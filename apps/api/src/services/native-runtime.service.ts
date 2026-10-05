/**
 * WHAT: the supervisor for `llama-server` — llama.cpp's own OpenAI-compatible HTTP server, run as a
 * child of this process. Decides WHO runs it (embedded / external / off), starts it with the flags
 * that matter, waits for it to be READY rather than merely alive, restarts it on an unexpected exit
 * with a capped backoff, and kills it before this process exits.
 *
 * ── THE SINGLE MOST IMPORTANT PROPERTY IN THIS FILE ─────────────────────────────────────────
 *
 * NOTHING HERE MAY EVER STOP THE APPLICATION FROM STARTING. A missing binary, a missing model, a
 * port already in use, a directory that cannot be read — every one of them degrades to "the native
 * provider is unavailable", logged once, with the API booting and serving normally. This is an
 * optional AI accelerator sitting inside a timesheet and ticketing system; the day it takes payroll
 * down is the day it should never have been written. Every exported function either returns a
 * status object or resolves; `startNativeRuntimeIfConfigured` in particular catches everything and
 * is invoked from server.ts detached, exactly like `warmFaceModelsIfEnabled`.
 *
 * ── WHY THREE MODES, AND WHY DOCKER DEFAULTS TO A SIDECAR ───────────────────────────────────
 *
 * `embedded` is this process spawning the binary. That is the right answer on bare metal and under
 * WSL, where having `llama-server` on PATH is an ordinary thing.
 *
 * `external` is somebody else running it — a Docker Compose service, a Kubernetes sidecar — with
 * this process only pointing at the address. It is the DEFAULT under both orchestrators, and the
 * reason is not stylistic: this app's image is `node:24-alpine`, which is musl. Upstream llama.cpp
 * binaries are glibc, so baking one in means either building it in the image (turning a 200 MB image
 * into a compiler toolchain) or shipping a musl build this project would then own. A sidecar is the
 * idiomatic answer in both orchestrators, it is how everyone already runs models beside an app, and
 * it keeps the model's memory accounted for separately — which matters a great deal when the whole
 * point of block 2 was that a container's memory limit is the number that binds.
 *
 * `off` is the veto, and it costs nothing: every route answers "off" without touching the disk, the
 * PATH or a child process.
 *
 * ── READINESS IS NOT LIVENESS ───────────────────────────────────────────────────────────────
 *
 * `llama-server` binds its port immediately and then spends tens of seconds mapping and warming
 * several gigabytes of weights, answering `/health` with 503 throughout. So "the socket accepted" is
 * not "the model can answer", and a supervisor that conflated them would mark the provider usable
 * and hand it the first real request. We poll `/health` until it answers 200.
 *
 * AND THE WINDOW IS ALREADY HANDLED CORRECTLY BY THE DISPATCHER, which is worth verifying rather
 * than reimplementing: during startup the OpenAI client's connection failure maps to a 503 in
 * ai.service.ts#translateProviderError, and 503 is the one status `callChat` treats as "busy, not
 * broken" — it falls through to the next provider WITHOUT incrementing this row's circuit-breaker
 * counter. A model that takes forty seconds to load therefore costs nothing but a fallback, and a
 * test pins that behaviour instead of this file duplicating it.
 *
 * ── WHERE THE BINARY COMES FROM, AND WHEN ───────────────────────────────────────────────────
 *
 * Three sources, in order: `NATIVE_AI_SERVER_BIN`, then the engine an administrator installed from
 * the settings screen (services/native-engine.service.ts), then PATH. `resolveServerBinary` reports
 * WHICH of the three answered, because an operator debugging a version mismatch has to know.
 *
 * THIS FILE STILL DOWNLOADS NOTHING AND MUST NOT START DOING SO. An install is an explicit click by
 * an administrator who has been shown the release, the host, the asset name and the size first —
 * fetching and then EXECUTING a binary from the internet is not a thing that happens on boot because
 * a config flag was set. `startNativeRuntimeIfConfigured` therefore looks for a binary and degrades
 * when there is none, exactly as it always did; it never acquires one. `config/version.ts` declines
 * to spawn `git` at boot for the same family of reason.
 *
 * PATH is searched by READING it, not by shelling out to `which` — spawning a process to find out
 * whether we can spawn a process is a circular kind of silly.
 *
 * WHO CALLS THIS: server.ts (boot + shutdown) and the `/settings/ai/native/runtime*` routes.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  estimateNativeModelFit,
  findNativeModel,
  nativeEngineBinaryFileName,
  nativeEngineSidecarInstructions,
  nativeModelWithMeasuredSize,
  type NativeEngineBinarySource,
  type NativeKvCacheType,
  type NativeModelDownloadRow,
  type NativeRuntimeEnvironment,
  type NativeRuntimeMode,
  type NativeRuntimeState,
  type NativeRuntimeStatus
} from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import {
  NATIVE_AI_LOOPBACK_HOST,
  nativeAiPort,
  nativeEngineDirectory,
  nativeEngineReleaseTag,
  nativeEngineRoot,
  nativeProviderBaseUrl,
  nativeRuntimeHealthUrl,
  nativeRuntimeModeSetting,
  nativeServerBinaryOverride
} from "../config/native-ai.js";
import { AppError } from "../middleware/error.js";
import { detectRuntimeEnvironment, probeNativeHardware } from "./hardware-probe.service.js";
import { findReadyModel } from "./native-model-store.service.js";

/* ── tuning, each number a decision ─────────────────────────────────────────────────────────── */

/** How long a model may take to load before we call the start a failure. Generous: a 7B model on a
 *  cold page cache genuinely takes most of a minute on a spinning disk. */
export const NATIVE_READY_TIMEOUT_MS = 180_000;
/** Gap between `/health` polls while waiting. Short enough to feel responsive, long enough that a
 *  three-minute wait is not thousands of requests. */
const READY_POLL_INTERVAL_MS = 1_000;
/** Per-poll timeout. A hung socket must not consume the whole readiness budget in one attempt. */
const HEALTH_TIMEOUT_MS = 4_000;

/**
 * How many times an unexpectedly-dead runtime is restarted before the supervisor gives up.
 *
 * A CAP AND NOT PERSISTENCE. The failures that kill `llama-server` repeatedly are not transient:
 * an OOM kill, a corrupt model, a port taken by something else. Restarting forever turns a broken
 * configuration into a machine that spends every core loading a model that will die again, and the
 * log fills with identical lines until nobody reads it. Five attempts, then a terminal `failed`
 * state with the exit code in it, which the settings screen can show and a person can act on.
 */
export const NATIVE_MAX_RESTART_ATTEMPTS = 5;
const RESTART_BASE_DELAY_MS = 1_000;
/** Ceiling on the exponential delay. Beyond half a minute the operator is going to press the button
 *  themselves anyway. */
export const NATIVE_MAX_RESTART_DELAY_MS = 30_000;
/** Grace given to a SIGTERM before the child is killed outright, inside server.ts's 25-second
 *  shutdown budget with room to spare for Prisma and the telemetry flush behind it. */
const STOP_GRACE_MS = 5_000;

/** Exponential, capped. Exported so the test asserts against the real curve rather than its own. */
export function nativeRestartDelayMs(attempt: number): number {
  return Math.min(NATIVE_MAX_RESTART_DELAY_MS, RESTART_BASE_DELAY_MS * 2 ** Math.max(0, attempt));
}

/* ── the seam ───────────────────────────────────────────────────────────────────────────────── */

/**
 * Everything that touches the operating system, injectable for the same reason `HardwareProbeIo` is:
 * a test on a Windows laptop with no llama.cpp anywhere has to be able to describe a machine that
 * has one, a machine that does not, and a child process that keeps dying.
 */
export interface NativeRuntimeIo {
  spawnServer(binary: string, args: string[]): ChildProcess;
  fileExists(target: string): boolean;
  pathEntries(): string[];
  pathExtensions(): string[];
  /**
   * Absolute paths where an engine THIS DEPLOYMENT INSTALLED would be, most-preferred first.
   *
   * A separate seam member rather than more `pathEntries`, because the two are not the same kind of
   * thing: PATH is the operator's environment and this is a directory the app writes. Keeping them
   * apart is what lets the status report WHICH of the three sources produced the binary it is about
   * to spawn — a question an operator debugging a version mismatch has to be able to answer.
   */
  engineCandidates(): string[];
  platform(): NodeJS.Platform;
  /** True when the runtime answered `/health` with 200. Never throws — an unreachable server is an
   *  answer, not an exception. */
  probeHealth(url: string, timeoutMs: number): Promise<boolean>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const defaultNativeRuntimeIo: NativeRuntimeIo = {
  // Reviewed for sonarjs/no-os-command-from-path: `binary` is always an ABSOLUTE path by the time it
  // reaches here — `resolveServerBinary` either takes the operator's configured absolute path or
  // resolves a PATH entry to one itself — so the OS is never asked to search. Arguments are passed
  // as an array with no shell, so there is no interpolation surface either.
  spawnServer: (binary, args) => spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }),
  fileExists: (target) => existsSync(target),
  pathEntries: () => (process.env.PATH ?? "").split(path.delimiter).filter(Boolean),
  pathExtensions: () => (process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""]),
  /**
   * The pinned release first, then any other release still on disk, newest build number first.
   *
   * WHY THE FALLBACK EXISTS: bumping `nativeEnginePinnedReleaseTag` in a TimeSphere release would
   * otherwise make every box that had installed the previous one report "no binary" until somebody
   * noticed and reinstalled. An older engine that runs is worth more than a newer one that is not
   * there, and the status names which release it found either way.
   *
   * SYNCHRONOUS AND SWALLOWING ITS ERRORS, because `resolveServerBinary` is called from the boot
   * path and from a status endpoint, and neither may fail over a directory that does not exist yet —
   * which is the ordinary state of every installation that has never pressed Install.
   */
  engineCandidates: () => {
    const fileName = nativeEngineBinaryFileName(process.platform);
    const pinned = nativeEngineReleaseTag();
    const candidates = [path.join(nativeEngineDirectory(pinned), fileName)];
    try {
      const others = readdirSync(nativeEngineRoot(), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== pinned)
        .map((entry) => entry.name)
        .sort()
        .reverse();
      for (const tag of others) candidates.push(path.join(nativeEngineDirectory(tag), fileName));
    } catch {
      // No engine root yet. The pinned candidate above is still the right thing to check.
    }
    return candidates;
  },
  platform: () => process.platform,
  async probeHealth(url, timeoutMs) {
    // NO EGRESS GATE HERE, and that is correct rather than an oversight: this URL is derived by
    // config/native-ai.ts and points at loopback BY DESIGN. `assertPublicEgressTarget` exists to stop
    // a server from fetching a private address an ADMIN named; refusing to reach our own child
    // process would be the gate firing on the one case it was never about.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  },
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.())
};

/* ── mode resolution ────────────────────────────────────────────────────────────────────────── */

let cachedEnvironment: { kind: NativeRuntimeEnvironment; signals: string[] } | null = null;

async function environmentKind(): Promise<{ kind: NativeRuntimeEnvironment; signals: string[] }> {
  // Cached for the process lifetime: a machine does not stop being a Kubernetes pod, and this is
  // read by a status endpoint a settings screen polls.
  cachedEnvironment ??= await detectRuntimeEnvironment();
  return cachedEnvironment;
}

/** Test seam only — the environment probe is cached for the process lifetime, which a suite that
 *  describes three different machines has to be able to undo. */
export function resetNativeRuntimeEnvironmentCache(): void {
  cachedEnvironment = null;
}

/**
 * Who runs `llama-server` here, and the sentence explaining it.
 *
 * The explicit setting always wins. `auto` asks where we are: a container or a pod means a sidecar
 * (see the header), anything else means we can spawn it ourselves.
 */
export async function resolveNativeRuntimeMode(): Promise<{ mode: NativeRuntimeMode; reason: string }> {
  const setting = nativeRuntimeModeSetting();
  if (setting !== "auto") {
    return { mode: setting, reason: `NATIVE_AI_RUNTIME_MODE is set to "${setting}", so the environment was not consulted.` };
  }
  const { kind, signals } = await environmentKind();
  if (kind === "docker" || kind === "kubernetes") {
    return {
      mode: "external",
      reason:
        `${kind} detected (${signals.join("; ") || "no signal"}), so a sidecar is assumed. This image is Alpine/musl and upstream ` +
        `llama.cpp builds are glibc, which is why a container defaults to pointing at a separate service rather than spawning one.`
    };
  }
  return {
    mode: "embedded",
    reason: `${kind} detected (${signals.join("; ") || "no signal"}), so this process will start and supervise llama-server itself.`
  };
}

/* ── binary resolution ──────────────────────────────────────────────────────────────────────── */

const BINARY_NAME = "llama-server";

/**
 * The absolute path of `llama-server`, WHERE IT CAME FROM, or the reason there isn't one.
 *
 * THREE SOURCES, IN THIS ORDER, AND THE ORDER IS A DECISION:
 *   1. `NATIVE_AI_SERVER_BIN` — an explicit instruction from whoever owns the machine. It wins over
 *      everything, and when it points at nothing the answer is that failure, never a quiet fallback
 *      to something else: an operator who named a path is debugging THAT path.
 *   2. The engine this deployment installed (services/native-engine.service.ts). Ahead of PATH
 *      because it is the one this app fetched, verified and RAN before calling it installed, and
 *      because a stale llama-server from some unrelated experiment sitting on PATH is exactly the
 *      version mismatch nobody enjoys diagnosing.
 *   3. PATH.
 *
 * THE `problem` SENTENCE IS NO LONGER A DEAD END, and that was the actual bug. It used to end at
 * "nothing is downloaded to satisfy this — install llama.cpp on this host", which is a wall with an
 * instruction painted on it: the operator had just watched a 940 MB model download and verify, and
 * the panel's last word was "now go and build a C++ project". It now names the button that fixes it.
 *
 * Never throws and never spawns. PATH is READ and each candidate stat-ed, which is all `which` does
 * anyway — and doing it in-process means "is the binary present" cannot itself be the thing that
 * fails at boot.
 */
export function resolveServerBinary(io: NativeRuntimeIo = defaultNativeRuntimeIo): {
  path: string | null;
  source: NativeEngineBinarySource | null;
  problem: string | null;
} {
  const configured = nativeServerBinaryOverride();
  if (configured) {
    if (io.fileExists(configured)) return { path: configured, source: "configured", problem: null };
    return {
      path: null,
      source: null,
      problem: `NATIVE_AI_SERVER_BIN points at "${configured}", which does not exist on this host. Correct it or clear it to use the engine installed from this screen, or PATH.`
    };
  }

  for (const candidate of io.engineCandidates()) {
    if (io.fileExists(candidate)) return { path: candidate, source: "managed", problem: null };
  }

  const extensions = io.pathExtensions();
  const searched = io.pathEntries();
  for (const dir of searched) {
    for (const ext of extensions) {
      const candidate = path.join(dir, `${BINARY_NAME}${ext}`);
      if (io.fileExists(candidate)) return { path: candidate, source: "path", problem: null };
    }
  }
  return {
    path: null,
    source: null,
    problem:
      `"${BINARY_NAME}" is not installed on this host: nothing has been installed from this screen, NATIVE_AI_SERVER_BIN is not set, ` +
      `and it is not on PATH (${searched.length} ${searched.length === 1 ? "directory" : "directories"} searched). ` +
      `Use "Install the engine" above to fetch the pinned llama.cpp build for this machine — or point NATIVE_AI_SERVER_BIN at a ` +
      `binary you installed yourself. ${nativeEngineSidecarInstructions}`
  };
}

/* ── supervisor state ───────────────────────────────────────────────────────────────────────── */

interface RuntimeState {
  state: NativeRuntimeState;
  detail: string;
  child: ChildProcess | null;
  binaryPath: string | null;
  binarySource: NativeEngineBinarySource | null;
  binaryProblem: string | null;
  modelId: string | null;
  modelPath: string | null;
  contextTokens: number | null;
  threads: number | null;
  kvCacheType: NativeKvCacheType | null;
  parallelSlots: number | null;
  startedAt: Date | null;
  readyAt: Date | null;
  lastError: string | null;
  attempts: number;
  nextRetryAt: Date | null;
  lastExitCode: number | null;
  lastExitSignal: string | null;
  /** Set while a deliberate stop is in progress, so the exit handler knows not to restart. */
  stopping: boolean;
  restartTimer: NodeJS.Timeout | null;
  /** The tail of the child's stderr, which is where llama.cpp explains itself. Bounded, because an
   *  unbounded buffer of a chatty process is a slow memory leak. */
  stderrTail: string[];
}

const runtime: RuntimeState = {
  state: "stopped",
  detail: "Not started.",
  child: null,
  binaryPath: null,
  binarySource: null,
  binaryProblem: null,
  modelId: null,
  modelPath: null,
  contextTokens: null,
  threads: null,
  kvCacheType: null,
  parallelSlots: null,
  startedAt: null,
  readyAt: null,
  lastError: null,
  attempts: 0,
  nextRetryAt: null,
  lastExitCode: null,
  lastExitSignal: null,
  stopping: false,
  restartTimer: null,
  stderrTail: []
};

/** What a restart needs in order to be the same start again. */
let lastLaunch: NativeRuntimeLaunch | null = null;

export interface NativeRuntimeLaunch {
  modelId: string;
  modelPath: string;
  contextTokens: number;
  threads: number | null;
  kvCacheType: NativeKvCacheType;
  parallelSlots: number;
}

/** Test seam: the supervisor is module-level state by nature (there is one host and one child), so a
 *  suite that exercises several lifecycles has to be able to put it back. */
export function resetNativeRuntimeState(): void {
  if (runtime.restartTimer) clearTimeout(runtime.restartTimer);
  Object.assign(runtime, {
    state: "stopped",
    detail: "Not started.",
    child: null,
    binaryPath: null,
    binarySource: null,
    binaryProblem: null,
    modelId: null,
    modelPath: null,
    contextTokens: null,
    threads: null,
    kvCacheType: null,
    parallelSlots: null,
    startedAt: null,
    readyAt: null,
    lastError: null,
    attempts: 0,
    nextRetryAt: null,
    lastExitCode: null,
    lastExitSignal: null,
    stopping: false,
    restartTimer: null,
    stderrTail: []
  });
  lastLaunch = null;
  cachedEnvironment = null;
}

/* ── status ─────────────────────────────────────────────────────────────────────────────────── */

/**
 * What the runtime is, right now. Safe to call at any time, in any mode, with nothing configured —
 * the settings screen polls it and it must never be the reason a page 500s.
 */
export async function getNativeRuntimeStatus(io: NativeRuntimeIo = defaultNativeRuntimeIo): Promise<NativeRuntimeStatus> {
  const { mode, reason } = await resolveNativeRuntimeMode();
  const { kind } = mode === "off" ? { kind: "unknown" as NativeRuntimeEnvironment } : await environmentKind();

  // RESOLVED ON EVERY EMBEDDED STATUS, not only after a start has been attempted.
  //
  // WHY THAT MATTERS AND IS NOT MERELY TIDY: the settings screen has to decide whether Restart can
  // possibly work, and "is there a binary" is half that answer. Before this, `binaryPath` and
  // `binaryProblem` were both null until somebody pressed Start — so on first paint the screen knew
  // nothing about the binary and offered a Restart button that was certain to fail. It is a PATH
  // read and a handful of `stat` calls, which is what the status endpoint's own polling can afford.
  if (mode === "embedded" && !runtime.child) {
    const resolved = resolveServerBinary(io);
    runtime.binaryPath = resolved.path;
    runtime.binarySource = resolved.source;
    runtime.binaryProblem = resolved.problem;
  }

  const base: NativeRuntimeStatus = {
    mode,
    modeReason: reason,
    state: runtime.state,
    detail: runtime.detail,
    baseUrl: mode === "off" ? null : nativeProviderBaseUrl(),
    binaryPath: runtime.binaryPath,
    binarySource: runtime.binarySource,
    binaryProblem: runtime.binaryProblem,
    modelId: runtime.modelId,
    modelPath: runtime.modelPath,
    pid: runtime.child?.pid ?? null,
    contextTokens: runtime.contextTokens,
    threads: runtime.threads,
    kvCacheType: runtime.kvCacheType,
    parallelSlots: runtime.parallelSlots,
    startedAt: runtime.startedAt?.toISOString() ?? null,
    readyAt: runtime.readyAt?.toISOString() ?? null,
    lastError: runtime.lastError,
    restarts: {
      attempts: runtime.attempts,
      maxAttempts: NATIVE_MAX_RESTART_ATTEMPTS,
      nextRetryAt: runtime.nextRetryAt?.toISOString() ?? null,
      lastExitCode: runtime.lastExitCode,
      lastExitSignal: runtime.lastExitSignal
    },
    environment: kind
  };

  if (mode === "off") {
    return { ...base, state: "off", detail: "NATIVE_AI_RUNTIME_MODE is off, so no local model runtime is used on this host." };
  }

  if (mode === "external") {
    // Nothing to supervise: the only truthful thing to report is whether the address answers.
    const healthy = await defaultNativeRuntimeIo.probeHealth(nativeRuntimeHealthUrl(), HEALTH_TIMEOUT_MS);
    return {
      ...base,
      state: healthy ? "ready" : "unavailable",
      detail: healthy
        ? `An external llama-server is answering at ${nativeRuntimeHealthUrl()}. This process does not supervise it.`
        : `No llama-server is answering at ${nativeRuntimeHealthUrl()}. In external mode this process points at a sidecar rather than ` +
          `starting one — check that the sidecar is running and that NATIVE_AI_HOST/NATIVE_AI_PORT name it.`,
      pid: null
    };
  }

  return base;
}

/* ── starting ───────────────────────────────────────────────────────────────────────────────── */

/**
 * The flags that matter, and only those.
 *
 * `--host 127.0.0.1` IS A SECURITY CONTROL, not a default. `llama-server` has no authentication
 * worth the name; bound to 0.0.0.0 it is an unauthenticated inference endpoint on every interface
 * the host has, reachable by anything on the network, spending the machine's whole CPU on request.
 * An embedded runtime is therefore ALWAYS loopback, regardless of NATIVE_AI_HOST — that variable
 * exists to point at somebody else's sidecar, never to publish ours.
 *
 * `--parallel` is kept consistent with the provider row's `maxConcurrent`, because the two describe
 * the same thing from opposite ends: the row says how many calls the dispatcher will have in flight,
 * and this says how many slots the server has to serve them. Fewer slots than callers means the
 * extra ones queue INSIDE llama.cpp, where the app can no longer make a routing decision about them
 * — which is exactly the failure `maxConcurrent` was added to prevent for Ollama.
 */
export function buildServerArgs(launch: NativeRuntimeLaunch): string[] {
  const args = [
    "--model",
    launch.modelPath,
    "--host",
    NATIVE_AI_LOOPBACK_HOST,
    "--port",
    String(nativeAiPort()),
    "--ctx-size",
    String(launch.contextTokens),
    "--parallel",
    String(launch.parallelSlots),
    // KV cache element type for both halves. q8_0 halves the cache at a quality cost small enough to
    // be worth it at long contexts — the estimator already models the difference.
    "--cache-type-k",
    launch.kvCacheType,
    "--cache-type-v",
    launch.kvCacheType
  ];
  // Omitted rather than guessed when the machine would not tell us its core count: llama.cpp's own
  // default is a better answer than a number this app invented.
  if (launch.threads !== null) args.push("--threads", String(launch.threads));
  return args;
}

function setState(state: NativeRuntimeState, detail: string): void {
  runtime.state = state;
  runtime.detail = detail;
}

/**
 * Everything a launch needs, filled in from the stored model, the machine and the provider row.
 *
 * The context and thread counts come from `estimateNativeModelFit` running on the MEASURED file
 * size, so the runtime is started with the numbers block 2 computed rather than a second opinion.
 */
export async function planLaunch(
  modelId: string,
  overrides: { contextTokens?: number; threads?: number; kvCacheType?: NativeKvCacheType; parallelSlots?: number } = {}
): Promise<NativeRuntimeLaunch> {
  const stored = await findReadyModel(modelId);
  if (!stored || !stored.filePath) {
    throw new AppError(409, `"${modelId}" has not been downloaded on this host yet, so there is nothing to run. Download it first.`);
  }
  const catalogueEntry = findNativeModel(modelId);
  if (!catalogueEntry) {
    throw new AppError(422, `"${modelId}" is no longer in this build's catalogue, so its architecture is unknown and it cannot be started.`);
  }
  const entry = nativeModelWithMeasuredSize(catalogueEntry, stored.fileSizeBytes);

  const kvCacheType = overrides.kvCacheType ?? "f16";
  const hardware = await probeNativeHardware(path.dirname(stored.filePath));
  const estimate = estimateNativeModelFit(hardware, entry, entry.recommendedContextTokens, kvCacheType);

  return {
    modelId,
    modelPath: stored.filePath,
    contextTokens: overrides.contextTokens ?? estimate.recommended.contextTokens ?? entry.recommendedContextTokens,
    threads: overrides.threads ?? estimate.recommended.threads,
    kvCacheType,
    parallelSlots: overrides.parallelSlots ?? (await providerSlotCount())
  };
}

/** The enabled native provider row's declared concurrency, defaulted to the column's own default.
 *  Read rather than assumed so the server's slot count and the dispatcher's in-flight ceiling say
 *  the same number. */
async function providerSlotCount(): Promise<number> {
  try {
    const row = await prisma.aIProviderConfig.findFirst({ where: { provider: "LLAMA_CPP", enabled: true }, orderBy: { priority: "asc" } });
    return row?.maxConcurrent ?? 2;
  } catch {
    return 2;
  }
}

/**
 * Start (or restart) the runtime. Resolves once the server is READY or once the attempt has failed —
 * and a failure is a returned status, never a thrown error, because every caller of this is either a
 * settings route that must render something or the boot path that must not die.
 */
export async function startNativeRuntime(
  launch: NativeRuntimeLaunch,
  io: NativeRuntimeIo = defaultNativeRuntimeIo
): Promise<NativeRuntimeStatus> {
  const { mode } = await resolveNativeRuntimeMode();
  if (mode !== "embedded") {
    // Not an error: in external mode the runtime is somebody else's to start, and in `off` mode
    // there isn't one. Both are reported by the status, which is what the caller renders anyway.
    return getNativeRuntimeStatus(io);
  }

  const binary = resolveServerBinary(io);
  runtime.binaryPath = binary.path;
  runtime.binarySource = binary.source;
  runtime.binaryProblem = binary.problem;
  if (!binary.path) {
    // THE CASE THIS FILE EXISTS TO GET RIGHT. No binary is a degraded feature, not a failed boot.
    //
    // `lastError` IS CLEARED HERE, NOT SET TO THE SAME SENTENCE, and that is a real fix rather than
    // cosmetics. The three fields mean three different things — `detail` explains the state,
    // `binaryProblem` is a fixable configuration problem, `lastError` is something that went wrong
    // while running — and this branch used to write one string into all three. The settings screen
    // then rendered the identical paragraph three times under three different icons, which reads as
    // broken software even though the state underneath it was perfectly correct. A missing binary is
    // not an error that occurred; it is a precondition that is not met, and `binaryProblem` is the
    // field for it. (The screen deduplicates on content as well — see `runtimeMessageLines` in
    // apps/web/src/utils/native-model-panel.ts — because two fields can still legitimately coincide.)
    setState("unavailable", binary.problem ?? `${BINARY_NAME} is not available on this host.`);
    runtime.lastError = null;
    return getNativeRuntimeStatus(io);
  }

  await stopNativeRuntime(io);
  lastLaunch = launch;
  runtime.stopping = false;
  runtime.modelId = launch.modelId;
  runtime.modelPath = launch.modelPath;
  runtime.contextTokens = launch.contextTokens;
  runtime.threads = launch.threads;
  runtime.kvCacheType = launch.kvCacheType;
  runtime.parallelSlots = launch.parallelSlots;
  runtime.startedAt = new Date();
  runtime.readyAt = null;
  runtime.stderrTail = [];
  setState("starting", `Starting ${BINARY_NAME} for ${launch.modelId}; waiting for it to finish loading the weights.`);

  let child: ChildProcess;
  try {
    child = io.spawnServer(binary.path, buildServerArgs(launch));
  } catch (error) {
    // ENOENT, EACCES, or a binary for the wrong architecture. Degrade, do not throw.
    runtime.lastError = `Could not start ${binary.path}: ${(error as Error).message}`;
    setState("unavailable", runtime.lastError);
    return getNativeRuntimeStatus(io);
  }

  runtime.child = child;
  attachChildHandlers(child, io);
  registerExitKill();

  const ready = await waitForReady(io);
  if (!ready) {
    // THE CHILD DIED RATHER THAN FAILING TO ANSWER, and the exit handler has already classified that
    // — `restarting` with a scheduled attempt, or `failed` once the attempts ran out. Overwriting it
    // here would cancel the backoff for exactly the failure the backoff exists for: a runtime that
    // crashes seconds after every start.
    if (runtime.state === "restarting" || runtime.state === "failed") return getNativeRuntimeStatus(io);
    runtime.lastError =
      `${BINARY_NAME} did not become ready within ${Math.round(NATIVE_READY_TIMEOUT_MS / 1000)} seconds. ` +
      (runtime.stderrTail.length > 0 ? `Its last output was: ${runtime.stderrTail.slice(-3).join(" ").slice(0, 400)}` : "It produced no output.");
    // Stop FIRST and set the state AFTER, not the other way round: `stopNativeRuntime` ends by
    // reporting `stopped`, which would otherwise erase the only sentence explaining why a runtime
    // that is bound, alive and useless was abandoned.
    await stopNativeRuntime(io);
    setState("failed", runtime.lastError);
    return getNativeRuntimeStatus(io);
  }

  runtime.readyAt = new Date();
  runtime.attempts = 0;
  runtime.nextRetryAt = null;
  runtime.lastError = null;
  setState("ready", `${BINARY_NAME} is serving ${launch.modelId} at ${nativeProviderBaseUrl()} with ${launch.contextTokens} tokens of context.`);
  return getNativeRuntimeStatus(io);
}

/** Polls `/health` until it answers or the budget runs out. The child dying mid-wait short-circuits
 *  it — there is no point spending three minutes polling for a process that has already exited. */
async function waitForReady(io: NativeRuntimeIo): Promise<boolean> {
  const deadline = io.now() + NATIVE_READY_TIMEOUT_MS;
  while (io.now() < deadline) {
    if (!runtime.child || runtime.child.exitCode !== null || runtime.child.signalCode !== null) return false;
    if (await io.probeHealth(nativeRuntimeHealthUrl(), HEALTH_TIMEOUT_MS)) return true;
    await io.sleep(READY_POLL_INTERVAL_MS);
  }
  return false;
}

function attachChildHandlers(child: ChildProcess, io: NativeRuntimeIo): void {
  child.stderr?.on("data", (chunk: Buffer) => {
    runtime.stderrTail.push(chunk.toString("utf8").trim());
    // Bounded: llama.cpp is chatty and this is a diagnostic tail, not a log sink.
    if (runtime.stderrTail.length > 20) runtime.stderrTail.splice(0, runtime.stderrTail.length - 20);
  });
  // Swallowed deliberately: llama-server writes its request log to stdout, and piping it into this
  // process's log would drown every other line at any real request rate.
  child.stdout?.resume();

  child.on("error", (error) => {
    runtime.lastError = `${BINARY_NAME} error: ${error.message}`;
  });

  child.on("exit", (code, signal) => {
    runtime.lastExitCode = code;
    runtime.lastExitSignal = signal;
    runtime.child = null;
    if (runtime.stopping) {
      setState("stopped", `${BINARY_NAME} was stopped.`);
      return;
    }
    scheduleRestart(code, signal, io);
  });
}

/**
 * An unexpected exit, handled with a capped exponential backoff and a terminal state.
 *
 * NEVER A TIGHT LOOP, and the failure this prevents is specific: a model whose file is corrupt, or a
 * port already taken, makes `llama-server` exit within a second of every start. Restarting
 * immediately would peg a core loading weights forever, and the log would be one identical line per
 * second until the disk filled.
 */
function scheduleRestart(code: number | null, signal: NodeJS.Signals | null, io: NativeRuntimeIo): void {
  runtime.attempts += 1;
  const reason = signal ? `signal ${signal}` : `exit code ${code}`;

  if (runtime.attempts > NATIVE_MAX_RESTART_ATTEMPTS || !lastLaunch) {
    runtime.nextRetryAt = null;
    runtime.lastError = `${BINARY_NAME} exited with ${reason} and did not stay up after ${NATIVE_MAX_RESTART_ATTEMPTS} restart attempts.`;
    setState(
      "failed",
      `${runtime.lastError} It will not be restarted again automatically. ` +
        (runtime.stderrTail.length > 0 ? `Its last output was: ${runtime.stderrTail.slice(-3).join(" ").slice(0, 400)}` : "")
    );
    return;
  }

  const delay = nativeRestartDelayMs(runtime.attempts - 1);
  runtime.nextRetryAt = new Date(Date.now() + delay);
  runtime.lastError = `${BINARY_NAME} exited with ${reason}.`;
  setState(
    "restarting",
    `${runtime.lastError} Restart ${runtime.attempts} of ${NATIVE_MAX_RESTART_ATTEMPTS} in ${Math.round(delay / 1000)}s.`
  );

  const launch = lastLaunch;
  runtime.restartTimer = setTimeout(() => {
    runtime.restartTimer = null;
    void startNativeRuntime(launch, io).catch((error) => console.warn(`[native-runtime] restart failed: ${(error as Error).message}`));
  }, delay);
  // Unref'd so a pending restart cannot hold the process open through a shutdown.
  runtime.restartTimer.unref?.();
}

/* ── stopping ───────────────────────────────────────────────────────────────────────────────── */

/**
 * Stop the child and wait for it to actually be gone, honouring a grace period before SIGKILL.
 *
 * Idempotent and safe when nothing is running, because it is called from the shutdown path, from a
 * settings route, and from `startNativeRuntime` before every launch.
 */
export async function stopNativeRuntime(io: NativeRuntimeIo = defaultNativeRuntimeIo): Promise<NativeRuntimeStatus> {
  if (runtime.restartTimer) {
    clearTimeout(runtime.restartTimer);
    runtime.restartTimer = null;
  }
  runtime.nextRetryAt = null;

  const child = runtime.child;
  if (!child) {
    if (runtime.state === "starting" || runtime.state === "ready" || runtime.state === "restarting") {
      setState("stopped", `${BINARY_NAME} is not running.`);
    }
    return getNativeRuntimeStatus(io);
  }

  runtime.stopping = true;
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
  });

  try {
    child.kill("SIGTERM");
  } catch {
    // Already dead. The wait below resolves immediately.
  }

  await Promise.race([exited, io.sleep(STOP_GRACE_MS)]);
  if (runtime.child) {
    // The grace window is over and it is still there. A model that will not put itself down must not
    // outlive this process — see `registerExitKill` for the last-resort half of the same promise.
    try {
      runtime.child.kill("SIGKILL");
    } catch {
      // Nothing further to try; the exit handler will clear the reference if it ever fires.
    }
    runtime.child = null;
  }
  runtime.stopping = false;
  setState("stopped", `${BINARY_NAME} was stopped.`);
  return getNativeRuntimeStatus(io);
}

/**
 * THE LAST-RESORT KILL, registered once and synchronous.
 *
 * server.ts's graceful shutdown awaits `stopNativeRuntime`, which is the normal path. It is not the
 * only path: the shutdown budget can expire and force `process.exit(1)`, and an `uncaughtException`
 * routes into the same shutdown from a process that may already be damaged. `process.on("exit")`
 * runs on every one of those and may only do synchronous work, so this does exactly one synchronous
 * thing. A leaked `llama-server` holding several gigabytes and the API's port is a real failure mode
 * — the next start then fails with EADDRINUSE, and the operator sees a model that "will not start"
 * on a machine that is already running it.
 */
let exitKillRegistered = false;
function registerExitKill(): void {
  if (exitKillRegistered) return;
  exitKillRegistered = true;
  process.on("exit", () => {
    try {
      runtime.child?.kill("SIGKILL");
    } catch {
      // Nothing can be done at this point and nothing should be logged: the process is leaving.
    }
  });
}

export async function restartNativeRuntime(io: NativeRuntimeIo = defaultNativeRuntimeIo): Promise<NativeRuntimeStatus> {
  if (!lastLaunch) {
    return getNativeRuntimeStatus(io);
  }
  runtime.attempts = 0;
  return startNativeRuntime(lastLaunch, io);
}

/* ── the boot hook ──────────────────────────────────────────────────────────────────────────── */

/**
 * Start the runtime at boot IF some workspace has actually asked for one — the same shape and the
 * same contract as `warmFaceModelsIfEnabled`, and invoked from server.ts the same way (detached,
 * `void … .catch(warn)`).
 *
 * A DEPLOYMENT THAT NEVER ENABLES THIS PAYS ONE QUERY PER ORG AND NOTHING ELSE. The gate is an
 * ENABLED `LLAMA_CPP` provider row whose `model` names a download this host has already completed;
 * absent that, nothing is spawned, nothing is probed, and no binary is looked for.
 *
 * ONE HOST, ONE RUNTIME, AND THAT IS A REAL BOUND WORTH STATING. `llama-server` serves one model per
 * process, and this process supervises one of them, while provider rows are per-tenant. So the first
 * workspace found with a runnable native row decides which model this host serves. That is the right
 * trade for the deployment shape this feature is for — a self-hosted install, usually one tenant, on
 * hardware the operator owns — and it is deliberately not solved by spawning a server per tenant,
 * which would multiply the one resource (memory) that the whole fit estimator exists to ration.
 */
export async function startNativeRuntimeIfConfigured(
  runForEveryOrg: (label: string, fn: () => Promise<void>) => Promise<void>,
  io: NativeRuntimeIo = defaultNativeRuntimeIo
): Promise<void> {
  const { mode, reason } = await resolveNativeRuntimeMode();
  if (mode === "off") return;

  let chosen: { modelId: string; slots: number } | null = null;
  await runForEveryOrg("native-runtime", async () => {
    if (chosen) return;
    const row = await prisma.aIProviderConfig.findFirst({ where: { provider: "LLAMA_CPP", enabled: true }, orderBy: { priority: "asc" } });
    if (!row) return;
    const stored: NativeModelDownloadRow | null = await findReadyModel(row.model);
    if (!stored) return;
    chosen = { modelId: row.model, slots: row.maxConcurrent };
  });

  if (!chosen) return;
  const target = chosen as { modelId: string; slots: number };

  if (mode === "external") {
    console.log(`[native-runtime] ${reason} Pointing at ${nativeProviderBaseUrl()} for ${target.modelId}; this process starts nothing.`);
    return;
  }

  const launch = await planLaunch(target.modelId, { parallelSlots: target.slots });
  const startedAt = Date.now();
  const status = await startNativeRuntime(launch, io);
  if (status.state === "ready") {
    console.log(`[native-runtime] ${BINARY_NAME} ready for ${target.modelId} in ${Date.now() - startedAt} ms — ${status.detail}`);
  } else {
    // ONE line, not a loop of them, and a warning rather than a failure: the app is up and every
    // other provider still works. This is the sentence an operator reads to find out why the native
    // row is not being tried.
    console.warn(`[native-runtime] native provider unavailable: ${status.detail}`);
  }
}

/** Where the runtime is addressed. Exported for the benchmark, which must talk to the same server
 *  the dispatcher does rather than deriving a second answer. */
export function nativeRuntimeBaseUrl(): string {
  return nativeProviderBaseUrl();
}
