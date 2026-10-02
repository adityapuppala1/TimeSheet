/**
 * WHAT: calendar days on the VIEWER's clock, as the `YYYY-MM-DD` keys every date window in the API
 * takes.
 *
 * WHY NOT `toISOString().slice(0, 10)`: that is UTC's day. In India (UTC+5:30) it is still yesterday
 * until 05:30 — so a page that opened "from today" on `toISOString()` started from yesterday for the
 * first five and a half hours of every day, and a local-midnight date converted to the previous day.
 */

/** "YYYY-MM-DD" from a Date's LOCAL calendar components. */
export function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** A `YYYY-MM-DD` key as a LOCAL midnight Date, or null for anything else. */
export function isoToLocalDate(iso: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

/** Calendar-day arithmetic on a local date; `setDate` keeps a DST change from shifting the day. */
export function addLocalDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/** Today's key, and the key `days` later — the window a forward-looking board asks for. */
export function localWindowFromToday(days: number, now: Date = new Date()): { from: string; to: string } {
  return { from: localDateKey(now), to: localDateKey(addLocalDays(now, days)) };
}
