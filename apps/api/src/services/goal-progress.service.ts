/**
 * WHAT: the measured half of Goals — one compute function per GoalProgressSource, plus the
 * health derivation that turns a measurement, a period and a target into on-track / at-risk /
 * off-track.
 *
 * WHY THE CATALOGUE IS CLOSED (same two reasons as the dashboard widget catalogue): a metric is
 * a number somebody will be judged against at quarter-end. If two goals wearing the same label
 * can be defined differently, they will be, and the person who notices is in the review meeting.
 * And a user-defined metric is a query surface reachable by anyone who can create a goal. The
 * cost — a new source needs a server change — is the right trade, made here for the third time
 * (widgets, then MCP tools, now this).
 *
 * WHY NOTHING IS STORED: every number is derived on read, the portfolio posture. A stored
 * progress% would need a recompute worker, and a stale stored number on a goals page is worse
 * than a slow fresh one — it is the exact "talked up in a status meeting" failure the measured
 * design exists to prevent. At this data volume the queries are cheap aggregates over indexed
 * columns.
 *
 * WHY `unavailable` IS A FIRST-CLASS RESULT, never 0: "no data in the period" and "0 hours
 * approved" are opposite messages that look identical as a zero — the dashboard-widget rule,
 * applied to the number that matters most. A measured goal with no period dates is unavailable
 * by definition; a measurement with no window is not a measurement.
 *
 * WHO CALLS THIS: `controllers/goal.controller.ts`, on read. Nothing else.
 */
import { Prisma, type GoalProgressSource } from "@prisma/client";
import { prisma } from "../config/prisma.js";

/** AT_LEAST: current climbs toward target (hours, tickets, on-time%). AT_MOST: current must
 *  stay under target (spend, breaches, risk). The direction decides both the progress% shape
 *  and what "ahead of schedule" means, so it lives in one place. */
export type GoalDirection = "AT_LEAST" | "AT_MOST";

export const SOURCE_DIRECTION: Record<GoalProgressSource, GoalDirection> = {
  MANUAL: "AT_LEAST",
  APPROVED_HOURS: "AT_LEAST",
  BUDGET_SPEND: "AT_MOST",
  TICKETS_CLOSED: "AT_LEAST",
  ON_TIME_RATE: "AT_LEAST",
  SLA_BREACHES: "AT_MOST",
  RISK_SCORE: "AT_MOST"
};

export type GoalHealth = "ON_TRACK" | "AT_RISK" | "OFF_TRACK";

export interface GoalMeasurement {
  /** Null exactly when `unavailable` — never 0-as-placeholder. */
  currentValue: number | null;
  /** 0–100 for AT_LEAST sources; null for AT_MOST, where a % toward a ceiling misleads. */
  progressPct: number | null;
  health: GoalHealth | null;
  unavailable: boolean;
  /** Why, when unavailable — "no period set", "no linked data". Shown verbatim in the UI. */
  unavailableReason: string | null;
}

const UNAVAILABLE = (reason: string): GoalMeasurement => ({
  currentValue: null,
  progressPct: null,
  health: null,
  unavailable: true,
  unavailableReason: reason
});

interface GoalScope {
  /** Empty array = whole workspace (a goal with no links measures everything). */
  projectIds: string[];
  ticketIds: string[];
}

/**
 * PORTFOLIO links expand to their member projects AT READ TIME, never stored expanded — a
 * portfolio that gains a project next week must widen every goal linked to it without anyone
 * touching those goals. Dangling ids (soft-deleted projects) simply drop out of the IN list.
 */
export async function resolveGoalScope(goalId: string): Promise<GoalScope> {
  const links = await prisma.goalLink.findMany({ where: { goalId } });
  const projectIds = new Set<string>();
  const ticketIds = new Set<string>();
  const portfolioIds: string[] = [];
  for (const link of links) {
    if (link.targetType === "PROJECT") projectIds.add(link.targetId);
    else if (link.targetType === "TICKET") ticketIds.add(link.targetId);
    else portfolioIds.push(link.targetId);
  }
  if (portfolioIds.length > 0) {
    const projects = await prisma.project.findMany({
      where: { portfolioId: { in: portfolioIds }, deletedAt: null },
      select: { id: true }
    });
    for (const p of projects) projectIds.add(p.id);
  }
  return { projectIds: [...projectIds], ticketIds: [...ticketIds] };
}

/** Fraction of the goal period already elapsed, clamped to [0,1]. The pace baseline. */
export function elapsedFraction(startDate: Date, endDate: Date, now: Date): number {
  const total = endDate.getTime() - startDate.getTime();
  if (total <= 0) return 1;
  return Math.min(1, Math.max(0, (now.getTime() - startDate.getTime()) / total));
}

/**
 * Health, from direction + pace. The thresholds are deliberately forgiving-but-fixed:
 * - AT_LEAST: on track when progress keeps pace with the elapsed period (within 10 points),
 *   at risk within 25, off track beyond that. Progress ≥ 100 is on track regardless of pace.
 * - AT_MOST: on track while current ≤ target × elapsed (spending/breaching no faster than the
 *   period passes), at risk within 15% over that line, off track beyond — and always off track
 *   once the ceiling itself is breached.
 * Fixed rather than configurable: a threshold each org tunes is a threshold nobody can compare
 * across orgs, and "what does at-risk mean here" should have one answer in the product.
 */
export function deriveHealth(params: {
  direction: GoalDirection;
  currentValue: number;
  targetValue: number;
  elapsed: number;
}): GoalHealth {
  const { direction, currentValue, targetValue, elapsed } = params;
  if (direction === "AT_LEAST") {
    if (targetValue <= 0) return "ON_TRACK";
    const pct = (currentValue / targetValue) * 100;
    if (pct >= 100) return "ON_TRACK";
    const paceGap = elapsed * 100 - pct;
    if (paceGap <= 10) return "ON_TRACK";
    if (paceGap <= 25) return "AT_RISK";
    return "OFF_TRACK";
  }
  // AT_MOST
  if (currentValue > targetValue) return "OFF_TRACK";
  const paceLine = targetValue * elapsed;
  if (currentValue <= paceLine || elapsed === 0) return "ON_TRACK";
  return currentValue <= paceLine * 1.15 ? "AT_RISK" : "OFF_TRACK";
}

function measurementFrom(params: {
  source: GoalProgressSource;
  currentValue: number;
  targetValue: number;
  elapsed: number;
}): GoalMeasurement {
  const direction = SOURCE_DIRECTION[params.source];
  const progressPct =
    direction === "AT_LEAST" && params.targetValue > 0
      ? Math.min(100, Math.round((params.currentValue / params.targetValue) * 100))
      : null;
  return {
    currentValue: params.currentValue,
    progressPct,
    health: deriveHealth({
      direction,
      currentValue: params.currentValue,
      targetValue: params.targetValue,
      elapsed: params.elapsed
    }),
    unavailable: false,
    unavailableReason: null
  };
}

/** Scope predicate shared by the ticket-shaped sources. Ticket links only bite here — hours and
 *  money are project-grained facts and a ticket link cannot scope them honestly. */
function ticketScopeWhere(scope: GoalScope): Prisma.TicketWhereInput {
  const clauses: Prisma.TicketWhereInput[] = [];
  if (scope.projectIds.length > 0) clauses.push({ projectId: { in: scope.projectIds } });
  if (scope.ticketIds.length > 0) clauses.push({ id: { in: scope.ticketIds } });
  return clauses.length > 0 ? { OR: clauses } : {};
}

/** A source either produced a number or could not. One shape so the dispatch stays flat. */
type SourceResult = { value: number } | { reason: string };

interface SourceInput {
  scope: GoalScope;
  period: { gte: Date; lte: Date };
}

const projectWhere = (scope: GoalScope) =>
  scope.projectIds.length > 0 ? { projectId: { in: scope.projectIds } } : {};

const dayFloor = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * One computer per measured source. Each is small enough to read in full, which is the point:
 * these are the definitions somebody will be judged against, so they must be reviewable
 * individually rather than buried in a branch of a long switch.
 */
const SOURCE_COMPUTERS: Record<
  Exclude<GoalProgressSource, "MANUAL">,
  (input: SourceInput) => Promise<SourceResult>
> = {
  // APPROVED only — the measured design reads the ledger, and the ledger is approval.
  APPROVED_HOURS: async ({ scope, period }) => {
    const agg = await prisma.timesheet.aggregate({
      _sum: { totalHours: true },
      where: { status: "APPROVED", workDate: period, ...projectWhere(scope) }
    });
    return { value: Number(agg._sum.totalHours ?? 0) };
  },

  // billedAmount is the rate snapshot an attestation reads — the one definition of money.
  BUDGET_SPEND: async ({ scope, period }) => {
    const agg = await prisma.timesheet.aggregate({
      _sum: { billedAmount: true },
      where: { status: "APPROVED", workDate: period, ...projectWhere(scope) }
    });
    return { value: Number(agg._sum.billedAmount ?? 0) };
  },

  TICKETS_CLOSED: async ({ scope, period }) => ({
    value: await prisma.ticket.count({ where: { closedAt: period, ...ticketScopeWhere(scope) } })
  }),

  // Share of tickets CLOSED in the period that closed by their planned endDate, falling back to
  // the SLA-derived `dueAt` when the ticket was never scheduled. Tickets with neither date are
  // excluded from the denominator rather than counted as on-time — an unplanned close is not
  // evidence of punctuality.
  ON_TIME_RATE: async ({ scope, period }) => {
    const closed = await prisma.ticket.findMany({
      where: { closedAt: period, ...ticketScopeWhere(scope) },
      select: { closedAt: true, endDate: true, dueAt: true }
    });
    const judged = closed.filter((t) => t.endDate ?? t.dueAt);
    if (judged.length === 0) return { reason: "no dated tickets closed in the period" };
    const onTime = judged.filter((t) => {
      const due = t.endDate ?? t.dueAt!;
      // endDate is a DATE column — closing any time that day is on time, so compare days.
      return t.endDate ? dayFloor(t.closedAt!) <= dayFloor(due) : t.closedAt! <= due;
    }).length;
    return { value: Math.round((onTime / judged.length) * 100) };
  },

  SLA_BREACHES: async ({ scope, period }) => {
    const scoped = scope.projectIds.length > 0 || scope.ticketIds.length > 0;
    return {
      value: await prisma.ticketEscalation.count({
        where: { createdAt: period, ...(scoped ? { ticket: ticketScopeWhere(scope) } : {}) }
      })
    };
  },

  // Latest snapshot per linked project, averaged. Workspace-wide (no links) averages the latest
  // snapshot of every project that has one.
  RISK_SCORE: async ({ scope }) => {
    const latest = await prisma.projectRiskSnapshot.findMany({
      where: projectWhere(scope),
      orderBy: { computedAt: "desc" },
      distinct: ["projectId"],
      select: { riskScore: true }
    });
    if (latest.length === 0) return { reason: "no risk snapshots for the linked projects" };
    return { value: Math.round(latest.reduce((sum, s) => sum + s.riskScore, 0) / latest.length) };
  }
};

/** MANUAL: stated, not computed. Health still derives from pace, so a manual goal is not exempt
 *  from "is this keeping up with the quarter" — only from how the number is produced. */
function measureManual(
  goal: { startDate: Date | null; endDate: Date | null; manualProgressPct: number | null },
  now: Date
): GoalMeasurement {
  if (goal.manualProgressPct == null) return UNAVAILABLE("no progress recorded yet");
  const elapsed = goal.startDate && goal.endDate ? elapsedFraction(goal.startDate, goal.endDate, now) : 0;
  const pct = Math.min(100, Math.max(0, goal.manualProgressPct));
  return {
    currentValue: goal.manualProgressPct,
    progressPct: pct,
    health: deriveHealth({ direction: "AT_LEAST", currentValue: goal.manualProgressPct, targetValue: 100, elapsed }),
    unavailable: false,
    unavailableReason: null
  };
}

/**
 * The compute dispatch. `now` is a parameter (not read from the clock inside) so tests can pin
 * pace arithmetic to a fixed day — the same reason plan-schedule.service takes explicit dates.
 */
export async function measureGoal(
  goal: {
    id: string;
    progressSource: GoalProgressSource;
    startDate: Date | null;
    endDate: Date | null;
    targetValue: Prisma.Decimal | null;
    manualProgressPct: number | null;
  },
  now: Date = new Date()
): Promise<GoalMeasurement> {
  if (goal.progressSource === "MANUAL") return measureManual(goal, now);

  // Every measured source needs a window and a target — without either it is not a measurement.
  if (!goal.startDate || !goal.endDate) return UNAVAILABLE("no period set");
  if (goal.targetValue == null) return UNAVAILABLE("no target set");

  const compute = SOURCE_COMPUTERS[goal.progressSource];
  if (!compute) return UNAVAILABLE("unknown source");

  const result = await compute({
    scope: await resolveGoalScope(goal.id),
    period: { gte: goal.startDate, lte: goal.endDate }
  });
  if ("reason" in result) return UNAVAILABLE(result.reason);

  return measurementFrom({
    source: goal.progressSource,
    currentValue: result.value,
    targetValue: Number(goal.targetValue),
    elapsed: elapsedFraction(goal.startDate, goal.endDate, now)
  });
}
