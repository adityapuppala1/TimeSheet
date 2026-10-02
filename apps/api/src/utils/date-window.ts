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
import { platformDayKey } from "./platform-time.js";
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
 * column. `day` is the UTC-midnight value of that calendar day (what `parseIsoDay` returns). Noon UTC
 * is on the same calendar day in every zone between UTC−11 and UTC+11, so it is a safe probe.
 */
export function platformDayStart(day: Date): Date {
  return startOfZonedDayUtc(new Date(day.getTime() + DAY_MS / 2), env.TZ);
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

export interface TimestampWindow {
  /** Inclusive lower bound. */
  start: Date;
  /**
   * EXCLUSIVE upper bound, sitting at midnight on the day AFTER `to` — so the window's own last day
   * is fully counted. This is the off-by-one that makes an inclusive-looking range quietly drop its
   * final day, and the reason this lives in one place.
   *
   * Null when the request gave no window: the pre-existing queries are `{ gte: startOfToday }` with
   * no upper bound at all, and inventing one would exclude anything written during the request.
   */
  end: Date | null;
  /** Inclusive lower bound of the equal-length window immediately before `start`. */
  prevStart: Date;
}

/**
 * Resolves a window over TIMESTAMP columns (createdAt, reviewedAt), plus the period to compare it
 * against.
 *
 * The comparison is the equal-length window immediately before this one, which is the only thing a
 * delta can honestly mean for an arbitrary span — "vs yesterday" against a fortnight would read as
 * a collapse every time. Floored at one day so a single-day window still has something before it.
 */
export function resolveTimestampWindow(window: DayWindow, fallbackStart: Date, now: Date): TimestampWindow {
  const start = window.from ?? fallbackStart;
  const end = window.to ? new Date(window.to.getTime() + DAY_MS) : window.ranged ? now : null;
  const length = Math.max(DAY_MS, (end?.getTime() ?? now.getTime()) - start.getTime());
  return { start, end, prevStart: new Date(start.getTime() - length) };
}

/** Days in an inclusive window, counting both ends. One when there is no window. */
export function windowDays(from: Date, to: Date): number {
  return Math.max(1, Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1);
}
