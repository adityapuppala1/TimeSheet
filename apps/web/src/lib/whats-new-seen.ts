/**
 * Tracks which release's notes this browser has already looked at, powering the small dot on the
 * profile menu's "What's new" entry.
 *
 * WHICH VERSION IS PASSED IN: the one the workspace is RUNNING (`UpdateStatus.currentVersion`), not
 * the newest one GitHub knows about. The two are the same only once somebody has pushed the tag,
 * which happens after the release ships — so keying on the remote value left the dot dark through
 * the upgrade it exists to announce. "What's new" means "notes you haven't read for the build you
 * are using".
 *
 * localStorage, per browser, deliberately NOT server state: "has this person read the changelog"
 * is not workspace data worth a column and a migration — being wrong costs one unnecessary dot.
 * Keyed by version rather than a boolean so every new release re-arms the dot exactly once.
 *
 * WHY THE BELL IS SEPARATE, and not a duplicate of this: an upgrade also raises a real
 * `release.published` Notification row per user (see api/src/services/release-announce.service.ts),
 * which is server state because it must survive a browser change and be markable as read from the
 * bell. This dot is the cheap, local, "you have not opened the page yet" hint on the menu item
 * itself; the two clear independently, and neither can un-clear the other.
 */
const KEY = "timesheet:whats-new-seen-version";

export function hasUnseenRelease(runningVersion: string | null | undefined): boolean {
  if (!runningVersion) return false;
  return localStorage.getItem(KEY) !== runningVersion;
}

export function markReleaseSeen(runningVersion: string | null | undefined): void {
  if (runningVersion) localStorage.setItem(KEY, runningVersion);
}
