/**
 * The console's Signups page (signup Phase 1): what the operators read to answer "is self-serve
 * working, and are the people it brings in staying?". Pinned:
 *  - the funnel counts each stage inside the period, from the funnel rows;
 *  - `converted` means paying for real: ACTIVE, no trial running, and a paid tier or a subscription;
 *  - seats come from the LATEST usage snapshot, and are null — not 0 — before the first one;
 *  - the period is one of 7, 30 or 90 days, whatever is asked for;
 *  - self-serve and console-made workspaces are counted apart, day by day, with empty days present.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Attempt = { stage: string; domain: string | null; organizationId: string | null; detail: string | null; createdAt: Date };
type Org = {
  id: string;
  name: string;
  slug: string;
  ownerEmail: string | null;
  createdVia: string | null;
  createdAt: Date;
  status: string;
  planTier: string;
  trialEndsAt: Date | null;
  stripeSubscriptionId: string | null;
};
type Snapshot = { organizationId: string; day: Date; activeSeats: number };

let attempts: Attempt[] = [];
let orgs: Org[] = [];
let snapshots: Snapshot[] = [];

const since = (where: { createdAt?: { gte: Date } }, at: Date) => !where.createdAt || at >= where.createdAt.gte;
const control = {
  signupAttempt: {
    groupBy: vi.fn(async ({ by, where }: { by: string[]; where: { createdAt: { gte: Date }; domain?: { not: null } } }) => {
      const rows = attempts.filter((a) => since(where, a.createdAt) && (!where.domain || a.domain !== null));
      const groups = new Map<string, Record<string, unknown>>();
      for (const row of rows) {
        const key = by.map((k) => String(row[k as keyof Attempt])).join("|");
        const group = groups.get(key) ?? { ...Object.fromEntries(by.map((k) => [k, row[k as keyof Attempt]])), _count: { _all: 0 } };
        (group._count as { _all: number })._all += 1;
        groups.set(key, group);
      }
      return [...groups.values()];
    }),
    findMany: vi.fn(async ({ where, take }: { where: { stage: string; createdAt: { gte: Date } }; take: number }) =>
      attempts
        .filter((a) => a.stage === where.stage && since(where, a.createdAt))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, take)
    )
  },
  organization: {
    findMany: vi.fn(async ({ where }: { where: { createdAt: { gte: Date }; createdVia?: string } }) =>
      orgs.filter((o) => since(where, o.createdAt) && (!where.createdVia || o.createdVia === where.createdVia)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    )
  },
  orgUsageSnapshot: {
    findMany: vi.fn(async ({ where }: { where: { organizationId: { in: string[] } } }) =>
      snapshots.filter((s) => where.organizationId.in.includes(s.organizationId)).sort((a, b) => b.day.getTime() - a.day.getTime())
    )
  }
};
vi.mock("../../src/config/control-prisma.js", () => ({ controlPrisma: control }));

const { clampSignupPeriod, getSignupAnalytics } = await import("../../src/services/signup-analytics.service.js");

const now = new Date("2026-10-02T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(now.getTime() - n * DAY);
const at = (stage: string, n: number, extra: Partial<Attempt> = {}): Attempt => ({ stage, domain: "northwind.co.uk", organizationId: null, detail: null, createdAt: daysAgo(n), ...extra });
const org = (extra: Partial<Org>): Org => ({
  id: "o",
  name: "Org",
  slug: "org",
  ownerEmail: "priya@northwind.co.uk",
  createdVia: "SELF_SERVE",
  createdAt: daysAgo(1),
  status: "ACTIVE",
  planTier: "STARTER",
  trialEndsAt: new Date(now.getTime() + 10 * DAY),
  stripeSubscriptionId: null,
  ...extra
});

beforeEach(() => {
  vi.clearAllMocks();
  attempts = [];
  orgs = [];
  snapshots = [];
});

describe("clampSignupPeriod", () => {
  it("is 7, 30 or 90 — the nearest allowed, defaulting to 30", () => {
    expect(clampSignupPeriod(7)).toBe(7);
    expect(clampSignupPeriod(90)).toBe(90);
    expect(clampSignupPeriod(1)).toBe(7);
    expect(clampSignupPeriod(45)).toBe(30);
    expect(clampSignupPeriod(10_000)).toBe(90);
    expect(clampSignupPeriod(Number.NaN)).toBe(30);
  });
});

describe("getSignupAnalytics", () => {
  it("counts each funnel stage inside the period only", async () => {
    attempts = [
      at("CODE_SENT", 1),
      at("CODE_SENT", 2),
      at("CODE_SENT", 3),
      at("VERIFIED", 1),
      at("VERIFIED", 2),
      at("CREATED", 1),
      at("JOIN_REQUESTED", 2),
      at("UNAVAILABLE", 2),
      at("REFUSED", 1, { domain: "gmail.com" }),
      at("FAILED", 1, { detail: "Access denied" }),
      at("CODE_SENT", 20) // outside 7 days
    ];
    const result = await getSignupAnalytics(7, now);
    expect(result.days).toBe(7);
    expect(result.funnel).toEqual({ codeSent: 3, verified: 2, created: 1, joinRequested: 1, unavailable: 1, refused: 1, failed: 1 });
    expect(result.failures).toEqual([{ at: daysAgo(1).toISOString(), domain: "northwind.co.uk", detail: "Access denied" }]);
  });

  it("calls a workspace converted only when it is paying for real", async () => {
    orgs = [
      org({ id: "trialling", trialEndsAt: new Date(now.getTime() + 5 * DAY), planTier: "TEAM" }),
      org({ id: "paid-tier", trialEndsAt: daysAgo(1), planTier: "TEAM" }),
      org({ id: "subscribed", trialEndsAt: null, planTier: "STARTER", stripeSubscriptionId: "sub_1" }),
      org({ id: "lapsed", trialEndsAt: daysAgo(1), planTier: "STARTER" }),
      org({ id: "suspended-paid", trialEndsAt: daysAgo(1), planTier: "TEAM", status: "SUSPENDED" })
    ];
    const result = await getSignupAnalytics(30, now);
    const converted = Object.fromEntries(result.recent.map((r) => [r.orgId, r.converted]));
    expect(converted).toEqual({ trialling: false, "paid-tier": true, subscribed: true, lapsed: false, "suspended-paid": false });
    expect(result.recent.find((r) => r.orgId === "trialling")?.trialDaysLeft).toBe(5);
    expect(result.recent.find((r) => r.orgId === "lapsed")?.trialDaysLeft).toBeNull();
    expect(result.recent[0].domain).toBe("northwind.co.uk");
  });

  it("reads seats from the latest snapshot, and null before the first one", async () => {
    orgs = [org({ id: "a" }), org({ id: "b" })];
    snapshots = [
      { organizationId: "a", day: daysAgo(2), activeSeats: 3 },
      { organizationId: "a", day: daysAgo(1), activeSeats: 7 }
    ];
    const result = await getSignupAnalytics(30, now);
    expect(result.recent.find((r) => r.orgId === "a")?.activeSeats).toBe(7);
    expect(result.recent.find((r) => r.orgId === "b")?.activeSeats).toBeNull();
  });

  it("counts self-serve and console workspaces apart, every day of the period present", async () => {
    orgs = [org({ id: "s1", createdAt: daysAgo(1) }), org({ id: "s2", createdAt: daysAgo(1) }), org({ id: "c1", createdVia: "CONSOLE", createdAt: daysAgo(3) })];
    const result = await getSignupAnalytics(7, now);
    expect(result.byDay).toHaveLength(7);
    expect(result.byDay.at(-1)?.day).toBe("2026-10-02");
    expect(result.byDay.find((d) => d.day === "2026-10-01")).toEqual({ day: "2026-10-01", selfServe: 2, console: 0 });
    expect(result.byDay.find((d) => d.day === "2026-09-29")).toEqual({ day: "2026-09-29", selfServe: 0, console: 1 });
    // Recent is who SIGNED UP — console-made workspaces are counted in the chart, not listed here.
    expect(result.recent.map((r) => r.orgId).sort()).toEqual(["s1", "s2"]);
  });

  it("ranks the domains trying hardest, with how many got a workspace or asked to join", async () => {
    attempts = [
      at("CODE_SENT", 1, { domain: "acme.com" }),
      at("CODE_SENT", 1, { domain: "acme.com" }),
      at("JOIN_REQUESTED", 1, { domain: "acme.com" }),
      at("CODE_SENT", 1, { domain: "globex.com" }),
      at("CREATED", 1, { domain: "globex.com" }),
      // Refused addresses are counted in the funnel, but gmail.com trying hard is not a company.
      at("REFUSED", 1, { domain: "gmail.com" }),
      at("REFUSED", 1, { domain: "gmail.com" }),
      at("REFUSED", 1, { domain: "gmail.com" }),
      at("REFUSED", 1, { domain: "gmail.com" })
    ];
    const result = await getSignupAnalytics(30, now);
    expect(result.topDomains[0]).toEqual({ domain: "acme.com", attempts: 3, created: 0, joinRequested: 1 });
    expect(result.topDomains[1]).toEqual({ domain: "globex.com", attempts: 2, created: 1, joinRequested: 0 });
    expect(result.topDomains.map((d) => d.domain)).not.toContain("gmail.com");
  });
});
