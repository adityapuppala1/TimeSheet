/**
 * WHAT: the small decisions behind User Management's People tab — which roles a picker offers,
 * which row actions are held back and why, who may be picked as a manager, and which tab the URL
 * asks for. Pure, so tests/unit/user-admin.test.ts pins each one.
 *
 * EACH MIRRORS A SERVER RULE (apps/api/src/services/user-authority.service.ts and
 * reporting-line.service.ts). The server is what enforces them; this only keeps the screen from
 * offering what the API would refuse, and says why instead of letting a click fail.
 */
import { roles, type RoleName } from "@timesheet/shared";

/** Every role except SUPER_ADMIN, unless the viewer is a super admin: only a super admin may grant
 *  it. An ADMIN keeps every other grant. */
export function assignableRoles(viewerRole: string | undefined): RoleName[] {
  return viewerRole === "SUPER_ADMIN" ? [...roles] : roles.filter((role) => role !== "SUPER_ADMIN");
}

export interface RowActionLocks {
  /** Why anything below is locked, shown once in the menu — or null when nothing is. */
  reason: string | null;
  edit: boolean;
  /** Deactivate / Activate. */
  toggleStatus: boolean;
  resetPassword: boolean;
  signOut: boolean;
  remove: boolean;
}

interface RowTarget {
  id: string;
  status: string;
  role?: { name?: string } | null;
  heldRoles?: string[];
}

const UNLOCKED: RowActionLocks = { reason: null, edit: false, toggleStatus: false, resetPassword: false, signOut: false, remove: false };

/**
 * What the viewer may not do from this row.
 *  - A super admin's account (held, not only active: someone switched into another role can switch
 *    back) is a super admin's to change. Resend-welcome stays open — it changes nobody's access.
 *  - Your own row: no deactivating or deleting yourself. Editing stays open (the server refuses
 *    only a self-demotion), and so does signing yourself out everywhere.
 */
export function rowActionLocks(viewer: { id?: string; role?: string }, target: RowTarget): RowActionLocks {
  const held = target.heldRoles ?? (target.role?.name ? [target.role.name] : []);
  if (held.includes("SUPER_ADMIN") && viewer.role !== "SUPER_ADMIN") {
    return {
      reason: "Only a super admin can change a super admin's account.",
      edit: true,
      toggleStatus: true,
      resetPassword: true,
      signOut: true,
      remove: true
    };
  }
  if (viewer.id && viewer.id === target.id) {
    return { ...UNLOCKED, reason: "You can't deactivate or delete your own account. Ask another admin.", toggleStatus: target.status === "ACTIVE", remove: true };
  }
  return UNLOCKED;
}

const MANAGER_ROLES = new Set(["MANAGER", "TEAM_LEAD", "ADMIN", "SUPER_ADMIN"]);

/** Who the manager picker offers: people in a managing role who are ACTIVE. The server refuses an
 *  inactive manager — they approve nothing and are skipped by every notification. */
export function eligibleManagers<T extends { status?: string; role?: { name?: string } | null }>(people: T[]): T[] {
  return people.filter((person) => person.status === "ACTIVE" && MANAGER_ROLES.has(person.role?.name ?? ""));
}

export type UsersTab = "people" | "requests";

/** The tab the URL asks for. Read on every render, not once at mount — the bell's "asked to join"
 *  link changes only the query string when you are already on Users, and the page stays mounted. */
export function usersTabFrom(params: URLSearchParams): UsersTab {
  return params.get("tab") === "requests" ? "requests" : "people";
}
