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

/** An amount in one currency. Never added to an amount in another. */
export interface CurrencyAmount {
  currency: string;
  amount: number;
}

export interface ProjectBudget {
  projectId: string;
  budget: number | null;
  /** The budget's currency (budget currency, else billing currency, else the workspace default) —
   *  and the ONLY currency `burn`, `burnPct`, the forecast and the risk flags are in. */
  currency: string;
  budgetAlertPct: number | null;
  /** Approved + billable only, and only what was billed in `currency`. */
  burn: number;
  /** Approved, billable burn billed in any OTHER currency, largest first. Reported beside `burn` and
   *  never added to it: there is no exchange rate here, and a sum across currencies is a number in
   *  no unit at all. Empty when everything was billed in the budget's currency. */
  otherCurrencyBurn: CurrencyAmount[];
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

  /**
   * WHAT THE AI TEAMMATES SPENT ON THIS PROJECT — beside `burn`, deliberately never inside it.
   *
   * Three reasons it cannot be added, each sufficient on its own. It is not billable (nothing is
   * priced into `billedAmount`, by decision), so folding it into burn would invoice a client for a
   * model call. It is always in **US dollars** while a project's budget may be in any currency, and
   * this file holds no exchange rate — a silent addition would be arithmetic across units. And a
   * budget is an agreement with somebody about labour; model spend is an operating cost of running
   * this workspace, which is a different conversation with a different person.
   *
   * So it is reported, labelled in its own currency, and left for the reader to weigh.
   */
  agentCostUsd: number;
  agentRuns: number;
}

export async function computeProjectBudgets(
  projectIds: string[],
  progressByProject: Map<string, number>
): Promise<Map<string, ProjectBudget>> {
  const out = new Map<string, ProjectBudget>();
  if (projectIds.length === 0) return out;

  const [projects, billable, nonBillable, unrated, defaults, agentSpend] = await Promise.all([
    prisma.project.findMany({
      where: { id: { in: projectIds } },
      select: { id: true, budgetAmount: true, budgetCurrency: true, billingCurrency: true, budgetAlertPct: true }
    }),
    // By billed currency too: each amount is frozen in the currency it was billed in, which need not
    // be the budget's (a free field in the project dialog) or even today's billing currency.
    prisma.timesheet.groupBy({
      by: ["projectId", "billedCurrency"],
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
    prisma.globalTicketSettings.findUnique({ where: { id: "global" } }),
    // The ledger, not `AgentRun`: the ledger is where this product already decided agent work is
    // recorded against a project, and a second definition of "what an agent spent here" is a number
    // nobody can reconcile.
    prisma.agentWorkEntry.groupBy({
      by: ["projectId"],
      where: { projectId: { in: projectIds } },
      _sum: { costUsd: true },
      _count: true
    })
  ]);

  const billableBy = new Map<string, typeof billable>();
  for (const r of billable) billableBy.set(r.projectId, [...(billableBy.get(r.projectId) ?? []), r]);
  const nonBillableBy = new Map(nonBillable.map((r) => [r.projectId, Number(r._sum.totalHours ?? 0)]));
  const unratedBy = new Map(unrated.map((r) => [r.projectId, Number(r._sum.totalHours ?? 0)]));
  const agentBy = new Map(agentSpend.map((r) => [r.projectId ?? "", { costUsd: Number(r._sum.costUsd ?? 0), runs: r._count }]));
  const workspaceCurrency = defaults?.defaultCurrency ?? "USD";

  for (const project of projects) {
    const currency = project.budgetCurrency ?? project.billingCurrency ?? workspaceCurrency;
    // Burn in the budget's currency, and every other billed currency apart. An amount with no
    // frozen currency (approved before the snapshot carried one) is in the project's billing
    // currency — the workspace metric rule for money.
    let burn = 0;
    let billableHours = 0;
    const other = new Map<string, number>();
    for (const g of billableBy.get(project.id) ?? []) {
      billableHours += Number(g._sum.totalHours ?? 0);
      const amount = Number(g._sum.billedAmount ?? 0);
      const billedIn = (g.billedCurrency ?? project.billingCurrency ?? workspaceCurrency).toUpperCase();
      if (billedIn === currency.toUpperCase()) burn += amount;
      else if (amount !== 0) other.set(billedIn, (other.get(billedIn) ?? 0) + amount);
    }
    const otherCurrencyBurn = [...other.entries()]
      .map(([c, amount]) => ({ currency: c, amount: Number(amount.toFixed(2)) }))
      .sort((a, b) => b.amount - a.amount || a.currency.localeCompare(b.currency));
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
      currency,
      budgetAlertPct: project.budgetAlertPct,
      burn: Number(burn.toFixed(2)),
      otherCurrencyBurn,
      burnPct,
      billableHours: Number(billableHours.toFixed(2)),
      nonBillableHours: Number((nonBillableBy.get(project.id) ?? 0).toFixed(2)),
      unratedHours: Number((unratedBy.get(project.id) ?? 0).toFixed(2)),
      forecastAtCompletion: forecast,
      overBudgetRisk: Boolean(budget && forecast && forecast > budget),
      alerting: Boolean(budget && burnPct !== null && project.budgetAlertPct && burnPct >= project.budgetAlertPct),
      agentCostUsd: Number((agentBy.get(project.id)?.costUsd ?? 0).toFixed(4)),
      agentRuns: agentBy.get(project.id)?.runs ?? 0
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

/* ------------------------------------------------------------------ shared roll-up helpers */

interface ProgressItem {
  id: string;
  estimatedHours: number | null;
  effectiveProgressPct: number;
}

/**
 * A solved plan's items grouped by project, and each project's EFFORT-WEIGHTED progress — the figure
 * the forecast scales burn by.
 *
 * ONE PASS OVER ONE MAP. The budget-burn widget and the Portfolio page each found an item's project
 * with `plan.raw.find(...)` per item — inside a filter, inside a loop over projects for the widget —
 * which is O(projects × tickets²) over every ticket, closed ones included. On a workspace with a few
 * thousand tickets that is the request that stalls the API. Shared here so the two cannot drift.
 */
export function progressFromPlan<Item extends ProgressItem>(
  plan: { items: Item[]; raw: Array<Record<string, unknown>> },
  projectIds: string[]
): { itemsByProject: Map<string, Item[]>; progressByProject: Map<string, number> } {
  const projectOf = new Map<string, string>();
  for (const row of plan.raw) {
    if (typeof row.id === "string" && typeof row.projectId === "string") projectOf.set(row.id, row.projectId);
  }
  const itemsByProject = new Map<string, Item[]>();
  for (const item of plan.items) {
    const projectId = projectOf.get(item.id);
    if (!projectId) continue;
    const list = itemsByProject.get(projectId);
    if (list) list.push(item);
    else itemsByProject.set(projectId, [item]);
  }
  // Effort-weighted: a plain mean would make a project with many tiny finished tasks look far
  // healthier than it is. An item with no estimate weighs as one hour.
  const weight = (i: Item) => (i.estimatedHours && i.estimatedHours > 0 ? i.estimatedHours : 1);
  const progressByProject = new Map<string, number>();
  for (const id of projectIds) {
    const items = itemsByProject.get(id) ?? [];
    const total = items.reduce((s, i) => s + weight(i), 0);
    progressByProject.set(id, total > 0 ? Math.round(items.reduce((s, i) => s + i.effectiveProgressPct * weight(i), 0) / total) : 0);
  }
  return { itemsByProject, progressByProject };
}

export interface CurrencyBurnTotal {
  currency: string;
  /** Summed budgets of the BUDGETED projects in this currency. */
  budget: number;
  /** Burn of those same budgeted projects — never of an unbudgeted one. */
  burn: number;
  /** burn ÷ budget, or null when the budget is zero. */
  burnPct: number | null;
  budgetedProjects: number;
  /** Burn in this currency that no budget in this currency covers: projects with no budget, and
   *  burn billed in this currency on a project budgeted in another. Reported, never in the ratio. */
  unbudgetedBurn: number;
}

/**
 * Budget and burn totals PER CURRENCY, with burn % over budgeted projects only.
 *
 * Two bugs this replaces, both in every roll-up: budgets in different currencies were added together
 * and labelled with whichever currency the first row had — the same refusal to mix currencies that
 * attestations already make is made here — and burn from projects with no budget went into the
 * numerator while only budgeted projects made the denominator, overstating burn %.
 *
 * A project's `otherCurrencyBurn` (billed in a currency that is not its budget's) lands in THAT
 * currency's `unbudgetedBurn`: it is real burn in that currency, and no budget in it covers it.
 */
export function burnTotalsByCurrency(
  rows: Iterable<Pick<ProjectBudget, "budget" | "burn" | "currency"> & { otherCurrencyBurn?: CurrencyAmount[] }>
): CurrencyBurnTotal[] {
  const totals = new Map<string, CurrencyBurnTotal>();
  const totalFor = (currency: string) =>
    totals.get(currency) ?? { currency, budget: 0, burn: 0, burnPct: null, budgetedProjects: 0, unbudgetedBurn: 0 };
  for (const row of rows) {
    const t = totalFor(row.currency);
    if (row.budget !== null && row.budget > 0) {
      t.budget += row.budget;
      t.burn += row.burn;
      t.budgetedProjects += 1;
    } else {
      t.unbudgetedBurn += row.burn;
    }
    totals.set(row.currency, t);
    for (const other of row.otherCurrencyBurn ?? []) {
      const o = totalFor(other.currency);
      o.unbudgetedBurn += other.amount;
      totals.set(other.currency, o);
    }
  }
  return [...totals.values()]
    .map((t) => ({
      ...t,
      budget: Number(t.budget.toFixed(2)),
      burn: Number(t.burn.toFixed(2)),
      unbudgetedBurn: Number(t.unbudgetedBurn.toFixed(2)),
      burnPct: t.budget > 0 ? Math.round((t.burn / t.budget) * 100) : null
    }))
    .sort((a, b) => b.budget - a.budget || a.currency.localeCompare(b.currency));
}
