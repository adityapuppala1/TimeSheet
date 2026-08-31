/**
 * The fleet alert digest — and above everything else, the rule that stops it becoming noise.
 *
 * WHAT IS ACTUALLY AT STAKE. Alert fatigue is not a soft problem; it is the mechanism by which a
 * working alert system stops working, and it has exactly one cause: reporting STATE on a timer
 * instead of reporting CHANGE. A digest that arrives every six hours saying the same three things
 * gets filtered, and the run that says a fourth thing gets filtered with it. So the property that
 * matters most here is a NEGATIVE one — that a second pass over an unchanged fleet sends nothing —
 * and it is the first thing tested below.
 *
 * FOUR PROPERTIES, EACH WITH ITS OWN BLOCK:
 *   1. Something wrong and new → it sends. Nothing changed → it is silent.
 *   2. What was SEEN is not what was SAID. A failed delivery must leave the alert looking new, so
 *      the next scheduled pass is the retry. Marking it reported on a send that never landed
 *      swallows the alert forever, which is the worst failure this design can have.
 *   3. The webhook degrades to "not configured" cleanly — no throw, no retry, no log spam, and no
 *      pretending a message was delivered.
 *   4. Schema drift is an alert like any other, so it inherits the whole delivery mechanism rather
 *      than needing a second one — and a fleet in step produces nothing at all.
 *
 * `diffAlerts` is PURE and is tested directly, because that rule is the whole difference between an
 * alert system and a mailing list, and a rule reachable only through a database and an SMTP server
 * is a rule nobody re-checks after touching it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
/* Type-only, so it is erased before `vi.mock`'s hoisting can care that the module is also mocked
   below — the VALUES come from the dynamic import after the mocks are in place. */
import type { FleetAlert, StoredAlertState } from "../../src/services/platform-alerts.service.js";

/* ----------------------------- the fake control plane ------------------------------ */

interface StateRow {
  id: string;
  organizationId: string;
  alertKey: string;
  severity: string;
  title: string;
  detail: string;
  area: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  lastReportedAt: Date | null;
  reportedSeverity: string | null;
  resolvedAt: Date | null;
}

let stateRows: StateRow[] = [];
let settingsRow: Record<string, unknown> | null = null;
let adminRows: Array<{ email: string; status: string }> = [];

const matchesState = (row: StateRow, where: Record<string, unknown> = {}) => {
  if ("resolvedAt" in where && where.resolvedAt === null && row.resolvedAt !== null) return false;
  if ("lastReportedAt" in where && where.lastReportedAt === null && row.lastReportedAt !== null) return false;
  if (where.organizationId && row.organizationId !== where.organizationId) return false;
  if (where.alertKey && row.alertKey !== where.alertKey) return false;
  return true;
};

const control = {
  platformAlertState: {
    findMany: vi.fn(async ({ where }: { where?: Record<string, unknown> } = {}) => stateRows.filter((row) => matchesState(row, where)).map((row) => ({ ...row }))),
    upsert: vi.fn(async ({ where, create, update }: { where: { organizationId_alertKey: { organizationId: string; alertKey: string } }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
      const key = where.organizationId_alertKey;
      const existing = stateRows.find((row) => row.organizationId === key.organizationId && row.alertKey === key.alertKey);
      if (existing) {
        Object.assign(existing, update);
        return { ...existing };
      }
      // The three nullable columns are spelled out because a real INSERT gives them SQL NULL and an
      // object spread leaves them `undefined` — and `undefined !== null` is exactly the difference
      // between "this row is open" and "this row is invisible to every `resolvedAt: null` query".
      // A fake that gets this wrong makes the anti-noise test pass for the wrong reason.
      const row = { id: `s-${stateRows.length + 1}`, lastReportedAt: null, reportedSeverity: null, resolvedAt: null, ...create } as StateRow;
      stateRows.push(row);
      return { ...row };
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = stateRows.find((entry) => entry.id === where.id);
      if (row) Object.assign(row, data);
      return row ? { ...row } : null;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const hit = stateRows.filter((row) => matchesState(row, where));
      for (const row of hit) Object.assign(row, data);
      return { count: hit.length };
    })
  },
  platformAlertSettings: {
    findUnique: vi.fn(async () => (settingsRow ? { ...settingsRow } : null)),
    upsert: vi.fn(async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
      // The column DEFAULTS from the migration, applied on the create branch. The digest's own
      // "record that a pass happened" upsert writes only `lastRunAt`, so without these a fresh row
      // would come back with `digestEnabled: undefined` and the very next pass would believe the
      // operator had switched the digest off — a fake-fidelity bug that fakes a real one.
      settingsRow = settingsRow
        ? { ...settingsRow, ...update }
        : { digestEnabled: true, minSeverity: "warning", recipients: null, webhookUrl: null, encryptedWebhookSecret: null, ...create };
      return { ...settingsRow };
    }),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      settingsRow = { ...(settingsRow ?? { id: "global" }), ...data };
      return { ...settingsRow };
    })
  },
  platformAdminUser: { findMany: vi.fn(async () => adminRows.filter((row) => row.status === "ACTIVE")) }
};
vi.mock("../../src/config/control-prisma.js", () => ({ controlPrisma: control }));

/* ------------------------------- everything outside --------------------------------- */

const sendPlatformTemplate = vi.fn().mockResolvedValue({ ok: true, status: "SENT", emailLogId: "e-1", subject: "s" });
vi.mock("../../src/services/platform-mail.service.js", () => ({ sendPlatformTemplate }));
vi.mock("../../src/services/platform-audit.service.js", () => ({ platformAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/utils/encryption.js", () => ({ encryptSecret: (v: string) => `enc:${v}`, decryptSecret: (v: string) => v.replace(/^enc:/, "") }));
vi.mock("../../src/utils/egress.js", () => ({ assertPublicEgressTarget: vi.fn().mockResolvedValue(new URL("https://hooks.example.test/x")) }));

const getFleetHealth = vi.fn();
vi.mock("../../src/services/platform-tenant-health.service.js", () => ({ getFleetHealth }));

const getFleetSchemaDrift = vi.fn();
vi.mock("../../src/services/tenant-schema-check.service.js", () => ({ getFleetSchemaDrift, TENANT_MIGRATE_COMMAND: "npm run db:migrate:tenants" }));

const { diffAlerts, reportable, worthSending, runAlertDigest, deliverAlertWebhook, sweepFleetAlerts, severityRank } = await import(
  "../../src/services/platform-alerts.service.js"
);

/* ---------------------------------- fixtures ---------------------------------------- */

const alert = (over: Partial<FleetAlert> = {}): FleetAlert => ({
  organizationId: "org-1",
  slug: "acme",
  name: "Acme Corp",
  key: "db.connections",
  severity: "warning",
  title: "Database connections at 84%",
  detail: "168 of 200. Threshold: 80%.",
  area: "database",
  ...over
});

const storedFrom = (source: FleetAlert, over: Partial<StoredAlertState> = {}): StoredAlertState => ({
  organizationId: source.organizationId,
  alertKey: source.key,
  severity: source.severity,
  title: source.title,
  detail: source.detail,
  resolvedAt: null,
  lastReportedAt: new Date("2026-08-30T00:00:00.000Z"),
  reportedSeverity: source.severity,
  firstSeenAt: new Date("2026-08-29T00:00:00.000Z"),
  ...over
});

/** A fleet row shaped like `getFleetHealth` returns one. */
const fleetRow = (alerts: Array<{ key: string; severity: string; title: string; detail: string; area: string }>, over: Record<string, unknown> = {}) => ({
  organizationId: "org-1",
  name: "Acme Corp",
  slug: "acme",
  status: "ACTIVE",
  planTier: "TEAM",
  databaseName: "acme",
  reachable: true,
  error: null,
  totalBytes: 1,
  tableCount: 1,
  estimatedRows: 1,
  queryMs: 1,
  maintenancePhase: null,
  alerts,
  ...over
});

const quietFleet = () => {
  getFleetHealth.mockResolvedValue({ rows: [fleetRow([])], totals: { databases: 1, reachable: 1, totalBytes: 1, alerts: 0 } });
  getFleetSchemaDrift.mockResolvedValue({ latest: "20260901120000_x", rows: [], behind: 0, unregistered: 0, command: "npm run db:migrate:tenants" });
};

const brokenFleet = (severity = "critical") => {
  getFleetHealth.mockResolvedValue({
    rows: [fleetRow([{ key: "db.auto_increment", severity, title: "Auto-increment 94% consumed", detail: "TimeEntry. Threshold: 70%.", area: "database" }])],
    totals: { databases: 1, reachable: 1, totalBytes: 1, alerts: 1 }
  });
  getFleetSchemaDrift.mockResolvedValue({ latest: "20260901120000_x", rows: [], behind: 0, unregistered: 0, command: "npm run db:migrate:tenants" });
};

beforeEach(() => {
  stateRows = [];
  settingsRow = null;
  adminRows = [{ email: "ops@timesphere.app", status: "ACTIVE" }];
  sendPlatformTemplate.mockClear();
  sendPlatformTemplate.mockResolvedValue({ ok: true, status: "SENT", emailLogId: "e-1", subject: "s" });
});

/* ============================== 1. the pure rule ==================================== */

describe("diffAlerts — the anti-noise rule, on its own", () => {
  it("calls a condition with no record APPEARED", () => {
    const diff = diffAlerts([], [alert()]);
    expect(diff.appeared).toHaveLength(1);
    expect(diff.unchanged).toHaveLength(0);
  });

  it("calls a condition that is exactly as reported UNCHANGED — this is the whole point", () => {
    const live = alert();
    const diff = diffAlerts([storedFrom(live)], [live]);
    expect(diff.appeared).toHaveLength(0);
    expect(diff.escalated).toHaveLength(0);
    expect(diff.unchanged).toHaveLength(1);
  });

  it("is unmoved by the NUMBER in a title changing, because that is the same condition", () => {
    // "at 84%" becoming "at 87%" is not news. If this ever splits into two conditions, every
    // percentage tick becomes an email and the noise comes back through the front door — which is
    // why the key is written beside the rule in deriveAlerts rather than derived from the words.
    const before = alert({ title: "Database connections at 84%" });
    const after = alert({ title: "Database connections at 87%" });
    expect(diffAlerts([storedFrom(before)], [after]).unchanged).toHaveLength(1);
  });

  it("calls a condition that got WORSE escalated, and carries what it was before", () => {
    const worse = alert({ severity: "critical", title: "Database connections at 91%" });
    const diff = diffAlerts([storedFrom(alert(), { reportedSeverity: "warning" })], [worse]);
    expect(diff.escalated).toHaveLength(1);
    expect(diff.escalated[0].previousSeverity).toBe("warning");
  });

  it("does NOT treat an improvement as news", () => {
    // warning → info on something already reported. Real, and not worth an email: nobody acts
    // differently, and mailing it doubles the traffic of every flapping metric.
    const better = alert({ severity: "info" });
    const diff = diffAlerts([storedFrom(alert(), { reportedSeverity: "warning" })], [better]);
    expect(diff.escalated).toHaveLength(0);
    expect(diff.unchanged).toHaveLength(1);
  });

  it("calls a reported condition that has gone CLEARED", () => {
    const diff = diffAlerts([storedFrom(alert())], []);
    expect(diff.cleared).toHaveLength(1);
  });

  it("does not announce the recovery of something nobody was ever told about", () => {
    const diff = diffAlerts([storedFrom(alert(), { lastReportedAt: null, reportedSeverity: null })], []);
    expect(diff.cleared).toHaveLength(0);
  });

  it("treats an open row nobody has been told about as APPEARED, however many sweeps have seen it", () => {
    // This is what makes a failed delivery self-healing: the sweep recorded it, nobody heard about
    // it, so it is still new. Without this an SMTP outage swallows an alert permanently.
    const live = alert();
    const diff = diffAlerts([storedFrom(live, { lastReportedAt: null, reportedSeverity: null })], [live]);
    expect(diff.appeared).toHaveLength(1);
    expect(diff.unchanged).toHaveLength(0);
  });

  it("keeps two workspaces' identical conditions apart", () => {
    const acme = alert();
    const other = alert({ organizationId: "org-2", slug: "northwind", name: "Northwind" });
    const diff = diffAlerts([storedFrom(acme)], [acme, other]);
    expect(diff.appeared).toHaveLength(1);
    expect(diff.appeared[0].organizationId).toBe("org-2");
  });
});

describe("reportable — the severity floor", () => {
  const diff = () => diffAlerts([], [alert({ severity: "info", key: "db.size" }), alert({ severity: "critical", key: "db.auto_increment" })]);

  it("drops what sits below the floor", () => {
    expect(reportable(diff(), "warning").appeared).toHaveLength(1);
    expect(reportable(diff(), "warning").appeared[0].severity).toBe("critical");
  });

  it("lets everything through at the lowest floor", () => {
    expect(reportable(diff(), "info").appeared).toHaveLength(2);
  });

  it("judges a CLEAR on the severity it had, so a critical's all-clear is never withheld", () => {
    const cleared = diffAlerts([storedFrom(alert({ severity: "critical" }), { severity: "critical", reportedSeverity: "critical" })], []);
    expect(reportable(cleared, "critical").cleared).toHaveLength(1);
  });

  it("ranks an unrecognised severity below every floor, so a value this build cannot read pages nobody", () => {
    expect(severityRank("catastrophic")).toBe(0);
    expect(severityRank(null)).toBe(0);
    const odd = diffAlerts([], [alert({ severity: "catastrophic" as never })]);
    expect(reportable(odd, "info").appeared).toHaveLength(0);
  });

  it("says plainly whether anything is worth an inbox", () => {
    expect(worthSending(reportable(diff(), "warning"))).toBe(true);
    expect(worthSending(reportable(diffAlerts([storedFrom(alert())], [alert()]), "warning"))).toBe(false);
  });
});

/* ========================= 2. the digest, end to end ================================ */

describe("runAlertDigest", () => {
  it("SENDS when something is wrong and new", async () => {
    brokenFleet();
    const result = await runAlertDigest();
    expect(result.sent).toBe(true);
    expect(result.appeared).toBe(1);
    expect(sendPlatformTemplate).toHaveBeenCalledTimes(1);
    expect(sendPlatformTemplate.mock.calls[0][0]).toBe("platform.alert_digest");
  });

  it("is SILENT on the second pass, when nothing has changed — the property that matters most", async () => {
    brokenFleet();
    await runAlertDigest();
    sendPlatformTemplate.mockClear();

    const second = await runAlertDigest();
    expect(second.sent).toBe(false);
    expect(second.appeared).toBe(0);
    expect(second.unchanged).toBe(1);
    expect(second.reason).toMatch(/nothing has changed/i);
    expect(sendPlatformTemplate).not.toHaveBeenCalled();
  });

  it("is silent on a healthy fleet, and says so differently from 'nothing changed'", async () => {
    quietFleet();
    const result = await runAlertDigest();
    expect(result.sent).toBe(false);
    expect(result.reason).toMatch(/quiet/i);
    expect(sendPlatformTemplate).not.toHaveBeenCalled();
  });

  it("speaks again when a standing condition gets WORSE", async () => {
    brokenFleet("warning");
    await runAlertDigest();
    sendPlatformTemplate.mockClear();

    brokenFleet("critical");
    const escalation = await runAlertDigest();
    expect(escalation.sent).toBe(true);
    expect(escalation.escalated).toBe(1);
    expect(sendPlatformTemplate).toHaveBeenCalledTimes(1);
  });

  it("speaks again when a reported condition clears, then goes quiet", async () => {
    brokenFleet();
    await runAlertDigest();
    sendPlatformTemplate.mockClear();

    quietFleet();
    const recovery = await runAlertDigest();
    expect(recovery.sent).toBe(true);
    expect(recovery.cleared).toBe(1);

    sendPlatformTemplate.mockClear();
    const after = await runAlertDigest();
    expect(after.sent).toBe(false);
    expect(sendPlatformTemplate).not.toHaveBeenCalled();
  });

  it("leaves an alert looking NEW when nothing could be delivered, so the next pass retries it", async () => {
    // The failure this guards against is the quiet one: mark it reported on a send that never
    // landed and the next sweep calls it unchanged, and nobody ever hears about it.
    brokenFleet();
    sendPlatformTemplate.mockResolvedValue({ ok: false, status: "FAILED", emailLogId: null, errorMessage: "relay down", subject: "s" });

    const failed = await runAlertDigest();
    expect(failed.sent).toBe(false);
    expect(failed.reason).toMatch(/stay unreported/i);

    sendPlatformTemplate.mockResolvedValue({ ok: true, status: "SENT", emailLogId: "e-1", subject: "s" });
    const retry = await runAlertDigest();
    expect(retry.sent).toBe(true);
    expect(retry.appeared).toBe(1);
  });

  it("records the sweep but sends nothing while the digest is switched off", async () => {
    settingsRow = { id: "global", digestEnabled: false, minSeverity: "warning", recipients: [], webhookUrl: null, encryptedWebhookSecret: null };
    brokenFleet();
    const result = await runAlertDigest();
    expect(result.sent).toBe(false);
    expect(result.reason).toMatch(/switched off/i);
    expect(sendPlatformTemplate).not.toHaveBeenCalled();
    // Recorded anyway — turning it back on must not produce a backlog of everything that happened
    // while it was off.
    expect(stateRows).toHaveLength(1);
  });

  it("previews without sending and without recording, so the button is safe to press twice", async () => {
    brokenFleet();
    const preview = await runAlertDigest({ dryRun: true });
    expect(preview.sent).toBe(false);
    expect(preview.appeared).toBe(1);
    expect(sendPlatformTemplate).not.toHaveBeenCalled();
    expect(stateRows).toHaveLength(0);

    // …and the real run afterwards still reports it, because the preview consumed nothing.
    const real = await runAlertDigest();
    expect(real.sent).toBe(true);
  });

  it("falls back to every ACTIVE platform admin when no recipient list is configured", async () => {
    adminRows = [
      { email: "one@timesphere.app", status: "ACTIVE" },
      { email: "two@timesphere.app", status: "ACTIVE" },
      { email: "gone@timesphere.app", status: "INACTIVE" }
    ];
    brokenFleet();
    const result = await runAlertDigest();
    expect(result.recipients).toBe(2);
    expect(sendPlatformTemplate).toHaveBeenCalledTimes(2);
  });

  it("keeps one bad address from costing the other operators their alert", async () => {
    adminRows = [
      { email: "one@timesphere.app", status: "ACTIVE" },
      { email: "two@timesphere.app", status: "ACTIVE" }
    ];
    brokenFleet();
    sendPlatformTemplate.mockRejectedValueOnce(new Error("550 no such user"));
    const result = await runAlertDigest();
    expect(result.mailed).toBe(1);
    expect(result.sent).toBe(true);
  });
});

/* ============================ 3. the webhook ======================================== */

describe("the outbound webhook", () => {
  it("degrades to NOT CONFIGURED — no throw, no pretending", async () => {
    settingsRow = null;
    const outcome = await deliverAlertWebhook({ event: "platform.alert_digest" });
    expect(outcome).toEqual({ status: "not_configured", ok: false });
  });

  it("degrades cleanly when a row exists but carries no URL", async () => {
    settingsRow = { id: "global", digestEnabled: true, minSeverity: "warning", recipients: [], webhookUrl: null, encryptedWebhookSecret: null };
    expect((await deliverAlertWebhook({ event: "platform.alert_digest" })).status).toBe("not_configured");
  });

  it("does not count an unconfigured webhook as a delivery, so the email is what decides", async () => {
    brokenFleet();
    sendPlatformTemplate.mockResolvedValue({ ok: false, status: "FAILED", emailLogId: null, errorMessage: "relay down", subject: "s" });
    const result = await runAlertDigest();
    expect(result.webhook?.status).toBe("not_configured");
    expect(result.sent).toBe(false);
  });

  it("signs the body when a secret is set, and posts unsigned when one is not", async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchMock = vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
      seen.push(init.headers);
      return { ok: true, status: 200 } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    settingsRow = { id: "global", digestEnabled: true, minSeverity: "warning", recipients: [], webhookUrl: "https://hooks.example.test/x", encryptedWebhookSecret: "enc:shhh" };
    expect((await deliverAlertWebhook({ event: "platform.alert_digest" })).ok).toBe(true);
    expect(seen[0]["X-TimeSphere-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);

    settingsRow = { ...settingsRow, encryptedWebhookSecret: null };
    await deliverAlertWebhook({ event: "platform.alert_digest" });
    // Slack and Teams incoming webhooks verify nothing; demanding a secret would make the common
    // case impossible for no gain.
    expect(seen[1]["X-TimeSphere-Signature"]).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("reports a receiver's error status as an outcome rather than throwing it at the worker", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 }) as Response));
    settingsRow = { id: "global", digestEnabled: true, minSeverity: "warning", recipients: [], webhookUrl: "https://hooks.example.test/x", encryptedWebhookSecret: null };
    expect((await deliverAlertWebhook({ event: "x" })).status).toBe("http_404");
    vi.unstubAllGlobals();
  });

  it("reports a network failure as an outcome too, and records it on the settings row", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    settingsRow = { id: "global", digestEnabled: true, minSeverity: "warning", recipients: [], webhookUrl: "https://hooks.example.test/x", encryptedWebhookSecret: null };
    const outcome = await deliverAlertWebhook({ event: "x" });
    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe("failed");
    expect(String(settingsRow.lastWebhookStatus)).toMatch(/failed/);
    vi.unstubAllGlobals();
  });

  it("lets a webhook alone count as delivery when every email failed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200 }) as Response));
    settingsRow = { id: "global", digestEnabled: true, minSeverity: "warning", recipients: [], webhookUrl: "https://hooks.example.test/x", encryptedWebhookSecret: null };
    brokenFleet();
    sendPlatformTemplate.mockResolvedValue({ ok: false, status: "FAILED", emailLogId: null, errorMessage: "relay down", subject: "s" });
    const result = await runAlertDigest();
    expect(result.sent).toBe(true);
    vi.unstubAllGlobals();
  });
});

/* ========================== 4. schema drift as an alert ============================= */

describe("schema drift rides the same rails", () => {
  it("produces a CRITICAL alert naming the command that fixes it", async () => {
    getFleetHealth.mockResolvedValue({ rows: [fleetRow([])], totals: { databases: 1, reachable: 1, totalBytes: 1, alerts: 0 } });
    getFleetSchemaDrift.mockResolvedValue({
      latest: "20260901120000_x",
      rows: [{ organizationId: "org-1", name: "Acme Corp", slug: "acme", status: "ACTIVE", databaseName: "acme", schemaVersion: "20260101000000_old", migratedAt: null, behind: true }],
      behind: 1,
      unregistered: 0,
      command: "npm run db:migrate:tenants"
    });

    const sweep = await sweepFleetAlerts();
    const drift = sweep.alerts.find((entry) => entry.key === "schema.drift")!;
    expect(drift.severity).toBe("critical");
    expect(drift.detail).toContain("npm run db:migrate:tenants");
    expect(drift.detail).toContain("20260901120000_x");
  });

  it("reports NOTHING when the whole fleet is in step", async () => {
    getFleetHealth.mockResolvedValue({ rows: [fleetRow([])], totals: { databases: 1, reachable: 1, totalBytes: 1, alerts: 0 } });
    getFleetSchemaDrift.mockResolvedValue({
      latest: "20260901120000_x",
      rows: [{ organizationId: "org-1", name: "Acme Corp", slug: "acme", status: "ACTIVE", databaseName: "acme", schemaVersion: "20260901120000_x", migratedAt: null, behind: false }],
      behind: 0,
      unregistered: 0,
      command: "npm run db:migrate:tenants"
    });

    const sweep = await sweepFleetAlerts();
    expect(sweep.alerts).toEqual([]);
    expect((await runAlertDigest()).sent).toBe(false);
  });

  it("separates a workspace that could not be read at all from one with no alerts", async () => {
    // An unreachable database produces NO alerts, which on a list looks exactly like a healthy
    // workspace. Reported as its own list for that reason.
    getFleetHealth.mockResolvedValue({
      rows: [fleetRow([], { reachable: false, error: "Access denied" })],
      totals: { databases: 1, reachable: 0, totalBytes: 0, alerts: 0 }
    });
    getFleetSchemaDrift.mockResolvedValue({ latest: "x", rows: [], behind: 0, unregistered: 0, command: "c" });

    const sweep = await sweepFleetAlerts();
    expect(sweep.alerts).toEqual([]);
    expect(sweep.unreachable).toHaveLength(1);
    expect(sweep.unreachable[0].error).toBe("Access denied");
  });
});
