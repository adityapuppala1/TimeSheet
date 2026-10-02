/**
 * The console's Feedback page — what trialling and lapsed customers said, aggregated.
 *
 *  - Every figure is over EVERY answer, aggregated in the database. The page used to load the newest
 *    500 rows and count those, so past 500 answers the rating, the split and the trend were wrong.
 *  - The monthly trend is India's months (the platform's zone): each bucket starts at India's
 *    midnight on the 1st and is LABELLED with that month. `new Date(y, m, 1).toISOString()` labelled
 *    October's bucket "2026-09", every month one early.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Feedback = { id: string; organizationId: string; stage: string; rating: number; wouldReturn: string | null; liked: string | null; missing: string | null; comment: string | null; createdAt: Date };
type Org = { id: string; name: string; slug: string; status: string; planTier: string; trialTier: string | null };

let feedback: Feedback[] = [];
let orgs: Org[] = [];

type Where = { createdAt?: { gte?: Date; lt?: Date }; OR?: Array<Record<string, { not: null }>> };
const matches = (row: Feedback, where?: Where) => {
  if (where?.createdAt?.gte && row.createdAt < where.createdAt.gte) return false;
  if (where?.createdAt?.lt && !(row.createdAt < where.createdAt.lt)) return false;
  if (where?.OR && !where.OR.some((clause) => Object.keys(clause).some((key) => row[key as keyof Feedback] !== null))) return false;
  return true;
};
const avg = (list: Feedback[]) => (list.length ? list.reduce((sum, row) => sum + row.rating, 0) / list.length : null);

const control = {
  trialFeedback: {
    groupBy: vi.fn(async ({ by, where }: { by: Array<keyof Feedback>; where?: Where }) => {
      const groups = new Map<string, Feedback[]>();
      for (const row of feedback.filter((r) => matches(r, where))) {
        const key = by.map((k) => String(row[k])).join("|");
        groups.set(key, [...(groups.get(key) ?? []), row]);
      }
      return [...groups.values()].map((list) => ({
        ...Object.fromEntries(by.map((k) => [k, list[0][k]])),
        _count: { _all: list.length },
        _avg: { rating: avg(list) },
        _sum: { rating: list.reduce((sum, row) => sum + row.rating, 0) }
      }));
    }),
    aggregate: vi.fn(async ({ where }: { where?: Where }) => {
      const list = feedback.filter((r) => matches(r, where));
      return { _count: { _all: list.length }, _avg: { rating: avg(list) } };
    }),
    count: vi.fn(async ({ where }: { where?: Where }) => feedback.filter((r) => matches(r, where)).length),
    findMany: vi.fn(async ({ take }: { take: number }) =>
      [...feedback].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, take).map((row) => ({ ...row, organization: orgs.find((o) => o.id === row.organizationId) }))
    )
  },
  organization: {
    findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => orgs.filter((o) => where.id.in.includes(o.id)))
  }
};
vi.mock("../../src/config/control-prisma.js", () => ({ controlPrisma: control }));
vi.mock("../../src/config/env.js", () => ({ env: { TZ: "Asia/Kolkata" } }));

const { getTrialFeedbackAnalytics } = await import("../../src/services/platform-feedback.service.js");

let seq = 0;
const answer = (iso: string, patch: Partial<Feedback> = {}): Feedback => ({
  id: `f${(seq += 1)}`,
  organizationId: "o1",
  stage: "feedback10",
  rating: 4,
  wouldReturn: "yes",
  liked: null,
  missing: null,
  comment: null,
  createdAt: new Date(iso),
  ...patch
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-15T06:00:00Z"));
  orgs = [
    { id: "o1", name: "Acme", slug: "acme", status: "ACTIVE", planTier: "STARTER", trialTier: "TEAM" },
    { id: "o2", name: "Beta", slug: "beta", status: "GRACE", planTier: "STARTER", trialTier: "TEAM" }
  ];
  feedback = [];
});
afterEach(() => vi.useRealTimers());

describe("getTrialFeedbackAnalytics", () => {
  it("labels each month as India's month — October's bucket is October", async () => {
    // 20:00 UTC on 30 Sept is 01:30 IST on 1 Oct: an October answer.
    feedback = [answer("2026-09-30T20:00:00Z", { rating: 5 }), answer("2026-09-20T10:00:00Z", { rating: 3 })];
    const result = await getTrialFeedbackAnalytics();
    expect(result.monthly).toHaveLength(12);
    expect(result.monthly.at(-1)).toEqual({ month: "2026-10", count: 1, avgRating: 5 });
    expect(result.monthly.at(-2)).toEqual({ month: "2026-09", count: 1, avgRating: 3 });
    expect(result.monthly[0].month).toBe("2025-11");
  });

  it("aggregates every answer, not the newest 500", async () => {
    feedback = Array.from({ length: 620 }, (_, i) => answer(new Date(Date.UTC(2026, 9, 14) - i * 60_000).toISOString(), { rating: i < 600 ? 5 : 1, wouldReturn: i < 600 ? "yes" : "no" }));
    const result = await getTrialFeedbackAnalytics();
    expect(result.count).toBe(620);
    expect(result.distribution.find((d) => d.rating === 1)?.count).toBe(20);
    expect(result.wouldReturn.find((w) => w.answer === "no")?.count).toBe(20);
    expect(result.rows).toHaveLength(500);
    expect(result.rowsTruncated).toBe(true);
  });

  it("breaks the answers down by stage, by workspace state and by tier", async () => {
    feedback = [
      answer("2026-10-01T10:00:00Z", { stage: "feedback10", rating: 4 }),
      answer("2026-10-02T10:00:00Z", { stage: "30", rating: 2, wouldReturn: "no", organizationId: "o2", comment: "Too pricey" })
    ];
    const result = await getTrialFeedbackAnalytics();
    expect(result.stages).toEqual(expect.arrayContaining([{ stage: "feedback10", count: 1, avgRating: 4, wouldReturn: 1 }, { stage: "30", count: 1, avgRating: 2, wouldReturn: 0 }]));
    expect(result.byStatus).toEqual(expect.arrayContaining([{ status: "ACTIVE", count: 1, avgRating: 4 }, { status: "GRACE", count: 1, avgRating: 2 }]));
    expect(result.byTier).toEqual([{ tier: "TEAM", count: 2, avgRating: 3 }]);
    expect(result.withWords).toBe(1);
    expect(result.avgRating).toBe(3);
  });
});
