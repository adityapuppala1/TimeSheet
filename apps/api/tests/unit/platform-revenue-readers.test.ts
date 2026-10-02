/**
 * The revenue READERS — what turns the snapshot table into the two sides of a churn window. The
 * arithmetic is pinned in platform-revenue.test.ts; this file pins WHICH rows reach it:
 *
 *  - the churn/NRR start cohort is the paying fleet on the window's FIRST snapshot day. A workspace
 *    whose first row arrives on day 20 is new business, never part of the starting cohort;
 *  - a night the tenant database could not be read is not a downgrade. Its seats are the last
 *    reading that DID reach the database, carried forward and flagged as unmeasured;
 *  - the window is read with a narrow select, not as whole snapshot rows.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Snap {
  organizationId: string;
  day: Date;
  capturedAt: Date;
  planTier: string;
  status: string;
  activeSeats: number;
  agentSeats: number;
  seatLimit: number;
  trialEndsAt: Date | null;
  trialTier: string | null;
  stripeSubscriptionId: string | null;
  reachable: boolean;
  /** Read only by the health scorer's ticket velocity. */
  ticketsTotal?: number;
  lastActivityAt?: Date | null;
}

type Where = {
  day?: { gte?: Date; lt?: Date };
  organizationId?: string | { in: string[] };
  reachable?: boolean;
  status?: string;
  activeSeats?: { gt: number };
};

let snaps: Snap[] = [];
let orgs: Array<Record<string, unknown>> = [];

const matches = (row: Snap, where: Where | undefined) => {
  if (!where) return true;
  if (where.day?.gte && row.day < where.day.gte) return false;
  if (where.day?.lt && !(row.day < where.day.lt)) return false;
  if (typeof where.organizationId === "string" && row.organizationId !== where.organizationId) return false;
  if (where.organizationId && typeof where.organizationId === "object" && !where.organizationId.in.includes(row.organizationId)) return false;
  if (where.reachable !== undefined && row.reachable !== where.reachable) return false;
  if (where.status && row.status !== where.status) return false;
  if (where.activeSeats && !(row.activeSeats > where.activeSeats.gt)) return false;
  return true;
};
const ordered = (rows: Snap[], orderBy?: { day?: "asc" | "desc" }) =>
  [...rows].sort((a, b) => (a.day.getTime() - b.day.getTime()) * (orderBy?.day === "desc" ? -1 : 1));

const control = {
  planTierLimit: {
    findMany: vi.fn(async () => [
      { tier: "STARTER", listPricePerSeatMinor: 0, listPriceCurrency: "USD" },
      { tier: "TEAM", listPricePerSeatMinor: 800, listPriceCurrency: "USD" },
      { tier: "ENTERPRISE", listPricePerSeatMinor: null, listPriceCurrency: "USD" }
    ])
  },
  organization: {
    findMany: vi.fn(async () => orgs),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => orgs.find((o) => o.id === where.id) ?? null)
  },
  orgUsageSnapshot: {
    findMany: vi.fn(async ({ where, orderBy }: { where?: Where; orderBy?: { day?: "asc" | "desc" } }) => ordered(snaps.filter((r) => matches(r, where)), orderBy)),
    findFirst: vi.fn(async ({ where, orderBy }: { where?: Where; orderBy?: { day?: "asc" | "desc" } }) => ordered(snaps.filter((r) => matches(r, where)), orderBy)[0] ?? null)
  },
  platformAuditLog: { findMany: vi.fn(async () => []) },
  backupRun: { groupBy: vi.fn(async () => []), count: vi.fn(async () => 0) }
};
vi.mock("../../src/config/control-prisma.js", () => ({ controlPrisma: control }));
vi.mock("../../src/config/env.js", () => ({ env: { TZ: "Asia/Kolkata" } }));
vi.mock("../../src/services/stripe-client.service.js", () => ({ isStripeConfigured: async () => false, DEAD_SUBSCRIPTION_STATUSES: new Set(), BILLABLE_SUBSCRIPTION_STATUSES: new Set(["active", "past_due"]) }));

const { getFleetAccountHealth, getOrgUsageProfile, getRevenueOverview } = await import("../../src/services/platform-revenue.service.js");

const NOW = new Date("2026-10-02T06:00:00Z"); // 11:30 IST on 2 Oct
const date = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const snap = (organizationId: string, day: string, patch: Partial<Snap> = {}): Snap => ({
  organizationId,
  day: date(day),
  capturedAt: new Date(date(day).getTime() - 2 * 60 * 60 * 1000),
  planTier: "TEAM",
  status: "ACTIVE",
  activeSeats: 10,
  agentSeats: 0,
  seatLimit: 1_000_000,
  trialEndsAt: null,
  trialTier: null,
  stripeSubscriptionId: null,
  reachable: true,
  ...patch
});
const org = (id: string, patch: Record<string, unknown> = {}) => ({
  id,
  slug: id,
  name: id.toUpperCase(),
  createdAt: new Date("2026-01-01T00:00:00Z"),
  status: "ACTIVE",
  planTier: "TEAM",
  trialStartedAt: null,
  trialEndsAt: null,
  trialTier: null,
  stripeSubscriptionId: null,
  convertedAt: null,
  retentionDeletedAt: null,
  ...patch
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  snaps = [];
  orgs = [];
});

describe("getRevenueOverview — the churn window's two sides", () => {
  it("starts the cohort with the fleet on the window's FIRST day — a workspace provisioned on day 20 is new", async () => {
    orgs = [org("a"), org("b")];
    snaps = [
      snap("a", "2026-09-02"),
      snap("a", "2026-10-02"),
      // B's first row is three weeks into the window. Taking "each org's first row" put it in the
      // starting cohort, booked its growth as NRR expansion and hid it from "new".
      snap("b", "2026-09-22", { activeSeats: 10 }),
      snap("b", "2026-10-02", { activeSeats: 20 })
    ];
    const overview = await getRevenueOverview(30);
    expect(overview.churn.startAccounts).toBe(1);
    expect(overview.churn.startMrrMinor).toBe(8_000);
    expect(overview.churn.newAccounts).toBe(1);
    expect(overview.churn.expansionMinor).toBe(0);
    expect(overview.churn.netRevenueRetentionPercent).toBe(100);
    expect(overview.churn.windowDays).toBe(30);
  });

  it("carries the last reachable seat count over an unreachable night instead of reading it as contraction", async () => {
    orgs = [org("a"), org("c")];
    snaps = [
      snap("a", "2026-09-02"),
      snap("a", "2026-10-01"),
      // Last night A's database did not answer: the row carries 0 seats and reachable: false.
      snap("a", "2026-10-02", { activeSeats: 0, reachable: false }),
      // C has not been reachable for the whole window; its last good reading is from August.
      snap("c", "2026-08-20", { activeSeats: 5 }),
      snap("c", "2026-09-02", { activeSeats: 0, reachable: false }),
      snap("c", "2026-10-02", { activeSeats: 0, reachable: false })
    ];
    const overview = await getRevenueOverview(30);
    expect(overview.mrr.mrrMinor).toBe(8_000 + 4_000);
    expect(overview.mrr.unmeasuredAccounts).toBe(2);
    expect(overview.churn.contractionMinor).toBe(0);
    expect(overview.churn.churnedAccounts).toBe(0);
    expect(overview.churn.netRevenueRetentionPercent).toBe(100);
    expect(overview.churn.unmeasuredAccounts).toBe(2);
  });

  it("reads the window with a narrow select, not whole snapshot rows", async () => {
    orgs = [org("a")];
    snaps = [snap("a", "2026-09-02"), snap("a", "2026-10-02")];
    await getRevenueOverview(30);
    const windowRead = control.orgUsageSnapshot.findMany.mock.calls[0][0] as { select?: Record<string, boolean> };
    expect(windowRead.select).toBeDefined();
    expect(windowRead.select).not.toHaveProperty("ticketCountsByStatus");
    expect(windowRead.select).toHaveProperty("reachable", true);
  });

  it("treats a converted trial whose clock was never cleared as revenue, not as a running trial", async () => {
    // Converted by hand before the console cleared trial clocks: planTier TEAM, trialTier still set,
    // trialEndsAt in the future. isConverted says it pays, so it is not pipeline.
    orgs = [org("a")];
    snaps = [snap("a", "2026-10-02", { trialTier: "TEAM", trialEndsAt: new Date("2026-10-20T00:00:00Z") })];
    const overview = await getRevenueOverview(30);
    expect(overview.mrr.mrrMinor).toBe(8_000);
    expect(overview.mrr.trialingAccounts).toBe(0);
  });
});

describe("getRevenueOverview — trial to paid", () => {
  it("renders median days to convert from the recorded conversion moment", async () => {
    // A trial converted by hand: clock and trial tier cleared, a paid plan, no Stripe. The page read
    // four audit actions nothing writes, so this figure could never render.
    orgs = [org("h", { trialStartedAt: new Date("2026-09-05T06:00:00Z"), trialEndsAt: null, trialTier: null, planTier: "TEAM", convertedAt: new Date("2026-09-15T06:00:00Z") })];
    snaps = [snap("h", "2026-10-02")];
    const overview = await getRevenueOverview(30);
    expect(overview.trials.converted).toBe(1);
    expect(overview.trials.medianDaysToConvert).toBe(10);
    expect(control.platformAuditLog.findMany).not.toHaveBeenCalled();
  });
});

describe("getFleetAccountHealth — the Needs attention list", () => {
  it("keeps deleted, archived and long-lapsed workspaces off the list, and live ones on it", async () => {
    orgs = [
      org("gone", { status: "ARCHIVED", retentionDeletedAt: new Date("2026-08-01T00:00:00Z") }),
      org("stale", { status: "SUSPENDED", planTier: "STARTER", trialTier: "TEAM", trialEndsAt: new Date("2026-05-01T00:00:00Z") }),
      org("slipping")
    ];
    snaps = [
      snap("gone", "2026-10-02", { status: "ARCHIVED", reachable: false, activeSeats: 0 }),
      snap("stale", "2026-10-02", { status: "SUSPENDED", planTier: "STARTER", trialTier: "TEAM" }),
      snap("slipping", "2026-10-02", { status: "GRACE" })
    ];
    const health = await getFleetAccountHealth(30, 90);
    const byId = Object.fromEntries(health.rows.map((row) => [row.orgId, row]));
    expect(byId.gone.attentionExclusion).toBe("deleted");
    expect(byId.stale.attentionExclusion).toBe("beyond-retention");
    expect(byId.slipping.needsAttention).toBe(true);
    expect(byId.gone.needsAttention).toBe(false);
    expect(byId.stale.needsAttention).toBe(false);
  });
});

/** Thirty-one nights, 2 Sep → 2 Oct, three tickets raised every day — a steady workspace whose
 *  FIRST night in the window could not reach its database, so that row holds a total of 0. */
const steadyWithAnOutageFirst = (orgId: string) =>
  Array.from({ length: 31 }, (_, i) => {
    const day = new Date(Date.UTC(2026, 8, 2 + i)).toISOString().slice(0, 10);
    return i === 0
      ? snap(orgId, day, { reachable: false, activeSeats: 0, ticketsTotal: 0, lastActivityAt: null })
      : snap(orgId, day, { ticketsTotal: 5_000 + i * 3, lastActivityAt: new Date(date(day).getTime() - 3_600_000) });
  });

describe("ticket velocity reads only the nights that reached the database", () => {
  it("does not call a steady workspace 'Work slowing' because one night in the window was an outage", async () => {
    orgs = [org("a")];
    snaps = steadyWithAnOutageFirst("a");
    const health = await getFleetAccountHealth(30, 90);
    const ids = health.rows[0].health.signals.map((signal) => signal.id);
    expect(ids).not.toContain("velocity-down");
    expect(ids).not.toContain("velocity-up");
  });

  it("does the same on the Org 360 page", async () => {
    orgs = [org("a")];
    snaps = steadyWithAnOutageFirst("a");
    const profile = await getOrgUsageProfile("a");
    expect(profile.health!.signals.map((signal) => signal.id)).not.toContain("velocity-down");
  });

  it("counts only the readable nights toward the trend's minimum", async () => {
    // Eight nights in the window, the first unreachable: seven readings are below the eight a trend
    // needs, so no velocity is assessed — even though the series has eight rows.
    orgs = [org("a")];
    snaps = steadyWithAnOutageFirst("a").slice(-8).map((row, i) => (i === 0 ? { ...row, reachable: false, ticketsTotal: 0 } : row));
    const health = await getFleetAccountHealth(30, 90);
    expect(health.rows[0].health.signals.map((signal) => signal.id)).toEqual(["steady"]);
    expect(health.rows[0].health.signals[0].detail).toMatch(/only 7 daily snapshots/);
  });
});

describe("getOrgUsageProfile — Org 360 prices the workspace the way the fleet does", () => {
  it("reports no list MRR for a workspace still on its trial, as the fleet figure does", async () => {
    orgs = [org("t", { planTier: "STARTER", trialTier: "TEAM", trialEndsAt: new Date("2026-10-10T00:00:00Z") })];
    snaps = [snap("t", "2026-10-02", { planTier: "STARTER", trialTier: "TEAM", trialEndsAt: new Date("2026-10-10T00:00:00Z") })];
    const profile = await getOrgUsageProfile("t");
    expect(profile.listMrrMinor).toBe(0);
    expect(profile.revenueState).toBe("trialing");
  });

  it("prices an unreachable night from the carried-forward seats", async () => {
    orgs = [org("a")];
    snaps = [snap("a", "2026-10-01", { activeSeats: 6 }), snap("a", "2026-10-02", { activeSeats: 0, reachable: false })];
    const profile = await getOrgUsageProfile("a");
    expect(profile.listMrrMinor).toBe(4_800);
    expect(profile.revenueState).toBe("paying");
  });
});
