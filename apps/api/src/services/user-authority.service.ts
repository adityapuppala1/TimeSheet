/**
 * WHAT: the one rule for who may change whose access in User Management, and the one definition of
 * "a super admin" that every last-super-admin guard counts.
 *
 * WHY ONE MODULE. The "only a super admin may act on a super admin" check existed in three routes
 * (bulk-action, force-logout, the role branch of PATCH) and was missing from the rest. The gap that
 * mattered most was POST /users/:id/reset-password: an ADMIN could reset a SUPER_ADMIN's password,
 * receive the plaintext in the response, and sign in as them. A rule that lives in the routes that
 * remembered it is a rule with holes, so every single-user and bulk mutation now asks here.
 *
 * WHO HOLDS SUPER_ADMIN. An ACTIVE, undeleted account whose primary `roleId` is SUPER_ADMIN, or
 * which holds a `UserRole` row for it. Both halves, because neither alone is the truth: the
 * `UserRole` backfill ran once (migration 20260826120000_user_multi_role), and the founding super
 * admin of every workspace provisioned after it was seeded with no row — so a guard counting rows
 * alone saw zero super admins in a workspace that had one, and let that one demote themselves.
 *
 * THE ACTOR'S AUTHORITY is their ACTIVE role (`req.user.role`), the same thing every permission
 * check in the app reads. Someone who holds SUPER_ADMIN but has switched into ADMIN acts as an
 * ADMIN until they switch back — that is what switching means.
 *
 * The join-request approval path already applies the same posture to grants
 * (join-request.service.ts#approveJoinRequest): a non-super-admin is refused with a 403 when the
 * grant goes above what they may hand out.
 */
import { type RoleName, resolveHeldRoles } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { AppError } from "../middleware/error.js";

export interface AuthorityActor {
  id: string;
  role: string;
}

export interface AuthorityTarget {
  id: string;
  status: string;
  deletedAt: Date | null;
  /** Primary role plus every `UserRole` row — `resolveHeldRoles`. */
  heldRoles: RoleName[];
}

/** What a guard needs to know about the account being changed. Spread into a route's own `select`
 *  when it needs more columns, so the guard and the route read one row. */
export const AUTHORITY_TARGET_SELECT = {
  id: true,
  status: true,
  deletedAt: true,
  role: { select: { name: true } },
  userRoles: { select: { role: { select: { name: true } } } }
} as const;

type AuthorityRow = {
  id: string;
  status: string;
  deletedAt: Date | null;
  role: { name: string };
  userRoles?: Array<{ role: { name: string } }>;
};

export function toAuthorityTarget(row: AuthorityRow): AuthorityTarget {
  return {
    id: row.id,
    status: row.status,
    deletedAt: row.deletedAt ?? null,
    heldRoles: resolveHeldRoles(row.role.name as RoleName, (row.userRoles ?? []).map((ur) => ur.role.name as RoleName))
  };
}

/** The target, deleted or not — whether a deleted target is a 404 is each route's own decision. */
export async function loadAuthorityTarget(id: string): Promise<AuthorityTarget> {
  const row = await prisma.user.findUnique({ where: { id }, select: AUTHORITY_TARGET_SELECT });
  if (!row) throw new AppError(404, "User not found");
  return toAuthorityTarget(row);
}

export function holdsSuperAdmin(heldRoles: readonly string[]): boolean {
  return heldRoles.includes("SUPER_ADMIN");
}

/** Why this actor may not touch this account, or null when they may. The bulk route skips with this
 *  reason; the single-user routes throw it as a 403 through `assertMayActOn`. */
export function actOnRefusal(actor: AuthorityActor, target: Pick<AuthorityTarget, "heldRoles">): string | null {
  if (holdsSuperAdmin(target.heldRoles) && actor.role !== "SUPER_ADMIN") {
    return "Only a super admin can change a super admin's account.";
  }
  return null;
}

export function assertMayActOn(actor: AuthorityActor, target: Pick<AuthorityTarget, "heldRoles">): void {
  const refusal = actOnRefusal(actor, target);
  if (refusal) throw new AppError(403, refusal);
}

/** Why this actor may not grant these roles, or null. Only SUPER_ADMIN is reserved: an ADMIN keeps
 *  every grant it had (ADMIN, MANAGER, TEAM_LEAD, EMPLOYEE), it just cannot mint its own superior —
 *  including on its own account. */
export function grantRefusal(actor: AuthorityActor, roleNames: readonly string[]): string | null {
  if (roleNames.includes("SUPER_ADMIN") && actor.role !== "SUPER_ADMIN") {
    return "Only a super admin can grant super admin.";
  }
  return null;
}

export function assertMayGrant(actor: AuthorityActor, roleNames: readonly string[]): void {
  const refusal = grantRefusal(actor, roleNames);
  if (refusal) throw new AppError(403, refusal);
}

const SELF_LOCKOUT_MESSAGES = {
  deactivate: "You can't deactivate your own account here. Ask another admin if it really should be.",
  delete: "You can't delete your own account here. Ask another admin if it really should be.",
  demote: "You can't remove roles from your own account here. Ask another super admin if it really should be done."
} as const;

/**
 * Refused rather than confirmed — the same reasoning the bulk self-target guard has always used:
 * locking yourself out is unrecoverable without a second admin, and there is no version of it the
 * operator meant. 422, because the request is well-formed and the actor is authorised; it is the
 * change itself that is not allowed.
 */
export function assertNotSelfLockout(actor: AuthorityActor, targetId: string, change: keyof typeof SELF_LOCKOUT_MESSAGES): void {
  if (actor.id === targetId) throw new AppError(422, SELF_LOCKOUT_MESSAGES[change]);
}

/** "Who holds SUPER_ADMIN", as a `where` — the header's definition, and the only copy of it. */
async function superAdminHolderWhere() {
  const superAdminRole = await prisma.role.findUniqueOrThrow({ where: { name: "SUPER_ADMIN" } });
  return {
    status: "ACTIVE" as const,
    deletedAt: null,
    OR: [{ roleId: superAdminRole.id }, { userRoles: { some: { roleId: superAdminRole.id } } }]
  };
}

export async function countActiveSuperAdmins(options: { excludeUserId?: string } = {}): Promise<number> {
  const holder = await superAdminHolderWhere();
  return prisma.user.count({
    where: options.excludeUserId ? { ...holder, id: { not: options.excludeUserId } } : holder
  });
}

/**
 * Refuses a change that would leave no ACTIVE account holding SUPER_ADMIN. Unlike a role switch,
 * that is not reversible from inside the workspace: once nobody holds it, nobody can use the
 * super-admin-only path to grant it back, and only a platform operator can recover the workspace.
 *
 * `after` describes the target once the change lands. A target that is not an active holder today
 * loses nothing, so no count is taken — an unrelated edit must never be refused because some OTHER
 * account happens to be the only super admin.
 */
export async function assertNotLastSuperAdmin(
  target: AuthorityTarget,
  after: { heldRoles?: readonly string[] | null; status?: string; deleted?: boolean }
): Promise<void> {
  const holdsNow = target.status === "ACTIVE" && !target.deletedAt && holdsSuperAdmin(target.heldRoles);
  if (!holdsNow) return;
  const holdsAfter = !after.deleted && (after.status ?? target.status) === "ACTIVE" && holdsSuperAdmin(after.heldRoles ?? target.heldRoles);
  if (holdsAfter) return;
  if ((await countActiveSuperAdmins({ excludeUserId: target.id })) === 0) {
    throw new AppError(422, "This would leave no super admin able to manage the workspace — grant super admin to someone else first.");
  }
}
