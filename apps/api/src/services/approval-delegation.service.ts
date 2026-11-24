/**
 * 7.0.0 — approval delegation: an approver hands their leave and comp-off decisions to someone else
 * for a date range (holiday cover).
 *
 * THE RULE (used by leave.service.ts#resolveDecisionRight, the inbox query and the notifications):
 * while a delegation's [startDate, endDate] covers today (server calendar day) and it is not revoked,
 * its delegate may decide every request whose CAPTURED approver is the delegator (and that approver
 * is still active — a deactivated approver's queue falls to the admin pool as before). The decision
 * is recorded as the delegate's, "on behalf of" the delegator, in the audit row.
 *
 *   - ONE HOP: B covering for A, and C covering for B, does NOT let C decide A's requests.
 *   - Nobody decides their own request through a delegation (decisionRight's self rule runs first).
 *   - No self-delegation, and no cycles: A→B is refused while B (or anyone B delegates to, along
 *     overlapping ranges) already delegates back to A.
 *   - Eligible delegates: active, human accounts whose role may approve (manager, team lead, admin,
 *     super admin).
 *   - Who may set one: the approver for themselves; an ADMIN / SUPER_ADMIN for anyone.
 */
import { z } from "zod";
import { prisma } from "../config/prisma.js";
import { serverTimezone } from "../config/env.js";
import { AppError } from "../middleware/error.js";
import { isoDate } from "./attendance-settings.service.js";
import { todayKeyFor } from "./attendance-day-status.js";
import { audit } from "./audit.service.js";
import { NOT_DEACTIVATED } from "./people-visibility.service.js";

const toKey = (d: Date) => d.toISOString().slice(0, 10);
const dayStart = (k: string) => new Date(`${k}T00:00:00.000Z`);
export const DELEGATE_ROLES = new Set(["MANAGER", "TEAM_LEAD", "ADMIN", "SUPER_ADMIN"]);
const ADMIN_ROLES = new Set(["ADMIN", "SUPER_ADMIN"]);
export const MAX_DELEGATION_DAYS = 366;

export const delegationBody = z
  .object({
    delegateId: z.string().trim().min(1).max(64),
    /** Admins only: whose approvals are delegated. Defaults to the caller. */
    delegatorId: z.string().trim().min(1).max(64).optional(),
    startDate: isoDate,
    endDate: isoDate
  })
  .strict();

export interface DelegationEdge {
  delegatorId: string;
  delegateId: string;
  startDate: string;
  endDate: string;
}

const overlaps = (a: { startDate: string; endDate: string }, b: { startDate: string; endDate: string }) => a.startDate <= b.endDate && b.startDate <= a.endDate;

/**
 * Pure: would adding `next` close a cycle among `existing` edges whose ranges overlap it? A walk from
 * the new delegate along overlapping edges that reaches the new delegator is a cycle.
 */
export function wouldCycle(next: DelegationEdge, existing: readonly DelegationEdge[]): boolean {
  if (next.delegatorId === next.delegateId) return true;
  const edges = existing.filter((e) => overlaps(e, next));
  const seen = new Set<string>();
  const stack = [next.delegateId];
  while (stack.length) {
    const at = stack.pop()!;
    if (at === next.delegatorId) return true;
    if (seen.has(at)) continue;
    seen.add(at);
    for (const e of edges) if (e.delegatorId === at) stack.push(e.delegateId);
  }
  return false;
}

/** Pure: is a delegation in force on `dateKey`? */
export function inForce(d: { startDate: string; endDate: string; revoked: boolean }, dateKey: string): boolean {
  return !d.revoked && d.startDate <= dateKey && dateKey <= d.endDate;
}

const today = (now: Date) => todayKeyFor(now, null, serverTimezone);

/** The people whose approvals `delegateId` currently holds (active delegators only). */
export async function delegatorsFor(delegateId: string, now: Date = new Date()): Promise<Set<string>> {
  const day = dayStart(today(now));
  const rows = await prisma.approvalDelegation.findMany({
    where: { delegateId, revokedAt: null, startDate: { lte: day }, endDate: { gte: day } },
    select: { delegatorId: true },
    take: 200
  });
  const ids = [...new Set(rows.map((r) => r.delegatorId))];
  if (ids.length === 0) return new Set();
  const active = await prisma.user.findMany({ where: { id: { in: ids }, ...NOT_DEACTIVATED }, select: { id: true } });
  return new Set(active.map((u) => u.id));
}

/** The active delegates currently covering `delegatorId` (for notifications). */
export async function delegatesOf(delegatorId: string, now: Date = new Date()): Promise<Array<{ id: string; name: string }>> {
  const day = dayStart(today(now));
  const rows = await prisma.approvalDelegation.findMany({
    where: { delegatorId, revokedAt: null, startDate: { lte: day }, endDate: { gte: day } },
    select: { delegateId: true },
    take: 50
  });
  const ids = [...new Set(rows.map((r) => r.delegateId))];
  if (ids.length === 0) return [];
  return prisma.user.findMany({ where: { id: { in: ids }, status: "ACTIVE", deletedAt: null, isAgent: false }, select: { id: true, name: true } });
}

function publicDelegation(r: { id: string; delegatorId: string; delegateId: string; startDate: Date; endDate: Date; revokedAt: Date | null; createdById: string; createdAt: Date }, names: Map<string, string>, now: Date) {
  const s = toKey(r.startDate);
  const e = toKey(r.endDate);
  return {
    id: r.id,
    delegator: { id: r.delegatorId, name: names.get(r.delegatorId) ?? "Former user" },
    delegate: { id: r.delegateId, name: names.get(r.delegateId) ?? "Former user" },
    startDate: s,
    endDate: e,
    revoked: Boolean(r.revokedAt),
    active: inForce({ startDate: s, endDate: e, revoked: Boolean(r.revokedAt) }, today(now)),
    createdById: r.createdById,
    createdAt: r.createdAt.toISOString()
  };
}

async function namesOf(ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const users = await prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
  return new Map(users.map((u) => [u.id, u.name]));
}

/** Mine (given and received), or every delegation for an admin with scope=all. Ended ones are kept 90 days. */
export async function listDelegations(actor: { id: string; role: string }, scope: "mine" | "all" = "mine", now: Date = new Date()) {
  if (scope === "all" && !ADMIN_ROLES.has(actor.role)) throw new AppError(403, "Only an administrator can see every delegation.");
  const since = dayStart(today(new Date(now.getTime() - 90 * 86_400_000)));
  const rows = await prisma.approvalDelegation.findMany({
    where: { endDate: { gte: since }, ...(scope === "all" ? {} : { OR: [{ delegatorId: actor.id }, { delegateId: actor.id }] }) },
    orderBy: { startDate: "desc" },
    take: 500
  });
  const names = await namesOf(rows.flatMap((r) => [r.delegatorId, r.delegateId]));
  return rows.map((r) => publicDelegation(r, names, now));
}

/** People who may be chosen as a delegate (id + name only). */
export async function delegateCandidates(actorId: string, q?: string) {
  const users = await prisma.user.findMany({
    where: {
      status: "ACTIVE",
      deletedAt: null,
      isAgent: false,
      id: { not: actorId },
      role: { name: { in: [...DELEGATE_ROLES] as never } },
      ...(q ? { name: { contains: q.slice(0, 60) } } : {})
    },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
    take: 50
  });
  return users;
}

export async function createDelegation(actor: { id: string; role: string }, body: z.infer<typeof delegationBody>, now: Date = new Date()) {
  const delegatorId = body.delegatorId ?? actor.id;
  if (delegatorId !== actor.id && !ADMIN_ROLES.has(actor.role)) throw new AppError(403, "Only an administrator can set a delegation for someone else.");
  if (delegatorId === body.delegateId) throw new AppError(422, "Nobody can delegate approvals to themselves.", { code: "DELEGATION_SELF" });
  if (body.endDate < body.startDate) throw new AppError(422, "`endDate` must be on or after `startDate`.");
  if (body.endDate < today(now)) throw new AppError(422, "That range has already ended.");
  const span = (dayStart(body.endDate).getTime() - dayStart(body.startDate).getTime()) / 86_400_000 + 1;
  if (span > MAX_DELEGATION_DAYS) throw new AppError(422, `A delegation can cover at most ${MAX_DELEGATION_DAYS} days.`);
  const [delegator, delegate] = await Promise.all([
    prisma.user.findFirst({ where: { id: delegatorId, ...NOT_DEACTIVATED }, select: { id: true } }),
    prisma.user.findFirst({ where: { id: body.delegateId, status: "ACTIVE", deletedAt: null, isAgent: false }, select: { id: true, role: { select: { name: true } } } })
  ]);
  if (!delegator) throw new AppError(404, "Approver not found");
  if (!delegate || !DELEGATE_ROLES.has(String(delegate.role?.name))) {
    throw new AppError(422, "Choose an active manager, team lead or admin as the delegate.", { code: "DELEGATION_INELIGIBLE" });
  }
  const created = await prisma.$transaction(async (tx) => {
    // Serialise delegation writes so two opposite delegations cannot both pass the cycle check.
    await tx.$queryRaw`SELECT id FROM \`User\` WHERE id = ${delegatorId} FOR UPDATE`;
    const existing = await tx.approvalDelegation.findMany({
      where: { revokedAt: null, endDate: { gte: dayStart(body.startDate) }, startDate: { lte: dayStart(body.endDate) } },
      select: { delegatorId: true, delegateId: true, startDate: true, endDate: true },
      take: 5000
    });
    const edges = existing.map((e) => ({ delegatorId: e.delegatorId, delegateId: e.delegateId, startDate: toKey(e.startDate), endDate: toKey(e.endDate) }));
    if (wouldCycle({ delegatorId, delegateId: body.delegateId, startDate: body.startDate, endDate: body.endDate }, edges)) {
      throw new AppError(409, "That would make a loop: the delegate already passes approvals back to this approver in that range.", { code: "DELEGATION_CYCLE" });
    }
    return tx.approvalDelegation.create({
      data: { delegatorId, delegateId: body.delegateId, startDate: dayStart(body.startDate), endDate: dayStart(body.endDate), createdById: actor.id }
    });
  });
  await audit(actor.id, "leave.delegation_created", "ApprovalDelegation", created.id, { delegatorId, delegateId: body.delegateId, startDate: body.startDate, endDate: body.endDate });
  return publicDelegation(created, await namesOf([delegatorId, body.delegateId]), now);
}

export async function revokeDelegation(actor: { id: string; role: string }, id: string, now: Date = new Date()) {
  const row = await prisma.approvalDelegation.findUnique({ where: { id } });
  // Someone else's delegation and an unknown id: one answer.
  if (!row || (row.delegatorId !== actor.id && row.delegateId !== actor.id && !ADMIN_ROLES.has(actor.role))) throw new AppError(404, "Delegation not found");
  if (!row.revokedAt) {
    await prisma.approvalDelegation.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: now, revokedById: actor.id } });
    await audit(actor.id, "leave.delegation_revoked", "ApprovalDelegation", id, { delegatorId: row.delegatorId, delegateId: row.delegateId });
  }
  return publicDelegation({ ...row, revokedAt: row.revokedAt ?? now }, await namesOf([row.delegatorId, row.delegateId]), now);
}
