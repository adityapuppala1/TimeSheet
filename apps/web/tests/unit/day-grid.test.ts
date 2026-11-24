/**
 * 7.0.0 — leave, holidays and attendance on the Home "Daily logging status" grid, the timeline
 * lane labels and the Reports "Attendance & leave" summary.
 *
 * Under test: the cell-state mapping, the gap / plan arithmetic (leave and holidays are not owed;
 * a half day plans 4h), the lane labels, and the module-off guarantee — with no day-status lookup
 * the grid renders byte-for-byte what it rendered before 7.0.0 (the snapshot was recorded from the
 * 6.5.0 component), and the Reports section renders nothing at all.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { DayFillGrid, type FillRow } from "../../src/components/DayFillGrid";
import { AttendanceLeaveSummary, attendanceSummaryCsv } from "../../src/components/AttendanceLeaveSummary";
import { clampGridRange, dayNote, dayStatusLookup, gridCellState, isAbsentMarker, laneLabel, tallyPerson } from "../../src/lib/day-grid";
import type { DayGridDay, DayGridResponse } from "../../src/services/attendance-api";
import { localDateKey } from "../../src/lib/local-day";

const work = { expected: true, upcoming: false };
const weekend = { expected: false, upcoming: false };
const future = { expected: true, upcoming: true };

describe("gridCellState", () => {
  it("anything logged is filled, whatever the day was", () => {
    expect(gridCellState(work, 2, { status: "LEAVE", leaveTypeCode: "PL" })).toBe("filled");
    expect(gridCellState(work, 1, { status: "HOLIDAY", holidayName: "Diwali" })).toBe("filled");
  });
  it("leave and holiday win over missing, off and upcoming", () => {
    expect(gridCellState(work, 0, { status: "LEAVE" })).toBe("leave");
    expect(gridCellState(future, 0, { status: "LEAVE" })).toBe("leave");
    expect(gridCellState(work, 0, { status: "HOLIDAY" })).toBe("holiday");
  });
  it("without a day status it is exactly the old mapping", () => {
    expect(gridCellState(work, 0)).toBe("missing");
    expect(gridCellState(weekend, 0)).toBe("off");
    expect(gridCellState(future, 0)).toBe("upcoming");
    expect(gridCellState(work, 0, { status: "ABSENT" })).toBe("missing");
  });
  it("the absent marker needs attendance on, a missed day and ABSENT", () => {
    const on = { attendanceEnabled: true, get: () => undefined };
    const off = { attendanceEnabled: false, get: () => undefined };
    expect(isAbsentMarker("missing", { status: "ABSENT" }, on)).toBe(true);
    expect(isAbsentMarker("missing", { status: "ABSENT" }, off)).toBe(false);
    expect(isAbsentMarker("missing", { status: "PENDING" }, on)).toBe(false);
    expect(isAbsentMarker("filled", { status: "ABSENT" }, on)).toBe(false);
    expect(isAbsentMarker("missing", { status: "ABSENT" }, undefined)).toBe(false);
  });
});

describe("tallyPerson — gaps and plan", () => {
  const cols = [
    { key: "d1", expected: true, upcoming: false },
    { key: "d2", expected: true, upcoming: false },
    { key: "d3", expected: true, upcoming: false },
    { key: "d4", expected: true, upcoming: false },
    { key: "d5", expected: false, upcoming: false },
    { key: "d6", expected: true, upcoming: true }
  ];
  const days: Record<string, DayGridDay> = {
    d2: { status: "LEAVE", leaveTypeCode: "PL" },
    d3: { status: "HOLIDAY", holidayName: "Diwali" },
    d4: { status: "ABSENT", halfDay: "FIRST_HALF", leaveTypeCode: "CL" }
  };

  it("leave and holiday days are neither gaps nor plan; a half day plans half", () => {
    const t = tallyPerson(cols, () => 0, (k) => days[k], 8);
    expect(t).toEqual({ filledDays: 0, expectedDays: 2, gapDays: 2, plannedHours: 12, offDays: 2 });
  });
  it("logging on a holiday still counts as filled but does not add a day owed", () => {
    const t = tallyPerson(cols, (k) => (k === "d3" ? 1 : 0), (k) => days[k], 8);
    expect(t.filledDays).toBe(1);
    expect(t.expectedDays).toBe(2);
  });
  it("without day statuses: the pre-7.0.0 arithmetic", () => {
    const t = tallyPerson(cols, (k) => (k === "d1" ? 1 : 0), () => undefined, 8);
    expect(t).toEqual({ filledDays: 1, expectedDays: 4, gapDays: 3, plannedHours: 32, offDays: 0 });
  });
});

describe("words", () => {
  it("popover notes", () => {
    expect(dayNote({ status: "LEAVE", leaveTypeCode: "PL", leaveTypeName: "Privilege leave" }, false, false)).toBe("On leave · Privilege leave (PL).");
    expect(dayNote({ status: "HOLIDAY", holidayName: "Diwali" }, false, true)).toBe("Holiday · Diwali. Time was still logged on this day.");
    expect(dayNote({ status: "PRESENT", halfDay: "SECOND_HALF", leaveTypeCode: "CL" }, false, false)).toBe("Half-day leave · CL, second half.");
    expect(dayNote({ status: "ABSENT" }, true, false)).toBe("Did not punch in.");
    expect(dayNote(undefined, false, false)).toBe("");
  });
  it("lane labels", () => {
    expect(laneLabel({ status: "LEAVE", leaveTypeCode: "PL" }, true)).toBe("On leave · PL");
    expect(laneLabel({ status: "HOLIDAY", holidayName: "Diwali" }, true)).toBe("Holiday · Diwali");
    expect(laneLabel({ status: "ABSENT" }, true)).toBe("Not punched in");
    expect(laneLabel({ status: "ABSENT" }, false)).toBeNull();
    expect(laneLabel({ status: "PRESENT" }, true)).toBeNull();
  });
  it("clamps a long dashboard range to the newest 93 days", () => {
    expect(clampGridRange("2026-01-01", "2026-11-24")).toEqual({ from: "2026-08-24", to: "2026-11-24" });
    expect(clampGridRange("2026-11-01", "2026-11-24")).toEqual({ from: "2026-11-01", to: "2026-11-24" });
  });
});

/* -------------------------------- rendering -------------------------------- */

const roster = [
  { id: "u1", name: "Asha", managerId: "m1", managerName: "Mona" },
  { id: "u2", name: "Bilal", managerId: "m1", managerName: "Mona" },
  { id: "u3", name: "Chen", managerId: "m1", managerName: "Mona" },
  { id: "u4", name: "Dara", managerId: "m2", managerName: "Omar" }
];
const rows: FillRow[] = [
  { id: "e1", workDate: "2026-11-16", startTime: "09:00", endTime: "12:00", totalHours: 3, status: "SUBMITTED", project: { name: "Apollo" }, user: { id: "u1", name: "Asha" } },
  { id: "e2", workDate: "2026-11-18", startTime: "09:00", endTime: "11:00", totalHours: 2, status: "DRAFT", project: { name: "Apollo" }, user: { id: "u2", name: "Bilal" } }
];
const gridProps = { rows, roster, rangeFrom: "2026-11-16", rangeTo: "2026-11-22", todayKey: "2026-11-24", workingDays: [1, 2, 3, 4, 5], loading: false, groupable: true };

describe("DayFillGrid", () => {
  it("module off: renders byte-for-byte what 6.5.0 rendered", () => {
    // The grid formats dates in the runner's default locale; pin it so the snapshot is the same
    // on an en-GB laptop and an en-US CI runner.
    const real = Date.prototype.toLocaleDateString;
    const spy = vi.spyOn(Date.prototype, "toLocaleDateString").mockImplementation(function (this: Date, locale, opts) {
      return real.call(this, locale ?? "en-GB", opts);
    });
    try {
      expect(renderToStaticMarkup(createElement(DayFillGrid, gridProps))).toMatchSnapshot();
    } finally {
      spy.mockRestore();
    }
  });

  it("module on: leave and holiday cells, the absent marker and the team-row leave note", () => {
    const res: DayGridResponse = {
      enabled: true,
      attendanceEnabled: true,
      leaveEnabled: true,
      from: "2026-11-16",
      to: "2026-11-22",
      leaveTypes: [{ code: "PL", name: "Privilege leave" }],
      people: [
        { userId: "u1", name: "Asha", days: { "2026-11-17": { status: "LEAVE", leaveTypeCode: "PL", leaveTypeName: "Privilege leave" } }, summary: { workingDays: 5, holidays: 0, leaveDays: { PL: 1 }, presentDays: 0, absentDays: 0, loggedHours: 3 } },
        { userId: "u3", name: "Chen", days: { "2026-11-16": { status: "ABSENT" }, "2026-11-19": { status: "HOLIDAY", holidayName: "Diwali" } }, summary: { workingDays: 4, holidays: 1, leaveDays: {}, presentDays: 0, absentDays: 1, loggedHours: 0 } }
      ]
    };
    const html = renderToStaticMarkup(createElement(DayFillGrid, { ...gridProps, dayStatus: dayStatusLookup(res) }));
    expect(html).toContain('data-state-kind="leave"');
    expect(html).toContain('data-state-kind="holiday"');
    expect(html).toContain("status-leave");
    expect(html).toContain("status-holiday");
    expect(html).toContain("On leave · Privilege leave (PL).");
    expect(html).toContain("Holiday · Diwali.");
    expect(html).toContain("Did not punch in.");
    // Tuesday: Asha on leave → 0 of the 2 owed, "· 1 on leave".
    expect(html).toContain("0 of 2 logged on");
    expect(html).toContain("· 1 on leave");
    expect(html).toContain("Leave and holidays are not gaps");
  });

  it("a lookup that knows nothing changes no cell", () => {
    const html = renderToStaticMarkup(createElement(DayFillGrid, { ...gridProps, dayStatus: { attendanceEnabled: false, get: () => undefined } }));
    expect(html).not.toContain('data-state-kind="leave"');
    expect(html).not.toContain('data-state-kind="holiday"');
  });
});

describe("Reports: Attendance & leave", () => {
  const now = new Date();
  const from = localDateKey(new Date(now.getFullYear(), now.getMonth(), 1));
  const to = localDateKey(now);
  const render = (data: DayGridResponse) => {
    const client = new QueryClient();
    client.setQueryData(["attendance", "day-grid", from, to], data);
    return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(AttendanceLeaveSummary)));
  };

  it("renders nothing with the module off", () => {
    expect(render({ enabled: false })).toBe("");
  });

  it("renders per person and exports CSV with one column per leave type", () => {
    const data: DayGridResponse = {
      enabled: true,
      attendanceEnabled: true,
      leaveEnabled: true,
      from,
      to,
      leaveTypes: [{ code: "PL", name: "Privilege leave" }],
      people: [{ userId: "u1", name: "=Asha", days: {}, summary: { workingDays: 20, holidays: 1, leaveDays: { PL: 1.5 }, presentDays: 17, absentDays: 1, loggedHours: 140 } }]
    };
    expect(render(data)).toContain("Attendance &amp; leave");
    const csv = attendanceSummaryCsv(data);
    expect(csv.split("\r\n")[0]).toBe("Person,Working days,Holidays,Leave: Privilege leave (PL),Leave days (total),Present days,Absent days,Logged hours");
    // Formula-looking names are defused by lib/csv-export.
    expect(csv.split("\r\n")[1]).toBe("'=Asha,20,1,1.5,1.5,17,1,140");
  });
});

describe("dayOffWeight", () => {
  it("holiday and full leave are a whole day off, half-day leave half, anything else none", async () => {
    const { dayOffWeight } = await import("../../src/lib/day-grid");
    expect(dayOffWeight({ status: "HOLIDAY" })).toBe(1);
    expect(dayOffWeight({ status: "LEAVE" })).toBe(1);
    expect(dayOffWeight({ status: "LEAVE", halfDay: "FIRST_HALF" })).toBe(0.5);
    expect(dayOffWeight({ status: "ABSENT" })).toBe(0);
    expect(dayOffWeight(undefined)).toBe(0);
  });
});
