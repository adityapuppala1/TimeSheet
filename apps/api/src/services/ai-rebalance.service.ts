/**
 * WHAT: proposes moving bookings off people who are over-allocated and onto people with room —
 * the producer for `ASSIGNMENT_REBALANCE`, one of four ProposalKinds that had been declared since
 * the envelope was written with nothing emitting them.
 *
 * WHY THERE IS NO MODEL CALL IN HERE, and this is the important part: which people are overloaded
 * and by how much is ARITHMETIC. `workload.service.ts` already computes capacity, bookings, time
 * off and an allocation percentage per bucket, and `OVER_ALLOCATION_THRESHOLD_PCT` already encodes
 * where "fully booked" ends and "overloaded" begins. Asking a model to re-derive any of that would
 * be slower, cost money, and be wrong sometimes — for a question with an exact answer.
 *
 * That is the same rule the rest of this codebase already follows: the face threshold, the assignee
 * ranking and the project risk score are all computed, and the model only ever writes the sentence
 * explaining them. This producer does not even need the sentence, because "Ana is at 140% in the
 * week of the 12th; Ben is at 40%" says itself.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: decide. It emits a proposal, so a person sees "move these
 * three bookings" as three rows they accept or reject individually, with the before-state recorded
 * — and, since Phase 2, can put back. Moving somebody's work to somebody else is a management act.
 *
 * WHO CALLS THIS: `controllers/ai-proposal.controller.ts`.
 */
import { createProposalAndMaybeApply, type DraftChange } from "./ai-proposal.service.js";
import { loadWorkload, OVER_ALLOCATION_THRESHOLD_PCT } from "./workload.service.js";
import { prisma } from "../config/prisma.js";
import { AppError } from "../middleware/error.js";

/** Below this, somebody has genuine room rather than merely less work than the overloaded person.
 *  Moving a booking from 140% to 95% just moves the problem. */
const HAS_ROOM_BELOW_PCT = 80;

/** More than this and the proposal stops being reviewable and starts being a rubber stamp — the
 *  same reasoning behind createProposal's own 200-change ceiling, applied earlier and tighter
 *  because each row here moves a named person's work. */
const MAX_MOVES = 12;

export interface RebalanceOutcome {
  proposalId: string | null;
  /** Why nothing was proposed, when nothing was — so the caller can say something useful rather
   *  than showing an empty result that looks like a failure. */
  reason: string | null;
  moves: number;
}

/**
 * Look at one project over a window and propose the moves.
 *
 * Returns `proposalId: null` with a reason rather than throwing when there is nothing to do:
 * "everybody is within capacity" is a good outcome and a 404 would misrepresent it.
 */
export async function proposeAssignmentRebalance(params: {
  projectId: string;
  from: Date;
  to: Date;
  requestedById: string;
}): Promise<RebalanceOutcome> {
  const project = await prisma.project.findFirst({
    where: { id: params.projectId, deletedAt: null },
    select: { id: true, name: true }
  });
  if (!project) throw new AppError(404, "Project not found");

  const { rows } = await loadWorkload({
    from: params.from,
    to: params.to,
    granularity: "week",
    projectId: params.projectId
  });

  if (rows.length < 2) {
    return { proposalId: null, reason: "There is only one person assigned to this project, so there is nothing to rebalance.", moves: 0 };
  }

  const overloaded = rows.filter((r) => (r.totals.allocationPct ?? 0) >= OVER_ALLOCATION_THRESHOLD_PCT);
  if (overloaded.length === 0) {
    return { proposalId: null, reason: "Nobody on this project is over capacity in that window.", moves: 0 };
  }

  // Sorted so the emptiest person is offered work first; a stable tiebreak on id keeps the same
  // input producing the same proposal, which matters when somebody re-runs this after rejecting.
  const withRoom = rows
    .filter((r) => (r.totals.allocationPct ?? 0) < HAS_ROOM_BELOW_PCT)
    .sort((a, b) => (a.totals.allocationPct ?? 0) - (b.totals.allocationPct ?? 0) || a.person.id.localeCompare(b.person.id));

  if (withRoom.length === 0) {
    return {
      proposalId: null,
      reason: "Somebody is over capacity, but nobody else on this project has room — this needs more people or a later deadline, not a reshuffle.",
      moves: 0
    };
  }

  const bookings = await prisma.resourceBooking.findMany({
    where: {
      projectId: params.projectId,
      userId: { in: overloaded.map((r) => r.person.id) },
      isTimeOff: false,
      startDate: { lte: params.to },
      endDate: { gte: params.from }
    },
    orderBy: [{ hoursPerDay: "desc" }, { id: "asc" }],
    select: { id: true, userId: true, hoursPerDay: true, startDate: true, endDate: true, note: true }
  });

  const nameById = new Map(rows.map((r) => [r.person.id, r.person.name]));
  // Tracks what each candidate has been given WITHIN this proposal, so a person with room for one
  // booking is not handed five. Without it every move would target the same emptiest person, and
  // applying the proposal would create the problem it was written to solve.
  const assignedHours = new Map<string, number>();

  const changes: DraftChange[] = [];
  for (const booking of bookings) {
    if (changes.length >= MAX_MOVES) break;

    const target = withRoom.find((candidate) => {
      if (candidate.person.id === booking.userId) return false;
      const capacity = candidate.totals.capacityHours || 0;
      const booked = candidate.totals.bookedHours + (assignedHours.get(candidate.person.id) ?? 0);
      // Measured against the same threshold the board uses, so a move never pushes somebody into
      // the state this exists to relieve.
      return capacity > 0 && ((booked + Number(booking.hoursPerDay)) / capacity) * 100 < OVER_ALLOCATION_THRESHOLD_PCT;
    });
    if (!target) continue;

    assignedHours.set(target.person.id, (assignedHours.get(target.person.id) ?? 0) + Number(booking.hoursPerDay));

    const fromName = nameById.get(booking.userId) ?? "someone";
    const label = booking.note ? `"${booking.note}"` : `${Number(booking.hoursPerDay)}h/day`;
    changes.push({
      targetType: "BOOKING",
      targetId: booking.id,
      op: "UPDATE",
      // The before-state is what makes this applicable and reversible: apply refuses if the
      // booking has moved since, and undo refuses if somebody has moved it after.
      before: { userId: booking.userId },
      after: { userId: target.person.id },
      summary: `Move ${label} from ${fromName} to ${target.person.name}`
    });
  }

  if (changes.length === 0) {
    return {
      proposalId: null,
      reason: "The overloaded work is in blocks too large for anyone else's remaining capacity — splitting it would need a person to decide how.",
      moves: 0
    };
  }

  const worst = overloaded[0];
  const outcome = await createProposalAndMaybeApply({
    // The producer does not decide whether it may act — createProposalAndMaybeApply asks the
    // policy. A producer that made its own call would be one more place to get it wrong.
    capability: "assignment_rebalance",
    kind: "ASSIGNMENT_REBALANCE",
    title: `Rebalance ${project.name}`,
    rationale:
      `${overloaded.length} ${overloaded.length === 1 ? "person is" : "people are"} over capacity in this window — ` +
      `${worst.person.name} is at ${Math.round(worst.totals.allocationPct ?? 0)}%. ` +
      `These moves put the work with people who have room, measured against the same capacity figures the workload board shows.`,
    // No `model` and no `confidence`: nothing here came from a model, and claiming a confidence
    // score for arithmetic would be inventing a number.
    scopeProjectId: project.id,
    requestedById: params.requestedById,
    changes
  });

  return {
    proposalId: outcome.proposalId,
    // A proposal held back by a guardrail is not a failure — it is the state the product had
    // before autonomy existed, and the caller should say so rather than show nothing.
    reason: outcome.heldForReview,
    moves: changes.length
  };
}
