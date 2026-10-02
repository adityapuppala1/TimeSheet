/**
 * The log form's "Already logged on <day>" meter — YOUR hours on that day, nobody else's.
 *
 * THE DEFECT (audit 2026-10, timesheets #7): the meter summed every row the list route returned for
 * the date. For a `reports:view` holder that route returns the whole workspace, so a manager with
 * two reports who had each logged 7h saw "Already logged: 14.00h · 15.00h / 12h cap" for their own
 * one-hour entry, and Submit was disabled.
 */
import { describe, expect, it } from "vitest";
import { dayTotalFor } from "../../src/lib/day-total";

const row = (userId: string, workDate: string, totalHours: number, status = "SUBMITTED") => ({ userId, workDate, totalHours, status });

describe("dayTotalFor", () => {
  it("counts only the current user's rows", () => {
    const rows = [row("emp-1", "2026-10-01", 7), row("emp-2", "2026-10-01", 7), row("mgr-1", "2026-10-01", 1)];
    expect(dayTotalFor(rows, "mgr-1", "2026-10-01")).toBe(1);
  });

  it("counts only the chosen day, matching a stored UTC-midnight workDate by its date part", () => {
    const rows = [row("mgr-1", "2026-10-01T00:00:00.000Z", 3), row("mgr-1", "2026-09-30T00:00:00.000Z", 5)];
    expect(dayTotalFor(rows, "mgr-1", "2026-10-01")).toBe(3);
  });

  it("leaves out rejected hours, which no longer hold their time", () => {
    const rows = [row("mgr-1", "2026-10-01", 4, "REJECTED"), row("mgr-1", "2026-10-01", 2, "DRAFT")];
    expect(dayTotalFor(rows, "mgr-1", "2026-10-01")).toBe(2);
  });

  it("reads the author from the nested user when the row has no userId", () => {
    const rows = [{ user: { id: "mgr-1" }, workDate: "2026-10-01", totalHours: "2.5", status: "APPROVED" }];
    expect(dayTotalFor(rows, "mgr-1", "2026-10-01")).toBe(2.5);
  });

  it("is zero while the user is unknown", () => {
    expect(dayTotalFor([row("mgr-1", "2026-10-01", 3)], undefined, "2026-10-01")).toBe(0);
  });
});
