/**
 * WHAT: the live server-health snapshot behind `GET /api/maintenance/health` — CPU, memory,
 * disk, network/latency, and a component checklist (API, tenant DB, control-plane DB, mail).
 * WHY it lives next to maintenance mode: the person staring at this panel is the SUPER_ADMIN
 * deciding "is it safe to start/end the maintenance window?" — the same page that schedules it.
 * HONESTY RULES, because a health panel that guesses is worse than none:
 * - Everything reported is measured on THE API INSTANCE THAT ANSWERED THIS REQUEST. Behind a
 *   load balancer / K8s replica set, that's one replica's view, and the payload says so
 *   (hostname + pid) rather than pretending to be a cluster-wide aggregate.
 * - CPU usage is a real two-sample delta over os.cpus() counters, not an instantaneous guess.
 *   `loadAvg` is null on Windows (the OS reports zeros there, so showing them would be a lie).
 * - Disk is fs.statfs on the working directory's volume — the volume the app (and its uploads)
 *   actually writes to; other mounts are out of scope on purpose.
 * - "Network" is measured round-trips (tenant + control-plane DB pings) plus event-loop lag —
 *   the latencies that actually degrade this app — not NIC byte counters Node can't read
 *   portably. Interface addresses are listed for identification, nothing more.
 * - A component check that throws reports `ok: false` with the error; the endpoint itself never
 *   throws. A health check that 500s when things are unhealthy is a self-defeating design.
 * WHO calls this: `controllers/maintenance.controller.ts` (SUPER_ADMIN-gated), polled ~10s by
 * the Server health card in the Maintenance settings tab.
 */
import os from "node:os";
import { statfs } from "node:fs/promises";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { prisma } from "../config/prisma.js";
import { controlPrisma } from "../config/control-prisma.js";
import { appVersion } from "../config/version.js";
import { getTransportStatus } from "./mail.service.js";

/** Started once at module load so the histogram is already warm when the first poll arrives.
 *  Reset after every read — each poll reports the lag SINCE the previous poll, not since boot
 *  (a startup spike would otherwise haunt the max forever). */
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();

function readCpuTimes(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idle, total };
}

/** Busy% across all cores over a real sampling window. Two snapshots of the kernel's cumulative
 *  per-core counters — the only way os.cpus() yields a rate rather than an average-since-boot. */
async function sampleCpuPercent(sampleMs = 250): Promise<number | null> {
  const before = readCpuTimes();
  await new Promise((resolve) => setTimeout(resolve, sampleMs));
  const after = readCpuTimes();
  const total = after.total - before.total;
  const idle = after.idle - before.idle;
  if (total <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((1 - idle / total) * 1000) / 10));
}

async function measureDbPing(run: () => Promise<unknown>): Promise<{ ok: boolean; ms: number | null; error: string | null }> {
  const startedAt = performance.now();
  try {
    await run();
    return { ok: true, ms: Math.round((performance.now() - startedAt) * 10) / 10, error: null };
  } catch (error) {
    return { ok: false, ms: null, error: (error as Error).message };
  }
}

export interface SystemHealthSnapshot {
  sampledAt: string;
  server: {
    hostname: string;
    pid: number;
    platform: string;
    arch: string;
    nodeVersion: string;
    appVersion: string;
    /** OS uptime — how long the machine has been up. */
    osUptimeSec: number;
    /** This API process's uptime — resets on every deploy/restart, which is the point. */
    processUptimeSec: number;
  };
  cpu: {
    cores: number;
    model: string;
    usagePercent: number | null;
    /** 1/5/15-min load averages; null on Windows where the OS doesn't provide them. */
    loadAvg: [number, number, number] | null;
  };
  memory: {
    totalBytes: number;
    freeBytes: number;
    usedPercent: number;
    /** Resident set of THIS Node process — how much of the box the API itself is using. */
    processRssBytes: number;
  };
  disk: {
    path: string;
    totalBytes: number;
    freeBytes: number;
    usedPercent: number;
  } | null;
  network: {
    /** Non-internal addresses, for identifying which box/replica answered. */
    interfaces: Array<{ name: string; address: string; family: string }>;
    tenantDbPingMs: number | null;
    controlDbPingMs: number | null;
    eventLoopLagMeanMs: number;
    eventLoopLagMaxMs: number;
  };
  /** The "cluster health" checklist — each dependency this instance needs, individually probed. */
  components: Array<{ name: string; ok: boolean; detail: string }>;
}

export async function getSystemHealth(): Promise<SystemHealthSnapshot> {
  // Independent probes run concurrently — the CPU sample's 250ms window doubles as the wait.
  const [cpuPercent, tenantPing, controlPing, diskInfo, mailStatus] = await Promise.all([
    sampleCpuPercent(),
    measureDbPing(() => prisma.$queryRaw`SELECT 1`),
    measureDbPing(() => controlPrisma.$queryRaw`SELECT 1`),
    statfs(process.cwd()).catch(() => null),
    getTransportStatus().catch(() => null)
  ]);

  const totalMem = os.totalmem();
  const freeMem = os.freemem();

  const loopMeanMs = Math.round((loopDelay.mean / 1e6) * 10) / 10;
  const loopMaxMs = Math.round((loopDelay.max / 1e6) * 10) / 10;
  loopDelay.reset();

  const interfaces: SystemHealthSnapshot["network"]["interfaces"] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (!addr.internal && addr.family === "IPv4") interfaces.push({ name, address: addr.address, family: addr.family });
    }
  }

  const components: SystemHealthSnapshot["components"] = [
    { name: "API server", ok: true, detail: `up ${Math.floor(process.uptime() / 60)} min, v${appVersion.version}` },
    {
      name: "Tenant database",
      ok: tenantPing.ok,
      detail: tenantPing.ok ? `ping ${tenantPing.ms} ms` : tenantPing.error ?? "unreachable"
    },
    {
      name: "Control-plane database",
      ok: controlPing.ok,
      detail: controlPing.ok ? `ping ${controlPing.ms} ms` : controlPing.error ?? "unreachable"
    },
    mailStatus
      ? {
          name: "Mail transport",
          // verified === null means "not yet attempted", which is not a failure.
          ok: mailStatus.configured && mailStatus.verified !== false,
          detail: !mailStatus.configured
            ? "not configured"
            : mailStatus.verified === false
              ? mailStatus.verifyError ?? "verification failed"
              : `${mailStatus.host}:${mailStatus.port}`
        }
      : { name: "Mail transport", ok: false, detail: "status check failed" }
  ];

  return {
    sampledAt: new Date().toISOString(),
    server: {
      hostname: os.hostname(),
      pid: process.pid,
      platform: `${os.platform()} ${os.release()}`,
      arch: os.arch(),
      nodeVersion: process.version,
      appVersion: appVersion.version,
      osUptimeSec: Math.floor(os.uptime()),
      processUptimeSec: Math.floor(process.uptime())
    },
    cpu: {
      cores: os.cpus().length,
      model: os.cpus()[0]?.model?.trim() ?? "unknown",
      usagePercent: cpuPercent,
      loadAvg: os.platform() === "win32" ? null : (os.loadavg() as [number, number, number])
    },
    memory: {
      totalBytes: totalMem,
      freeBytes: freeMem,
      usedPercent: Math.round(((totalMem - freeMem) / totalMem) * 1000) / 10,
      processRssBytes: process.memoryUsage().rss
    },
    disk: diskInfo
      ? {
          path: process.cwd(),
          totalBytes: Number(diskInfo.blocks) * Number(diskInfo.bsize),
          freeBytes: Number(diskInfo.bavail) * Number(diskInfo.bsize),
          usedPercent:
            Number(diskInfo.blocks) > 0
              ? Math.round(((Number(diskInfo.blocks) - Number(diskInfo.bavail)) / Number(diskInfo.blocks)) * 1000) / 10
              : 0
        }
      : null,
    network: {
      interfaces,
      tenantDbPingMs: tenantPing.ms,
      controlDbPingMs: controlPing.ms,
      eventLoopLagMeanMs: loopMeanMs,
      eventLoopLagMaxMs: loopMaxMs
    },
    components
  };
}
