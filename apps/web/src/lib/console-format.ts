/**
 * WHAT: the platform console's calendar and number formats — one place, so seven pages cannot drift.
 *
 * THE CALENDAR IS THE PLATFORM'S. The API keys every console day, week and month in the deployment's
 * zone (`TZ`, Asia/Kolkata by default — apps/api/src/utils/platform-time.ts), so a window the browser
 * asks for has to be named in the same calendar. `toISOString().slice(0, 10)` is UTC's date: between
 * 00:00 and 05:30 IST it names yesterday, and a range ending there left today out entirely.
 */

/** The zone the platform keys its days in. Mirrors the API's default `TZ`. */
export const CONSOLE_TIME_ZONE = "Asia/Kolkata";

const DAY_MS = 24 * 60 * 60 * 1000;

let dayFormatter: Intl.DateTimeFormat | null = null;

/** `YYYY-MM-DD` of `instant` on the platform's calendar. */
export function consoleDayKey(instant: Date): string {
  // en-CA formats a date as YYYY-MM-DD, which is exactly the key the API takes.
  dayFormatter ??= new Intl.DateTimeFormat("en-CA", { timeZone: CONSOLE_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });
  return dayFormatter.format(instant);
}

/** A `YYYY-MM-DD` key moved by whole days. Date-only arithmetic, so no zone and no DST cliff. */
export function shiftConsoleDay(dayKey: string, days: number): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The last `days` platform days, today included, as the inclusive pair the API's windows take. */
export function consoleRangeForDays(days: number, now = new Date()): { from: string; to: string } {
  const to = consoleDayKey(now);
  return { from: shiftConsoleDay(to, -(Math.max(1, days) - 1)), to };
}
