/**
 * WHAT: the console's Feedback page — every answer to the retention programme's feedback form,
 * aggregated: how many and how happy, WHERE the answers came from (which retention stage), WHICH kind
 * of workspace gave them (lifecycle state and tier), and whether the score is moving month to month.
 *
 * EVERY FIGURE IS OVER EVERY ANSWER, AGGREGATED IN THE DATABASE. The route used to load the newest 500
 * rows and count those in memory, so once a deployment passed 500 answers the rating, the split and
 * the trend all quietly described a sample. The list of answers underneath is still capped — it is a
 * page to read, not a dataset — and says so (`rowsTruncated`).
 *
 * THE MONTHS ARE INDIA'S (the platform's zone, utils/platform-time.ts): each bucket starts at India's
 * midnight on the 1st and is labelled with that month. `new Date(y, m, 1).toISOString().slice(0, 7)`
 * took IST midnight on the 1st — 18:30 UTC on the last day of the previous month — and labelled every
 * bucket one month early.
 *
 * WHY THE TREND IS BY MONTH AND NOT BY DAY. Feedback arrives in single figures a week even on a
 * healthy platform; a daily series of a 1-to-5 rating is almost all noise and empty buckets. A monthly
 * mean over twelve months is the shortest window in which a change in it means something.
 */
import { controlPrisma } from "../config/control-prisma.js";
import { platformDayStart, platformMonthKey } from "../utils/platform-time.js";

/** How many answers the page lists verbatim. Every count above the list is over all of them. */
const LISTED_ANSWERS = 500;

const round2 = (value: number | null | undefined): number | null => (value === null || value === undefined ? null : Number(value.toFixed(2)));

/** `YYYY-MM` moved by whole months. */
function shiftMonth(month: string, offset: number): string {
  const [year, m] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, m - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The last twelve platform months, oldest first, each with India's midnight on its 1st and the next. */
function lastTwelveMonths(now: Date): Array<{ month: string; start: Date; next: Date }> {
  const current = platformMonthKey(now);
  return Array.from({ length: 12 }, (_, i) => {
    const month = shiftMonth(current, i - 11);
    return { month, start: platformDayStart(`${month}-01`), next: platformDayStart(`${shiftMonth(month, 1)}-01`) };
  });
}

/** Per workspace state and per tier, rolled up from one group-by per workspace — the state and tier
 *  live on the Organization, which a group-by on feedback cannot reach. */
async function byWorkspace() {
  const perOrg = await controlPrisma.trialFeedback.groupBy({ by: ["organizationId"], _count: { _all: true }, _sum: { rating: true } });
  const orgs = await controlPrisma.organization.findMany({ where: { id: { in: perOrg.map((row) => row.organizationId) } }, select: { id: true, status: true, planTier: true, trialTier: true } });
  const orgById = new Map(orgs.map((org) => [org.id, org]));
  const roll = (keyOf: (org: (typeof orgs)[number]) => string) => {
    const totals = new Map<string, { count: number; sum: number }>();
    for (const row of perOrg) {
      const org = orgById.get(row.organizationId);
      if (!org) continue;
      const entry = totals.get(keyOf(org)) ?? { count: 0, sum: 0 };
      entry.count += row._count._all;
      entry.sum += row._sum.rating ?? 0;
      totals.set(keyOf(org), entry);
    }
    return [...totals.entries()].map(([key, entry]) => ({ key, count: entry.count, avgRating: entry.count ? round2(entry.sum / entry.count) : null }));
  };
  return {
    byStatus: roll((org) => String(org.status)).map(({ key, ...rest }) => ({ status: key, ...rest })),
    // The tier the workspace was asked ABOUT: a trialling workspace answers about its trial tier.
    byTier: roll((org) => String(org.trialTier ?? org.planTier)).map(({ key, ...rest }) => ({ tier: key, ...rest }))
  };
}

export async function getTrialFeedbackAnalytics(now = new Date()) {
  const months = lastTwelveMonths(now);
  const [overall, ratings, returns, stageRows, stageReturns, withWords, rows, workspace, monthly] = await Promise.all([
    controlPrisma.trialFeedback.aggregate({ _count: { _all: true }, _avg: { rating: true } }),
    controlPrisma.trialFeedback.groupBy({ by: ["rating"], _count: { _all: true } }),
    controlPrisma.trialFeedback.groupBy({ by: ["wouldReturn"], _count: { _all: true } }),
    controlPrisma.trialFeedback.groupBy({ by: ["stage"], _count: { _all: true }, _avg: { rating: true } }),
    controlPrisma.trialFeedback.groupBy({ by: ["stage", "wouldReturn"], _count: { _all: true } }),
    // The submit route stores a blank answer as NULL (retention.service.ts#submitTrialFeedback), so
    // "left words" is any of the three text answers being present.
    controlPrisma.trialFeedback.count({ where: { OR: [{ liked: { not: null } }, { missing: { not: null } }, { comment: { not: null } }] } }),
    controlPrisma.trialFeedback.findMany({
      orderBy: { createdAt: "desc" },
      take: LISTED_ANSWERS,
      include: { organization: { select: { name: true, slug: true, status: true, planTier: true, trialTier: true } } }
    }),
    byWorkspace(),
    Promise.all(
      months.map(async ({ month, start, next }) => {
        const agg = await controlPrisma.trialFeedback.aggregate({ where: { createdAt: { gte: start, lt: next } }, _count: { _all: true }, _avg: { rating: true } });
        // A month nobody answered plots no point: nobody rated us 0/5, nobody rated us at all.
        return { month, count: agg._count._all, avgRating: round2(agg._avg.rating) };
      })
    )
  ]);

  const countOf = <T extends { _count: { _all: number } }>(list: T[], match: (row: T) => boolean) => list.find(match)?._count._all ?? 0;
  const yesByStage = new Map(stageReturns.filter((row) => row.wouldReturn === "yes").map((row) => [row.stage, row._count._all]));

  return {
    count: overall._count._all,
    avgRating: round2(overall._avg.rating),
    withWords,
    distribution: [1, 2, 3, 4, 5].map((rating) => ({ rating, count: countOf(ratings, (row) => row.rating === rating) })),
    wouldReturn: ["yes", "maybe", "no"].map((answer) => ({ answer, count: countOf(returns, (row) => row.wouldReturn === answer) })),
    // Per stage: the day-10 check-in and the post-trial reminders are different questions asked of
    // different moods, and averaging them together hides which one is bad.
    stages: stageRows
      .map((row) => ({ stage: row.stage, count: row._count._all, avgRating: round2(row._avg.rating), wouldReturn: yesByStage.get(row.stage) ?? 0 }))
      .sort((a, b) => b.count - a.count),
    byStatus: workspace.byStatus,
    byTier: workspace.byTier,
    monthly,
    rows,
    rowsTruncated: overall._count._all > rows.length
  };
}
