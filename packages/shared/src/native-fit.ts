/**
 * WHAT: the shape of "what this machine is", and the pure function that answers "will this model
 * run on it, and how well". Shared, because the settings screen and the API must give the operator
 * the SAME answer — a UI that recomputes the fit in its own arithmetic is a UI that will eventually
 * show a green badge over a server that refuses the download.
 *
 * WHY THE ESTIMATOR IS PURE. No fs, no database, no clock. It takes a snapshot and a catalogue
 * entry and returns numbers. That is what makes the interesting cases testable at all: "a pod
 * capped at 1 GiB on a 32 GiB host" is a one-line fixture here and an unreproducible production
 * incident anywhere else. The probe that PRODUCES the snapshot lives in the API
 * (`services/hardware-probe.service.ts`) and is the only part that touches the machine.
 *
 * THE THING THIS FILE EXISTS TO GET RIGHT. `os.totalmem()` reports the HOST's memory, always. A
 * container capped at 1 GiB is told it has 32 GiB, is told a 3B model fits comfortably, downloads
 * two gigabytes, and is OOM-killed the instant llama.cpp maps the file. Every memory figure that
 * reaches a verdict comes from `memory.effectiveTotalBytes`, which the probe has already reduced to
 * the MINIMUM of the host figure and any cgroup limit. Nothing here may reach past it to the host
 * number, and a test pins exactly that.
 *
 * AND THE VERDICT IS COMPUTED FROM TOTAL, NOT FROM FREE-RIGHT-NOW. This is the second half of the
 * same lesson and it was learned the hard way: judging against `freemem()` told a workstation with
 * 31 GB of RAM that a 2.9 GB model would not fit, because 4.3 GB happened to be unallocated at the
 * moment of the probe. Everything else was reclaimable page cache — memory the kernel hands back the
 * instant something asks for it. A refusal like that is not conservative, it is wrong, and an
 * operator who reads it once is right to stop trusting the whole screen.
 *
 * So the budget is what the machine HAS minus a stated reserve, and free-right-now becomes a
 * WARNING when a model needs more than is currently unallocated: it will load, the kernel just has
 * to evict cache first. Both tests are pinned, including the 31 GB case by name.
 *
 * WHAT IS DELIBERATELY AN ESTIMATE, AND SAYS SO. The generation speed. CPU token generation is
 * bound by memory bandwidth, not clock — every token streams the entire model through the cache
 * hierarchy — and there is no portable way to ask a machine what its memory bandwidth is. So the
 * number here is derived from a conservative per-architecture assumption, `measured` is `false`,
 * and `speed.basis` says in words where the figure came from, so the UI can render "roughly" and
 * a later benchmark can replace it with a measurement rather than argue with it.
 */

import {
  type NativeModelEntry,
  type NativeModelWeightSource,
  nativeModelWeightBytes
} from "./native-models.js";

/** Where a machine is running, as far as it can tell about itself. */
export const nativeRuntimeEnvironments = ["bare-metal", "docker", "kubernetes", "wsl", "unknown"] as const;
export type NativeRuntimeEnvironment = (typeof nativeRuntimeEnvironments)[number];

/**
 * llama.cpp's KV cache element type. `f16` is the default; `q8_0` halves the cache for a quality
 * cost small enough to be worth it at long contexts.
 */
export const nativeKvCacheTypes = ["f16", "q8_0"] as const;
export type NativeKvCacheType = (typeof nativeKvCacheTypes)[number];

/**
 * What the probe reports. EVERY field that could fail to be readable is nullable, and `null` here
 * always means "could not determine", never "zero" — an unreadable `/proc/cpuinfo` must not be
 * reported as a machine with no CPU flags, because those two are acted on differently.
 */
export interface NativeHardwareSnapshot {
  sampledAt: string;
  cpu: {
    model: string | null;
    /** `os.cpus().length` — hyperthreads included. Not the useful thread count for inference. */
    logicalCores: number | null;
    /** Real cores, when the machine will say. `null` means the estimator has to assume. */
    physicalCores: number | null;
    arch: string;
    /** `null` per flag means "this platform would not tell us", which is worth more than a guess. */
    instructionSets: {
      avx2: boolean | null;
      avx512: boolean | null;
      neon: boolean | null;
      dotprod: boolean | null;
    };
    /** cgroup CPU quota expressed in whole-core equivalents (`cpu: "2"` -> 2). Null = no quota. */
    quotaCores: number | null;
    /** Which file the quota came from, for the UI to show its work. */
    quotaSource: string | null;
  };
  memory: {
    hostTotalBytes: number | null;
    hostAvailableBytes: number | null;
    /** The cgroup's own ceiling, when there is a real one. The "no limit" sentinel is null here. */
    cgroupLimitBytes: number | null;
    cgroupUsageBytes: number | null;
    cgroupSource: string | null;
    /** min(host total, cgroup limit) — the only total anything downstream is allowed to believe. */
    effectiveTotalBytes: number | null;
    effectiveAvailableBytes: number | null;
  };
  environment: {
    kind: NativeRuntimeEnvironment;
    /** Every signal that fired, in words, so the UI can explain the label instead of asserting it. */
    signals: string[];
  };
  disk: {
    /** The directory a model would be downloaded into. */
    path: string;
    freeBytes: number | null;
    totalBytes: number | null;
  } | null;
}

export const nativeFitVerdicts = ["comfortable", "tight", "will-not-fit", "unknown"] as const;
export type NativeFitVerdict = (typeof nativeFitVerdicts)[number];

export interface NativeFitWarning {
  code: string;
  message: string;
}

export interface NativeFitEstimate {
  modelId: string;
  contextTokens: number;
  kvCacheType: NativeKvCacheType;
  ram: {
    /** The model file itself. */
    weightBytes: number;
    weightSource: NativeModelWeightSource;
    /** Computed from the model's own layers/kv-heads/head-dim at THIS context. */
    kvCacheBytes: number;
    /** llama.cpp's own working set beside the weights and the cache. */
    runtimeOverheadBytes: number;
    requiredBytes: number;
    /** What the machine claims, before the cgroup is taken into account. Reported for contrast
     *  only — no verdict is computed from it. */
    hostTotalBytes: number | null;
    /** After the cgroup. This is the honest ceiling. */
    effectiveTotalBytes: number | null;
    /** Held back for MySQL, Node and the OS — see `nativeApplicationReserveBytes`. */
    applicationReserveBytes: number;
    /** Effective available minus the reserve, floored at zero. The number the verdict uses. */
    availableBytes: number | null;
  };
  verdict: NativeFitVerdict;
  /** NEVER empty. A red badge is not actionable; "needs 3.8 GB, 2.1 GB free after reserve" is. */
  reason: string;
  speed: {
    tokensPerSecond: number | null;
    assumedBandwidthBytesPerSec: number | null;
    /** In words: what was assumed and why. Rendered next to the number, not hidden behind it. */
    basis: string;
    /** Always false here. A real benchmark sets this true and replaces `tokensPerSecond`. */
    measured: false;
  };
  recommended: {
    threads: number | null;
    threadsBasis: string;
    /** The largest ladder rung that fits. Null when nothing fits. */
    contextTokens: number | null;
  };
  warnings: NativeFitWarning[];
}

/**
 * The payload of `GET /settings/ai/native/capability`. Lives here rather than beside the route so
 * the web client and the API are typed by the same declaration — the whole reason this module is
 * shared.
 */
export interface NativeCapabilityReport {
  hardware: NativeHardwareSnapshot;
  /** One estimate per catalogue entry, each at that entry's own recommended context. */
  models: Array<{ modelId: string; estimate: NativeFitEstimate }>;
  /** The best entry that is `comfortable` here, preferring the curated default. Null when nothing
   *  in the catalogue fits — a real outcome on a small box, not something to paper over. */
  suggestedModelId: string | null;
}

/**
 * Held back from "available RAM" for everything that is NOT the model.
 *
 * WHY 1.5 GiB AND WHY A RESERVE AT ALL: this app does not run alone. MySQL sits beside it with an
 * InnoDB buffer pool that real installs size at 512 MB to 1 GB, the API's own Node heap runs a few
 * hundred megabytes under load, and the OS wants page cache for both. A model that fits into "free
 * RAM" and then evicts the database's buffer pool has not fit — it has moved the slowness somewhere
 * the operator will not connect to the model they just installed. Sizing the reserve at the buffer
 * pool plus the Node heap plus a little is the smallest figure that keeps that from happening.
 */
export const nativeApplicationReserveBytes = Math.round(1.5 * 1024 ** 3);

/**
 * llama.cpp's working set beside the weights and the KV cache: compute buffers, the logits tensor
 * over the full vocabulary, the graph allocator's scratch, and the server process itself. It
 * scales with batch and vocabulary rather than with context, so a flat allowance is the honest
 * shape. It also quietly absorbs the ~6% that a `q8_0` KV cache spends on its per-block scales,
 * which the halving below does not model.
 */
export const nativeRuntimeOverheadBytes = 512 * 1024 ** 2;

/** One core left for the rest of the application. Handing every physical core to llama.cpp starves
 *  the event loop that is supposed to be serving the request that asked for the completion. */
export const nativeAppCpuReserveCores = 1;

/** Below this much headroom the verdict is `tight` rather than `comfortable`: it will load, and it
 *  will be the first thing the OOM killer looks at when anything else spikes. */
export const nativeComfortableHeadroomRatio = 0.85;

/**
 * Assumed sustained memory bandwidth, by what we could learn about the CPU. Conservative on
 * purpose — over-promising throughput is how a "fast" verdict becomes a support ticket.
 *
 * AVX-512 is used as a proxy for "server-class part with multi-channel memory", which is a
 * correlation and not a rule; it is the best signal available without running a benchmark.
 */
export const nativeAssumedBandwidthBytesPerSec = {
  avx512: 40e9,
  avx2: 25e9,
  arm64: 25e9,
  unknown: 12e9
} as const;

/** llama.cpp does not reach peak theoretical bandwidth; ~60% of it is the usual observed share. */
export const nativeBandwidthEfficiency = 0.6;

/** The contexts this app will actually recommend. 16k is the top because the app's own truncation
 *  caps mean nothing here fills more — paying KV above it is paying for context nobody sends. */
export const nativeContextLadder = [2048, 4096, 8192, 16384] as const;

/**
 * KV cache bytes for a model at a context.
 *
 *     2 (one K and one V) x layers x kv_heads x head_dim x context x bytes_per_element
 *
 * The `kv_heads` term is the one that surprises people and the one this whole catalogue is built
 * around: it is KEY-VALUE heads, not attention heads, so a grouped-query model with 2 of them pays
 * a quarter of what an otherwise identical model with 8 pays, and a sixteenth of a plain
 * multi-head model with 32. At 16k that difference is measured in gigabytes.
 */
export function nativeKvCacheBytes(entry: NativeModelEntry, contextTokens: number, kvCacheType: NativeKvCacheType): number {
  // f16 is two bytes per element; q8_0 is one. The real q8_0 layout adds a scale per 32-element
  // block (~6% more), which `nativeRuntimeOverheadBytes` absorbs rather than modelling here.
  const bytesPerElement = kvCacheType === "q8_0" ? 1 : 2;
  return 2 * entry.layers * entry.kvHeads * entry.headDim * contextTokens * bytesPerElement;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "unknown";
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${Math.round(gb * 10) / 10} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

function bandwidthFor(cpu: NativeHardwareSnapshot["cpu"]): { bytesPerSec: number; basis: string; known: boolean } {
  if (cpu.instructionSets.avx512 === true) {
    return {
      bytesPerSec: nativeAssumedBandwidthBytesPerSec.avx512,
      basis: "assumed 40 GB/s — AVX-512 present, which usually means a server part with multi-channel memory",
      known: true
    };
  }
  if (cpu.instructionSets.avx2 === true) {
    return {
      bytesPerSec: nativeAssumedBandwidthBytesPerSec.avx2,
      basis: "assumed 25 GB/s — AVX2 present, typical of a desktop or cloud x86 part",
      known: true
    };
  }
  if (cpu.arch === "arm64" && cpu.instructionSets.neon === true) {
    return {
      bytesPerSec: nativeAssumedBandwidthBytesPerSec.arm64,
      basis: "assumed 25 GB/s — ARM64 with NEON; Apple Silicon is considerably faster than this and will out-perform the estimate",
      known: true
    };
  }
  return {
    bytesPerSec: nativeAssumedBandwidthBytesPerSec.unknown,
    basis: "assumed 12 GB/s — this platform would not report its CPU instruction sets, so the most conservative class was used",
    known: false
  };
}

/**
 * Verdict + reason. Split out of `estimateNativeModelFit` so the branch that decides the headline
 * answer reads as one short thing; `warnings` is threaded through because two of the three
 * outcomes have something extra worth saying.
 *
 * THE INVARIANT: every branch sets a non-empty `reason`. A verdict without one is a coloured badge,
 * and a coloured badge tells an operator nothing about what to do next.
 */
function judgeFit(
  requiredBytes: number,
  availableBytes: number | null,
  warnings: NativeFitWarning[]
): { verdict: NativeFitVerdict; reason: string } {
  if (availableBytes === null) {
    warnings.push({ code: "unknown-memory", message: "Memory could not be read on this platform; the fit is undecidable rather than optimistic." });
    return {
      verdict: "unknown",
      reason: `Could not determine how much memory this machine has, so no honest verdict is possible. The model needs about ${formatBytes(requiredBytes)}.`
    };
  }
  if (requiredBytes > availableBytes) {
    return {
      verdict: "will-not-fit",
      reason: `Won't fit: needs ${formatBytes(requiredBytes)}, ${formatBytes(availableBytes)} available after the ${formatBytes(nativeApplicationReserveBytes)} reserved for the database and the app.`
    };
  }
  if (requiredBytes > availableBytes * nativeComfortableHeadroomRatio) {
    warnings.push({
      code: "near-budget",
      message: "This model sits at the edge of the memory budget. Lower the context, choose a q8_0 KV cache, or pick a smaller entry."
    });
    return {
      verdict: "tight",
      reason: `Tight: needs ${formatBytes(requiredBytes)} of the ${formatBytes(availableBytes)} available after reserve — under 15% headroom, so anything else that spikes will push it out.`
    };
  }
  return {
    verdict: "comfortable",
    reason: `Comfortable: needs ${formatBytes(requiredBytes)} of ${formatBytes(availableBytes)} available after reserve.`
  };
}

/**
 * How many inference threads this machine should be told to use, and why in words.
 *
 * Two independent ceilings, and BOTH have to apply: physical cores minus a reserve for the app,
 * and any cgroup CPU quota. A pod with `cpu: "2"` on a 64-core node passes the first check with 63
 * and must still come out at 2 — running more threads than the quota does not go faster, it just
 * exhausts the period sooner and spends the rest of it throttled.
 */
function recommendThreads(
  cpu: NativeHardwareSnapshot["cpu"],
  warnings: NativeFitWarning[]
): { threads: number | null; threadsBasis: string } {
  let physicalCores = cpu.physicalCores;
  if (physicalCores === null && cpu.logicalCores !== null) {
    // WHY HALVE: os.cpus() counts hyperthreads, and two threads sharing one core's load/store
    // units do not double a bandwidth-bound workload — llama.cpp's own guidance is physical
    // cores. Assuming SMT is wrong on a machine without it, so it is a warning, not a silent fix.
    physicalCores = Math.max(1, Math.floor(cpu.logicalCores / 2));
    warnings.push({
      code: "assumed-physical-cores",
      message: `This platform reports only ${cpu.logicalCores} logical CPUs, so ${physicalCores} physical cores were assumed (hyperthreading). If this chip has no SMT, the thread count below is half what it could be.`
    });
  }
  if (physicalCores === null) {
    warnings.push({ code: "unknown-cpu-count", message: "CPU count unavailable; llama.cpp's own default will have to be used." });
    return { threads: null, threadsBasis: "unknown — this machine would not report a CPU count" };
  }

  const fromCores = Math.max(1, physicalCores - nativeAppCpuReserveCores);
  const quotaCap = cpu.quotaCores === null ? null : Math.max(1, Math.floor(cpu.quotaCores));
  if (quotaCap !== null && quotaCap < fromCores) {
    warnings.push({
      code: "cpu-quota-clamped-threads",
      message: `A cgroup CPU quota of ${cpu.quotaCores} cores is in force. Running more threads than the quota does not go faster; it just gets throttled harder.`
    });
    return {
      threads: quotaCap,
      threadsBasis: `clamped to ${quotaCap} by the cgroup CPU quota of ${cpu.quotaCores} cores (${cpu.quotaSource ?? "cgroup"}) — the machine has more cores than this container may use`
    };
  }
  return {
    threads: fromCores,
    threadsBasis: `${physicalCores} physical cores minus ${nativeAppCpuReserveCores} left for the API and the database`
  };
}

/**
 * The largest ladder rung that still leaves COMFORTABLE headroom — not the largest that merely
 * fits. Recommending a context that lands on `tight` is recommending an OOM kill with a delay.
 */
function recommendContext(
  model: NativeModelEntry,
  weightBytes: number,
  availableBytes: number | null,
  kvCacheType: NativeKvCacheType,
  warnings: NativeFitWarning[]
): number | null {
  if (availableBytes === null) return null;
  let best: number | null = null;
  for (const rung of nativeContextLadder) {
    if (rung > model.maxContextTokens) continue;
    const need = weightBytes + nativeKvCacheBytes(model, rung, kvCacheType) + nativeRuntimeOverheadBytes;
    if (need <= availableBytes * nativeComfortableHeadroomRatio) best = rung;
  }
  if (best === null) {
    warnings.push({
      code: "context-does-not-fit",
      message: `Not even ${nativeContextLadder[0]} tokens of context fits in ${formatBytes(availableBytes)} with this model. A smaller entry, or a q8_0 KV cache, is the only way forward on this machine.`
    });
  }
  return best;
}

/**
 * The whole answer for one model on one machine at one context. Pure — same inputs, same output,
 * every time.
 */
export function estimateNativeModelFit(
  hardware: NativeHardwareSnapshot,
  model: NativeModelEntry,
  contextTokens: number,
  kvCacheType: NativeKvCacheType = "f16"
): NativeFitEstimate {
  const warnings: NativeFitWarning[] = [];

  const weight = nativeModelWeightBytes(model);
  const kvCacheBytes = nativeKvCacheBytes(model, contextTokens, kvCacheType);
  const requiredBytes = weight.bytes + kvCacheBytes + nativeRuntimeOverheadBytes;

  // THE CENTRAL RULE OF THIS FILE: the budget is derived from the effective TOTAL — the host's
  // memory or the cgroup limit, whichever is lower — and never from the host figure alone. That is
  // what keeps the container lie out of the verdict.
  //
  // AND IT IS TOTAL, NOT FREE-RIGHT-NOW, which is the correction that matters most here. `freemem()`
  // reports only unallocated memory; on any machine that has been up for an hour most of the rest is
  // reclaimable page cache, which the kernel hands back the moment something asks. Judging against it
  // produced the absurdity this rule was written for: a box with 31 GB of RAM being told a 2.9 GB
  // model would not fit, because 4.3 GB happened to be unallocated at that instant. An operator who
  // reads that once stops believing the panel, and they are right to.
  //
  // Free-right-now is still worth knowing — it decides whether loading is instant or whether the
  // kernel has to evict cache first — so it becomes a WARNING below rather than the denominator.
  const effectiveTotal = hardware.memory.effectiveTotalBytes;
  const availableBytes = effectiveTotal === null ? null : Math.max(0, effectiveTotal - nativeApplicationReserveBytes);

  // A model that fits the budget but exceeds what is unallocated will load — the kernel reclaims
  // cache — it just will not load instantly. Saying so is the honest middle between silence and a
  // false refusal.
  const freeNow = hardware.memory.effectiveAvailableBytes;
  if (availableBytes !== null && freeNow !== null && requiredBytes <= availableBytes && requiredBytes > freeNow) {
    warnings.push({
      code: "below-free-memory-now",
      message: `This fits the machine, but only ${formatBytes(freeNow)} is unallocated at this moment against ${formatBytes(requiredBytes)} needed. The kernel will reclaim page cache to make room, so loading works — it is just slower the first time, and worth a second look if this box is genuinely busy.`
    });
  }

  if (
    hardware.environment.kind !== "bare-metal" &&
    hardware.environment.kind !== "unknown" &&
    hardware.memory.cgroupLimitBytes === null
  ) {
    warnings.push({
      code: "container-without-memory-limit",
      message: `Running under ${hardware.environment.kind} with no cgroup memory limit set, so these figures are the HOST's memory. If the orchestrator caps this container elsewhere, the model may be killed despite a comfortable verdict — set an explicit memory limit to get a real answer.`
    });
  }

  const { verdict, reason } = judgeFit(requiredBytes, availableBytes, warnings);

  if (contextTokens > model.maxContextTokens) {
    warnings.push({
      code: "context-above-model-maximum",
      message: `${model.displayName} was trained to ${model.maxContextTokens} tokens; ${contextTokens} is above its own maximum and llama.cpp will refuse or degrade.`
    });
  }

  // --- speed -------------------------------------------------------------------------------
  // Bandwidth-bound, not clock-bound: generating one token reads every weight in the model
  // exactly once, so tokens/sec is roughly (usable bandwidth / model bytes). This is a rough
  // model and is labelled as one; a measured benchmark from a later block replaces it outright.
  const bandwidth = bandwidthFor(hardware.cpu);
  if (!bandwidth.known) {
    warnings.push({
      code: "unknown-instruction-set",
      message: `CPU instruction sets could not be read on ${hardware.cpu.arch}. Without knowing whether AVX2 or AVX-512 is present, both the speed estimate and llama.cpp's own kernel choice are guesses — the estimate below is deliberately pessimistic.`
    });
  }
  const tokensPerSecond = weight.bytes > 0 ? Math.round(((bandwidth.bytesPerSec * nativeBandwidthEfficiency) / weight.bytes) * 10) / 10 : null;

  const { threads, threadsBasis } = recommendThreads(hardware.cpu, warnings);
  const recommendedContext = recommendContext(model, weight.bytes, availableBytes, kvCacheType, warnings);

  return {
    modelId: model.id,
    contextTokens,
    kvCacheType,
    ram: {
      weightBytes: weight.bytes,
      weightSource: weight.source,
      kvCacheBytes,
      runtimeOverheadBytes: nativeRuntimeOverheadBytes,
      requiredBytes,
      hostTotalBytes: hardware.memory.hostTotalBytes,
      effectiveTotalBytes: hardware.memory.effectiveTotalBytes,
      applicationReserveBytes: nativeApplicationReserveBytes,
      availableBytes
    },
    verdict,
    reason,
    speed: {
      tokensPerSecond,
      assumedBandwidthBytesPerSec: bandwidth.bytesPerSec,
      basis: `${bandwidth.basis}; every token reads all ${formatBytes(weight.bytes)} of weights, so this is an estimate, not a measurement`,
      measured: false
    },
    recommended: {
      threads,
      threadsBasis,
      contextTokens: recommendedContext
    },
    warnings
  };
}
