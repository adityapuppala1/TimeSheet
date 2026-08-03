/**
 * WHAT: project delivery risk — a 0-100 score computed from signals this app already measures,
 * and the RED/AMBER/GREEN band that follows from it.
 *
 * WHY THE SCORE IS ARITHMETIC AND THE LLM ONLY NARRATES IT: a project going red is a number
 * somebody will be asked to defend in a meeting. "The model thinks it's risky" is not defensible,
 * not reproducible, and not auditable — run it twice and it may disagree with itself, and nobody
 * can answer "what would have to change for this to go green?". Every signal below is measured,
 * every weight is stated, and the breakdown is stored alongside the score so the answer is always
 * available without recomputing against data that has since moved. This is the same division of
 * labour `face.service.ts#recommendMatchThreshold` uses, and for the same reason: it is a
 * decision-support control, not a chat feature.
 *
 * WHY THE WEIGHTS ARE WHAT THEY ARE: they are ordered by how early each signal predicts trouble.
 * Schedule slip against a frozen baseline is the earliest honest warning, so it carries the most.
 * Budget overrun is nearly as strong but arrives later, because spend lags work. Blocked
 * dependencies and over-allocation are leading indicators of slip that has not happened yet.
 * SLA breaches and reopen rate are quality signals that usually confirm what the others already
 * said. Nothing here is tuned against a dataset — these are stated judgements, and they are in
 * one place so they can be argued with.
 *
 * WHO CALLS THIS: `workers/project-risk.worker.ts` (nightly, via runForEveryOrg),
 * `controllers/ai-proposal.controller.ts` (on demand), and the portfolio roll-up.
 */
import { prisma } from "../config/prisma.js";
import { buildPlan, dayKey, legacyCategory, readWorkingDays, workingDaysBetween } from "./plan-schedule.service.js";
import { computeProjectBudgets } from "./budget.service.js";
import { loadWorkload } from "./workload.service.js";

export type RiskBand = "GREEN" | "AMBER" | "RED";

/**
 * Each signal contributes at most its weight. They sum to 100, so the score is directly readable
 * as "how much of everything that could be wrong, is".
 */
export const RISK_WEIGHTS = {
  scheduleSlip: 25,
  budgetOverrun: 20,
  blockedWork: 15,
  overAllocation: 15,
  slaBreaches: 15,
  reopenRate: 10
} as const;

export type RiskSignalKey = keyof typeof RISK_WEIGHTS;

export interface RiskSignal {
  key: RiskSignalKey;
  /** 0-1, how bad this particular signal is. */
  severity: number;
  /** severity × weight, rounded — what this signal contributed to the total. */
  points: number;
  /** The measured facts behind it, for the explanation. */
  detail: Record<string, number | string | null>;
  /** One sentence a person can act on. Empty when the signal is clean. */
  note: string;
}

export interface RiskAssessment {
  projectId: string;
  riskScore: number;
  band: RiskBand;
  signals: RiskSignal[];
  /** Ordered worst-first — what to fix, in order. */
  topConcerns: string[];
  /** Enough measured context for a narrator to write about without inventing anything. */
  facts: Record<string, number | string | null>;
}

/** A band is a threshold on the score, stated once so the table, the badge and the AI agree. */
export function bandFor(score: number): RiskBand {
  if (score >= 55) return "RED";
  if (score >= 25) return "AMBER";
  return "GREEN";
}

/** Clamps a ratio into 0-1 so no single signal can exceed its weight, however extreme the input. */
const ratio = (value: number, worstCase: number): number => {
  if (worstCase <= 0) return 0;
  return Math.max(0, Math.min(1, value / worstCase));
};

export interface RiskInputs {
  projectId: string;
  /** Working days the plan has slipped past its frozen baseline. Negative = ahead. */
  worstSlipDays: number;
  slippedItemCount: number;
  /** True when the solved schedule runs past the project's own planned end date. */
  overrunsPlannedEnd: boolean;
  plannedEndOverrunDays: number;

  budget: number | null;
  burn: number;
  forecastAtCompletion: number | null;

  /** Items whose predecessors are unfinished. */
  blockedCount: number;
  openCount: number;
  /** Dates that contradict a dependency — a plan that disagrees with itself. */
  violationCount: number;

  overAllocatedPeople: number;
  teamSize: number;

  slaBreachCount: number;
  reopenedCount: number;
  resolvedCount: number;

  progressPct: number;
}

/**
 * The whole scoring rule, as one pure function.
 *
 * Pure because this is the part that has to be explainable and testable: given these numbers, the
 * score is always this. No database, no clock, no model.
 */
export function assessRisk(input: RiskInputs): RiskAssessment {
  const signals: RiskSignal[] = [];

  /* --- Schedule slip: the earliest honest warning ---------------------------------------- */
  // 15 working days (three weeks) of slip is treated as the worst case. Beyond that a project is
  // not "more late" in a way the score needs to distinguish — it is simply late, and the number
  // has already done its job.
  const slipSeverity = Math.max(
    ratio(input.worstSlipDays, 15),
    input.overrunsPlannedEnd ? ratio(input.plannedEndOverrunDays, 15) : 0
  );
  signals.push({
    key: "scheduleSlip",
    severity: slipSeverity,
    points: Math.round(slipSeverity * RISK_WEIGHTS.scheduleSlip),
    detail: {
      worstSlipDays: input.worstSlipDays,
      slippedItems: input.slippedItemCount,
      plannedEndOverrunDays: input.overrunsPlannedEnd ? input.plannedEndOverrunDays : 0
    },
    note:
      slipSeverity === 0
        ? ""
        : input.overrunsPlannedEnd
          ? `The schedule runs ${input.plannedEndOverrunDays} working day(s) past the planned end date.`
          : `${input.slippedItemCount} item(s) have slipped, the worst by ${input.worstSlipDays} working day(s).`
  });

  /* --- Budget: nearly as strong, but arrives later ---------------------------------------- */
  // Measured against the FORECAST, not the spend so far. Spend lags work, so "we're only 40%
  // through the budget" is meaningless at 20% progress — the forecast is what already accounts
  // for that, and it is null when there isn't enough data to say (see budget.service.ts).
  const overrunRatio =
    input.budget && input.budget > 0 && input.forecastAtCompletion
      ? Math.max(0, (input.forecastAtCompletion - input.budget) / input.budget)
      : 0;
  // 50% over is the worst case: at that point the conversation is not about a score.
  const budgetSeverity = ratio(overrunRatio, 0.5);
  signals.push({
    key: "budgetOverrun",
    severity: budgetSeverity,
    points: Math.round(budgetSeverity * RISK_WEIGHTS.budgetOverrun),
    detail: {
      budget: input.budget,
      burn: input.burn,
      forecast: input.forecastAtCompletion,
      overrunPct: Math.round(overrunRatio * 100)
    },
    note:
      budgetSeverity === 0
        ? ""
        : `Forecast to complete is ${Math.round(overrunRatio * 100)}% over budget.`
  });

  /* --- Blocked work: a leading indicator of slip that has not happened yet ---------------- */
  // As a share of open work, not an absolute count: three blocked items out of five is a stalled
  // project, three out of two hundred is a normal Tuesday. Violations count double because a plan
  // that contradicts itself is worse than one that is merely waiting.
  const blockedShare = ratio(input.blockedCount + input.violationCount * 2, Math.max(1, input.openCount));
  signals.push({
    key: "blockedWork",
    severity: blockedShare,
    points: Math.round(blockedShare * RISK_WEIGHTS.blockedWork),
    detail: { blocked: input.blockedCount, open: input.openCount, schedulingConflicts: input.violationCount },
    note:
      blockedShare === 0
        ? ""
        : input.violationCount > 0
          ? `${input.blockedCount} item(s) are blocked and ${input.violationCount} date(s) contradict a dependency.`
          : `${input.blockedCount} of ${input.openCount} open items are waiting on something else.`
  });

  /* --- Over-allocation: the other leading indicator ---------------------------------------- */
  const overAllocShare = ratio(input.overAllocatedPeople, Math.max(1, input.teamSize));
  signals.push({
    key: "overAllocation",
    severity: overAllocShare,
    points: Math.round(overAllocShare * RISK_WEIGHTS.overAllocation),
    detail: { overAllocated: input.overAllocatedPeople, teamSize: input.teamSize },
    note:
      overAllocShare === 0
        ? ""
        : `${input.overAllocatedPeople} of ${input.teamSize} people are booked past their capacity.`
  });

  /* --- SLA breaches: usually confirms what the others already said ------------------------ */
  const breachShare = ratio(input.slaBreachCount, Math.max(1, input.openCount));
  signals.push({
    key: "slaBreaches",
    severity: breachShare,
    points: Math.round(breachShare * RISK_WEIGHTS.slaBreaches),
    detail: { breaches: input.slaBreachCount, open: input.openCount },
    note: breachShare === 0 ? "" : `${input.slaBreachCount} open item(s) are past their SLA.`
  });

  /* --- Reopen rate: quality ---------------------------------------------------------------- */
  // A quarter of finished work coming back is the worst case. Below ~5% is normal and scores
  // near zero rather than nagging.
  const reopenRate = input.resolvedCount > 0 ? input.reopenedCount / input.resolvedCount : 0;
  const reopenSeverity = ratio(reopenRate, 0.25);
  signals.push({
    key: "reopenRate",
    severity: reopenSeverity,
    points: Math.round(reopenSeverity * RISK_WEIGHTS.reopenRate),
    detail: { reopened: input.reopenedCount, resolved: input.resolvedCount, ratePct: Math.round(reopenRate * 100) },
    note: reopenSeverity === 0 ? "" : `${Math.round(reopenRate * 100)}% of resolved work has been reopened.`
  });

  const riskScore = Math.min(100, signals.reduce((sum, s) => sum + s.points, 0));

  return {
    projectId: input.projectId,
    riskScore,
    band: bandFor(riskScore),
    signals,
    topConcerns: signals
      .filter((s) => s.points > 0 && s.note)
      .sort((a, b) => b.points - a.points)
      .map((s) => s.note),
    facts: {
      progressPct: input.progressPct,
      openItems: input.openCount,
      blockedItems: input.blockedCount,
      slippedItems: input.slippedItemCount,
      worstSlipDays: input.worstSlipDays,
      budget: input.budget,
      burn: input.burn,
      forecast: input.forecastAtCompletion,
      overAllocatedPeople: input.overAllocatedPeople,
      slaBreaches: input.slaBreachCount,
      reopenRatePct: Math.round(reopenRate * 100)
    }
  };
}

/* ================================================================== *
 * DB shell
 * ================================================================== */

/** Gathers every signal for one project and scores it. Reads only; persisting is the caller's. */
export async function assessProject(projectId: string): Promise<RiskAssessment & { projectName: string; projectCode: string }> {
  const project = await prisma.project.findFirstOrThrow({
    where: { id: projectId, deletedAt: null },
    select: { id: true, code: true, name: true, plannedEndDate: true }
  });

  const workingDays = await readWorkingDays();
  const plan = await buildPlan({ projectIds: [projectId], includeClosed: true });

  const weight = (i: (typeof plan.items)[number]) => (i.estimatedHours && i.estimatedHours > 0 ? i.estimatedHours : 1);
  const totalWeight = plan.items.reduce((sum, i) => sum + weight(i), 0);
  const progressPct =
    totalWeight > 0 ? Math.round(plan.items.reduce((sum, i) => sum + i.effectiveProgressPct * weight(i), 0) / totalWeight) : 0;

  const slipped = plan.items.filter((i) => (i.slipDays ?? 0) > 0);
  const worstSlipDays = slipped.reduce((max, i) => Math.max(max, i.slipDays ?? 0), 0);
  const planEnd = plan.end;
  const overrunsPlannedEnd = Boolean(project.plannedEndDate && planEnd && planEnd > project.plannedEndDate);
  const plannedEndOverrunDays =
    overrunsPlannedEnd && project.plannedEndDate && planEnd
      ? Math.max(0, workingDaysBetween(project.plannedEndDate, planEnd, workingDays) - 1)
      : 0;

  // "Blocked" means a predecessor is genuinely unfinished — not merely that a link exists.
  const openItems = plan.items.filter((i) => i.statusCategory !== "DONE" && i.statusCategory !== "CANCELLED");
  const doneIds = new Set(plan.items.filter((i) => i.statusCategory === "DONE").map((i) => i.id));
  const links = await prisma.ticketLink.findMany({
    where: {
      type: { in: ["BLOCKS", "FINISH_TO_START"] },
      targetTicketId: { in: openItems.map((i) => i.id) }
    },
    select: { sourceTicketId: true, targetTicketId: true }
  });
  const blockedIds = new Set(links.filter((l) => !doneIds.has(l.sourceTicketId)).map((l) => l.targetTicketId));

  const [budgets, counts, workload] = await Promise.all([
    computeProjectBudgets([projectId], new Map([[projectId, progressPct]])),
    prisma.ticket.groupBy({
      by: ["status"],
      where: { projectId, deletedAt: null },
      _count: { _all: true }
    }),
    // Scoped to this project's assigned people; a company-wide over-allocation is not this
    // project's risk, and attributing it here would make every project red at once.
    loadWorkload({
      from: new Date(),
      to: new Date(Date.now() + 28 * 86_400_000),
      projectId
    }).catch(() => null)
  ]);

  const slaBreachCount = await prisma.ticket.count({
    where: { projectId, deletedAt: null, slaBreachAt: { not: null }, status: { notIn: ["RESOLVED", "CLOSED"] } }
  });
  const reopenedCount = counts.find((c) => c.status === "REOPENED")?._count._all ?? 0;
  const resolvedCount = counts
    .filter((c) => legacyCategory(c.status) === "DONE")
    .reduce((sum, c) => sum + c._count._all, 0);

  const money = budgets.get(projectId);

  const assessment = assessRisk({
    projectId,
    worstSlipDays,
    slippedItemCount: slipped.length,
    overrunsPlannedEnd,
    plannedEndOverrunDays,
    budget: money?.budget ?? null,
    burn: money?.burn ?? 0,
    forecastAtCompletion: money?.forecastAtCompletion ?? null,
    blockedCount: blockedIds.size,
    openCount: openItems.length,
    violationCount: plan.violations.length,
    overAllocatedPeople: workload?.rows.filter((r) => r.totals.overAllocatedBuckets > 0).length ?? 0,
    teamSize: workload?.rows.length ?? 0,
    slaBreachCount,
    reopenedCount,
    resolvedCount,
    progressPct
  });

  return {
    ...assessment,
    projectName: project.name,
    projectCode: project.code,
    facts: {
      ...assessment.facts,
      scheduleEnd: planEnd ? dayKey(planEnd) : null,
      plannedEnd: project.plannedEndDate ? dayKey(project.plannedEndDate) : null
    }
  };
}

/** Stores a snapshot. Kept separate from assessment so a preview can score without writing. */
export async function saveSnapshot(assessment: RiskAssessment, aiNarrative?: string | null, aiProposalId?: string | null) {
  return prisma.projectRiskSnapshot.create({
    data: {
      projectId: assessment.projectId,
      riskScore: assessment.riskScore,
      band: assessment.band,
      // The full breakdown, not just the score: "why is this red?" must be answerable later
      // without recomputing against data that has since changed.
      signals: { signals: assessment.signals, facts: assessment.facts, topConcerns: assessment.topConcerns } as never,
      aiNarrative: aiNarrative ?? null,
      aiProposalId: aiProposalId ?? null
    }
  });
}

/** Latest snapshot per project, for badges and the portfolio table. */
export async function latestSnapshots(projectIds: string[]) {
  if (projectIds.length === 0) return new Map<string, { riskScore: number; band: RiskBand; computedAt: Date; aiNarrative: string | null }>();
  const rows = await prisma.projectRiskSnapshot.findMany({
    where: { projectId: { in: projectIds } },
    orderBy: { computedAt: "desc" },
    select: { projectId: true, riskScore: true, band: true, computedAt: true, aiNarrative: true }
  });
  const out = new Map<string, { riskScore: number; band: RiskBand; computedAt: Date; aiNarrative: string | null }>();
  for (const row of rows) {
    // findMany is ordered newest-first, so the first one seen per project is the latest.
    if (!out.has(row.projectId)) {
      out.set(row.projectId, { riskScore: row.riskScore, band: row.band as RiskBand, computedAt: row.computedAt, aiNarrative: row.aiNarrative });
    }
  }
  return out;
}
