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

/** How many table names a sample keeps beside each schema-finding count. A schema with four hundred
 *  keyless tables has a problem the first twenty names already describe; the count carries the rest. */
const SCHEMA_FINDING_NAME_CAP = 20;

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
          slowQueries: metrics.server.slowQueries,
          /*
           * THE SCHEMA FINDINGS, KEPT (5.0.0). `getDatabaseMetrics` has always computed these two,
           * raised an alert from them and then discarded them — so the only question an operator
           * ever actually asks about a schema finding, "when did this start?", could not be
           * answered by any route in the product. The counts make the trend; the names make a count
           * actionable. Both are aggregate: table NAMES, never a row.
           *
           * The name list is capped because it is unbounded in principle — a schema with four
           * hundred keyless tables must not turn an hourly row into a document.
           */
          tablesWithoutPrimaryKey: metrics.schema.tablesWithoutPrimaryKey.length,
          indexHeavyTables: metrics.schema.indexHeavyTables.length,
          schemaFindings: {
            tablesWithoutPrimaryKey: metrics.schema.tablesWithoutPrimaryKey.slice(0, SCHEMA_FINDING_NAME_CAP),
            indexHeavyTables: metrics.schema.indexHeavyTables.slice(0, SCHEMA_FINDING_NAME_CAP)
          }
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
  /** NULL on every sample taken before 5.0.0, and deliberately not backfilled to 0 — null means
   *  "that hour did not record this", 0 means "we looked and the schema was clean". The chart draws
   *  a gap rather than a floor, so the first real finding does not look like a regression that
   *  happened the day this shipped. */
  tablesWithoutPrimaryKey: number | null;
  indexHeavyTables: number | null;
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

export interface SchemaFindingTrend {
  tablesWithoutPrimaryKey: number | null;
  indexHeavyTables: number | null;
  names: { tablesWithoutPrimaryKey?: string[]; indexHeavyTables?: string[] } | null;
  firstSeen: { tablesWithoutPrimaryKey: string | null; indexHeavyTables: string | null };
}

export async function getTenantDbTrend(
  orgId: string,
  days = 30
): Promise<{ points: TrendPoint[]; growth: GrowthSummary; forecast: GrowthForecast; schemaFindings: SchemaFindingTrend }> {
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
    bufferPoolHitRate: row.bufferPoolHitRate,
    tablesWithoutPrimaryKey: row.tablesWithoutPrimaryKey,
    indexHeavyTables: row.indexHeavyTables
  }));

  // TWO ANSWERS, ON PURPOSE, and the page shows both. `summariseGrowth` says what the series DID
  // between its two ends; `forecastGrowth` says what it is likely to do next and, far more often,
  // refuses to say. Neither replaces the other: the first is a measurement and cannot be wrong, the
  // second is an inference and mostly declines to make one.
  const latest = rows[rows.length - 1];
  return {
    points,
    growth: summariseGrowth(points),
    forecast: forecastGrowth(points),
    schemaFindings: {
      tablesWithoutPrimaryKey: latest?.tablesWithoutPrimaryKey ?? null,
      indexHeavyTables: latest?.indexHeavyTables ?? null,
      names: (latest?.schemaFindings as { tablesWithoutPrimaryKey?: string[]; indexHeavyTables?: string[] } | null) ?? null,
      /** When each count was first non-zero in this window — the "when did this start" the counts
       *  were persisted for. Null when the finding is absent, or when no sample in the window
       *  recorded it at all (every row before 5.0.0). */
      firstSeen: {
        tablesWithoutPrimaryKey: points.find((point) => (point.tablesWithoutPrimaryKey ?? 0) > 0)?.at ?? null,
        indexHeavyTables: points.find((point) => (point.indexHeavyTables ?? 0) > 0)?.at ?? null
      }
    }
  };
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
/* The forecast                                                                                */
/* ------------------------------------------------------------------------------------------ */

/**
 * How confident the fit is, and it is `"none"` far more often than anything else — by design.
 *
 * A capacity forecast is only worth having if it is willing to say "I don't know". "Acme reaches
 * its ceiling in about six weeks" is a decision an operator can act on; the same sentence produced
 * from three samples taken on a Tuesday afternoon is a decision an operator acts on WRONGLY, and
 * they have no way to tell the two apart unless the number arrives carrying its own confidence.
 */
export type ForecastConfidence = "none" | "low" | "moderate" | "high";

export interface GrowthForecast {
  confidence: ForecastConfidence;
  /** Always populated, in plain words. Why there is a projection, or why there is not. */
  reason: string;
  /** Least-squares slope. Null whenever the fit was refused. */
  bytesPerDay: number | null;
  /** Coefficient of determination, 0–1. Null when it could not be computed. */
  r2: number | null;
  samples: number;
  spanDays: number;
  targetBytes: number;
  latestBytes: number | null;
  /** Days until `targetBytes` at the fitted rate. Null unless the fit was accepted AND the slope
   *  actually points at the target. */
  daysToTarget: number | null;
  /** The same answer as an absolute date, because "in 43 days" is a number people mis-add. */
  reachesTargetAt: string | null;
}

/** The floor for a fit. Six hourly samples is a quarter of a day; the SPAN is what actually
 *  matters, and three days is where a weekday/weekend cycle stops dominating the slope. */
const FORECAST_MIN_SAMPLES = 6;
const FORECAST_MIN_SPAN_DAYS = 3;
/** Below this, the line explains so little of the series that quoting its slope is a fiction with
 *  a decimal point on it. Half the variance is a deliberately generous bar: this is not science,
 *  it is a capacity conversation, and the alternative to a rough answer here is no answer. */
const FORECAST_MIN_R2 = 0.5;

/**
 * A LEAST-SQUARES FIT over the whole series, unlike `summariseGrowth` above, which reads only the
 * two ends — and the two functions coexist on purpose.
 *
 * `summariseGrowth` is a MEASUREMENT: "it grew 4 GB between these two samples" is true whatever the
 * shape in between, and it is the honest thing to show beside a chart. Its own comment says why it
 * is not a regression: one migration-shaped step makes a least-squares slope confidently describe
 * nothing. That objection is entirely right, and it is why this function reports r² and refuses the
 * projection when the line does not fit — the step that would have silently corrupted a slope now
 * shows up as a low r² and a "too noisy to project" answer instead.
 *
 * PURE, AND TAKING ONLY WHAT IT NEEDS. No clock, no database, no Prisma row type: a fixed series in,
 * a verdict out. Extrapolation is exactly the kind of arithmetic that looks right in review and is
 * wrong at the third decimal place, so it is tested directly against fixed series — one point, two
 * points, flat, shrinking, noisy, and cleanly growing.
 *
 * THE REFUSALS, IN THE ORDER THEY ARE CHECKED, each of them a real failure mode:
 *   1. Too few samples, or too short a span — the "extrapolate from three points" trap.
 *   2. A slope that is flat or negative — projecting a shrinking database at a ceiling is arithmetic
 *      pointed backwards.
 *   3. Already past the target — there is nothing to count down to, and "in -12 days" is not a
 *      sentence.
 *   4. A poor fit — the series moves, but not along this line.
 */
/**
 * The ordinary-least-squares fit itself, separated from the JUDGEMENT above it.
 *
 * `x` is in DAYS from the first sample rather than in milliseconds: the slope is then already bytes
 * per day, and the sums stay in a range where a double is exact rather than merely close.
 *
 * Returns null when every sample shares one timestamp — there is no time axis, and `sxx` is zero.
 */
function leastSquares(points: Array<{ at: string; totalBytes: number }>): { slope: number; r2: number } | null {
  const originMs = new Date(points[0].at).getTime();
  const xs = points.map((point) => (new Date(point.at).getTime() - originMs) / 86_400_000);
  const ys = points.map((point) => point.totalBytes);
  const n = points.length;
  const meanX = xs.reduce((sum, x) => sum + x, 0) / n;
  const meanY = ys.reduce((sum, y) => sum + y, 0) / n;

  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += (xs[i] - meanX) * (ys[i] - meanY);
    sxx += (xs[i] - meanX) ** 2;
  }
  if (sxx === 0) return null;

  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;

  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i += 1) {
    ssRes += (ys[i] - (intercept + slope * xs[i])) ** 2;
    ssTot += (ys[i] - meanY) ** 2;
  }
  // A perfectly flat series has zero variance, and r² is 0/0 there. Reported as 1 — the line
  // describes it exactly — which is correct and also irrelevant, because the caller refuses a zero
  // slope regardless.
  return { slope, r2: ssTot === 0 ? 1 : 1 - ssRes / ssTot };
}

/** How much of the variation the line has to explain to earn each word. Named rather than written
 *  as a chain of ternaries so the thresholds are greppable from the console's copy. */
function confidenceFor(r2: number): ForecastConfidence {
  if (r2 >= 0.9) return "high";
  if (r2 >= 0.7) return "moderate";
  return "low";
}

export function forecastGrowth(
  points: Array<{ at: string; totalBytes: number }>,
  targetBytes: number = PROJECTION_TARGET_BYTES
): GrowthForecast {
  const first = points[0];
  const last = points[points.length - 1];
  const spanDays = first && last ? (new Date(last.at).getTime() - new Date(first.at).getTime()) / 86_400_000 : 0;

  const base: GrowthForecast = {
    confidence: "none",
    reason: "",
    bytesPerDay: null,
    r2: null,
    samples: points.length,
    spanDays,
    targetBytes,
    latestBytes: last?.totalBytes ?? null,
    daysToTarget: null,
    reachesTargetAt: null
  };

  if (points.length < FORECAST_MIN_SAMPLES || spanDays < FORECAST_MIN_SPAN_DAYS) {
    return {
      ...base,
      reason: `Not enough history — ${points.length} sample${points.length === 1 ? "" : "s"} over ${spanDays.toFixed(1)} day${spanDays === 1 ? "" : "s"}. A projection needs at least ${FORECAST_MIN_SAMPLES} samples spanning ${FORECAST_MIN_SPAN_DAYS} days.`
    };
  }

  const fit = leastSquares(points);
  // Every sample at the same instant. Impossible from the hourly sampler, trivially producible by a
  // test or by a manual sweep run twice, and a division by zero either way.
  if (!fit) return { ...base, reason: "Every sample was taken at the same moment — there is no time axis to fit against." };

  const { slope, r2 } = fit;
  const withFit = { ...base, bytesPerDay: slope, r2 };

  if (slope <= 0) {
    return {
      ...withFit,
      reason:
        slope === 0
          ? "Flat — the database has not grown across this window, so there is nothing to project."
          : `Shrinking by ${Math.abs(slope / 1024 ** 2).toFixed(1)} MB/day across this window. A projection off a negative slope is arithmetic pointed backwards.`
    };
  }
  if (last.totalBytes >= targetBytes) {
    return { ...withFit, reason: "Already at or past the projection target — this is a capacity conversation to have now, not a countdown." };
  }
  if (r2 < FORECAST_MIN_R2) {
    return {
      ...withFit,
      reason: `Too noisy to project — the trend line explains only ${(r2 * 100).toFixed(0)}% of the variation (needs ${FORECAST_MIN_R2 * 100}%). The database is moving, but not along a straight line.`
    };
  }

  const daysToTarget = (targetBytes - last.totalBytes) / slope;

  return {
    ...withFit,
    confidence: confidenceFor(r2),
    reason: `Growing ${(slope / 1024 ** 2).toFixed(1)} MB/day across ${spanDays.toFixed(1)} days of samples; the trend line explains ${(r2 * 100).toFixed(0)}% of the variation.`,
    daysToTarget,
    // Derived from the LAST SAMPLE's clock rather than from `Date.now()`, so the function stays pure
    // and a stale series does not quietly report a date that keeps sliding forward on its own.
    reachesTargetAt: new Date(new Date(last.at).getTime() + daysToTarget * 86_400_000).toISOString()
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
