/**
 * WHAT: project money — approved budget, burn to date, forecast at completion, and
 * estimate-vs-actual variance.
 *
 * WHY BURN IS NEVER STORED: it is summed live from `Timesheet.billedAmount`, the rate snapshot
 * frozen when each entry was approved (see billing-rate.service.ts). That is the same source a
 * Verified Work Attestation reads, so the number on an internal dashboard and the number on a
 * document a client may dispute cannot drift apart. A stored `burn` column would be a second
 * copy of a fact, and the two would eventually disagree.
 *
 * WHY ONLY APPROVED, BILLABLE HOURS COUNT: those are the hours the organisation has accepted as
 * real and chargeable. Counting drafts would let anyone move a project's reported cost by typing;
 * counting non-billable time would price internal work against a client budget.
 *
 * WHY THE FORECAST IS OFTEN NULL: forecast-at-completion is burn scaled by remaining work. With
 * near-zero progress the denominator is noise, and with zero spend the arithmetic yields a
 * confident "$0" that reads as "this project will cost nothing" — the single most misleading
 * figure it is possible to put on an executive dashboard. A blank that means "not enough data
 * yet" is the honest output, and every caller renders it as such.
 *
 * WHO CALLS THIS: `controllers/portfolio.controller.ts` (roll-up) and
 * `controllers/resource.controller.ts` (one project's budget panel). Sharing it is the point —
 * two definitions of "burn" is how a portfolio total stops matching the rows under it.
 */
import { prisma } from "../config/prisma.js";

/** Below this, "percent complete" is too small a denominator for a forecast to mean anything. */
export const MIN_PROGRESS_FOR_FORECAST_PCT = 5;

export interface ProjectBudget {
  projectId: string;
  budget: number | null;
  currency: string;
  budgetAlertPct: number | null;
  /** Approved + billable only. */
  burn: number;
  burnPct: number | null;
  billableHours: number;
  /** Approved hours explicitly marked non-billable — surfaced so "where did the time go" has an
   *  answer, never folded into burn. */
  nonBillableHours: number;
  /** Approved hours with no rate on record. Reported, never priced as zero: pretending unrated
   *  work was free is how a budget looks healthy right up until it isn't. */
  unratedHours: number;
  forecastAtCompletion: number | null;
  overBudgetRisk: boolean;
  /** True once burn crosses the project's own alert threshold. */
  alerting: boolean;
}

export async function computeProjectBudgets(
  projectIds: string[],
  progressByProject: Map<string, number>
): Promise<Map<string, ProjectBudget>> {
  const out = new Map<string, ProjectBudget>();
  if (projectIds.length === 0) return out;

  const [projects, billable, nonBillable, unrated, defaults] = await Promise.all([
    prisma.project.findMany({
      where: { id: { in: projectIds } },
      select: { id: true, budgetAmount: true, budgetCurrency: true, billingCurrency: true, budgetAlertPct: true }
    }),
    prisma.timesheet.groupBy({
      by: ["projectId"],
      where: { projectId: { in: projectIds }, status: "APPROVED", billable: true, deletedAt: null },
      _sum: { billedAmount: true, totalHours: true }
    }),
    prisma.timesheet.groupBy({
      by: ["projectId"],
      where: { projectId: { in: projectIds }, status: "APPROVED", billable: false, deletedAt: null },
      _sum: { totalHours: true }
    }),
    prisma.timesheet.groupBy({
      by: ["projectId"],
      where: {
        projectId: { in: projectIds },
        status: "APPROVED",
        billable: true,
        deletedAt: null,
        // Entries approved before rate snapshotting existed, or approved with no rate configured
        // anywhere. Both are legitimately unpriced — see billing-rate.service.ts.
        billedAmount: null
      },
      _sum: { totalHours: true }
    }),
    prisma.globalTicketSettings.findUnique({ where: { id: "global" } })
  ]);

  const billableBy = new Map(billable.map((r) => [r.projectId, r]));
  const nonBillableBy = new Map(nonBillable.map((r) => [r.projectId, Number(r._sum.totalHours ?? 0)]));
  const unratedBy = new Map(unrated.map((r) => [r.projectId, Number(r._sum.totalHours ?? 0)]));

  for (const project of projects) {
    const b = billableBy.get(project.id);
    const burn = Number(b?._sum.billedAmount ?? 0);
    const budget = project.budgetAmount ? Number(project.budgetAmount) : null;
    const progressPct = progressByProject.get(project.id) ?? 0;

    const burnPct = budget && budget > 0 ? Math.round((burn / budget) * 100) : null;
    const forecast =
      budget !== null && progressPct >= MIN_PROGRESS_FOR_FORECAST_PCT && burn > 0
        ? Math.round((burn / progressPct) * 100)
        : null;

    out.set(project.id, {
      projectId: project.id,
      budget,
      currency: project.budgetCurrency ?? project.billingCurrency ?? defaults?.defaultCurrency ?? "USD",
      budgetAlertPct: project.budgetAlertPct,
      burn: Number(burn.toFixed(2)),
      burnPct,
      billableHours: Number(Number(b?._sum.totalHours ?? 0).toFixed(2)),
      nonBillableHours: Number((nonBillableBy.get(project.id) ?? 0).toFixed(2)),
      unratedHours: Number((unratedBy.get(project.id) ?? 0).toFixed(2)),
      forecastAtCompletion: forecast,
      overBudgetRisk: Boolean(budget && forecast && forecast > budget),
      alerting: Boolean(budget && burnPct !== null && project.budgetAlertPct && burnPct >= project.budgetAlertPct)
    });
  }

  return out;
}

export interface EffortVarianceRow {
  ticketId: string;
  key: string;
  title: string;
  estimatedHours: number;
  actualHours: number;
  /** actual − estimated. Positive = overrun. */
  varianceHours: number;
  variancePct: number;
  assignee: { id: string; name: string } | null;
}

/**
 * Estimate vs actual for items that have both.
 *
 * Only items with a real estimate AND real logged hours appear: comparing against a missing
 * estimate would report a 100% overrun on every unestimated ticket and drown the signal. This is
 * the number that makes future estimates better, so it has to be trustworthy rather than
 * complete.
 */
export async function computeEffortVariance(params: {
  projectIds: string[];
  limit?: number;
}): Promise<{ rows: EffortVarianceRow[]; medianVariancePct: number | null; overrunRate: number | null }> {
  const tickets = await prisma.ticket.findMany({
    where: {
      projectId: { in: params.projectIds },
      deletedAt: null,
      estimatedHours: { not: null },
      // Finished work only — a half-done task is under its estimate by definition, and including
      // it would make every project look like it consistently beats its estimates.
      status: { in: ["RESOLVED", "CLOSED"] }
    },
    select: {
      id: true,
      key: true,
      title: true,
      estimatedHours: true,
      assignee: { select: { id: true, name: true } }
    },
    take: 500
  });
  if (tickets.length === 0) return { rows: [], medianVariancePct: null, overrunRate: null };

  const actuals = await prisma.timesheet.groupBy({
    by: ["ticketId"],
    where: { ticketId: { in: tickets.map((t) => t.id) }, status: "APPROVED", deletedAt: null },
    _sum: { totalHours: true }
  });
  const actualBy = new Map(actuals.map((a) => [a.ticketId!, Number(a._sum.totalHours ?? 0)]));

  const rows: EffortVarianceRow[] = [];
  for (const t of tickets) {
    const estimated = Number(t.estimatedHours);
    const actual = actualBy.get(t.id) ?? 0;
    if (estimated <= 0 || actual <= 0) continue;
    rows.push({
      ticketId: t.id,
      key: t.key,
      title: t.title,
      estimatedHours: Number(estimated.toFixed(2)),
      actualHours: Number(actual.toFixed(2)),
      varianceHours: Number((actual - estimated).toFixed(2)),
      variancePct: Math.round(((actual - estimated) / estimated) * 100),
      assignee: t.assignee
    });
  }

  rows.sort((a, b) => Math.abs(b.variancePct) - Math.abs(a.variancePct));

  // Median, not mean: one task that took 12× its estimate would drag a mean into uselessness,
  // and "our typical task runs 15% over" is the sentence a planner can actually act on.
  const sorted = rows.map((r) => r.variancePct).sort((a, b) => a - b);
  const median =
    sorted.length === 0
      ? null
      : sorted.length % 2 === 1
        ? sorted[(sorted.length - 1) / 2]
        : Math.round((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2);

  return {
    rows: rows.slice(0, params.limit ?? 50),
    medianVariancePct: median,
    overrunRate: rows.length === 0 ? null : Math.round((rows.filter((r) => r.varianceHours > 0).length / rows.length) * 100)
  };
}
