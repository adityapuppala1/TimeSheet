/**
 * WHAT: whether "X reports to M" is a reporting line the rest of the app can live with.
 *
 * WHY IT IS CHECKED, NOT ASSUMED. Three things walk `User.managerId` upward and trust it to end: the
 * org chart (team.controller.ts), timesheet SLA escalation to the manager's manager
 * (sla.service.ts), and every "my team" scope. PATCH refused only `managerId === id` and the CSV
 * import linked managers with no check at all, so A → B → A was accepted — after which the org
 * chart recursed until the stack ran out and A's own SLA breach escalated to A.
 *
 * THE RULES: the manager exists, is not deleted, is ACTIVE (an inactive manager approves nothing
 * and is skipped by every notification, so their reports would wait on nobody), and is not the
 * person themselves or anyone below them.
 */
import { prisma } from "../config/prisma.js";
import { AppError } from "../middleware/error.js";

export interface ReportingRow {
  id: string;
  email: string;
  managerId: string | null;
  status: string;
  deletedAt: Date | null;
}

/**
 * Walks up from `from` through manager links; true if the walk meets `target`. A loop already in
 * the data that does not include `target` is stopped by the visited set rather than walked forever.
 */
export function chainReaches(rows: ReadonlyMap<string, Pick<ReportingRow, "managerId">>, from: string, target: string): boolean {
  const seen = new Set<string>();
  let cursor: string | null | undefined = from;
  while (cursor && !seen.has(cursor)) {
    if (cursor === target) return true;
    seen.add(cursor);
    cursor = rows.get(cursor)?.managerId;
  }
  return false;
}

/** Why `managerId` cannot be `targetId`'s manager, or null when it can. `targetId` is null for an
 *  account not created yet, which cannot be anyone's manager and so cannot close a loop. Pure. */
export function managerRefusal(rows: ReadonlyMap<string, ReportingRow>, targetId: string | null, managerId: string): string | null {
  if (targetId && managerId === targetId) return "A user cannot be their own manager";
  const manager = rows.get(managerId);
  if (!manager || manager.deletedAt) return "Manager not found";
  if (manager.status !== "ACTIVE") return "That manager's account is not active — choose someone who is.";
  if (targetId && chainReaches(rows, managerId, targetId)) {
    return "That would create a reporting loop — the chosen manager already reports, directly or through others, to this person.";
  }
  return null;
}

/** Everyone's reporting link, in one read — what `managerRefusal` walks. Deleted accounts included:
 *  their links still exist, and a loop through one is still a loop. */
export async function loadReportingRows(): Promise<Map<string, ReportingRow>> {
  const rows = await prisma.user.findMany({ select: { id: true, email: true, managerId: true, status: true, deletedAt: true } });
  return new Map(rows.map((row) => [row.id, row]));
}

/** 422 when `managerId` may not be `targetId`'s manager. */
export async function assertValidManager(targetId: string | null, managerId: string): Promise<void> {
  const refusal = managerRefusal(await loadReportingRows(), targetId, managerId);
  if (refusal) throw new AppError(422, refusal);
}
