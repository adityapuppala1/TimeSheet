/**
 * The two-person rule for the platform console: the handful of console actions that cannot be
 * undone are queued for a second operator to countersign instead of happening on the spot.
 *
 * WHAT IS ON THE LIST, AND WHY IT IS SHORT. `platformTwoPersonActions` in `@timesheet/shared` names
 * five: delete a workspace, restore a snapshot over one, delete a snapshot, create a platform
 * admin, change a platform admin's role. The test of membership is not "is it dangerous" — plenty
 * of console actions are — it is "can it be undone". A suspended workspace can be un-suspended and
 * a plan tier can be moved back; a dropped database cannot, and an account quietly promoted to
 * OWNER can grant itself everything before anybody reads the audit log. A two-person rule applied
 * to everything is a rule operators learn to route around, so it is applied to the irreversible
 * five and nothing else.
 *
 * HOW THE DEFERRAL WORKS, AND WHY IT IS A REPLAY.
 *
 * The obvious design is a flag: mark the target "approved" and let the destructive service check
 * it. That is wrong in a way that only shows up in production, because the world moves between the
 * request and the approval. The org that was a lapsed trial on Monday started paying on Tuesday.
 * The snapshot somebody asked to delete has already been deleted. The tier changed. A stored
 * decision replayed blind carries Monday's facts into Wednesday's database.
 *
 * So what is stored is the REQUEST — the action, its route, its params and its body — and what
 * happens on approval is that the ordinary handler runs, now, against the database as it is. Every
 * guard the handler already had runs again. An approval is a decision to do the thing NOW, which
 * is the only decision a person is actually in a position to make. Nothing in the destructive
 * services changed to support this: they already take `(id…, { actorLabel })` and re-derive
 * everything else themselves, which is exactly what makes a clean replay possible.
 *
 * The executor is looked up by `action`, never by the stored `route`. A path recorded in a database
 * row must never be able to choose which code runs.
 */
import { PLATFORM_APPROVAL_TTL_HOURS, PLATFORM_TWO_PERSON_LABEL, type PlatformTwoPersonAction } from "@timesheet/shared";
import { controlPrisma } from "../config/control-prisma.js";
import { AppError } from "../middleware/error.js";
import { platformAudit } from "./platform-audit.service.js";

export interface TwoPersonContext {
  params: Record<string, string>;
  body: Record<string, unknown>;
  /** Recorded against the action itself. The APPROVER's label, not the requester's: they are the
   *  one authorising it to happen now, and the audit row for a deletion should name the person who
   *  said yes as well as the person who asked. */
  actorLabel: string;
  reason: string;
  approver: { id: string; email: string };
  requester: { id: string; label: string };
  ipAddress?: string;
}

export type TwoPersonExecutor = (ctx: TwoPersonContext) => Promise<unknown>;

const executors = new Map<PlatformTwoPersonAction, TwoPersonExecutor>();

/**
 * Registered at module load by the controller that owns the route, so the queued path and the
 * live path are declared together and cannot drift apart. Re-registration overwrites rather than
 * throwing: a test file that imports the controller twice is not a bug worth crashing over, and
 * the second registration is the same function.
 */
export function registerTwoPersonAction(action: PlatformTwoPersonAction, executor: TwoPersonExecutor) {
  executors.set(action, executor);
}

/** Test seam: the registry is module state shared by every test in a file. */
export function __registeredTwoPersonActionsForTests() {
  return [...executors.keys()];
}

export interface QueueInput {
  action: PlatformTwoPersonAction;
  route: string;
  method: string;
  params: Record<string, string>;
  body: unknown;
  reason: string;
  requester: { id: string; email: string };
  ipAddress?: string;
}

/**
 * Record the request. Deliberately does NOT validate anything beyond the shape the route's own zod
 * schema already checked.
 *
 * That reads like a gap and is the point: a request-time business check would be a check against
 * facts that may not survive to approval time, and having run it once invites the reader — and the
 * next maintainer — to believe it still holds. The only validation that means anything happens in
 * the executor, at approval, against the live database. A request for a workspace that does not
 * exist queues cleanly here and is refused, with the real reason, by the handler on approval.
 */
export async function queuePlatformAction(input: QueueInput) {
  const expiresAt = new Date(Date.now() + PLATFORM_APPROVAL_TTL_HOURS * 60 * 60 * 1000);
  const row = await controlPrisma.pendingPlatformAction.create({
    data: {
      action: input.action,
      route: input.route,
      method: input.method,
      params: JSON.parse(JSON.stringify(input.params ?? {})),
      body: JSON.parse(JSON.stringify(input.body ?? {})),
      reason: input.reason,
      requestedById: input.requester.id,
      requestedByLabel: input.requester.email,
      requestedIp: input.ipAddress,
      expiresAt
    }
  });

  await platformAudit("PLATFORM_ADMIN", input.requester.email, "governance.requested", "PendingPlatformAction", row.id, {
    action: input.action,
    route: input.route
  }, { reason: input.reason, ipAddress: input.ipAddress, after: { status: "PENDING" } });

  /**
   * Who could say yes right now. `GET /admins` already counts live sessions per admin, and that is
   * the honest answer to "is there anybody around to approve this?" — an OWNER who last signed in
   * in March is not an approver, they are a name.
   */
  const approvers = await controlPrisma.platformAdminUser.findMany({
    where: { status: "ACTIVE", role: "OWNER", id: { not: input.requester.id } },
    select: { id: true, name: true, email: true, _count: { select: { sessions: { where: { revokedAt: null, expiresAt: { gt: new Date() } } } } } }
  });

  return {
    pending: true as const,
    requestId: row.id,
    action: input.action,
    label: PLATFORM_TWO_PERSON_LABEL[input.action],
    expiresAt,
    approvers: approvers.map((a) => ({ id: a.id, name: a.name, email: a.email, liveSessions: a._count.sessions })),
    message:
      approvers.length > 0
        ? `Queued for approval. ${PLATFORM_TWO_PERSON_LABEL[input.action]} cannot be undone, so another owner has to countersign it before it runs. It expires in ${PLATFORM_APPROVAL_TTL_HOURS} hours.`
        : `Queued, but there is no other owner who can approve it. Create a second owner account first — a two-person rule one person can satisfy alone is not one.`
  };
}

function isExpired(row: { expiresAt: Date }) {
  return row.expiresAt.getTime() <= Date.now();
}

/**
 * Countersign and run.
 *
 * The three refusals, in the order they matter:
 *  1. Not yours to approve — the requester cannot approve their own request. Without this the whole
 *     mechanism is a confirmation dialog with extra steps.
 *  2. Not still pending — an already-approved request must not run twice, and a rejected one must
 *     not be resurrected.
 *  3. Not still fresh — past `expiresAt` the answer is "ask again", because an approval is a
 *     judgement about now and nobody can make that judgement about last week.
 */
export async function approvePlatformAction(requestId: string, approver: { id: string; email: string }, opts: { ipAddress?: string } = {}) {
  const row = await controlPrisma.pendingPlatformAction.findUnique({ where: { id: requestId } });
  if (!row) throw new AppError(404, "That request no longer exists.");

  if (row.requestedById === approver.id) {
    throw new AppError(403, "You raised this request. Somebody else has to approve it — that is the whole point of the second signature.");
  }
  if (row.status !== "PENDING") throw new AppError(409, `That request is already ${row.status.toLowerCase()}.`);
  if (isExpired(row)) {
    await controlPrisma.pendingPlatformAction.update({ where: { id: row.id }, data: { status: "EXPIRED", resolutionNote: "Expired before anybody approved it." } });
    throw new AppError(409, `That request expired after ${PLATFORM_APPROVAL_TTL_HOURS} hours. Raise it again if it still needs doing.`);
  }

  const executor = executors.get(row.action as PlatformTwoPersonAction);
  if (!executor) throw new AppError(500, `No handler is registered for "${row.action}" in this build.`);

  let result: unknown;
  try {
    result = await executor({
      params: (row.params ?? {}) as Record<string, string>,
      body: (row.body ?? {}) as Record<string, unknown>,
      actorLabel: approver.email,
      reason: row.reason,
      approver,
      requester: { id: row.requestedById, label: row.requestedByLabel },
      ipAddress: opts.ipAddress
    });
  } catch (error) {
    /*
     * A failed replay is recorded and the request stays consumed — it does NOT go back to PENDING.
     * The approval was given; what it authorised turned out to be impossible. Re-arming it would
     * let somebody sit on an approved request and retry it until the world happened to allow it,
     * which is exactly the stale-decision problem the replay design exists to prevent.
     */
    const message = error instanceof AppError ? error.message : (error as Error).message;
    await controlPrisma.pendingPlatformAction.update({
      where: { id: row.id },
      data: { status: "FAILED", approvedById: approver.id, approvedByLabel: approver.email, approvedAt: new Date(), resolutionNote: message }
    });
    await platformAudit("PLATFORM_ADMIN", approver.email, "governance.failed", "PendingPlatformAction", row.id, { action: row.action, error: message }, {
      reason: row.reason,
      ipAddress: opts.ipAddress
    });
    throw error;
  }

  await controlPrisma.pendingPlatformAction.update({
    where: { id: row.id },
    data: { status: "APPROVED", approvedById: approver.id, approvedByLabel: approver.email, approvedAt: new Date() }
  });
  await platformAudit("PLATFORM_ADMIN", approver.email, "governance.approved", "PendingPlatformAction", row.id, {
    action: row.action,
    requestedBy: row.requestedByLabel
  }, { reason: row.reason, ipAddress: opts.ipAddress, before: { status: "PENDING" }, after: { status: "APPROVED" } });

  return { approved: true as const, requestId: row.id, action: row.action, result };
}

/** Saying no is a decision worth recording too — and unlike an expiry it names somebody. The
 *  requester may withdraw their own; anyone who could approve may refuse. */
export async function rejectPlatformAction(requestId: string, actor: { id: string; email: string }, note: string) {
  const row = await controlPrisma.pendingPlatformAction.findUnique({ where: { id: requestId } });
  if (!row) throw new AppError(404, "That request no longer exists.");
  if (row.status !== "PENDING") throw new AppError(409, `That request is already ${row.status.toLowerCase()}.`);

  await controlPrisma.pendingPlatformAction.update({
    where: { id: row.id },
    data: { status: "REJECTED", approvedById: actor.id, approvedByLabel: actor.email, approvedAt: new Date(), resolutionNote: note }
  });
  await platformAudit("PLATFORM_ADMIN", actor.email, "governance.rejected", "PendingPlatformAction", row.id, {
    action: row.action,
    requestedBy: row.requestedByLabel,
    withdrawn: row.requestedById === actor.id
  }, { reason: note, ipAddress: undefined, before: { status: "PENDING" }, after: { status: "REJECTED" } });

  return { rejected: true as const, requestId: row.id };
}

/**
 * The queue, newest first. `expired` is computed rather than stored, so a row nobody has tried to
 * approve still reads as expired the moment it is — a status column only changes when somebody
 * touches the row, and a queue that lies about what is actionable is worse than no queue.
 */
export async function listPendingPlatformActions(viewerId: string, limit = 50) {
  const rows = await controlPrisma.pendingPlatformAction.findMany({ orderBy: { requestedAt: "desc" }, take: Math.min(200, Math.max(1, limit)) });
  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    label: PLATFORM_TWO_PERSON_LABEL[row.action as PlatformTwoPersonAction] ?? row.action,
    route: row.route,
    method: row.method,
    params: row.params,
    body: row.body,
    reason: row.reason,
    requestedByLabel: row.requestedByLabel,
    requestedAt: row.requestedAt,
    status: row.status,
    expiresAt: row.expiresAt,
    expired: row.status === "PENDING" && isExpired(row),
    approvedByLabel: row.approvedByLabel,
    approvedAt: row.approvedAt,
    resolutionNote: row.resolutionNote,
    /** Drives the console: the requester sees "waiting for somebody else", everyone else sees the
     *  button. The server refuses self-approval regardless — this only stops offering it. */
    isMine: row.requestedById === viewerId
  }));
}
