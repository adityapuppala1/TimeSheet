/**
 * The nightly usage sweep — the thing that makes every historical number in the platform console
 * possible, and the thing that silently corrupts all of them if it is wrong.
 *
 * THREE PROPERTIES, EACH THE SHAPE OF A REAL FAILURE:
 *
 *  1. ONE ROW PER WORKSPACE PER DAY. The table's whole grain. A sweep that wrote two rows for one
 *     day would double that workspace inside every fleet total that sums the day — an MRR figure
 *     an operator quotes, silently wrong, with nothing in the UI to hint at it.
 *  2. IDEMPOTENT ON A RE-RUN. The worker skips-rather-than-queues, an operator can trigger a pass
 *     by hand, and a retried night must correct the day rather than append to it. This is (1)
 *     under adversarial conditions, and it is the one that only fails in production.
 *  3. ONE UNREACHABLE TENANT DOES NOT ABORT THE SWEEP. Thirty-nine good rows are exactly what let
 *     an operator SEE that the fortieth is missing. A pass that dies on the first bad DSN produces
 *     nothing, on the night it matters most.
 *
 * It also pins the aggregate-only boundary: the capture reads counts, group-by counts and sums,
 * and nothing that could carry a ticket title, a comment or a person out of a tenant database.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/* ------------------------------- the fake control plane ---------------------------------- */

interface OrgRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  planTier: string;
  seatLimitOverride: number | null;
  aiMonthlyBudgetCeilingOverride: number | null;
  trialStartedAt: Date | null;
  trialEndsAt: Date | null;
  trialTier: string | null;
  stripeSubscriptionId: string | null;
  createdAt: Date;
  database: { encryptedDsn: string } | null;
}

let orgs: OrgRow[] = [];
/** Keyed exactly the way the UNIQUE index is, so a second write to the same key can only ever
 *  update — which is the property under test, expressed as the fixture's own storage. */
const snapshots = new Map<string, Record<string, unknown>>();
let deletedBefore: Date | null = null;

const control = {
  organization: { findMany: vi.fn(async () => orgs) },
  planTierLimit: {
    findMany: vi.fn(async () => [
      { tier: "STARTER", seatLimit: 10, aiMonthlyBudgetCeilingUsd: 0 },
      { tier: "TEAM", seatLimit: 1_000_000, aiMonthlyBudgetCeilingUsd: 200 },
      { tier: "ENTERPRISE", seatLimit: 1_000_000, aiMonthlyBudgetCeilingUsd: 5000 }
    ])
  },
  tenantDbSample: { findFirst: vi.fn(async () => ({ totalBytes: 12_345 })) },
  orgUsageSnapshot: {
    upsert: vi.fn(async ({ where, update, create }: { where: { organizationId_day: { organizationId: string; day: Date } }; update: Record<string, unknown>; create: Record<string, unknown> }) => {
      const key = `${where.organizationId_day.organizationId}|${where.organizationId_day.day.toISOString()}`;
      const existing = snapshots.get(key);
      snapshots.set(key, existing ? { ...existing, ...update } : { ...create });
      return snapshots.get(key)!;
    }),
    deleteMany: vi.fn(async ({ where }: { where: { day: { lt: Date } } }) => {
      deletedBefore = where.day.lt;
      return { count: 0 };
    })
  }
};
vi.mock("../../src/config/control-prisma.js", () => ({ controlPrisma: control }));

/* --------------------------------- the fake tenants -------------------------------------- */

/** Which slugs blow up when their database is opened. */
const unreachable = new Set<string>();

const tenantClient = {
  user: {
    count: vi.fn(async ({ where }: { where: { isAgent: boolean } }) => (where.isAgent ? 2 : 7)),
    aggregate: vi.fn(async () => ({ _max: { lastLoginAt: new Date("2026-08-30T10:00:00Z") } }))
  },
  ticket: {
    groupBy: vi.fn(async () => [
      { status: "OPEN", _count: { _all: 4 } },
      { status: "IN_PROGRESS", _count: { _all: 2 } },
      { status: "REOPENED", _count: { _all: 1 } },
      { status: "CLOSED", _count: { _all: 9 } }
    ])
  },
  aIUsageLog: { aggregate: vi.fn(async () => ({ _sum: { costUsdEstimate: 12.5 } })) },
  emailLog: {
    groupBy: vi.fn(async () => [
      { status: "SENT", _count: { _all: 30 } },
      { status: "FAILED", _count: { _all: 3 } },
      { status: "QUEUED", _count: { _all: 1 } }
    ])
  }
};

vi.mock("../../src/config/prisma.js", () => ({
  getTenantClient: vi.fn(async (orgId: string) => {
    if (unreachable.has(orgId)) throw new Error("ECONNREFUSED 10.0.0.9:3306");
    return tenantClient;
  }),
  prisma: {},
  disconnectAllTenantClients: vi.fn()
}));
vi.mock("../../src/config/tenant-context.js", () => ({
  tenantContext: { run: (_store: unknown, fn: () => Promise<unknown>) => fn(), getStore: () => undefined }
}));
vi.mock("../../src/utils/encryption.js", () => ({ decryptSecret: (value: string) => value, encryptSecret: (value: string) => value }));

const { captureOrgUsageSnapshots, startOfUtcDay, USAGE_SNAPSHOT_RETENTION_DAYS } = await import("../../src/services/platform-admin-analytics.service.js");

const org = (id: string, overrides: Partial<OrgRow> = {}): OrgRow => ({
  id,
  slug: id,
  name: id.toUpperCase(),
  status: "ACTIVE",
  planTier: "TEAM",
  seatLimitOverride: null,
  aiMonthlyBudgetCeilingOverride: null,
  trialStartedAt: null,
  trialEndsAt: null,
  trialTier: null,
  stripeSubscriptionId: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  database: { encryptedDsn: "mysql://x" },
  ...overrides
});

const NOW = new Date("2026-08-31T03:40:00Z");

beforeEach(() => {
  snapshots.clear();
  unreachable.clear();
  deletedBefore = null;
  orgs = [org("acme"), org("globex"), org("initech")];
  vi.clearAllMocks();
  // Re-seated per test, not declared once: `clearAllMocks` wipes CALLS but keeps implementations,
  // so a test that re-points `user.count` would otherwise leak its seat count into the next one.
  tenantClient.user.count.mockImplementation(async ({ where }: { where: { isAgent: boolean } }) => (where.isAgent ? 2 : 7));
});

describe("captureOrgUsageSnapshots", () => {
  it("writes exactly one row per workspace, keyed to midnight UTC of the day", async () => {
    const result = await captureOrgUsageSnapshots(NOW);

    expect(result.captured).toBe(3);
    expect(snapshots.size).toBe(3);
    // The grain. Every key carries the SAME day, and that day is midnight UTC — not the moment the
    // sweep happened to run, which would give a re-run at 04:00 its own row.
    for (const key of snapshots.keys()) {
      expect(key.endsWith("|2026-08-31T00:00:00.000Z")).toBe(true);
    }
    expect(startOfUtcDay(NOW).toISOString()).toBe("2026-08-31T00:00:00.000Z");
  });

  it("is idempotent: a second pass on the same day updates the row instead of adding one", async () => {
    await captureOrgUsageSnapshots(NOW);
    // A later run of the same day, with the workspace having grown by one seat.
    tenantClient.user.count.mockImplementation(async ({ where }: { where: { isAgent: boolean } }) => (where.isAgent ? 2 : 8));
    const second = await captureOrgUsageSnapshots(new Date("2026-08-31T19:00:00Z"));

    expect(second.captured).toBe(3);
    // THE ASSERTION THAT MATTERS. Three workspaces, two passes, three rows — not six. Without the
    // per-day uniqueness every fleet total that sums a day would double.
    expect(snapshots.size).toBe(3);
    expect(snapshots.get("acme|2026-08-31T00:00:00.000Z")!.activeSeats).toBe(8);
  });

  it("keeps sweeping after a workspace whose database cannot be opened", async () => {
    unreachable.add("globex");
    const result = await captureOrgUsageSnapshots(NOW);

    // The sweep completed. Every workspace has a row, including the broken one.
    expect(result.captured).toBe(3);
    expect(snapshots.size).toBe(3);
    expect(result.failed.map((f) => f.slug)).toEqual(["globex"]);
    expect(result.failed[0].error).toMatch(/ECONNREFUSED/);
  });

  it("marks the unreachable workspace rather than writing a false zero", async () => {
    unreachable.add("globex");
    await captureOrgUsageSnapshots(NOW);

    const broken = snapshots.get("globex|2026-08-31T00:00:00.000Z")!;
    expect(broken.reachable).toBe(false);
    // The CONTROL plane's own facts survive: a workspace that cannot be read is still on a plan,
    // still has a status, and still belongs to a cohort.
    expect(broken.planTier).toBe("TEAM");
    expect(broken.status).toBe("ACTIVE");

    const healthy = snapshots.get("acme|2026-08-31T00:00:00.000Z")!;
    expect(healthy.reachable).toBe(true);
  });

  it("writes a row for a workspace that has no database at all", async () => {
    orgs.push(org("newco", { status: "PROVISIONING", database: null }));
    await captureOrgUsageSnapshots(NOW);

    const row = snapshots.get("newco|2026-08-31T00:00:00.000Z")!;
    expect(row.reachable).toBe(false);
    expect(row.activeSeats).toBe(0);
    expect(row.status).toBe("PROVISIONING");
  });

  it("counts human seats and agent identities separately, and never merges them", async () => {
    await captureOrgUsageSnapshots(NOW);
    const row = snapshots.get("acme|2026-08-31T00:00:00.000Z")!;

    // The billable figure excludes automation identities — the same predicate countActiveSeats()
    // uses. Two columns, because only one of them is ever priced.
    expect(row.activeSeats).toBe(7);
    expect(row.agentSeats).toBe(2);
  });

  it("records the backlog and the total from the same status map", async () => {
    await captureOrgUsageSnapshots(NOW);
    const row = snapshots.get("acme|2026-08-31T00:00:00.000Z")!;

    expect(row.ticketsTotal).toBe(16);
    // OPEN + IN_PROGRESS + REOPENED. A reopened ticket is open again; counting it as done makes a
    // struggling workspace look calm.
    expect(row.ticketsOpen).toBe(7);
    expect(row.ticketCountsByStatus).toEqual({ OPEN: 4, IN_PROGRESS: 2, REOPENED: 1, CLOSED: 9 });
  });

  it("resolves the seat ceiling from the org override first, then the tier", async () => {
    orgs = [org("acme", { seatLimitOverride: 25 }), org("small", { planTier: "STARTER" })];
    await captureOrgUsageSnapshots(NOW);

    expect(snapshots.get("acme|2026-08-31T00:00:00.000Z")!.seatLimit).toBe(25);
    expect(snapshots.get("small|2026-08-31T00:00:00.000Z")!.seatLimit).toBe(10);
  });

  it("uses the TRIAL tier's ceiling while a trial is still running", async () => {
    // The workspace has paid for nothing (STARTER) but is entitled to TEAM until the clock runs
    // out. Recording Starter's ten-seat ceiling would show a trialling customer as over its limit.
    orgs = [org("trialling", { planTier: "STARTER", trialTier: "TEAM", trialEndsAt: new Date("2026-09-15T00:00:00Z") })];
    await captureOrgUsageSnapshots(NOW);
    expect(snapshots.get("trialling|2026-08-31T00:00:00.000Z")!.seatLimit).toBe(1_000_000);
  });

  it("carries the commercial state as it stood that day", async () => {
    orgs = [org("acme", { trialStartedAt: new Date("2026-08-01T00:00:00Z"), trialEndsAt: new Date("2026-08-15T00:00:00Z"), trialTier: "TEAM", stripeSubscriptionId: "sub_1" })];
    await captureOrgUsageSnapshots(NOW);
    const row = snapshots.get("acme|2026-08-31T00:00:00.000Z")!;

    expect(row.trialTier).toBe("TEAM");
    expect(row.stripeSubscriptionId).toBe("sub_1");
    expect((row.trialEndsAt as Date).toISOString()).toBe("2026-08-15T00:00:00.000Z");
  });

  it("copies the database size from the hourly sampler rather than measuring it again", async () => {
    await captureOrgUsageSnapshots(NOW);
    expect(snapshots.get("acme|2026-08-31T00:00:00.000Z")!.databaseBytes).toBe(12_345);
    // The whole point: no second metadata query per workspace per night.
    expect(control.tenantDbSample.findFirst).toHaveBeenCalledTimes(3);
  });

  it("prunes beyond the retention horizon, measured from the captured day", async () => {
    await captureOrgUsageSnapshots(NOW);
    expect(deletedBefore).not.toBeNull();
    const expected = new Date(startOfUtcDay(NOW).getTime() - USAGE_SNAPSHOT_RETENTION_DAYS * 86_400_000);
    expect(deletedBefore!.toISOString()).toBe(expected.toISOString());
    // Three years, not the sampler's 400 days: a cohort table is about what a customer who signed
    // up two years ago is doing now, and a series that has forgotten them cannot answer it.
    expect(USAGE_SNAPSHOT_RETENTION_DAYS).toBeGreaterThanOrEqual(1095);
  });

  it("reads only aggregates out of a tenant database", async () => {
    await captureOrgUsageSnapshots(NOW);

    // The boundary this whole service exists to hold, asserted as the SET of tenant calls made.
    // A `findMany` appearing here would mean rows — titles, comments, people — are being read.
    expect(tenantClient.user.count).toHaveBeenCalled();
    expect(tenantClient.user.aggregate).toHaveBeenCalled();
    expect(tenantClient.ticket.groupBy).toHaveBeenCalled();
    expect(tenantClient.aIUsageLog.aggregate).toHaveBeenCalled();
    expect(tenantClient.emailLog.groupBy).toHaveBeenCalled();
    expect(tenantClient).not.toHaveProperty("timeEntry");
    // `groupBy` on tickets selects `status` only — never a title.
    expect(tenantClient.ticket.groupBy.mock.calls[0][0]).toEqual({ by: ["status"], _count: { _all: true } });
  });
});
