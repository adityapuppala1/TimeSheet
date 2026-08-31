/**
 * WHAT: per-tenant observability for the platform console — one workspace's server health, service
 * status, incident history, API performance and, the part that did not exist anywhere before, its
 * DATABASE: size, growth, the tables that dominate it, and how the server it sits on is behaving.
 *
 * IT COMPOSES THE TENANT SERVICES RATHER THAN RE-QUERYING THEM. `getSystemHealth`, `getStatusPage`
 * and `getApiPerformanceOverview` already answer three of the four questions for the workspace you
 * are inside; entering that workspace's context with `withOrgTenant` and calling them is what makes
 * the platform view and the customer's own Maintenance tab show the SAME numbers. A second set of
 * queries here would drift, and the first person to notice would be a customer disagreeing with us
 * about their own uptime.
 *
 * THE DATABASE METRICS ARE NEW, AND THEIR HONESTY MATTERS:
 *  - PER-SCHEMA figures (size, rows, table count, index share, the biggest tables) come from
 *    `information_schema.TABLES` for that workspace's schema alone. Row counts there are InnoDB's
 *    ESTIMATES, not exact counts, and the response says so rather than presenting them as truth.
 *  - SERVER-WIDE figures (connections, slow queries, buffer-pool hit rate, uptime) come from
 *    `SHOW GLOBAL STATUS`. They describe the MySQL server, which several workspaces share. They are
 *    labelled `scope: "server"` for exactly that reason — attributing a server-wide slow-query
 *    count to one tenant would be a lie a dashboard makes very easy to tell.
 *
 * NOTHING HERE WRITES. Every query is a read, and a failure on any one section degrades that
 * section to `null` with its error rather than failing the page: a workspace whose database is down
 * is precisely when an operator needs the other four panels to still render.
 */
import { PrismaClient as ControlPrismaClient } from "../generated/control-client/index.js";
import { controlPrisma } from "../config/control-prisma.js";
import { withOrgTenant } from "../config/with-org-tenant.js";
import { AppError } from "../middleware/error.js";
import { decryptSecret } from "../utils/encryption.js";
import { getSystemHealth } from "./system-health.service.js";
import { getStatusPage } from "./service-health.service.js";
import { getApiPerformanceOverview } from "./api-performance.service.js";

/* ------------------------------------------------------------------------------------------ */
/* Database metrics                                                                            */
/* ------------------------------------------------------------------------------------------ */

export interface TableRow {
  name: string;
  /** InnoDB's ESTIMATE. Exact counts need a full scan, which is not worth doing to draw a chart. */
  estimatedRows: number;
  dataBytes: number;
  indexBytes: number;
  totalBytes: number;
  /** Space the engine has allocated and no longer uses. Reclaimed by OPTIMIZE, which locks. */
  freeBytes: number;
  /** freeBytes / (total + free). Above ~30% on a large table is a real reason to rebuild. */
  fragmentation: number | null;
  engine: string | null;
  collation: string | null;
  /** Average bytes per row — a sudden jump usually means a blob column nobody meant to add. */
  avgRowBytes: number;
  /** How many indexes the table carries, and how far its AUTO_INCREMENT is through its type. */
  indexCount: number;
  /** Percent of the signed range consumed. NULL when the column is not an integer AUTO_INCREMENT. */
  autoIncrementUsePercent: number | null;
  /** A table with no primary key cannot be replicated row-based and cannot be chunk-migrated. */
  hasPrimaryKey: boolean;
}

/** One index, as the schema describes it — never its contents. */
export interface IndexRow {
  table: string;
  name: string;
  columns: string[];
  unique: boolean;
  /** Distinct values the optimiser believes it has. Zero on a non-empty table = stale statistics. */
  cardinality: number;
}

/** A query running right now, from SHOW PROCESSLIST, with its text redacted to its shape. */
export interface ProcessRow {
  id: number;
  user: string;
  host: string | null;
  command: string;
  seconds: number;
  state: string | null;
  /** Statement shape only — literals are stripped before this leaves the service. */
  digest: string | null;
}

export interface DatabaseMetrics {
  databaseName: string;
  host: string;
  /** The MySQL server version, so an operator can see a tenant on an older box. */
  serverVersion: string | null;
  schema: {
    tableCount: number;
    estimatedRows: number;
    dataBytes: number;
    indexBytes: number;
    totalBytes: number;
    /** index / (data + index). A very low share on a large schema is a missing-index smell. */
    indexShare: number | null;
    largestTables: TableRow[];
    /** Sum of DATA_FREE across the schema — how much a rebuild would hand back. */
    freeBytes: number;
    /** Tables with no primary key, named. Empty is the healthy answer. */
    tablesWithoutPrimaryKey: string[];
    /** Tables whose indexes outweigh their data 2:1 — usually an index nobody uses. */
    indexHeavyTables: string[];
    /** The engines in use. More than one in a schema is worth knowing about. */
    engines: Array<{ engine: string; tables: number }>;
    /** Total indexes across the schema, and the widest ones. */
    indexCount: number;
    widestIndexes: IndexRow[];
  };
  /** Everything below describes the SERVER, which other workspaces may share. */
  server: {
    scope: "server";
    uptimeSec: number | null;
    threadsConnected: number | null;
    threadsRunning: number | null;
    maxConnections: number | null;
    connectionUsePercent: number | null;
    slowQueries: number | null;
    questions: number | null;
    /** Reads served from memory, as a percentage of all reads. Below ~99% is worth a look. */
    bufferPoolHitRate: number | null;
    abortedConnects: number | null;
    /** Rows the storage engine actually read to answer queries, as a ratio of rows returned.
     *  A large number means full scans: the optimiser is reading far more than it hands back. */
    rowsExaminedPerReturned: number | null;
    /** Temporary tables spilled to disk, as a share of all temporary tables created. */
    tmpDiskTablePercent: number | null;
    /** Open tables against the table_open_cache ceiling. */
    openTables: number | null;
    tableOpenCache: number | null;
    /** InnoDB buffer pool size, so "hit rate is low" has a next question attached. */
    bufferPoolBytes: number | null;
  };
  /** Statements running right now against THIS schema, shape-only. Empty on a quiet workspace. */
  activeQueries: ProcessRow[];
  /** How long the metrics query itself took — a slow answer here IS a finding. */
  queryMs: number;
}

const bigintToNumber = (value: unknown): number => (typeof value === "bigint" ? Number(value) : Number(value ?? 0));

const percentOf = (part: number | null, whole: number | null): number | null => (whole && whole > 0 && part !== null ? (part / whole) * 100 : null);

/** Rows the engine read per SELECT. Crude by construction — server-wide counters cannot be
 *  attributed to one query — but a jump from tens to millions is the tell for a lost index. */
const rowsExaminedRatio = (rowsRead: number | null, selects: number | null): number | null =>
  selects && selects > 0 && rowsRead !== null ? rowsRead / selects : null;

/**
 * A running statement, reduced to its SHAPE.
 *
 * PROCESSLIST hands back the literal SQL, and a tenant's SQL carries a tenant's data — an email
 * address in a WHERE clause, a person's name in an INSERT. The platform console is aggregate-only
 * by policy, so every literal is replaced before the text leaves this service: quoted strings,
 * numbers and long IN-lists all collapse to a placeholder. What survives is enough to say "this is
 * the timesheet-approval query and it has been running for 40 seconds", which is the whole job.
 */
export function redactStatement(sql: string | null): string | null {
  if (!sql) return null;
  const shape = sql
    .replace(/\s+/g, " ")
    // Quoted literals first, escapes included, so a string that itself contains a quote cannot end
    // the match early and leak its own tail.
    .replace(/'(?:[^'\\]|\\.)*'/g, "?")
    .replace(/"(?:[^"\\]|\\.)*"/g, "?")
    .replace(/\b0x[0-9a-fA-F]+\b/g, "?")
    .replace(/\b\d+(?:\.\d+)?\b/g, "?")
    // A 500-id IN-list is noise once every id is already a placeholder.
    .replace(/\(\s*\?(?:\s*,\s*\?)+\s*\)/g, "(?)")
    .trim();
  return shape.length > 300 ? `${shape.slice(0, 300)}…` : shape;
}

/**
 * Read one workspace's database metrics through its OWN connection string.
 *
 * A dedicated short-lived client rather than the cached tenant client: this runs from an operator
 * screen, not the request path, and `information_schema` queries against a large server are exactly
 * the kind of thing that should not sit in a pool other requests are waiting on.
 */
export async function getDatabaseMetrics(orgId: string): Promise<DatabaseMetrics> {
  const org = await controlPrisma.organization.findUnique({ where: { id: orgId }, include: { database: true } });
  if (!org) throw new AppError(404, "Organization not found");
  if (!org.database) throw new AppError(409, "This workspace has no database registered.");

  const dsn = decryptSecret(org.database.encryptedDsn);
  const client = new ControlPrismaClient({ datasources: { db: { url: dsn } } });
  const started = Date.now();

  try {
    const [tables, status, variables, indexes, processes] = await Promise.all([
      client.$queryRawUnsafe<
        Array<{
          TABLE_NAME: string;
          TABLE_ROWS: bigint | null;
          DATA_LENGTH: bigint | null;
          INDEX_LENGTH: bigint | null;
          DATA_FREE: bigint | null;
          AVG_ROW_LENGTH: bigint | null;
          ENGINE: string | null;
          TABLE_COLLATION: string | null;
          AUTO_INCREMENT: bigint | null;
        }>
      >(
        `SELECT TABLE_NAME, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH, DATA_FREE, AVG_ROW_LENGTH,
                ENGINE, TABLE_COLLATION, AUTO_INCREMENT
           FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'`,
        org.database.databaseName
      ),
      // One round trip for every counter this screen reads. `SHOW GLOBAL STATUS` is cheap and the
      // alternative — one query per counter — multiplies latency for no benefit.
      client
        .$queryRawUnsafe<Array<{ Variable_name: string; Value: string }>>(
          `SHOW GLOBAL STATUS WHERE Variable_name IN
           ('Uptime','Threads_connected','Threads_running','Slow_queries','Questions','Aborted_connects',
            'Innodb_buffer_pool_read_requests','Innodb_buffer_pool_reads',
            'Handler_read_rnd_next','Handler_read_next','Innodb_rows_read','Com_select',
            'Created_tmp_disk_tables','Created_tmp_tables','Open_tables')`
        )
        .catch(() => []),
      client
        .$queryRawUnsafe<Array<{ Variable_name: string; Value: string }>>(
          `SHOW GLOBAL VARIABLES WHERE Variable_name IN ('max_connections','version','table_open_cache','innodb_buffer_pool_size')`
        )
        .catch(() => []),
      // The SCHEMA, never the contents. Index names and column lists describe the shape of the
      // database, which is the platform's own product; a workspace's DATA is never read here and
      // no query in this service selects from a tenant table.
      client
        .$queryRawUnsafe<Array<{ TABLE_NAME: string; INDEX_NAME: string; COLUMN_NAME: string; NON_UNIQUE: number | bigint; CARDINALITY: bigint | null; SEQ_IN_INDEX: number | bigint }>>(
          `SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME, NON_UNIQUE, CARDINALITY, SEQ_IN_INDEX
             FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = ?
            ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
          org.database.databaseName
        )
        .catch(() => []),
      // Requires PROCESS privilege. A deployment whose API user does not have it gets an empty
      // panel that says so rather than a failed page — this is a nice-to-have, not the point.
      client
        .$queryRawUnsafe<Array<{ ID: bigint; USER: string; HOST: string | null; COMMAND: string; TIME: bigint | number; STATE: string | null; INFO: string | null }>>(
          // `INFO NOT LIKE '%information_schema%'` keeps this panel from showing the monitor
          // watching itself: the three queries above are running on this very connection while it
          // executes, and an operator scanning for a stuck statement should not have to skip past
          // the tool they are scanning with.
          `SELECT ID, USER, HOST, COMMAND, TIME, STATE, INFO
             FROM information_schema.PROCESSLIST
            WHERE DB = ? AND COMMAND <> 'Sleep'
              AND (INFO IS NULL OR INFO NOT LIKE '%information_schema%')
            ORDER BY TIME DESC
            LIMIT 25`,
          org.database.databaseName
        )
        .catch(() => [])
    ]);

    const statusOf = (name: string) => {
      const row = status.find((r) => r.Variable_name === name);
      return row ? Number(row.Value) : null;
    };
    const variableOf = (name: string) => variables.find((r) => r.Variable_name === name)?.Value ?? null;

    /* Index metadata, folded from one row per COLUMN into one row per INDEX. */
    const indexByKey = new Map<string, IndexRow>();
    const indexNamesByTable = new Map<string, Set<string>>();
    for (const row of indexes) {
      const key = `${row.TABLE_NAME}.${row.INDEX_NAME}`;
      const existing = indexByKey.get(key);
      if (existing) {
        existing.columns.push(row.COLUMN_NAME);
      } else {
        indexByKey.set(key, {
          table: row.TABLE_NAME,
          name: row.INDEX_NAME,
          columns: [row.COLUMN_NAME],
          unique: Number(row.NON_UNIQUE) === 0,
          cardinality: bigintToNumber(row.CARDINALITY)
        });
      }
      const names = indexNamesByTable.get(row.TABLE_NAME) ?? new Set<string>();
      names.add(row.INDEX_NAME);
      indexNamesByTable.set(row.TABLE_NAME, names);
    }
    const allIndexes = [...indexByKey.values()];
    const primaryKeyTables = new Set(allIndexes.filter((i) => i.name === "PRIMARY").map((i) => i.table));

    const rows: TableRow[] = tables.map((table) => {
      const dataBytes = bigintToNumber(table.DATA_LENGTH);
      const indexBytes = bigintToNumber(table.INDEX_LENGTH);
      const freeBytes = bigintToNumber(table.DATA_FREE);
      const totalBytes = dataBytes + indexBytes;
      const autoIncrement = table.AUTO_INCREMENT === null ? null : bigintToNumber(table.AUTO_INCREMENT);
      return {
        name: table.TABLE_NAME,
        estimatedRows: bigintToNumber(table.TABLE_ROWS),
        dataBytes,
        indexBytes,
        totalBytes,
        freeBytes,
        fragmentation: totalBytes + freeBytes > 0 ? freeBytes / (totalBytes + freeBytes) : null,
        engine: table.ENGINE,
        collation: table.TABLE_COLLATION,
        avgRowBytes: bigintToNumber(table.AVG_ROW_LENGTH),
        indexCount: indexNamesByTable.get(table.TABLE_NAME)?.size ?? 0,
        // Against signed INT, which is what this schema's auto-increment columns are. A BIGINT key
        // would report a nonsense fraction of a percent, which is the honest answer for a BIGINT.
        autoIncrementUsePercent: autoIncrement === null ? null : (autoIncrement / 2_147_483_647) * 100,
        hasPrimaryKey: primaryKeyTables.has(table.TABLE_NAME)
      };
    });

    const dataBytes = rows.reduce((sum, r) => sum + r.dataBytes, 0);
    const indexBytes = rows.reduce((sum, r) => sum + r.indexBytes, 0);
    const freeBytes = rows.reduce((sum, r) => sum + r.freeBytes, 0);

    const engineCounts = new Map<string, number>();
    for (const row of rows) engineCounts.set(row.engine ?? "unknown", (engineCounts.get(row.engine ?? "unknown") ?? 0) + 1);
    const readRequests = statusOf("Innodb_buffer_pool_read_requests");
    const diskReads = statusOf("Innodb_buffer_pool_reads");
    const maxConnections = Number(variableOf("max_connections")) || null;
    const threadsConnected = statusOf("Threads_connected");

    return {
      databaseName: org.database.databaseName,
      host: org.database.host,
      serverVersion: variableOf("version"),
      schema: {
        tableCount: rows.length,
        estimatedRows: rows.reduce((sum, r) => sum + r.estimatedRows, 0),
        dataBytes,
        indexBytes,
        totalBytes: dataBytes + indexBytes,
        indexShare: dataBytes + indexBytes > 0 ? indexBytes / (dataBytes + indexBytes) : null,
        largestTables: [...rows].sort((a, b) => b.totalBytes - a.totalBytes).slice(0, 12),
        freeBytes,
        tablesWithoutPrimaryKey: rows.filter((r) => !r.hasPrimaryKey).map((r) => r.name),
        // 2:1 index-to-data, and only once the table is big enough for the ratio to mean anything —
        // a 16KB lookup table is all index by definition and is not a finding.
        indexHeavyTables: rows.filter((r) => r.dataBytes > 1_000_000 && r.indexBytes > r.dataBytes * 2).map((r) => r.name),
        engines: [...engineCounts.entries()].map(([engine, count]) => ({ engine, tables: count })).sort((a, b) => b.tables - a.tables),
        indexCount: allIndexes.length,
        widestIndexes: [...allIndexes].sort((a, b) => b.columns.length - a.columns.length || b.cardinality - a.cardinality).slice(0, 10)
      },
      server: {
        scope: "server",
        uptimeSec: statusOf("Uptime"),
        threadsConnected,
        threadsRunning: statusOf("Threads_running"),
        maxConnections,
        connectionUsePercent: maxConnections && threadsConnected !== null ? (threadsConnected / maxConnections) * 100 : null,
        slowQueries: statusOf("Slow_queries"),
        questions: statusOf("Questions"),
        bufferPoolHitRate: readRequests && readRequests > 0 && diskReads !== null ? ((readRequests - diskReads) / readRequests) * 100 : null,
        abortedConnects: statusOf("Aborted_connects"),
        rowsExaminedPerReturned: rowsExaminedRatio(statusOf("Innodb_rows_read"), statusOf("Com_select")),
        tmpDiskTablePercent: percentOf(statusOf("Created_tmp_disk_tables"), statusOf("Created_tmp_tables")),
        openTables: statusOf("Open_tables"),
        tableOpenCache: Number(variableOf("table_open_cache")) || null,
        bufferPoolBytes: Number(variableOf("innodb_buffer_pool_size")) || null
      },
      activeQueries: processes.map((process) => ({
        id: Number(process.ID),
        user: process.USER,
        host: process.HOST,
        command: process.COMMAND,
        seconds: Number(process.TIME),
        state: process.STATE,
        digest: redactStatement(process.INFO)
      })),
      queryMs: Date.now() - started
    };
  } finally {
    await client.$disconnect().catch(() => undefined);
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Derived alerts                                                                              */
/* ------------------------------------------------------------------------------------------ */

export type HealthAlertSeverity = "critical" | "warning" | "info";

export interface HealthAlert {
  severity: HealthAlertSeverity;
  title: string;
  detail: string;
  /** Which panel to look at, so an alert is a destination rather than only a statement. */
  area: "database" | "services" | "api" | "server" | "maintenance";
  /**
   * The stable identity of the CONDITION, which is not the identity of the message (5.0.0).
   *
   * `platform-alerts.service.ts` keeps one row per workspace per key so that a standing alert is
   * reported once rather than every six hours. That only works if "Database connections at 84%"
   * and "…at 87%" are the same thing, and if "1 fragmented table" and "2 fragmented tables" are
   * too. Deriving a key by normalising the title was tried and is exactly as fragile as it sounds
   * — the plural `s` alone splits one condition into two. So the key is written HERE, beside the
   * rule that produced the alert, where changing one without the other is visible in the diff.
   *
   * CHANGING A KEY RE-ANNOUNCES THE CONDITION to every deployment on the next sweep, because the
   * old row no longer matches and the new one has never been reported. That is the right
   * behaviour for a genuinely new rule and an avoidable nuisance for a reworded one.
   */
  key: string;
}

/**
 * Alerts are DERIVED from the numbers on the page, not stored as configured rules.
 *
 * Deliberately so, for now: a rules engine with per-tenant thresholds is a product of its own, and
 * an operator's first question is not "which rule fired" but "is anything wrong with this
 * workspace". Every threshold below is stated in the alert text, so nothing is a black box — and
 * when these need to become editable, they are already one pure function.
 */
export function deriveAlerts(input: {
  database: DatabaseMetrics | null;
  openIncidents: number;
  downServices: string[];
  degradedServices: string[];
  apiErrorRate: number | null;
  apiP95Ms: number | null;
  maintenancePhase: string | null;
}): HealthAlert[] {
  const alerts: HealthAlert[] = [];

  if (input.downServices.length) {
    alerts.push({ key: "services.down", severity: "critical", title: `${input.downServices.length} service down`, detail: input.downServices.join(", "), area: "services" });
  }
  if (input.degradedServices.length) {
    alerts.push({ key: "services.degraded", severity: "warning", title: `${input.degradedServices.length} service degraded`, detail: input.degradedServices.join(", "), area: "services" });
  }
  if (input.openIncidents > 0) {
    alerts.push({ key: "services.open_incidents", severity: "warning", title: `${input.openIncidents} open incident${input.openIncidents === 1 ? "" : "s"}`, detail: "Still unresolved on this workspace's status page.", area: "services" });
  }

  const db = input.database;
  if (db) {
    if (db.server.connectionUsePercent !== null && db.server.connectionUsePercent >= 80) {
      alerts.push({
        key: "db.connections",
        severity: db.server.connectionUsePercent >= 90 ? "critical" : "warning",
        title: `Database connections at ${db.server.connectionUsePercent.toFixed(0)}%`,
        detail: `${db.server.threadsConnected} of ${db.server.maxConnections} on ${db.host}. Server-wide — every workspace on this box shares it. Threshold: 80%.`,
        area: "database"
      });
    }
    if (db.server.bufferPoolHitRate !== null && db.server.bufferPoolHitRate < 99) {
      alerts.push({
        key: "db.buffer_pool",
        severity: db.server.bufferPoolHitRate < 95 ? "warning" : "info",
        title: `Buffer pool hit rate ${db.server.bufferPoolHitRate.toFixed(2)}%`,
        detail: "Reads are going to disk more than they should. Server-wide. Threshold: 99%.",
        area: "database"
      });
    }
    if (db.schema.totalBytes > 20 * 1024 ** 3) {
      alerts.push({ key: "db.size", severity: "info", title: "Large workspace database", detail: `${(db.schema.totalBytes / 1024 ** 3).toFixed(1)} GB across ${db.schema.tableCount} tables. Threshold: 20 GB.`, area: "database" });
    }
    if (db.queryMs > 2000) {
      alerts.push({ key: "db.metadata_slow", severity: "warning", title: "Slow metadata query", detail: `information_schema took ${db.queryMs} ms to answer — the server is busy or the schema is very large. Threshold: 2000 ms.`, area: "database" });
    }

    /* ---- schema-shape findings, all of them things a rebuild or an index would fix ---- */

    // Fragmentation is only worth an operator's attention once the space is worth reclaiming: a
    // 60%-fragmented 200KB table is arithmetic, not a problem.
    const fragmented = db.schema.largestTables.filter((table) => (table.fragmentation ?? 0) >= 0.3 && table.freeBytes > 50 * 1024 ** 2);
    if (fragmented.length) {
      alerts.push({
        key: "db.fragmentation",
        severity: "info",
        title: `${fragmented.length} fragmented table${fragmented.length === 1 ? "" : "s"}`,
        detail: `${fragmented.map((table) => table.name).join(", ")} — ${(db.schema.freeBytes / 1024 ** 3).toFixed(2)} GB is allocated and unused across the schema. Reclaiming it rebuilds the table, which locks it, so run it inside a maintenance window. Threshold: 30% free and over 50 MB.`,
        area: "database"
      });
    }

    if (db.schema.tablesWithoutPrimaryKey.length) {
      alerts.push({
        key: "db.no_primary_key",
        severity: "warning",
        title: `${db.schema.tablesWithoutPrimaryKey.length} table${db.schema.tablesWithoutPrimaryKey.length === 1 ? "" : "s"} without a primary key`,
        detail: `${db.schema.tablesWithoutPrimaryKey.slice(0, 6).join(", ")}. Row-based replication and chunked migrations both need one; without it a large table can only be copied whole.`,
        area: "database"
      });
    }

    // The one that ends a workspace's day without warning: an INT auto-increment that runs out.
    const nearlyFull = db.schema.largestTables.filter((table) => (table.autoIncrementUsePercent ?? 0) >= 70);
    if (nearlyFull.length) {
      const worst = Math.max(...nearlyFull.map((table) => table.autoIncrementUsePercent ?? 0));
      alerts.push({
        key: "db.auto_increment",
        severity: worst >= 90 ? "critical" : "warning",
        title: `Auto-increment ${worst.toFixed(0)}% consumed`,
        detail: `${nearlyFull.map((table) => table.name).join(", ")} — against a signed INT key. At 100% every insert fails, and the fix (widening to BIGINT) is a full table rebuild that wants planning, not an outage. Threshold: 70%.`,
        area: "database"
      });
    }

    if (db.schema.indexHeavyTables.length) {
      alerts.push({
        key: "db.index_heavy",
        severity: "info",
        title: `${db.schema.indexHeavyTables.length} index-heavy table${db.schema.indexHeavyTables.length === 1 ? "" : "s"}`,
        detail: `${db.schema.indexHeavyTables.join(", ")} carry more than twice as much index as data. Usually an index nobody queries — each one costs on every write. Threshold: 2:1 on tables over 1 MB.`,
        area: "database"
      });
    }

    if (db.server.tmpDiskTablePercent !== null && db.server.tmpDiskTablePercent >= 25) {
      alerts.push({
        key: "db.tmp_disk_tables",
        severity: "info",
        title: `${db.server.tmpDiskTablePercent.toFixed(0)}% of temporary tables spill to disk`,
        detail: "Sorts and group-bys are exceeding the in-memory limit. Server-wide. Threshold: 25%.",
        area: "database"
      });
    }

    // A statement running longer than a minute inside a request-shaped application is almost always
    // stuck rather than slow.
    const stuck = db.activeQueries.filter((query) => query.seconds >= 60);
    if (stuck.length) {
      alerts.push({
        key: "db.long_running_queries",
        severity: stuck.some((query) => query.seconds >= 300) ? "critical" : "warning",
        title: `${stuck.length} long-running quer${stuck.length === 1 ? "y" : "ies"}`,
        detail: `Longest ${Math.max(...stuck.map((query) => query.seconds))}s: ${stuck[0].digest ?? stuck[0].command}. Threshold: 60s.`,
        area: "database"
      });
    }
  }

  if (input.apiErrorRate !== null && input.apiErrorRate >= 2) {
    alerts.push({
      key: "api.error_rate",
      severity: input.apiErrorRate >= 5 ? "critical" : "warning",
      title: `API error rate ${input.apiErrorRate.toFixed(1)}%`,
      detail: "Share of sampled requests answering 5xx. Threshold: 2%.",
      area: "api"
    });
  }
  if (input.apiP95Ms !== null && input.apiP95Ms >= 1500) {
    alerts.push({ key: "api.p95", severity: "warning", title: `API p95 ${Math.round(input.apiP95Ms)} ms`, detail: "Slowest 5% of sampled requests. Threshold: 1500 ms.", area: "api" });
  }

  if (input.maintenancePhase === "active") {
    alerts.push({ key: "maintenance.active", severity: "info", title: "In maintenance", detail: "Everyone below super admin is locked out of this workspace right now.", area: "maintenance" });
  }

  return alerts;
}

/* ------------------------------------------------------------------------------------------ */
/* The per-tenant page                                                                         */
/* ------------------------------------------------------------------------------------------ */

/** A section that can fail without taking the page with it. */
type Section<T> = { data: T | null; error: string | null };

async function section<T>(load: () => Promise<T>): Promise<Section<T>> {
  try {
    return { data: await load(), error: null };
  } catch (error) {
    return { data: null, error: (error as Error).message.slice(0, 300) };
  }
}

export async function getTenantHealth(orgId: string, days = 30): Promise<{
  organization: { id: string; name: string; slug: string; status: string; planTier: string; databaseName: string | null };
  maintenance: Section<{ enabled: boolean; phase: string; scheduledStartAt: Date | null; scheduledEndAt: Date | null; message: string | null }>;
  system: Section<Awaited<ReturnType<typeof getSystemHealth>>>;
  status: Section<Awaited<ReturnType<typeof getStatusPage>>>;
  api: Section<Awaited<ReturnType<typeof getApiPerformanceOverview>>>;
  database: Section<DatabaseMetrics>;
  alerts: HealthAlert[];
}> {
  const org = await controlPrisma.organization.findUnique({ where: { id: orgId }, include: { database: { select: { databaseName: true } } } });
  if (!org) throw new AppError(404, "Organization not found");

  // The three tenant-scoped reads share ONE tenant context: three separate `withOrgTenant` calls
  // would resolve the org, decrypt its DSN and open a client three times for one screen.
  const inTenant = await section(async () =>
    withOrgTenant(org.slug, async () => {
      const { getMaintenanceSettings, phaseOf } = await import("./maintenance.service.js");
      const settings = await getMaintenanceSettings();
      const [system, status, api] = await Promise.all([
        section(() => getSystemHealth()),
        section(() => getStatusPage(days)),
        // HOURS, not days — the tenant panel takes a window in hours, and passing 30 here would
        // silently narrow a month to a day and a quarter.
        section(() => getApiPerformanceOverview(days * 24))
      ]);
      return {
        maintenance: { enabled: settings.enabled, phase: phaseOf(settings), scheduledStartAt: settings.scheduledStartAt, scheduledEndAt: settings.scheduledEndAt, message: settings.message },
        system,
        status,
        api
      };
    })
  );

  const database = org.database ? await section(() => getDatabaseMetrics(orgId)) : { data: null, error: "No database registered for this workspace." };

  const statusData = inTenant.data?.status.data;
  const apiTotals = inTenant.data?.api.data?.totals as { errorRate?: number; p95Ms?: number } | undefined;

  const alerts = deriveAlerts({
    database: database.data,
    openIncidents: statusData?.incidents?.filter((i: { endedAt: Date | string | null }) => !i.endedAt).length ?? 0,
    downServices: (statusData?.services ?? []).filter((s: { current: string | null }) => s.current === "DOWN").map((s: { label: string }) => s.label),
    degradedServices: (statusData?.services ?? []).filter((s: { current: string | null }) => s.current === "DEGRADED").map((s: { label: string }) => s.label),
    apiErrorRate: apiTotals?.errorRate ?? null,
    apiP95Ms: apiTotals?.p95Ms ?? null,
    maintenancePhase: inTenant.data?.maintenance.phase ?? null
  });

  return {
    organization: { id: org.id, name: org.name, slug: org.slug, status: org.status, planTier: org.planTier, databaseName: org.database?.databaseName ?? null },
    maintenance: inTenant.data ? { data: inTenant.data.maintenance, error: null } : { data: null, error: inTenant.error },
    system: inTenant.data?.system ?? { data: null, error: inTenant.error },
    status: inTenant.data?.status ?? { data: null, error: inTenant.error },
    api: inTenant.data?.api ?? { data: null, error: inTenant.error },
    database,
    alerts
  };
}

/* ------------------------------------------------------------------------------------------ */
/* The fleet view                                                                              */
/* ------------------------------------------------------------------------------------------ */

export interface FleetRow {
  organizationId: string;
  name: string;
  slug: string;
  status: string;
  planTier: string;
  databaseName: string | null;
  reachable: boolean;
  error: string | null;
  totalBytes: number | null;
  tableCount: number | null;
  estimatedRows: number | null;
  queryMs: number | null;
  maintenancePhase: string | null;
  alerts: HealthAlert[];
}

/**
 * Every workspace's database at a glance.
 *
 * SEQUENTIAL, NOT PARALLEL, and that is the point: this opens a fresh connection per workspace, and
 * forty at once against one MySQL server is a self-inflicted connection storm on the box the whole
 * platform runs on. A screen an operator opens occasionally can afford to take a few seconds.
 */
export async function getFleetHealth(): Promise<{ rows: FleetRow[]; totals: { databases: number; reachable: number; totalBytes: number; alerts: number } }> {
  const orgs = await controlPrisma.organization.findMany({
    where: { status: { in: ["ACTIVE", "GRACE", "SUSPENDED"] } },
    orderBy: { name: "asc" },
    include: { database: { select: { databaseName: true } } }
  });

  const rows: FleetRow[] = [];
  for (const org of orgs) {
    const base = {
      organizationId: org.id,
      name: org.name,
      slug: org.slug,
      status: org.status,
      planTier: org.planTier,
      databaseName: org.database?.databaseName ?? null
    };
    if (!org.database) {
      rows.push({ ...base, reachable: false, error: "No database registered.", totalBytes: null, tableCount: null, estimatedRows: null, queryMs: null, maintenancePhase: null, alerts: [] });
      continue;
    }
    try {
      const metrics = await getDatabaseMetrics(org.id);
      let phase: string | null = null;
      try {
        phase = await withOrgTenant(org.slug, async () => {
          const { getMaintenanceSettings, phaseOf } = await import("./maintenance.service.js");
          return phaseOf(await getMaintenanceSettings());
        });
      } catch {
        phase = null;
      }
      rows.push({
        ...base,
        reachable: true,
        error: null,
        totalBytes: metrics.schema.totalBytes,
        tableCount: metrics.schema.tableCount,
        estimatedRows: metrics.schema.estimatedRows,
        queryMs: metrics.queryMs,
        maintenancePhase: phase,
        alerts: deriveAlerts({ database: metrics, openIncidents: 0, downServices: [], degradedServices: [], apiErrorRate: null, apiP95Ms: null, maintenancePhase: phase })
      });
    } catch (error) {
      rows.push({ ...base, reachable: false, error: (error as Error).message.slice(0, 200), totalBytes: null, tableCount: null, estimatedRows: null, queryMs: null, maintenancePhase: null, alerts: [] });
    }
  }

  return {
    rows,
    totals: {
      databases: rows.length,
      reachable: rows.filter((r) => r.reachable).length,
      totalBytes: rows.reduce((sum, r) => sum + (r.totalBytes ?? 0), 0),
      alerts: rows.reduce((sum, r) => sum + r.alerts.length, 0)
    }
  };
}
