/**
 * The guardrails around the platform operator's AI advisor.
 *
 * These are the tests that would have to fail before the advisor could do damage, so they are
 * written as properties of the two pure functions the whole feature funnels through:
 *
 *   `buildAdvisorFacts`  — decides what LEAVES the deployment. If a customer's data can reach a
 *                          model, it reaches it through here.
 *   `sanitiseAdvice`     — decides what the console is allowed to SHOW and offer to run. If a
 *                          hallucinated action or table name can reach an operator's button, it
 *                          arrives through here.
 *
 * Everything else in the feature — the settings row, the daily ceiling, the audit trail — is
 * ordinary plumbing. These two are the boundary, and a boundary is only real if it is asserted.
 *
 * A failure here is never "update the expectation". It means either the fact sheet grew a field
 * that carries customer data, or the sanitiser started trusting the model. Both are the bug.
 */
import { describe, expect, it } from "vitest";
import { ADVISOR_ACTIONS, buildAdvisorFacts, buildAdvisorPrompt, sanitiseAdvice } from "../../src/services/platform-ai.service.js";
import { redactStatement } from "../../src/services/platform-tenant-health.service.js";
import { summariseGrowth } from "../../src/services/tenant-db-metrics.service.js";

/* A health payload shaped like the real one, carrying deliberately identifying strings in every
   field a careless fact sheet might pick up. Nothing below should reach the model. */
const health = {
  organization: { id: "org-1", name: "Acme Corp", slug: "acme", status: "ACTIVE", planTier: "TEAM", databaseName: "tenant_acme" },
  maintenance: { data: { enabled: false, phase: "off", scheduledStartAt: null, scheduledEndAt: null, message: "Ring Priya on 555-0134 before starting" }, error: null },
  system: {
    data: {
      sampledAt: new Date().toISOString(),
      server: { hostname: "prod-api-07.internal", pid: 1, platform: "linux", arch: "x64", nodeVersion: "24", appVersion: "4.0.0", osUptimeSec: 1, processUptimeSec: 1 },
      cpu: { cores: 8, model: "x", usagePercent: 20, loadAvg: null },
      memory: { totalBytes: 1, freeBytes: 1, usedPercent: 40, processRssBytes: 1 },
      disk: null,
      network: { interfaces: [], tenantDbPingMs: 2, controlDbPingMs: 2, eventLoopLagMeanMs: 1, eventLoopLagMaxMs: 2 },
      components: []
    },
    error: null
  },
  status: {
    data: {
      from: "",
      to: "",
      days: 30,
      overall: "OPERATIONAL",
      services: [
        { key: "email", label: "Email delivery", description: "", current: "DEGRADED", currentDetail: "550 to priya.raghavan@acme.example", lastCheckedAt: null, avgLatencyMs: 1, uptimePct: 99, days: [] },
        { key: "api", label: "API", description: "", current: "OPERATIONAL", currentDetail: null, lastCheckedAt: null, avgLatencyMs: 1, uptimePct: 100, days: [] }
      ],
      incidents: [{ id: "i1", service: "email", serviceLabel: "Email delivery", status: "DEGRADED", startedAt: "", endedAt: null, detail: "mailbox priya@acme.example full", sampleCount: 1, durationMinutes: 5 }]
    },
    error: null
  },
  api: {
    data: {
      window: { hours: 720, since: "", bucketSeconds: 3600 },
      collection: { enabled: true, sampleRate: 1, flushMs: 1, retentionDays: 30, maxBuffer: 1, bufferedNow: 0, droppedSinceBoot: 0, failedSinceBoot: 0, writtenSinceBoot: 1, host: { hostname: "h", podName: null, podNamespace: null, cluster: null, osType: "linux" } },
      totals: { total: 1000, clientErrors: 10, serverErrors: 5, errorRate: 0.5, avgMs: 100, p50Ms: 50, p95Ms: 400, p99Ms: 900, maxMs: 3000, avgDbMs: 20, distinctUsers: 12, distinctHosts: 1 },
      series: [],
      endpoints: [{ apiName: "POST /api/timesheets", method: "POST", apiPath: "/api/timesheets", total: 100, clientErrors: 1, serverErrors: 0, errorRate: 1, avgMs: 10, p50Ms: 8, p95Ms: 30, p99Ms: 40, maxMs: 50, avgDbMs: 3, totalMs: 1000 }],
      hosts: [],
      statusMix: []
    },
    error: null
  },
  database: {
    data: {
      databaseName: "tenant_acme",
      host: "db.internal",
      serverVersion: "8.0.36",
      schema: {
        tableCount: 2,
        estimatedRows: 100,
        dataBytes: 2_000_000,
        indexBytes: 1_000_000,
        totalBytes: 3_000_000,
        indexShare: 0.33,
        freeBytes: 500_000,
        tablesWithoutPrimaryKey: ["_migrations"],
        indexHeavyTables: ["AuditLog"],
        engines: [{ engine: "InnoDB", tables: 2 }],
        indexCount: 5,
        widestIndexes: [],
        largestTables: [
          { name: "TimeEntry", estimatedRows: 90, dataBytes: 1_500_000, indexBytes: 800_000, totalBytes: 2_300_000, freeBytes: 400_000, fragmentation: 0.15, engine: "InnoDB", collation: "utf8mb4", avgRowBytes: 100, indexCount: 3, autoIncrementUsePercent: 12, hasPrimaryKey: true },
          { name: "AuditLog", estimatedRows: 10, dataBytes: 500_000, indexBytes: 200_000, totalBytes: 700_000, freeBytes: 100_000, fragmentation: 0.12, engine: "InnoDB", collation: "utf8mb4", avgRowBytes: 90, indexCount: 2, autoIncrementUsePercent: 4, hasPrimaryKey: true }
        ]
      },
      server: {
        scope: "server" as const,
        uptimeSec: 100,
        threadsConnected: 10,
        threadsRunning: 2,
        maxConnections: 100,
        connectionUsePercent: 10,
        slowQueries: 3,
        questions: 100,
        bufferPoolHitRate: 99.9,
        abortedConnects: 0,
        rowsExaminedPerReturned: 12,
        tmpDiskTablePercent: 2,
        openTables: 40,
        tableOpenCache: 400,
        bufferPoolBytes: 134_217_728
      },
      activeQueries: [{ id: 1, user: "app", host: "10.0.0.1:5000", command: "Query", seconds: 42, state: "Sending data", digest: "SELECT * FROM TimeEntry WHERE userId = ?" }],
      queryMs: 15
    },
    error: null
  },
  alerts: [{ severity: "warning" as const, title: "API p95 400 ms", detail: "Slowest 5% of sampled requests. Threshold: 1500 ms.", area: "api" as const }]
};

const trend = {
  points: [
    { at: "2026-08-01T00:00:00.000Z", totalBytes: 2_000_000, dataBytes: 1_500_000, indexBytes: 500_000, freeBytes: 100_000, estimatedRows: 80, tableCount: 2, queryMs: 12, connectionUsePercent: 10, bufferPoolHitRate: 99.9 },
    { at: "2026-08-31T00:00:00.000Z", totalBytes: 3_000_000, dataBytes: 2_000_000, indexBytes: 1_000_000, freeBytes: 500_000, estimatedRows: 100, tableCount: 2, queryMs: 15, connectionUsePercent: 10, bufferPoolHitRate: 99.9 }
  ],
  growth: summariseGrowth([])
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the shapes above mirror the real
// service returns field for field; typing them fully here would restate three interfaces to test a
// boundary that only cares about which STRINGS come out the other side.
const facts = () => buildAdvisorFacts({ health: health as any, trend: { ...trend, growth: summariseGrowth(trend.points) } as any, trendDays: 30 });

describe("buildAdvisorFacts — what leaves the deployment", () => {
  it("carries no customer content from any section of the health payload", () => {
    const serialised = JSON.stringify(facts());
    // Every string below is planted in the input above, in a field a careless fact sheet would
    // pick up: an admin's note, a probe's failure detail, an incident body, a hostname.
    for (const leak of ["Priya", "priya.raghavan@acme.example", "priya@acme.example", "555-0134", "prod-api-07.internal", "Ring Priya"]) {
      expect(serialised, `"${leak}" reached the model`).not.toContain(leak);
    }
  });

  it("sends the shape of the schema and nothing from inside it", () => {
    const built = facts();
    // Table names ARE sent, deliberately: the schema is the platform's own product, and advice
    // about a database that cannot name a table is not advice. Row contents are not.
    expect(built.database?.largestTables.map((table) => table.name)).toEqual(["TimeEntry", "AuditLog"]);
    expect(JSON.stringify(built)).not.toContain("userId = 'u-");
  });

  it("passes long-running statements as shapes, never as SQL with literals in it", () => {
    const built = facts();
    expect(built.longRunningQueries).toHaveLength(1);
    expect(built.longRunningQueries[0].shape).toBe("SELECT * FROM TimeEntry WHERE userId = ?");
  });

  it("labels server-wide counters as server-wide, in the payload itself", () => {
    // Not only in the UI: the model is the one being asked not to blame the tenant for the box.
    expect(facts().server?.note).toMatch(/server, which other workspaces may share/i);
  });

  it("tells the model which thresholds already fired, so it is not asked to re-derive them", () => {
    expect(facts().existingAlerts).toEqual([{ severity: "warning", title: "API p95 400 ms", detail: "Slowest 5% of sampled requests. Threshold: 1500 ms." }]);
  });

  it("puts the allowlist and the rules in the prompt, not just in the parser", () => {
    const prompt = buildAdvisorPrompt(facts());
    for (const id of Object.keys(ADVISOR_ACTIONS)) expect(prompt).toContain(id);
    expect(prompt).toMatch(/An empty list is a valid, useful answer/);
    expect(prompt).toMatch(/Never present it as this workspace's fault/);
  });
});


describe("redactStatement — the last line before a statement leaves the service", () => {
  it("strips string, numeric and hex literals", () => {
    expect(redactStatement("SELECT * FROM User WHERE email = 'priya@acme.example' AND id = 42")).toBe("SELECT * FROM User WHERE email = ? AND id = ?");
    expect(redactStatement("SELECT * FROM T WHERE k = 0xDEADBEEF")).toBe("SELECT * FROM T WHERE k = ?");
  });

  it("is not ended early by a quote inside a quoted string", () => {
    // The failure this prevents: a naive /'[^']*'/ ends the match at the escaped quote and lets
    // the REST of the literal through as if it were SQL.
    expect(redactStatement("SELECT * FROM U WHERE name = 'O\\'Brien' AND org = 'acme'")).not.toContain("Brien");
  });

  it("collapses a long IN-list rather than shipping five hundred placeholders", () => {
    expect(redactStatement("DELETE FROM T WHERE id IN (1, 2, 3, 4, 5)")).toBe("DELETE FROM T WHERE id IN (?)");
  });

  it("returns null for nothing, and clamps something enormous", () => {
    expect(redactStatement(null)).toBeNull();
    expect((redactStatement(`SELECT ${"a".repeat(5000)}`) ?? "").length).toBeLessThanOrEqual(301);
  });
});

describe("sanitiseAdvice — what the console is allowed to show", () => {
  const known = ["TimeEntry", "AuditLog"];
  const wrap = (findings: unknown[], summary = "All fine.") => JSON.stringify({ summary, findings });

  it("drops a finding whose action is not on the allowlist", () => {
    const raw = wrap([
      { severity: "critical", title: "Drop the audit table", rationale: "It is large.", action: "DROP_TABLE", tables: ["AuditLog"], confidence: "high" },
      { severity: "info", title: "Refresh statistics", rationale: "Plans have drifted.", action: "ANALYZE_TABLES", tables: ["TimeEntry"], confidence: "high" }
    ]);
    const result = sanitiseAdvice(raw, known);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].action).toBe("ANALYZE_TABLES");
  });

  it("drops table names the facts never mentioned", () => {
    // A hallucinated table would reach `runMaintenanceOperation` and produce a confusing 422 —
    // and, worse, would read to an operator as though the advisor knew something they did not.
    const result = sanitiseAdvice(wrap([{ severity: "info", title: "Analyze", rationale: "x", action: "ANALYZE_TABLES", tables: ["TimeEntry", "SecretLedger"], confidence: "high" }]), known);
    expect(result.findings[0].tables).toEqual(["TimeEntry"]);
  });

  it("clamps a flood of findings and a wall of prose", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ severity: "info", title: `Finding ${i}`, rationale: "y".repeat(2000), action: "MONITOR", tables: [], confidence: "low" }));
    const result = sanitiseAdvice(wrap(many, "z".repeat(5000)), known);
    expect(result.findings.length).toBeLessThanOrEqual(8);
    expect(result.summary.length).toBeLessThanOrEqual(900);
    expect(result.findings[0].rationale.length).toBeLessThanOrEqual(400);
  });

  it("returns nothing rather than throwing on malformed output", () => {
    // "The advisor had nothing to say" is a state the console already renders. A 500 is not.
    for (const raw of ["", "I'm sorry, I can't help with that.", "{ not json", "null", "[]"]) {
      expect(() => sanitiseAdvice(raw, known)).not.toThrow();
      expect(sanitiseAdvice(raw, known).findings).toEqual([]);
    }
  });

  it("finds the JSON inside a fenced or prefaced answer", () => {
    const raw = "Here is my analysis:\n```json\n" + wrap([{ severity: "warning", title: "Growth", rationale: "Doubling monthly.", action: "MONITOR", tables: [], confidence: "medium" }]) + "\n```";
    expect(sanitiseAdvice(raw, known).findings).toHaveLength(1);
  });

  it("orders findings by severity, because that is the order an operator reads in", () => {
    const raw = wrap([
      { severity: "info", title: "Third", rationale: "x", action: "MONITOR", tables: [], confidence: "low" },
      { severity: "critical", title: "First", rationale: "x", action: "ARM_MAINTENANCE_WINDOW", tables: [], confidence: "high" },
      { severity: "warning", title: "Second", rationale: "x", action: "REVIEW_INDEXES", tables: [], confidence: "medium" }
    ]);
    expect(sanitiseAdvice(raw, known).findings.map((finding) => finding.title)).toEqual(["First", "Second", "Third"]);
  });

  it("refuses a finding with no title or no reasoning", () => {
    // A finding without a rationale is an assertion, and an assertion is what an operator cannot
    // check. Dropping it is better than rendering a headline with nothing underneath.
    const raw = wrap([
      { severity: "critical", title: "", rationale: "x", action: "MONITOR", tables: [], confidence: "high" },
      { severity: "critical", title: "Something", rationale: "", action: "MONITOR", tables: [], confidence: "high" }
    ]);
    expect(sanitiseAdvice(raw, known).findings).toEqual([]);
  });

  it("only ever marks two actions executable, and both of them are the guarded ones", () => {
    const executable = Object.entries(ADVISOR_ACTIONS).filter(([, action]) => action.executable).map(([id]) => id);
    expect(executable.sort()).toEqual(["ANALYZE_TABLES", "OPTIMIZE_TABLES"]);
  });
});

describe("summariseGrowth", () => {
  it("refuses to extrapolate from less than a day", () => {
    const points = [
      { ...trend.points[0], at: "2026-08-01T00:00:00.000Z" },
      { ...trend.points[1], at: "2026-08-01T00:20:00.000Z" }
    ];
    // "Grew 3 MB in twenty minutes" annualises to a number an operator would have to know to
    // ignore — so it is not offered.
    expect(summariseGrowth(points).bytesPerDay).toBeNull();
    expect(summariseGrowth(points).daysToTarget).toBeNull();
  });

  it("reports a rate and a projection over a real span", () => {
    const growth = summariseGrowth(trend.points);
    expect(growth.bytesPerDay).toBeCloseTo(1_000_000 / 30, 0);
    expect(growth.percentChange).toBeCloseTo(50, 0);
    expect(growth.daysToTarget).toBeGreaterThan(0);
  });

  it("does not project when the database is flat or shrinking", () => {
    const shrinking = [trend.points[1], { ...trend.points[0], at: "2026-09-30T00:00:00.000Z" }];
    expect(summariseGrowth(shrinking).daysToTarget).toBeNull();
  });

  it("says nothing at all from a single sample", () => {
    expect(summariseGrowth([trend.points[0]])).toMatchObject({ bytesPerDay: null, percentChange: null, samples: 1 });
  });
});
