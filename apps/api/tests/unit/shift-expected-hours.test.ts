/**
 * 7.0.0: expected hours follow the person's shift (digest, leave preview, capacity board all read
 * leave-capacity.service.ts#expectedHoursFor). No shift = the workspace week, unchanged.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ users: [] as unknown[], assignments: [] as unknown[] }));

vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    user: { findMany: vi.fn(async () => db.users) },
    attendanceShiftAssignment: { findMany: vi.fn(async () => db.assignments) }
  }
}));
vi.mock("../../src/services/planning.service.js", () => ({
  getPlanningSettings: vi.fn(async () => ({ workingDays: [1, 2, 3, 4, 5], defaultWeeklyCapacityHours: 40 }))
}));
vi.mock("../../src/services/attendance-team.service.js", () => ({
  loadHolidays: vi.fn(async () => (_cal: string | null, d: string) => (d === "2026-11-25" ? { name: "Holiday" } : null))
}));
vi.mock("../../src/services/leave-query.service.js", () => ({
  loadApprovedLeave: vi.fn(async () => new Map()),
  leaveFractionOf: () => 0
}));

import { expectedHours } from "../../src/services/leave-calc.js";
import { expectedHoursFor } from "../../src/services/leave-capacity.service.js";

const MON_FRI = [1, 2, 3, 4, 5];
// 4-day week, 10h shifts with no break: 07:00-17:00, Mon-Thu.
const fourTens = { id: "s1", name: "4x10", startMinute: 420, endMinute: 1020, breakMinutes: 0, workingDays: [1, 2, 3, 4] };

describe("expectedHours with a shift (pure)", () => {
  it("is unchanged when no shiftOn is given or it returns null", () => {
    const base = { from: "2026-11-23", to: "2026-11-29", workingDays: MON_FRI, isHoliday: () => false, leaveFraction: () => 0, weeklyCapacityHours: 40 };
    expect(expectedHours(base)).toEqual(expectedHours({ ...base, shiftOn: () => null }));
    expect(expectedHours(base).expectedHours).toBe(40);
  });

  it("uses the shift's working days and minutes per day", () => {
    const r = expectedHours({
      from: "2026-11-23",
      to: "2026-11-29",
      workingDays: MON_FRI,
      isHoliday: () => false,
      leaveFraction: (d) => (d === "2026-11-24" ? 0.5 : 0),
      weeklyCapacityHours: 40,
      shiftOn: () => ({ workingDays: [1, 2, 3, 4], expectedMinutes: 600 })
    });
    expect(r).toMatchObject({ workingDays: 4, leaveDays: 0.5, dailyHours: 10, expectedHours: 35 });
  });

  it("mixes shifted and workspace days when an assignment starts mid-range", () => {
    const r = expectedHours({
      from: "2026-11-23",
      to: "2026-11-27",
      workingDays: MON_FRI,
      isHoliday: () => false,
      leaveFraction: () => 0,
      weeklyCapacityHours: 40,
      shiftOn: (d) => (d >= "2026-11-26" ? { workingDays: [4], expectedMinutes: 360 } : null)
    });
    // Mon-Wed workspace (3 × 8) + Thu shift (6) + Fri not a shift day.
    expect(r.workingDays).toBe(4);
    expect(r.expectedHours).toBe(30);
  });
});

describe("expectedHoursFor", () => {
  beforeEach(() => {
    db.users = [
      { id: "u1", managerId: null, holidayCalendarId: null, weeklyCapacityHours: null },
      { id: "u2", managerId: "m1", holidayCalendarId: null, weeklyCapacityHours: null },
      { id: "u3", managerId: null, holidayCalendarId: null, weeklyCapacityHours: 30 }
    ];
    db.assignments = [];
  });

  it("keeps the workspace week for everyone when no shift exists", async () => {
    const m = await expectedHoursFor(["u1", "u3"], "2026-11-23", "2026-11-27");
    expect(m.get("u1")?.expectedHours).toBe(32); // 4 days (Wed holiday) × 8
    expect(m.get("u3")?.expectedHours).toBe(24);
  });

  it("follows a personal shift and a team shift; a holiday on a shift day still costs the day", async () => {
    db.assignments = [
      { userId: "u1", managerId: null, effectiveFrom: new Date("2026-11-01T00:00:00Z"), effectiveTo: null, shift: fourTens },
      { userId: null, managerId: "m1", effectiveFrom: new Date("2026-11-01T00:00:00Z"), effectiveTo: null, shift: { ...fourTens, id: "s2", breakMinutes: 120 } }
    ];
    const m = await expectedHoursFor(["u1", "u2", "u3"], "2026-11-23", "2026-11-29");
    expect(m.get("u1")?.expectedHours).toBe(30); // Mon, Tue, Thu × 10 (Wed holiday)
    expect(m.get("u2")?.expectedHours).toBe(24); // × 8
    expect(m.get("u3")?.expectedHours).toBe(24); // no shift: workspace
  });

  it("stops following a shift after its effectiveTo", async () => {
    db.assignments = [{ userId: "u1", managerId: null, effectiveFrom: new Date("2026-11-01T00:00:00Z"), effectiveTo: new Date("2026-11-24T00:00:00Z"), shift: fourTens }];
    const m = await expectedHoursFor(["u1"], "2026-11-23", "2026-11-27");
    // Mon+Tue shift (20) + Wed holiday + Thu+Fri workspace (16).
    expect(m.get("u1")?.expectedHours).toBe(36);
  });
});
