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

const metrics = (over: {
  connectionUsePercent?: number | null;
  bufferPoolHitRate?: number | null;
  totalBytes?: number;
  queryMs?: number;
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
    largestTables: []
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
    abortedConnects: 0
  },
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
      ...deriveAlerts({ ...quiet, apiP95Ms: 2_000 })
    ];
    expect(all).toHaveLength(6);
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

  it("survives a workspace whose database could not be read", () => {
    // The database panel arrives as `{ data: null, error }` when a tenant is unreachable, and the
    // page still has services and API numbers to judge. A null must narrow the alerts, not throw.
    expect(() => deriveAlerts({ ...quiet, database: null, apiErrorRate: 9 })).not.toThrow();
    expect(deriveAlerts({ ...quiet, database: null, apiErrorRate: 9 })).toHaveLength(1);
  });
});
