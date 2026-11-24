import { describe, expect, it } from "vitest";
import { buildMonthGrid, monthBounds, shiftMonth, weekDays } from "../../src/lib/attendance-calendar";
import { dayAriaLabel, durationText, legendFor, minutesLate, STATUS_META, statusKeyFor } from "../../src/lib/attendance-status";

describe("statusKeyFor", () => {
  const punch = new Date(2026, 10, 12, 10, 15).toISOString();
  it("maps the server statuses one to one", () => {
    for (const s of ["PRESENT", "ABSENT", "LEAVE", "HOLIDAY", "WEEKEND", "PENDING"] as const) expect(statusKeyFor({ status: s })).toBe(s);
  });
  it("only calls a present day LATE when lateness is on and the punch was after the expected start", () => {
    expect(statusKeyFor({ status: "PRESENT", punchInAt: punch, latenessEnabled: false, expectedStartMinute: 570 })).toBe("PRESENT");
    expect(statusKeyFor({ status: "PRESENT", punchInAt: punch, latenessEnabled: true, expectedStartMinute: 570 })).toBe("LATE");
    expect(statusKeyFor({ status: "PRESENT", punchInAt: punch, latenessEnabled: true, expectedStartMinute: 660 })).toBe("PRESENT");
    expect(statusKeyFor({ status: "ABSENT", latenessEnabled: true, expectedStartMinute: 570 })).toBe("ABSENT");
  });
  it("measures minutes late and never goes negative", () => {
    expect(minutesLate(punch, 570)).toBe(45);
    expect(minutesLate(punch, 700)).toBe(0);
    expect(minutesLate(null, 570)).toBe(0);
  });
});

describe("every status has colour class, icon and word", () => {
  it("is complete and distinct", () => {
    const metas = Object.values(STATUS_META);
    expect(metas).toHaveLength(7);
    for (const m of metas) {
      expect(m.label.length).toBeGreaterThan(2);
      expect(m.icon).toBeTruthy();
      expect(m.className).toMatch(/^status-/);
    }
    expect(new Set(metas.map((m) => m.letter)).size).toBe(7);
  });
});

describe("dayAriaLabel", () => {
  it("names the day, the status and the punch or holiday", () => {
    const punch = new Date(2026, 10, 12, 9, 42).toISOString();
    expect(dayAriaLabel({ date: "2026-11-12", status: "PRESENT", punchInAt: punch }, STATUS_META.PRESENT)).toMatch(/^12 Nov, Present, in 0?9[:.]42/);
    expect(dayAriaLabel({ date: "2026-12-25", status: "HOLIDAY", holidayName: "Christmas" }, STATUS_META.HOLIDAY)).toBe("25 Dec, Holiday, Christmas");
  });
});

describe("legendFor", () => {
  it("shows Late and On leave only when those features are on", () => {
    expect(legendFor({ latenessEnabled: false, leaveEnabled: false }).map((m) => m.key)).toEqual(["PRESENT", "ABSENT", "HOLIDAY", "WEEKEND", "PENDING"]);
    expect(legendFor({ latenessEnabled: true, leaveEnabled: true }).map((m) => m.key)).toEqual(["PRESENT", "LATE", "ABSENT", "LEAVE", "HOLIDAY", "WEEKEND", "PENDING"]);
  });
});

describe("durationText", () => {
  it("reads hours and minutes", () => {
    expect(durationText(459)).toBe("7h 39m");
    expect(durationText(5)).toBe("5m");
    expect(durationText(-3)).toBe("0m");
  });
});

describe("month grid", () => {
  it("covers November 2026 in Monday-first weeks of seven", () => {
    const grid = buildMonthGrid("2026-11", "2026-11-23", (d) => (d === "2026-11-12" ? "x" : null));
    expect(grid.every((row) => row.length === 7)).toBe(true);
    expect(grid[0][0].date).toBe("2026-10-26");
    expect(grid[0][6].date).toBe("2026-11-01");
    expect(grid.at(-1)!.at(-1)!.date).toBe("2026-12-06");
    const flat = grid.flat();
    expect(flat.filter((c) => c.inMonth)).toHaveLength(30);
    expect(flat.find((c) => c.isToday)!.date).toBe("2026-11-23");
    expect(flat.find((c) => c.date === "2026-11-12")!.data).toBe("x");
    expect(flat.find((c) => c.date === "2026-10-26")!.data).toBeNull();
  });
  it("handles a month that starts on Monday and ends on Sunday without padding", () => {
    const grid = buildMonthGrid("2026-06", "2026-06-01", () => null);
    expect(grid[0][0].date).toBe("2026-06-01");
    expect(grid).toHaveLength(5);
    expect(grid.at(-1)!.at(-1)!.date).toBe("2026-07-05");
  });
  it("shifts months across a year and bounds them", () => {
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(monthBounds("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
  });
  it("gives the week containing a day, Monday first", () => {
    expect(weekDays("2026-11-26")[0]).toBe("2026-11-23");
    expect(weekDays("2026-11-26")[6]).toBe("2026-11-29");
  });
});
