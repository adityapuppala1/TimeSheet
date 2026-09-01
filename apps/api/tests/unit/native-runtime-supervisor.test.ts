/**
 * THE RUNTIME SUPERVISOR AND THE BENCHMARK — who runs `llama-server`, what happens when it will not
 * run, and the one number the whole block exists to produce.
 *
 * ── THE PROPERTY THAT MATTERS MOST, AND IT IS A NEGATIVE ONE ────────────────────────────────
 *
 * NOTHING HERE MAY STOP THE APPLICATION FROM STARTING. This is an optional AI accelerator inside a
 * timesheet and ticketing system, and the failure modes it invites — no binary on PATH, a model that
 * was never downloaded, a port already taken, a child that crashes on every start — are all ordinary
 * misconfigurations. Every one of them has to end as "the native provider is unavailable", logged
 * once, with the API serving normally. That is impossible to notice by reading a passing suite, so it
 * is asserted directly: the boot hook is called against a machine with nothing installed, and the
 * test's success condition is that it RESOLVES.
 *
 * ── THE OTHER THREE ─────────────────────────────────────────────────────────────────────────
 *
 * RESTART BACKOFF THAT TERMINATES. A model file that is corrupt, or a port owned by something else,
 * makes `llama-server` exit within a second of every start. A supervisor without a cap turns that
 * into a machine pegged loading weights forever and a log of one identical line per second. Both
 * halves are pinned: the delay curve grows and is capped, and the attempts run out into a terminal
 * state a person can act on.
 *
 * A CHILD THAT DOES NOT OUTLIVE US. A leaked `llama-server` holds gigabytes and this process's model
 * port, so the next start fails with EADDRINUSE on a machine that is already running the thing it
 * claims it cannot start.
 *
 * THE BENCHMARK IS THE POINT. `estimateNativeModelFit` guesses generation speed from assumed memory
 * bandwidth and says `measured: false`. The measurement replaces it, and the number it produces goes
 * straight into `AIProviderConfig.maxOutputTokens`, which is what the dispatcher's demand filter
 * consumes. The last test in this file follows that number end to end through the REAL routing
 * function, because a benchmark whose output nothing reads is a decoration.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import type { NativeHardwareSnapshot } from "@timesheet/shared";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";

const { modeSetting, binaryOverride, environmentKind, readyModel } = vi.hoisted(() => ({
  modeSetting: { value: "auto" as "auto" | "embedded" | "external" | "off" },
  binaryOverride: { value: "" },
  environmentKind: { value: "bare-metal" as string, signals: ["no container or WSL signal found"] },
  readyModel: { value: null as null | { modelId: string; filePath: string; fileSizeBytes: number | null } }
}));

// PARTIAL, keeping the URL derivation real: `nativeProviderBaseUrl` and `nativeRuntimeHealthUrl` are
// what the supervisor and the dispatcher must agree on, so replacing them would test the mock.
vi.mock("../../src/config/native-ai.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  nativeRuntimeModeSetting: () => modeSetting.value,
  nativeServerBinaryOverride: () => binaryOverride.value
}));

vi.mock("../../src/services/hardware-probe.service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  detectRuntimeEnvironment: async () => ({ kind: environmentKind.value, signals: environmentKind.signals }),
  probeNativeHardware: async (): Promise<NativeHardwareSnapshot> => ({
    sampledAt: new Date().toISOString(),
    cpu: {
      model: "Test CPU",
      logicalCores: 8,
      physicalCores: 4,
      arch: "x64",
      instructionSets: { avx2: true, avx512: false, neon: null, dotprod: null },
      quotaCores: null,
      quotaSource: null
    },
    memory: {
      hostTotalBytes: 32 * 1024 ** 3,
      hostAvailableBytes: 24 * 1024 ** 3,
      cgroupLimitBytes: null,
      cgroupUsageBytes: null,
      cgroupSource: null,
      effectiveTotalBytes: 32 * 1024 ** 3,
      effectiveAvailableBytes: 24 * 1024 ** 3
    },
    environment: { kind: "bare-metal", signals: [] },
    disk: { path: "/models", freeBytes: 500 * 1024 ** 3, totalBytes: 900 * 1024 ** 3 }
  })
}));

vi.mock("../../src/services/native-model-store.service.js", () => ({
  findReadyModel: async (modelId: string) =>
    readyModel.value && readyModel.value.modelId === modelId
      ? { ...readyModel.value, id: "download-1", status: "ready", benchmark: null, catalogue: null }
      : null,
  recordNativeBenchmark: async (modelId: string, measurement: Record<string, number>) => ({
    id: "download-1",
    modelId,
    status: "ready",
    bytesDownloaded: 0,
    bytesTotal: null,
    fileSizeBytes: 1_000,
    sha256: null,
    filePath: "/models/x.gguf",
    error: null,
    startedAt: null,
    completedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    catalogue: null,
    benchmark: {
      measuredAt: new Date().toISOString(),
      timeToFirstTokenMs: measurement.timeToFirstTokenMs,
      tokensPerSecond: measurement.tokensPerSecond,
      outputTokens: measurement.outputTokens,
      totalMs: measurement.totalMs,
      suggestedMaxOutputTokens: measurement.suggestedMaxOutputTokens,
      basis: "Measured on this machine."
    }
  })
}));

const {
  NATIVE_MAX_RESTART_ATTEMPTS,
  NATIVE_MAX_RESTART_DELAY_MS,
  buildServerArgs,
  getNativeRuntimeStatus,
  nativeRestartDelayMs,
  planLaunch,
  resetNativeRuntimeState,
  resolveNativeRuntimeMode,
  resolveServerBinary,
  restartNativeRuntime,
  startNativeRuntime,
  startNativeRuntimeIfConfigured,
  stopNativeRuntime
} = await import("../../src/services/native-runtime.service.js");
type NativeRuntimeIo = import("../../src/services/native-runtime.service.js").NativeRuntimeIo;

const { runNativeBenchmark, NATIVE_BENCHMARK_MAX_TOKENS } = await import("../../src/services/native-benchmark.service.js");
const { getEnabledProviderConfigsForTask, isAvailabilityFailure, isBusyFailure, MODEL_CALL_TIMEOUT_MS, translateProviderError } = await import(
  "../../src/services/ai.service.js"
);
const { AppError } = await import("../../src/middleware/error.js");
const OpenAI = (await import("openai")).default;
const { suggestNativeMaxOutputTokens, nativeMaxSuggestedOutputTokens, nativeMinSuggestedOutputTokens } = await import("@timesheet/shared");

/* ── a child process that never existed ─────────────────────────────────────────────────────── */

class FakeChild extends EventEmitter {
  pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: string[] = [];
  /** Whether SIGTERM actually persuades it to leave — the whole point of having a SIGKILL behind it
   *  is that some processes do not. */
  respondsToSigterm = true;

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    if (signal === "SIGKILL" || this.respondsToSigterm) this.die(0, signal);
    return true;
  }

  die(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

interface IoOptions {
  spawn?: (binary: string, args: string[]) => ChildProcess;
  healthy?: () => boolean;
  files?: Set<string>;
}

let spawned: Array<{ binary: string; args: string[] }> = [];

/** Built with `path.join` rather than written as a literal: `resolveServerBinary` joins a PATH entry
 *  to the binary name, and on Windows that yields backslashes — a hard-coded POSIX string would make
 *  this whole suite look like a machine with no llama.cpp on it. */
const PATH_DIRS = ["/usr/local/bin", "/usr/bin"];
const FAKE_BINARY = path.join(PATH_DIRS[0], "llama-server");

function makeIo(options: IoOptions = {}): NativeRuntimeIo {
  const files = options.files ?? new Set<string>([FAKE_BINARY]);
  return {
    spawnServer: (binary, args) => {
      spawned.push({ binary, args });
      return (options.spawn ?? (() => new FakeChild() as unknown as ChildProcess))(binary, args);
    },
    fileExists: (target) => files.has(target),
    pathEntries: () => PATH_DIRS,
    pathExtensions: () => [""],
    platform: () => "linux",
    probeHealth: async () => (options.healthy ?? (() => true))(),
    now: () => Date.now(),
    // Instant, so a readiness poll or a stop grace does not cost the suite real seconds.
    sleep: async () => undefined
  };
}

const LAUNCH = {
  modelId: "qwen2.5-3b-instruct-q4_k_m",
  modelPath: "/models/qwen2.5-3b-instruct-q4_k_m.gguf",
  contextTokens: 8192,
  threads: 3,
  kvCacheType: "f16" as const,
  parallelSlots: 2
};

beforeEach(() => {
  resetNativeRuntimeState();
  spawned = [];
  modeSetting.value = "auto";
  binaryOverride.value = "";
  environmentKind.value = "bare-metal";
  readyModel.value = null;
});

afterEach(async () => {
  await stopNativeRuntime(makeIo());
  resetNativeRuntimeState();
  vi.useRealTimers();
});

/* ── who runs it ────────────────────────────────────────────────────────────────────────────── */

describe("deciding who runs llama-server", () => {
  it("spawns it itself on bare metal", async () => {
    environmentKind.value = "bare-metal";
    const { mode, reason } = await resolveNativeRuntimeMode();
    expect(mode).toBe("embedded");
    // The reason is not decoration: a mode nobody chose and cannot explain is one an operator argues
    // with instead of acting on.
    expect(reason).toContain("bare-metal");
  });

  it("assumes a sidecar under Docker and under Kubernetes", async () => {
    for (const kind of ["docker", "kubernetes"]) {
      resetNativeRuntimeState();
      environmentKind.value = kind;
      const { mode, reason } = await resolveNativeRuntimeMode();
      expect(mode).toBe("external");
      expect(reason).toContain(kind);
      // The musl-vs-glibc argument is the whole reason, and it belongs in the sentence the operator
      // reads rather than only in a source comment.
      expect(reason).toMatch(/musl|glibc/);
    }
  });

  it("lets an explicit setting override the detection in both directions", async () => {
    environmentKind.value = "kubernetes";
    modeSetting.value = "embedded";
    await expect(resolveNativeRuntimeMode()).resolves.toMatchObject({ mode: "embedded" });

    resetNativeRuntimeState();
    environmentKind.value = "bare-metal";
    modeSetting.value = "off";
    await expect(resolveNativeRuntimeMode()).resolves.toMatchObject({ mode: "off" });
  });

  it("answers 'off' with a status and no side effects at all", async () => {
    modeSetting.value = "off";
    const status = await getNativeRuntimeStatus();
    expect(status.mode).toBe("off");
    expect(status.state).toBe("off");
    expect(status.baseUrl).toBeNull();
    expect(status.detail.length).toBeGreaterThan(0);
    expect(spawned).toEqual([]);
  });

  it("never starts a child in external mode — the sidecar is somebody else's to run", async () => {
    environmentKind.value = "docker";
    const status = await startNativeRuntime(LAUNCH, makeIo());
    expect(status.mode).toBe("external");
    expect(spawned).toEqual([]);
  });
});

/* ── the missing binary ─────────────────────────────────────────────────────────────────────── */

describe("a host with no llama-server on it", () => {
  it("degrades to unavailable and does NOT throw", async () => {
    const status = await startNativeRuntime(LAUNCH, makeIo({ files: new Set() }));
    expect(status.state).toBe("unavailable");
    expect(status.binaryPath).toBeNull();
    // The message has to say what to do, and it has to say that nothing will be downloaded to fix it.
    expect(status.binaryProblem).toContain("llama-server");
    expect(status.binaryProblem).toMatch(/NATIVE_AI_SERVER_BIN/);
    expect(status.binaryProblem).toMatch(/Nothing is downloaded/);
    expect(spawned).toEqual([]);
  });

  it("names a configured path that does not exist, rather than silently searching PATH instead", async () => {
    binaryOverride.value = "/opt/nope/llama-server";
    const resolved = resolveServerBinary(makeIo());
    expect(resolved.path).toBeNull();
    expect(resolved.problem).toContain("/opt/nope/llama-server");
  });

  it("lets the BOOT HOOK resolve on a machine with nothing installed — the property this file exists for", async () => {
    readyModel.value = { modelId: LAUNCH.modelId, filePath: LAUNCH.modelPath, fileSizeBytes: 2_000_000_000 };
    const client = createFakeTenantClient();
    (client.aIProviderConfig.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      provider: "LLAMA_CPP",
      enabled: true,
      model: LAUNCH.modelId,
      maxConcurrent: 3
    });

    // No binary anywhere. An AI accelerator must never be the reason a timesheet system will not boot.
    await expect(
      runInTenant(client, async () => {
        await startNativeRuntimeIfConfigured(async (_label, fn) => fn(), makeIo({ files: new Set() }));
      })
    ).resolves.toBeUndefined();

    expect((await getNativeRuntimeStatus()).state).toBe("unavailable");
  });

  it("starts nothing at all when no workspace has asked for a native provider", async () => {
    const client = createFakeTenantClient();
    (client.aIProviderConfig.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await runInTenant(client, async () => {
      await startNativeRuntimeIfConfigured(async (_label, fn) => fn(), makeIo());
    });

    // A deployment that never enables this pays one query per org and nothing else — no PATH search,
    // no health probe, no child.
    expect(spawned).toEqual([]);
    expect((await getNativeRuntimeStatus()).state).toBe("stopped");
  });
});

/* ── the flags ──────────────────────────────────────────────────────────────────────────────── */

describe("the flags llama-server is given", () => {
  it("binds loopback, and passes the context, slots, cache type and thread count", () => {
    const args = buildServerArgs({ ...LAUNCH, kvCacheType: "q8_0", parallelSlots: 4 });
    // NOT a default — an unauthenticated inference endpoint on every interface is what the
    // alternative actually means.
    expect(args).toContain("--host");
    expect(args[args.indexOf("--host") + 1]).toBe("127.0.0.1");
    expect(args[args.indexOf("--model") + 1]).toBe(LAUNCH.modelPath);
    expect(args[args.indexOf("--ctx-size") + 1]).toBe("8192");
    expect(args[args.indexOf("--parallel") + 1]).toBe("4");
    expect(args[args.indexOf("--threads") + 1]).toBe("3");
    expect(args[args.indexOf("--cache-type-k") + 1]).toBe("q8_0");
    expect(args[args.indexOf("--cache-type-v") + 1]).toBe("q8_0");
  });

  it("omits --threads when the machine would not say how many cores it has", () => {
    // llama.cpp's own default is a better answer than a number this app invented.
    expect(buildServerArgs({ ...LAUNCH, threads: null })).not.toContain("--threads");
  });

  it("plans a launch from the fit estimator rather than from a second opinion", async () => {
    readyModel.value = { modelId: LAUNCH.modelId, filePath: LAUNCH.modelPath, fileSizeBytes: 2_000_000_000 };
    const client = createFakeTenantClient();
    (client.aIProviderConfig.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ maxConcurrent: 5 });

    const launch = await runInTenant(client, () => planLaunch(LAUNCH.modelId));

    expect(launch.modelPath).toBe(LAUNCH.modelPath);
    expect(launch.contextTokens).toBeGreaterThan(0);
    expect(launch.threads).toBe(3); // 4 physical cores minus the one reserved for the app
    // The server's slot count and the dispatcher's in-flight ceiling describe the same capacity and
    // must not be able to disagree.
    expect(launch.parallelSlots).toBe(5);
  });

  it("refuses to start a model this host has never downloaded", async () => {
    readyModel.value = null;
    await expect(runInTenant(createFakeTenantClient(), () => planLaunch(LAUNCH.modelId))).rejects.toMatchObject({ statusCode: 409 });
  });
});

/* ── readiness ──────────────────────────────────────────────────────────────────────────────── */

describe("readiness, which is not liveness", () => {
  it("only reports ready once /health answers", async () => {
    // The child is alive and bound from the instant it is spawned, and `/health` refuses for the
    // first three polls — which is what a model loading several gigabytes of weights looks like. A
    // supervisor that called a successful connect "ready" would have handed the first real request
    // to a server that could not serve it.
    const child = new FakeChild();
    let polls = 0;
    const io = makeIo({ spawn: () => child as unknown as ChildProcess, healthy: () => ++polls >= 4 });

    const status = await startNativeRuntime(LAUNCH, io);

    expect(polls).toBe(4);
    expect(status.state).toBe("ready");
    expect(status.readyAt).not.toBeNull();
    expect(status.pid).toBe(4242);
  });

  it("gives up with a message when the server binds but never finishes loading", async () => {
    const child = new FakeChild();
    // `now` runs past the readiness deadline so the loop terminates without the suite waiting three
    // real minutes for it.
    let clock = 0;
    const io: NativeRuntimeIo = {
      ...makeIo({ spawn: () => child as unknown as ChildProcess, healthy: () => false }),
      now: () => (clock += 60_000)
    };

    const status = await startNativeRuntime(LAUNCH, io);
    expect(status.state).toBe("failed");
    expect(status.detail).toMatch(/did not become ready/);
    // And it does not leave the thing it gave up on running.
    expect(child.signals.length).toBeGreaterThan(0);
  });
});

/* ── the startup window costs nothing, and that is already true ─────────────────────────────── */

describe("the window while a model is still loading", () => {
  it("already costs a fallback and NOT a circuit-breaker strike — verified, not reimplemented", () => {
    // While llama-server is mapping several gigabytes of weights it refuses connections outright, so
    // a call dispatched into that window fails with a connection error rather than an HTTP status.
    // The supervisor deliberately does NOT special-case that: the existing dispatcher already
    // classifies it correctly, and duplicating the rule is how the two copies come to disagree.
    // What the supervisor relies on is asserted here instead.
    const refused = new OpenAI.APIConnectionError({ message: "connect ECONNREFUSED 127.0.0.1:8080" });
    const translated = translateProviderError(refused);

    expect(translated).toBeInstanceOf(AppError);
    // 503, which means BUSY: worth trying the next provider...
    expect((translated as InstanceType<typeof AppError>).statusCode).toBe(503);
    expect(isAvailabilityFailure(translated)).toBe(true);
    // ...and NOT the native row's fault, so nothing is counted against its reliability. A model that
    // takes forty seconds to load must not be auto-demoted for having been slow to start once.
    expect(isBusyFailure(translated)).toBe(true);
  });
});

/* ── the backoff ────────────────────────────────────────────────────────────────────────────── */

describe("restarting a runtime that keeps dying", () => {
  it("has a delay curve that grows and is capped", () => {
    expect(nativeRestartDelayMs(0)).toBe(1_000);
    expect(nativeRestartDelayMs(1)).toBe(2_000);
    expect(nativeRestartDelayMs(2)).toBe(4_000);
    // Capped: beyond half a minute the operator presses the button themselves anyway, and an
    // unbounded curve is how a supervisor stops being one.
    expect(nativeRestartDelayMs(20)).toBe(NATIVE_MAX_RESTART_DELAY_MS);
    expect(nativeRestartDelayMs(99)).toBe(NATIVE_MAX_RESTART_DELAY_MS);
  });

  it("stops after the attempt budget and lands in a terminal state, rather than looping forever", async () => {
    vi.useFakeTimers();
    const children: FakeChild[] = [];
    const io = makeIo({
      healthy: () => false,
      spawn: () => {
        const child = new FakeChild();
        children.push(child);
        // Crashes right after spawn, every time — a corrupt model file, or a port already taken.
        queueMicrotask(() => child.die(1));
        return child as unknown as ChildProcess;
      }
    });

    await startNativeRuntime(LAUNCH, io);
    expect((await getNativeRuntimeStatus()).state).toBe("restarting");

    // Let every scheduled restart fire. Bounded, so a supervisor that never terminates fails this
    // test by exhausting the loop rather than by hanging the suite.
    for (let tick = 0; tick < NATIVE_MAX_RESTART_ATTEMPTS + 3; tick += 1) {
      await vi.advanceTimersByTimeAsync(NATIVE_MAX_RESTART_DELAY_MS + 1_000);
      if ((await getNativeRuntimeStatus()).state === "failed") break;
    }

    const status = await getNativeRuntimeStatus();
    expect(status.state).toBe("failed");
    expect(status.restarts.attempts).toBeGreaterThan(NATIVE_MAX_RESTART_ATTEMPTS);
    expect(status.restarts.nextRetryAt).toBeNull();
    expect(status.detail).toMatch(/will not be restarted again/);
    // It really did stop: no further spawn happens however long we wait.
    const spawnsAtGiveUp = spawned.length;
    await vi.advanceTimersByTimeAsync(10 * NATIVE_MAX_RESTART_DELAY_MS);
    expect(spawned.length).toBe(spawnsAtGiveUp);
    expect(spawnsAtGiveUp).toBeLessThanOrEqual(NATIVE_MAX_RESTART_ATTEMPTS + 1);
  });

  it("clears the counter once a start actually succeeds, so a healthy restart is not held against it", async () => {
    const io = makeIo();
    await startNativeRuntime(LAUNCH, io);
    const first = await getNativeRuntimeStatus();
    expect(first.state).toBe("ready");
    expect(first.restarts.attempts).toBe(0);

    const restarted = await restartNativeRuntime(io);
    expect(restarted.state).toBe("ready");
    expect(restarted.restarts.attempts).toBe(0);
  });
});

/* ── shutdown ───────────────────────────────────────────────────────────────────────────────── */

describe("shutting down", () => {
  it("kills the child and reports itself stopped", async () => {
    const child = new FakeChild();
    await startNativeRuntime(LAUNCH, makeIo({ spawn: () => child as unknown as ChildProcess }));
    expect((await getNativeRuntimeStatus()).state).toBe("ready");

    const status = await stopNativeRuntime(makeIo());

    expect(child.signals).toContain("SIGTERM");
    expect(status.state).toBe("stopped");
    expect(status.pid).toBeNull();
  });

  it("escalates to SIGKILL when SIGTERM is ignored", async () => {
    const child = new FakeChild();
    child.respondsToSigterm = false;
    await startNativeRuntime(LAUNCH, makeIo({ spawn: () => child as unknown as ChildProcess }));

    await stopNativeRuntime(makeIo());

    // A model that will not put itself down must not outlive this process: the next start would fail
    // with EADDRINUSE on a machine that is already running it.
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("does not restart a child it stopped on purpose", async () => {
    const child = new FakeChild();
    await startNativeRuntime(LAUNCH, makeIo({ spawn: () => child as unknown as ChildProcess }));
    const spawnsBefore = spawned.length;

    await stopNativeRuntime(makeIo());
    const status = await getNativeRuntimeStatus();

    expect(status.state).toBe("stopped");
    expect(status.restarts.nextRetryAt).toBeNull();
    expect(spawned.length).toBe(spawnsBefore);
  });

  it("is wired into the process's own shutdown path and has a synchronous last resort behind it", () => {
    // Read rather than executed: importing server.ts boots the whole application, binds a port and
    // starts twenty cron workers. What is being pinned is the WIRING, and the wiring is one line —
    // the shape of failure here is somebody removing it while every other test still passes.
    const serverSource = fs.readFileSync(path.resolve(fileURLToPath(new URL("../../src/server.ts", import.meta.url))), "utf8");
    expect(serverSource).toMatch(/await stopNativeRuntime\(\)/);

    const runtimeSource = fs.readFileSync(
      path.resolve(fileURLToPath(new URL("../../src/services/native-runtime.service.ts", import.meta.url))),
      "utf8"
    );
    // The graceful path is not the only path: the shutdown budget can expire into `process.exit(1)`,
    // and `uncaughtException` routes into the same shutdown from a process that may be damaged.
    expect(runtimeSource).toMatch(/process\.on\("exit"/);
    expect(runtimeSource).toMatch(/SIGKILL/);
  });
});

/* ── the benchmark, and the number it is for ────────────────────────────────────────────────── */

/** A fixed sequence of clock readings, so a timing assertion is arithmetic rather than a race. The
 *  benchmark reads the clock exactly three times: at the request, at the first content frame, and
 *  once the stream ends. */
function clockReading(values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

/** An OpenAI-style streaming response, one content token per frame. */
function sseResponse(tokens: number): Response {
  const frames = Array.from({ length: tokens }, (_, index) => `data: ${JSON.stringify({ choices: [{ delta: { content: `t${index} ` } }] })}\n\n`);
  frames.unshift(`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })}\n\n`);
  frames.push("data: [DONE]\n\n");
  return new Response(new TextEncoder().encode(frames.join("")), { status: 200 });
}

describe("what a measurement lets a provider row declare", () => {
  it("keeps a real margin under the call ceiling rather than promising the whole of it", () => {
    // 90-second ceiling, one second to the first token, ten tokens a second.
    const suggestion = suggestNativeMaxOutputTokens({ tokensPerSecond: 10, timeToFirstTokenMs: 1_000, ceilingMs: 90_000 });

    // THE NUMBER, PINNED. 90s x 0.6 share = 54s, minus the 1s first token (which buys no output
    // tokens at all — it is prompt processing), at 10 tokens/sec = 530.
    expect(suggestion).toBe(530);
    // And the margin is real rather than nominal: promising the whole ceiling would allow 890, and
    // the difference is what absorbs a longer real prompt, a colder cache, and another tenant's call
    // landing on the same single-threaded CPU. A declaration that is too small routes a few heavy
    // calls to the cloud provider behind it, which is what they should do anyway; one that is too
    // large makes every one of them spend the full ninety seconds finding out.
    expect(suggestion).toBeLessThan(890 * 0.75);
  });

  it("never puts a NaN or an unbounded number into a routing decision", () => {
    // A benchmark that divided by a zero duration yields NaN, and NaN is false for every
    // comparison — so a bare "<= 0" guard would wave it through into AIProviderConfig.maxOutputTokens.
    expect(suggestNativeMaxOutputTokens({ tokensPerSecond: Number.NaN, timeToFirstTokenMs: 10, ceilingMs: 90_000 })).toBe(
      nativeMinSuggestedOutputTokens
    );
    expect(suggestNativeMaxOutputTokens({ tokensPerSecond: 0.0001, timeToFirstTokenMs: 10, ceilingMs: 90_000 })).toBe(nativeMinSuggestedOutputTokens);
    // A first token that eats the entire budget buys no output at all.
    expect(suggestNativeMaxOutputTokens({ tokensPerSecond: 10, timeToFirstTokenMs: 90_000, ceilingMs: 90_000 })).toBe(nativeMinSuggestedOutputTokens);
    // And a very fast machine is still bounded by what this app's own generators ever ask for.
    expect(suggestNativeMaxOutputTokens({ tokensPerSecond: 5_000, timeToFirstTokenMs: 10, ceilingMs: 90_000 })).toBe(nativeMaxSuggestedOutputTokens);
  });
});

describe("the benchmark", () => {
  beforeEach(async () => {
    readyModel.value = { modelId: LAUNCH.modelId, filePath: LAUNCH.modelPath, fileSizeBytes: 2_000_000_000 };
    await startNativeRuntime(LAUNCH, makeIo());
  });

  it("refuses to measure a runtime that is not ready, rather than measuring a cold start", async () => {
    await stopNativeRuntime(makeIo());
    await expect(runNativeBenchmark(LAUNCH.modelId)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("separates time-to-first-token from the generation rate, because they mean different things", async () => {
    // The clock is read exactly three times — at the request, at the first content frame, and at the
    // end — so the fixture is a sequence rather than an increment. 500 ms of prompt processing, then
    // one second in which the remaining ten tokens arrive.
    const io = { fetch: async () => sseResponse(11), now: clockReading([0, 500, 1_500]) };

    const { benchmark } = await runNativeBenchmark(LAUNCH.modelId, io);

    expect(benchmark.timeToFirstTokenMs).toBe(500);
    expect(benchmark.outputTokens).toBe(11);
    // Ten tokens after the first, over one second: 10 tokens/sec. The first token is EXCLUDED from
    // the rate because it was produced by prompt processing, not by generation — counting it would
    // let a long first-token wait quietly depress a figure it is not part of.
    expect(benchmark.tokensPerSecond).toBeCloseTo(10, 1);
  });

  it("asks for a small, fixed, deterministic completion", async () => {
    let body: Record<string, unknown> = {};
    const io = {
      fetch: async (_url: string, init: { body: string }) => {
        body = JSON.parse(init.body);
        return sseResponse(8);
      },
      now: clockReading([0, 100, 200])
    };

    await runNativeBenchmark(LAUNCH.modelId, io);

    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(NATIVE_BENCHMARK_MAX_TOKENS);
    // A benchmark whose sampler varies measures the sampler.
    expect(body.temperature).toBe(0);
  });

  it("turns the measurement into a maxOutputTokens the ROUTING FILTER then honours", async () => {
    // One second to the first token, then ten more tokens in the second after it: 10 tokens/sec.
    const io = { fetch: async () => sseResponse(11), now: clockReading([0, 1_000, 2_000]) };

    const { benchmark } = await runNativeBenchmark(LAUNCH.modelId, io);

    expect(benchmark.tokensPerSecond).toBeCloseTo(10, 1);
    // 90s ceiling x 0.6 share, minus the 1s first token, at 10 tokens/sec = 530 tokens.
    const expected = suggestNativeMaxOutputTokens({
      tokensPerSecond: benchmark.tokensPerSecond,
      timeToFirstTokenMs: benchmark.timeToFirstTokenMs,
      ceilingMs: MODEL_CALL_TIMEOUT_MS
    });
    expect(benchmark.suggestedMaxOutputTokens).toBe(expected);
    expect(expected).toBeGreaterThan(0);
    expect(expected).toBeLessThan(nativeMaxSuggestedOutputTokens);

    // AND THE POINT OF THE WHOLE BLOCK: that number, written to the provider row, is what the REAL
    // demand filter consumes. A call asking for more is not attempted; a call within reach is.
    const client = createFakeTenantClient();
    const nativeRow = {
      id: "native-1",
      provider: "LLAMA_CPP",
      label: null,
      baseUrl: "http://127.0.0.1:8080/v1",
      apiKey: null,
      model: LAUNCH.modelId,
      enabled: true,
      priority: 0,
      maxConcurrent: 2,
      maxOutputTokens: benchmark.suggestedMaxOutputTokens,
      contextWindow: 8192
    };
    const cloudRow = { ...nativeRow, id: "cloud-1", provider: "ANTHROPIC", baseUrl: null, priority: 1, maxOutputTokens: null, contextWindow: null };
    (client.aIProviderConfig.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([nativeRow, cloudRow]);

    const within = await runInTenant(client, () =>
      getEnabledProviderConfigsForTask("judgment", { maxTokens: benchmark.suggestedMaxOutputTokens - 1, promptTokens: 100 })
    );
    expect(within.map((row) => row.id)).toEqual(["native-1", "cloud-1"]);

    const beyond = await runInTenant(client, () =>
      getEnabledProviderConfigsForTask("judgment", { maxTokens: benchmark.suggestedMaxOutputTokens + 1_000, promptTokens: 100 })
    );
    // Skipped, not failed — so its circuit-breaker counter never moves for a call it was never given.
    expect(beyond.map((row) => row.id)).toEqual(["cloud-1"]);
  });
});
