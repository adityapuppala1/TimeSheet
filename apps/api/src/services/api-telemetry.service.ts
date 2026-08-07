/**
 * WHAT: the collection half of request observability — host identity, a cached machine snapshot,
 * and the in-memory buffer that batches `ApiRequestSample` rows to the database.
 * (The measuring half is middleware/request-telemetry.ts; the reading half is
 * services/api-performance.service.ts.)
 *
 * THE TWO RULES THIS FILE EXISTS TO ENFORCE, both because it runs on every request:
 *
 * 1. NOTHING IN THE REQUEST LIFECYCLE WAITS ON THIS. `enqueue` is synchronous, does no I/O, and
 *    cannot reject. Rows leave in batches on a timer. An awaited INSERT per request would add a
 *    round-trip to every response and make the observability tool the top entry in its own
 *    slowest-endpoints table.
 *
 * 2. THE HOST SNAPSHOT IS SAMPLED ON A TIMER, NEVER PER REQUEST. system-health.service.ts measures
 *    CPU by sleeping 250ms between two readings of the kernel's counters — correct there (a human
 *    is waiting for one health card), catastrophic here. So CPU/memory/disk come from one snapshot
 *    refreshed every REFRESH_MS, and the CPU delta is taken between refreshes with no sleep at all.
 *    Consequence, stated plainly because it bounds what the data can be used for: these columns
 *    describe the machine AROUND the request, to within REFRESH_MS — not during it.
 *
 * WHAT IS DELIBERATELY NOT COLLECTED: request bodies, query strings, headers, cookies, IPs,
 * user-agents, names, emails. `userId` is the whole of the identity recorded, and the drill-down
 * resolves it to a name at READ time against User — so a deleted user disappears from this view
 * without the telemetry table ever having held their details.
 */
import os from "node:os";
import { statfs } from "node:fs/promises";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { PrismaClient } from "@prisma/client";
import { env } from "../config/env.js";

/** Row shape mirroring the model's own columns. Kept structural (not Prisma's generated input
 *  type) so this module has no dependency on a generated client that may not exist yet at the
 *  moment a fresh checkout first typechecks. */
export interface ApiRequestSampleRow {
  apiName: string;
  method: string;
  apiPath: string;
  statusCode: number;
  userId: string | null;
  apiRequestAt: Date;
  apiResponseAt: Date;
  apiResponseTime: number;
  dbResponseTime: number | null;
  dbQueryCount: number | null;
  hostname: string;
  podName: string | null;
  podNamespace: string | null;
  cluster: string | null;
  osType: string;
  cpuPercent: number | null;
  memUsedPercent: number | null;
  diskUsedPercent: number | null;
  eventLoopLagMs: number | null;
}

/* -------------------------------- host identity -------------------------------- */

/**
 * Resolved once at module load: none of it changes while the process lives, and re-reading
 * os.hostname() per request would be a syscall per request for a constant.
 *
 * Off Kubernetes, `podName`/`podNamespace`/`cluster` are NULL rather than filled with the hostname
 * — "this row came from a pod called X" must not be something the code invented. `osType` carries
 * the release string so a fleet running two different base images is visible as two values.
 */
export const hostIdentity = {
  hostname: (os.hostname() || env.HOSTNAME || "unknown").slice(0, 120),
  podName: env.POD_NAME.trim() ? env.POD_NAME.trim().slice(0, 120) : null,
  podNamespace: env.POD_NAMESPACE.trim() ? env.POD_NAMESPACE.trim().slice(0, 120) : null,
  cluster: env.CLUSTER_NAME.trim() ? env.CLUSTER_NAME.trim().slice(0, 120) : null,
  osType: `${os.type()} ${os.release()} (${os.arch()})`.slice(0, 80)
} as const;

/* ------------------------------- machine snapshot ------------------------------- */

interface HostSnapshot {
  cpuPercent: number | null;
  memUsedPercent: number | null;
  diskUsedPercent: number | null;
  eventLoopLagMs: number | null;
}

/** Long enough that the sampling itself is free at any request rate, short enough that a spike
 *  lasting a few seconds still lands on the rows it caused. */
const REFRESH_MS = 15_000;

let snapshot: HostSnapshot = { cpuPercent: null, memUsedPercent: null, diskUsedPercent: null, eventLoopLagMs: null };
let previousCpuTimes: { idle: number; total: number } | null = null;
let loopDelay: ReturnType<typeof monitorEventLoopDelay> | null = null;

function readCpuTimes(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idle, total };
}

async function refreshSnapshot(): Promise<void> {
  // The CPU delta is taken against the PREVIOUS refresh rather than a fresh 250ms sleep — same
  // arithmetic as system-health.service.ts, with the sampling window supplied by the interval
  // itself instead of by blocking. The first refresh after boot therefore has no baseline and
  // reports null, which is honest: nothing has been measured yet.
  const nowTimes = readCpuTimes();
  let cpuPercent: number | null = null;
  if (previousCpuTimes) {
    const total = nowTimes.total - previousCpuTimes.total;
    const idle = nowTimes.idle - previousCpuTimes.idle;
    if (total > 0) cpuPercent = Math.min(100, Math.max(0, Math.round((1 - idle / total) * 1000) / 10));
  }
  previousCpuTimes = nowTimes;

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const memUsedPercent = totalMem > 0 ? Math.round(((totalMem - freeMem) / totalMem) * 1000) / 10 : null;

  const disk = await statfs(process.cwd()).catch(() => null);
  const diskUsedPercent =
    disk && Number(disk.blocks) > 0
      ? Math.round(((Number(disk.blocks) - Number(disk.bavail)) / Number(disk.blocks)) * 1000) / 10
      : null;

  let eventLoopLagMs: number | null = null;
  if (loopDelay) {
    eventLoopLagMs = Math.round((loopDelay.mean / 1e6) * 10) / 10;
    // Reset so each snapshot reports the lag since the previous one; without this a startup spike
    // would sit in the mean forever and every row would inherit it.
    loopDelay.reset();
  }

  snapshot = { cpuPercent, memUsedPercent, diskUsedPercent, eventLoopLagMs };
}

/* ---------------------------------- the buffer ---------------------------------- */

/**
 * A buffered row keeps the tenant's OWN client alongside it.
 *
 * WHY the client and not just the org id: the flush happens on a timer, long outside any tenant
 * context, so the `prisma` proxy is unusable there by design. Re-resolving the org would mean a
 * control-plane read plus a DSN decryption per flush, per tenant, to reach a client that was
 * already in hand when the request ran. Holding the reference also cannot outlive anything
 * meaningful: it is dropped at the next flush, seconds later.
 */
interface BufferedSample {
  orgId: string;
  client: PrismaClient;
  row: ApiRequestSampleRow;
}

const buffer: BufferedSample[] = [];
let flushing = false;
let started = false;

const stats = {
  /** Samples discarded because the buffer was full — surfaced in the UI so a deployment that has
   *  outgrown its flush interval says so rather than quietly under-reporting. */
  dropped: 0,
  /** Rows the database refused. Counted, never thrown: telemetry must not be able to break a
   *  running server, and the most likely cause is simply that the migration has not been applied. */
  failed: 0,
  written: 0
};

export function telemetryEnabled(): boolean {
  return env.API_TELEMETRY_ENABLED;
}

/** Synchronous, non-throwing, no I/O. The only thing the request path ever calls. */
export function enqueueApiRequestSample(orgId: string, client: PrismaClient, row: ApiRequestSampleRow): void {
  if (buffer.length >= env.API_TELEMETRY_MAX_BUFFER) {
    stats.dropped += 1;
    return;
  }
  buffer.push({ orgId, client, row });
}

/**
 * Drains the buffer. Never throws, never runs concurrently with itself (a slow database would
 * otherwise stack flushes until the buffer they are all draining is gone from under them).
 *
 * Rows are grouped by tenant because each goes to a different physical database. A failing tenant
 * costs only its own batch: the loop continues, so one org with a full disk cannot stop another
 * org's telemetry.
 */
export async function flushApiTelemetry(): Promise<{ written: number; failed: number }> {
  if (flushing || buffer.length === 0) return { written: 0, failed: 0 };
  flushing = true;
  let written = 0;
  let failed = 0;

  // try/finally, not a bare assignment at the end: `flushing` is a one-way latch if anything
  // between here and the end throws unexpectedly, and a stuck latch disables telemetry silently
  // for the lifetime of the process — the buffer would fill, then drop every sample forever.
  // Nothing below is *expected* to throw (the per-tenant write is already guarded), which is
  // exactly why the failure would be baffling if it ever did.
  try {
    // Splice first: anything enqueued while the awaits below are in flight belongs to the NEXT
    // batch, and must not be lost by a later `length = 0`.
    const batch = buffer.splice(0, buffer.length);

    const byOrg = new Map<string, { client: PrismaClient; rows: ApiRequestSampleRow[] }>();
    for (const sample of batch) {
      const group = byOrg.get(sample.orgId) ?? { client: sample.client, rows: [] };
      group.rows.push(sample.row);
      byOrg.set(sample.orgId, group);
    }

    for (const [orgId, group] of byOrg) {
      try {
        await group.client.apiRequestSample.createMany({ data: group.rows });
        written += group.rows.length;
      } catch (error) {
        failed += group.rows.length;
        stats.failed += group.rows.length;
        // Warn, do not rethrow. This runs on a timer with no caller to handle it, and an unhandled
        // rejection from a monitoring feature taking the API down would be a self-inflicted outage.
        console.warn(`[api-telemetry] dropped ${group.rows.length} sample(s) for org ${orgId}: ${(error as Error).message}`);
      }
    }

    stats.written += written;
  } finally {
    flushing = false;
  }
  return { written, failed };
}

/**
 * Starts the snapshot refresh and the flush timer. Idempotent, and a no-op when telemetry is off —
 * a deployment that never enables this pays for no timers at all.
 *
 * Both intervals are `unref`'d so they can never be the reason the process refuses to exit.
 */
export function startApiTelemetry(): void {
  if (started || !telemetryEnabled()) return;
  started = true;

  loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
  void refreshSnapshot();
  setInterval(() => void refreshSnapshot(), REFRESH_MS).unref();

  setInterval(() => {
    void flushApiTelemetry();
  }, env.API_TELEMETRY_FLUSH_MS).unref();

  console.info(
    `[api-telemetry] recording ${Math.round(env.API_TELEMETRY_SAMPLE_RATE * 100)}% of requests as ` +
      `${hostIdentity.podName ?? hostIdentity.hostname}, flushing every ${env.API_TELEMETRY_FLUSH_MS}ms.`
  );
}

/** The machine columns for the row being written right now. Returns the cached snapshot — see this
 *  file's header for why it is not measured per request. */
export function currentHostSnapshot(): HostSnapshot {
  return snapshot;
}

/** Collection state for the admin UI, so the panel can explain an empty chart ("recording is off")
 *  instead of leaving an admin to guess. */
export function apiTelemetryStatus() {
  return {
    enabled: telemetryEnabled(),
    sampleRate: env.API_TELEMETRY_SAMPLE_RATE,
    flushMs: env.API_TELEMETRY_FLUSH_MS,
    retentionDays: env.API_TELEMETRY_RETENTION_DAYS,
    maxBuffer: env.API_TELEMETRY_MAX_BUFFER,
    bufferedNow: buffer.length,
    droppedSinceBoot: stats.dropped,
    failedSinceBoot: stats.failed,
    writtenSinceBoot: stats.written,
    host: hostIdentity
  };
}
