/**
 * The home page's personal cards — "Your logged hours", "Awaiting review", the target meter and the
 * daily rhythm chart — are about the SIGNED-IN person and nobody else.
 *
 * They used to be built from `GET /timesheets`, which hands anyone with reports:view (managers, team
 * leads, admins) every row in the workspace. So a manager's "Your logged hours" was the whole team's,
 * the "awaiting review" count was the team's queue, and the target meter read 600% on a Tuesday.
 * These tests pin the per-person rule and the shared definitions the cards now use.
 */
import { describe, expect, it } from "vitest";
import { periodNote, summarisePersonalPeriod, type PersonalRow } from "../../src/lib/personal-period";

const ME = "user-me";
const COLLEAGUE = "user-colleague";

function row(over: Partial<PersonalRow> & { workDate: string; totalHours: number }): PersonalRow {
  return {
    id: `${over.userId ?? ME}-${over.workDate}-${over.status ?? "APPROVED"}-${over.totalHours}`,
    startTime: "09:00",
    status: "APPROVED",
    userId: ME,
    project: { id: "p1", code: "APL", name: "Apollo" },
    ...over
  };
}

/** Thursday 1 October 2026, mid-afternoon. The week runs Mon 28 Sep → Sun 4 Oct. */
const TODAY = new Date(2026, 9, 1, 15, 0);

describe("whose hours", () => {
  it("counts only the signed-in person's rows, even when the list holds a manager's whole team", () => {
    const period = summarisePersonalPeriod({
      rows: [
        row({ workDate: "2026-09-28", totalHours: 8 }),
        row({ workDate: "2026-09-28", totalHours: 6, userId: COLLEAGUE }),
        row({ workDate: "2026-09-29", totalHours: 7, userId: COLLEAGUE, status: "SUBMITTED" }),
        // A row that only names its author through the nested `user` still belongs to them.
        row({ workDate: "2026-09-29", totalHours: 5, userId: undefined, user: { id: COLLEAGUE, name: "Ben" } })
      ],
      from: "2026-09-28",
      to: "2026-10-01",
      userId: ME,
      today: TODAY
    });

    expect(period.loggedHours).toBe(8);
    expect(period.pendingCount).toBe(0);
    expect(period.trend.reduce((sum, b) => sum + b.hours, 0)).toBe(8);
    expect(period.rangeProjects).toEqual([{ label: "APL", hours: 8 }]);
    expect([...period.entriesByDate.values()].flat().every((r) => r.userId === ME)).toBe(true);
  });
});

describe("what counts as logged", () => {
  it("is SUBMITTED + APPROVED; drafts and rejected hours are shown by state but never counted", () => {
    const period = summarisePersonalPeriod({
      rows: [
        row({ workDate: "2026-09-28", totalHours: 4, status: "APPROVED" }),
        row({ workDate: "2026-09-29", totalHours: 2, status: "SUBMITTED" }),
        row({ workDate: "2026-09-30", totalHours: 3, status: "DRAFT" }),
        row({ workDate: "2026-09-30", totalHours: 1, status: "REJECTED" })
      ],
      from: "2026-09-28",
      to: "2026-10-01",
      userId: ME,
      today: TODAY
    });

    expect(period.loggedHours).toBe(6);
    expect(period.byStatus).toEqual({ APPROVED: 4, SUBMITTED: 2, DRAFT: 3, REJECTED: 1 });
    expect(period.pendingCount).toBe(1);
    // A day carrying only a draft and a rejected entry is not a day logged.
    expect(period.daysLogged).toBe(2);
    expect(period.trend.map((b) => b.hours)).toEqual([4, 2, 0, 0]);
  });
});

describe("the target", () => {
  it("counts working days up to today, not the days of the range still to come", () => {
    const period = summarisePersonalPeriod({
      rows: [],
      from: "2026-09-28",
      to: "2026-10-04",
      userId: ME,
      today: TODAY
    });
    // Mon–Thu so far. Friday has not happened; counting it would make Thursday look 20% behind.
    expect(period.workingDaysToDate).toBe(4);
  });

  it("is the whole range's working days when the range is in the past", () => {
    const period = summarisePersonalPeriod({ rows: [], from: "2026-09-14", to: "2026-09-27", userId: ME, today: TODAY });
    expect(period.workingDaysToDate).toBe(10);
  });

  it("counts the workspace's own working days, so a six-day week counts its Saturdays", () => {
    // Planning settings → working days (0 = Sunday … 6 = Saturday), the set the server's utilisation
    // uses. Mon 21 Sep – Thu 1 Oct to date holds nine weekdays and one Saturday (the 26th).
    const sixDay = summarisePersonalPeriod({ rows: [], from: "2026-09-21", to: "2026-10-04", userId: ME, today: TODAY, workingDays: [1, 2, 3, 4, 5, 6] });
    expect(sixDay.workingDaysToDate).toBe(10);
    // Without settings (still loading, or an older server) it is Monday to Friday, as before.
    const fallback = summarisePersonalPeriod({ rows: [], from: "2026-09-21", to: "2026-10-04", userId: ME, today: TODAY });
    expect(fallback.workingDaysToDate).toBe(9);
  });
});

describe("the comparison", () => {
  it("is the same weekdays last week, not the days just before (which would straddle a weekend)", () => {
    const period = summarisePersonalPeriod({ rows: [], from: "2026-09-28", to: "2026-10-01", userId: ME, today: TODAY });
    expect(period.comparison).toEqual({ from: "2026-09-21", to: "2026-09-24", label: "vs the same days last week" });
  });

  it("shifts by whole weeks for a longer range, so the weekday mix still matches", () => {
    const period = summarisePersonalPeriod({ rows: [], from: "2026-09-01", to: "2026-09-30", userId: ME, today: TODAY });
    expect(period.comparison).toEqual({ from: "2026-07-28", to: "2026-08-26", label: "vs the same days 5 weeks earlier" });
  });

  it("names a single day's comparison", () => {
    const period = summarisePersonalPeriod({ rows: [], from: "2026-10-01", to: "2026-10-01", userId: ME, today: TODAY });
    expect(period.comparison.label).toBe("vs the same day last week");
  });

  it("reads the previous hours from the previous window's own rows, logged statuses only", () => {
    const period = summarisePersonalPeriod({
      rows: [row({ workDate: "2026-09-28", totalHours: 8 })],
      prevRows: [
        row({ workDate: "2026-09-21", totalHours: 5 }),
        row({ workDate: "2026-09-22", totalHours: 2, status: "DRAFT" }),
        row({ workDate: "2026-09-22", totalHours: 9, userId: COLLEAGUE })
      ],
      from: "2026-09-28",
      to: "2026-10-01",
      userId: ME,
      today: TODAY
    });
    expect(period.prevLoggedHours).toBe(5);
  });

  it("is null — not zero — while the previous window has not been loaded", () => {
    const period = summarisePersonalPeriod({ rows: [], from: "2026-09-28", to: "2026-10-01", userId: ME, today: TODAY });
    expect(period.prevLoggedHours).toBeNull();
  });
});

describe("the by-state card's sentence", () => {
  it("says a period of only drafts is drafts, not that nothing was logged", () => {
    expect(periodNote(0, 0, { DRAFT: 6, APPROVED: 0, SUBMITTED: 0, REJECTED: 0 }, "this week")).toMatch(/still a draft/);
    expect(periodNote(0, 0, { DRAFT: 0, APPROVED: 0, SUBMITTED: 0, REJECTED: 0 }, "this week")).toMatch(/^No hours logged this week/);
  });

  it("reads the approved share against logged hours", () => {
    expect(periodNote(8, 0, { APPROVED: 6, SUBMITTED: 2, DRAFT: 5, REJECTED: 0 }, "this week")).toBe("75% of these hours are approved.");
    expect(periodNote(8, 0, { APPROVED: 8, SUBMITTED: 0, DRAFT: 5, REJECTED: 0 }, "this week")).toMatch(/^Every logged hour this week is approved/);
  });
});
