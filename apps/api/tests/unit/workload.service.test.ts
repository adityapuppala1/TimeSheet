/**
 * Pins the capacity/allocation arithmetic.
 *
 * WHY THESE CASES: every bug that matters here is silent. Spreading a booking across calendar
 * days instead of working days inflates the whole company's load by 40% and the board still looks
 * plausible. Counting leave as load makes a week off read as "fully booked" so planners fill it.
 * An over-allocation threshold off by a rounding error lights up every row. None of these throw.
 */
import { describe, expect, it } from "vitest";
import { toDay } from "../../src/services/plan-schedule.service.js";
import {
  bookedHoursInRange,
  buildBuckets,
  buildWorkload,
  capacityForBucket,
  findConflicts,
  OVER_ALLOCATION_THRESHOLD_PCT,
  type BookingSpan,
  type CapacityPerson
} from "../../src/services/workload.service.js";

/** 2026-03-02 is a Monday. */
const MON = toDay("2026-03-02");
const FRI = toDay("2026-03-06");
const SUN = toDay("2026-03-08");

const person = (over: Partial<CapacityPerson> = {}): CapacityPerson => ({
  id: "u1",
  name: "Ana",
  email: "ana@example.com",
  avatarUrl: null,
  weeklyCapacityHours: null,
  plannedUtilizationPct: null,
  ...over
});

const booking = (over: Partial<BookingSpan> & { id: string }): BookingSpan => ({
  userId: "u1",
  projectId: "p1",
  ticketId: null,
  startDate: MON,
  endDate: FRI,
  hoursPerDay: 8,
  isTimeOff: false,
  note: null,
  ...over
});

const DEFAULTS = { weeklyCapacityHours: 40, workingDaysPerWeek: 5 };

describe("bookedHoursInRange", () => {
  it("counts WORKING days, not calendar days", () => {
    // THE bug: 8h/day Mon-Sun must be 40 hours, not 56. Getting this wrong inflates every
    // person's load by the weekend and makes the whole board useless.
    expect(bookedHoursInRange(booking({ id: "b", startDate: MON, endDate: SUN }), MON, SUN)).toBe(40);
    expect(bookedHoursInRange(booking({ id: "b", startDate: MON, endDate: FRI }), MON, FRI)).toBe(40);
  });

  it("clips to the requested window rather than counting the whole booking", () => {
    const b = booking({ id: "b", startDate: MON, endDate: toDay("2026-03-20") });
    // Only Mon-Fri of the first week falls in the window.
    expect(bookedHoursInRange(b, MON, FRI)).toBe(40);
  });

  it("returns zero when the booking does not overlap the window at all", () => {
    const b = booking({ id: "b", startDate: toDay("2026-04-01"), endDate: toDay("2026-04-10") });
    expect(bookedHoursInRange(b, MON, FRI)).toBe(0);
  });

  it("honours a six-day working week", () => {
    const sixDay = [1, 2, 3, 4, 5, 6];
    expect(bookedHoursInRange(booking({ id: "b", startDate: MON, endDate: SUN }), MON, SUN, sixDay)).toBe(48);
  });
});

describe("capacityForBucket", () => {
  it("falls back to the workspace default when a person has no capacity of their own", () => {
    expect(capacityForBucket(person(), { workingDays: 5 }, DEFAULTS)).toBe(40);
  });

  it("uses the person's own hours when set", () => {
    expect(capacityForBucket(person({ weeklyCapacityHours: 20 }), { workingDays: 5 }, DEFAULTS)).toBe(20);
  });

  it("scales to the working days actually in the bucket", () => {
    // A truncated first/last column must report proportional capacity, not a full week of it.
    expect(capacityForBucket(person(), { workingDays: 2 }, DEFAULTS)).toBe(16);
    expect(capacityForBucket(person(), { workingDays: 0 }, DEFAULTS)).toBe(0);
  });

  it("applies planned utilisation on top of contracted hours", () => {
    // Part-time and fully-loaded are modelled by two different fields rather than one fudged
    // number, so a 40h person expected to be 80% billable has 32h of bookable capacity.
    expect(capacityForBucket(person({ plannedUtilizationPct: 80 }), { workingDays: 5 }, DEFAULTS)).toBe(32);
  });
});

describe("buildBuckets", () => {
  it("aligns weeks to the first working day of the workspace week", () => {
    const buckets = buildBuckets(toDay("2026-03-04"), toDay("2026-03-17"), "week");
    // Requested range starts mid-week; the first bucket still starts on the Monday.
    expect(buckets[0].start).toBe("2026-03-02");
    expect(buckets).toHaveLength(3);
  });

  it("clamps the working-day count of a truncated bucket to the requested range", () => {
    // Range starts Wednesday, so the first week contributes only Wed/Thu/Fri.
    const buckets = buildBuckets(toDay("2026-03-04"), toDay("2026-03-13"), "week");
    expect(buckets[0].workingDays).toBe(3);
    expect(buckets[1].workingDays).toBe(5);
  });

  it("marks non-working days as zero-capacity in day granularity", () => {
    const buckets = buildBuckets(FRI, SUN, "day");
    expect(buckets.map((b) => b.workingDays)).toEqual([1, 0, 0]); // Fri, Sat, Sun
  });

  it("returns nothing for a reversed range instead of looping", () => {
    expect(buildBuckets(FRI, MON, "week")).toHaveLength(0);
  });
});

describe("buildWorkload", () => {
  const buckets = buildBuckets(MON, FRI, "week");
  const base = { buckets, workingDays: [1, 2, 3, 4, 5], defaultWeeklyCapacityHours: 40 };

  it("reports allocation against available capacity", () => {
    const [row] = buildWorkload({
      ...base,
      people: [person()],
      bookings: [booking({ id: "b1", hoursPerDay: 4 })],
      logged: []
    });
    expect(row.cells[0].capacityHours).toBe(40);
    expect(row.cells[0].bookedHours).toBe(20);
    expect(row.cells[0].allocationPct).toBe(50);
    expect(row.cells[0].isOverAllocated).toBe(false);
  });

  it("does NOT flag someone booked to exactly their capacity", () => {
    // Fully booked is the intended state. Flagging it would light up the whole board on a
    // well-planned sprint and train everyone to ignore the colour.
    const [row] = buildWorkload({ ...base, people: [person()], bookings: [booking({ id: "b1", hoursPerDay: 8 })], logged: [] });
    expect(row.cells[0].allocationPct).toBe(100);
    expect(row.cells[0].isOverAllocated).toBe(false);
  });

  it("flags a real overrun", () => {
    const [row] = buildWorkload({ ...base, people: [person()], bookings: [booking({ id: "b1", hoursPerDay: 10 })], logged: [] });
    expect(row.cells[0].allocationPct).toBe(125);
    expect(row.cells[0].isOverAllocated).toBe(true);
    expect(OVER_ALLOCATION_THRESHOLD_PCT).toBeGreaterThan(100);
  });

  it("treats time off as unavailable capacity, not as load", () => {
    // A week of leave must read as "unavailable", not "100% booked" — otherwise planners fill it.
    const [row] = buildWorkload({
      ...base,
      people: [person()],
      bookings: [booking({ id: "off", hoursPerDay: 8, isTimeOff: true })],
      logged: []
    });
    expect(row.cells[0].timeOffHours).toBe(40);
    expect(row.cells[0].capacityHours).toBe(0);
    expect(row.cells[0].bookedHours).toBe(0);
    // No capacity to divide by, so the percentage is null rather than Infinity.
    expect(row.cells[0].allocationPct).toBeNull();
    expect(row.cells[0].isOverAllocated).toBe(false);
  });

  it("calls any booking during full leave an over-allocation, which the percentage cannot say", () => {
    const [row] = buildWorkload({
      ...base,
      people: [person()],
      bookings: [booking({ id: "off", hoursPerDay: 8, isTimeOff: true }), booking({ id: "work", hoursPerDay: 2 })],
      logged: []
    });
    expect(row.cells[0].allocationPct).toBeNull();
    expect(row.cells[0].isOverAllocated).toBe(true);
  });

  it("carries logged hours alongside booked ones — planned vs actual on the same axis", () => {
    // The thing a pure PM tool cannot do: compare the plan against what really happened.
    const [row] = buildWorkload({
      ...base,
      people: [person()],
      bookings: [booking({ id: "b1", hoursPerDay: 8 })],
      logged: [
        { userId: "u1", workDate: MON, hours: 7.5 },
        { userId: "u1", workDate: FRI, hours: 6 },
        // Outside the window — must not be counted.
        { userId: "u1", workDate: toDay("2026-04-01"), hours: 8 }
      ]
    });
    expect(row.cells[0].loggedHours).toBe(13.5);
    expect(row.totals.loggedHours).toBe(13.5);
  });

  it("keeps people with no bookings on the board", () => {
    // Someone at 0% is exactly who a planner is looking for; dropping empty rows hides them.
    const [row] = buildWorkload({ ...base, people: [person()], bookings: [], logged: [] });
    expect(row.cells[0].bookedHours).toBe(0);
    expect(row.cells[0].allocationPct).toBe(0);
  });

  it("totals across buckets", () => {
    const twoWeeks = buildBuckets(MON, toDay("2026-03-13"), "week");
    const [row] = buildWorkload({
      ...base,
      buckets: twoWeeks,
      people: [person()],
      bookings: [booking({ id: "b1", startDate: MON, endDate: toDay("2026-03-13"), hoursPerDay: 4 })],
      logged: []
    });
    expect(row.totals.capacityHours).toBe(80);
    expect(row.totals.bookedHours).toBe(40);
    expect(row.totals.allocationPct).toBe(50);
    expect(row.totals.overAllocatedBuckets).toBe(0);
  });
});

describe("findConflicts", () => {
  it("reports overlapping bookings that together exceed a daily capacity", () => {
    const conflicts = findConflicts(
      [
        booking({ id: "a", startDate: MON, endDate: FRI, hoursPerDay: 6 }),
        booking({ id: "b", startDate: toDay("2026-03-04"), endDate: toDay("2026-03-10"), hoursPerDay: 5 })
      ],
      person(),
      DEFAULTS
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].combinedHoursPerDay).toBe(11);
    expect(conflicts[0].overlapStart).toBe("2026-03-04");
    expect(conflicts[0].overlapEnd).toBe("2026-03-06");
  });

  it("says nothing when two bookings fit inside a day", () => {
    const conflicts = findConflicts(
      [booking({ id: "a", hoursPerDay: 4 }), booking({ id: "b", hoursPerDay: 4 })],
      person(),
      DEFAULTS
    );
    expect(conflicts).toHaveLength(0);
  });

  it("ignores time off, which is an absence rather than a competing commitment", () => {
    const conflicts = findConflicts(
      [booking({ id: "a", hoursPerDay: 8 }), booking({ id: "off", hoursPerDay: 8, isTimeOff: true })],
      person(),
      DEFAULTS
    );
    expect(conflicts).toHaveLength(0);
  });

  it("says nothing when the two bookings do not overlap in time", () => {
    const conflicts = findConflicts(
      [
        booking({ id: "a", startDate: MON, endDate: toDay("2026-03-03"), hoursPerDay: 8 }),
        booking({ id: "b", startDate: toDay("2026-03-05"), endDate: FRI, hoursPerDay: 8 })
      ],
      person(),
      DEFAULTS
    );
    expect(conflicts).toHaveLength(0);
  });
});
