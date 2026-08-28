/**
 * The alert rules behind the platform console's per-workspace monitoring page.
 *
 * WHY THESE ARE WORTH PINNING. `deriveAlerts` is the whole of the "is this customer's instance
 * healthy?" judgement — it is what turns a wall of numbers into the two lines an operator reads
 * first. Three properties matter more than the individual thresholds, and each has a test below:
 *
 *   1. SEVERITY IS EARNED. A number just over the line is a warning; well over it is critical. An
 *      operator who is paged at "critical" for something that merely deserves a look stops reading
 *      criticals.
 *   2. SHARED-SERVER COUNTERS SAY SO. Connections and buffer-pool hit rate belong to the MySQL
 *      server, which other workspaces sit on. An alert that reads as this tenant's fault sends
 *      somebody to debug the wrong customer, so the text must name the scope.
 *   3. EVERY THRESHOLD IS STATED IN THE ALERT. These are derived rules, not configured ones; the
 *      only thing that stops that being a black box is that each alert quotes the line it crossed.
 *      That is asserted, not left to reviewer discipline.
 *
 * A failure here is usually deliberate — someone moved a threshold. The question to answer is
 * whether the console's copy, the meter colours in Monitoring.tsx (which use the same 75/90 split)
 * and this file still agree.
 */
import { describe, expect, it } from "vitest";
import { deriveAlerts, type DatabaseMetrics } from "../../src/services/platform-tenant-health.service.js";

type TableOver = Partial<DatabaseMetrics["schema"]["largestTables"][number]> & { name: string };

const table = (over: TableOver): DatabaseMetrics["schema"]["largestTables"][number] => ({
  estimatedRows: 1_000,
  dataBytes: 1_000_000,
  indexBytes: 200_000,
  totalBytes: 1_200_000,
  freeBytes: 0,
  fragmentation: 0,
  engine: "InnoDB",
  collation: "utf8mb4_unicode_ci",
  avgRowBytes: 100,
  indexCount: 2,
  autoIncrementUsePercent: 1,
  hasPrimaryKey: true,
  ...over
});

const metrics = (over: {
  connectionUsePercent?: number | null;
  bufferPoolHitRate?: number | null;
  totalBytes?: number;
  queryMs?: number;
  freeBytes?: number;
  tablesWithoutPrimaryKey?: string[];
  indexHeavyTables?: string[];
  tmpDiskTablePercent?: number | null;
  largestTables?: DatabaseMetrics["schema"]["largestTables"];
  activeQueries?: DatabaseMetrics["activeQueries"];
}): DatabaseMetrics => ({
  databaseName: "tenant_acme",
  host: "db.internal",
  serverVersion: "8.0.36",
  schema: {
    tableCount: 128,
    estimatedRows: 10_000,
    dataBytes: 1_000,
    indexBytes: 1_000,
    totalBytes: over.totalBytes ?? 2_000,
    indexShare: 0.5,
    largestTables: over.largestTables ?? [],
    freeBytes: over.freeBytes ?? 0,
    tablesWithoutPrimaryKey: over.tablesWithoutPrimaryKey ?? [],
    indexHeavyTables: over.indexHeavyTables ?? [],
    engines: [{ engine: "InnoDB", tables: 128 }],
    indexCount: 300,
    widestIndexes: []
  },
  server: {
    scope: "server",
    uptimeSec: 3600,
    threadsConnected: 40,
    threadsRunning: 4,
    maxConnections: 100,
    connectionUsePercent: over.connectionUsePercent === undefined ? 40 : over.connectionUsePercent,
    slowQueries: 0,
    questions: 1_000,
    bufferPoolHitRate: over.bufferPoolHitRate === undefined ? 99.9 : over.bufferPoolHitRate,
    abortedConnects: 0,
    rowsExaminedPerReturned: 10,
    tmpDiskTablePercent: over.tmpDiskTablePercent === undefined ? 1 : over.tmpDiskTablePercent,
    openTables: 40,
    tableOpenCache: 4000,
    bufferPoolBytes: 134_217_728
  },
  activeQueries: over.activeQueries ?? [],
  queryMs: over.queryMs ?? 12
});

const quiet = {
  database: null,
  openIncidents: 0,
  downServices: [],
  degradedServices: [],
  apiErrorRate: null,
  apiP95Ms: null,
  maintenancePhase: null
};

describe("deriveAlerts", () => {
  it("says nothing when nothing is wrong", () => {
    expect(deriveAlerts({ ...quiet, database: metrics({}) })).toEqual([]);
  });

  it("escalates from warning to critical as a number gets worse", () => {
    const warning = deriveAlerts({ ...quiet, database: metrics({ connectionUsePercent: 85 }) });
    const critical = deriveAlerts({ ...quiet, database: metrics({ connectionUsePercent: 95 }) });
    expect(warning[0].severity).toBe("warning");
    expect(critical[0].severity).toBe("critical");

    // The same shape on the API side, because an operator learns one rule, not two.
    expect(deriveAlerts({ ...quiet, apiErrorRate: 3 })[0].severity).toBe("warning");
    expect(deriveAlerts({ ...quiet, apiErrorRate: 7 })[0].severity).toBe("critical");
  });

  it("does not fire one step below each line", () => {
    expect(deriveAlerts({ ...quiet, database: metrics({ connectionUsePercent: 79 }) })).toEqual([]);
    expect(deriveAlerts({ ...quiet, apiErrorRate: 1.9 })).toEqual([]);
    expect(deriveAlerts({ ...quiet, apiP95Ms: 1499 })).toEqual([]);
    expect(deriveAlerts({ ...quiet, database: metrics({ queryMs: 2000 }) })).toEqual([]);
  });

  it("marks server-wide counters as server-wide, so nobody debugs the wrong tenant", () => {
    const connections = deriveAlerts({ ...quiet, database: metrics({ connectionUsePercent: 92 }) })[0];
    expect(connections.detail).toMatch(/server-wide/i);
    expect(connections.detail).toContain("db.internal");

    const bufferPool = deriveAlerts({ ...quiet, database: metrics({ bufferPoolHitRate: 90 }) })[0];
    expect(bufferPool.detail).toMatch(/server-wide/i);
  });

  it("states the threshold it crossed in every alert it raises", () => {
    const all = [
      ...deriveAlerts({ ...quiet, database: metrics({ connectionUsePercent: 92 }) }),
      ...deriveAlerts({ ...quiet, database: metrics({ bufferPoolHitRate: 90 }) }),
      ...deriveAlerts({ ...quiet, database: metrics({ totalBytes: 25 * 1024 ** 3 }) }),
      ...deriveAlerts({ ...quiet, database: metrics({ queryMs: 5_000 }) }),
      ...deriveAlerts({ ...quiet, apiErrorRate: 4 }),
      ...deriveAlerts({ ...quiet, apiP95Ms: 2_000 }),
      ...deriveAlerts({ ...quiet, database: metrics({ freeBytes: 4 * 1024 ** 3, largestTables: [table({ name: "AuditLog", fragmentation: 0.42, freeBytes: 4 * 1024 ** 3 })] }) }),
      ...deriveAlerts({ ...quiet, database: metrics({ largestTables: [table({ name: "TimeEntry", autoIncrementUsePercent: 93 })] }) }),
      ...deriveAlerts({ ...quiet, database: metrics({ indexHeavyTables: ["AuditLog"] }) }),
      ...deriveAlerts({ ...quiet, database: metrics({ tmpDiskTablePercent: 40 }) }),
      ...deriveAlerts({ ...quiet, database: metrics({ activeQueries: [{ id: 1, user: "app", host: null, command: "Query", seconds: 90, state: null, digest: "SELECT ?" }] }) })
    ];
    expect(all).toHaveLength(11);
    for (const alert of all) expect(alert.detail, alert.title).toMatch(/threshold/i);
  });

  it("reports a down service as critical and a degraded one as a warning, naming both", () => {
    const alerts = deriveAlerts({ ...quiet, downServices: ["Email delivery"], degradedServices: ["AI features"] });
    expect(alerts[0]).toMatchObject({ severity: "critical", area: "services" });
    expect(alerts[0].detail).toContain("Email delivery");
    expect(alerts[1]).toMatchObject({ severity: "warning", area: "services" });
    expect(alerts[1].detail).toContain("AI features");
  });

  it("treats an open maintenance window as information, not a fault", () => {
    // A workspace an operator deliberately took offline must not read as an incident — but it must
    // be visible, because "why can nobody sign in" has this as its answer more often than not.
    const alerts = deriveAlerts({ ...quiet, maintenancePhase: "active" });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: "info", area: "maintenance" });
    expect(deriveAlerts({ ...quiet, maintenancePhase: "scheduled" })).toEqual([]);
  });

  /* ---- the schema-shape findings (4.0.0) ---------------------------------------------- */

  it("only calls a table fragmented when the space is worth reclaiming", () => {
    // A 60%-fragmented 200KB table is arithmetic, not a problem — and an operator who is shown one
    // learns to skim the section that will one day hold a real 4GB finding.
    const small = deriveAlerts({ ...quiet, database: metrics({ largestTables: [table({ name: "Tiny", fragmentation: 0.6, freeBytes: 200_000 })] }) });
    expect(small).toEqual([]);

    const big = deriveAlerts({ ...quiet, database: metrics({ freeBytes: 4 * 1024 ** 3, largestTables: [table({ name: "AuditLog", fragmentation: 0.42, freeBytes: 4 * 1024 ** 3 })] }) });
    expect(big[0]).toMatchObject({ area: "database", severity: "info" });
    expect(big[0].detail).toContain("AuditLog");
    expect(big[0].detail).toMatch(/locks it, so run it inside a maintenance window/);
  });

  it("escalates an auto-increment that is running out, because the failure mode is total", () => {
    const warning = deriveAlerts({ ...quiet, database: metrics({ largestTables: [table({ name: "TimeEntry", autoIncrementUsePercent: 74 })] }) });
    const critical = deriveAlerts({ ...quiet, database: metrics({ largestTables: [table({ name: "TimeEntry", autoIncrementUsePercent: 93 })] }) });
    expect(warning[0].severity).toBe("warning");
    expect(critical[0].severity).toBe("critical");
    // At 100% every insert fails. An operator needs to know that BEFORE it happens, because the
    // fix is a full table rebuild that wants planning.
    expect(critical[0].detail).toMatch(/every insert fails/);
    expect(deriveAlerts({ ...quiet, database: metrics({ largestTables: [table({ name: "TimeEntry", autoIncrementUsePercent: 69 })] }) })).toEqual([]);
  });

  it("names tables with no primary key", () => {
    const alerts = deriveAlerts({ ...quiet, database: metrics({ tablesWithoutPrimaryKey: ["_legacy_import"] }) });
    expect(alerts[0]).toMatchObject({ severity: "warning", area: "database" });
    expect(alerts[0].detail).toContain("_legacy_import");
  });

  it("treats a stuck query as worse the longer it has been stuck", () => {
    const oneMinute = deriveAlerts({ ...quiet, database: metrics({ activeQueries: [{ id: 1, user: "app", host: null, command: "Query", seconds: 90, state: null, digest: "SELECT ? FROM T" }] }) });
    const fiveMinutes = deriveAlerts({ ...quiet, database: metrics({ activeQueries: [{ id: 1, user: "app", host: null, command: "Query", seconds: 400, state: null, digest: "SELECT ? FROM T" }] }) });
    expect(oneMinute[0].severity).toBe("warning");
    expect(fiveMinutes[0].severity).toBe("critical");
    // The SHAPE is reported, never the statement — see redactStatement.
    expect(oneMinute[0].detail).toContain("SELECT ? FROM T");
    expect(deriveAlerts({ ...quiet, database: metrics({ activeQueries: [{ id: 1, user: "app", host: null, command: "Query", seconds: 30, state: null, digest: "x" }] }) })).toEqual([]);
  });

  it("survives a workspace whose database could not be read", () => {
    // The database panel arrives as `{ data: null, error }` when a tenant is unreachable, and the
    // page still has services and API numbers to judge. A null must narrow the alerts, not throw.
    expect(() => deriveAlerts({ ...quiet, database: null, apiErrorRate: 9 })).not.toThrow();
    expect(deriveAlerts({ ...quiet, database: null, apiErrorRate: 9 })).toHaveLength(1);
  });
});
