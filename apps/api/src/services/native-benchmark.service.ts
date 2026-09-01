/**
 * WHAT: the measurement that replaces the guess. Runs one short, fixed prompt against the running
 * `llama-server`, times the first token and the ones after it, stores the result against the stored
 * model, and turns it into the `maxOutputTokens` a `LLAMA_CPP` provider row should declare.
 *
 * ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────────────────────
 *
 * `estimateNativeModelFit` predicts generation speed from ASSUMED memory bandwidth, and says so:
 * `speed.measured` is `false` and `speed.basis` spells out what was assumed, because CPU token
 * generation is bandwidth-bound and no platform reports its memory bandwidth portably. The
 * assumption is a class-based guess — "AVX-512 present, so probably a server part" — and it can be
 * wrong by a factor of three in either direction on real hardware.
 *
 * That would be a cosmetic problem if the number were only shown to a person. It is not: block 1
 * added `AIProviderConfig.maxOutputTokens` so the dispatcher can skip a provider that cannot serve a
 * call inside `MODEL_CALL_TIMEOUT_MS`, and the whole value of that filter depends on the declared
 * number being true. Nobody can type it honestly for a local model. Measuring it is the point of the
 * feature: thirty seconds of arithmetic on this machine turns a routing decision from a guess into a
 * fact. See `suggestNativeMaxOutputTokens` in @timesheet/shared for the arithmetic and its margin.
 *
 * ── WHY IT MEASURES TWO NUMBERS AND NOT ONE ─────────────────────────────────────────────────
 *
 * TIME TO FIRST TOKEN is prompt processing: the model reading the input. GENERATION RATE is
 * everything after. They are bound by different things (compute versus memory bandwidth), they
 * differ by an order of magnitude on a CPU, and they fail differently — a machine that emits forty
 * tokens a second after waiting twenty seconds for the first one is unusable for anything
 * interactive and perfectly fine for background classification. Collapsing them into "tokens per
 * second" would hide exactly the distinction an operator needs, and would also make the output
 * budget wrong, since the first-token wait buys no output tokens at all.
 *
 * ── WHY IT IS DELIBERATELY TINY ─────────────────────────────────────────────────────────────
 *
 * A short prompt and a 64-token ceiling. This is a button on a settings page, not a benchmark
 * suite: it has to finish while somebody is looking at it, and the two figures it measures are
 * stable well before then. Measuring longer would buy a third decimal place and lose the operator.
 *
 * WHO CALLS THIS: `POST /settings/ai/native/benchmark` in controllers/settings.controller.ts.
 */
import {
  findNativeModel,
  suggestNativeMaxOutputTokens,
  type NativeBenchmarkSummary,
  type NativeModelDownloadRow
} from "@timesheet/shared";
import { AppError } from "../middleware/error.js";
import { MODEL_CALL_TIMEOUT_MS } from "./ai.service.js";
import { findReadyModel, recordNativeBenchmark } from "./native-model-store.service.js";
import { getNativeRuntimeStatus, nativeRuntimeBaseUrl } from "./native-runtime.service.js";

/**
 * The prompt. Fixed, in-repo, and short on purpose — a benchmark whose input varies is not a
 * benchmark, and one whose input is a workspace's real data is a privacy question nobody asked for.
 * It asks for prose rather than a single word so the model actually generates the tokens being
 * timed instead of stopping after two.
 */
export const NATIVE_BENCHMARK_PROMPT =
  "Write three short sentences explaining what a timesheet is and why an employee fills one in. Plain prose, no lists.";

/** Enough tokens for the rate to settle past the first-token effects, few enough that the whole
 *  thing is over in seconds on any machine the catalogue's models fit on. */
export const NATIVE_BENCHMARK_MAX_TOKENS = 64;

/** Hard ceiling on the whole measurement. Far below MODEL_CALL_TIMEOUT_MS because this runs while a
 *  person waits on a settings page — a benchmark that can take ninety seconds is one nobody presses
 *  twice. A timeout here is reported as a result ("too slow to measure"), not swallowed. */
export const NATIVE_BENCHMARK_TIMEOUT_MS = 60_000;

export interface NativeBenchmarkIo {
  fetch(url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }): Promise<Response>;
  now(): number;
}

export const defaultNativeBenchmarkIo: NativeBenchmarkIo = {
  // No egress gate, for the reason `probeHealth` gives: this URL is derived by config/native-ai.ts
  // and points at our own runtime on loopback. The gate exists to distrust an ADMIN-supplied URL.
  fetch: (url, init) => fetch(url, init),
  now: () => (typeof performance !== "undefined" ? performance.now() : Date.now())
};

/**
 * One streamed completion, timed.
 *
 * STREAMING IS NOT AN OPTIMISATION HERE, IT IS THE MEASUREMENT. Time to first token is only
 * observable if the response arrives incrementally; a buffered call can report total duration and
 * nothing else, and total duration cannot be split into the two figures that mean different things.
 * The parser is a minimal SSE reader rather than the OpenAI SDK's, because the SDK's stream helper
 * hides exactly the timing this needs behind its own buffering.
 */
async function measureStream(
  baseUrl: string,
  model: string,
  io: NativeBenchmarkIo
): Promise<{ timeToFirstTokenMs: number; tokensPerSecond: number; outputTokens: number; totalMs: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NATIVE_BENCHMARK_TIMEOUT_MS);
  const startedAt = io.now();

  try {
    const response = await io.fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: true,
        // Deterministic, so re-running the benchmark measures the machine and not the sampler.
        temperature: 0,
        max_tokens: NATIVE_BENCHMARK_MAX_TOKENS,
        messages: [{ role: "user", content: NATIVE_BENCHMARK_PROMPT }]
      }),
      signal: controller.signal
    });

    if (!response.ok || !response.body) {
      throw new AppError(
        502,
        `The local runtime answered ${response.status} ${response.statusText || ""}`.trim() +
          ". The benchmark needs a running, ready llama-server — check the runtime status before running it."
      );
    }

    let firstTokenAt: number | null = null;
    let outputTokens = 0;
    let buffered = "";
    const decoder = new TextDecoder();

    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffered += decoder.decode(chunk, { stream: true });
      // SSE frames are separated by a blank line; a chunk can carry several, or half of one, so the
      // trailing fragment is carried into the next iteration rather than parsed as a whole frame.
      const frames = buffered.split("\n\n");
      buffered = frames.pop() ?? "";
      for (const frame of frames) {
        if (!frameCarriesContent(frame)) continue;
        firstTokenAt ??= io.now();
        outputTokens += 1;
      }
    }

    const finishedAt = io.now();
    if (firstTokenAt === null || outputTokens === 0) {
      throw new AppError(502, "The local runtime produced no tokens, so there was nothing to measure. Check that the model finished loading.");
    }

    const timeToFirstTokenMs = firstTokenAt - startedAt;
    const generationMs = Math.max(1, finishedAt - firstTokenAt);
    // The first token is EXCLUDED from the rate: it was produced by prompt processing, and counting
    // it would let a long first-token wait quietly depress the generation figure it is not part of.
    const tokensPerSecond = Math.round(((outputTokens - 1) / (generationMs / 1000)) * 10) / 10;

    return { timeToFirstTokenMs, tokensPerSecond, outputTokens, totalMs: finishedAt - startedAt };
  } catch (error) {
    if (error instanceof AppError) throw error;
    if ((error as Error).name === "AbortError") {
      throw new AppError(
        504,
        `The benchmark gave up after ${Math.round(NATIVE_BENCHMARK_TIMEOUT_MS / 1000)} seconds. A model this slow to answer a ` +
          `two-line prompt is not usable for this application's calls — a smaller catalogue entry is the answer, not a longer timeout.`
      );
    }
    throw new AppError(502, `Could not reach the local runtime: ${(error as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * True when one SSE frame carries actual generated text — which is what "a token arrived" means for
 * timing purposes.
 *
 * TOLERANT BY DESIGN. A keepalive, a comment line, the `[DONE]` sentinel, a role-only opening delta
 * and anything this cannot parse all answer false rather than throwing. A benchmark that dies on an
 * unexpected frame is measuring its own parser.
 */
function frameCarriesContent(frame: string): boolean {
  const line = frame.split("\n").find((row) => row.startsWith("data:"));
  if (!line) return false;
  const payload = line.slice(5).trim();
  if (payload === "" || payload === "[DONE]") return false;
  try {
    const parsed = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
    return (parsed.choices?.[0]?.delta?.content ?? "").length > 0;
  } catch {
    return false;
  }
}

/**
 * Measure the running runtime on one model and persist the result.
 *
 * Refuses when the runtime is not ready rather than measuring a cold start, because a figure that
 * includes weight loading is not a generation rate and would then be divided into a routing number.
 */
export async function runNativeBenchmark(
  modelId: string,
  io: NativeBenchmarkIo = defaultNativeBenchmarkIo
): Promise<{ download: NativeModelDownloadRow; benchmark: NativeBenchmarkSummary }> {
  const entry = findNativeModel(modelId);
  if (!entry) throw new AppError(422, `"${modelId}" is not a model in this build's catalogue.`);

  const stored = await findReadyModel(modelId);
  if (!stored) throw new AppError(409, `"${modelId}" has not been downloaded on this host, so there is nothing to benchmark.`);

  const status = await getNativeRuntimeStatus();
  if (status.state !== "ready") {
    throw new AppError(409, `The local runtime is not ready (${status.state}): ${status.detail} Start it before benchmarking.`);
  }

  const measurement = await measureStream(nativeRuntimeBaseUrl(), modelId, io);
  const suggestedMaxOutputTokens = suggestNativeMaxOutputTokens({
    tokensPerSecond: measurement.tokensPerSecond,
    timeToFirstTokenMs: measurement.timeToFirstTokenMs,
    ceilingMs: MODEL_CALL_TIMEOUT_MS
  });

  const download = await recordNativeBenchmark(modelId, { ...measurement, suggestedMaxOutputTokens });
  if (!download.benchmark) {
    // Cannot happen — `recordNativeBenchmark` just wrote every column `toBenchmark` reads — but the
    // type is nullable for the rows that have never been measured, and inventing a value here would
    // be worse than saying so.
    throw new AppError(500, "The benchmark ran but could not be read back from the store.");
  }
  return { download, benchmark: download.benchmark };
}
