/**
 * 7.0.0 shifts — the pure half: midnight crossing, work date = shift start date, the shift-end
 * absent cutoff in the person's own zone, assignment precedence, and shift-aware lateness.
 */
import { describe, expect, it } from "vitest";
import {
  resolveDayStatus,
  shiftCrossesMidnight,
  shiftEndUtc,
  shiftExpectedMinutes,
  workDateKeyFor,
  type DayStatusInput,
  type ShiftWindow
} from "../../src/services/attendance-day-status.js";
import { pickAssignment, shiftBody, shiftAssignmentBody } from "../../src/services/attendance-shift.service.js";
import { countLate } from "../../src/services/attendance-team.service.js";

const night: ShiftWindow = { startMinute: 22 * 60, endMinute: 6 * 60, breakMinutes: 30, workingDays: [1, 2, 3, 4, 5] };
const day: ShiftWindow = { startMinute: 9 * 60, endMinute: 17 * 60 + 30, breakMinutes: 60, workingDays: [0, 1, 2, 3, 4] };

const base: DayStatusInput = {
  dateKey: "2026-11-23", // Monday
  workingDays: [1, 2, 3, 4, 5],
  holiday: null,
  leave: null,
  punchedIn: false,
  now: new Date("2026-11-23T10:00:00Z"),
  timeZone: "UTC"
};

describe("shift arithmetic", () => {
  it("knows a night shift crosses midnight and computes paid minutes", () => {
    expect(shiftCrossesMidnight(night)).toBe(true);
    expect(shiftCrossesMidnight(day)).toBe(false);
    expect(shiftExpectedMinutes(night)).toBe(8 * 60 - 30);
    expect(shiftExpectedMinutes(day)).toBe(8 * 60 + 30 - 60);
    expect(shiftExpectedMinutes({ startMinute: 60, endMinute: 90, breakMinutes: 600 })).toBe(0);
  });

  it("ends a night shift on the next calendar morning, in the person's zone", () => {
    expect(shiftEndUtc("2026-11-23", night, "Asia/Kolkata").toISOString()).toBe("2026-11-24T00:30:00.000Z");
    expect(shiftEndUtc("2026-11-23", day, "America/New_York").toISOString()).toBe("2026-11-23T22:30:00.000Z");
  });
});

describe("workDateKeyFor", () => {
  it("files an after-midnight punch on the night shift's START date", () => {
    // 02:00 IST on the 24th = 20:30Z on the 23rd.
    expect(workDateKeyFor(new Date("2026-11-23T20:30:00Z"), "Asia/Kolkata", null, night)).toBe("2026-11-23");
  });
  it("files an early arrival for tonight on tonight", () => {
    // 21:30 IST on the 23rd.
    expect(workDateKeyFor(new Date("2026-11-23T16:00:00Z"), "Asia/Kolkata", null, night)).toBe("2026-11-23");
  });
  it("splits mid-gap (14:00 for 22:00-06:00)", () => {
    expect(workDateKeyFor(new Date("2026-11-24T13:59:00Z"), "UTC", null, night)).toBe("2026-11-23");
    expect(workDateKeyFor(new Date("2026-11-24T14:00:00Z"), "UTC", null, night)).toBe("2026-11-24");
  });
  it("is the plain local day without a shift or with a day shift", () => {
    const t = new Date("2026-11-23T20:30:00Z");
    expect(workDateKeyFor(t, "Asia/Kolkata", null, null)).toBe("2026-11-24");
    expect(workDateKeyFor(t, "Asia/Kolkata", null, day)).toBe("2026-11-24");
  });
});

describe("resolveDayStatus with a shift", () => {
  it("uses the shift's working days instead of the workspace's", () => {
    expect(resolveDayStatus({ ...base, dateKey: "2026-11-22", shift: day }).status).not.toBe("WEEKEND"); // Sunday in shift
    expect(resolveDayStatus({ ...base, dateKey: "2026-11-27", shift: day }).status).toBe("WEEKEND"); // Friday off
  });
  it("keeps a night shift PENDING past midnight and ABSENT only once it has ended", () => {
    const s = { ...base, shift: night, timeZone: "UTC" };
    expect(resolveDayStatus({ ...s, now: new Date("2026-11-24T03:00:00Z") }).status).toBe("PENDING");
    expect(resolveDayStatus({ ...s, now: new Date("2026-11-24T06:00:00Z") }).status).toBe("ABSENT");
  });
  it("turns a day shift ABSENT after its end on the same day, not at midnight", () => {
    const s = { ...base, shift: day, timeZone: "America/New_York" };
    expect(resolveDayStatus({ ...s, now: new Date("2026-11-23T22:00:00Z") }).status).toBe("PENDING");
    expect(resolveDayStatus({ ...s, now: new Date("2026-11-23T22:31:00Z") }).status).toBe("ABSENT");
  });
  it("is unchanged without a shift", () => {
    expect(resolveDayStatus({ ...base, shift: null })).toEqual(resolveDayStatus(base));
  });
});

describe("pickAssignment", () => {
  const d = (k: string) => new Date(`${k}T00:00:00Z`);
  it("prefers the person's own assignment over the team's, then the latest", () => {
    const rows = [
      { id: "team-new", userId: null, managerId: "m", effectiveFrom: d("2026-11-20") },
      { id: "own-old", userId: "u", managerId: null, effectiveFrom: d("2026-01-01") },
      { id: "own-new", userId: "u", managerId: null, effectiveFrom: d("2026-06-01") }
    ];
    expect(pickAssignment(rows, "u")?.id).toBe("own-new");
    expect(pickAssignment(rows.slice(0, 1), "u")?.id).toBe("team-new");
    expect(pickAssignment([], "u")).toBeNull();
  });
});

describe("validation", () => {
  it("refuses a zero-length shift and out-of-range minutes", () => {
    expect(shiftBody.safeParse({ name: "x", startMinute: 60, endMinute: 60, workingDays: [1] }).success).toBe(false);
    expect(shiftBody.safeParse({ name: "x", startMinute: 1440, endMinute: 60, workingDays: [1] }).success).toBe(false);
    expect(shiftBody.safeParse({ name: "Night", startMinute: 1320, endMinute: 360, workingDays: [1] }).success).toBe(true);
  });
  it("needs exactly one of person or team, and an ordered range", () => {
    const ok = { shiftId: "s", effectiveFrom: "2026-11-01" };
    expect(shiftAssignmentBody.safeParse(ok).success).toBe(false);
    expect(shiftAssignmentBody.safeParse({ ...ok, userId: "u", managerId: "m" }).success).toBe(false);
    expect(shiftAssignmentBody.safeParse({ ...ok, userId: "u", effectiveTo: "2026-10-01" }).success).toBe(false);
    expect(shiftAssignmentBody.safeParse({ ...ok, managerId: "m" }).success).toBe(true);
  });
});

describe("countLate per shift", () => {
  const minuteUtc = (i: Date) => i.getUTCHours() * 60 + i.getUTCMinutes();
  const row = (id: string, iso: string) => ({ status: "PRESENT" as const, punch: { punchInAt: iso } as never, user: { id } as never });
  it("judges each person against their own start, including after-midnight night punches", () => {
    const starts: Record<string, number> = { n: 22 * 60, d: 9 * 60 };
    const rows = [row("n", "2026-11-24T00:30:00Z"), row("n2", "2026-11-23T21:50:00Z"), row("d", "2026-11-23T09:00:00Z")];
    starts.n2 = 22 * 60;
    expect(countLate(minuteUtc, rows, new Map(), (u) => starts[u])).toBe(1);
    expect(countLate(minuteUtc, [row("d", "2026-11-23T09:05:00Z")], new Map(), 540)).toBe(1);
  });
});
