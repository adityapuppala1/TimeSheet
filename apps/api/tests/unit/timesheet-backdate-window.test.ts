/**
 * "Users can only log a timesheet entry up to a week back."
 *
 * The rule is one line and the boundary is the only place it can be wrong: is the 8th day back
 * refused and the 7th accepted? Off by one in either direction is a real defect — too lax and the
 * limit is not a week, too strict and somebody who logs on Monday for last Monday is refused on the
 * exact day they are meant to be allowed. So the edge is pinned from both sides, along with the
 * calendar arithmetic that tends to go wrong at month, year and leap-day boundaries.
 *
 * The window is a WORKSPACE SETTING now (Workspace Settings -> Ticketing): a number of days, 0 for today
 * only, or null for no limit. The cases below cover 7 (the default) and the values an admin can choose.
 *
 * Pure functions: the controller's three call sites (create, move-the-date, submit-an-old-draft) are
 * one line each and all call `assertWorkDateInWindow`; the interesting logic is here.
 */
import { describe, expect, it } from "vitest";

import { earliestLoggableDate, earliestLoggableDateFor, TIMESHEET_BACKDATE_DAYS } from "@timesheet/shared";

import { assertWorkDateInWindow, isWorkDateTooOld } from "../../src/utils/timesheet-window.js";

const day = (key: string) => new Date(`${key}T00:00:00.000Z`);

describe("earliestLoggableDate", () => {
  it("is a week back, counting today as day 0", () => {
    expect(TIMESHEET_BACKDATE_DAYS).toBe(7);
    expect(earliestLoggableDate("2026-11-12")).toBe("2026-11-05");
  });

  it("crosses a month boundary", () => {
    expect(earliestLoggableDate("2026-11-03")).toBe("2026-10-27");
  });

  it("crosses a year boundary", () => {
    expect(earliestLoggableDate("2026-01-03")).toBe("2025-12-27");
  });

  it("handles a leap day", () => {
    expect(earliestLoggableDate("2028-03-02")).toBe("2028-02-24");
    expect(earliestLoggableDate("2027-03-02")).toBe("2027-02-23");
  });
});

describe("isWorkDateTooOld — the boundary, from both sides", () => {
  const today = day("2026-11-12");

  it("accepts today and the seven days before it", () => {
    expect(isWorkDateTooOld(day("2026-11-12"), today, 7)).toBe(false);
    expect(isWorkDateTooOld(day("2026-11-06"), today, 7)).toBe(false);
    expect(isWorkDateTooOld(day("2026-11-05"), today, 7)).toBe(false); // exactly a week back: still allowed
  });

  it("refuses the eighth day back and anything older", () => {
    expect(isWorkDateTooOld(day("2026-11-04"), today, 7)).toBe(true);
    expect(isWorkDateTooOld(day("2026-10-01"), today, 7)).toBe(true);
    expect(isWorkDateTooOld(day("2025-11-12"), today, 7)).toBe(true);
  });

  it("does not treat a future date as too old (that is the other rule's job)", () => {
    expect(isWorkDateTooOld(day("2026-11-13"), today, 7)).toBe(false);
  });
});

describe("assertWorkDateInWindow", () => {
  const today = day("2026-11-12");

  it("passes inside the window", () => {
    expect(() => assertWorkDateInWindow(day("2026-11-05"), today, 7)).not.toThrow();
  });

  it("throws a 422 that names the earliest date that would be accepted", () => {
    let error: unknown;
    try {
      assertWorkDateInWindow(day("2026-11-04"), today, 7);
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({ statusCode: 422, code: "TIMESHEET_TOO_OLD" });
    expect((error as Error).message).toContain("up to 7 days back");
    expect((error as Error).message).toContain("2026-11-05");
  });
});

describe("the window is a setting: any number of days, today only, or no limit", () => {
  const today = day("2026-11-12");

  it("30 days reaches back a month — the same boundary rule, just further", () => {
    expect(isWorkDateTooOld(day("2026-10-13"), today, 30)).toBe(false);
    expect(isWorkDateTooOld(day("2026-10-12"), today, 30)).toBe(true);
  });

  it("0 means today only: yesterday is already too old", () => {
    expect(isWorkDateTooOld(day("2026-11-12"), today, 0)).toBe(false);
    expect(isWorkDateTooOld(day("2026-11-11"), today, 0)).toBe(true);
    expect(earliestLoggableDate("2026-11-12", 0)).toBe("2026-11-12");
  });

  it("null means NO LIMIT — nothing is ever too old, however old", () => {
    expect(isWorkDateTooOld(day("2020-01-01"), today, null)).toBe(false);
    expect(() => assertWorkDateInWindow(day("2020-01-01"), today, null)).not.toThrow();
  });

  it("earliestLoggableDateFor gives null for no limit, so no caller invents a date", () => {
    expect(earliestLoggableDateFor("2026-11-12", null)).toBeNull();
    expect(earliestLoggableDateFor("2026-11-12", 7)).toBe("2026-11-05");
  });

  it("words the refusal for the window in force", () => {
    const message = (days: number) => {
      try {
        assertWorkDateInWindow(day("2020-01-01"), today, days);
      } catch (e) {
        return (e as Error).message;
      }
      return "";
    };
    expect(message(0)).toContain("for today only");
    expect(message(1)).toContain("up to 1 day back");
    expect(message(30)).toContain("up to 30 days back");
    expect(message(30)).toContain("2026-10-13");
  });
});
