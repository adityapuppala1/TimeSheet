/**
 * WHAT: the time dimension of the platform console's database monitoring — an hourly reading of
 * every workspace's database, the trend it makes, and the two maintenance operations an operator
 * can run against one.
 *
 * WHY A SERIES AND NOT A NUMBER. `platform-tenant-health.service.ts` answers "how big is this
 * database, right now". Almost every question an operator actually has is a derivative of that:
 * is it growing, how fast, when does it cross the ceiling the plan implies, and did the index we
 * added on Tuesday change anything. None of those can be answered from one measurement, and a
 * screen that shows only the instantaneous value quietly teaches people not to ask.
 *
 * WHAT IS STORED IS AGGREGATE. Sizes, counts and server counters. No table names, no row contents.
 * The platform console's standing line — the operator can see how much data a customer has, never
 * what it says.
 *
 * THE TWO CONTROLS, AND WHY ONLY TWO.
 *   - ANALYZE recomputes the optimiser's statistics. It is cheap, online, and the honest answer to
 *     "the plan is wrong since the data changed shape". Safe to offer.
 *   - OPTIMIZE rebuilds a table to hand back the space fragmentation is holding. It is the fix for
 *     the one finding an operator cannot otherwise act on — but on InnoDB it is a full table
 *     rebuild that BLOCKS WRITES for its duration, so it is gated behind an active maintenance
 *     window. That gate is not advisory: `runMaintenanceOperation` reads the workspace's own maintenance
 *     row and refuses outside a live window, which is exactly the state the platform's own broadcast
 *     produces. The two features are deliberately wired to each other.
 *   - Nothing else. No arbitrary SQL, no DROP, no KILL, no schema changes. The set of operations is
 *     a closed allowlist in code, not a string the caller supplies, because a console that can run
 *     one statement can run any statement.
 */
import { PrismaClient as ControlPrismaClient } from "../generated/control-client/index.js";
import { controlPrisma } from "../config/control-prisma.js";
import { withOrgTenant } from "../config/with-org-tenant.js";
import { AppError } from "../middleware/error.js";
import { decryptSecret } from "../utils/encryption.js";
import { getDatabaseMetrics } from "./platform-tenant-health.service.js";
import { platformAudit } from "./platform-audit.service.js";

/* ------------------------------------------------------------------------------------------ */
/* Sampling                                                                                    */
/* ------------------------------------------------------------------------------------------ */

/** How long a reading is kept. A year of hourly samples per workspace is ~8,760 rows — small, and
 *  it is what makes "this time last year" answerable during a capacity conversation. */
export const SAMPLE_RETENTION_DAYS = 400;

export interface SampleResult {
  sampled: number;
  failed: Array<{ slug: string; error: string }>;
  prunedRows: number;
}

/**
 * Take one reading of every workspace that has a database.
 *
 * SEQUENTIAL, like every other fleet-wide read in this console: each sample opens a fresh
 * connection, and forty at once against the server the whole platform runs on is a self-inflicted
 * outage. An hourly job has all the time in the world.
 */
export async function sampleAllTenantDatabases(now = new Date()): Promise<SampleResult> {
  const orgs = await controlPrisma.organization.findMany({
    where: { status: { in: ["ACTIVE", "GRACE", "SUSPENDED"] }, database: { isNot: null } },
    select: { id: true, slug: true }
  });

  const failed: SampleResult["failed"] = [];
  let sampled = 0;

  for (const org of orgs) {
    try {
      const metrics = await getDatabaseMetrics(org.id);
      await controlPrisma.tenantDbSample.create({
        data: {
          organizationId: org.id,
          sampledAt: now,
          totalBytes: metrics.schema.totalBytes,
          dataBytes: metrics.schema.dataBytes,
          indexBytes: metrics.schema.indexBytes,
          freeBytes: metrics.schema.freeBytes,
          tableCount: metrics.schema.tableCount,
          estimatedRows: metrics.schema.estimatedRows,
          queryMs: metrics.queryMs,
          connectionUsePercent: metrics.server.connectionUsePercent,
          bufferPoolHitRate: metrics.server.bufferPoolHitRate,
          slowQueries: metrics.server.slowQueries
        }
      });
      sampled += 1;
    } catch (error) {
      // A workspace that cannot be read is recorded and skipped. It must never stop the fleet, and
      // it must never write a zero — a gap in a chart is honest; a false zero is a fake recovery.
      failed.push({ slug: org.slug, error: (error as Error).message.slice(0, 200) });
    }
  }

  const cutoff = new Date(now.getTime() - SAMPLE_RETENTION_DAYS * 86_400_000);
  const pruned = await controlPrisma.tenantDbSample.deleteMany({ where: { sampledAt: { lt: cutoff } } });

  return { sampled, failed, prunedRows: pruned.count };
}

/* ------------------------------------------------------------------------------------------ */
/* The trend                                                                                   */
/* ------------------------------------------------------------------------------------------ */

export interface TrendPoint {
  at: string;
  totalBytes: number;
  dataBytes: number;
  indexBytes: number;
  freeBytes: number;
  estimatedRows: number;
  tableCount: number;
  queryMs: number;
  connectionUsePercent: number | null;
  bufferPoolHitRate: number | null;
}

export interface GrowthSummary {
  /** Bytes added per day, from the first and last sample in the window. */
  bytesPerDay: number | null;
  /** Percent change across the window. Null when there is nothing to compare against. */
  percentChange: number | null;
  rowsPerDay: number | null;
  /** Days until the database reaches `projectionTargetBytes` at the current rate, or null when it
   *  is flat or shrinking — a projection off a negative slope is arithmetic, not information. */
  daysToTarget: number | null;
  projectionTargetBytes: number;
  firstSampleAt: string | null;
  lastSampleAt: string | null;
  samples: number;
}

/** The size a growth projection counts down to. Not a quota — nothing enforces it — but a number
 *  worth being told you are approaching, because 50 GB is where a nightly mysqldump stops being a
 *  reasonable backup strategy and the conversation becomes about snapshots. */
const PROJECTION_TARGET_BYTES = 50 * 1024 ** 3;

export async function getTenantDbTrend(orgId: string, days = 30): Promise<{ points: TrendPoint[]; growth: GrowthSummary }> {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await controlPrisma.tenantDbSample.findMany({
    where: { organizationId: orgId, sampledAt: { gte: since } },
    orderBy: { sampledAt: "asc" }
  });

  const points: TrendPoint[] = rows.map((row) => ({
    at: row.sampledAt.toISOString(),
    totalBytes: row.totalBytes,
    dataBytes: row.dataBytes,
    indexBytes: row.indexBytes,
    freeBytes: row.freeBytes,
    estimatedRows: row.estimatedRows,
    tableCount: row.tableCount,
    queryMs: row.queryMs,
    connectionUsePercent: row.connectionUsePercent,
    bufferPoolHitRate: row.bufferPoolHitRate
  }));

  return { points, growth: summariseGrowth(points) };
}

/**
 * Growth, from the ends of the series.
 *
 * DELIBERATELY NOT A REGRESSION. A least-squares slope over a series with one migration-shaped step
 * in it reports a confident number that describes nothing; first-to-last at least says plainly what
 * it measured. Two samples is the floor, and anything under a day of span refuses to extrapolate —
 * "grew 3 MB in twenty minutes" annualises to a nonsense an operator would have to know to ignore.
 */
export function summariseGrowth(points: TrendPoint[]): GrowthSummary {
  const first = points[0];
  const last = points[points.length - 1];
  const base: GrowthSummary = {
    bytesPerDay: null,
    percentChange: null,
    rowsPerDay: null,
    daysToTarget: null,
    projectionTargetBytes: PROJECTION_TARGET_BYTES,
    firstSampleAt: first?.at ?? null,
    lastSampleAt: last?.at ?? null,
    samples: points.length
  };
  if (!first || !last || points.length < 2) return base;

  const spanDays = (new Date(last.at).getTime() - new Date(first.at).getTime()) / 86_400_000;
  if (spanDays < 1) return base;

  const bytesPerDay = (last.totalBytes - first.totalBytes) / spanDays;
  const rowsPerDay = (last.estimatedRows - first.estimatedRows) / spanDays;
  const percentChange = first.totalBytes > 0 ? ((last.totalBytes - first.totalBytes) / first.totalBytes) * 100 : null;
  const remaining = PROJECTION_TARGET_BYTES - last.totalBytes;

  return {
    ...base,
    bytesPerDay,
    rowsPerDay,
    percentChange,
    // Only project forward, and only while there is somewhere to project to.
    daysToTarget: bytesPerDay > 0 && remaining > 0 ? remaining / bytesPerDay : null
  };
}

/* ------------------------------------------------------------------------------------------ */
/* The two controls                                                                            */
/* ------------------------------------------------------------------------------------------ */

/** The closed set. A caller names an operation; it never supplies SQL. */
export type MaintenanceOperation = "ANALYZE" | "OPTIMIZE";

export interface OperationResult {
  operation: MaintenanceOperation;
  tables: string[];
  ms: number;
  /** What MySQL said, one line per table, so a "Note" or an "OK" is visible rather than assumed. */
  messages: Array<{ table: string; type: string; text: string }>;
  freedBytes: number | null;
}

/** Identifier hygiene: a table name reaches SQL only if it matches a plain identifier AND appears
 *  in the schema we just read. Both, not either — the pattern stops injection, the membership check
 *  stops a valid identifier pointing at somebody else's table. */
const SAFE_IDENTIFIER = /^\w{1,64}$/;

export async function runMaintenanceOperation(input: {
  orgId: string;
  operation: MaintenanceOperation;
  /** Empty means every table in the schema. */
  tables: string[];
  actorLabel: string;
}): Promise<OperationResult> {
  const org = await controlPrisma.organization.findUnique({ where: { id: input.orgId }, include: { database: true } });
  if (!org) throw new AppError(404, "Organization not found");
  if (!org.database) throw new AppError(409, "This workspace has no database registered.");

  const before = await getDatabaseMetrics(input.orgId);
  const known = new Set(before.schema.largestTables.map((table) => table.name));
  // `largestTables` is a top-12 slice, so a request for a small table needs the full list.
  const allTables = await listTableNames(org.database.encryptedDsn, org.database.databaseName);
  for (const name of allTables) known.add(name);

  const targets = input.tables.length ? input.tables : allTables;
  for (const table of targets) {
    if (!SAFE_IDENTIFIER.test(table) || !known.has(table)) {
      throw new AppError(422, `"${table}" is not a table in this workspace's schema.`);
    }
  }
  if (targets.length === 0) throw new AppError(409, "That schema has no tables to work on.");

  /*
   * THE GATE. OPTIMIZE on InnoDB is a full table rebuild that blocks writes for its duration —
   * minutes on a large table, with every request against it hanging. Running one on a live
   * workspace is an outage the operator chose without meaning to, so it is refused unless that
   * workspace is inside an ACTIVE maintenance window. The platform's own broadcast produces exactly
   * that state, which is why these two features were built together.
   *
   * ANALYZE is online and cheap, and is not gated.
   */
  if (input.operation === "OPTIMIZE") {
    const phase = await withOrgTenant(org.slug, async () => {
      const { getMaintenanceSettings, phaseOf } = await import("./maintenance.service.js");
      return phaseOf(await getMaintenanceSettings());
    });
    if (phase !== "active") {
      throw new AppError(
        409,
        "Reclaiming space rebuilds each table and blocks writes to it while it runs, so it is only allowed inside an active maintenance window. Arm one for this workspace from Maintenance, then run it again.",
        { code: "MAINTENANCE_WINDOW_REQUIRED" }
      );
    }
  }

  const dsn = decryptSecret(org.database.encryptedDsn);
  const client = new ControlPrismaClient({ datasources: { db: { url: dsn } } });
  const started = Date.now();
  const messages: OperationResult["messages"] = [];

  try {
    // One statement per table rather than one statement listing all of them: a single failure then
    // costs one table instead of the whole run, and the message names which.
    for (const table of targets) {
      const verb = input.operation === "ANALYZE" ? "ANALYZE" : "OPTIMIZE";
      const rows = await client.$queryRawUnsafe<Array<{ Table: string; Op: string; Msg_type: string; Msg_text: string }>>(
        // Interpolated, and it has to be — MySQL does not accept a bound parameter where a table
        // name goes. Safe because `table` has passed BOTH the identifier pattern and the
        // membership check above, and comes from the schema rather than from the request.
        `${verb} TABLE \`${table}\``
      );
      for (const row of rows) messages.push({ table: row.Table ?? table, type: row.Msg_type ?? "info", text: row.Msg_text ?? "" });
    }
  } finally {
    await client.$disconnect().catch(() => undefined);
  }

  const after = await getDatabaseMetrics(input.orgId);
  const freedBytes = input.operation === "OPTIMIZE" ? before.schema.freeBytes - after.schema.freeBytes : null;

  await platformAudit("PLATFORM_ADMIN", input.actorLabel, `tenant_db.${input.operation.toLowerCase()}`, "Organization", org.id, {
    tables: targets.length,
    freedBytes,
    ms: Date.now() - started
  });

  return { operation: input.operation, tables: targets, ms: Date.now() - started, messages, freedBytes };
}

/** Every base table in the schema, by name. Its own short-lived connection for the same reason
 *  `getDatabaseMetrics` uses one: this is an operator screen, not the request path. */
async function listTableNames(encryptedDsn: string, databaseName: string): Promise<string[]> {
  const client = new ControlPrismaClient({ datasources: { db: { url: decryptSecret(encryptedDsn) } } });
  try {
    const rows = await client.$queryRawUnsafe<Array<{ TABLE_NAME: string }>>(
      `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`,
      databaseName
    );
    return rows.map((row) => row.TABLE_NAME);
  } finally {
    await client.$disconnect().catch(() => undefined);
  }
}
