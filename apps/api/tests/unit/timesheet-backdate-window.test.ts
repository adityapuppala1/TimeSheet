/**
 * "Users can only log a timesheet entry up to a week back."
 *
 * The rule is one line and the boundary is the only place it can be wrong: is the 8th day back
 * refused and the 7th accepted? Off by one in either direction is a real defect — too lax and the
 * limit is not a week, too strict and somebody who logs on Monday for last Monday is refused on the
 * exact day they are meant to be allowed. So the edge is pinned from both sides, along with the
 * calendar arithmetic that tends to go wrong at month, year and leap-day boundaries.
 *
 * Pure functions: the controller's three call sites (create, move-the-date, submit-an-old-draft) are
 * one line each and all call `assertWorkDateInWindow`; the interesting logic is here.
 */
import { describe, expect, it } from "vitest";

import { earliestLoggableDate, TIMESHEET_BACKDATE_DAYS } from "@timesheet/shared";

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
    expect(isWorkDateTooOld(day("2026-11-12"), today)).toBe(false);
    expect(isWorkDateTooOld(day("2026-11-06"), today)).toBe(false);
    expect(isWorkDateTooOld(day("2026-11-05"), today)).toBe(false); // exactly a week back: still allowed
  });

  it("refuses the eighth day back and anything older", () => {
    expect(isWorkDateTooOld(day("2026-11-04"), today)).toBe(true);
    expect(isWorkDateTooOld(day("2026-10-01"), today)).toBe(true);
    expect(isWorkDateTooOld(day("2025-11-12"), today)).toBe(true);
  });

  it("does not treat a future date as too old (that is the other rule's job)", () => {
    expect(isWorkDateTooOld(day("2026-11-13"), today)).toBe(false);
  });
});

describe("assertWorkDateInWindow", () => {
  const today = day("2026-11-12");

  it("passes inside the window", () => {
    expect(() => assertWorkDateInWindow(day("2026-11-05"), today)).not.toThrow();
  });

  it("throws a 422 that names the earliest date that would be accepted", () => {
    let error: unknown;
    try {
      assertWorkDateInWindow(day("2026-11-04"), today);
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({ statusCode: 422, code: "TIMESHEET_TOO_OLD" });
    expect((error as Error).message).toContain("7 days back");
    expect((error as Error).message).toContain("2026-11-05");
  });
});
