/**
 * WHAT: the reading half of request observability — everything the Maintenance page's "API
 * performance" panel shows, aggregated in SQL. (Collection: services/api-telemetry.service.ts and
 * middleware/request-telemetry.ts.)
 *
 * EVERYTHING HERE AGGREGATES IN THE DATABASE, and that is not a style preference. A busy workspace
 * accumulates millions of `ApiRequestSample` rows between prunes; shipping them to Node to compute
 * a p95 would move megabytes per poll, and shipping them to the BROWSER to draw a chart would move
 * them twice. The only endpoint that returns individual rows is the drill-down, which is capped and
 * exists precisely so an admin can look at named requests after the aggregates have pointed at one.
 *
 * WHY PERCENTILES AND NOT AVERAGES. An average latency is the one number that reliably hides the
 * problem: a handful of eight-second responses vanish into a 120ms mean, and the eight-second
 * responses are the entire reason somebody opened this page. p50 says what the typical user feels,
 * p95/p99 say what the unlucky ones do, and the gap between them is the finding.
 *
 * WHY RAW SQL RATHER THAN groupBy. Prisma's `groupBy` has no percentile aggregate, and MySQL 8 has
 * no `PERCENTILE_CONT`. The window-function pattern below — rank within the partition, then take
 * the largest value at or under the target rank — is the standard way to get an exact percentile
 * out of MySQL 8 in one pass. (MySQL 8 is already this project's floor; see docs/DEPLOYMENT.md.)
 *
 * WHO CALLS THIS: controllers/maintenance.controller.ts, SUPER_ADMIN-gated like every other admin
 * surface in that router.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { apiTelemetryStatus } from "./api-telemetry.service.js";

/** MySQL hands back BIGINT as bigint and SUM/AVG as Decimal; both need coercing before they can be
 *  serialised to JSON at all (`JSON.stringify` throws on bigint). One helper so no call site can
 *  forget and produce a 500 from a reporting endpoint. */
function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  return Number(value);
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Window clamped to a year: beyond that the rows have been pruned anyway, and the request is
 *  almost always a fat-fingered parameter rather than an intent. */
export function clampHours(hours: number): number {
  return Math.min(24 * 365, Math.max(1, Math.round(hours) || 24));
}

/**
 * Bucket width for the time series, chosen from the window so the chart always carries roughly
 * 50–150 points. A fixed width either produces a 10,000-point line for a 90-day window (unreadable
 * and slow to serialise) or six points for an hour (a chart that hides the spike it was opened to
 * find).
 */
export function bucketSecondsFor(hours: number): number {
  if (hours <= 3) return 60;
  if (hours <= 12) return 300;
  if (hours <= 48) return 900;
  if (hours <= 24 * 14) return 3_600;
  return 21_600;
}

export interface LatencyPoint {
  bucketStart: string;
  total: number;
  clientErrors: number;
  serverErrors: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  avgDbMs: number | null;
}

export interface EndpointRow {
  apiName: string;
  method: string;
  apiPath: string;
  total: number;
  clientErrors: number;
  serverErrors: number;
  errorRate: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  avgDbMs: number | null;
  /** Share of the window's TOTAL time spent in this endpoint. The honest way to rank work: a 40ms
   *  endpoint called 100,000 times costs the server more than a 4-second one called twice, and a
   *  table sorted by p95 alone would never show it. */
  totalMs: number;
}

export interface HostRow {
  hostname: string;
  podName: string | null;
  cluster: string | null;
  osType: string;
  total: number;
  serverErrors: number;
  avgMs: number;
  p95Ms: number;
  avgCpuPercent: number | null;
  avgMemPercent: number | null;
  avgDiskPercent: number | null;
  lastSeenAt: string;
}

/**
 * SQL fragment computing exact percentiles for a partition.
 *
 * `ROW_NUMBER()` ranks each row's latency within its group and `COUNT(*) OVER` gives the group
 * size; the outer `MAX(CASE WHEN rn <= CEIL(cnt * q) …)` then picks the largest value at or below
 * the quantile's rank — the nearest-rank definition, which needs no interpolation and cannot
 * invent a latency nobody experienced.
 */
function percentileExpr(quantile: number, alias: string): Prisma.Sql {
  return Prisma.sql`MAX(CASE WHEN rn <= CEIL(cnt * ${quantile}) THEN apiResponseTime END) AS ${Prisma.raw(alias)}`;
}

export async function getLatencySeries(since: Date, bucketSeconds: number): Promise<LatencyPoint[]> {
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT
      bucketStart,
      COUNT(*) AS total,
      SUM(isClientError) AS clientErrors,
      SUM(isServerError) AS serverErrors,
      ROUND(AVG(apiResponseTime)) AS avgMs,
      ${percentileExpr(0.5, "p50Ms")},
      ${percentileExpr(0.95, "p95Ms")},
      ${percentileExpr(0.99, "p99Ms")},
      ROUND(AVG(dbResponseTime)) AS avgDbMs
    FROM (
      SELECT
        apiResponseTime,
        dbResponseTime,
        FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(createdAt) / ${bucketSeconds}) * ${bucketSeconds}) AS bucketStart,
        (statusCode >= 400 AND statusCode < 500) AS isClientError,
        (statusCode >= 500) AS isServerError,
        ROW_NUMBER() OVER (
          PARTITION BY FLOOR(UNIX_TIMESTAMP(createdAt) / ${bucketSeconds}) ORDER BY apiResponseTime
        ) AS rn,
        COUNT(*) OVER (PARTITION BY FLOOR(UNIX_TIMESTAMP(createdAt) / ${bucketSeconds})) AS cnt
      FROM ApiRequestSample
      WHERE createdAt >= ${since}
    ) bucketed
    GROUP BY bucketStart
    ORDER BY bucketStart
  `);

  return rows.map((row) => ({
    bucketStart: new Date(row.bucketStart as string).toISOString(),
    total: num(row.total),
    clientErrors: num(row.clientErrors),
    serverErrors: num(row.serverErrors),
    avgMs: num(row.avgMs),
    p50Ms: num(row.p50Ms),
    p95Ms: num(row.p95Ms),
    p99Ms: num(row.p99Ms),
    avgDbMs: numOrNull(row.avgDbMs)
  }));
}

export async function getEndpointBreakdown(since: Date, limit: number): Promise<EndpointRow[]> {
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT
      method,
      apiPath,
      COUNT(*) AS total,
      SUM(isClientError) AS clientErrors,
      SUM(isServerError) AS serverErrors,
      ROUND(AVG(apiResponseTime)) AS avgMs,
      MAX(apiResponseTime) AS maxMs,
      SUM(apiResponseTime) AS totalMs,
      ${percentileExpr(0.5, "p50Ms")},
      ${percentileExpr(0.95, "p95Ms")},
      ${percentileExpr(0.99, "p99Ms")},
      ROUND(AVG(dbResponseTime)) AS avgDbMs
    FROM (
      SELECT
        method,
        apiPath,
        apiResponseTime,
        dbResponseTime,
        (statusCode >= 400 AND statusCode < 500) AS isClientError,
        (statusCode >= 500) AS isServerError,
        ROW_NUMBER() OVER (PARTITION BY method, apiPath ORDER BY apiResponseTime) AS rn,
        COUNT(*) OVER (PARTITION BY method, apiPath) AS cnt
      FROM ApiRequestSample
      WHERE createdAt >= ${since}
    ) ranked
    GROUP BY method, apiPath
    ORDER BY p95Ms DESC
    LIMIT ${limit}
  `);

  return rows.map((row) => {
    const total = num(row.total);
    const clientErrors = num(row.clientErrors);
    const serverErrors = num(row.serverErrors);
    return {
      apiName: `${String(row.method)} ${String(row.apiPath)}`,
      method: String(row.method),
      apiPath: String(row.apiPath),
      total,
      clientErrors,
      serverErrors,
      errorRate: total === 0 ? 0 : Number((((clientErrors + serverErrors) / total) * 100).toFixed(2)),
      avgMs: num(row.avgMs),
      p50Ms: num(row.p50Ms),
      p95Ms: num(row.p95Ms),
      p99Ms: num(row.p99Ms),
      maxMs: num(row.maxMs),
      avgDbMs: numOrNull(row.avgDbMs),
      totalMs: num(row.totalMs)
    };
  });
}

export async function getHostBreakdown(since: Date): Promise<HostRow[]> {
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT
      hostname,
      podName,
      cluster,
      MAX(osType) AS osType,
      COUNT(*) AS total,
      SUM(isServerError) AS serverErrors,
      ROUND(AVG(apiResponseTime)) AS avgMs,
      ${percentileExpr(0.95, "p95Ms")},
      ROUND(AVG(cpuPercent), 1) AS avgCpuPercent,
      ROUND(AVG(memUsedPercent), 1) AS avgMemPercent,
      ROUND(AVG(diskUsedPercent), 1) AS avgDiskPercent,
      MAX(createdAt) AS lastSeenAt
    FROM (
      SELECT
        hostname, podName, cluster, osType, apiResponseTime, cpuPercent, memUsedPercent,
        diskUsedPercent, createdAt,
        (statusCode >= 500) AS isServerError,
        ROW_NUMBER() OVER (PARTITION BY hostname, podName ORDER BY apiResponseTime) AS rn,
        COUNT(*) OVER (PARTITION BY hostname, podName) AS cnt
      FROM ApiRequestSample
      WHERE createdAt >= ${since}
    ) ranked
    GROUP BY hostname, podName, cluster
    ORDER BY total DESC
    LIMIT 50
  `);

  return rows.map((row) => ({
    hostname: String(row.hostname),
    podName: row.podName === null ? null : String(row.podName),
    cluster: row.cluster === null ? null : String(row.cluster),
    osType: String(row.osType ?? ""),
    total: num(row.total),
    serverErrors: num(row.serverErrors),
    avgMs: num(row.avgMs),
    p95Ms: num(row.p95Ms),
    avgCpuPercent: numOrNull(row.avgCpuPercent),
    avgMemPercent: numOrNull(row.avgMemPercent),
    avgDiskPercent: numOrNull(row.avgDiskPercent),
    lastSeenAt: new Date(row.lastSeenAt as string).toISOString()
  }));
}

/**
 * The headline figures. Deliberately computed over the same window as everything else so no two
 * numbers on the panel can disagree about what "the last 24 hours" means.
 */
async function getTotals(since: Date) {
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT
      COUNT(*) AS total,
      SUM(isClientError) AS clientErrors,
      SUM(isServerError) AS serverErrors,
      ROUND(AVG(apiResponseTime)) AS avgMs,
      MAX(apiResponseTime) AS maxMs,
      ROUND(AVG(dbResponseTime)) AS avgDbMs,
      COUNT(DISTINCT userId) AS distinctUsers,
      COUNT(DISTINCT CONCAT(hostname, '|', COALESCE(podName, ''))) AS distinctHosts,
      ${percentileExpr(0.5, "p50Ms")},
      ${percentileExpr(0.95, "p95Ms")},
      ${percentileExpr(0.99, "p99Ms")}
    FROM (
      SELECT
        apiResponseTime, dbResponseTime, userId, hostname, podName,
        (statusCode >= 400 AND statusCode < 500) AS isClientError,
        (statusCode >= 500) AS isServerError,
        ROW_NUMBER() OVER (ORDER BY apiResponseTime) AS rn,
        COUNT(*) OVER () AS cnt
      FROM ApiRequestSample
      WHERE createdAt >= ${since}
    ) ranked
  `);

  const row = rows[0] ?? {};
  const total = num(row.total);
  const clientErrors = num(row.clientErrors);
  const serverErrors = num(row.serverErrors);
  return {
    total,
    clientErrors,
    serverErrors,
    errorRate: total === 0 ? 0 : Number((((clientErrors + serverErrors) / total) * 100).toFixed(2)),
    avgMs: num(row.avgMs),
    p50Ms: num(row.p50Ms),
    p95Ms: num(row.p95Ms),
    p99Ms: num(row.p99Ms),
    maxMs: num(row.maxMs),
    avgDbMs: numOrNull(row.avgDbMs),
    distinctUsers: num(row.distinctUsers),
    distinctHosts: num(row.distinctHosts)
  };
}

/** Status-class mix. Grouped into classes rather than exact codes: the decision an admin makes is
 *  the same for a 401 and a 403 ("clients are being refused") and different for a 502. */
async function getStatusMix(since: Date) {
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT FLOOR(statusCode / 100) AS class, COUNT(*) AS total
    FROM ApiRequestSample
    WHERE createdAt >= ${since}
    GROUP BY FLOOR(statusCode / 100)
    ORDER BY class
  `);
  return rows.map((row) => ({ statusClass: `${num(row.class)}xx`, total: num(row.total) }));
}

export async function getApiPerformanceOverview(hours: number) {
  const windowHours = clampHours(hours);
  const since = new Date(Date.now() - windowHours * 3_600_000);
  const bucketSeconds = bucketSecondsFor(windowHours);

  // One round of independent aggregates, run together rather than in sequence — five sequential
  // scans of the same table is five times the latency for a panel that is polled.
  const [totals, series, endpoints, hosts, statusMix] = await Promise.all([
    getTotals(since),
    getLatencySeries(since, bucketSeconds),
    getEndpointBreakdown(since, 25),
    getHostBreakdown(since),
    getStatusMix(since)
  ]);

  return {
    window: { hours: windowHours, since: since.toISOString(), bucketSeconds },
    collection: apiTelemetryStatus(),
    totals,
    series,
    endpoints,
    hosts,
    statusMix
  };
}

export interface RequestFilter {
  hours: number;
  path?: string;
  method?: string;
  hostname?: string;
  minMs?: number;
  statusClass?: number;
  sort: "slowest" | "recent";
  limit: number;
  /** Rows to skip. Paging exists because "top 50 of 23,783" with no total is indistinguishable
   *  from "these are all of them" — which is the wrong thing for somebody to conclude while
   *  looking for a slow endpoint. */
  offset?: number;
}

/**
 * The drill-down: individual requests, after the aggregates above have identified something worth
 * looking at. The ONLY endpoint that returns rows rather than aggregates, and it is capped at
 * `limit` (itself clamped by the controller) for that reason.
 *
 * User names are joined in HERE, at read time, rather than denormalised onto the sample. That keeps
 * names and emails out of the telemetry table entirely, and means a deleted user disappears from
 * this view rather than living on in a fortnight of rows.
 */
export async function listApiRequests(filter: RequestFilter) {
  const since = new Date(Date.now() - clampHours(filter.hours) * 3_600_000);

  const where: Prisma.ApiRequestSampleWhereInput = { createdAt: { gte: since } };
  if (filter.path) where.apiPath = { contains: filter.path };
  if (filter.method) where.method = filter.method;
  if (filter.hostname) where.hostname = filter.hostname;
  if (filter.minMs !== undefined) where.apiResponseTime = { gte: filter.minMs };
  if (filter.statusClass !== undefined) {
    where.statusCode = { gte: filter.statusClass * 100, lt: (filter.statusClass + 1) * 100 };
  }

  // Counted alongside the page, not derived from it. The count is what turns a page into a
  // position — without it the last page and a full page look the same.
  const total = await prisma.apiRequestSample.count({ where });

  const rows = await prisma.apiRequestSample.findMany({
    where,
    orderBy: filter.sort === "slowest" ? { apiResponseTime: "desc" } : { createdAt: "desc" },
    take: filter.limit,
    skip: filter.offset ?? 0,
    select: {
      id: true,
      apiName: true,
      method: true,
      apiPath: true,
      statusCode: true,
      userId: true,
      apiRequestAt: true,
      apiResponseAt: true,
      apiResponseTime: true,
      dbResponseTime: true,
      dbQueryCount: true,
      hostname: true,
      podName: true,
      cluster: true,
      osType: true,
      cpuPercent: true,
      memUsedPercent: true,
      diskUsedPercent: true,
      eventLoopLagMs: true
    }
  });

  const userIds = [...new Set(rows.map((row) => row.userId).filter((id): id is string => Boolean(id)))];
  const users = userIds.length
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } })
    : [];
  const userById = new Map(users.map((user) => [user.id, user]));

  return {
    since: since.toISOString(),
    total,
    limit: filter.limit,
    offset: filter.offset ?? 0,
    rows: rows.map((row) => ({
      ...row,
      apiRequestAt: row.apiRequestAt.toISOString(),
      apiResponseAt: row.apiResponseAt.toISOString(),
      // Null user = an unauthenticated request (a login, a public status poll), which is a real
      // and meaningful answer — not a lookup that failed.
      user: row.userId ? (userById.get(row.userId) ?? { id: row.userId, name: "Deleted user", email: "" }) : null
    }))
  };
}
