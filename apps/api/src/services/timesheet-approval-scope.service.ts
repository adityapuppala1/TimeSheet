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
 *   - Nobody decides an entry by someone ABOVE them in their own reporting line. A team lead who
 *     reports to a manager does not sign off that manager's hours.
 *   - It is NOT "only your reporting line". Plenty of teams route approvals to whoever holds
 *     `timesheets:approve` regardless of who manages whom (a PMO, a project lead, an admin covering
 *     a holiday), and narrowing to the reporting line would quietly strand their queues.
 *
 * WHO CALLS THIS: controllers/timesheet.controller.ts (approve/reject/reopen and the approvals
 * queue), services/inbox.service.ts (the brief), controllers/report.controller.ts (admin-summary).
 */
import type { Prisma } from "@prisma/client";
import { AppError } from "../middleware/error.js";
import { loadReportingRows, type ReportingRow } from "./reporting-line.service.js";

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

/** What a reviewer may not decide: themselves, and their own chain of managers. Loaded once per
 *  request — a bulk decision over a hundred rows walks the reporting line once, not a hundred times. */
export interface ApprovalAuthority {
  reviewerId: string;
  excludedAuthorIds: string[];
}

export async function loadApprovalAuthority(reviewerId: string): Promise<ApprovalAuthority> {
  const rows = await loadReportingRows();
  return { reviewerId, excludedAuthorIds: [reviewerId, ...managersAbove(rows, reviewerId)] };
}

/** Why `authority` may not decide an entry written by `authorId`, or null when it may. Pure. */
export function decisionRefusal(authority: ApprovalAuthority, authorId: string): string | null {
  if (authorId === authority.reviewerId) {
    return "You can't decide your own timesheet — somebody else has to review it.";
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

/** THE definition of "awaiting your review": SUBMITTED, not yours, within your approval scope. */
export function awaitingReviewWhere(authority: ApprovalAuthority): Prisma.TimesheetWhereInput {
  return { ...approvalScopeWhere(authority), status: "SUBMITTED" };
}
