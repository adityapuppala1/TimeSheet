/**
 * V17 Phase B — the pure arithmetic of leave (services/leave-calc.ts) and the half-day branch of the
 * day-status resolver. No database: every number a person might dispute is pinned here.
 */
import { describe, expect, it } from "vitest";
import {
  accrualDueThrough,
  accrualSchedule,
  availableBalance,
  countLeaveDays,
  dayPortions,
  expectedHours,
  findClash,
  leaveYearBounds,
  leaveYearOf,
  mergePortions,
  monthIndexInLeaveYear,
  portionsClash,
  rolloverDeltas,
  spanErrors,
  type LeaveSpan
} from "../../src/services/leave-calc.js";
import { resolveDayStatus } from "../../src/services/attendance-day-status.js";
import { mergedTimeOffHours } from "../../src/services/leave-capacity.service.js";
import { buildWorkload, buildBuckets } from "../../src/services/workload.service.js";

const MON_FRI = [1, 2, 3, 4, 5];
const noHoliday = () => false;
const span = (startDate: string, endDate: string, startHalf: LeaveSpan["startHalf"] = "FULL", endHalf: LeaveSpan["endHalf"] = "FULL"): LeaveSpan => ({
  startDate,
  endDate,
  startHalf,
  endHalf
});

// 2026-11-23 is a Monday.
describe("countLeaveDays", () => {
  it("counts a working week as 5", () => {
    expect(countLeaveDays(span("2026-11-23", "2026-11-27"), { workingDays: MON_FRI, isHoliday: noHoliday })).toBe(5);
  });

  it("skips weekends inside the span", () => {
    expect(countLeaveDays(span("2026-11-27", "2026-11-30"), { workingDays: MON_FRI, isHoliday: noHoliday })).toBe(2);
  });

  it("skips the person's holidays", () => {
    const isHoliday = (d: string) => d === "2026-11-25";
    expect(countLeaveDays(span("2026-11-23", "2026-11-27"), { workingDays: MON_FRI, isHoliday })).toBe(4);
  });

  it("counts a single half day as 0.5, either half", () => {
    expect(countLeaveDays(span("2026-11-23", "2026-11-23", "FIRST_HALF", "FIRST_HALF"), { workingDays: MON_FRI, isHoliday: noHoliday })).toBe(0.5);
    expect(countLeaveDays(span("2026-11-23", "2026-11-23", "SECOND_HALF", "SECOND_HALF"), { workingDays: MON_FRI, isHoliday: noHoliday })).toBe(0.5);
  });

  it("counts a half at both ends: Mon afternoon to Wed morning = 2", () => {
    expect(countLeaveDays(span("2026-11-23", "2026-11-25", "SECOND_HALF", "FIRST_HALF"), { workingDays: MON_FRI, isHoliday: noHoliday })).toBe(2);
  });

  it("a half day that falls on a weekend or holiday costs nothing", () => {
    expect(countLeaveDays(span("2026-11-28", "2026-11-28", "FIRST_HALF", "FIRST_HALF"), { workingDays: MON_FRI, isHoliday: noHoliday })).toBe(0);
    expect(
      countLeaveDays(span("2026-11-21", "2026-11-23", "SECOND_HALF", "FIRST_HALF"), { workingDays: MON_FRI, isHoliday: (d) => d === "2026-11-23" })
    ).toBe(0);
  });

  it("honours a six-day working week", () => {
    expect(countLeaveDays(span("2026-11-23", "2026-11-29"), { workingDays: [1, 2, 3, 4, 5, 6], isHoliday: noHoliday })).toBe(6);
  });

  it("is 0 when the end is before the start", () => {
    expect(countLeaveDays(span("2026-11-25", "2026-11-23"), { workingDays: MON_FRI, isHoliday: noHoliday })).toBe(0);
  });
});

describe("spanErrors", () => {
  it("accepts the legal shapes", () => {
    expect(spanErrors(span("2026-11-23", "2026-11-23"))).toEqual([]);
    expect(spanErrors(span("2026-11-23", "2026-11-23", "FIRST_HALF", "FIRST_HALF"))).toEqual([]);
    expect(spanErrors(span("2026-11-23", "2026-11-25", "SECOND_HALF", "FIRST_HALF"))).toEqual([]);
  });

  it("refuses a multi-day span starting FIRST_HALF or ending SECOND_HALF (a hole in the middle)", () => {
    expect(spanErrors(span("2026-11-23", "2026-11-25", "FIRST_HALF", "FULL"))).toHaveLength(1);
    expect(spanErrors(span("2026-11-23", "2026-11-25", "FULL", "SECOND_HALF"))).toHaveLength(1);
  });

  it("refuses mismatched halves on one day, reversed dates and halves on a no-half type", () => {
    expect(spanErrors(span("2026-11-23", "2026-11-23", "FIRST_HALF", "SECOND_HALF"))).toHaveLength(1);
    expect(spanErrors(span("2026-11-25", "2026-11-23"))[0]).toMatch(/before/);
    expect(spanErrors(span("2026-11-23", "2026-11-23", "FIRST_HALF", "FIRST_HALF"), false)[0]).toMatch(/half days/);
  });
});

describe("overlap", () => {
  it("dayPortions marks the halves at each end", () => {
    expect([...dayPortions(span("2026-11-23", "2026-11-25", "SECOND_HALF", "FIRST_HALF"))]).toEqual([
      ["2026-11-23", "SECOND_HALF"],
      ["2026-11-24", "FULL"],
      ["2026-11-25", "FIRST_HALF"]
    ]);
  });

  it("two different halves of one day do not clash; anything else on a shared day does", () => {
    expect(portionsClash("FIRST_HALF", "SECOND_HALF")).toBe(false);
    expect(portionsClash("FIRST_HALF", "FIRST_HALF")).toBe(true);
    expect(portionsClash("FULL", "SECOND_HALF")).toBe(true);
  });

  it("findClash finds the overlapping request and ignores neighbours", () => {
    const existing = [
      { id: "a", ...span("2026-11-16", "2026-11-20") },
      { id: "b", ...span("2026-11-25", "2026-11-25", "FIRST_HALF", "FIRST_HALF") }
    ];
    expect(findClash(span("2026-11-23", "2026-11-24"), existing)).toBeNull();
    expect(findClash(span("2026-11-25", "2026-11-25", "SECOND_HALF", "SECOND_HALF"), existing)).toBeNull();
    expect(findClash(span("2026-11-24", "2026-11-26"), existing)?.id).toBe("b");
    expect(findClash(span("2026-11-20", "2026-11-23"), existing)?.id).toBe("a");
  });

  it("merges two halves of a day into a full day", () => {
    expect(mergePortions("FIRST_HALF", "SECOND_HALF")).toBe("FULL");
    expect(mergePortions("FIRST_HALF", "FIRST_HALF")).toBe("FIRST_HALF");
    expect(mergePortions(undefined, "SECOND_HALF")).toBe("SECOND_HALF");
  });
});

describe("leave years", () => {
  it("a January year is the calendar year", () => {
    expect(leaveYearOf("2026-01-01", 1)).toBe(2026);
    expect(leaveYearOf("2026-12-31", 1)).toBe(2026);
    expect(leaveYearBounds(2026, 1)).toEqual({ from: "2026-01-01", to: "2026-12-31" });
  });

  it("an April year is named by the year it starts in", () => {
    expect(leaveYearOf("2027-03-31", 4)).toBe(2026);
    expect(leaveYearOf("2027-04-01", 4)).toBe(2027);
    expect(leaveYearBounds(2026, 4)).toEqual({ from: "2026-04-01", to: "2027-03-31" });
    expect(monthIndexInLeaveYear("2026-04-15", 4)).toBe(0);
    expect(monthIndexInLeaveYear("2027-03-15", 4)).toBe(11);
  });

  it("handles a leap-year February end", () => {
    expect(leaveYearBounds(2027, 3)).toEqual({ from: "2027-03-01", to: "2028-02-29" });
  });
});

describe("accrual", () => {
  it("yearly upfront lands the whole quota on day one", () => {
    expect(accrualSchedule({ annualQuota: 8, accrual: "YEARLY_UPFRONT" }, 2026, 4)).toEqual([{ period: "2026-04", dateKey: "2026-04-01", amount: 8 }]);
  });

  it("monthly pro-rata sums to exactly the quota, remainder on the last month", () => {
    const slots = accrualSchedule({ annualQuota: 10, accrual: "MONTHLY_PRORATA" }, 2026, 1);
    expect(slots).toHaveLength(12);
    expect(slots[0].amount).toBe(0.83);
    expect(slots[11].amount).toBe(0.87);
    expect(Math.round(slots.reduce((s, x) => s + x.amount, 0) * 100) / 100).toBe(10);
  });

  it("an April year's months run April to March across two calendar years", () => {
    const slots = accrualSchedule({ annualQuota: 18, accrual: "MONTHLY_PRORATA" }, 2026, 4);
    expect(slots[0].period).toBe("2026-04");
    expect(slots[11].period).toBe("2027-03");
    expect(slots.every((s) => s.amount === 1.5)).toBe(true);
  });

  it("only slots that have landed are due", () => {
    expect(accrualDueThrough({ annualQuota: 12, accrual: "MONTHLY_PRORATA" }, 2026, 1, "2026-03-15")).toHaveLength(3);
    expect(accrualDueThrough({ annualQuota: 12, accrual: "MONTHLY_PRORATA" }, 2026, 1, "2025-12-31")).toHaveLength(0);
  });

  it("a mid-year joiner accrues from their joining month (monthly) or a scaled lump (yearly)", () => {
    expect(accrualDueThrough({ annualQuota: 12, accrual: "MONTHLY_PRORATA" }, 2026, 1, "2026-12-31", "2026-07-10").map((s) => s.period)[0]).toBe("2026-07");
    expect(accrualDueThrough({ annualQuota: 12, accrual: "YEARLY_UPFRONT" }, 2026, 1, "2026-12-31", "2026-07-10")).toEqual([
      { period: "2026-07", dateKey: "2026-07-01", amount: 6 }
    ]);
    expect(accrualDueThrough({ annualQuota: 12, accrual: "YEARLY_UPFRONT" }, 2026, 1, "2026-12-31", "2025-03-01")[0].amount).toBe(12);
    expect(accrualDueThrough({ annualQuota: 12, accrual: "YEARLY_UPFRONT" }, 2026, 1, "2026-12-31", "2027-02-01")).toEqual([]);
  });

  it("a zero quota accrues nothing", () => {
    expect(accrualSchedule({ annualQuota: 0, accrual: "MONTHLY_PRORATA" }, 2026, 1)).toEqual([]);
  });
});

describe("rolloverDeltas", () => {
  it("carries up to the cap and expires the rest", () => {
    expect(rolloverDeltas(20, 15)).toEqual({ expire: -20, carry: 15 });
    expect(rolloverDeltas(4, 15)).toEqual({ expire: -4, carry: 4 });
  });

  it("nothing carries when the cap is 0", () => {
    expect(rolloverDeltas(5, 0)).toEqual({ expire: -5, carry: 0 });
  });

  it("a debt carries in full and is not forgiven", () => {
    expect(rolloverDeltas(-2, 10)).toEqual({ expire: 2, carry: -2 });
  });

  it("zero balance writes nothing", () => {
    expect(rolloverDeltas(0, 10)).toEqual({ expire: 0, carry: 0 });
  });

  it("the closing year nets to zero and the new year opens at the carry", () => {
    const closing = 12.5;
    const { expire, carry } = rolloverDeltas(closing, 10);
    expect(closing + expire).toBe(0);
    expect(carry).toBe(10);
  });
});

describe("availableBalance", () => {
  it("counts due-but-unposted accrual and reserves pending days", () => {
    expect(availableBalance({ ledgerSum: 3, postedAccrual: 3, dueAccrual: 4.5, pendingDays: 2 })).toBe(2.5);
  });

  it("never double-counts accrual that is already posted", () => {
    expect(availableBalance({ ledgerSum: 6, postedAccrual: 6, dueAccrual: 4.5, pendingDays: 0 })).toBe(6);
  });
});

describe("expectedHours", () => {
  it("(working days − holidays − leave) × weekly/working-days", () => {
    const r = expectedHours({
      from: "2026-11-23",
      to: "2026-11-29",
      workingDays: MON_FRI,
      isHoliday: (d) => d === "2026-11-24",
      leaveFraction: (d) => (d === "2026-11-26" ? 1 : d === "2026-11-27" ? 0.5 : 0),
      weeklyCapacityHours: 40
    });
    expect(r).toEqual({ workingDays: 5, holidays: 1, leaveDays: 1.5, expectedDays: 2.5, dailyHours: 8, expectedHours: 20 });
  });

  it("leave on a holiday is not counted twice", () => {
    const r = expectedHours({ from: "2026-11-24", to: "2026-11-24", workingDays: MON_FRI, isHoliday: () => true, leaveFraction: () => 1, weeklyCapacityHours: 40 });
    expect(r.expectedHours).toBe(0);
    expect(r.leaveDays).toBe(0);
  });

  it("uses the person's own weekly capacity", () => {
    expect(expectedHours({ from: "2026-11-23", to: "2026-11-27", workingDays: MON_FRI, isHoliday: noHoliday, leaveFraction: () => 0, weeklyCapacityHours: 37.5 }).expectedHours).toBe(37.5);
  });
});

describe("resolveDayStatus with leave", () => {
  const base = { dateKey: "2026-11-23", workingDays: MON_FRI, holiday: null, punchedIn: false, now: new Date("2026-11-23T08:00:00Z"), timeZone: "UTC" };

  it("a full day of leave is LEAVE and not a working day", () => {
    expect(resolveDayStatus({ ...base, leave: { type: "PL", half: "FULL" } })).toEqual({ status: "LEAVE", isWorkingDay: false, holidayName: null });
    expect(resolveDayStatus({ ...base, leave: { type: "PL" } }).status).toBe("LEAVE");
  });

  it("a half day is still a working day: PENDING until punched, annotated with the half", () => {
    expect(resolveDayStatus({ ...base, leave: { type: "PL", half: "FIRST_HALF" } })).toEqual({
      status: "PENDING",
      isWorkingDay: true,
      holidayName: null,
      leaveHalf: "FIRST_HALF"
    });
    expect(resolveDayStatus({ ...base, punchedIn: true, leave: { type: "PL", half: "SECOND_HALF" } }).status).toBe("PRESENT");
  });

  it("no leave keeps the exact Phase A shape (no leaveHalf key)", () => {
    expect(resolveDayStatus({ ...base, leave: null })).toEqual({ status: "PENDING", isWorkingDay: true, holidayName: null });
  });
});

describe("capacity: leave reduces availability without double counting", () => {
  const off = [{ startDate: new Date("2026-11-23T00:00:00Z"), endDate: new Date("2026-11-24T00:00:00Z"), hoursPerDay: 8 }];

  it("takes the larger of booked time off and absence per day, never the sum", () => {
    const absence = new Map([
      ["2026-11-24", 8],
      ["2026-11-25", 4]
    ]);
    expect(mergedTimeOffHours(off, absence, "2026-11-23", "2026-11-27", MON_FRI)).toBe(20);
  });

  it("with no absence it is exactly the booked time off (isTimeOff keeps working)", () => {
    expect(mergedTimeOffHours(off, undefined, "2026-11-23", "2026-11-27", MON_FRI)).toBe(16);
  });

  it("buildWorkload subtracts approved leave from capacity", () => {
    const buckets = buildBuckets(new Date("2026-11-23T00:00:00Z"), new Date("2026-11-27T00:00:00Z"), "week", MON_FRI);
    const person = { id: "p1", name: "P", email: "p@x.io", avatarUrl: null, weeklyCapacityHours: 40, plannedUtilizationPct: null };
    const rows = buildWorkload({
      people: [person],
      bookings: [],
      logged: [],
      buckets,
      workingDays: MON_FRI,
      defaultWeeklyCapacityHours: 40,
      absence: new Map([["p1", new Map([["2026-11-25", 8], ["2026-11-26", 4]])]])
    });
    expect(rows[0].totals.timeOffHours).toBe(12);
    expect(rows[0].totals.capacityHours).toBe(28);
  });
});
