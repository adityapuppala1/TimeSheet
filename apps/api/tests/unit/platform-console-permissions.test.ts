/**
 * The platform console's permission matrix — every route, every role, driven through the REAL
 * routers and the REAL middleware.
 *
 * WHY THIS FILE EXISTS AT ALL. Before 4.1.0 there was no test anywhere over
 * `platformAdminConsoleRouter`, and there was nothing to test: `requirePlatformAdmin` proved you
 * were *an* admin and that was the entire authorization surface. Every platform admin could drop
 * any tenant's database, restore a snapshot over one, retune every plan tier and read every stored
 * credential. The matrix below IS the policy; a table in a design document that nothing executes is
 * a wish.
 *
 * NOTHING IN THE AUTH PATH IS MOCKED. `requirePlatformAdmin` runs for real against a fake control
 * database, with a genuinely signed access token per role, so this exercises the property the whole
 * design rests on: the role is read from the ADMIN ROW on every request, never from the token. A
 * demotion therefore takes effect on the next click rather than whenever a 15-minute token happens
 * to expire — and this test would go red if somebody "optimised" that into a JWT claim.
 *
 * WHAT AN ASSERTION MEANS. For a role that should be refused: exactly 403. For a role that should
 * be allowed: anything EXCEPT 403 (and except 401). The handlers run against mocked services and
 * mostly answer 200 or 500 depending on what the mock returned — which is irrelevant. The property
 * under test is the gate, not the handler, and pinning a status code per route would make this file
 * break every time an unrelated handler changed.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { PLATFORM_ROLE_CAPABILITIES, platformCapabilities, platformRoles, type PlatformCapability, type PlatformRole } from "@timesheet/shared";

const ADMIN_IDS: Record<PlatformRole, string> = {
  OWNER: "00000000-0000-4000-8000-00000000000a",
  OPERATOR: "00000000-0000-4000-8000-00000000000b",
  SUPPORT: "00000000-0000-4000-8000-00000000000c",
  BILLING: "00000000-0000-4000-8000-00000000000d",
  READ_ONLY: "00000000-0000-4000-8000-00000000000e"
};
const SESSION_ID = "00000000-0000-4000-8000-0000000000ff";
const DEACTIVATED_ID = "00000000-0000-4000-8000-000000000dead".slice(0, 36);

/* --------------------------------- the fake control plane -------------------------------- */

const adminRows = new Map<string, Record<string, unknown>>();
let sessionRevoked: Date | null = null;

const table = () => ({
  findUnique: vi.fn().mockResolvedValue(null),
  findFirst: vi.fn().mockResolvedValue(null),
  findMany: vi.fn().mockResolvedValue([]),
  count: vi.fn().mockResolvedValue(0),
  create: vi.fn().mockResolvedValue({ id: "new" }),
  createMany: vi.fn().mockResolvedValue({ count: 0 }),
  update: vi.fn().mockResolvedValue({ id: "updated" }),
  updateMany: vi.fn().mockResolvedValue({ count: 0 }),
  upsert: vi.fn().mockResolvedValue({ id: "upserted" }),
  delete: vi.fn().mockResolvedValue({ id: "deleted" }),
  deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  groupBy: vi.fn().mockResolvedValue([]),
  aggregate: vi.fn().mockResolvedValue({ _count: { _all: 0 }, _avg: { rating: null } })
});

const control = {
  platformAdminUser: {
    ...table(),
    findUnique: vi.fn(async ({ where }: { where: { id?: string } }) => (where.id ? (adminRows.get(where.id) ?? null) : null))
  },
  platformAdminSession: { ...table(), findUnique: vi.fn(async () => ({ revokedAt: sessionRevoked })) },
  platformAdminRecoveryCode: table(),
  pendingPlatformAction: table(),
  organization: table(),
  orgAuthMethod: table(),
  orgBackupPolicy: table(),
  backupDestination: table(),
  backupRun: table(),
  planTierLimit: table(),
  orgUsageSnapshot: table(),
  platformBillingSettings: table(),
  platformMailSettings: table(),
  platformEmailTemplate: table(),
  platformEmailLog: table(),
  platformAuditLog: table(),
  platformAlertSettings: table(),
  platformAlertState: table(),
  platformMaintenanceBroadcast: table(),
  trialFeedback: table(),
  salesLead: table()
};
vi.mock("../../src/config/control-prisma.js", () => ({ controlPrisma: control }));

/* ------------- everything the two routers pull in that would talk to the world ------------- */

const stub = (...names: string[]) => Object.fromEntries(names.map((n) => [n, vi.fn().mockResolvedValue({})]));

vi.mock("../../src/services/platform-audit.service.js", () => ({
  platformAudit: vi.fn().mockResolvedValue(undefined),
  platformAuditFor: () => vi.fn().mockResolvedValue(undefined)
}));
vi.mock("../../src/services/platform-mail.service.js", () => ({
  applyPlatformVars: (s: string) => s,
  getPlatformTransportStatus: vi.fn().mockResolvedValue({ configured: false }),
  renderPlatformTemplate: vi.fn().mockResolvedValue({ subject: "s", html: "h" }),
  resendPlatformEmail: vi.fn().mockResolvedValue({ ok: true, status: "SENT" }),
  resolvePlatformMailConfig: vi.fn().mockResolvedValue({ host: "" }),
  sendPlatformTemplate: vi.fn().mockResolvedValue({ ok: true })
}));
vi.mock("../../src/services/retention.service.js", () => ({
  deleteWorkspaceUnderPolicy: vi.fn().mockResolvedValue({ deleted: true }),
  getRetentionQueue: vi.fn().mockResolvedValue([]),
  getRetentionSettings: vi.fn().mockResolvedValue({}),
  runRetentionTick: vi.fn().mockResolvedValue({ sent: [], deleted: [] }),
  sendRetentionMarker: vi.fn().mockResolvedValue({ ok: true }),
  setRetentionHold: vi.fn().mockResolvedValue({}),
  updateRetentionSettings: vi.fn().mockResolvedValue({})
}));
vi.mock("../../src/services/sales-lead.service.js", () => ({
  resolveSalesInbox: vi.fn().mockResolvedValue("sales@example.test"),
  SALES_LEAD_STATUSES: ["NEW", "CONTACTED", "QUALIFIED", "WON", "LOST"] as const
}));
vi.mock("../../src/services/platform-admin-analytics.service.js", () => ({
  captureOrgUsageSnapshots: vi.fn().mockResolvedValue({ day: "2026-08-31T00:00:00.000Z", captured: 0, failed: [], prunedRows: 0 }),
  getPlatformAnalytics: vi.fn().mockResolvedValue({})
}));
vi.mock("../../src/services/platform-revenue.service.js", () => ({
  getBilledRevenueReconciliation: vi.fn().mockResolvedValue(null),
  getFleetAccountHealth: vi.fn().mockResolvedValue({ rows: [], coverage: {}, seatOverage: [] }),
  getFleetUsageTrend: vi.fn().mockResolvedValue([]),
  getOrgUsageProfile: vi.fn().mockResolvedValue({}),
  getRevenueOverview: vi.fn().mockResolvedValue({})
}));
vi.mock("../../src/services/platform-billing-reconcile.service.js", () => ({
  reconcileBilledRevenue: vi.fn().mockResolvedValue({ configured: false, attempted: 0, reconciled: 0, failed: [], at: "2026-08-31T03:50:00.000Z" })
}));
vi.mock("../../src/services/platform-email-analytics.service.js", () => ({ getPlatformEmailAnalytics: vi.fn().mockResolvedValue({}) }));
vi.mock("../../src/services/platform-backup.service.js", () => ({
  deleteSnapshot: vi.fn().mockResolvedValue({ deleted: true }),
  listSnapshots: vi.fn().mockResolvedValue([]),
  restoreSnapshot: vi.fn().mockResolvedValue({ restored: true }),
  // Rejects rather than resolving: a resolved path would send the handler into createReadStream on
  // a file that is not there, and a hung response is a hung test.
  snapshotPath: vi.fn().mockRejectedValue(new Error("no snapshot in a unit test"))
}));
vi.mock("../../src/services/platform-maintenance.service.js", () => ({
  broadcastMaintenance: vi.fn().mockResolvedValue({}),
  getFleetMaintenance: vi.fn().mockResolvedValue([]),
  listBroadcasts: vi.fn().mockResolvedValue([])
}));
vi.mock("../../src/services/platform-tenant-health.service.js", () => ({
  getDatabaseMetrics: vi.fn().mockResolvedValue({}),
  getFleetHealth: vi.fn().mockResolvedValue({}),
  getTenantHealth: vi.fn().mockResolvedValue({})
}));
vi.mock("../../src/services/platform-alerts.service.js", () => ({
  ALERT_SEVERITIES: ["critical", "warning", "info"] as const,
  deliverAlertWebhook: vi.fn().mockResolvedValue({ status: "not_configured", ok: false }),
  getAlertsOverview: vi.fn().mockResolvedValue({}),
  runAlertDigest: vi.fn().mockResolvedValue({ sent: false }),
  updateAlertSettings: vi.fn().mockResolvedValue({})
}));
vi.mock("../../src/services/tenant-schema-check.service.js", () => ({ getFleetSchemaDrift: vi.fn().mockResolvedValue({ rows: [], behind: 0 }) }));
vi.mock("../../src/services/platform-org-timeline.service.js", () => ({ getOrgTimeline: vi.fn().mockResolvedValue({ entries: [] }) }));
vi.mock("../../src/services/platform-feature-overrides.service.js", () => ({
  getOrgFeatureOverrides: vi.fn().mockResolvedValue({ overrides: {}, classified: [], grants: [] }),
  setOrgFeatureOverrides: vi.fn().mockResolvedValue({ overrides: {}, classified: [], grants: [] })
}));
vi.mock("../../src/services/tenant-db-metrics.service.js", () => ({
  getTenantDbTrend: vi.fn().mockResolvedValue({}),
  runMaintenanceOperation: vi.fn().mockResolvedValue({}),
  sampleAllTenantDatabases: vi.fn().mockResolvedValue({ sampled: 0, failed: [], prunedRows: 0 })
}));
vi.mock("../../src/services/platform-ai.service.js", () => ({
  ADVISOR_ACTIONS: [],
  adviseWorkspace: vi.fn().mockResolvedValue({}),
  decideAdvice: vi.fn().mockResolvedValue({}),
  getPlatformAiSettings: vi.fn().mockResolvedValue({}),
  listAdvice: vi.fn().mockResolvedValue([]),
  updatePlatformAiSettings: vi.fn().mockResolvedValue({})
}));
vi.mock("../../src/services/backup-destination.service.js", () => ({
  DESTINATION_FIELDS: { LOCAL: [] },
  describeSecret: () => ({}),
  encryptDestinationSecret: () => "enc",
  testDestination: vi.fn().mockResolvedValue({ ok: true })
}));
vi.mock("../../src/services/backup.service.js", () => ({
  backupEntitlement: vi.fn().mockResolvedValue({ tier: "TEAM", frequency: "DAILY", maxDestinations: 5 }),
  nextRunAt: () => new Date(),
  planRetention: () => ({ keep: [], drop: [] }),
  runBackup: vi.fn().mockResolvedValue({ status: "SUCCEEDED" }),
  runBackupTick: vi.fn().mockResolvedValue({ ran: [] }),
  sweepRetention: vi.fn().mockResolvedValue({}),
  testRestore: vi.fn().mockResolvedValue({ ok: true })
}));
vi.mock("../../src/services/provisioning.service.js", () => ({ provisionOrganization: vi.fn().mockResolvedValue({ organizationId: "o", databaseName: "d", schemaVersion: "1" }) }));
vi.mock("../../src/services/org-domain.service.js", () => stub("addDomain", "listDomains", "removeDomain", "verifyDomain"));
vi.mock("../../src/services/workspace-directory.service.js", () => ({ workspaceUrlForSlug: (s: string) => `https://${s}.example.test` }));
vi.mock("../../src/services/notify.service.js", () => ({ dispatchTransactional: vi.fn() }));
vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn() }));
vi.mock("../../src/config/with-org-tenant.js", () => ({ withOrgTenant: vi.fn(async (_s: string, fn: () => Promise<unknown>) => fn()) }));
vi.mock("../../src/config/tenant-context.js", () => ({
  requireTenantContext: () => ({ orgId: "o", orgSlug: "s", client: { user: { findFirst: vi.fn() } } }),
  tenantContext: { getStore: () => undefined }
}));

/* ------------------------------------- the app ------------------------------------------- */

let app: express.Express;
let tokenFor: Record<PlatformRole, string>;
let deactivatedToken: string;

beforeAll(async () => {
  const { platformAdminRouter } = await import("../../src/controllers/platform-admin.controller.js");
  const { platformAdminConsoleRouter } = await import("../../src/controllers/platform-admin-console.controller.js");
  const { errorHandler } = await import("../../src/middleware/error.js");
  const { signPlatformAdminAccessToken } = await import("../../src/utils/platform-admin-security.js");

  app = express();
  app.use(express.json());
  // Exactly how app.ts mounts them: both at the same prefix, the org-lifecycle router first.
  app.use("/api/platform-admin", platformAdminRouter);
  app.use("/api/platform-admin", platformAdminConsoleRouter);
  app.use(errorHandler);

  tokenFor = Object.fromEntries(platformRoles.map((role) => [role, signPlatformAdminAccessToken(ADMIN_IDS[role], SESSION_ID)])) as Record<PlatformRole, string>;
  deactivatedToken = signPlatformAdminAccessToken(DEACTIVATED_ID, SESSION_ID);
}, 60_000);

beforeEach(() => {
  sessionRevoked = null;
  adminRows.clear();
  for (const role of platformRoles) {
    adminRows.set(ADMIN_IDS[role], { id: ADMIN_IDS[role], email: `${role.toLowerCase()}@timesphere.app`, name: role, role, status: "ACTIVE", passwordHash: "x", mfaEnabled: false });
  }
  adminRows.set(DEACTIVATED_ID, { id: DEACTIVATED_ID, email: "gone@timesphere.app", name: "Gone", role: "OWNER", status: "INACTIVE", passwordHash: "x", mfaEnabled: false });
});

/* ------------------------------------- the matrix ---------------------------------------- */

const READ = platformCapabilities.PLATFORM_READ;
const SUPPORT = platformCapabilities.PLATFORM_SUPPORT;
const BILLING = platformCapabilities.PLATFORM_BILLING;
const OPERATE = platformCapabilities.PLATFORM_OPERATE;
const OWNER = platformCapabilities.PLATFORM_OWNER;

interface Route {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;
  /** The minimum capability. `null` = any signed-in operator, for the routes about your OWN account. */
  cap: PlatformCapability | null;
  body?: object;
  note?: string;
}

const ORG = "org-1";

const ROUTES: Route[] = [
  /* ---- your own account: no capability, because a READ_ONLY operator must be able to harden
     their own sign-in and end their own sessions. ---- */
  { method: "get", path: "/auth/me", cap: null },
  { method: "get", path: "/auth/mfa", cap: null },
  { method: "get", path: "/auth/sessions", cap: null },
  { method: "post", path: "/auth/sessions/revoke-others", cap: null },

  /* ---- reads ---- */
  { method: "get", path: "/organizations", cap: READ },
  { method: "get", path: `/organizations/${ORG}`, cap: READ },
  { method: "get", path: `/organizations/${ORG}/domains`, cap: READ },
  { method: "get", path: "/routing", cap: READ },
  { method: "get", path: "/plan-tier-limits", cap: READ },
  { method: "get", path: "/analytics", cap: READ },
  { method: "get", path: "/overview", cap: READ },
  { method: "get", path: "/mail-settings", cap: READ },
  { method: "get", path: "/email-templates", cap: READ },
  { method: "get", path: "/email-templates/retention.feedback/log", cap: READ },
  { method: "get", path: "/email-log", cap: READ },
  { method: "get", path: "/email-log/e-1", cap: READ },
  { method: "get", path: "/email-analytics", cap: READ },
  { method: "get", path: "/retention", cap: READ },
  { method: "get", path: "/feedback", cap: READ },
  { method: "get", path: "/sales-leads", cap: READ },
  { method: "get", path: "/audit", cap: READ },
  { method: "get", path: "/admins", cap: READ },
  { method: "get", path: "/governance/requests", cap: READ },
  { method: "get", path: "/maintenance/fleet", cap: READ },
  { method: "get", path: "/monitoring/fleet", cap: READ },
  { method: "get", path: `/monitoring/${ORG}`, cap: READ },
  { method: "get", path: `/monitoring/${ORG}/database`, cap: READ },
  { method: "get", path: `/monitoring/${ORG}/trend`, cap: READ },
  { method: "get", path: "/ai/settings", cap: READ },
  { method: "get", path: `/ai/advice/${ORG}`, cap: READ },
  { method: "get", path: "/backups/overview", cap: READ },
  { method: "get", path: "/backups", cap: READ },
  { method: "get", path: `/backups/policy/${ORG}/retention-preview`, cap: READ },
  { method: "get", path: "/analytics/summary", cap: READ },
  /* The 4.2.0 business screens. Reads are `platform:read` — every figure is aggregate, carries no
     customer content, and an operator who cannot see the business cannot run it. The list price
     those figures are derived from is edited through PATCH /plan-tier-limits/:tier below, which is
     `platform:billing`; there is deliberately no second price-editing route to keep in step. */
  { method: "get", path: "/analytics/revenue", cap: READ },
  { method: "get", path: "/analytics/health", cap: READ },
  { method: "get", path: "/analytics/usage-trend", cap: READ },
  { method: "get", path: `/analytics/org/${ORG}`, cap: READ },
  /* Billed revenue. The READ is `platform:read` like every other figure on that screen — it is an
     aggregate about our own business with no customer content in it. The WRITE beside it is the
     one action on the revenue page that is NOT `platform:operate`; see the note there. */
  { method: "get", path: "/analytics/billed-revenue", cap: READ },

  /* The 4.3.0 operational screens. All reads, all `platform:read`: an operator who cannot see what
     is broken cannot be on call for it, and the alert delivery CONFIGURATION is readable for the
     same reason a firewall rule is — knowing where alerts go is not being able to change it. Every
     write below is `platform:operate`. */
  { method: "get", path: "/alerts", cap: READ },
  { method: "get", path: "/fleet/schema-drift", cap: READ, note: "read-only on purpose — the fix is a fan-out that needs a terminal and a human watching" },
  { method: "get", path: `/organizations/${ORG}/timeline`, cap: READ },
  { method: "get", path: `/organizations/${ORG}/feature-overrides`, cap: READ },

  /* ---- support: act on a customer without changing the platform ---- */
  { method: "post", path: `/organizations/${ORG}/restore-password-login`, cap: SUPPORT },
  { method: "post", path: `/organizations/${ORG}/reset-admin-password`, cap: SUPPORT, body: { email: "owner@acme.test" } },
  { method: "post", path: "/mail-settings/test", cap: SUPPORT, body: { to: "a@b.test" } },
  { method: "post", path: "/email-templates/retention.feedback/preview", cap: SUPPORT, body: {} },
  { method: "post", path: "/email-templates/retention.feedback/test", cap: SUPPORT, body: { to: "a@b.test" } },
  { method: "post", path: "/email-log/e-1/resend", cap: SUPPORT },
  { method: "post", path: `/retention/${ORG}/send/feedback`, cap: SUPPORT },
  { method: "patch", path: "/sales-leads/l-1", cap: SUPPORT, body: { status: "CONTACTED" } },
  { method: "post", path: `/ai/advise/${ORG}`, cap: SUPPORT, body: {} },
  { method: "post", path: "/ai/advice/a-1/decision", cap: SUPPORT, body: { status: "DISMISSED", note: "no" } },

  /* ---- billing: money, and nothing that touches a customer's users ---- */
  { method: "patch", path: "/plan-tier-limits/TEAM", cap: BILLING, body: { seatLimit: 20 } },
  { method: "get", path: "/billing-settings", cap: BILLING },
  { method: "patch", path: "/billing-settings", cap: BILLING, body: { priceIdTeam: "price_x" } },
  { method: "put", path: `/backups/policy/${ORG}`, cap: BILLING, body: { enabled: false } },
  {
    method: "post",
    path: "/analytics/reconcile-billing",
    cap: BILLING,
    note: "spends our Stripe API quota and what it fetches is money — deliberately NOT platform:operate like the usage sweep beside it"
  },

  /* ---- operate: run the platform ---- */
  { method: "post", path: "/organizations", cap: OPERATE, body: { name: "Acme", slug: "acme" } },
  { method: "post", path: `/organizations/${ORG}/domains`, cap: OPERATE, body: { domain: "time.acme.test" } },
  { method: "post", path: `/organizations/${ORG}/domains/d-1/verify`, cap: OPERATE },
  { method: "delete", path: `/organizations/${ORG}/domains/d-1`, cap: OPERATE },
  { method: "post", path: `/organizations/${ORG}/provision`, cap: OPERATE, body: { adminEmail: "a@b.test", adminName: "Ann", adminPassword: "Password-12" } },
  { method: "put", path: "/mail-settings", cap: OPERATE, body: { host: "smtp.test", port: 587, secure: false } },
  { method: "put", path: "/email-templates/retention.feedback", cap: OPERATE, body: { subject: "Subject here", bodyHtml: "<p>a long enough body</p>" } },
  { method: "delete", path: "/email-templates/retention.feedback", cap: OPERATE },
  { method: "put", path: "/retention/settings", cap: OPERATE, body: { enabled: true } },
  { method: "post", path: "/retention/run", cap: OPERATE, body: { dryRun: true } },
  { method: "post", path: `/retention/${ORG}/hold`, cap: OPERATE, body: { hold: true } },
  { method: "post", path: `/retention/${ORG}/delete`, cap: OPERATE, body: { confirmSlug: "acme" } },
  { method: "post", path: "/maintenance/broadcast", cap: OPERATE, body: { organizationIds: [], enabled: true } },
  { method: "post", path: "/monitoring/sample", cap: OPERATE },
  {
    method: "post",
    path: "/analytics/snapshot",
    cap: OPERATE,
    note: "opens a connection to every tenant database in the fleet — a load decision, not a reporting one"
  },
  { method: "post", path: `/monitoring/${ORG}/operation`, cap: OPERATE, body: { operation: "ANALYZE", tables: [] } },
  { method: "put", path: "/alerts/settings", cap: OPERATE, body: { digestEnabled: true, minSeverity: "warning", recipients: [] } },
  { method: "post", path: "/alerts/digest/run", cap: OPERATE, body: { dryRun: true } },
  { method: "post", path: "/alerts/webhook/test", cap: OPERATE },
  {
    method: "put",
    path: `/organizations/${ORG}/feature-overrides`,
    cap: OPERATE,
    body: { overrides: {}, acknowledgeGrants: false },
    note: "can hand a workspace a capability its plan forbids — an operator decision, not a commercial one"
  },
  { method: "put", path: "/ai/settings", cap: OPERATE, body: { enabled: false, provider: "ANTHROPIC", model: "m", dailyCallLimit: 5 } },
  { method: "post", path: "/backups/destinations", cap: OPERATE, body: { name: "n", kind: "LOCAL", config: {} } },
  { method: "patch", path: "/backups/destinations/d-1", cap: OPERATE, body: { name: "n2" } },
  { method: "post", path: "/backups/destinations/d-1/test", cap: OPERATE },
  { method: "delete", path: "/backups/destinations/d-1", cap: OPERATE },
  { method: "post", path: `/backups/run/${ORG}`, cap: OPERATE, body: {} },
  { method: "post", path: `/backups/sweep/${ORG}`, cap: OPERATE },
  { method: "post", path: "/backups/runs/r-1/test-restore", cap: OPERATE },
  { method: "post", path: "/backups/tick", cap: OPERATE, body: { dryRun: true } },
  {
    method: "get",
    path: "/backups/snap-1/download",
    cap: OPERATE,
    note: "the one GET in the console that is not read-only — it streams a whole customer database"
  },
  { method: "post", path: "/backups/snap-1/restore", cap: OPERATE, body: { organizationId: ORG, confirmSlug: "acme" } },
  { method: "delete", path: "/backups/snap-1", cap: OPERATE },

  /* ---- owner: grant power, and countersign somebody else's irreversible action ---- */
  { method: "post", path: "/admins", cap: OWNER, body: { email: "new@timesphere.app", name: "New", role: "READ_ONLY" } },
  { method: "patch", path: `/admins/${ADMIN_IDS.SUPPORT}`, cap: OWNER, body: { status: "INACTIVE" } },
  { method: "post", path: "/governance/requests/r-1/approve", cap: OWNER }
];

const call = (route: Route, role: PlatformRole) => {
  const req = request(app)
    [route.method](`/api/platform-admin${route.path}`)
    .set("Authorization", `Bearer ${tokenFor[role]}`)
    // Every route that demands one gets one, so a 403 here is always the CAPABILITY gate and never
    // the reason gate answering 400 first.
    .set("X-Platform-Reason", encodeURIComponent("matrix test — verifying the capability gate"));
  return route.body === undefined ? req : req.send(route.body);
};

const holds = (role: PlatformRole, cap: PlatformCapability | null) => cap === null || PLATFORM_ROLE_CAPABILITIES[role].includes(cap);

describe("the role → route matrix", () => {
  for (const role of platformRoles) {
    describe(role, () => {
      for (const route of ROUTES) {
        const allowed = holds(role, route.cap);
        const label = `${route.method.toUpperCase()} ${route.path}${route.note ? ` (${route.note})` : ""}`;

        it(`${allowed ? "reaches" : "is refused"} ${label}`, async () => {
          const res = await call(route, role);
          if (allowed) {
            // Anything but a refusal. What the handler then does with mocked services is not the
            // property under test.
            expect(res.status, `${role} should reach ${label} but got ${res.status}: ${JSON.stringify(res.body)}`).not.toBe(403);
            expect(res.status).not.toBe(401);
          } else {
            expect(res.status, `${role} should be refused ${label}`).toBe(403);
          }
        });
      }
    });
  }
});

describe("the callouts, stated on their own so a regression names itself", () => {
  it("READ_ONLY cannot download a snapshot — the GET verb disguises an entire customer database leaving the building", async () => {
    const res = await call({ method: "get", path: "/backups/snap-1/download", cap: OPERATE }, "READ_ONLY");
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/platform:operate/);
  });

  it("SUPPORT cannot download a snapshot either, despite holding the customer-facing rescues", async () => {
    expect((await call({ method: "get", path: "/backups/snap-1/download", cap: OPERATE }, "SUPPORT")).status).toBe(403);
  });

  it("BILLING cannot reach the tenant rescue routes — a finance role has no business in a customer's user table", async () => {
    expect((await call({ method: "post", path: `/organizations/${ORG}/restore-password-login`, cap: SUPPORT }, "BILLING")).status).toBe(403);
    expect((await call({ method: "post", path: `/organizations/${ORG}/reset-admin-password`, cap: SUPPORT, body: { email: "a@b.test" } }, "BILLING")).status).toBe(403);
  });

  it("SUPPORT and READ_ONLY can SEE the billed-revenue gap but cannot spend Stripe quota to refresh it", async () => {
    // The split this route exists to draw: reading the discounting is a business question every
    // operator has, and re-fetching it is a call to our payment processor.
    for (const role of ["SUPPORT", "READ_ONLY"] as const) {
      expect((await call({ method: "get", path: "/analytics/billed-revenue", cap: READ }, role)).status).not.toBe(403);
      expect((await call({ method: "post", path: "/analytics/reconcile-billing", cap: BILLING }, role)).status).toBe(403);
    }
  });

  it("SUPPORT cannot move a workspace onto a different plan", async () => {
    expect((await call({ method: "patch", path: "/plan-tier-limits/TEAM", cap: BILLING, body: { seatLimit: 9 } }, "SUPPORT")).status).toBe(403);
  });

  it("OPERATOR cannot create an admin or change a role — that is the one thing only an OWNER does", async () => {
    expect((await call({ method: "post", path: "/admins", cap: OWNER, body: { email: "x@y.test", name: "Xy", role: "OWNER" } }, "OPERATOR")).status).toBe(403);
    expect((await call({ method: "patch", path: `/admins/${ADMIN_IDS.SUPPORT}`, cap: OWNER, body: { role: "OWNER" } }, "OPERATOR")).status).toBe(403);
  });
});

describe("PATCH /organizations/:id is authorised per FIELD, not per route", () => {
  const patch = (role: PlatformRole, body: object) =>
    request(app)
      .patch(`/api/platform-admin/organizations/${ORG}`)
      .set("Authorization", `Bearer ${tokenFor[role]}`)
      .set("X-Platform-Reason", encodeURIComponent("matrix test — field-level authorisation"))
      .send(body);

  beforeEach(() => {
    control.organization.findUnique.mockResolvedValue({ id: ORG, slug: "acme", name: "Acme", status: "ACTIVE", planTier: "TEAM", seatLimitOverride: null, aiMonthlyBudgetCeilingOverride: null });
    control.organization.update.mockResolvedValue({ id: ORG, slug: "acme", name: "Acme", status: "ACTIVE", planTier: "ENTERPRISE", seatLimitOverride: null, aiMonthlyBudgetCeilingOverride: null });
  });

  it("lets BILLING move the plan tier", async () => {
    expect((await patch("BILLING", { planTier: "ENTERPRISE" })).status).toBe(200);
  });

  it("refuses BILLING the lifecycle status — taking a customer offline is not a commercial decision", async () => {
    const res = await patch("BILLING", { status: "SUSPENDED" });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/platform:operate/);
  });

  it("refuses BILLING a mixed body that smuggles a status change in beside a tier change", async () => {
    expect((await patch("BILLING", { planTier: "ENTERPRISE", status: "SUSPENDED" })).status).toBe(403);
  });

  it("lets OPERATOR do both", async () => {
    expect((await patch("OPERATOR", { status: "SUSPENDED" })).status).toBe(200);
    expect((await patch("OPERATOR", { planTier: "ENTERPRISE" })).status).toBe(200);
  });

  it("refuses SUPPORT and READ_ONLY either way", async () => {
    expect((await patch("SUPPORT", { planTier: "ENTERPRISE" })).status).toBe(403);
    expect((await patch("READ_ONLY", { status: "ACTIVE" })).status).toBe(403);
  });
});

describe("the role comes from the database row, not from the token", () => {
  it("honours a demotion on the very next request, with the same token", async () => {
    const before = await call({ method: "post", path: "/monitoring/sample", cap: OPERATE }, "OPERATOR");
    expect(before.status).not.toBe(403);

    // Nothing about the token changes. Only the row does.
    adminRows.set(ADMIN_IDS.OPERATOR, { ...adminRows.get(ADMIN_IDS.OPERATOR)!, role: "READ_ONLY" });

    expect((await call({ method: "post", path: "/monitoring/sample", cap: OPERATE }, "OPERATOR")).status).toBe(403);
  });

  it("fails CLOSED on a role this build does not recognise, rather than open", async () => {
    adminRows.set(ADMIN_IDS.OWNER, { ...adminRows.get(ADMIN_IDS.OWNER)!, role: "SUPREME_LEADER" });
    expect((await call({ method: "post", path: "/monitoring/sample", cap: OPERATE }, "OWNER")).status).toBe(403);
    // …but still an authenticated READ_ONLY, so the console is usable enough to notice.
    expect((await call({ method: "get", path: "/overview", cap: READ }, "OWNER")).status).not.toBe(403);
  });

  it("refuses a deactivated admin outright, before any role question is asked", async () => {
    const res = await request(app).get("/api/platform-admin/overview").set("Authorization", `Bearer ${deactivatedToken}`);
    expect(res.status).toBe(401);
  });

  it("refuses a revoked session", async () => {
    sessionRevoked = new Date();
    expect((await call({ method: "get", path: "/overview", cap: READ }, "OWNER")).status).toBe(401);
  });

  it("refuses no token at all", async () => {
    expect((await request(app).get("/api/platform-admin/overview")).status).toBe(401);
  });
});

describe("reason-for-access is enforced at the door", () => {
  const noReason = (method: "get" | "post", path: string, body?: object) => {
    const req = request(app)[method](`/api/platform-admin${path}`).set("Authorization", `Bearer ${tokenFor.OWNER}`);
    return body ? req.send(body) : req;
  };

  it("refuses a snapshot download with no reason", async () => {
    const res = await noReason("get", "/backups/snap-1/download");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("REASON_REQUIRED");
  });

  it("refuses a tenant rescue with no reason", async () => {
    expect((await noReason("post", `/organizations/${ORG}/reset-admin-password`, { email: "a@b.test" })).status).toBe(400);
  });

  it("refuses a reason that is too short to mean anything", async () => {
    const res = await request(app).get(`/api/platform-admin/backups/snap-1/download`).set("Authorization", `Bearer ${tokenFor.OWNER}`).set("X-Platform-Reason", "because");
    expect(res.status).toBe(400);
  });

  it("does NOT demand one for an ordinary read", async () => {
    expect((await noReason("get", "/overview")).status).not.toBe(400);
  });
});
