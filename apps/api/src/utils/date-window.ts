/**
 * WHAT: the `from`/`to` date window the dashboard endpoints accept, parsed and resolved once.
 *
 * WHY IT EXISTS: four routes — `GET /timesheets`, `/reports/admin-summary`, `/reports/daily-status`
 * and `/dashboards/my-month` — all learned the same window when the home page got a universal date
 * filter, and three of them had already grown their own copy of the same eight-line date parser.
 * One definition means a fix to the off-by-one lands in all four, and means the behaviour can be
 * tested against the real thing instead of against a copy of it in a test file.
 *
 * WHY IT DROPS BAD INPUT RATHER THAN REJECTING IT: these query strings are built by the UI, then
 * bookmarked, hand-edited and pasted between people. Refusing a whole dashboard over one stale
 * parameter is worse than answering the rest of it — the same rule report.controller.ts's
 * `parseReportFilters` already applied to its own filters. A missing or unusable range simply means
 * "the window this endpoint used before there was anything to choose".
 *
 * WHOSE CALENDAR: the platform's (`env.TZ`, Asia/Kolkata by default — utils/platform-time.ts). A
 * `YYYY-MM-DD` here names a day on THAT calendar. Two column kinds need it differently:
 *   - a `@db.Date` column (`workDate`, a ticket's `endDate`) stores the calendar day itself as UTC
 *     midnight, so the day key converts straight across (`dateKeyToUtc`);
 *   - a TIMESTAMP column (`createdAt`, `resolvedAt`) needs the INSTANT that day began there — UTC
 *     midnight is 05:30 IST, so a window starting at it drops the first five and a half hours of
 *     the day and borrows them from the day after.
 * The helpers below compose platform-time.ts and recipient-time.ts; they are not a second clock.
 */
import { env } from "../config/env.js";
import { platformDayKey, platformDayStart as platformDayStartOfKey } from "./platform-time.js";
import { dateKeyToUtc, startOfZonedDayUtc } from "./recipient-time.js";

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Today on the platform's calendar, as the UTC-midnight value a `@db.Date` column stores. */
export function platformToday(now: Date = new Date()): Date {
  return dateKeyToUtc(platformDayKey(now));
}

/** The platform-calendar month containing `now`, on a `@db.Date` column: [1st, 1st of next month). */
export function platformMonth(now: Date = new Date()): { start: Date; end: Date } {
  const [y, m] = platformDayKey(now).split("-").map(Number);
  return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)) };
}

/** Monday of the platform-calendar week containing `now`, on a `@db.Date` column. */
export function platformWeekStart(now: Date = new Date()): Date {
  const today = platformToday(now);
  return new Date(today.getTime() - ((today.getUTCDay() + 6) % 7) * DAY_MS);
}

/**
 * The INSTANT a calendar day began on the platform's clock, for comparing against a timestamp
 * column. `day` is the UTC-midnight value of that calendar day (what `parseIsoDay` returns).
 *
 * Delegates to platform-time.ts, which corrects its noon-UTC probe for the zones east of UTC+11
 * (where noon UTC is already the next day). This used to probe noon UTC uncorrected, so under
 * Pacific/Auckland every window began a day late — two implementations of one boundary that
 * disagreed.
 */
export function platformDayStart(day: Date): Date {
  return platformDayStartOfKey(day.toISOString().slice(0, 10));
}

/** `2026-08-27` → midnight UTC that day. Anything else → undefined. */
export function parseIsoDay(raw: unknown): Date | undefined {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export interface DayWindow {
  /** Midnight UTC on the first day, or undefined for "unbounded below". */
  from?: Date;
  /** Midnight UTC on the last day, INCLUSIVE. Compare with `lte`. */
  to?: Date;
  /** True when the request actually asked for a window. */
  ranged: boolean;
}

export function parseDayWindow(query: { from?: unknown; to?: unknown }): DayWindow {
  const from = parseIsoDay(query.from);
  const to = parseIsoDay(query.to);
  return { from, to, ranged: Boolean(from || to) };
}

/** The `where.workDate` clause for a date column, or undefined when there is no window. */
export function workDateFilter(window: DayWindow): { gte?: Date; lte?: Date } | undefined {
  if (!window.ranged) return undefined;
  return { ...(window.from ? { gte: window.from } : {}), ...(window.to ? { lte: window.to } : {}) };
}

/** Days in an inclusive window, counting both ends. One when there is no window. */
export function windowDays(from: Date, to: Date): number {
  return Math.max(1, Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1);
}

/**
 * How far back a comparison period sits: the window's length rounded UP to whole weeks.
 *
 * WHY WHOLE WEEKS: "vs the previous period" used to be the equal-length window immediately before
 * this one. For the home page's default — Monday to today — that compared Mon–Thu with the Thu–Sun
 * before it, a window holding a weekend, so every delta on the page read as growth. Shifting by whole
 * weeks keeps the same weekdays on both sides (week-to-date against the same weekdays last week), and
 * rounding up keeps the two windows from overlapping.
 */
export function comparisonShiftDays(days: number): number {
  return Math.ceil(Math.max(1, days) / 7) * 7;
}

/** The visible label for a delta against `comparisonShiftDays(days)` — never tooltip-only. */
export function comparisonLabel(days: number): string {
  const weeks = comparisonShiftDays(days) / 7;
  if (weeks === 1) return days === 1 ? "vs the same day last week" : "vs the same days last week";
  return `vs the same days ${weeks} weeks earlier`;
}

export interface DayComparison {
  /** First and last day of the window on a `@db.Date` column, both INCLUSIVE (compare with lte). */
  from: Date;
  to: Date;
  /** The like-for-like comparison days, inclusive: the same weekdays `shiftDays` earlier, ending at
   *  the same point — so a window that runs past today compares only its days to date. */
  prevFrom: Date;
  prevTo: Date;
  days: number;
  shiftDays: number;
  label: string;
}

/**
 * The day window for a `@db.Date` column (`workDate`), and its comparison. With no range it is today
 * on the platform calendar — what every caller that sends nothing has always meant.
 */
export function resolveDayComparison(window: DayWindow, now: Date): DayComparison {
  const today = platformToday(now);
  const from = window.from ?? today;
  const to = window.to ?? today;
  const days = windowDays(from, to);
  const shiftDays = comparisonShiftDays(days);
  const shift = shiftDays * DAY_MS;
  // To date: a week in progress is compared with the same days of last week, not all seven.
  const comparableTo = to > today && from <= today ? today : to;
  return {
    from,
    to,
    prevFrom: new Date(from.getTime() - shift),
    prevTo: new Date(comparableTo.getTime() - shift),
    days,
    shiftDays,
    label: comparisonLabel(days)
  };
}

export interface TimestampWindow {
  /** Inclusive lower bound: the instant the window's first day began on the platform calendar. */
  start: Date;
  /**
   * EXCLUSIVE upper bound: the instant the day AFTER `to` began — so the window's own last day is
   * fully counted. This is the off-by-one that makes an inclusive-looking range quietly drop its
   * final day, and the reason this lives in one place.
   *
   * Null when the request gave no window: the pre-existing queries are `{ gte: startOfToday }` with
   * no upper bound at all, and inventing one would exclude anything written during the request.
   */
  end: Date | null;
  /** The like-for-like comparison window, [prevStart, prevEnd): the same span `shiftDays` earlier,
   *  cut at the same moment — `now` minus the shift when the window runs on past now. */
  prevStart: Date;
  prevEnd: Date;
}

/**
 * Resolves a window over TIMESTAMP columns (createdAt, resolvedAt), plus the period to compare it
 * against — see `comparisonShiftDays` for why that is the same weekdays whole weeks earlier.
 *
 * Every boundary is an IST midnight (platform calendar), not a UTC one: UTC midnight is 05:30 IST, so
 * a ticket raised at 02:00 IST on the 1st used to count against the 31st.
 */
export function resolveTimestampWindow(window: DayWindow, now: Date): TimestampWindow {
  const days = resolveDayComparison(window, now);
  const start = platformDayStart(days.from);
  const end = window.ranged ? platformDayStart(new Date(days.to.getTime() + DAY_MS)) : null;
  const shift = days.shiftDays * DAY_MS;
  const comparableEnd = end && end.getTime() < now.getTime() ? end : now;
  return { start, end, prevStart: new Date(start.getTime() - shift), prevEnd: new Date(comparableEnd.getTime() - shift) };
}

/**
 * The platform zone's UTC offset at `at`, as MySQL's CONVERT_TZ wants it: "+05:30".
 *
 * For raw SQL over DATETIME columns. Prisma writes and reads `DateTime` as UTC, and a DATETIME is
 * zone-less, so MySQL's session time_zone does not touch it: `DATE(createdAt)` is UTC's day.
 * `DATE(CONVERT_TZ(createdAt, '+00:00', <this>))` is the platform's day — the same day Prisma-side
 * comparisons against `platformDayStart` give. One offset per query: exact for IST, which has no
 * daylight saving. NOT exact under a daylight-saving zone: the offset taken at `at` is applied to the
 * whole series, so rows from the other side of a changeover that fall in the hour next to midnight
 * land on the neighbouring day (review finding F6 — left as is; IST, the default, is unaffected).
 *
 * Measured AT `at`: `startOfZonedDayUtc` subtracts the zone's offset at that instant from the day's
 * UTC-midnight value, so the difference between the two is that offset exactly — no noon probe, so
 * no zone (UTC+13, UTC+14) falls outside it.
 */
export function platformUtcOffset(at: Date = new Date()): string {
  const minutes = Math.round((platformToday(at).getTime() - startOfZonedDayUtc(at, env.TZ).getTime()) / 60_000);
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}
