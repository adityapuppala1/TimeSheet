/**
 * THE FIT ESTIMATOR, AND THE FOUR LIES IT EXISTS TO REFUSE.
 *
 * This is arithmetic with consequences: the output decides whether an operator downloads two
 * gigabytes onto a box that will OOM-kill it. Everything here drives the REAL exported function
 * against fixture snapshots rather than re-deriving the formulas, for the reason
 * ai-cost-routing.test.ts states: a test that recomputes the maths checks its own arithmetic and
 * passes just as happily against a service that never applies it.
 *
 * WHAT IS PINNED, and why each one is a silent failure rather than a loud one:
 *
 *  1. THE cgroup LIMIT BEATS HOST RAM. `os.totalmem()` reports the HOST, always. The failure mode
 *     is not an error — it is a green "comfortable" badge on a pod that gets killed on load. So a
 *     snapshot with 30 GB of host memory and a 4 GiB cgroup ceiling must come back "won't fit" for
 *     a 3 GiB model, and it must do so BECAUSE the estimator never reads the host figure.
 *  2. THE "NO LIMIT" SENTINEL IS ABSENCE, NOT A NUMBER. cgroup v1 spells unlimited as
 *     9223372036854771712. Parsed as a limit, that is an 8-exabyte allowance and every model
 *     "fits". (Pinned in native-hardware-probe.test.ts, where the parsing lives.)
 *  3. kv_heads IS IN THE KV FORMULA. Drop the term and every model looks identically cheap — the
 *     entire premise of the curated catalogue evaporates, and nothing crashes. Two synthetic models
 *     identical but for 2-vs-8 KV heads must differ by exactly 4x at 16k.
 *  4. THE APPLICATION RESERVE IS APPLIED. MySQL and Node live on this box too. Without the
 *     reserve, a model that exactly fills free RAM is called comfortable and then evicts the
 *     database's buffer pool — slowness nobody will connect to the model they just installed.
 *
 * And one shape rule: EVERY verdict carries a non-empty reason. A red badge is not actionable.
 */
import { describe, expect, it } from "vitest";
import {
  estimateNativeModelFit,
  findNativeModel,
  nativeApplicationReserveBytes,
  nativeContextLadder,
  nativeKvCacheBytes,
  nativeModelCatalogue,
  nativeModelWeightBytes,
  nativeQuantBitsPerWeight,
  nativeRuntimeOverheadBytes,
  type NativeHardwareSnapshot,
  type NativeModelEntry
} from "@timesheet/shared";

const GIB = 1024 ** 3;

/**
 * A model whose numbers are deliberately round so the assertions can be exact rather than
 * approximate: 2 GiB of weights (given as a measured `fileSizeBytes`, so no derivation is
 * involved) and, at 4096 tokens with an f16 cache, exactly 0.5 GiB of KV. With the 0.5 GiB runtime
 * overhead that is a required footprint of EXACTLY 3 GiB.
 */
const roundModel: NativeModelEntry = {
  id: "test-round-3gib",
  displayName: "Round Numbers 7B",
  parameterCountB: 7,
  quantisation: "Q4_K_M",
  repo: "test/round",
  file: "round.gguf",
  fileSizeBytes: 2 * GIB,
  layers: 32,
  kvHeads: 8,
  headDim: 128,
  maxContextTokens: 32768,
  recommendedContextTokens: 4096,
  goodAt: "being arithmetically convenient",
  weakAt: "existing"
};

function snapshot(overrides: {
  hostTotal?: number | null;
  hostAvailable?: number | null;
  cgroupLimit?: number | null;
  effectiveTotal?: number | null;
  effectiveAvailable?: number | null;
  physicalCores?: number | null;
  logicalCores?: number | null;
  quotaCores?: number | null;
  environment?: NativeHardwareSnapshot["environment"]["kind"];
  avx2?: boolean | null;
}): NativeHardwareSnapshot {
  const hostTotal = overrides.hostTotal === undefined ? 8 * GIB : overrides.hostTotal;
  const hostAvailable = overrides.hostAvailable === undefined ? 6 * GIB : overrides.hostAvailable;
  return {
    sampledAt: "2026-09-01T00:00:00.000Z",
    cpu: {
      model: "Test CPU",
      logicalCores: overrides.logicalCores === undefined ? 8 : overrides.logicalCores,
      physicalCores: overrides.physicalCores === undefined ? 4 : overrides.physicalCores,
      arch: "x64",
      instructionSets: { avx2: overrides.avx2 === undefined ? true : overrides.avx2, avx512: false, neon: null, dotprod: null },
      quotaCores: overrides.quotaCores ?? null,
      quotaSource: overrides.quotaCores ? "cgroup v2 (/sys/fs/cgroup/cpu.max)" : null
    },
    memory: {
      hostTotalBytes: hostTotal,
      hostAvailableBytes: hostAvailable,
      cgroupLimitBytes: overrides.cgroupLimit ?? null,
      cgroupUsageBytes: null,
      cgroupSource: overrides.cgroupLimit ? "cgroup v2 (/sys/fs/cgroup/memory.max)" : null,
      effectiveTotalBytes: overrides.effectiveTotal === undefined ? hostTotal : overrides.effectiveTotal,
      effectiveAvailableBytes: overrides.effectiveAvailable === undefined ? hostAvailable : overrides.effectiveAvailable
    },
    environment: { kind: overrides.environment ?? "bare-metal", signals: [] },
    disk: { path: "/data", freeBytes: 100 * GIB, totalBytes: 200 * GIB }
  };
}

describe("the budget is what the machine HAS, not what is unallocated this second", () => {
  // The regression this whole describe exists for. A workstation with 31 GB of RAM was told a 2.9 GB
  // model "won't fit", because 4.3 GB happened to be unallocated at that instant and the estimator
  // judged against that. Everything else on a running machine is page cache, which the kernel hands
  // back on demand — so the refusal was arithmetic on the wrong number, and an operator who reads it
  // once is right to stop trusting the panel.
  const roomy = () => snapshot({ hostTotal: 31 * GIB, hostAvailable: Math.round(4.3 * GIB) });

  it("fits a model that exceeds free-right-now but sits well inside total memory", () => {
    const estimate = estimateNativeModelFit(roomy(), roundModel, 4096, "f16");
    expect(estimate.verdict, estimate.reason).toBe("comfortable");
    // Judged against 31 GB minus the reserve, never against the 4.3 GB that was merely unallocated.
    expect(estimate.ram.availableBytes).toBe(31 * GIB - nativeApplicationReserveBytes);
  });

  it("still SAYS that loading has to reclaim cache first, rather than staying silent about it", () => {
    // Honest middle: not a refusal, not silence. The model loads; it is just not instant.
    const tightNow = snapshot({ hostTotal: 31 * GIB, hostAvailable: 1 * GIB, effectiveTotal: 31 * GIB, effectiveAvailable: 1 * GIB });
    const estimate = estimateNativeModelFit(tightNow, roundModel, 4096, "f16");
    const warning = estimate.warnings.find((w) => w.code === "below-free-memory-now");
    expect(warning, `expected a free-memory warning, got ${estimate.warnings.map((w) => w.code).join(", ") || "none"}`).toBeTruthy();
    expect(warning!.message).toMatch(/unallocated at this moment/i);
  });

  it("does NOT warn when the model fits inside what is already free", () => {
    const estimate = estimateNativeModelFit(snapshot({ hostTotal: 31 * GIB, hostAvailable: 20 * GIB }), roundModel, 4096, "f16");
    expect(estimate.warnings.map((w) => w.code)).not.toContain("below-free-memory-now");
  });

  it("a cgroup limit still beats host total — the container protection survives this change", () => {
    // The pod sees a 30 GB node and is capped at 4 GiB. The cap must remain the denominator; this is
    // the one case where the smaller number is the true one.
    const pod = snapshot({
      hostTotal: 30 * GIB, hostAvailable: 25 * GIB,
      cgroupLimit: 4 * GIB, effectiveTotal: 4 * GIB, effectiveAvailable: 4 * GIB,
      environment: "kubernetes"
    });
    const estimate = estimateNativeModelFit(pod, roundModel, 16384, "f16");
    expect(estimate.ram.availableBytes).toBe(4 * GIB - nativeApplicationReserveBytes);
    expect(estimate.ram.availableBytes! < 30 * GIB).toBe(true);
  });
});

describe("KV cache maths — the term the whole catalogue is built around", () => {
  // Identical models but for the KV head count: 2 (grouped-query) against 8. Same depth, same
  // head width, same context. If kv_heads is in the formula the ratio is exactly 4.
  const gqa: NativeModelEntry = { ...roundModel, id: "gqa-2", kvHeads: 2 };
  const wide: NativeModelEntry = { ...roundModel, id: "gqa-8", kvHeads: 8 };

  it("an 8-KV-head model costs exactly 4x the cache of a 2-KV-head model at 16k", () => {
    const small = nativeKvCacheBytes(gqa, 16384, "f16");
    const large = nativeKvCacheBytes(wide, 16384, "f16");
    expect(large / small).toBe(4);
  });

  it("computes the cache from the model's own layers/kv-heads/head-dim, not a flat guess", () => {
    // 2 (K and V) x 32 layers x 2 kv heads x 128 head dim x 16384 tokens x 2 bytes.
    expect(nativeKvCacheBytes(gqa, 16384, "f16")).toBe(2 * 32 * 2 * 128 * 16384 * 2);
  });

  it("an 8-bit KV cache halves it", () => {
    expect(nativeKvCacheBytes(wide, 16384, "q8_0")).toBe(nativeKvCacheBytes(wide, 16384, "f16") / 2);
  });

  it("the parts are shown, not just the total — an operator choosing 8k vs 16k needs to see which number moved", () => {
    const hw = snapshot({});
    const at8k = estimateNativeModelFit(hw, roundModel, 8192);
    const at16k = estimateNativeModelFit(hw, roundModel, 16384);

    expect(at8k.ram.weightBytes).toBe(at16k.ram.weightBytes);
    expect(at16k.ram.kvCacheBytes).toBe(at8k.ram.kvCacheBytes * 2);
    expect(at16k.ram.requiredBytes).toBe(at16k.ram.weightBytes + at16k.ram.kvCacheBytes + at16k.ram.runtimeOverheadBytes);
  });

  it("phi-3.5-mini's plain multi-head attention really is the expensive one in the shipped catalogue", () => {
    // Not a synthetic argument — the real catalogue entries, at the context this app uses. If a
    // future edit "simplifies" the kv-head figures, this is the number that moves.
    const phi = findNativeModel("phi-3.5-mini-instruct-q4_k_m")!;
    const qwen3b = findNativeModel("qwen2.5-3b-instruct-q4_k_m")!;
    const ratio = nativeKvCacheBytes(phi, 16384, "f16") / nativeKvCacheBytes(qwen3b, 16384, "f16");
    expect(ratio).toBeGreaterThan(9);
    // Exactly 6 GiB of cache before a single weight is loaded — which is why that entry
    // recommends 4k of context and the Qwen 3B beside it recommends 16k.
    expect(nativeKvCacheBytes(phi, 16384, "f16")).toBe(6 * GIB);
  });
});

describe("the cgroup limit beats host RAM", () => {
  it("a 3 GiB model on a 30 GB host capped at 4 GiB will not fit", () => {
    const hw = snapshot({
      hostTotal: 32 * GIB,
      hostAvailable: 30 * GIB,
      cgroupLimit: 4 * GIB,
      effectiveTotal: 4 * GIB,
      effectiveAvailable: 4 * GIB,
      environment: "kubernetes"
    });
    const estimate = estimateNativeModelFit(hw, roundModel, 4096);

    expect(estimate.ram.requiredBytes).toBe(3 * GIB);
    // 4 GiB - 1.5 GiB reserve = 2.5 GiB, which is less than the 3 GiB required.
    expect(estimate.verdict).toBe("will-not-fit");
    expect(estimate.reason).toContain("Won't fit");
  });

  it("...and the SAME model on the SAME host is comfortable once the cap is lifted", () => {
    // The control. Everything is identical except that the cgroup no longer binds — proving the
    // failure above is the limit talking and not some other property of the fixture.
    const hw = snapshot({ hostTotal: 32 * GIB, hostAvailable: 30 * GIB, effectiveTotal: 32 * GIB, effectiveAvailable: 30 * GIB });
    expect(estimateNativeModelFit(hw, roundModel, 4096).verdict).toBe("comfortable");
  });

  it("reports the host figure for contrast but never computes from it", () => {
    const hw = snapshot({
      hostTotal: 32 * GIB,
      hostAvailable: 30 * GIB,
      cgroupLimit: 4 * GIB,
      effectiveTotal: 4 * GIB,
      effectiveAvailable: 4 * GIB,
      environment: "docker"
    });
    const estimate = estimateNativeModelFit(hw, roundModel, 4096);

    expect(estimate.ram.hostTotalBytes).toBe(32 * GIB);
    expect(estimate.ram.effectiveTotalBytes).toBe(4 * GIB);
    // The number the verdict used: effective available minus the reserve. Never 30 GiB.
    expect(estimate.ram.availableBytes).toBe(4 * GIB - nativeApplicationReserveBytes);
  });

  it("warns when a container has no memory limit at all, because then the host figure IS what we have", () => {
    const hw = snapshot({ environment: "docker", cgroupLimit: null });
    const codes = estimateNativeModelFit(hw, roundModel, 4096).warnings.map((w) => w.code);
    expect(codes).toContain("container-without-memory-limit");
  });

  it("does not cry container on bare metal", () => {
    const codes = estimateNativeModelFit(snapshot({ environment: "bare-metal" }), roundModel, 4096).warnings.map((w) => w.code);
    expect(codes).not.toContain("container-without-memory-limit");
  });
});

describe("the application reserve", () => {
  it("a 3 GiB model on a 4 GiB machine does NOT fit, because MySQL and Node live here too", () => {
    // Bare metal, no cgroup anywhere: host and effective are the same number, so the ONLY thing
    // standing between a 4 GiB machine and "comfortable" is the reserve. Note the pressure is
    // expressed as TOTAL memory, not free memory — free-right-now is page cache away from being
    // meaningless, and judging against it once told a 31 GB workstation it could not hold 3 GB.
    const hw = snapshot({ hostTotal: 4 * GIB, hostAvailable: 4 * GIB, effectiveTotal: 4 * GIB, effectiveAvailable: 4 * GIB });
    const estimate = estimateNativeModelFit(hw, roundModel, 4096);

    expect(estimate.ram.applicationReserveBytes).toBe(nativeApplicationReserveBytes);
    expect(estimate.ram.availableBytes).toBe(4 * GIB - nativeApplicationReserveBytes);
    expect(estimate.verdict).toBe("will-not-fit");
  });

  it("states the reserve in the reason, so the missing memory is accounted for rather than mysterious", () => {
    const hw = snapshot({ hostTotal: 4 * GIB, effectiveTotal: 4 * GIB });
    expect(estimateNativeModelFit(hw, roundModel, 4096).reason).toContain("reserved for the database and the app");
  });
});

describe("verdicts always explain themselves", () => {
  const cases: Array<[string, NativeHardwareSnapshot]> = [
    ["comfortable", snapshot({ hostTotal: 16 * GIB, effectiveTotal: 16 * GIB })],
    ["tight", snapshot({ hostTotal: 5 * GIB, effectiveTotal: 5 * GIB })],
    ["will-not-fit", snapshot({ hostTotal: 2 * GIB, effectiveTotal: 2 * GIB })],
    ["unknown", snapshot({ hostTotal: null, effectiveTotal: null })]
  ];

  it.each(cases)("%s carries a non-empty reason naming real numbers", (_label, hw) => {
    const estimate = estimateNativeModelFit(hw, roundModel, 4096);
    expect(estimate.reason).toBeTruthy();
    expect(estimate.reason.length).toBeGreaterThan(20);
  });

  it("covers all four verdicts, so none of them can quietly become unreachable", () => {
    const seen = cases.map(([, hw]) => estimateNativeModelFit(hw, roundModel, 4096).verdict);
    expect(new Set(seen)).toEqual(new Set(["comfortable", "tight", "will-not-fit", "unknown"]));
  });

  it("unknown memory is undecidable, never optimistic", () => {
    const estimate = estimateNativeModelFit(snapshot({ hostTotal: null, effectiveTotal: null }), roundModel, 4096);
    expect(estimate.verdict).toBe("unknown");
    expect(estimate.ram.availableBytes).toBeNull();
    expect(estimate.warnings.map((w) => w.code)).toContain("unknown-memory");
  });
});

describe("thread and context recommendations", () => {
  it("leaves a core for the rest of the application", () => {
    const estimate = estimateNativeModelFit(snapshot({ physicalCores: 8 }), roundModel, 4096);
    expect(estimate.recommended.threads).toBe(7);
  });

  it("a cgroup CPU quota clamps the thread count — 32 cores, 2 cores of quota, 2 threads", () => {
    const estimate = estimateNativeModelFit(snapshot({ physicalCores: 32, quotaCores: 2 }), roundModel, 4096);
    expect(estimate.recommended.threads).toBe(2);
    expect(estimate.recommended.threadsBasis).toContain("quota");
    expect(estimate.warnings.map((w) => w.code)).toContain("cpu-quota-clamped-threads");
  });

  it("a quota larger than the machine is not a licence to exceed the machine", () => {
    const estimate = estimateNativeModelFit(snapshot({ physicalCores: 4, quotaCores: 64 }), roundModel, 4096);
    expect(estimate.recommended.threads).toBe(3);
  });

  it("assumes hyperthreading when only a logical count is available, and says so", () => {
    const estimate = estimateNativeModelFit(snapshot({ physicalCores: null, logicalCores: 16 }), roundModel, 4096);
    expect(estimate.recommended.threads).toBe(7); // 16 logical -> 8 assumed physical -> minus 1
    expect(estimate.warnings.map((w) => w.code)).toContain("assumed-physical-cores");
  });

  it("no CPU count at all is null threads, not a made-up one", () => {
    const estimate = estimateNativeModelFit(snapshot({ physicalCores: null, logicalCores: null }), roundModel, 4096);
    expect(estimate.recommended.threads).toBeNull();
    expect(estimate.warnings.map((w) => w.code)).toContain("unknown-cpu-count");
  });

  it("recommends the largest ladder context that still leaves comfortable headroom", () => {
    const hw = snapshot({ hostAvailable: 32 * GIB, effectiveAvailable: 32 * GIB });
    expect(estimateNativeModelFit(hw, roundModel, 4096).recommended.contextTokens).toBe(nativeContextLadder.at(-1));
  });

  it("recommends nothing, with a warning, when not even the smallest rung fits", () => {
    const hw = snapshot({ hostTotal: 2 * GIB, effectiveTotal: 2 * GIB });
    const estimate = estimateNativeModelFit(hw, roundModel, 4096);
    expect(estimate.recommended.contextTokens).toBeNull();
    expect(estimate.warnings.map((w) => w.code)).toContain("context-does-not-fit");
  });
});

describe("the speed estimate is honest about being an estimate", () => {
  it("never claims to be measured", () => {
    const estimate = estimateNativeModelFit(snapshot({}), roundModel, 4096);
    expect(estimate.speed.measured).toBe(false);
    expect(estimate.speed.basis).toContain("estimate");
  });

  it("falls back to the most pessimistic bandwidth class when the instruction sets are unknown, and warns", () => {
    const known = estimateNativeModelFit(snapshot({ avx2: true }), roundModel, 4096);
    const unknown = estimateNativeModelFit(snapshot({ avx2: null }), roundModel, 4096);

    expect(unknown.speed.assumedBandwidthBytesPerSec!).toBeLessThan(known.speed.assumedBandwidthBytesPerSec!);
    expect(unknown.warnings.map((w) => w.code)).toContain("unknown-instruction-set");
    expect(known.warnings.map((w) => w.code)).not.toContain("unknown-instruction-set");
  });

  it("is bandwidth-bound: twice the weights, half the tokens per second", () => {
    const heavy: NativeModelEntry = { ...roundModel, id: "heavy", fileSizeBytes: 4 * GIB };
    const hw = snapshot({});
    const light = estimateNativeModelFit(hw, roundModel, 4096).speed.tokensPerSecond!;
    const dense = estimateNativeModelFit(hw, heavy, 4096).speed.tokensPerSecond!;
    expect(dense).toBeCloseTo(light / 2, 1);
  });
});

describe("the catalogue itself", () => {
  it("has unique ids", () => {
    const ids = nativeModelCatalogue.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("names exactly one recommended default", () => {
    expect(nativeModelCatalogue.filter((entry) => entry.recommendedDefault === true)).toHaveLength(1);
  });

  it("every entry carries the fields the estimator divides by", () => {
    for (const entry of nativeModelCatalogue) {
      expect(entry.layers, entry.id).toBeGreaterThan(0);
      expect(entry.kvHeads, entry.id).toBeGreaterThan(0);
      expect(entry.headDim, entry.id).toBeGreaterThan(0);
      expect(entry.parameterCountB, entry.id).toBeGreaterThan(0);
      expect(entry.maxContextTokens, entry.id).toBeGreaterThan(0);
      expect(entry.repo, entry.id).toMatch(/^[\w.-]+\/[\w.-]+$/);
      expect(entry.file, entry.id).toMatch(/\.gguf$/);
      expect(nativeQuantBitsPerWeight[entry.quantisation], entry.id).toBeGreaterThan(0);
    }
  });

  it("never recommends a context above the model's own maximum", () => {
    for (const entry of nativeModelCatalogue) {
      expect(entry.recommendedContextTokens, entry.id).toBeLessThanOrEqual(entry.maxContextTokens);
    }
  });

  it("says what each model is bad at, not only what it is good at", () => {
    for (const entry of nativeModelCatalogue) {
      expect(entry.goodAt.length, entry.id).toBeGreaterThan(20);
      expect(entry.weakAt.length, entry.id).toBeGreaterThan(20);
    }
  });

  it("declares no file sizes today, and derives them instead — see the header for why a guessed size is worse than none", () => {
    for (const entry of nativeModelCatalogue) {
      expect(entry.fileSizeBytes, entry.id).toBeUndefined();
      const weight = nativeModelWeightBytes(entry);
      expect(weight.source, entry.id).toBe("derived-from-quantisation");
      expect(weight.bytes, entry.id).toBeGreaterThan(0);
    }
  });

  it("prefers a measured file size the moment one exists", () => {
    expect(nativeModelWeightBytes(roundModel)).toEqual({ bytes: 2 * GIB, source: "catalogue" });
  });

  it("derives a larger file for a heavier quant of the same model", () => {
    const q4 = findNativeModel("qwen2.5-3b-instruct-q4_k_m")!;
    const q5 = findNativeModel("qwen2.5-3b-instruct-q5_k_m")!;
    expect(nativeModelWeightBytes(q5).bytes).toBeGreaterThan(nativeModelWeightBytes(q4).bytes);
  });

  it("every catalogue entry produces a complete estimate on a real-ish machine", () => {
    const hw = snapshot({ hostTotal: 16 * GIB, hostAvailable: 12 * GIB, effectiveTotal: 16 * GIB, effectiveAvailable: 12 * GIB });
    for (const entry of nativeModelCatalogue) {
      const estimate = estimateNativeModelFit(hw, entry, entry.recommendedContextTokens);
      expect(estimate.modelId, entry.id).toBe(entry.id);
      expect(estimate.reason, entry.id).toBeTruthy();
      expect(estimate.ram.requiredBytes, entry.id).toBe(
        estimate.ram.weightBytes + estimate.ram.kvCacheBytes + nativeRuntimeOverheadBytes
      );
    }
  });

  it("findNativeModel returns undefined for an id that is no longer in the list, rather than throwing", () => {
    expect(findNativeModel("something-we-removed-last-release")).toBeUndefined();
  });
});
