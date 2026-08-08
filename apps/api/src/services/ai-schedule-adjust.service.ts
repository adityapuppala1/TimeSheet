/**
 * WHAT: proposes date corrections for items whose explicit dates contradict their dependencies —
 * the producer for `SCHEDULE_ADJUSTMENT`, the second of the declared ProposalKinds to gain one.
 *
 * WHY THERE IS NO MODEL CALL IN HERE: the solver already computes, for every item, the earliest
 * start its dependencies allow — and it deliberately REPORTS a contradiction rather than silently
 * correcting it (see solveSchedule's header: "the difference between a tool that tells you your
 * plan is inconsistent and one that silently disagrees with what you entered"). This producer is
 * the missing third option: the correction, offered as a proposal a person applies row by row.
 * Asking a model to re-derive what the solver states exactly would be paying for a worse answer.
 *
 * HOW THE CORRECTED DATES ARE COMPUTED: the plan is solved a second time with the violating items'
 * explicit dates removed, so the solver infers the earliest legal dates for exactly those items
 * while everything else stays pinned where a human put it. Reusing the solver rather than
 * reimplementing "walk the dependency forward" means the proposal can never disagree with the
 * timeline's own arithmetic.
 *
 * WHO CALLS THIS: `controllers/ai-proposal.controller.ts` (the "Fix schedule conflicts" action).
 */
import { createProposalAndMaybeApply, type DraftChange } from "./ai-proposal.service.js";
import { buildPlan, dayKey, readWorkingDays, solveSchedule, type PlanDependency, type PlanItem } from "./plan-schedule.service.js";
import { prisma } from "../config/prisma.js";
import { AppError } from "../middleware/error.js";

/** Same reviewability ceiling as the rebalance producer, same reasoning: past this many rows a
 *  proposal stops being reviewed and starts being rubber-stamped. */
const MAX_CORRECTIONS = 12;

export interface ScheduleAdjustOutcome {
  proposalId: string | null;
  /** Why nothing was proposed, when nothing was. Only set when there is no proposal. */
  reason: string | null;
  /** Set when a proposal WAS produced but its capability was not allowed to apply it. */
  heldForReview: string | null;
  corrections: number;
}

export async function proposeScheduleAdjustment(params: {
  projectId: string;
  requestedById: string;
}): Promise<ScheduleAdjustOutcome> {
  const project = await prisma.project.findFirst({
    where: { id: params.projectId, deletedAt: null },
    select: { id: true, name: true }
  });
  if (!project) throw new AppError(404, "Project not found");

  const plan = await buildPlan({ projectIds: [project.id] });
  if (plan.violations.length === 0) {
    return { proposalId: null, reason: "Every date on this plan already agrees with its dependencies.", heldForReview: null, corrections: 0 };
  }

  // One violating item may contradict several dependencies; it still gets ONE correction.
  const violating = [...new Set(plan.violations.map((v) => v.itemId))].slice(0, MAX_CORRECTIONS);
  const violatingSet = new Set(violating);

  // Re-solve with the violating items' explicit dates stripped, so the solver infers the earliest
  // dates the dependency graph allows for exactly those items. Everything else keeps its pinned
  // dates — this corrects the contradiction, it does not reflow the plan. The links are fetched
  // fresh (buildPlan does not hand its list back out); the solver filters non-scheduling kinds
  // itself, so passing every link is correct.
  const workingDays = await readWorkingDays();
  const links = await prisma.ticketLink.findMany({
    where: { sourceTicketId: { in: plan.items.map((i) => i.id) } },
    select: { id: true, sourceTicketId: true, targetTicketId: true, type: true, lagDays: true }
  });
  const dependencies: PlanDependency[] = links.map((l) => ({
    id: l.id,
    fromId: l.sourceTicketId,
    toId: l.targetTicketId,
    type: l.type as PlanDependency["type"],
    lagDays: l.lagDays ?? 0
  }));
  const relaxed: PlanItem[] = plan.items.map((item) =>
    violatingSet.has(item.id) ? { ...item, startDate: null, endDate: null } : item
  );
  const solved = solveSchedule(relaxed, dependencies, { workingDays });
  const solvedById = new Map(solved.items.map((item) => [item.id, item]));

  const byId = new Map(plan.items.map((item) => [item.id, item]));
  const changes: DraftChange[] = [];
  for (const itemId of violating) {
    const current = byId.get(itemId);
    const corrected = solvedById.get(itemId);
    if (!current || !corrected) continue;

    const nextStart = dayKey(corrected.resolvedStart);
    const nextEnd = dayKey(corrected.resolvedEnd);
    const currentStart = current.startDate ? dayKey(current.startDate) : null;
    const currentEnd = current.endDate ? dayKey(current.endDate) : null;
    if (nextStart === currentStart && nextEnd === currentEnd) continue;

    changes.push({
      targetType: "TICKET",
      targetId: itemId,
      op: "UPDATE",
      // The before-state is the explicit dates the contradiction lives in — apply refuses if a
      // human has since moved them, and undo refuses if a human moves them after.
      before: { startDate: currentStart, endDate: currentEnd },
      after: { startDate: nextStart, endDate: nextEnd },
      summary: `Move ${current.key} to ${nextStart} – ${nextEnd}, the earliest its dependencies allow`
    });
  }

  if (changes.length === 0) {
    return {
      proposalId: null,
      reason: "The conflicting items have no dependency-legal dates to move to — a person needs to untangle the dependencies themselves.",
      heldForReview: null,
      corrections: 0
    };
  }

  const outcome = await createProposalAndMaybeApply({
    capability: "schedule_adjustment",
    kind: "SCHEDULE_ADJUSTMENT",
    title: `Fix ${changes.length} schedule conflict${changes.length === 1 ? "" : "s"} in ${project.name}`,
    rationale:
      `${plan.violations.length} date${plan.violations.length === 1 ? "" : "s"} on this plan contradict a dependency — the timeline already flags them. ` +
      `These corrections move each conflicting item to the earliest dates its predecessors allow, computed by the same solver the timeline uses. ` +
      `Nothing else on the plan moves.`,
    // No model, no confidence — the solver's answer is not a guess.
    scopeProjectId: project.id,
    requestedById: params.requestedById,
    changes
  });

  return { proposalId: outcome.proposalId, reason: null, heldForReview: outcome.heldForReview, corrections: changes.length };
}
