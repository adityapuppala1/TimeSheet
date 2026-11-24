/**
 * V17 A2 — the day-status resolver. Pure, so every timezone edge is a plain assertion: the order
 * (weekend → holiday → leave → punched in → absent/pending) and, above all, that ABSENT is only
 * ever decided on the person's own clock after their day is over.
 */
import { describe, expect, it } from "vitest";
import { resolveDayStatus, todayKeyFor, weekdayOfDateKey, type DayStatusInput } from "../../src/services/attendance-day-status.js";

const base: DayStatusInput = {
  dateKey: "2026-11-23", // a Monday
  workingDays: [1, 2, 3, 4, 5],
  holiday: null,
  leave: null,
  punchedIn: false,
  now: new Date("2026-11-23T10:00:00Z"),
  timeZone: "UTC"
};

describe("weekdayOfDateKey", () => {
  it("reads the calendar day, independent of any zone", () => {
    expect(weekdayOfDateKey("2026-11-23")).toBe(1);
    expect(weekdayOfDateKey("2026-11-22")).toBe(0);
    expect(weekdayOfDateKey("2026-11-28")).toBe(6);
  });
});

describe("resolveDayStatus order", () => {
  it("weekend wins over everything, including a punch", () => {
    const r = resolveDayStatus({ ...base, dateKey: "2026-11-22", punchedIn: true, holiday: { name: "X" } });
    expect(r).toEqual({ status: "WEEKEND", isWorkingDay: false, holidayName: null });
  });
  it("honours a custom working week (Sun-Thu)", () => {
    expect(resolveDayStatus({ ...base, dateKey: "2026-11-22", workingDays: [0, 1, 2, 3, 4] }).status).not.toBe("WEEKEND");
    expect(resolveDayStatus({ ...base, dateKey: "2026-11-27", workingDays: [0, 1, 2, 3, 4] }).status).toBe("WEEKEND");
  });
  it("holiday wins over leave and punch", () => {
    const r = resolveDayStatus({ ...base, holiday: { name: "Diwali" }, leave: { type: "SICK" }, punchedIn: true });
    expect(r).toEqual({ status: "HOLIDAY", isWorkingDay: false, holidayName: "Diwali" });
  });
  it("leave wins over a punch", () => {
    expect(resolveDayStatus({ ...base, leave: { type: "PTO" }, punchedIn: true }).status).toBe("LEAVE");
  });
  it("a punch on a working day is PRESENT", () => {
    expect(resolveDayStatus({ ...base, punchedIn: true })).toEqual({ status: "PRESENT", isWorkingDay: true, holidayName: null });
  });
});

describe("ABSENT vs PENDING", () => {
  it("today without a punch is PENDING, never ABSENT", () => {
    expect(resolveDayStatus({ ...base, now: new Date("2026-11-23T23:59:59Z") }).status).toBe("PENDING");
  });
  it("a past working day without a punch is ABSENT", () => {
    expect(resolveDayStatus({ ...base, now: new Date("2026-11-24T00:00:00Z") }).status).toBe("ABSENT");
  });
  it("a future day is PENDING", () => {
    expect(resolveDayStatus({ ...base, dateKey: "2026-11-25" }).status).toBe("PENDING");
  });
  it("New York: Monday is still running at 03:00 UTC Tuesday", () => {
    const now = new Date("2026-11-24T03:00:00Z"); // 22:00 Mon in New York
    expect(resolveDayStatus({ ...base, now, timeZone: "America/New_York" }).status).toBe("PENDING");
    // ...but on the UTC clock the same instant has already ended Monday.
    expect(resolveDayStatus({ ...base, now, timeZone: "UTC" }).status).toBe("ABSENT");
  });
  it("Kolkata: Monday is over at 18:30 UTC Monday (midnight IST)", () => {
    expect(resolveDayStatus({ ...base, now: new Date("2026-11-23T18:29:00Z"), timeZone: "Asia/Kolkata" }).status).toBe("PENDING");
    expect(resolveDayStatus({ ...base, now: new Date("2026-11-23T18:30:00Z"), timeZone: "Asia/Kolkata" }).status).toBe("ABSENT");
  });
  it("Pacific/Kiritimati (UTC+14) finishes its day before UTC does", () => {
    expect(resolveDayStatus({ ...base, now: new Date("2026-11-23T10:00:00Z"), timeZone: "Pacific/Kiritimati" }).status).toBe("ABSENT");
  });
  it("an invalid zone falls back to the workspace zone", () => {
    const now = new Date("2026-11-24T03:00:00Z");
    expect(resolveDayStatus({ ...base, now, timeZone: "Not/AZone", fallbackZone: "America/New_York" }).status).toBe("PENDING");
  });
  it("DST end in New York does not shift the day", () => {
    // 2026-11-01 01:30 happens twice in New York; both are still Sunday Nov 1 locally.
    expect(todayKeyFor(new Date("2026-11-01T05:30:00Z"), "America/New_York")).toBe("2026-11-01");
    expect(todayKeyFor(new Date("2026-11-01T06:30:00Z"), "America/New_York")).toBe("2026-11-01");
    expect(todayKeyFor(new Date("2026-11-02T04:59:00Z"), "America/New_York")).toBe("2026-11-01");
    expect(todayKeyFor(new Date("2026-11-02T05:00:00Z"), "America/New_York")).toBe("2026-11-02");
  });
});
