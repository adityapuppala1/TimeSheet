/**
 * WHAT: the arithmetic and the wording behind the AI tab's "Run a model on this server" card
 * (pages/settings/NativeModelRunnerCard.tsx) — byte formatting, the tone a fit verdict is allowed
 * to wear, the live RAM recomputation as an operator moves the context slider, which context steps
 * a model permits, and the one decision that must never be got wrong: whether the tokens/sec on
 * screen was MEASURED or GUESSED.
 *
 * WHY THIS FILE EXISTS AT ALL. The web suite here is utility-level — there is no component test
 * harness and deliberately isn't one — so anything in that card worth being sure about has to live
 * in a pure function outside it. Everything below takes values and returns values: no queries, no
 * React, no clock. `native-model-panel.test.ts` breaks each one on purpose.
 *
 * THE RULE THIS FILE OBEYS, AND IT IS NOT NEGOTIABLE. It does NOT re-implement the fit estimator.
 * `liveNativeFit` calls `estimateNativeModelFit` from @timesheet/shared — the same pure function
 * the API runs to produce `GET /settings/ai/native/capability` — with a different context and KV
 * type. A screen that recomputed the verdict in its own arithmetic would eventually show a green
 * badge over a server that refuses the download, which is the exact failure native-fit.ts's header
 * was written to prevent. `nativeRamBreakdown` exists only to SPLIT the same total into the three
 * terms an operator needs to see separately, and the test asserts it sums to what the estimator
 * itself computed, so the two cannot drift.
 *
 * WHY "MEASURED VS ESTIMATED" GETS ITS OWN FUNCTION. The speed number drives a real decision — an
 * operator picks a model by it, and `suggestNativeMaxOutputTokens` turns it into routing. The
 * estimate is arithmetic over an ASSUMED memory bandwidth (no platform reports the real one); the
 * benchmark is a stopwatch. Letting the first quietly wear the second's clothes is the single most
 * misleading thing this card could do, so the choice is one function with one return shape that
 * always names its own source, and the component renders that name.
 */
import {
  estimateNativeModelFit,
  nativeKvCacheBytes,
  nativeModelWeightBytes,
  nativeModelWithMeasuredSize,
  nativeRuntimeOverheadBytes,
  type NativeBenchmarkSummary,
  type NativeDownloadStatus,
  type NativeFitEstimate,
  type NativeFitVerdict,
  type NativeHardwareSnapshot,
  type NativeKvCacheType,
  type NativeModelEntry,
  type NativeModelWeightSource,
  type NativeRuntimeEnvironment
} from "@timesheet/shared";

/* ── numbers a person can read ──────────────────────────────────────────────────────────────── */

/**
 * Bytes to a figure with a unit, or the word "unknown".
 *
 * "UNKNOWN" AND NEVER "0 B" for a null. Every memory and disk field in the hardware snapshot is
 * nullable and null there always means "this platform would not say" — rendering that as a
 * confident zero tells an operator their box has no free disk, which is a different and much more
 * alarming claim than the truth.
 *
 * THE KB TIER EARNS ITS PLACE. A download that fetched an HTML error page under a `.gguf` name is
 * about a kilobyte, and "0 MB of 1.9 GB" reads like a transfer that has not started rather than one
 * that finished with the wrong thing in it. The GB tier keeps one decimal because these are derived
 * numbers (see nativeModelWeightBytes) and printing a derived value to the byte is a lie about its
 * own precision.
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "unknown";
  const abs = Math.abs(bytes);
  if (abs >= 1024 ** 3) return `${Math.round((bytes / 1024 ** 3) * 10) / 10} GB`;
  if (abs >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  if (abs >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes)} B`;
}

/** "8k" rather than "8192" on a button, because four of these sit in a row on a phone. Falls back
 *  to the exact number for anything not a whole multiple of 1024 — an approximation of a context
 *  is not a thing worth inventing. */
export function formatContextTokens(tokens: number): string {
  return tokens % 1024 === 0 ? `${tokens / 1024}k` : String(tokens);
}

/* ── the verdict, and the colour it is allowed to wear ──────────────────────────────────────── */

/** The badge variants this app actually ships (components/ui/badge.tsx). Named here so a typo is a
 *  compile error rather than an unstyled badge. */
export type NativeBadgeVariant = "default" | "secondary" | "outline" | "success" | "warning" | "destructive" | "info" | "muted";

export interface NativeVerdictTone {
  badge: NativeBadgeVariant;
  /** The two-word headline. The SENTENCE beside it is `estimate.reason`, which is never empty and
   *  is what the operator actually acts on — this is only the thing the eye lands on first. */
  label: string;
  /** For the memory meter's fill, so the bar and the badge cannot say different things. */
  meterClassName: string;
}

/**
 * Verdict → tone. The whole point is the mapping's strictness: ONLY `comfortable` is allowed the
 * success colour, and `unknown` is muted rather than green — an undecidable fit is not a passing
 * one, and a green badge over "we could not read this machine's memory" is precisely the reassuring
 * lie this subsystem exists to avoid.
 */
export function fitVerdictTone(verdict: NativeFitVerdict): NativeVerdictTone {
  switch (verdict) {
    case "comfortable":
      return { badge: "success", label: "Comfortable", meterClassName: "bg-success" };
    case "tight":
      return { badge: "warning", label: "Tight", meterClassName: "bg-warning" };
    case "will-not-fit":
      return { badge: "destructive", label: "Won't fit", meterClassName: "bg-destructive" };
    default:
      return { badge: "muted", label: "Can't tell", meterClassName: "bg-muted-foreground" };
  }
}

/* ── the live RAM recomputation ─────────────────────────────────────────────────────────────── */

/** The three terms that make up "how much memory this costs", kept separate because an operator
 *  choosing between 8k and 16k needs to see WHICH number moved — a single total hides the only
 *  thing the choice changes. */
export interface NativeRamBreakdown {
  weightBytes: number;
  weightSource: NativeModelWeightSource;
  kvCacheBytes: number;
  runtimeOverheadBytes: number;
  totalBytes: number;
}

/**
 * Weights + KV cache at THIS context and precision + llama.cpp's flat working set.
 *
 * The KV term is the one that moves when the operator touches anything, and it is the term this
 * whole card is built to make visible: it scales linearly with context AND halves with a `q8_0`
 * cache, and on a multi-head model it is larger than the weights long before 16k. Dropping it from
 * the total would make every context step look free, which is the falsification the test performs.
 */
export function nativeRamBreakdown(entry: NativeModelEntry, contextTokens: number, kvCacheType: NativeKvCacheType): NativeRamBreakdown {
  const weight = nativeModelWeightBytes(entry);
  const kvCacheBytes = nativeKvCacheBytes(entry, contextTokens, kvCacheType);
  return {
    weightBytes: weight.bytes,
    weightSource: weight.source,
    kvCacheBytes,
    runtimeOverheadBytes: nativeRuntimeOverheadBytes,
    totalBytes: weight.bytes + kvCacheBytes + nativeRuntimeOverheadBytes
  };
}

/**
 * The full verdict for one model at the context and KV precision currently selected on screen.
 *
 * A THIN WRAPPER ON PURPOSE. The capability report the API returns estimates every model at its own
 * RECOMMENDED context; the moment an operator moves the context steps, that report is answering a
 * different question. Rather than patching its numbers, this re-runs the identical shared estimator
 * against the same hardware snapshot the API used — so what the screen shows at 16k is exactly what
 * the API would say if asked at 16k.
 *
 * THE MEASURED SIZE WINS WHERE ONE EXISTS. Once a model is downloaded, its real byte count is
 * known, and every figure downstream should run on the file rather than on the catalogue's
 * bits-per-weight derivation. `nativeModelWithMeasuredSize` is a no-op when there is nothing
 * measured yet, which is the ordinary case before the first download.
 *
 * CLAMPED TO THE MODEL'S OWN MAXIMUM, not left to produce a fit for a context llama.cpp would
 * refuse. The clamped value comes back on the returned estimate's `contextTokens`, so the caller
 * can say "16k (this model's maximum)" instead of silently showing figures for a number nobody
 * chose.
 */
export function liveNativeFit(input: {
  hardware: NativeHardwareSnapshot;
  entry: NativeModelEntry;
  /** From the download row once one is `ready`; null/undefined before that. */
  measuredFileSizeBytes?: number | null;
  contextTokens: number;
  kvCacheType: NativeKvCacheType;
}): NativeFitEstimate {
  const entry = nativeModelWithMeasuredSize(input.entry, input.measuredFileSizeBytes);
  const contextTokens = Math.min(input.contextTokens, entry.maxContextTokens);
  return estimateNativeModelFit(input.hardware, entry, contextTokens, input.kvCacheType);
}

/* ── the steps an operator may choose between ───────────────────────────────────────────────── */

/**
 * The context rungs this card offers.
 *
 * STEPS AND NOT A FREE NUMBER because the interesting differences here are powers of two and every
 * value between them costs KV for context nobody sends. It stops at 32k because that is the largest
 * any catalogue entry is trained to that this app could plausibly fill; note that the RECOMMENDED
 * context (`estimate.recommended.contextTokens`) comes from the shared `nativeContextLadder`, which
 * stops at 16k on purpose — above that you are paying cache for context this app's own truncation
 * caps mean its callers never fill. 32k is offered, never suggested.
 */
export const NATIVE_CONTEXT_STEPS = [4096, 8192, 16384, 32768] as const;

/**
 * Which of those steps this model actually permits. A model trained to 32k must not be offered a
 * 131k button, and — the case that matters — a model whose own maximum is below the smallest step
 * still gets exactly one offer (its maximum) rather than an empty row that looks broken.
 */
export function contextStepsForModel(entry: NativeModelEntry, steps: readonly number[] = NATIVE_CONTEXT_STEPS): number[] {
  const allowed = steps.filter((step) => step <= entry.maxContextTokens);
  return allowed.length > 0 ? allowed : [entry.maxContextTokens];
}

/* ── measured, estimated, or neither ────────────────────────────────────────────────────────── */

export type NativeSpeedSource = "measured" | "estimated" | "unknown";

export interface NativeSpeedFigure {
  source: NativeSpeedSource;
  tokensPerSecond: number | null;
  /** The word the badge wears. Rendered, never derived a second time by the component. */
  label: string;
  /** In words: what produced this number. For an estimate it names the assumption; for a
   *  measurement it names the run. Shown next to the figure, not hidden behind it. */
  basis: string;
  /** Only ever non-null for a measurement — the two halves of "slow" a person actually feels. */
  timeToFirstTokenMs: number | null;
  measuredAt: string | null;
  suggestedMaxOutputTokens: number | null;
}

/**
 * Which speed figure the card is entitled to show, and what it must call it.
 *
 * A MEASUREMENT OUTRANKS AN ESTIMATE, AND NOTHING PROMOTES AN ESTIMATE. The benchmark is a
 * stopwatch over real tokens; the estimate divides an ASSUMED memory bandwidth by the weight bytes
 * and `estimate.speed.measured` is hard-coded false in the shared estimator for that reason. A
 * benchmark row with a non-positive or non-finite rate is treated as absent rather than as a
 * measurement of zero — a divide-by-zero in a stopwatch is not a slow machine.
 *
 * The `unknown` branch is real: a model whose weight size could not be derived leaves the estimator
 * with a null rate, and "we don't know" is a better answer than a number.
 */
export function selectSpeedFigure(input: {
  estimate: NativeFitEstimate | null;
  benchmark: NativeBenchmarkSummary | null | undefined;
}): NativeSpeedFigure {
  const measured = input.benchmark;
  if (measured && Number.isFinite(measured.tokensPerSecond) && measured.tokensPerSecond > 0) {
    return {
      source: "measured",
      tokensPerSecond: measured.tokensPerSecond,
      label: "Measured",
      basis: measured.basis,
      timeToFirstTokenMs: measured.timeToFirstTokenMs,
      measuredAt: measured.measuredAt,
      suggestedMaxOutputTokens: measured.suggestedMaxOutputTokens
    };
  }
  const estimated = input.estimate?.speed.tokensPerSecond ?? null;
  if (estimated !== null && Number.isFinite(estimated) && estimated > 0) {
    return {
      source: "estimated",
      tokensPerSecond: estimated,
      label: "Estimated",
      basis: input.estimate!.speed.basis,
      timeToFirstTokenMs: null,
      measuredAt: null,
      suggestedMaxOutputTokens: null
    };
  }
  return {
    source: "unknown",
    tokensPerSecond: null,
    label: "Not known",
    basis: "This machine gave up too little about itself to even estimate a generation rate. Run a benchmark to find out.",
    timeToFirstTokenMs: null,
    measuredAt: null,
    suggestedMaxOutputTokens: null
  };
}

/* ── threads ────────────────────────────────────────────────────────────────────────────────── */

export interface NativeThreadCeiling {
  max: number;
  basis: string;
}

/**
 * The largest thread count the input will accept, and why in words.
 *
 * NOT THE SAME NUMBER AS THE RECOMMENDATION, and the difference is the point. The recommendation
 * (`estimate.recommended.threads`) holds a core back for the API and the database; this is the
 * ceiling an operator is allowed to type past it if they know something the estimator does not.
 * What they are NOT allowed to type past is a cgroup CPU quota — more threads than the quota does
 * not go faster, it exhausts the period sooner and spends the rest of it throttled — so the quota
 * binds even when the node has sixty-four cores.
 *
 * With no core count at all the ceiling is the API's own 256, which is honest: we have no basis for
 * a smaller one, and inventing one would refuse a valid setting on a machine we know nothing about.
 */
export function nativeThreadCeiling(hardware: NativeHardwareSnapshot): NativeThreadCeiling {
  const { physicalCores, logicalCores, quotaCores, quotaSource } = hardware.cpu;
  const cores = physicalCores ?? (logicalCores === null ? null : Math.max(1, Math.floor(logicalCores / 2)));
  const quota = quotaCores === null ? null : Math.max(1, Math.floor(quotaCores));

  if (quota !== null && (cores === null || quota < cores)) {
    return { max: quota, basis: `a cgroup CPU quota of ${quotaCores} cores (${quotaSource ?? "cgroup"}) caps this container` };
  }
  if (cores === null) {
    return { max: 256, basis: "this machine would not report a CPU count, so nothing here can narrow it" };
  }
  return {
    max: cores,
    basis:
      physicalCores === null
        ? `${logicalCores} logical CPUs, halved for hyperthreading — two threads on one core's load/store units do not double a bandwidth-bound workload`
        : `${physicalCores} physical cores`
  };
}

/* ── the download ───────────────────────────────────────────────────────────────────────────── */

/**
 * Percent complete, or `null` for "render an indeterminate bar".
 *
 * NULL IS A REAL ANSWER: `bytesTotal` is null whenever the server sent no `Content-Length`, and a
 * bar pinned at 0% for a transfer that is visibly moving is worse than an honest indeterminate one.
 * Clamped at both ends because a server that under-reports its own length would otherwise produce a
 * bar past its own track.
 */
export function downloadProgressPercent(row: { bytesDownloaded: number; bytesTotal: number | null }): number | null {
  if (row.bytesTotal === null || !Number.isFinite(row.bytesTotal) || row.bytesTotal <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((row.bytesDownloaded / row.bytesTotal) * 100)));
}

/** The status line under the bar. Verification is its OWN step and says so — it re-reads a
 *  multi-gigabyte file to hash it, with no bytes moving, and a bar frozen at 100% with no
 *  explanation is how an operator concludes the download hung. */
export function downloadStatusLabel(status: NativeDownloadStatus): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "downloading":
      return "Downloading";
    case "verifying":
      return "Verifying — hashing the file and checking its header";
    case "ready":
      return "On this machine's disk";
    case "cancelled":
      return "Cancelled";
    default:
      return "Failed";
  }
}

/* ── the machine ────────────────────────────────────────────────────────────────────────────── */

const ENVIRONMENT_LABELS: Record<NativeRuntimeEnvironment, string> = {
  "bare-metal": "Bare metal",
  docker: "Docker",
  kubernetes: "Kubernetes",
  wsl: "WSL",
  unknown: "Unknown"
};

/** The environment label AND the signals that produced it. A label with no reasoning is a claim an
 *  operator has no way to check — and this one is wrong often enough (a VM that looks like a
 *  container, a container with no cgroup evidence) to be worth showing its work. */
export function environmentSummary(hardware: NativeHardwareSnapshot): { label: string; reason: string } {
  const signals = hardware.environment.signals;
  return {
    label: ENVIRONMENT_LABELS[hardware.environment.kind] ?? "Unknown",
    reason: signals.length > 0 ? `detected from ${signals.join("; ")}` : "no signal either way was readable on this platform"
  };
}

/**
 * THE WARNING THIS CARD EXISTS TO SHOW. Non-null when this process is in a container that has no
 * cgroup memory limit, which means `os.totalmem()` — and therefore every figure below it — is the
 * HOST's memory rather than this process's budget.
 *
 * That is the difference between an operator trusting the screen and being OOM-killed by it: the
 * pod is told it has 32 GB, told a 3B model fits comfortably, downloads two gigabytes, and dies the
 * instant llama.cpp maps the file. Nothing else on the page can detect this, because from inside
 * the container the optimistic numbers look exactly like true ones.
 */
export function containerMemoryCaveat(hardware: NativeHardwareSnapshot): string | null {
  const kind = hardware.environment.kind;
  if (kind !== "docker" && kind !== "kubernetes") return null;
  if (hardware.memory.cgroupLimitBytes !== null) return null;
  return (
    `This process is running under ${ENVIRONMENT_LABELS[kind]} with no cgroup memory limit set, so the memory figures below are ` +
    `the HOST's, not this container's budget. Every fit verdict on this page is therefore optimistic: if your orchestrator caps ` +
    `this container somewhere else, a model with a comfortable verdict can still be OOM-killed the moment its weights are mapped. ` +
    `Set an explicit memory limit on the container to get a real answer.`
  );
}

/**
 * Which warnings belong to the MACHINE rather than to one model.
 *
 * The shared estimator emits its warnings per model, so a machine-wide fact — no cgroup limit, an
 * unreadable CPU count, a CPU quota clamping threads — arrives six times on a six-model page. Split
 * so the machine's warnings are said once at the top and each card carries only what is true of
 * THAT model at THIS context. Six copies of the same sentence trains an operator to skip all of
 * them, including the one that was about their model.
 */
const MACHINE_WIDE_WARNING_CODES = new Set([
  "container-without-memory-limit",
  "unknown-memory",
  "unknown-cpu-count",
  "assumed-physical-cores",
  "cpu-quota-clamped-threads",
  "unknown-instruction-set"
]);

export function isMachineWideWarning(code: string): boolean {
  return MACHINE_WIDE_WARNING_CODES.has(code);
}
