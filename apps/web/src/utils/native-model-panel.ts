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
  type NativeEngineInstallStatus,
  type NativeFitEstimate,
  type NativeFitVerdict,
  type NativeHardwareSnapshot,
  type NativeKvCacheType,
  type NativeModelEntry,
  type NativeModelWeightSource,
  type NativeRuntimeEnvironment,
  type NativeRuntimeMode,
  type NativeRuntimeState
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

/* ── the runtime block's three sentences, said once each ────────────────────────────────────── */

/** Which field a line came from, so the card can give each its own icon and tone without
 *  re-deriving that from the text. */
export type NativeRuntimeMessageKind = "detail" | "binaryProblem" | "lastError";

export interface NativeRuntimeMessage {
  kind: NativeRuntimeMessageKind;
  text: string;
}

/** Whitespace and case folded away, because "the same sentence" is a claim about content and not
 *  about how a server happened to wrap it. */
function normaliseMessage(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * THE RUNTIME BLOCK'S MESSAGES, DEDUPLICATED ON CONTENT — each distinct thing said exactly once.
 *
 * ── THE BUG THIS EXISTS TO KILL ─────────────────────────────────────────────────────────────
 *
 * With no binary installed, the API filled `detail`, `binaryProblem` and `lastError` with the SAME
 * sentence, and this card rendered all three unconditionally: the identical paragraph three times,
 * under three different icons, in three different colours. The state underneath was perfectly
 * correct and the screen read as broken software — which is worse than a wrong number, because an
 * operator who stops trusting the panel stops reading the parts of it that are right.
 *
 * ── WHY NOT SIMPLY DELETE TWO OF THE RENDERS ────────────────────────────────────────────────
 *
 * Because the three fields mean three genuinely different things and routinely differ:
 *   `detail`         — what the runtime IS, always present, often a mode explanation
 *                      ("NATIVE_AI_RUNTIME_MODE is off, so no local model runtime is used here").
 *   `binaryProblem`  — a fixable CONFIGURATION problem, and usually the only actionable line on the
 *                      card ("NATIVE_AI_SERVER_BIN points at …, which does not exist").
 *   `lastError`      — something that went WRONG while running (a crash, an exit code, a readiness
 *                      timeout with llama.cpp's own stderr quoted).
 * Dropping two renders would hide a real crash behind a stale mode explanation. The fix is
 * content-level: say the first, then say the second only if it adds something the first did not, and
 * the third only if it adds something neither did.
 *
 * ── THE CONTAINMENT RULE, AND ITS DELIBERATE ASYMMETRY ──────────────────────────────────────
 *
 * A later line is dropped when what it says is already CONTAINED in what has been said — identical
 * strings, and also the very common case where `detail` is `binaryProblem` plus a sentence of
 * context. It is NOT dropped when it is longer and contains an earlier line, because then it really
 * does carry something new, and suppressing it would be the "deleted two renders" mistake wearing a
 * cleverer hat. Containment rather than equality alone, because the API composes these sentences
 * from shared fragments and exact equality would miss most real duplicates.
 */
export function runtimeMessageLines(status: {
  detail?: string | null;
  binaryProblem?: string | null;
  lastError?: string | null;
}): NativeRuntimeMessage[] {
  const candidates: NativeRuntimeMessage[] = [
    { kind: "detail", text: status.detail ?? "" },
    { kind: "binaryProblem", text: status.binaryProblem ?? "" },
    { kind: "lastError", text: status.lastError ?? "" }
  ];

  const shown: NativeRuntimeMessage[] = [];
  const said: string[] = [];
  for (const candidate of candidates) {
    const text = candidate.text.trim();
    if (text === "") continue;
    const normalised = normaliseMessage(text);
    if (said.some((earlier) => earlier.includes(normalised))) continue;
    shown.push({ kind: candidate.kind, text });
    said.push(normalised);
  }
  return shown;
}

/* ── which runtime action can possibly work ─────────────────────────────────────────────────── */

export type NativeRuntimeAction = "stop" | "restart" | "measure";

export interface NativeActionAvailability {
  enabled: boolean;
  /** Why it is disabled, for the button's `title`. Null when it is enabled. NEVER empty when
   *  disabled — a control greyed out for an unstated reason is a support ticket. */
  reason: string | null;
}

/**
 * WHAT EACH RUNTIME BUTTON ACTUALLY REQUIRES, and the sentence to show when it is not met.
 *
 * ── THE BUG THIS EXISTS TO KILL ─────────────────────────────────────────────────────────────
 *
 * Restart was gated on `status.modelId === null` and nothing else. With a model on disk and no
 * `llama-server` anywhere, that made it a live, clickable, confident-looking button whose every
 * press was guaranteed to fail — the worst kind of control, because it teaches an operator that the
 * screen does not know what it is talking about.
 *
 * ── EACH RULE, AND WHY IT IS THAT RULE ──────────────────────────────────────────────────────
 *
 * STOP needs a process THIS PROCESS supervises. `external` mode reports `ready` when the sidecar
 * answers, and pressing Stop there does nothing at all: the child is somebody else's, and this
 * process has never held a handle to it. A button that silently no-ops is worse than one that
 * explains itself.
 *
 * RESTART needs a usable binary AND a model. Both, and the binary half is the one that was missing:
 * `restartNativeRuntime` replays the last launch, and a launch with no binary to spawn cannot
 * succeed however many times it is replayed. `binaryPath` is now resolved on every status read
 * precisely so this question is answerable before anybody presses anything.
 *
 * MEASURE needs a READY runtime, in either mode — the benchmark is an HTTP call to the base URL, so
 * a sidecar is a perfectly good thing to measure. It does not need a local binary at all.
 *
 * READ-ONLY AND BUSY COME FIRST because they are true regardless of the rest, and an operator
 * without permission should be told that rather than being told about a missing binary they cannot
 * do anything about anyway.
 */
export interface NativeActionStatus {
  state: NativeRuntimeState;
  mode: NativeRuntimeMode;
  modelId: string | null;
  binaryPath: string | null;
  binaryProblem: string | null;
}

const ALLOWED = { enabled: true, reason: null } as const;

/** Stop: a process THIS process supervises, and one that is actually up. */
function stopAvailability(status: NativeActionStatus): NativeActionAvailability {
  if (status.mode !== "embedded") {
    return {
      enabled: false,
      reason: `In ${status.mode} mode a separate service owns llama-server — this process only points at it, so there is nothing here to stop.`
    };
  }
  const running = status.state === "ready" || status.state === "starting" || status.state === "restarting";
  return running ? { ...ALLOWED } : { enabled: false, reason: `Nothing is running to stop — the runtime is ${status.state}.` };
}

/** Restart: a usable binary AND a model. The binary half is the one that was missing. */
function restartAvailability(status: NativeActionStatus): NativeActionAvailability {
  if (status.mode !== "embedded") {
    return {
      enabled: false,
      reason: `In ${status.mode} mode a separate service owns llama-server — restart it where it runs, not from here.`
    };
  }
  if (status.binaryPath === null) {
    return {
      enabled: false,
      // The server's own sentence when it has one: it names the actual problem (a bad
      // NATIVE_AI_SERVER_BIN, or nothing installed) far better than anything this file could
      // reconstruct from a null.
      reason:
        status.binaryProblem ??
        "There is no llama-server on this host to start, so a restart cannot succeed. Install the engine above first."
    };
  }
  if (status.modelId === null) {
    return {
      enabled: false,
      reason: "No model has been started yet, so there is no previous launch to repeat. Press Run on a model below."
    };
  }
  return { ...ALLOWED };
}

/** Measure: a READY runtime, in either mode — the benchmark is an HTTP call, so a sidecar is a
 *  perfectly good thing to measure and no local binary is needed. */
function measureAvailability(status: NativeActionStatus): NativeActionAvailability {
  if (status.state !== "ready") {
    return { enabled: false, reason: `The runtime has to be ready before it can be measured — it is ${status.state}.` };
  }
  if (status.modelId === null) return { enabled: false, reason: "Nothing is loaded, so there is no model to measure." };
  return { ...ALLOWED };
}

export function nativeRuntimeActionAvailability(input: {
  status: NativeActionStatus | null;
  action: NativeRuntimeAction;
  readOnly: boolean;
  busy: boolean;
}): NativeActionAvailability {
  // These three come FIRST because they are true regardless of the action, and an operator without
  // permission should be told that rather than about a missing binary they could not act on anyway.
  if (input.readOnly) return { enabled: false, reason: "You have read-only access to these settings." };
  if (input.busy) return { enabled: false, reason: "Another runtime action is still running." };
  const status = input.status;
  if (!status) return { enabled: false, reason: "The runtime status has not loaded yet." };
  if (status.mode === "off") {
    return { enabled: false, reason: "NATIVE_AI_RUNTIME_MODE is off, so there is no local runtime on this host to act on." };
  }

  if (input.action === "stop") return stopAvailability(status);
  if (input.action === "restart") return restartAvailability(status);
  return measureAvailability(status);
}

/* ── the honest provider row ────────────────────────────────────────────────────────────────── */

export interface NativeProviderRowPlan {
  /** What `enabled` the row should actually be created/saved with. */
  enabled: boolean;
  /** True when this plan DIFFERS from what the operator would naively expect (an enabled row). */
  heldBack: boolean;
  /** Stated at the moment of the click and repeated in the toast. Null when nothing needs saying. */
  warning: string | null;
}

/**
 * WHETHER A NATIVE PROVIDER ROW MAY BE CREATED LIVE, AND WHAT TO SAY WHEN IT MAY NOT.
 *
 * ── THE BUG THIS EXISTS TO KILL ─────────────────────────────────────────────────────────────
 *
 * The runner card's "Make it the primary provider" button is correctly disabled until something is
 * actually serving requests. The Add provider dialog had no such check, so a `LLAMA_CPP` row could
 * be created with no runtime behind it — and because a native row is the kind that belongs at the
 * top of the priority list, it landed there and became the first provider every AI feature tried and
 * the first one every AI feature failed on. The provider list showed exactly that:
 * "Native (llama.cpp) · Primary · Down", with the fallback quietly picking up the pieces.
 *
 * ── WHAT WAS CHOSEN, AND WHY IT IS NOT A REFUSAL ────────────────────────────────────────────
 *
 * The row is still CREATED — configuring a provider before installing its engine is a legitimate
 * order to do things in, and refusing would force an admin to keep the settings in their head until
 * the download finishes. What it must not do is silently become the primary FAILING provider. So it
 * is created DISABLED, the dialog says so before the click in those words, the toast repeats it, and
 * the provider list carries the reason on the row. Nothing here is silent, which is the actual
 * requirement: the failure mode being fixed is not "a disabled row" but "an operator who does not
 * know what their click did".
 *
 * AN ALREADY-ENABLED ROW IS NEVER TURNED OFF BY THIS. Editing an existing enabled row while the
 * runtime happens to be down is not the moment to override an administrator's explicit earlier
 * decision — they get the warning, not a surprise state change. `heldBack` is therefore only ever
 * true on creation.
 */
export function nativeProviderRowPlan(input: {
  isNew: boolean;
  /** The row's current/intended enabled state. */
  requestedEnabled: boolean;
  runtime: { state: NativeRuntimeState; mode: NativeRuntimeMode; detail?: string | null } | null;
}): NativeProviderRowPlan {
  const running = input.runtime?.state === "ready";
  if (running) return { enabled: input.requestedEnabled, heldBack: false, warning: null };

  let situation: string;
  if (input.runtime === null) situation = "the local runtime's status could not be read";
  else if (input.runtime.mode === "off") situation = "NATIVE_AI_RUNTIME_MODE is off on this host";
  else situation = `the local runtime is ${input.runtime.state}, not ready`;

  if (!input.isNew) {
    return {
      enabled: input.requestedEnabled,
      heldBack: false,
      warning: input.requestedEnabled
        ? `Heads up: ${situation}. While that is true, every AI feature will try this row first and fail over to the next provider. ` +
          `Its enabled state is left exactly as you set it — turning it off is your call, not this dialog's.`
        : null
    };
  }

  return {
    enabled: false,
    heldBack: true,
    warning:
      `This row will be added DISABLED, because ${situation}. A native row goes to the top of the priority list, so an enabled one ` +
      `with nothing behind it would be the first provider every AI feature tries and the first one every AI feature fails on — ` +
      `showing up as "Primary · Down" while the fallback quietly does the work. Start the runtime (or install the engine) and then ` +
      `turn this row on from the provider list.`
  };
}

/* ── the engine ─────────────────────────────────────────────────────────────────────────────── */

/**
 * The sentence stating what the Install button will fetch, from where, and roughly how big — the
 * whole thing said BEFORE the click, because downloading and then executing a binary from the
 * internet is a decision an operator makes knowingly or not at all.
 *
 * "About" is load-bearing on the size: it is the published-size ballpark from the resolver, and the
 * REAL byte count is measured from what arrives and shown on the row afterwards. Saying "26 MB" flat
 * about a number nobody has measured is the same class of dishonesty as an estimate wearing a
 * measurement's badge, which this panel refuses to do anywhere else.
 */
export function engineInstallOffer(asset: { assetName: string; url: string; releaseTag: string; approximateBytes: number }): string {
  let host = "github.com";
  try {
    host = new URL(asset.url).hostname;
  } catch {
    // A malformed URL is not a thing the resolver produces, and the offer sentence is not the place
    // to raise over it — the installer's own host allowlist refuses it a moment later anyway.
  }
  return (
    `Downloads ${asset.assetName} (about ${formatBytes(asset.approximateBytes)}) from ${host}, checks that it is really an archive, ` +
    `extracts only llama-server and the libraries it needs, and then RUNS it to confirm it works on this machine before calling it ` +
    `installed. Release ${asset.releaseTag} is pinned by this build — nothing resolves "latest".`
  );
}

/** The line under the engine bar. Extraction and the version probe share `installing` because they
 *  are one step from the operator's point of view — "it is being put in place" — and separating them
 *  would be two labels for four seconds. */
export function engineInstallStatusLabel(status: NativeEngineInstallStatus): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "downloading":
      return "Downloading the llama.cpp build";
    case "verifying":
      return "Verifying — hashing the archive and checking it really is one";
    case "installing":
      return "Installing — extracting, then running the binary to confirm it works here";
    case "ready":
      return "Installed on this machine";
    case "cancelled":
      return "Cancelled";
    default:
      return "Failed";
  }
}
