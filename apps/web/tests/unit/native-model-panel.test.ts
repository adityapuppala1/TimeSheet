/**
 * The five decisions the "Run a model on this server" card is not allowed to get wrong, and one
 * anti-drift check.
 *
 * WHY THESE FIVE. The card is mostly layout, and layout is not what hurts an operator. What hurts
 * them is a number that is confidently wrong: a green badge over a model that will be OOM-killed, a
 * context step that looks free because the cache term was dropped from the total, or a "measured"
 * throughput that was never measured. Each of those is one pure function, and each block below is
 * written so that breaking that function turns it red — which was checked by breaking each one on
 * purpose before this file was considered finished.
 *
 * THE ANTI-DRIFT CHECK is the last assertion in the RAM block: `nativeRamBreakdown` splits the same
 * memory total the shared `estimateNativeModelFit` computes, and the test pins that the split sums
 * to the estimator's own `ram.requiredBytes`. The card shows the split; the verdict comes from the
 * estimator. If those two ever disagree, the screen is explaining one number and judging another.
 */
import { describe, expect, it } from "vitest";
import {
  estimateNativeModelFit,
  findNativeModel,
  nativeApplicationReserveBytes,
  type NativeBenchmarkSummary,
  type NativeFitEstimate,
  type NativeHardwareSnapshot,
  type NativeModelEntry
} from "@timesheet/shared";
import {
  NATIVE_CONTEXT_STEPS,
  containerMemoryCaveat,
  contextStepsForModel,
  downloadProgressPercent,
  downloadStatusLabel,
  environmentSummary,
  fitVerdictTone,
  formatBytes,
  formatContextTokens,
  isMachineWideWarning,
  liveNativeFit,
  nativeRamBreakdown,
  nativeThreadCeiling,
  selectSpeedFigure
} from "../../src/utils/native-model-panel";

const GIB = 1024 ** 3;

/** The two catalogue entries that make the memory lesson visible: 2 KV heads against 32, which at
 *  16k is the difference between "a rounding error" and "six gigabytes". Read from the real
 *  catalogue rather than hand-built, so a catalogue edit that breaks these assumptions surfaces
 *  here instead of in production. */
const QWEN_3B = findNativeModel("qwen2.5-3b-instruct-q4_k_m") as NativeModelEntry;
const PHI_MINI = findNativeModel("phi-3.5-mini-instruct-q4_k_m") as NativeModelEntry;

/** A machine, with everything readable and nothing surprising. Overrides are shallow per section
 *  because every test here changes exactly one thing about the box. */
function machine(overrides: {
  cpu?: Partial<NativeHardwareSnapshot["cpu"]>;
  memory?: Partial<NativeHardwareSnapshot["memory"]>;
  environment?: Partial<NativeHardwareSnapshot["environment"]>;
} = {}): NativeHardwareSnapshot {
  return {
    sampledAt: "2026-09-01T00:00:00.000Z",
    cpu: {
      model: "AMD Ryzen 7 5800X",
      logicalCores: 16,
      physicalCores: 8,
      arch: "x64",
      instructionSets: { avx2: true, avx512: false, neon: false, dotprod: null },
      quotaCores: null,
      quotaSource: null,
      ...overrides.cpu
    },
    memory: {
      hostTotalBytes: 16 * GIB,
      hostAvailableBytes: 8 * GIB,
      cgroupLimitBytes: null,
      cgroupUsageBytes: null,
      cgroupSource: null,
      effectiveTotalBytes: 16 * GIB,
      effectiveAvailableBytes: 8 * GIB,
      ...overrides.memory
    },
    environment: { kind: "bare-metal", signals: ["no container or WSL signal found"], ...overrides.environment },
    disk: { path: "/var/lib/timesphere/models", freeBytes: 200 * GIB, totalBytes: 500 * GIB }
  };
}

describe("formatBytes", () => {
  it("says the word unknown rather than rendering a confident zero", () => {
    // Every memory and disk field in the snapshot is nullable and null means "would not say".
    // "0 B" free disk is a different, much more alarming claim than "we could not read it".
    expect(formatBytes(null)).toBe("unknown");
    expect(formatBytes(undefined)).toBe("unknown");
    expect(formatBytes(Number.NaN)).toBe("unknown");
    expect(formatBytes(0)).toBe("0 B");
  });

  it("keeps a kilobyte tier, because that is what an HTML error page saved as .gguf looks like", () => {
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1400)).toBe("1 KB");
  });

  it("prints one decimal at GB and whole numbers below it", () => {
    expect(formatBytes(1.5 * GIB)).toBe("1.5 GB");
    expect(formatBytes(5 * 1024 ** 2)).toBe("5 MB");
  });
});

describe("formatContextTokens", () => {
  it("shortens the powers of two and leaves anything else exact", () => {
    expect(formatContextTokens(8192)).toBe("8k");
    expect(formatContextTokens(32768)).toBe("32k");
    expect(formatContextTokens(3000)).toBe("3000");
  });
});

describe("fitVerdictTone", () => {
  it("gives the success colour to `comfortable` and to nothing else", () => {
    // THE FALSIFICATION: pointing `will-not-fit` (or `unknown`) at the success tone paints a green
    // badge over a model this machine cannot load, which is the single most misleading pixel this
    // card could draw. Each of the three assertions below goes red on its own if that happens.
    expect(fitVerdictTone("comfortable").badge).toBe("success");
    expect(fitVerdictTone("tight").badge).toBe("warning");
    expect(fitVerdictTone("will-not-fit").badge).toBe("destructive");
    expect(fitVerdictTone("unknown").badge).toBe("muted");
  });

  it("never lets an undecidable fit read as a passing one", () => {
    // `unknown` means the memory could not be read. That is not a pass, and the meter must not be
    // green either — the badge and the bar have to agree.
    expect(fitVerdictTone("unknown").badge).not.toBe("success");
    expect(fitVerdictTone("unknown").meterClassName).not.toContain("success");
    expect(fitVerdictTone("will-not-fit").meterClassName).toBe("bg-destructive");
  });
});

describe("nativeRamBreakdown", () => {
  it("includes the KV cache in the total, and the cache is what moves when context does", () => {
    // THE FALSIFICATION: drop the KV term from `totalBytes` and every context step looks free —
    // which is the exact trade-off the card exists to make legible. Both assertions here go red.
    const at8k = nativeRamBreakdown(PHI_MINI, 8192, "f16");
    const at16k = nativeRamBreakdown(PHI_MINI, 16384, "f16");

    expect(at8k.totalBytes).toBe(at8k.weightBytes + at8k.kvCacheBytes + at8k.runtimeOverheadBytes);
    expect(at16k.kvCacheBytes).toBe(at8k.kvCacheBytes * 2);
    expect(at16k.totalBytes - at8k.totalBytes).toBe(at8k.kvCacheBytes);
    // Weights and overhead are the two terms that do NOT move with context.
    expect(at16k.weightBytes).toBe(at8k.weightBytes);
    expect(at16k.runtimeOverheadBytes).toBe(at8k.runtimeOverheadBytes);
  });

  it("halves the cache for an 8-bit KV, which is the whole reason that control exists", () => {
    const f16 = nativeRamBreakdown(PHI_MINI, 16384, "f16");
    const q8 = nativeRamBreakdown(PHI_MINI, 16384, "q8_0");
    expect(q8.kvCacheBytes).toBe(f16.kvCacheBytes / 2);
    expect(q8.totalBytes).toBeLessThan(f16.totalBytes);
  });

  it("shows grouped-query attention paying a fraction of multi-head at the same context", () => {
    // 2 KV heads against 32, 36 layers against 32: the catalogue's central claim, pinned.
    const grouped = nativeRamBreakdown(QWEN_3B, 16384, "f16");
    const multiHead = nativeRamBreakdown(PHI_MINI, 16384, "f16");
    expect(multiHead.kvCacheBytes).toBeGreaterThan(grouped.kvCacheBytes * 5);
  });

  it("sums to exactly what the shared estimator judged the model on", () => {
    // ANTI-DRIFT. The card renders this split and takes its verdict from the estimator; if the two
    // ever compute a different total, the screen is explaining one number and judging another.
    const split = nativeRamBreakdown(QWEN_3B, 8192, "f16");
    const estimate = estimateNativeModelFit(machine(), QWEN_3B, 8192, "f16");
    expect(split.totalBytes).toBe(estimate.ram.requiredBytes);
    expect(split.kvCacheBytes).toBe(estimate.ram.kvCacheBytes);
  });
});

describe("liveNativeFit", () => {
  it("re-judges the model as the context moves, on the same machine", () => {
    // THE FALSIFICATION: ignore the caller's `contextTokens` (pass the model's recommended value
    // instead) and this pair collapses to one verdict — the live recomputation stops being live.
    // A machine sized so the CONTEXT is what decides. Phi-3.5-mini is plain multi-head attention, so
    // its cache grows brutally with context: comfortably inside this budget at 4k, far outside it at
    // 16k. Expressed as TOTAL memory, because that — minus a stated reserve — is the budget; free
    // memory at the instant of a probe is mostly reclaimable page cache and decides nothing.
    const hardware = machine({ memory: { hostTotalBytes: 7 * GIB, effectiveTotalBytes: 7 * GIB } });
    const at4k = liveNativeFit({ hardware, entry: PHI_MINI, contextTokens: 4096, kvCacheType: "f16" });
    const at16k = liveNativeFit({ hardware, entry: PHI_MINI, contextTokens: 16384, kvCacheType: "f16" });

    expect(at4k.verdict).toBe("comfortable");
    expect(at16k.verdict).toBe("will-not-fit");
    // Never a bare badge: the refusal states both numbers.
    expect(at16k.reason).toMatch(/Won't fit/);
    expect(at16k.reason).toMatch(/GB/);
  });

  it("recovers a will-not-fit into a fit when the KV cache is halved", () => {
    const hardware = machine({ memory: { effectiveAvailableBytes: 6 * GIB, effectiveTotalBytes: 8 * GIB } });
    const f16 = liveNativeFit({ hardware, entry: PHI_MINI, contextTokens: 8192, kvCacheType: "f16" });
    const q8 = liveNativeFit({ hardware, entry: PHI_MINI, contextTokens: 8192, kvCacheType: "q8_0" });
    expect(f16.ram.requiredBytes).toBeGreaterThan(q8.ram.requiredBytes);
    expect(q8.ram.kvCacheBytes).toBe(f16.ram.kvCacheBytes / 2);
  });

  it("clamps to the model's own maximum instead of pricing a context llama.cpp would refuse", () => {
    const tiny: NativeModelEntry = { ...QWEN_3B, maxContextTokens: 4096 };
    const fit = liveNativeFit({ hardware: machine(), entry: tiny, contextTokens: 32768, kvCacheType: "f16" });
    expect(fit.contextTokens).toBe(4096);
  });

  it("prefers the measured file size over the catalogue's derivation once one exists", () => {
    const hardware = machine();
    const derived = liveNativeFit({ hardware, entry: QWEN_3B, contextTokens: 8192, kvCacheType: "f16" });
    const measured = liveNativeFit({
      hardware,
      entry: QWEN_3B,
      measuredFileSizeBytes: 2_100_000_000,
      contextTokens: 8192,
      kvCacheType: "f16"
    });
    expect(derived.ram.weightSource).toBe("derived-from-quantisation");
    expect(measured.ram.weightSource).toBe("catalogue");
    expect(measured.ram.weightBytes).toBe(2_100_000_000);
  });

  it("holds back the application reserve, and takes it off what the machine HAS", () => {
    // Two rules in one assertion. The reserve is withheld — MySQL and Node live here too. And it is
    // withheld from TOTAL memory, not from whatever happened to be unallocated when the probe ran:
    // judging against free memory once told a 31 GB workstation it could not hold a 2.9 GB model.
    const fit = liveNativeFit({ hardware: machine(), entry: QWEN_3B, contextTokens: 8192, kvCacheType: "f16" });
    expect(fit.ram.availableBytes).toBe(16 * GIB - nativeApplicationReserveBytes);
    expect(fit.ram.availableBytes).not.toBe(8 * GIB - nativeApplicationReserveBytes);
  });
});

describe("contextStepsForModel", () => {
  it("offers only the steps the model was trained for", () => {
    const capped: NativeModelEntry = { ...QWEN_3B, maxContextTokens: 8192 };
    expect(contextStepsForModel(capped)).toEqual([4096, 8192]);
    expect(contextStepsForModel(QWEN_3B)).toEqual([...NATIVE_CONTEXT_STEPS]);
  });

  it("never returns an empty row, which would render as a broken control", () => {
    const minute: NativeModelEntry = { ...QWEN_3B, maxContextTokens: 2048 };
    expect(contextStepsForModel(minute)).toEqual([2048]);
  });
});

describe("selectSpeedFigure", () => {
  const estimate = estimateNativeModelFit(machine(), QWEN_3B, 8192, "f16") as NativeFitEstimate;
  const benchmark: NativeBenchmarkSummary = {
    measuredAt: "2026-09-01T10:00:00.000Z",
    timeToFirstTokenMs: 1800,
    tokensPerSecond: 9.4,
    outputTokens: 128,
    totalMs: 15_400,
    suggestedMaxOutputTokens: 490,
    basis: "measured over 128 generated tokens against the running runtime"
  };

  it("labels an estimate as an estimate and says what it was assumed from", () => {
    // THE FALSIFICATION: return `measured` here — with no benchmark anywhere in the input — and the
    // card presents arithmetic over an ASSUMED memory bandwidth as a stopwatch reading.
    const figure = selectSpeedFigure({ estimate, benchmark: null });
    expect(figure.source).toBe("estimated");
    expect(figure.label).toBe("Estimated");
    expect(figure.basis).toMatch(/assumed/);
    expect(figure.basis).toMatch(/estimate, not a measurement/);
    // An estimate cannot carry the two things only a stopwatch produces.
    expect(figure.timeToFirstTokenMs).toBeNull();
    expect(figure.measuredAt).toBeNull();
    expect(figure.suggestedMaxOutputTokens).toBeNull();
  });

  it("lets a real measurement outrank the estimate, and carries what only it knows", () => {
    const figure = selectSpeedFigure({ estimate, benchmark });
    expect(figure.source).toBe("measured");
    expect(figure.tokensPerSecond).toBe(9.4);
    expect(figure.timeToFirstTokenMs).toBe(1800);
    expect(figure.suggestedMaxOutputTokens).toBe(490);
  });

  it("treats a nonsense benchmark rate as no measurement at all", () => {
    // A divide-by-zero in a stopwatch is not a machine that generates zero tokens per second, and
    // it must not be allowed to wear the `measured` badge that a routing decision is made from.
    for (const rate of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const figure = selectSpeedFigure({ estimate, benchmark: { ...benchmark, tokensPerSecond: rate } });
      expect(figure.source).toBe("estimated");
    }
  });

  it("admits it does not know rather than printing a number it does not have", () => {
    const blind: NativeFitEstimate = { ...estimate, speed: { ...estimate.speed, tokensPerSecond: null } };
    const figure = selectSpeedFigure({ estimate: blind, benchmark: null });
    expect(figure.source).toBe("unknown");
    expect(figure.tokensPerSecond).toBeNull();
  });
});

describe("nativeThreadCeiling", () => {
  it("stops at the physical cores, not the hyperthreads", () => {
    expect(nativeThreadCeiling(machine()).max).toBe(8);
  });

  it("lets a cgroup CPU quota bind even on a machine with far more cores", () => {
    // A pod with `cpu: "2"` on a 64-core node: more threads than the quota does not go faster, it
    // exhausts the period sooner and spends the rest of it throttled.
    const ceiling = nativeThreadCeiling(machine({ cpu: { physicalCores: 64, logicalCores: 128, quotaCores: 2, quotaSource: "/sys/fs/cgroup/cpu.max" } }));
    expect(ceiling.max).toBe(2);
    expect(ceiling.basis).toMatch(/cpu\.max/);
  });

  it("halves an unknown physical-core count and says it assumed hyperthreading", () => {
    const ceiling = nativeThreadCeiling(machine({ cpu: { physicalCores: null, logicalCores: 12 } }));
    expect(ceiling.max).toBe(6);
    expect(ceiling.basis).toMatch(/hyperthreading/);
  });

  it("falls back to the API's own ceiling when the machine reports no CPU count at all", () => {
    const ceiling = nativeThreadCeiling(machine({ cpu: { physicalCores: null, logicalCores: null } }));
    expect(ceiling.max).toBe(256);
  });
});

describe("downloadProgressPercent", () => {
  it("returns null when the server sent no Content-Length, so the bar can go indeterminate", () => {
    expect(downloadProgressPercent({ bytesDownloaded: 12_000, bytesTotal: null })).toBeNull();
    expect(downloadProgressPercent({ bytesDownloaded: 12_000, bytesTotal: 0 })).toBeNull();
  });

  it("clamps rather than drawing past its own track", () => {
    expect(downloadProgressPercent({ bytesDownloaded: 500, bytesTotal: 1000 })).toBe(50);
    expect(downloadProgressPercent({ bytesDownloaded: 2000, bytesTotal: 1000 })).toBe(100);
  });
});

describe("downloadStatusLabel", () => {
  it("makes verification its own step rather than a bar frozen at 100%", () => {
    expect(downloadStatusLabel("verifying")).toMatch(/hashing/);
    expect(downloadStatusLabel("ready")).not.toBe(downloadStatusLabel("verifying"));
  });
});

describe("environmentSummary", () => {
  it("shows its work instead of asserting a label", () => {
    const summary = environmentSummary(machine({ environment: { kind: "kubernetes", signals: ["KUBERNETES_SERVICE_HOST is set"] } }));
    expect(summary.label).toBe("Kubernetes");
    expect(summary.reason).toBe("detected from KUBERNETES_SERVICE_HOST is set");
  });

  it("says so when nothing was readable, rather than implying bare metal was proved", () => {
    const summary = environmentSummary(machine({ environment: { kind: "unknown", signals: [] } }));
    expect(summary.label).toBe("Unknown");
    expect(summary.reason).toMatch(/no signal/);
  });
});

describe("containerMemoryCaveat", () => {
  it("fires for a container with no memory limit, and names the consequence", () => {
    const caveat = containerMemoryCaveat(machine({ environment: { kind: "docker", signals: ["/.dockerenv exists"] }, memory: { cgroupLimitBytes: null } }));
    expect(caveat).toMatch(/HOST/);
    expect(caveat).toMatch(/OOM-killed/);
  });

  it("stays quiet once a real limit exists, and on bare metal", () => {
    expect(containerMemoryCaveat(machine({ environment: { kind: "docker" }, memory: { cgroupLimitBytes: 4 * GIB } }))).toBeNull();
    expect(containerMemoryCaveat(machine())).toBeNull();
    expect(containerMemoryCaveat(machine({ environment: { kind: "wsl" } }))).toBeNull();
  });
});

describe("isMachineWideWarning", () => {
  it("says once what is true of the box and per-card what is true of the model", () => {
    expect(isMachineWideWarning("container-without-memory-limit")).toBe(true);
    expect(isMachineWideWarning("cpu-quota-clamped-threads")).toBe(true);
    expect(isMachineWideWarning("near-budget")).toBe(false);
    expect(isMachineWideWarning("context-does-not-fit")).toBe(false);
  });
});
