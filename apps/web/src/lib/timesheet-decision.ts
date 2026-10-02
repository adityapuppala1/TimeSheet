/**
 * Whether the signed-in person may approve or reject THIS timesheet entry — the client's mirror of
 * `services/timesheet-approval-scope.service.ts` on the API.
 *
 * WHY PER ENTRY: it used to be one boolean ("holds timesheets:approve"), so an approver opening their
 * own submitted entry from History or the dashboard was offered Approve beside it. The server now
 * refuses self-approval and approval of anyone above you in your reporting line (segregation of
 * duties, every role); offering a button the server refuses is a button that can only fail.
 *
 * The client knows your DIRECT manager (`AuthUser.managerId`), not the whole chain above them, so it
 * hides the common case and leaves the rest to the server's 403 — which says why in plain words. The
 * approvals queue itself is already scoped server-side and never lists either kind of entry.
 */
export interface DecidingUser {
  id: string;
  managerId?: string | null;
  permissions: readonly string[];
}

export interface DecidableEntry {
  userId?: string | null;
  user?: { id?: string | null } | null;
}

export function canDecideTimesheet(user: DecidingUser | null | undefined, entry: DecidableEntry | null | undefined): boolean {
  if (!user || !entry) return false;
  if (!user.permissions.includes("timesheets:approve")) return false;
  const authorId = entry.userId ?? entry.user?.id ?? null;
  if (!authorId) return false;
  if (authorId === user.id) return false;
  if (user.managerId && authorId === user.managerId) return false;
  return true;
}
