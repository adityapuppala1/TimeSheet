/**
 * WHAT: the one way a change moves through its lifecycle — the gates it must pass, the writes that
 * move it, and what happens because it moved: the approval round, the stage timestamps, the
 * ticket's status and stamps, the audit row, the domain event and the submission email.
 *
 * WHY ONE FUNCTION WITH SEVERAL CALLERS: the transition route, the Workflow Studio's "Move a change"
 * action, and an accepted proposal from a flow that may only propose all move changes. When the side
 * effects lived inside the route, the automation action re-entered the gates and forgot everything
 * else — a flow could put a change into AWAITING_APPROVAL with no approval round, no submission
 * time and no email: a change nobody had been asked to decide, which the decision route then
 * refused to the manager and crashed on for a super admin. A second copy is how that happens, so
 * there is no second copy.
 *
 * WHAT IS NOT HERE: the approval DECISION. APPROVED and REJECTED are written only by
 * `POST /changes/:id/decision`, which checks who is asking. Nothing in this file reaches them except
 * SCHEDULED → APPROVED ("unschedule it"), which involves no approval at all — and the automation
 * callers refuse even that.
 */
import type { ChangeRequest, Prisma } from "@prisma/client";
import type { ChangeState } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { AppError } from "../middleware/error.js";
import { audit, type AuditProvenance } from "./audit.service.js";
import { sendChangeSubmittedMail } from "./change-mail.service.js";
import {
  activeRiskParameterKeys,
  assertDependenciesClear,
  assertLegalChangeTransition,
  assertReadyFor,
  assertScheduleOverrideRecorded,
  getChangeSettings,
  isNoOpTransition,
  resolveChangeApprovers,
  stageStampsOnEnter,
  ticketWriteFor
} from "./change.service.js";
import { emitDomainEvent } from "./domain-events.js";

const USER_SUMMARY = { id: true, name: true, email: true, avatarUrl: true } as const;

/** Everything the change page, the routes and the change emails read about a change. */
export const CHANGE_INCLUDE = {
  category: { select: { id: true, name: true, color: true, requiresSecurityReview: true } },
  source: { select: { id: true, name: true } },
  application: { select: { id: true, name: true, code: true } },
  collaborators: { include: { user: { select: USER_SUMMARY } }, orderBy: { createdAt: "asc" } },
  linkedTickets: {
    include: { ticket: { select: { id: true, key: true, title: true, status: true, type: true } } },
    orderBy: { createdAt: "asc" }
  },
  approvals: { include: { approver: { select: USER_SUMMARY } }, orderBy: [{ round: "desc" }, { createdAt: "asc" }] },
  implementationSteps: { orderBy: { stepNumber: "asc" } },
  testCases: { orderBy: { createdAt: "asc" } },
  dependencies: { orderBy: { createdAt: "asc" } },
  ticket: {
    select: {
      id: true,
      key: true,
      title: true,
      description: true,
      status: true,
      priority: true,
      dueAt: true,
      createdAt: true,
      project: { select: { id: true, code: true, name: true } },
      module: { select: { id: true, name: true } },
      reporter: { select: USER_SUMMARY },
      assignee: { select: USER_SUMMARY },
      _count: { select: { comments: true, attachments: true } }
    }
  }
} as const satisfies Prisma.ChangeRequestInclude;

/** A change as the write paths load it: every column, plus the two ticket ids a move needs. */
export type MovableChange = ChangeRequest & { ticket: { id: string; reporterId: string } };

/** Who moved it. `name` is what the submission email says submitted it. */
export interface ChangeMover {
  id: string;
  name: string;
}

/**
 * Opens an approval round.
 *
 * A ROUND, not a chain: a change rejected and reworked opens round 2, leaving round 1's decision
 * standing. Overwriting it would erase the record of what was objected to, which is the one thing a
 * change history is for.
 */
export async function openApprovalRound(
  tx: Prisma.TransactionClient,
  change: { id: string; ticket: { reporterId: string } },
  slaHours: number
): Promise<{ approverIds: string[]; round: number }> {
  const approvers = await resolveChangeApprovers(change.ticket.reporterId);
  if (approvers.length === 0) {
    throw new AppError(
      409,
      "There is nobody to approve this change — you have no manager set, and this workspace has no active super admin. Ask an administrator to set your manager."
    );
  }

  const previous = await tx.changeApproval.findFirst({
    where: { changeId: change.id },
    orderBy: { round: "desc" },
    select: { round: true }
  });
  const round = (previous?.round ?? 0) + 1;
  const dueAt = new Date(Date.now() + slaHours * 60 * 60 * 1000);

  await tx.changeApproval.createMany({
    data: approvers.map((a) => ({
      changeId: change.id,
      round,
      approverId: a.approverId,
      reason: a.reason,
      status: "PENDING",
      dueAt
    }))
  });

  return { approverIds: approvers.map((a) => a.approverId), round };
}

/**
 * Every gate a move has to pass, in the order the person should hear about them: is the move on
 * the table at all, does the change owe anything before it may enter the state, is anything it
 * waits on still open, and — when it commits to its window — is a collision accounted for with a
 * written reason. Exported on its own because the automation dispatcher asks BEFORE deciding
 * whether to move or to propose — a proposal for a move that cannot happen is noise in somebody's
 * review queue.
 */
export async function assertChangeTransitionAllowed(change: MovableChange, to: ChangeState): Promise<void> {
  assertLegalChangeTransition(change.state as ChangeState, to);
  assertReadyFor(change, to, await activeRiskParameterKeys());
  await assertDependenciesClear(change.id, to);
  await assertScheduleOverrideRecorded(change, to);
}

/**
 * The writes, inside the caller's transaction. No gates: the caller has already run them.
 *
 * Returns the approvers asked, when the move opened a round, so the caller can tell them AFTER the
 * transaction commits — a mail sent from inside a transaction that then rolls back announces a
 * submission that never happened.
 */
export async function writeChangeTransition(
  tx: Prisma.TransactionClient,
  change: MovableChange,
  to: ChangeState,
  actor: ChangeMover,
  now: Date
): Promise<{ approverIds: string[] }> {
  let approverIds: string[] = [];
  if (to === "AWAITING_APPROVAL") {
    const settings = await getChangeSettings();
    approverIds = (await openApprovalRound(tx, change, settings.approvalSlaHours)).approverIds;
  }
  // Leaving AWAITING_APPROVAL any way but a decision settles the round nobody decided. WITHDRAWN when
  // the requester took it back to rework — the round stays on the record, which is the point of
  // rounds — and CANCELLED when the change itself was called off. Left PENDING, the rows read as
  // decisions still owed, on a change nobody is being asked about any more.
  if (change.state === "AWAITING_APPROVAL" && (to === "DRAFT" || to === "CANCELLED")) {
    await tx.changeApproval.updateMany({
      where: { changeId: change.id, status: "PENDING" },
      data: { status: to === "DRAFT" ? "WITHDRAWN" : "CANCELLED", decidedAt: now }
    });
  }

  // The state and the ticket half are never written apart — the compatibility hinge ~40 readers of
  // `Ticket.status` depend on.
  await tx.ticket.update({ where: { id: change.ticket.id }, data: ticketWriteFor(to, now) });
  await tx.changeRequest.update({
    where: { id: change.id },
    data: {
      state: to,
      ...stageStampsOnEnter(to, change, now),
      ...(to === "CLOSED" ? { closedAt: now, closedById: actor.id } : {})
    }
  });
  return { approverIds };
}

/**
 * What happens BECAUSE a change moved, once the move is committed: the audit row, the domain event
 * (which is what a Workflow Studio flow listening for it fires on), and — on submission — the email
 * and bell notification to the approvers. Best-effort mail, so a slow mail server cannot lose a move
 * that already happened.
 */
export async function announceChangeTransition(params: {
  change: ChangeWithDetail;
  from: ChangeState;
  to: ChangeState;
  actor: ChangeMover;
  approverIds: string[];
  note?: string;
  provenance?: AuditProvenance;
}): Promise<void> {
  const { change, from, to, actor } = params;
  await audit(actor.id, "change.transitioned", "ChangeRequest", change.id, { from, to, note: params.note }, params.provenance);
  emitDomainEvent(`change.${to.toLowerCase()}` as never, { change } as never);

  if (to === "AWAITING_APPROVAL") {
    await sendChangeSubmittedMail(change, actor, params.approverIds).catch((error) =>
      console.warn(`[change] submission mail failed for ${change.changeKey}: ${(error as Error).message}`)
    );
  }
}

/** The change as every route answers it and every change email reads it. */
export type ChangeWithDetail = Prisma.ChangeRequestGetPayload<{ include: typeof CHANGE_INCLUDE }>;

/** Re-read after the commit, so what is announced is what was stored. */
export async function loadChangeDetail(id: string): Promise<ChangeWithDetail> {
  const change = await prisma.changeRequest.findFirst({ where: { id }, include: CHANGE_INCLUDE });
  if (!change) throw new AppError(404, "Change not found");
  return change;
}

/**
 * Move a change: gates, writes, side effects. The function every caller uses.
 *
 * A no-op is answered, not performed. Without that, re-posting the same state opens another
 * approval round and mails the approver again — which a double-click alone was enough to do.
 */
export async function applyChangeTransition(params: {
  change: MovableChange;
  to: ChangeState;
  actor: ChangeMover;
  note?: string;
  provenance?: AuditProvenance;
}) {
  const { change, to, actor } = params;
  const from = change.state as ChangeState;
  if (isNoOpTransition(from, to)) return loadChangeDetail(change.id);

  await assertChangeTransitionAllowed(change, to);

  const now = new Date();
  const approverIds = await prisma.$transaction(async (tx) => (await writeChangeTransition(tx, change, to, actor, now)).approverIds);
  const updated = await loadChangeDetail(change.id);

  await announceChangeTransition({ change: updated, from, to, actor, approverIds, note: params.note, provenance: params.provenance });
  return updated;
}
