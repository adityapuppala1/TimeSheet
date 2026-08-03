/**
 * WHAT: approval chains on work items — who has to sign off, in what order, and what a decision
 * does to the request as a whole.
 *
 * WHY THIS IS SEPARATE FROM THE TIMESHEET APPROVAL FLOW, which already exists and is untouched:
 * that one approves HOURS (`Timesheet.status` + `Escalation`, one approver, tied to the reporting
 * line). This one approves DELIVERABLES — a design, a release, a document — with an arbitrary
 * chain that can include people outside the company. Merging them would have meant one of the two
 * changing meaning, and the timesheet flow is load-bearing for payroll.
 *
 * WHY A GUEST APPROVER IS A TOKEN AND NOT A USER ROW: an external reviewer needs to approve
 * exactly one thing, once. Creating a half-real `User` who cannot log in — no password, no role,
 * no session — puts a row into every permission check, every user list, every seat count, and
 * every "who works here" report, forever, for a decision that took one click. The token carries
 * exactly the authority needed and expires with the request. Same reasoning as
 * `AttestationShareLink`.
 *
 * WHY REJECTION IS TERMINAL BUT APPROVAL IS NOT: one "no" is a decision about the deliverable, so
 * the request completes immediately and nobody else is asked to spend time on something already
 * turned down. One "yes" is only a step. The asymmetry is deliberate and is what stops a chain
 * from continuing to badger people after it is already settled.
 *
 * WHO CALLS THIS: `controllers/approval.controller.ts` (internal) and its public guest route.
 */
import { randomBytes } from "node:crypto";
import { AppError } from "../middleware/error.js";

export type Decision = "PENDING" | "APPROVED" | "REJECTED";

export interface ApprovalStepState {
  id: string;
  order: number;
  approverId: string | null;
  guestEmail: string | null;
  decision: Decision;
}

/** Unguessable, URL-safe, and never derived from the step id — the id is not a secret. */
export function issueGuestToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Which steps are being asked for a decision right now.
 *
 * Sequential: exactly the lowest-ordered undecided step. Parallel: every undecided step at once.
 * Everything else in this service is expressed in terms of this, so "who is this waiting on?" has
 * one answer that the reminder worker, the UI badge and the guest link all agree on.
 */
export function activeSteps(steps: ApprovalStepState[], isSequential: boolean): ApprovalStepState[] {
  const pending = steps.filter((s) => s.decision === "PENDING").sort((a, b) => a.order - b.order);
  if (pending.length === 0) return [];
  if (!isSequential) return pending;
  const lowest = pending[0].order;
  // Ties at the same order run together even in a sequential chain — two people given the same
  // step number were deliberately put side by side by whoever built the chain.
  return pending.filter((s) => s.order === lowest);
}

export function canDecide(step: ApprovalStepState, steps: ApprovalStepState[], isSequential: boolean): boolean {
  if (step.decision !== "PENDING") return false;
  return activeSteps(steps, isSequential).some((s) => s.id === step.id);
}

/**
 * The request's status after a decision lands.
 *
 * Returns PENDING while any step is still outstanding, APPROVED once every step has said yes, and
 * REJECTED the moment any step says no.
 */
export function requestStatusAfter(steps: ApprovalStepState[]): Decision {
  if (steps.some((s) => s.decision === "REJECTED")) return "REJECTED";
  if (steps.length > 0 && steps.every((s) => s.decision === "APPROVED")) return "APPROVED";
  return "PENDING";
}

export interface DecisionOutcome {
  /** What the request as a whole becomes. */
  status: Decision;
  completed: boolean;
  /** Steps that become askable as a result — who to notify next. Empty when the chain is done. */
  nextSteps: ApprovalStepState[];
  /** Steps that will never be asked, because a rejection settled it. Their pending reminders
   *  should stop; they are NOT marked decided, because nobody decided them. */
  supersededSteps: ApprovalStepState[];
}

/**
 * Applies one decision and reports everything that follows from it.
 *
 * Pure: the caller persists. That split is what makes the ordering rules testable without a
 * database, and they are the part with real edge cases — a rejection mid-chain, a tie at the same
 * order, the last approval completing the request.
 */
export function applyDecision(params: {
  steps: ApprovalStepState[];
  stepId: string;
  decision: "APPROVED" | "REJECTED";
  isSequential: boolean;
}): DecisionOutcome {
  const { steps, stepId, decision, isSequential } = params;
  const step = steps.find((s) => s.id === stepId);
  if (!step) throw new AppError(404, "That approval step no longer exists.");

  // Idempotence matters here more than usual: approval links are emailed, and an email client
  // that pre-fetches links, or a person who clicks twice, must not produce a different outcome
  // or a confusing error about a decision they did make.
  if (step.decision !== "PENDING") {
    throw new AppError(409, `This was already ${step.decision.toLowerCase()}.`);
  }
  if (!canDecide(step, steps, isSequential)) {
    throw new AppError(409, "It isn't this approver's turn yet.");
  }

  const updated = steps.map((s) => (s.id === stepId ? { ...s, decision } : s));
  const status = requestStatusAfter(updated);
  const completed = status !== "PENDING";

  return {
    status,
    completed,
    nextSteps: completed ? [] : activeSteps(updated, isSequential),
    supersededSteps: status === "REJECTED" ? updated.filter((s) => s.decision === "PENDING") : []
  };
}

export interface ChainInput {
  approverId?: string | null;
  guestEmail?: string | null;
  order?: number;
}

/**
 * Validates a chain before it is created.
 *
 * A step must name exactly one approver — internal or guest, never both and never neither. "Both"
 * is ambiguous about who the decision belongs to; "neither" is a step nobody can ever action,
 * which silently wedges the whole request.
 */
export function validateChain(steps: ChainInput[]): void {
  if (!Array.isArray(steps) || steps.length === 0) throw new AppError(400, "An approval needs at least one approver.");
  if (steps.length > 20) throw new AppError(400, "An approval can have at most 20 steps.");

  const seenApprovers = new Set<string>();
  steps.forEach((step, index) => {
    const hasInternal = Boolean(step.approverId);
    const hasGuest = Boolean(step.guestEmail?.trim());
    if (hasInternal === hasGuest) {
      throw new AppError(400, `Step ${index + 1} must name exactly one approver — a colleague or an email address, not both.`);
    }
    if (hasGuest && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(step.guestEmail!.trim())) {
      throw new AppError(400, `"${step.guestEmail}" is not a valid email address.`);
    }
    // The same person twice in one chain is asked to approve the same thing twice, which is
    // almost always a mistake in the builder rather than a real requirement.
    const identity = (step.approverId ?? step.guestEmail!.trim().toLowerCase());
    if (seenApprovers.has(identity)) throw new AppError(400, "The same approver appears twice in this chain.");
    seenApprovers.add(identity);
  });
}
