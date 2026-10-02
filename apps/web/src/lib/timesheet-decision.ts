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
 *
 * Two exceptions exist on the server and are deliberately NOT mirrored here, because the client
 * cannot see what they turn on: a manager at the top of the tree (no manager of their own) may be
 * decided by the people below them, and a workspace's sole approver may decide their own entries.
 * Both are listed, with their buttons, in the approvals queue; this only ever hides a button the
 * server would have allowed, never offers one it refuses.
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

/** Whether to offer "Reopen" — sending an APPROVED entry back to the approval queue. The same rule as
 *  deciding (never your own entry, never your manager's), and only on an APPROVED one; the server
 *  enforces both (POST /timesheets/:id/reopen). */
export function canReopenTimesheet(
  user: DecidingUser | null | undefined,
  entry: (DecidableEntry & { status?: string | null }) | null | undefined
): boolean {
  return entry?.status === "APPROVED" && canDecideTimesheet(user, entry);
}
