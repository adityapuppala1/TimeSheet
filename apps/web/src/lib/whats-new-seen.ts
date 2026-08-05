/**
 * Tracks which release's notes this browser has already looked at, powering the small dot on the
 * profile menu's "What's new" entry.
 *
 * localStorage, per browser, deliberately NOT server state: "has this person read the changelog"
 * is not workspace data worth a column and a migration — being wrong costs one unnecessary dot.
 * Keyed by version rather than a boolean so every new release re-arms the dot exactly once.
 */
const KEY = "timesheet:whats-new-seen-version";

export function hasUnseenRelease(latestVersion: string | null | undefined): boolean {
  if (!latestVersion) return false;
  return localStorage.getItem(KEY) !== latestVersion;
}

export function markReleaseSeen(latestVersion: string | null | undefined): void {
  if (latestVersion) localStorage.setItem(KEY, latestVersion);
}
