/**
 * WHAT: the vocabulary the model store, the runtime supervisor and the benchmark all speak — the
 * download job's states, the runtime's modes and states, the measured benchmark, and the four pure
 * decisions that must give the SAME answer on the server and in the settings screen.
 *
 * WHY IT IS SHARED, and it is the same argument native-fit.ts makes: the operator sees a progress
 * bar, a verdict and a "measured" badge, and every one of those is derived from a number the API
 * also derives. A client that recomputes "is this file plausible" or "what does this benchmark
 * allow us to ask for" in its own arithmetic is a client that will eventually show a green badge
 * over a server that refuses the same file.
 *
 * ── WHERE A MODEL COMES FROM, AND WHY THE HOST IS NOT NEGOTIABLE ─────────────────────────────
 *
 * The download URL is DERIVED from the catalogue entry, never typed by anybody. That is a security
 * property and not a convenience: `utils/egress.ts` exists because four features let an admin name
 * a URL this server then fetches, and a downloader that accepted one would be the fifth and the
 * worst — it writes what it fetches to disk and then executes it as model weights. So the URL is
 * built here from `repo`/`file`, and `isNativeDownloadHostAllowed` is applied to the initial URL
 * AND to every redirect hop, on top of the ordinary egress gate. Hugging Face answers a model
 * request with a 302 to its own CDN, so redirects cannot simply be refused — they have to be
 * followed with the same suspicion as the first request.
 *
 * ── WHY A DERIVED SIZE STILL GETS TO REFUSE A FILE ──────────────────────────────────────────
 *
 * `nativeModelWeightBytes` is honest that its number is derived from the quantisation's published
 * bits-per-weight (see native-models.ts), and a derived number must never be used to claim a file
 * is EXACTLY right. It is entirely good enough to catch the failure that actually happens: a
 * request that 404s and saves ~1 KB of HTML under a `.gguf` name, or a proxy that returns a login
 * page. `nativeDownloadSizeProblem` therefore checks a wide band and says both numbers when it
 * refuses — it is a smoke alarm, not a checksum, and the tolerance is deliberately loose enough
 * that no real file trips it.
 *
 * ── THE POINT OF THE WHOLE BLOCK, IN ONE FUNCTION ───────────────────────────────────────────
 *
 * `suggestNativeMaxOutputTokens` is why the benchmark exists. Block 1 gave a provider row a
 * `maxOutputTokens` so the dispatcher can skip a provider that cannot serve a call inside the
 * 90-second ceiling. Nobody can type that number honestly for a local model: it depends on this
 * machine's memory bandwidth, which no platform reports. Measure the machine, divide the budget by
 * the measured rate, and the routing filter is finally consuming a fact instead of a guess.
 */

import { nativeModelWeightBytes, type NativeModelEntry } from "./native-models.js";
import type { NativeKvCacheType, NativeRuntimeEnvironment } from "./native-fit.js";
import type { NativeEngineBinarySource } from "./native-engine.js";

/* ── the download job ───────────────────────────────────────────────────────────────────────── */

/**
 * A download's life. `verifying` is its own state and not a flicker at the end of `downloading`:
 * verification re-reads the whole temp file to hash it and to check its magic bytes, which on a
 * 5 GB model is seconds of work with no bytes moving. Folding it into `downloading` would show a
 * progress bar frozen at 100% and leave the operator wondering what broke.
 */
export const nativeDownloadStatuses = ["queued", "downloading", "verifying", "ready", "failed", "cancelled"] as const;
export type NativeDownloadStatus = (typeof nativeDownloadStatuses)[number];

/** The statuses a UI should keep polling on — the conditional `refetchInterval` this codebase uses
 *  for every long-running job (see AgentRunsCard). There is no SSE and no WebSocket here. */
export const nativeDownloadInFlightStatuses: readonly NativeDownloadStatus[] = ["queued", "downloading", "verifying"];

export interface NativeBenchmarkSummary {
  measuredAt: string;
  /** Milliseconds from request to the first token of the answer. On CPU this is dominated by
   *  prompt processing, and it is the half of "slow" a person actually feels. */
  timeToFirstTokenMs: number;
  /** Generation rate AFTER the first token, which is the figure the fit estimator guesses at. */
  tokensPerSecond: number;
  outputTokens: number;
  totalMs: number;
  /** What this measurement says the provider row should declare — see
   *  {@link suggestNativeMaxOutputTokens}. */
  suggestedMaxOutputTokens: number;
  /** In words: what was measured and what was assumed on top of it. Rendered beside the number. */
  basis: string;
}

/**
 * One model this deployment has (or is getting) on its own disk. The API shape, not the row shape —
 * byte counts come back as ordinary numbers.
 */
export interface NativeModelDownloadRow {
  id: string;
  modelId: string;
  status: NativeDownloadStatus;
  bytesDownloaded: number;
  /** From `Content-Length` when the server sent one. Null means "the server would not say", which
   *  is a real outcome and NOT zero — a progress bar has to render indeterminate for it. */
  bytesTotal: number | null;
  /**
   * MEASURED, from the finished file. Everything downstream prefers this over the catalogue's
   * derived estimate — see {@link nativeModelWithMeasuredSize}.
   */
  fileSizeBytes: number | null;
  /** SHA-256 of what actually arrived. Recorded rather than compared: the catalogue publishes no
   *  hashes (it would be asserting something it cannot know), so this is evidence, not a gate. */
  sha256: string | null;
  /** Absolute path on the API host. Null until the file is `ready`. */
  filePath: string | null;
  /** Populated only on `failed`; the operator-facing sentence, with the numbers in it. */
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  benchmark: NativeBenchmarkSummary | null;
  /** The catalogue entry this names, when it still names one. Null after a catalogue edit removes
   *  an id somebody already downloaded — which must render as "unknown model, delete it", not as a
   *  crash in the picker. */
  catalogue: NativeModelEntry | null;
}

/* ── where a model is fetched from ──────────────────────────────────────────────────────────── */

/**
 * The only hosts a model may be fetched from, as suffixes.
 *
 * `hf.co` is here because `huggingface.co` redirects large-file downloads to `cdn-lfs*.hf.co` and
 * to the transfer service on `*.hf.co`; refusing redirects outright would refuse every real
 * download, and following them blindly would make the allowlist decorative. Matched as "equal to,
 * or ending in a dot plus" — a bare `endsWith` would accept `evil-huggingface.co`, which is the
 * classic way an allowlist becomes a formality.
 */
export const nativeDownloadHostSuffixes = ["huggingface.co", "hf.co"] as const;

export function isNativeDownloadHostAllowed(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  return nativeDownloadHostSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * Where this exact catalogue entry's file lives. `resolve/main` is Hugging Face's raw-file route;
 * `?download=true` asks for the file rather than the repo's HTML viewer, which is precisely the
 * mistake that saves a web page under a `.gguf` name.
 */
export function nativeModelDownloadUrl(entry: NativeModelEntry): string {
  return `https://huggingface.co/${entry.repo}/resolve/main/${encodeURIComponent(entry.file)}?download=true`;
}

/**
 * The name a model takes on THIS machine's disk — the catalogue id, not the remote filename.
 *
 * WHY NOT THE PUBLISHED FILENAME, which would be friendlier to an operator running `ls`: it is a
 * string from a data file being used to build a path. Today the catalogue is in-repo and every
 * value is safe; the moment it is editable, `../../.env` is a filename and this is the function
 * that decided to trust it. The id is already constrained to the shape below, and it is what every
 * row and provider config stores anyway, so one name serves both.
 */
export const nativeModelIdPattern = /^[a-z0-9][a-z0-9._-]{0,79}$/;

export function nativeModelStoredFileName(modelId: string): string {
  if (!nativeModelIdPattern.test(modelId)) {
    throw new Error(`"${modelId}" is not a usable model id — expected lowercase letters, digits, dot, dash or underscore.`);
  }
  return `${modelId}.gguf`;
}

/* ── the two things a finished file has to survive ──────────────────────────────────────────── */

/**
 * How far a real file may sit from the derived estimate before it is refused. Wide on purpose: the
 * derivation is an average bits-per-weight with a safety factor, so being 20% out on some entry is
 * expected and being 90% out is a different file. See the header.
 */
export const nativeDownloadSizeLowRatio = 0.55;
export const nativeDownloadSizeHighRatio = 1.7;

function gb(bytes: number): string {
  return `${Math.round((bytes / 1024 ** 3) * 100) / 100} GB`;
}

/**
 * `null` when the measured size is plausible for this entry; otherwise the sentence to store on the
 * download row, with BOTH numbers in it. "Verification failed" tells an operator nothing; "got
 * 0.00 GB, expected roughly 1.94 GB" tells them they fetched an error page.
 */
export function nativeDownloadSizeProblem(entry: NativeModelEntry, measuredBytes: number): string | null {
  const expected = nativeModelWeightBytes(entry);
  const low = expected.bytes * nativeDownloadSizeLowRatio;
  const high = expected.bytes * nativeDownloadSizeHighRatio;
  if (measuredBytes >= low && measuredBytes <= high) return null;
  return (
    `The downloaded file is ${gb(measuredBytes)}, but ${entry.displayName} should be roughly ${gb(expected.bytes)} ` +
    `(${expected.source === "catalogue" ? "published size" : "derived from the quantisation"}; anything outside ` +
    `${gb(low)}–${gb(high)} is rejected). This is usually an error page or a partial transfer saved under a .gguf name.`
  );
}

/**
 * The catalogue entry with the MEASURED file size substituted in, so every downstream estimate
 * (`estimateNativeModelFit`, the memory verdict, the recommended context) runs on the real number
 * once one exists.
 *
 * WHY A FUNCTION RATHER THAN MUTATING THE CATALOGUE: the catalogue is a frozen, in-repo constant
 * shared with the browser, and the measurement is per-installation. Copying at the point of use is
 * what keeps "what this build ships" and "what this machine has" from becoming the same object.
 */
export function nativeModelWithMeasuredSize(entry: NativeModelEntry, fileSizeBytes: number | null | undefined): NativeModelEntry {
  if (typeof fileSizeBytes !== "number" || !Number.isFinite(fileSizeBytes) || fileSizeBytes <= 0) return entry;
  return { ...entry, fileSizeBytes };
}

/* ── turning a measurement into a routing number ────────────────────────────────────────────── */

/**
 * Of the call ceiling, how much a provider row may promise to fill. The rest absorbs everything the
 * benchmark's short fixed prompt does not: a longer real prompt, a colder cache, the API's own
 * queueing, and another tenant's call landing on the same single-threaded CPU.
 *
 * 0.6 rather than 0.9 because the cost of the two errors is not symmetric. Declaring too little
 * means a few heavy calls route to the cloud provider behind it, which is what they should do
 * anyway; declaring too much means every one of them spends the full ninety seconds finding out.
 */
export const nativeOutputBudgetShare = 0.6;

/** Below this, declaring a ceiling is pointless — nothing in this app asks for fewer. */
export const nativeMinSuggestedOutputTokens = 64;
/** Above this, the honest answer is "no declared limit"; the app's own generators cap out here. */
export const nativeMaxSuggestedOutputTokens = 8192;

/**
 * What this machine can actually emit inside the call ceiling, with the margin above applied.
 *
 * THE ARITHMETIC, spelled out because the number goes straight into a routing decision: the budget
 * is the ceiling times the share, MINUS the measured time to first token (which buys no output
 * tokens at all — it is prompt processing), and the answer is that budget times the measured
 * generation rate. Clamped at both ends and floored, never rounded up.
 */
export function suggestNativeMaxOutputTokens(input: {
  tokensPerSecond: number;
  timeToFirstTokenMs: number;
  ceilingMs: number;
}): number {
  const budgetMs = input.ceilingMs * nativeOutputBudgetShare - input.timeToFirstTokenMs;
  // `Number.isFinite` first, and not merely `<= 0`: a NaN rate (a benchmark that divided by a zero
  // duration) is false for EVERY comparison, so a bare `<= 0` would wave it through and the floor
  // below would then be `Math.max(64, NaN)` — which is NaN, straight into a routing decision.
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) return nativeMinSuggestedOutputTokens;
  if (!Number.isFinite(input.tokensPerSecond) || input.tokensPerSecond <= 0) return nativeMinSuggestedOutputTokens;
  const tokens = Math.floor((budgetMs / 1000) * input.tokensPerSecond);
  return Math.min(nativeMaxSuggestedOutputTokens, Math.max(nativeMinSuggestedOutputTokens, tokens));
}

/* ── the runtime ────────────────────────────────────────────────────────────────────────────── */

/**
 * WHO runs `llama-server`.
 *
 * `embedded` — this process spawns and supervises it. The right answer on bare metal and WSL,
 *   where a binary on PATH is an ordinary thing to have.
 * `external` — something else runs it (a Docker Compose service, a Kubernetes sidecar) and we only
 *   point at it. The DEFAULT under Docker and Kubernetes, because baking a llama.cpp binary into
 *   `node:24-alpine` is a musl-vs-glibc problem with no good answer, and a sidecar is the idiomatic
 *   solution in both orchestrators anyway.
 * `off` — nothing native. The default everywhere until an operator says otherwise, and the state
 *   this whole subsystem must cost nothing in.
 */
export const nativeRuntimeModes = ["embedded", "external", "off"] as const;
export type NativeRuntimeMode = (typeof nativeRuntimeModes)[number];

/**
 * What the runtime is doing, as opposed to who owns it.
 *
 * `unavailable` and `failed` are DIFFERENT and the difference is what the operator does next.
 * `unavailable` means it cannot run here at all — no binary, no model file — and no amount of
 * retrying changes that, so nothing retries. `failed` means it ran, kept exiting, and the
 * supervisor gave up after its attempt budget; that one is worth a Start button.
 */
export const nativeRuntimeStates = ["off", "unavailable", "stopped", "starting", "ready", "restarting", "failed"] as const;
export type NativeRuntimeState = (typeof nativeRuntimeStates)[number];

export interface NativeRuntimeStatus {
  mode: NativeRuntimeMode;
  /** Why this mode, in words — "Kubernetes detected, so a sidecar is assumed". A mode nobody chose
   *  and cannot explain is a mode an operator argues with. */
  modeReason: string;
  state: NativeRuntimeState;
  /** NEVER empty, for the same reason `NativeFitEstimate.reason` is never empty. */
  detail: string;
  /** The OpenAI-compatible endpoint a `LLAMA_CPP` provider row is dispatched against, or null when
   *  the mode is `off`. Derived server-side — see apps/api/src/config/native-ai.ts. */
  baseUrl: string | null;
  /** Resolved absolute path of `llama-server`, or null. Only meaningful in `embedded` mode, where it
   *  is resolved on EVERY status read rather than only after a start — the screen has to know
   *  whether Restart could possibly work before anybody presses anything. */
  binaryPath: string | null;
  /** Which of the three sources produced it: the operator's `NATIVE_AI_SERVER_BIN`, the engine this
   *  deployment installed, or PATH. Reported because "there is a llama-server" and "there is the one
   *  this panel installed" are different facts, and a version mismatch is diagnosed from the
   *  difference. */
  binarySource: NativeEngineBinarySource | null;
  /** Why there is no binary, when there is none. Null when one was found or none is needed.
   *
   *  DIFFERENT FROM `lastError`, and keeping them different is load-bearing: this is a precondition
   *  that is not met and is fixable from the screen, while `lastError` is something that went wrong
   *  while running. They used to be set to the identical sentence when no binary was found, which
   *  the settings screen then rendered three times under three icons. */
  binaryProblem: string | null;
  modelId: string | null;
  modelPath: string | null;
  pid: number | null;
  contextTokens: number | null;
  threads: number | null;
  kvCacheType: NativeKvCacheType | null;
  parallelSlots: number | null;
  startedAt: string | null;
  readyAt: string | null;
  lastError: string | null;
  restarts: {
    /** Consecutive unexpected exits since the last clean start. Reset by a successful readiness. */
    attempts: number;
    maxAttempts: number;
    nextRetryAt: string | null;
    lastExitCode: number | null;
    lastExitSignal: string | null;
  };
  environment: NativeRuntimeEnvironment;
}
