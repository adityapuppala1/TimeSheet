import { permissions } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";

/**
 * Whose entries `?scope=team` returns, which is NOT the same question as `REPORTS_VIEW`.
 *
 * REPORTS_VIEW is granted to MANAGER and TEAM_LEAD as well as the admin roles, so the existing
 * "can view all" check hands a manager the whole workspace — which is why the home page's day
 * timeline showed a manager every person in the company rather than their own team.
 *
 * The reporting line is the right instrument and already exists: `User.managerId`, the same
 * relation team.controller.ts scopes by. Three tiers fall out of it with no role-name check and no
 * new schema:
 *   - `users:manage` (SUPER_ADMIN / ADMIN)  → everyone
 *   - anyone else                           → themselves plus their direct reports
 *   - an employee who manages nobody        → themselves, because that set is just them
 *
 * Returns `undefined` for "no restriction" so it drops straight into a Prisma `where`.
 */
export async function teamScopeUserIds(user: { id: string; permissions: string[] }): Promise<{ in: string[] } | undefined> {
  if (user.permissions.includes(permissions.USERS_MANAGE)) return undefined;
  const reports = await prisma.user.findMany({
    where: { managerId: user.id, deletedAt: null },
    select: { id: true }
  });
  // Their own entries are always in scope — a manager's timeline that omitted their own work would
  // be a strange thing to hand someone.
  return { in: [user.id, ...reports.map((r) => r.id)] };
}
