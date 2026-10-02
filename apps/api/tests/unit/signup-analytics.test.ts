/**
 * The console's Signups page (signup Phase 1): what the operators read to answer "is self-serve
 * working, and are the people it brings in staying?". Pinned:
 *  - the funnel counts PEOPLE (the keyed email hash), as a cohort of those whose FIRST code was sent
 *    in the period — a resend is not a second person, and no step can exceed the one before it;
 *  - `converted` is the shared trial-conversion rule (trial-conversion.ts#isConverted): a checkout,
 *    a subscription or a paid tier set by hand — the same answer Revenue and retention give;
 *  - the "converted of N self-serve" figure is counted on the server over EVERY self-serve workspace
 *    in the period, not over the hundred listed;
 *  - seats come from the LATEST usage snapshot, and are null — not 0 — before the first one;
 *  - the period is one of 7, 30 or 90 days, whatever is asked for;
 *  - self-serve and console-made workspaces are counted apart, day by day, with empty days present.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Attempt = { stage: string; domain: string | null; emailHash: string | null; organizationId: string | null; detail: string | null; createdAt: Date };
type Org = {
  id: string;
  name: string;
  slug: string;
  ownerEmail: string | null;
  createdVia: string | null;
  createdAt: Date;
  status: string;
  planTier: string;
  trialTier: string | null;
  trialEndsAt: Date | null;
  stripeSubscriptionId: string | null;
};
type Snapshot = { organizationId: string; day: Date; activeSeats: number };

let attempts: Attempt[] = [];
let orgs: Org[] = [];
let snapshots: Snapshot[] = [];

const since = (where: { createdAt?: { gte: Date } }, at: Date) => !where.createdAt || at >= where.createdAt.gte;
type AttemptWhere = {
  createdAt?: { gte: Date };
  domain?: { not: null };
  emailHash?: { not: null } | { in: string[] };
  stage?: string | { in: string[] };
};
const attemptMatches = (a: Attempt, where: AttemptWhere) => {
  if (!since(where, a.createdAt)) return false;
  if (where.domain && a.domain === null) return false;
  if (where.emailHash && "not" in where.emailHash && a.emailHash === null) return false;
  if (where.emailHash && "in" in where.emailHash && !(a.emailHash && where.emailHash.in.includes(a.emailHash))) return false;
  if (typeof where.stage === "string" && a.stage !== where.stage) return false;
  if (where.stage && typeof where.stage === "object" && !where.stage.in.includes(a.stage)) return false;
  return true;
};
const control = {
  signupAttempt: {
    groupBy: vi.fn(async ({ by, where, having }: { by: string[]; where: AttemptWhere; having?: { createdAt?: { _min?: { gte: Date } } } }) => {
      const rows = attempts.filter((a) => attemptMatches(a, where));
      const groups = new Map<string, Record<string, unknown> & { _rows: Attempt[] }>();
      for (const row of rows) {
        const key = by.map((k) => String(row[k as keyof Attempt])).join("|");
        const group = groups.get(key) ?? { ...Object.fromEntries(by.map((k) => [k, row[k as keyof Attempt]])), _count: { _all: 0 }, _rows: [] };
        (group._count as { _all: number })._all += 1;
        group._rows.push(row);
        groups.set(key, group);
      }
      return [...groups.values()]
        .map(({ _rows, ...group }) => ({ ...group, _min: { createdAt: new Date(Math.min(..._rows.map((r) => r.createdAt.getTime()))) } }))
        .filter((group) => !having?.createdAt?._min || group._min.createdAt >= having.createdAt._min.gte);
    }),
    findMany: vi.fn(async ({ where, take, distinct }: { where: AttemptWhere; take?: number; distinct?: string[] }) => {
      const rows = attempts.filter((a) => attemptMatches(a, where)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const unique = distinct ? [...new Map(rows.map((r) => [distinct.map((k) => String(r[k as keyof Attempt])).join("|"), r])).values()] : rows;
      return take ? unique.slice(0, take) : unique;
    })
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
// The platform's zone, as config/env.ts defaults it — every day key below is India's.
vi.mock("../../src/config/env.js", () => ({ env: { TZ: "Asia/Kolkata" } }));

const { clampSignupPeriod, getSignupAnalytics, overviewSignups } = await import("../../src/services/signup-analytics.service.js");

const now = new Date("2026-10-02T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(now.getTime() - n * DAY);
const at = (stage: string, n: number, extra: Partial<Attempt> = {}): Attempt => ({ stage, domain: "northwind.co.uk", emailHash: "h-priya", organizationId: null, detail: null, createdAt: daysAgo(n), ...extra });
/** One person's attempt — the keyed hash is what makes them one person across rows. */
const by = (person: string, stage: string, n: number, extra: Partial<Attempt> = {}): Attempt => at(stage, n, { emailHash: `h-${person}`, ...extra });
const org = (extra: Partial<Org>): Org => ({
  id: "o",
  name: "Org",
  slug: "org",
  ownerEmail: "priya@northwind.co.uk",
  createdVia: "SELF_SERVE",
  createdAt: daysAgo(1),
  status: "ACTIVE",
  planTier: "STARTER",
  trialTier: "TEAM",
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
  it("counts each funnel step as PEOPLE whose first code was sent in the period", async () => {
    attempts = [
      by("a", "CODE_SENT", 3),
      by("a", "VERIFIED", 3),
      by("a", "CREATED", 3),
      by("b", "CODE_SENT", 2),
      by("b", "VERIFIED", 2),
      by("b", "JOIN_REQUESTED", 2),
      by("c", "CODE_SENT", 2),
      by("c", "VERIFIED", 2),
      by("c", "UNAVAILABLE", 2),
      by("d", "CODE_SENT", 1),
      by("d", "VERIFIED", 1),
      by("d", "FAILED", 1, { detail: "Access denied" }),
      by("e", "REFUSED", 1, { domain: "gmail.com" }),
      by("f", "CODE_SENT", 20) // first code outside 7 days
    ];
    const result = await getSignupAnalytics(7, now);
    expect(result.days).toBe(7);
    expect(result.funnel).toEqual({ codeSent: 4, verified: 4, existingMembers: 0, created: 1, joinRequested: 1, unavailable: 1, refused: 1, failed: 1 });
    expect(result.failures).toEqual([{ at: daysAgo(1).toISOString(), domain: "northwind.co.uk", detail: "Access denied" }]);
  });

  it("counts a person once however many codes they asked for", async () => {
    // Three resends and two verifications are one person who verified — counted as events, the
    // funnel read 3 codes and 2 verifications, and step rates drifted with how often people resend.
    attempts = [by("a", "CODE_SENT", 3), by("a", "CODE_SENT", 2), by("a", "CODE_SENT", 1), by("a", "VERIFIED", 2), by("a", "VERIFIED", 1)];
    const result = await getSignupAnalytics(7, now);
    expect(result.funnel.codeSent).toBe(1);
    expect(result.funnel.verified).toBe(1);
  });

  it("leaves out someone whose first code was sent before the period — they are an earlier cohort", async () => {
    attempts = [by("old", "CODE_SENT", 20), by("old", "CODE_SENT", 1), by("old", "VERIFIED", 1), by("old", "CREATED", 1)];
    const result = await getSignupAnalytics(7, now);
    expect(result.funnel).toMatchObject({ codeSent: 0, verified: 0, created: 0 });
  });

  it("never lets a step exceed the one before it", async () => {
    // A verification with no code in this cohort (its code was earlier, or its row failed to write)
    // used to push "verified of codes sent" past 100%.
    attempts = [by("a", "CODE_SENT", 2), by("ghost", "VERIFIED", 1), by("ghost", "CREATED", 1)];
    const result = await getSignupAnalytics(7, now);
    expect(result.funnel.verified).toBeLessThanOrEqual(result.funnel.codeSent);
    expect(result.funnel.created).toBeLessThanOrEqual(result.funnel.verified);
    expect(result.funnel).toMatchObject({ codeSent: 1, verified: 0, created: 0 });
  });

  it("counts people who verified only to reach a workspace they already belong to", async () => {
    attempts = [by("m", "CODE_SENT", 1), by("m", "VERIFIED", 1), by("m", "EXISTING_MEMBER", 1), by("n", "CODE_SENT", 1), by("n", "VERIFIED", 1), by("n", "CREATED", 1)];
    const result = await getSignupAnalytics(7, now);
    expect(result.funnel).toMatchObject({ codeSent: 2, verified: 2, existingMembers: 1, created: 1 });
  });

  it("calls a workspace converted by the shared rule — the same answer Revenue and retention give", async () => {
    orgs = [
      // A self-serve trial: Starter, entitled to Team until the clock runs out. Not converted.
      org({ id: "trialling", trialEndsAt: new Date(now.getTime() + 5 * DAY) }),
      // Converted by hand in the console: clock and trial tier cleared, a paid plan, no Stripe.
      org({ id: "by-hand", trialEndsAt: null, trialTier: null, planTier: "TEAM" }),
      // Converted through Stripe checkout.
      org({ id: "subscribed", trialEndsAt: null, trialTier: null, planTier: "TEAM", stripeSubscriptionId: "sub_1" }),
      // The trial ran out on Starter: lapsed, whatever its status.
      org({ id: "lapsed", trialEndsAt: daysAgo(1) }),
      // Converted, then failed a renewal: still a conversion — its status pill says the rest.
      org({ id: "converted-then-grace", trialEndsAt: null, trialTier: null, planTier: "TEAM", status: "GRACE" })
    ];
    const result = await getSignupAnalytics(30, now);
    const converted = Object.fromEntries(result.recent.map((r) => [r.orgId, r.converted]));
    expect(converted).toEqual({ trialling: false, "by-hand": true, subscribed: true, lapsed: false, "converted-then-grace": true });
    expect(result.recent.find((r) => r.orgId === "trialling")?.trialDaysLeft).toBe(5);
    expect(result.recent.find((r) => r.orgId === "lapsed")?.trialDaysLeft).toBeNull();
    expect(result.recent[0].domain).toBe("northwind.co.uk");
  });

  it("counts self-serve and converted workspaces on the server, over every one in the period", async () => {
    // 120 self-serve workspaces, the first 110 converted. The list stops at 100; the count must not.
    orgs = Array.from({ length: 120 }, (_, i) =>
      org({ id: `w${i}`, createdAt: new Date(now.getTime() - (i + 1) * 60_000), ...(i < 110 ? { trialEndsAt: null, trialTier: null, planTier: "TEAM" } : {}) })
    );
    const result = await getSignupAnalytics(30, now);
    expect(result.recent).toHaveLength(100);
    expect(result.selfServe).toEqual({ total: 120, converted: 110 });
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

  it("buckets by India's day — a workspace made at 01:00 IST counts on that day, not UTC's previous one", async () => {
    orgs = [org({ id: "late", createdAt: new Date("2026-10-01T19:30:00Z") })]; // 01:00 IST on the 2nd
    const result = await getSignupAnalytics(7, now);
    expect(result.byDay.find((d) => d.day === "2026-10-02")).toMatchObject({ selfServe: 1 });
    expect(result.byDay.find((d) => d.day === "2026-10-01")).toMatchObject({ selfServe: 0 });
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

describe("overviewSignups — the Overview's tile and chart", () => {
  const created = (createdVia: string | null, daysBack: number) => ({ createdVia, createdAt: daysAgo(daysBack) });

  it("counts the last 30 days self-serve apart from console-made — a null createdVia is console", () => {
    const result = overviewSignups([created("SELF_SERVE", 1), created("SELF_SERVE", 29), created("CONSOLE", 2), created(null, 3), created("SELF_SERVE", 31)], now);
    expect(result.signups30).toEqual({ selfServe: 2, console: 2 });
  });

  it("buckets twelve weeks, oldest first, each split the same way", () => {
    const result = overviewSignups([created("SELF_SERVE", 1), created("CONSOLE", 1), created("SELF_SERVE", 8), created("SELF_SERVE", 200)], now);
    expect(result.signupsByWeek).toHaveLength(12);
    expect(result.signupsByWeek.at(-1)).toMatchObject({ selfServe: 1, console: 1 });
    expect(result.signupsByWeek.at(-2)).toMatchObject({ selfServe: 1, console: 0 });
    expect(result.signupsByWeek.reduce((n, w) => n + w.selfServe + w.console, 0)).toBe(3);
    expect(result.signupsByWeek[0].week < result.signupsByWeek[11].week).toBe(true);
  });

  it("buckets CALENDAR weeks, Monday to Sunday in India, labelled by their Monday", () => {
    // Fri 2 Oct 2026: this week began Mon 28 Sept; twelve of them go back to Mon 13 July.
    const result = overviewSignups([], new Date("2026-10-02T12:00:00Z"));
    expect(result.signupsByWeek.at(-1)?.week).toBe("2026-09-28");
    expect(result.signupsByWeek[0].week).toBe("2026-07-13");
  });

  it("puts a workspace in the week India was in when it was made, and the buckets do not move on a refetch", () => {
    // 20:00 UTC on Sun 27 Sept is 01:30 IST on Mon 28 Sept: this week, not last.
    const orgsMade = [{ createdVia: "SELF_SERVE", createdAt: new Date("2026-09-27T20:00:00Z") }];
    const morning = overviewSignups(orgsMade, new Date("2026-10-02T03:00:00Z"));
    const evening = overviewSignups(orgsMade, new Date("2026-10-02T15:00:00Z"));
    expect(morning.signupsByWeek.at(-1)).toMatchObject({ week: "2026-09-28", selfServe: 1 });
    // Rolling 168-hour windows shifted with every refetch; calendar weeks do not.
    expect(evening.signupsByWeek).toEqual(morning.signupsByWeek);
  });
});
