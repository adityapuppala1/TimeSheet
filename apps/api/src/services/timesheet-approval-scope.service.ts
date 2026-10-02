/**
 * WHAT: who may decide a timesheet, and — the same rule read the other way — which entries are
 * waiting on a given reviewer.
 *
 * WHY ONE FILE: the decision routes, the approvals queue, the Inbox brief and the reports summary
 * all answer some form of "what is awaiting review", and they used to answer it four ways. The
 * Inbox counted every SUBMITTED row except your own, the reports summary counted every SUBMITTED
 * row, and the approvals queue showed you your own entries with an Approve button beside them —
 * while the decision routes themselves checked nothing but the status. A count that disagrees with
 * the queue it links to is a count nobody trusts, so all of them now read the predicate below.
 *
 * THE RULE, and what it deliberately is NOT:
 *   - Nobody decides their own entry. Segregation of duties, for every role, admins included: the
 *     person whose hours become payable is the one person who cannot be the one saying so.
 *   - Nobody decides an entry by someone ABOVE them in their own reporting line — when that person
 *     has a manager of their own. A team lead who reports to a manager does not sign off that
 *     manager's hours; the manager's manager does.
 *   - It is NOT "only your reporting line". Plenty of teams route approvals to whoever holds
 *     `timesheets:approve` regardless of who manages whom (a PMO, a project lead, an admin covering
 *     a holiday), and narrowing to the reporting line would quietly strand their queues.
 *
 * THE TWO EXCEPTIONS, both about the top of the tree (audit 2026-10 R3, finding 1). Read strictly,
 * the rule above left the ROOT of every reporting tree — the owner, the super admin over everyone —
 * with nobody allowed to decide their hours: they are above every other approver. Their entries
 * sat SUBMITTED forever and, by this same predicate, vanished from every queue and count.
 *   - The upward refusal applies only to an author WITH a manager. Somebody has to decide the
 *     root's hours, and everybody else in the workspace is below them; any approver but the root
 *     themselves may. "Has a manager" means a manager account that still exists — a link to a
 *     deleted account leaves its holder at the top of what remains.
 *   - Self-approval is allowed for exactly one person: an author who is the ONLY active, non-agent
 *     holder of `timesheets:approve` able to decide the entry (a solo trial, an owner whose staff
 *     only log time). Separation of duties cannot apply when there is one person, and refusing
 *     would strand the hours. The decision's audit records `soleApprover: true`, and the moment a
 *     second eligible approver exists the exception is gone.
 *
 * WHO CALLS THIS: controllers/timesheet.controller.ts (approve/reject/reopen and the approvals
 * queue), services/inbox.service.ts (the brief), controllers/report.controller.ts (admin-summary),
 * services/sla.service.ts (who an overdue entry may be escalated to).
 */
import type { Prisma } from "@prisma/client";
import { permissions } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { AppError } from "../middleware/error.js";
import { loadReportingRows, type ReportingRow } from "./reporting-line.service.js";

type ReportingLinks = ReadonlyMap<string, Pick<ReportingRow, "managerId"> & Partial<Pick<ReportingRow, "deletedAt">>>;

/**
 * Everyone above `userId` in their reporting line, nearest first. Pure; a loop already in the data
 * is stopped by the visited set rather than walked forever.
 */
export function managersAbove(rows: ReadonlyMap<string, Pick<ReportingRow, "managerId">>, userId: string): string[] {
  const above: string[] = [];
  const seen = new Set<string>([userId]);
  let cursor = rows.get(userId)?.managerId ?? null;
  while (cursor && !seen.has(cursor)) {
    above.push(cursor);
    seen.add(cursor);
    cursor = rows.get(cursor)?.managerId ?? null;
  }
  return above;
}

/** True when `userId` reports to a manager account that still exists. Pure. */
function hasManager(rows: ReportingLinks, userId: string): boolean {
  const managerId = rows.get(userId)?.managerId;
  if (!managerId) return false;
  const manager = rows.get(managerId);
  return Boolean(manager && !manager.deletedAt);
}

/** The people above `reviewerId` whose hours the reviewer may not decide: their chain of managers,
 *  less whoever sits at the top of it with no manager of their own. Pure. */
function upwardRefused(rows: ReportingLinks, reviewerId: string): string[] {
  return managersAbove(rows, reviewerId).filter((id) => hasManager(rows, id));
}

/** Approvers other than the author who may decide the author's entry, in `approverIds` order. Pure. */
export function othersWhoMayDecide(rows: ReportingLinks, approverIds: readonly string[], authorId: string): string[] {
  return approverIds.filter((id) => id !== authorId && !upwardRefused(rows, id).includes(authorId));
}

/** What a reviewer may not decide: themselves (unless they are the only one who could), and the
 *  managers above them who have a manager of their own. Loaded once per request — a bulk decision
 *  over a hundred rows walks the reporting line once, not a hundred times. */
export interface ApprovalAuthority {
  reviewerId: string;
  excludedAuthorIds: string[];
  /** The reviewer is the only active, non-agent approver able to decide their own entries, so
   *  those are theirs to decide — and every such decision is audited as `soleApprover: true`. */
  soleApprover: boolean;
}

/** The authority, from the directory. Pure, so the rule can be read without a database. */
export function approvalAuthorityFor(rows: ReportingLinks, approverIds: readonly string[], reviewerId: string): ApprovalAuthority {
  const soleApprover = approverIds.includes(reviewerId) && othersWhoMayDecide(rows, approverIds, reviewerId).length === 0;
  return {
    reviewerId,
    excludedAuthorIds: [...(soleApprover ? [] : [reviewerId]), ...upwardRefused(rows, reviewerId)],
    soleApprover
  };
}

/**
 * Everyone who could decide a timesheet today: ACTIVE, not deleted, not an agent identity, and
 * holding `timesheets:approve` on their active role (the same permissions `requireAuth` builds).
 * Oldest account first, so "the first eligible person" is a stable answer.
 */
export async function loadApprovers(): Promise<Array<{ id: string; name: string; email: string; role: { name: string } }>> {
  return prisma.user.findMany({
    where: {
      status: "ACTIVE",
      deletedAt: null,
      isAgent: false,
      role: { permissions: { some: { permission: { key: permissions.TIMESHEETS_APPROVE } } } }
    },
    select: { id: true, name: true, email: true, role: { select: { name: true } } },
    orderBy: { createdAt: "asc" }
  });
}

export async function loadApprovalAuthority(reviewerId: string): Promise<ApprovalAuthority> {
  const [rows, approvers] = await Promise.all([loadReportingRows(), loadApprovers()]);
  return approvalAuthorityFor(
    rows,
    approvers.map((a) => a.id),
    reviewerId
  );
}

/** Why `authority` may not decide an entry written by `authorId`, or null when it may. Pure. */
export function decisionRefusal(authority: ApprovalAuthority, authorId: string): string | null {
  if (authorId === authority.reviewerId) {
    return authority.soleApprover ? null : "You can't decide your own timesheet — somebody else has to review it.";
  }
  if (authority.excludedAuthorIds.includes(authorId)) {
    return "This entry belongs to someone you report to, so it isn't yours to decide — it needs a reviewer outside your reporting line above them.";
  }
  return null;
}

export function assertMayDecide(authority: ApprovalAuthority, authorId: string): void {
  const refusal = decisionRefusal(authority, authorId);
  if (refusal) throw new AppError(403, refusal);
}

/** Entries this reviewer could decide, in any status — the approvals page's scope. */
export function approvalScopeWhere(authority: ApprovalAuthority): Prisma.TimesheetWhereInput {
  return { deletedAt: null, userId: { notIn: authority.excludedAuthorIds } };
}

/** THE definition of "awaiting your review": SUBMITTED, within your approval scope — never yours,
 *  unless you are the workspace's sole approver. `notIn: []` (a sole approver at the top) is no
 *  filter at all, which is what it should be. */
export function awaitingReviewWhere(authority: ApprovalAuthority): Prisma.TimesheetWhereInput {
  return { ...approvalScopeWhere(authority), status: "SUBMITTED" };
}
