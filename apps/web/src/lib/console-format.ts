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

/* ------------------------------------------------------------------------------------------ */
/* Dates as people read them                                                                    */
/* ------------------------------------------------------------------------------------------ */

let dayMonthFormatter: Intl.DateTimeFormat | null = null;

/**
 * A `YYYY-MM-DD` key as "13 Jul" — the console's axis and label format, never "07-13".
 *
 * A date-only key HAS no zone, so it is formatted in UTC on purpose: formatting it in the browser's
 * zone would turn 13 July into 12 July for anybody west of Greenwich.
 */
export function dayMonth(dayKey: string): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  dayMonthFormatter ??= new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", day: "numeric", month: "short" });
  return dayMonthFormatter.format(new Date(Date.UTC(y, m - 1, d)));
}

/* ------------------------------------------------------------------------------------------ */
/* A chart's words                                                                              */
/* ------------------------------------------------------------------------------------------ */

/**
 * The sentence printed under a count chart — its text alternative (WCAG 1.1.1) and the figure anyone
 * can check the bars against: the total, the peak and the latest point. Written from the same series
 * the chart draws, so the words cannot disagree with the picture.
 */
export function summariseCounts(points: Array<{ label: string; total: number }>, options: { noun: string; span: string }): string {
  const total = points.reduce((sum, point) => sum + point.total, 0);
  const plural = (n: number) => `${options.noun}${n === 1 ? "" : "s"}`;
  if (total === 0) return `No ${plural(0)} in the last ${options.span}.`;
  const peak = points.reduce((best, point) => (point.total > best.total ? point : best), points[0]);
  const latest = points[points.length - 1];
  return `${total.toLocaleString(CONSOLE_LOCALE)} ${plural(total)} in the last ${options.span}. The most, ${peak.total}, in ${peak.label}; ${latest.total} in ${latest.label}.`;
}

/** The console's number locale: Indian digit grouping (12,34,567) unless a page has a reason not to. */
export const CONSOLE_LOCALE = "en-IN";
