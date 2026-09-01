/**
 * WHAT: the honest answer to "what machine is this, really" — CPU model, PHYSICAL cores, the
 * instruction sets llama.cpp actually dispatches on, memory as bounded by any cgroup, the CPU
 * quota, which kind of runtime this is, and how much disk a model download would have. Plus the
 * one read-only report that stitches this together with the shared model catalogue and the fit
 * estimator.
 *
 * WHY IT IS A SIBLING OF system-health.service.ts AND NOT A SECOND COPY OF IT. That file already
 * probes CPU and memory for the maintenance panel, and building a second probe beside it would
 * guarantee the two eventually disagree in front of the same admin. So the container-aware parts
 * live HERE, exported, and system-health.service.ts consumes them — which also fixes a real (if
 * quiet) lie in that panel, since it has been reporting the host's memory to anyone running this
 * app in a container.
 *
 * THE CORRECTNESS PROBLEM THIS FILE EXISTS FOR. `os.totalmem()` reports the HOST. Inside Docker or
 * Kubernetes it is not merely imprecise, it is off by an order of magnitude: a pod capped at 1 GiB
 * on a 32 GiB node is told it has 32 GiB, is told a 3B model fits, and is OOM-killed the moment
 * llama.cpp maps the weights. The kernel's real answer is in the cgroup, in two mutually
 * incompatible layouts (v2 and v1), each with its own "there is no limit" sentinel that must NOT be
 * read as a number — cgroup v1 spells "unlimited" as 9223372036854771712, and a fit estimator that
 * believes that has just been told it has 8 exabytes.
 *
 * EVERY PROBE FAILS ALONE. This runs on Windows, Alpine, Debian and macOS. `/proc` does not exist
 * on three of those, `/sys/fs/cgroup` on two, and a hardened container can make either unreadable.
 * So each field is read through `readText`, which returns `null` on ANY error, and each parse
 * returns `null` rather than throwing. A `null` is a fact the UI can render ("unknown"); an
 * exception takes the whole page down, and a fabricated default is worse than both.
 *
 * WINDOWS TELLS US LESS, AND SAYS SO. There is no portable way to read CPU feature flags on
 * Windows from Node without shelling out, so `avx2`/`avx512` come back `null` there rather than
 * `false` (which would read as "this CPU lacks AVX2" — usually untrue) or `true` (a guess that
 * makes the speed estimate confidently wrong). An unknown that admits it is worth more than a
 * confident wrong answer, and the estimator has a documented pessimistic path for exactly this.
 *
 * WHO CALLS THIS: `GET /api/settings/ai/native/capability` (SUPER_ADMIN), and
 * system-health.service.ts for the container-aware memory figures.
 */
import os from "node:os";
import { readFile, statfs } from "node:fs/promises";
import {
  estimateNativeModelFit,
  nativeModelCatalogue,
  type NativeCapabilityReport,
  type NativeHardwareSnapshot,
  type NativeKvCacheType,
  type NativeLibc,
  type NativeRuntimeEnvironment
} from "@timesheet/shared";

/**
 * The one way this file touches the filesystem, so the tests can replace it wholesale and describe
 * a Kubernetes pod on a Windows dev box. Returns `null` for every failure mode there is —
 * not-found, permission denied, a directory, an unreadable procfs entry mid-read.
 */
export interface HardwareProbeIo {
  readText(path: string): Promise<string | null>;
  freeDiskBytes(path: string): Promise<{ freeBytes: number; totalBytes: number } | null>;
  platform(): NodeJS.Platform;
  arch(): string;
  cpus(): os.CpuInfo[];
  totalmem(): number;
  freemem(): number;
  env(): NodeJS.ProcessEnv;
}

export const defaultHardwareProbeIo: HardwareProbeIo = {
  async readText(path) {
    try {
      return await readFile(path, "utf8");
    } catch {
      return null;
    }
  },
  async freeDiskBytes(path) {
    try {
      const info = await statfs(path);
      return { freeBytes: Number(info.bavail) * Number(info.bsize), totalBytes: Number(info.blocks) * Number(info.bsize) };
    } catch {
      return null;
    }
  },
  platform: () => process.platform,
  arch: () => process.arch,
  cpus: () => os.cpus(),
  totalmem: () => os.totalmem(),
  freemem: () => os.freemem(),
  env: () => process.env
};

/**
 * Anything at or above this is a "no limit" sentinel, not a memory limit.
 *
 * WHY A THRESHOLD RATHER THAN AN EQUALITY TEST: cgroup v1 does not write one canonical value. It
 * writes PAGE_COUNTER_MAX, which is `LONG_MAX / PAGE_SIZE * PAGE_SIZE` — so the exact number
 * differs by page size and by kernel version (9223372036854771712 on a 4 KiB-page x86 box,
 * something else on a 64 KiB-page ARM one). Matching a hard-coded constant would silently start
 * treating "unlimited" as a real limit on the first machine that spells it differently. 8 PiB is
 * far above any real container cap and far below every sentinel any kernel writes.
 */
export const cgroupNoLimitThresholdBytes = 2 ** 53;

/** `null` for anything that is not a clean non-negative integer, including the sentinel. */
function parseCgroupBytes(raw: string | null): number | null {
  if (raw === null) return null;
  const text = raw.trim();
  // cgroup v2 spells "unlimited" literally.
  if (text === "" || text === "max") return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value >= cgroupNoLimitThresholdBytes) return null;
  return value;
}

/** The cgroup memory ceiling and current usage, whichever layout this kernel uses. */
export async function readCgroupMemory(
  io: HardwareProbeIo = defaultHardwareProbeIo
): Promise<{ limitBytes: number | null; usageBytes: number | null; source: string | null }> {
  // v2 first: a machine running the unified hierarchy may still have v1 paths present but empty.
  const v2Limit = parseCgroupBytes(await io.readText("/sys/fs/cgroup/memory.max"));
  if (v2Limit !== null) {
    return {
      limitBytes: v2Limit,
      usageBytes: parseCgroupBytes(await io.readText("/sys/fs/cgroup/memory.current")),
      source: "cgroup v2 (/sys/fs/cgroup/memory.max)"
    };
  }
  const v1Limit = parseCgroupBytes(await io.readText("/sys/fs/cgroup/memory/memory.limit_in_bytes"));
  if (v1Limit !== null) {
    return {
      limitBytes: v1Limit,
      usageBytes: parseCgroupBytes(await io.readText("/sys/fs/cgroup/memory/memory.usage_in_bytes")),
      source: "cgroup v1 (/sys/fs/cgroup/memory/memory.limit_in_bytes)"
    };
  }
  return { limitBytes: null, usageBytes: null, source: null };
}

/**
 * The cgroup CPU quota, in whole-core equivalents — `cpu: "2"` in a pod spec comes back as 2.
 *
 * WHY IT MATTERS HERE: a pod with a 2-core quota on a 64-core node sees 64 cores from `os.cpus()`.
 * Told to run 63 inference threads, it does not run fast; it burns its entire quota inside the
 * first few milliseconds of every scheduler period and then sits throttled, which is slower than
 * running two threads would have been.
 */
export async function readCgroupCpuQuota(
  io: HardwareProbeIo = defaultHardwareProbeIo
): Promise<{ quotaCores: number | null; source: string | null }> {
  // v2: one file, "<quota> <period>", with "max" for no quota.
  const v2 = await io.readText("/sys/fs/cgroup/cpu.max");
  if (v2 !== null) {
    const [quotaRaw, periodRaw] = v2.trim().split(/\s+/);
    const period = Number(periodRaw);
    if (quotaRaw && quotaRaw !== "max" && Number.isFinite(Number(quotaRaw)) && Number.isFinite(period) && period > 0) {
      const cores = Number(quotaRaw) / period;
      if (cores > 0) return { quotaCores: Math.round(cores * 100) / 100, source: "cgroup v2 (/sys/fs/cgroup/cpu.max)" };
    }
  }
  // v1: two files, and the quota is -1 when unset. The controller is mounted at either path
  // depending on how systemd set the machine up, so both are tried.
  for (const dir of ["/sys/fs/cgroup/cpu", "/sys/fs/cgroup/cpu,cpuacct"]) {
    const quota = Number((await io.readText(`${dir}/cpu.cfs_quota_us`))?.trim());
    const period = Number((await io.readText(`${dir}/cpu.cfs_period_us`))?.trim());
    if (Number.isFinite(quota) && quota > 0 && Number.isFinite(period) && period > 0) {
      return { quotaCores: Math.round((quota / period) * 100) / 100, source: `cgroup v1 (${dir}/cpu.cfs_quota_us)` };
    }
  }
  return { quotaCores: null, source: null };
}

/**
 * WHICH C LIBRARY THIS LINUX USERLAND IS BUILT AGAINST — the one fact that decides whether a
 * published llama.cpp binary can run here at all.
 *
 * WHY THIS LIVES IN THE HARDWARE PROBE rather than beside the installer that consumes it: it is a
 * property of the machine, read through the same `HardwareProbeIo` seam as every other property of
 * the machine, and it degrades to `null` on exactly the same terms. Putting it anywhere else would
 * be a second probe of the same box, which is the mistake this file's own header warns about.
 *
 * WHY IT MATTERS SO MUCH HERE. llama.cpp publishes only glibc-linked Linux builds, and this app's
 * image is `node:22-alpine`, which is musl. A glibc binary on musl does not fail with a diagnosis:
 * the kernel's loader reports "no such file or directory" for the binary itself, which plainly
 * exists. An operator handed that error debugs the wrong thing for an hour. So this is checked
 * BEFORE anything is offered, and musl gets the sidecar instructions instead of a download.
 *
 * ── HOW IT IS READ, IN THE ORDER TRUST DECREASES ────────────────────────────────────────────
 *
 * 1. `/proc/self/maps` — the libraries THIS PROCESS actually has mapped. It is the only source that
 *    answers about the running process rather than about the filesystem around it, and `ld-musl-*`
 *    vs `libc.so.6`/`ld-linux-*` is unambiguous there.
 * 2. `/etc/alpine-release` — present on every Alpine image and nowhere else. The fallback for a
 *    hardened container where `/proc/self/maps` is unreadable.
 *
 * A `null` RESULT IS NOT TREATED AS glibc BY THE CALLER, and that is the whole discipline: the cost
 * of guessing wrong in one direction is an operator who has to run a sidecar they could have avoided;
 * in the other it is a binary that cannot start and an error message that lies about why.
 */
export async function detectLibcFlavour(io: HardwareProbeIo = defaultHardwareProbeIo): Promise<NativeLibc | null> {
  if (io.platform() !== "linux") return null;

  const maps = await io.readText("/proc/self/maps");
  if (maps !== null) {
    if (/ld-musl|libc\.musl-/.test(maps)) return "musl";
    if (/libc\.so\.6|ld-linux/.test(maps)) return "glibc";
  }
  // Alpine ships this file and nothing else does. Only consulted when the authoritative source above
  // would not answer — a container can make /proc unreadable, and refusing to look further would
  // report "unknown" on the one distribution this check exists for.
  if ((await io.readText("/etc/alpine-release")) !== null) return "musl";
  return null;
}

/**
 * Which kind of machine this is, AND the signals that decided it.
 *
 * The signals are returned rather than collapsed into the label on purpose: "kubernetes" with no
 * explanation is a claim an operator cannot check, and this detection is heuristic by nature. A
 * panel that says "kubernetes — KUBERNETES_SERVICE_HOST is set, /proc/1/cgroup mentions kubepods"
 * lets somebody spot the day it is wrong.
 */
export async function detectRuntimeEnvironment(
  io: HardwareProbeIo = defaultHardwareProbeIo
): Promise<{ kind: NativeRuntimeEnvironment; signals: string[] }> {
  const signals: string[] = [];

  const pid1Cgroup = (await io.readText("/proc/1/cgroup")) ?? "";
  const dockerEnv = await io.readText("/.dockerenv");
  const version = (await io.readText("/proc/version")) ?? "";

  const hasKubeEnv = typeof io.env().KUBERNETES_SERVICE_HOST === "string" && io.env().KUBERNETES_SERVICE_HOST !== "";
  if (hasKubeEnv) signals.push("KUBERNETES_SERVICE_HOST is set");
  const kubeCgroup = /kubepods|kubelet/i.test(pid1Cgroup);
  if (kubeCgroup) signals.push("/proc/1/cgroup mentions kubepods");
  if (dockerEnv !== null) signals.push("/.dockerenv exists");
  const dockerCgroup = /docker|containerd|lxc|podman/i.test(pid1Cgroup);
  if (dockerCgroup) signals.push("/proc/1/cgroup mentions a container runtime");
  const wsl = /microsoft|wsl/i.test(version);
  if (wsl) signals.push("/proc/version mentions Microsoft/WSL");

  // ORDER MATTERS: a Kubernetes pod is also a container, and a container inside WSL is still a
  // container. Most specific wins, so the label names the thing whose limits actually bind.
  if (hasKubeEnv || kubeCgroup) return { kind: "kubernetes", signals };
  if (dockerEnv !== null || dockerCgroup) return { kind: "docker", signals };
  if (wsl) return { kind: "wsl", signals };
  if (io.platform() === "linux" && pid1Cgroup === "" && version === "") {
    // Linux that will not show us /proc at all — do not call that bare metal, we simply cannot see.
    return { kind: "unknown", signals: ["/proc is unreadable, so no runtime signal was available"] };
  }
  signals.push("no container or WSL signal found");
  return { kind: "bare-metal", signals };
}

/**
 * CPU feature flags that change which llama.cpp kernels run, read from `/proc/cpuinfo`.
 *
 * `null` per flag means "this platform would not say". On Linux the flags line is authoritative;
 * everywhere else we decline to guess — with one exception worth stating: ARMv8-A makes Advanced
 * SIMD (NEON) mandatory, so `neon` is `true` on any arm64 machine as a fact of the architecture,
 * not an inference about the part. `dotprod` is an optional extension and stays unknown.
 */
export function parseCpuFlags(cpuinfo: string | null, arch: string): NativeHardwareSnapshot["cpu"]["instructionSets"] {
  const archNeon = arch === "arm64" ? true : null;
  if (cpuinfo === null) return { avx2: null, avx512: null, neon: archNeon, dotprod: null };

  // x86 uses "flags:", ARM uses "Features:" — both are space-separated lowercase tokens.
  const line = cpuinfo.split(/\r?\n/).find((row) => /^(flags|Features)\s*:/i.test(row));
  if (!line) return { avx2: null, avx512: null, neon: archNeon, dotprod: null };
  const flags = new Set(line.split(":").slice(1).join(":").trim().toLowerCase().split(/\s+/));

  const isX86 = arch === "x64" || arch === "ia32";
  return {
    // Only claim false on an architecture where the flag could have appeared. Reporting
    // "avx2: false" for an ARM chip is technically true and completely useless.
    avx2: isX86 ? flags.has("avx2") : null,
    // Any AVX-512 subset implies the base; `avx512f` is the foundation every variant carries.
    avx512: isX86 ? [...flags].some((flag) => flag.startsWith("avx512")) : null,
    neon: isX86 ? null : flags.has("neon") || flags.has("asimd") || archNeon,
    dotprod: isX86 ? null : flags.has("asimddp") || flags.has("dotprod")
  };
}

/**
 * Real cores, not hyperthreads, counted as the number of distinct (physical id, core id) pairs in
 * `/proc/cpuinfo`. `null` when the file is unavailable or does not carry the topology — the
 * estimator has a documented, warned assumption for that case, and inventing a number here would
 * hide it.
 */
export function parsePhysicalCores(cpuinfo: string | null): number | null {
  if (cpuinfo === null) return null;
  const pairs = new Set<string>();
  let physicalId: string | null = null;
  let coreId: string | null = null;
  let sawTopology = false;
  for (const row of cpuinfo.split(/\r?\n/)) {
    const [keyRaw, ...rest] = row.split(":");
    const key = keyRaw.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "physical id") {
      physicalId = value;
      sawTopology = true;
    } else if (key === "core id") {
      coreId = value;
      sawTopology = true;
    } else if (key === "" && physicalId !== null && coreId !== null) {
      // Blank line terminates a processor block.
      pairs.add(`${physicalId}/${coreId}`);
      physicalId = null;
      coreId = null;
    }
  }
  if (physicalId !== null && coreId !== null) pairs.add(`${physicalId}/${coreId}`);
  if (!sawTopology || pairs.size === 0) return null;
  return pairs.size;
}

/**
 * THE MINIMUM OF TWO CEILINGS, either of which may be unknown. Whichever is lower is the one the
 * kernel will actually enforce, and therefore the only one anything downstream may believe — an
 * unknown on one side is not permission to ignore the other.
 */
function lowerCeiling(hostBytes: number | null, limitBytes: number | null): number | null {
  if (hostBytes === null) return limitBytes;
  if (limitBytes === null) return hostBytes;
  return Math.min(hostBytes, limitBytes);
}

/**
 * The full snapshot. Never throws: every constituent probe already degrades to `null`, and the
 * two `os` calls that cannot fail are the only unguarded reads.
 *
 * `modelDirectory` is where a download would land — reported for disk space only. Nothing here
 * writes, creates or even stats a model file.
 */
export async function probeNativeHardware(
  modelDirectory: string = process.cwd(),
  io: HardwareProbeIo = defaultHardwareProbeIo
): Promise<NativeHardwareSnapshot> {
  const cpuinfo = io.platform() === "linux" ? await io.readText("/proc/cpuinfo") : null;

  const [cgroupMemory, cpuQuota, environment, disk] = await Promise.all([
    readCgroupMemory(io),
    readCgroupCpuQuota(io),
    detectRuntimeEnvironment(io),
    io.freeDiskBytes(modelDirectory)
  ]);

  const cpus = io.cpus();
  const logicalCores = cpus.length > 0 ? cpus.length : null;

  const hostTotal = io.totalmem();
  const hostFree = io.freemem();
  const hostTotalBytes = Number.isFinite(hostTotal) && hostTotal > 0 ? hostTotal : null;
  const hostAvailableBytes = Number.isFinite(hostFree) && hostFree >= 0 ? hostFree : null;

  const effectiveTotalBytes = lowerCeiling(hostTotalBytes, cgroupMemory.limitBytes);

  // Inside a limit, "available" is what is left of the limit. `memory.current` counts reclaimable
  // page cache as used, so this runs PESSIMISTIC — which is the safe direction: under-promising
  // memory costs an operator a smaller model, over-promising costs them an OOM kill.
  let effectiveAvailableBytes = hostAvailableBytes;
  if (cgroupMemory.limitBytes !== null) {
    const withinLimit = Math.max(0, cgroupMemory.limitBytes - (cgroupMemory.usageBytes ?? 0));
    effectiveAvailableBytes = hostAvailableBytes === null ? withinLimit : Math.min(hostAvailableBytes, withinLimit);
  }

  return {
    sampledAt: new Date().toISOString(),
    cpu: {
      model: cpus[0]?.model?.trim() || null,
      logicalCores,
      physicalCores: parsePhysicalCores(cpuinfo),
      arch: io.arch(),
      instructionSets: parseCpuFlags(cpuinfo, io.arch()),
      quotaCores: cpuQuota.quotaCores,
      quotaSource: cpuQuota.source
    },
    memory: {
      hostTotalBytes,
      hostAvailableBytes,
      cgroupLimitBytes: cgroupMemory.limitBytes,
      cgroupUsageBytes: cgroupMemory.usageBytes,
      cgroupSource: cgroupMemory.source,
      effectiveTotalBytes,
      effectiveAvailableBytes
    },
    environment,
    disk: disk === null ? { path: modelDirectory, freeBytes: null, totalBytes: null } : { path: modelDirectory, ...disk }
  };
}

/**
 * The read-only report behind the capability endpoint: probe the machine once, then estimate every
 * catalogue entry against it.
 *
 * WHY EVERY ENTRY AND NOT JUST THE DEFAULT: the operator's question is not "does the default fit"
 * but "what are my options and why is this one greyed out". Estimating all six costs arithmetic on
 * numbers already in memory, and it is what lets the picker sort by verdict.
 */
export async function describeNativeCapability(
  modelDirectory: string = process.cwd(),
  kvCacheType: NativeKvCacheType = "f16",
  io: HardwareProbeIo = defaultHardwareProbeIo
): Promise<NativeCapabilityReport> {
  const hardware = await probeNativeHardware(modelDirectory, io);
  const models = nativeModelCatalogue.map((entry) => ({
    modelId: entry.id,
    estimate: estimateNativeModelFit(hardware, entry, entry.recommendedContextTokens, kvCacheType)
  }));

  // The best thing that actually fits, preferring the curated default when it does. "Comfortable"
  // only — suggesting a `tight` model as the headline recommendation is how an operator ends up
  // with a box that works until the first Monday morning.
  const comfortable = models.filter((row) => row.estimate.verdict === "comfortable");
  const curatedDefault = comfortable.find((row) => row.modelId === nativeModelCatalogue.find((entry) => entry.recommendedDefault)?.id);
  const suggestedModelId = curatedDefault?.modelId ?? comfortable.at(-1)?.modelId ?? null;

  return { hardware, models, suggestedModelId };
}
