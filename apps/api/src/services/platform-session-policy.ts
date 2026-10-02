/**
 * How long a platform-console session may live (M5).
 *
 * Until this existed a console session lasted REFRESH_TOKEN_TTL_DAYS — the tenants' fourteen days —
 * with no idle limit at all, so a laptop left open on the console stayed an owner's console for a
 * fortnight. OWASP ASVS 3.3.2 (L2) puts it at 12 hours absolute and 30 minutes idle, which are the
 * defaults of PLATFORM_ADMIN_SESSION_TTL_HOURS and PLATFORM_ADMIN_IDLE_TIMEOUT_MINUTES.
 *
 * ABSOLUTE IS MEASURED FROM CREATION and nothing extends it — a refresh rotates the credential, not
 * the deadline. It is also applied to sessions created before this release, whose stored `expiresAt`
 * is fourteen days out: `createdAt + TTL` is the earlier of the two, so they end on the new terms.
 *
 * IDLE IS MEASURED FROM THE LAST AUTHENTICATED REQUEST (`lastUsedAt`, written by
 * requirePlatformAdmin at most once a minute), falling back to `createdAt` for a session that has
 * not carried one since the column was added.
 *
 * Pure, so the middleware and the refresh path ask the same function and cannot disagree.
 */
export type ConsoleSessionLapse = "absolute" | "idle";

export interface ConsoleSessionTimes {
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date;
}

export interface ConsoleSessionPolicy {
  ttlHours: number;
  idleMinutes: number;
}

/** How often `lastUsedAt` is rewritten. A minute is three orders of magnitude finer than the idle
 *  limit and keeps the write rate at one row per active operator per minute. */
export const SESSION_TOUCH_INTERVAL_MS = 60_000;

export function consoleSessionLapse(session: ConsoleSessionTimes, now: Date, policy: ConsoleSessionPolicy): ConsoleSessionLapse | null {
  const absoluteEnd = Math.min(session.expiresAt.getTime(), session.createdAt.getTime() + policy.ttlHours * 3_600_000);
  if (now.getTime() >= absoluteEnd) return "absolute";
  const lastActive = (session.lastUsedAt ?? session.createdAt).getTime();
  if (now.getTime() - lastActive > policy.idleMinutes * 60_000) return "idle";
  return null;
}

/** Whether this request should rewrite `lastUsedAt`. */
export function sessionNeedsTouch(session: Pick<ConsoleSessionTimes, "lastUsedAt">, now: Date): boolean {
  return !session.lastUsedAt || now.getTime() - session.lastUsedAt.getTime() >= SESSION_TOUCH_INTERVAL_MS;
}
