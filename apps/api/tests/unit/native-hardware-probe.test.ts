/**
 * THE HARDWARE PROBE — every way a machine can decline to answer, and the one number it must never
 * get wrong.
 *
 * The probe reads `/proc` and `/sys/fs/cgroup`, neither of which exists on Windows or macOS and
 * either of which a hardened container can make unreadable. So the contract has two halves and both
 * are pinned here:
 *
 *   NOTHING THROWS. An absent, empty, truncated or garbage file yields `null` for that ONE field.
 *   The snapshot still comes back whole, because a settings page that 500s because /proc/cpuinfo
 *   was unreadable has turned a missing detail into an outage.
 *
 *   `null` IS NOT ZERO AND IT IS NOT FALSE. "We could not read the CPU flags" and "this CPU has no
 *   AVX2" are different facts that lead to different decisions — the first makes the speed estimate
 *   deliberately pessimistic and raises a warning, the second is just a slow machine. Reporting the
 *   first as the second is the confident-wrong-answer this whole block was written to avoid.
 *
 * AND THE SENTINEL. cgroup v1 writes "no limit" as PAGE_COUNTER_MAX — 9223372036854771712 on a
 * 4 KiB-page box. Read as a number, that is an 8-exabyte memory allowance, every model on earth
 * "fits", and the failure appears as an OOM kill in production rather than as a red test. There is
 * no way to notice this by looking at a passing suite, so it gets its own tests in both layouts.
 *
 * Everything drives the real exported functions through the injectable `HardwareProbeIo`, which is
 * how a Kubernetes pod with a 1 GiB cap can be described on a Windows dev box.
 */
import { describe, expect, it } from "vitest";
import type { CpuInfo } from "node:os";
import {
  cgroupNoLimitThresholdBytes,
  defaultHardwareProbeIo,
  detectRuntimeEnvironment,
  describeNativeCapability,
  parseCpuFlags,
  parsePhysicalCores,
  probeNativeHardware,
  readCgroupCpuQuota,
  readCgroupMemory,
  type HardwareProbeIo
} from "../../src/services/hardware-probe.service.js";

const GIB = 1024 ** 3;

const fakeCpu = (model: string): CpuInfo =>
  ({ model, speed: 2400, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }) as CpuInfo;

/** A machine that answers nothing — the Windows/macOS baseline, and also the hardened-container
 *  one. Every `readText` returns null, exactly as the real io does for an unreadable path. */
function io(overrides: Partial<HardwareProbeIo> & { files?: Record<string, string> } = {}): HardwareProbeIo {
  const files = overrides.files ?? {};
  return {
    readText: async (path) => (path in files ? files[path] : null),
    freeDiskBytes: async () => ({ freeBytes: 100 * GIB, totalBytes: 200 * GIB }),
    platform: () => "linux",
    arch: () => "x64",
    cpus: () => [fakeCpu("Test CPU"), fakeCpu("Test CPU")],
    totalmem: () => 32 * GIB,
    freemem: () => 30 * GIB,
    env: () => ({}),
    ...overrides
  };
}

describe("cgroup memory — the number that decides whether a container survives", () => {
  it("reads a v2 limit", async () => {
    const result = await readCgroupMemory(io({ files: { "/sys/fs/cgroup/memory.max": "1073741824\n", "/sys/fs/cgroup/memory.current": "268435456\n" } }));
    expect(result.limitBytes).toBe(GIB);
    expect(result.usageBytes).toBe(256 * 1024 ** 2);
    expect(result.source).toContain("cgroup v2");
  });

  it("reads a v1 limit when the unified hierarchy is absent", async () => {
    const result = await readCgroupMemory(
      io({
        files: {
          "/sys/fs/cgroup/memory/memory.limit_in_bytes": "2147483648\n",
          "/sys/fs/cgroup/memory/memory.usage_in_bytes": "536870912\n"
        }
      })
    );
    expect(result.limitBytes).toBe(2 * GIB);
    expect(result.source).toContain("cgroup v1");
  });

  it('treats the v2 literal "max" as no limit, not as a value', async () => {
    const result = await readCgroupMemory(io({ files: { "/sys/fs/cgroup/memory.max": "max\n" } }));
    expect(result.limitBytes).toBeNull();
    expect(result.source).toBeNull();
  });

  it("treats the v1 PAGE_COUNTER_MAX sentinel as no limit — NOT as an 8-exabyte allowance", async () => {
    // The exact value a 4 KiB-page x86 kernel writes for "unlimited".
    const result = await readCgroupMemory(io({ files: { "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712\n" } }));
    expect(result.limitBytes).toBeNull();
  });

  it("treats ANY absurd v1 value as a sentinel, because kernels spell it differently by page size", async () => {
    // A 64 KiB-page ARM kernel writes a different number for the same idea. A threshold survives
    // that; an equality check against one hard-coded constant does not.
    const result = await readCgroupMemory(io({ files: { "/sys/fs/cgroup/memory/memory.limit_in_bytes": String(cgroupNoLimitThresholdBytes + 4096) } }));
    expect(result.limitBytes).toBeNull();
  });

  it("degrades to null on garbage, an empty file, or a negative value — never throws", async () => {
    for (const junk of ["", "   ", "not-a-number", "-1", "0"]) {
      const result = await readCgroupMemory(io({ files: { "/sys/fs/cgroup/memory.max": junk, "/sys/fs/cgroup/memory/memory.limit_in_bytes": junk } }));
      expect(result.limitBytes, junk).toBeNull();
    }
  });
});

describe("cgroup CPU quota — a pod with two cores must not be told to run six threads", () => {
  it('reads v2 "quota period" as whole-core equivalents', async () => {
    const result = await readCgroupCpuQuota(io({ files: { "/sys/fs/cgroup/cpu.max": "200000 100000\n" } }));
    expect(result.quotaCores).toBe(2);
  });

  it('treats v2 "max" as no quota', async () => {
    expect((await readCgroupCpuQuota(io({ files: { "/sys/fs/cgroup/cpu.max": "max 100000\n" } }))).quotaCores).toBeNull();
  });

  it("reads the v1 quota/period pair", async () => {
    const result = await readCgroupCpuQuota(
      io({ files: { "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "150000\n", "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000\n" } })
    );
    expect(result.quotaCores).toBe(1.5);
  });

  it("finds the v1 controller at the cpu,cpuacct mount too", async () => {
    const result = await readCgroupCpuQuota(
      io({ files: { "/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_quota_us": "400000\n", "/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_period_us": "100000\n" } })
    );
    expect(result.quotaCores).toBe(4);
  });

  it("treats the v1 -1 quota as no quota", async () => {
    const result = await readCgroupCpuQuota(
      io({ files: { "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "-1\n", "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000\n" } })
    );
    expect(result.quotaCores).toBeNull();
  });

  it("reports nothing on a machine with no cgroup filesystem at all", async () => {
    expect(await readCgroupCpuQuota(io())).toEqual({ quotaCores: null, source: null });
  });
});

describe("runtime environment detection shows its working", () => {
  it("kubernetes wins over docker, and names both signals", async () => {
    const result = await detectRuntimeEnvironment(
      io({ env: () => ({ KUBERNETES_SERVICE_HOST: "10.0.0.1" }), files: { "/.dockerenv": "", "/proc/1/cgroup": "0::/kubepods/besteffort/pod123" } })
    );
    expect(result.kind).toBe("kubernetes");
    expect(result.signals).toContain("KUBERNETES_SERVICE_HOST is set");
    expect(result.signals).toContain("/.dockerenv exists");
  });

  it("docker from /.dockerenv alone", async () => {
    const result = await detectRuntimeEnvironment(io({ files: { "/.dockerenv": "", "/proc/version": "Linux version 6.1" } }));
    expect(result.kind).toBe("docker");
    expect(result.signals).toContain("/.dockerenv exists");
  });

  it("docker from the pid-1 cgroup when /.dockerenv has been removed", async () => {
    const result = await detectRuntimeEnvironment(io({ files: { "/proc/1/cgroup": "0::/system.slice/containerd.service" } }));
    expect(result.kind).toBe("docker");
  });

  it("wsl from /proc/version", async () => {
    const result = await detectRuntimeEnvironment(io({ files: { "/proc/version": "Linux version 5.15.0-microsoft-standard-WSL2" } }));
    expect(result.kind).toBe("wsl");
    expect(result.signals).toContain("/proc/version mentions Microsoft/WSL");
  });

  it("bare metal on a Linux box that reads fine and shows no container signal", async () => {
    const result = await detectRuntimeEnvironment(io({ files: { "/proc/1/cgroup": "0::/init.scope", "/proc/version": "Linux version 6.1.0-generic" } }));
    expect(result.kind).toBe("bare-metal");
  });

  it("Windows is bare metal, not unknown — there is no /proc to be suspicious about", async () => {
    const result = await detectRuntimeEnvironment(io({ platform: () => "win32" }));
    expect(result.kind).toBe("bare-metal");
  });

  it("Linux that will not show us /proc at all is UNKNOWN, not bare metal", async () => {
    // The honest answer. A container that has masked /proc is exactly the case where claiming
    // "bare metal, host RAM is yours" would be most wrong.
    const result = await detectRuntimeEnvironment(io({ platform: () => "linux" }));
    expect(result.kind).toBe("unknown");
    expect(result.signals[0]).toContain("/proc is unreadable");
  });
});

describe("CPU flags — an unknown that says so beats a confident wrong answer", () => {
  it("reads AVX2 and AVX-512 from an x86 flags line", () => {
    const flags = parseCpuFlags("processor\t: 0\nflags\t\t: fpu vme de avx avx2 avx512f avx512dq\n", "x64");
    expect(flags.avx2).toBe(true);
    expect(flags.avx512).toBe(true);
  });

  it("reports false — not null — for an x86 CPU whose flags line genuinely lacks them", () => {
    const flags = parseCpuFlags("flags\t\t: fpu vme de sse4_2\n", "x64");
    expect(flags.avx2).toBe(false);
    expect(flags.avx512).toBe(false);
  });

  it("reports null on a platform that would not tell us, rather than guessing either way", () => {
    // The Windows/macOS case: no /proc/cpuinfo at all.
    expect(parseCpuFlags(null, "x64")).toEqual({ avx2: null, avx512: null, neon: null, dotprod: null });
  });

  it("reads NEON and dotprod from an ARM Features line", () => {
    const flags = parseCpuFlags("Features\t: fp asimd evtstrm aes asimddp\nCPU architecture: 8\n", "arm64");
    expect(flags.neon).toBe(true);
    expect(flags.dotprod).toBe(true);
    // Reporting "no AVX2" on an ARM chip is true and useless — null is the honest answer.
    expect(flags.avx2).toBeNull();
  });

  it("knows NEON is mandatory on ARMv8 even with no cpuinfo to read", () => {
    expect(parseCpuFlags(null, "arm64").neon).toBe(true);
    // dotprod is an optional extension, so it stays unknown.
    expect(parseCpuFlags(null, "arm64").dotprod).toBeNull();
  });

  it("survives a cpuinfo with no flags line at all", () => {
    expect(parseCpuFlags("processor\t: 0\nmodel name\t: Something\n", "x64").avx2).toBeNull();
  });
});

describe("physical cores — os.cpus() counts hyperthreads, and that is double the useful answer", () => {
  const hyperthreaded = [
    "processor\t: 0\nphysical id\t: 0\ncore id\t\t: 0\n",
    "processor\t: 1\nphysical id\t: 0\ncore id\t\t: 1\n",
    "processor\t: 2\nphysical id\t: 0\ncore id\t\t: 0\n",
    "processor\t: 3\nphysical id\t: 0\ncore id\t\t: 1\n"
  ].join("\n");

  it("counts distinct (physical id, core id) pairs — four logical CPUs, two real cores", () => {
    expect(parsePhysicalCores(hyperthreaded)).toBe(2);
  });

  it("counts sockets separately", () => {
    const dual = ["processor\t: 0\nphysical id\t: 0\ncore id\t\t: 0\n", "processor\t: 1\nphysical id\t: 1\ncore id\t\t: 0\n"].join("\n");
    expect(parsePhysicalCores(dual)).toBe(2);
  });

  it("returns null when the topology is absent, rather than assuming", () => {
    // Many ARM and virtualised /proc/cpuinfo files carry no physical/core id at all.
    expect(parsePhysicalCores("processor\t: 0\nBogoMIPS\t: 48.00\n")).toBeNull();
    expect(parsePhysicalCores(null)).toBeNull();
  });
});

describe("the whole snapshot", () => {
  it("takes the MINIMUM of the host total and the cgroup limit", async () => {
    const snapshot = await probeNativeHardware(
      "/data",
      io({
        totalmem: () => 32 * GIB,
        freemem: () => 30 * GIB,
        files: { "/sys/fs/cgroup/memory.max": String(GIB), "/sys/fs/cgroup/memory.current": String(256 * 1024 ** 2), "/.dockerenv": "" }
      })
    );

    expect(snapshot.memory.hostTotalBytes).toBe(32 * GIB);
    expect(snapshot.memory.cgroupLimitBytes).toBe(GIB);
    expect(snapshot.memory.effectiveTotalBytes).toBe(GIB);
    // 1 GiB limit minus 256 MiB already used — never the host's 30 GiB free.
    expect(snapshot.memory.effectiveAvailableBytes).toBe(GIB - 256 * 1024 ** 2);
    expect(snapshot.environment.kind).toBe("docker");
  });

  it("falls back to the host figures when there is no limit", async () => {
    const snapshot = await probeNativeHardware("/data", io({ files: { "/sys/fs/cgroup/memory.max": "max" } }));
    expect(snapshot.memory.cgroupLimitBytes).toBeNull();
    expect(snapshot.memory.effectiveTotalBytes).toBe(32 * GIB);
    expect(snapshot.memory.effectiveAvailableBytes).toBe(30 * GIB);
  });

  it("returns a complete snapshot of nulls, and does NOT throw, when nothing is readable", async () => {
    const snapshot = await probeNativeHardware("/data", io({ platform: () => "win32", freeDiskBytes: async () => null }));

    expect(snapshot.cpu.physicalCores).toBeNull();
    expect(snapshot.cpu.instructionSets.avx2).toBeNull();
    expect(snapshot.cpu.quotaCores).toBeNull();
    expect(snapshot.memory.cgroupLimitBytes).toBeNull();
    expect(snapshot.disk).toEqual({ path: "/data", freeBytes: null, totalBytes: null });
    // The parts that CAN be known are still there.
    expect(snapshot.cpu.logicalCores).toBe(2);
    expect(snapshot.memory.hostTotalBytes).toBe(32 * GIB);
    expect(snapshot.sampledAt).toBeTruthy();
  });

  it("the real io returns null for an unreadable path instead of rejecting", async () => {
    // The contract every probe above depends on, checked against the real filesystem rather than
    // the fake: this is the seam where a thrown ENOENT would become a 500.
    await expect(defaultHardwareProbeIo.readText("/definitely/not/a/real/path/for/this/test")).resolves.toBeNull();
    await expect(defaultHardwareProbeIo.freeDiskBytes("/definitely/not/a/real/path/for/this/test")).resolves.toBeNull();
  });
});

describe("the capability report the endpoint returns", () => {
  it("estimates every catalogue entry and suggests one that is actually comfortable", async () => {
    const report = await describeNativeCapability("/data", "f16", io({ totalmem: () => 32 * GIB, freemem: () => 24 * GIB }));

    expect(report.models.length).toBeGreaterThan(0);
    expect(report.models.every((row) => row.estimate.reason.length > 0)).toBe(true);
    expect(report.suggestedModelId).not.toBeNull();
    const suggested = report.models.find((row) => row.modelId === report.suggestedModelId)!;
    expect(suggested.estimate.verdict).toBe("comfortable");
  });

  it("suggests nothing at all on a box too small for anything in the list, rather than picking a doomed one", async () => {
    const report = await describeNativeCapability(
      "/data",
      "f16",
      io({ totalmem: () => 2 * GIB, freemem: () => GIB, files: { "/sys/fs/cgroup/memory.max": String(GIB) } })
    );
    expect(report.suggestedModelId).toBeNull();
    expect(report.models.every((row) => row.estimate.verdict === "will-not-fit")).toBe(true);
  });

  it("a 1 GiB pod on a 32 GiB node is told the truth", async () => {
    // The whole point of the block, end to end: the host figure is enormous, the cgroup is not,
    // and every verdict comes from the cgroup.
    const report = await describeNativeCapability(
      "/data",
      "f16",
      io({
        totalmem: () => 32 * GIB,
        freemem: () => 31 * GIB,
        env: () => ({ KUBERNETES_SERVICE_HOST: "10.0.0.1" }),
        files: { "/sys/fs/cgroup/memory.max": String(GIB), "/sys/fs/cgroup/memory.current": "0" }
      })
    );

    expect(report.hardware.environment.kind).toBe("kubernetes");
    expect(report.hardware.memory.effectiveTotalBytes).toBe(GIB);
    expect(report.models.every((row) => row.estimate.verdict === "will-not-fit")).toBe(true);
    expect(report.models[0].estimate.reason).toContain("Won't fit");
  });
});
