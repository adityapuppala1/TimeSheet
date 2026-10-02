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
  const latest = points.at(-1) ?? peak;
  return `${total.toLocaleString(CONSOLE_LOCALE)} ${plural(total)} in the last ${options.span}. The most, ${peak.total}, in ${peak.label}; ${latest.total} in ${latest.label}.`;
}

/** The console's number locale: Indian digit grouping (12,34,567) unless a page has a reason not to. */
export const CONSOLE_LOCALE = "en-IN";

/* ------------------------------------------------------------------------------------------ */
/* Money and counts                                                                             */
/* ------------------------------------------------------------------------------------------ */

const moneyFormatters = new Map<string, Intl.NumberFormat>();

/**
 * Minor units as money — THE console money formatter. The CURRENCY always comes from the data (a
 * tier's list-price currency, a Stripe subscription's), never from the page; the locale is the
 * console's (`CONSOLE_LOCALE`). Revenue and Org 360 each hard-coded en-US, so an en-IN browser showed
 * 1,00,000 beside $100,000 on the same screen.
 *
 * `null` is NEVER money: it is the absence of a price or a reading, and it renders as an em dash so
 * it cannot be mistaken for zero down a column.
 */
export function formatMinor(minor: number | null | undefined, currency: string, fractionDigits = 0): string {
  if (minor === null || minor === undefined) return "—";
  const key = `${currency}|${fractionDigits}`;
  let formatter = moneyFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(CONSOLE_LOCALE, { style: "currency", currency, minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits });
    moneyFormatters.set(key, formatter);
  }
  return formatter.format(minor / 100);
}

/** AI spend: US dollars, because that is what the model providers bill and what the AI budget
 *  ceiling is set in — whatever currency the workspace's plan is priced in. */
export function formatUsd(amount: number | null | undefined, fractionDigits = 2): string {
  return amount === null || amount === undefined ? "—" : formatMinor(Math.round(amount * 100), "USD", fractionDigits);
}

let countFormatter: Intl.NumberFormat | null = null;

/** A whole count in the console's grouping. */
export function formatCount(value: number): string {
  countFormatter ??= new Intl.NumberFormat(CONSOLE_LOCALE, { maximumFractionDigits: 0 });
  return countFormatter.format(value);
}

/* ------------------------------------------------------------------------------------------ */
/* Chart labels                                                                                 */
/* ------------------------------------------------------------------------------------------ */

let monthFormatter: Intl.DateTimeFormat | null = null;

/** A `YYYY-MM` key as "Oct 2026". Date-only, so formatted in UTC for the reason `dayMonth` is. */
export function monthLabel(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  monthFormatter ??= new Intl.DateTimeFormat(CONSOLE_LOCALE, { timeZone: "UTC", month: "short", year: "numeric" });
  return monthFormatter.format(new Date(Date.UTC(y, m - 1, 1)));
}

const trendFormatters = new Map<boolean, Intl.DateTimeFormat>();

/**
 * One tick on an hourly series, on the platform's calendar. Over a short window the hour is part of
 * the label — twenty-four samples a day labelled by the date alone read as twenty-four identical
 * ticks; over a long one the date is enough.
 */
export function trendTick(instant: string | number | Date, spanDays: number): string {
  const withHour = spanDays <= 7;
  let formatter = trendFormatters.get(withHour);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(CONSOLE_LOCALE, {
      timeZone: CONSOLE_TIME_ZONE,
      day: "numeric",
      month: "short",
      ...(withHour ? { hour: "2-digit", minute: "2-digit", hour12: false } : {})
    });
    trendFormatters.set(withHour, formatter);
  }
  return formatter.format(new Date(instant));
}
