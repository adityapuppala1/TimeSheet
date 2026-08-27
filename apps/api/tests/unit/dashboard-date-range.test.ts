/**
 * `utils/date-window.ts` — the `from`/`to` window the home page's universal date filter drives, and
 * which four endpoints resolve through: `GET /timesheets`, `/reports/admin-summary`,
 * `/reports/daily-status` and `/dashboards/my-month`.
 *
 * The property that matters most is NOT that the window works. It is that OMITTING it reproduces
 * exactly what each endpoint did before, because every other caller in the app still calls them
 * with no range and must not shift underneath.
 *
 * The other thing pinned here is `GET /timesheets`' row cap. That cap is the whole reason the
 * filter could not live in the browser: the route returns newest-first and truncates, so filtering
 * a range client-side silently under-reports any period outside the newest page. It looks right in
 * development, where nobody has that many entries, and is wrong in production.
 *
 * The shims below are the four routes' own lines, calling the same helpers they call — not a copy
 * of the arithmetic, which would pass happily while the routes were broken.
 */
import { describe, expect, it } from "vitest";

import {
  DAY_MS,
  parseDayWindow,
  parseIsoDay,
  resolveTimestampWindow,
  windowDays,
  workDateFilter
} from "../../src/utils/date-window.js";

/** Exactly what `GET /timesheets` builds from the query. */
function timesheetQuery(query: Record<string, unknown>) {
  const workDate = workDateFilter(parseDayWindow(query));
  return { workDate, take: workDate ? 2_000 : 100 };
}

/** Exactly what `/reports/admin-summary` resolves. */
function summaryWindows(query: Record<string, unknown>, now: Date, startOfLocalDay: Date) {
  const window = parseDayWindow(query);
  const { start: winStart, end: winEnd, prevStart } = resolveTimestampWindow(window, startOfLocalDay, now);
  return { ranged: window.ranged, winStart, winEnd, prevStart };
}

/** Exactly what `/dashboards/my-month` resolves. */
function myMonthWindow(query: Record<string, unknown>, now: Date) {
  const window = parseDayWindow(query);
  return {
    start: window.from ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: window.to ? new Date(window.to.getTime() + DAY_MS) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  };
}

/** Exactly what `/reports/daily-status` resolves. */
function dailyStatusWindow(query: Record<string, unknown>, today: Date) {
  const window = parseDayWindow(query);
  const from = window.from ?? today;
  const to = window.to ?? today;
  return { from, to, days: windowDays(from, to) };
}

describe("GET /timesheets — the range and the row cap", () => {
  it("does not filter, and keeps the 100-row page, when no range is given", () => {
    // Every other caller — History, the Timesheet page, the approvals table — passes nothing.
    expect(timesheetQuery({})).toEqual({ workDate: undefined, take: 100 });
  });

  it("raises the cap for a bounded range, which is why the filter is server-side", () => {
    const q = timesheetQuery({ from: "2026-08-01", to: "2026-08-27" });
    expect(q.take).toBe(2_000);
    expect(q.workDate).toEqual({
      gte: new Date("2026-08-01T00:00:00.000Z"),
      lte: new Date("2026-08-27T00:00:00.000Z")
    });
  });

  it("accepts a half-open range", () => {
    expect(timesheetQuery({ from: "2026-08-01" }).workDate).toEqual({ gte: new Date("2026-08-01T00:00:00.000Z") });
    expect(timesheetQuery({ to: "2026-08-27" }).workDate).toEqual({ lte: new Date("2026-08-27T00:00:00.000Z") });
  });

  it("DROPS an unparseable date rather than rejecting the request", () => {
    // These query strings get bookmarked, hand-edited and pasted between people. Refusing a whole
    // dashboard over one stale parameter is worse than answering the rest of it.
    for (const bad of ["yesterday", "2026-8-1", "", "2026-13-45", 20260801, null]) {
      expect(parseIsoDay(bad)).toBeUndefined();
      expect(timesheetQuery({ from: bad })).toEqual({ workDate: undefined, take: 100 });
    }
  });
});

describe("GET /reports/admin-summary — window arithmetic", () => {
  const now = new Date("2026-08-27T11:00:00.000Z");
  const startOfToday = new Date("2026-08-27T00:00:00.000Z");

  it("falls back to today-onward with no upper bound when no range is given", () => {
    const w = summaryWindows({}, now, startOfToday);
    expect(w.ranged).toBe(false);
    expect(w.winStart).toEqual(startOfToday);
    // `null`, not `now`: the pre-existing queries are `{ gte: startOfToday }` with no `lt`, and
    // adding one would quietly exclude anything written during the request.
    expect(w.winEnd).toBeNull();
  });

  it("includes the range's own last day", () => {
    const w = summaryWindows({ from: "2026-08-01", to: "2026-08-27" }, now, startOfToday);
    // The 28th at midnight, exclusive — so everything ON the 27th counts. A `lt: 27th` here would
    // drop a whole day of the period the user asked for.
    expect(w.winEnd).toEqual(new Date("2026-08-28T00:00:00.000Z"));
  });

  it("compares against the equal-length window immediately before the range", () => {
    const w = summaryWindows({ from: "2026-08-21", to: "2026-08-27" }, now, startOfToday);
    // Seven days selected → the seven days before them. "vs yesterday" would read as a collapse
    // every time a longer period was chosen, which is why the label changes with the range too.
    expect(w.prevStart).toEqual(new Date("2026-08-14T00:00:00.000Z"));
    expect(w.winStart.getTime() - w.prevStart.getTime()).toBe(7 * DAY_MS);
  });

  it("never produces a zero-length comparison window for a single day", () => {
    const w = summaryWindows({ from: "2026-08-27", to: "2026-08-27" }, now, startOfToday);
    expect(w.winStart.getTime() - w.prevStart.getTime()).toBe(DAY_MS);
  });
});

describe("GET /dashboards/my-month", () => {
  const now = new Date("2026-08-27T11:00:00.000Z");

  it("is the current calendar month when no range is given", () => {
    expect(myMonthWindow({}, now)).toEqual({
      start: new Date("2026-08-01T00:00:00.000Z"),
      end: new Date("2026-09-01T00:00:00.000Z")
    });
  });

  it("takes the range, with the last day included", () => {
    expect(myMonthWindow({ from: "2026-07-06", to: "2026-07-12" }, now)).toEqual({
      start: new Date("2026-07-06T00:00:00.000Z"),
      end: new Date("2026-07-13T00:00:00.000Z")
    });
  });
});

describe("GET /reports/daily-status", () => {
  const today = new Date("2026-08-27T00:00:00.000Z");

  it("is a single day — today — when no range is given", () => {
    expect(dailyStatusWindow({}, today)).toEqual({ from: today, to: today, days: 1 });
  });

  it("counts days inclusively, so the card can label itself", () => {
    // The caller cannot infer the period from the numbers, and a card reading "today" over a
    // month of data is simply wrong.
    expect(dailyStatusWindow({ from: "2026-08-01", to: "2026-08-27" }, today).days).toBe(27);
    expect(dailyStatusWindow({ from: "2026-08-27", to: "2026-08-27" }, today).days).toBe(1);
  });
});
