/**
 * WHAT: capacity and allocation — how much time each person has, how much is booked against
 * them, how much they have actually logged, and where those three disagree.
 *
 * WHY THIS IS THE FEATURE TIMESPHERE CAN DO BETTER THAN A PURE PM TOOL: Wrike, Asana and the
 * rest can only ever compare a plan against another plan, because estimates are the only numbers
 * they hold. This app already has approved timesheets with a rate snapshot, so it can put PLANNED
 * (a `ResourceBooking`), ACTUAL (approved `Timesheet` rows) and CAPACITY
 * (`User.weeklyCapacityHours`) on the same axis. "Ana is booked at 110%" is a forecast; "Ana was
 * booked at 110% and actually logged 46 hours" is evidence. The whole shape of this file follows
 * from wanting the second sentence to be possible.
 *
 * WHY A PURE CORE WITH A THIN DB SHELL, same as plan-schedule.service.ts: the interesting bugs
 * are arithmetic — spreading a booking across calendar days instead of working days silently
 * inflates everyone's load by 40%, and an over-allocation threshold that rounds the wrong way
 * flags half the company. Those are cheap to unit-test and miserable to debug through a database.
 *
 * WHO CALLS THIS: `controllers/resource.controller.ts`, and from phase 5 the risk scorer (an
 * over-allocated team is one of the signals it reads).
 */
import { prisma } from "../config/prisma.js";
import {
  addDays,
  dayKey,
  isWorkingDay,
  toDay,
  workingDaysBetween,
  type WorkingDays,
  DEFAULT_WORKING_DAYS
} from "./plan-schedule.service.js";
import { getPlanningSettings } from "./planning.service.js";

/* ================================================================== *
 * Pure core
 * ================================================================== */

export interface CapacityPerson {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  /** Null = fall back to the workspace default. Deliberately not defaulted in the column: a
   *  row-level 40 and an unanswered-question 40 are different facts, and only the second should
   *  follow a workspace that later says its week is 37.5 hours. */
  weeklyCapacityHours: number | null;
  /** Share of that capacity expected to be bookable project work rather than meetings/support.
   *  Null = 100. */
  plannedUtilizationPct: number | null;
}

export interface BookingSpan {
  id: string;
  userId: string;
  projectId: string | null;
  ticketId: string | null;
  startDate: Date;
  endDate: Date;
  /** Hours per WORKING day. See `bookedHoursInRange`. */
  hoursPerDay: number;
  isTimeOff: boolean;
  note: string | null;
}

export interface LoggedSpan {
  userId: string;
  workDate: Date;
  hours: number;
}

export interface Bucket {
  /** ISO day of the bucket's first day. */
  start: string;
  end: string;
  label: string;
  workingDays: number;
}

/**
 * Hours a booking contributes inside [from, to].
 *
 * `hoursPerDay` is per WORKING day, not per calendar day. Booking somebody 8h/day across a
 * calendar week must claim 40 hours, not 56 — getting this wrong inflates every person's load by
 * the weekend and makes the whole board useless.
 */
export function bookedHoursInRange(
  booking: Pick<BookingSpan, "startDate" | "endDate" | "hoursPerDay">,
  from: Date,
  to: Date,
  workingDays: WorkingDays = DEFAULT_WORKING_DAYS
): number {
  const overlapStart = toDay(booking.startDate) > toDay(from) ? toDay(booking.startDate) : toDay(from);
  const overlapEnd = toDay(booking.endDate) < toDay(to) ? toDay(booking.endDate) : toDay(to);
  if (overlapEnd < overlapStart) return 0;
  return workingDaysBetween(overlapStart, overlapEnd, workingDays) * booking.hoursPerDay;
}

/**
 * A person's capacity for one bucket.
 *
 * Scaled by working days in the bucket rather than assumed to be a full week, so a bucket
 * truncated by the requested range (or a week containing a public holiday, once those exist)
 * reports proportionally less capacity instead of pretending everyone was available.
 */
export function capacityForBucket(
  person: Pick<CapacityPerson, "weeklyCapacityHours" | "plannedUtilizationPct">,
  bucket: Pick<Bucket, "workingDays">,
  defaults: { weeklyCapacityHours: number; workingDaysPerWeek: number }
): number {
  const weekly = person.weeklyCapacityHours ?? defaults.weeklyCapacityHours;
  const perDay = defaults.workingDaysPerWeek > 0 ? weekly / defaults.workingDaysPerWeek : 0;
  const raw = perDay * bucket.workingDays;
  const utilisation = person.plannedUtilizationPct ?? 100;
  return Math.round(raw * (utilisation / 100) * 100) / 100;
}

export interface WorkloadCell {
  bucketStart: string;
  capacityHours: number;
  bookedHours: number;
  /** Bookings flagged `isTimeOff` — subtracted from what is available rather than counted as
   *  delivery, so leave reads as "unavailable", not "busy". */
  timeOffHours: number;
  loggedHours: number;
  /** Booked ÷ available, as a percentage. Null when there is no capacity to divide by (someone
   *  fully on leave), because "Infinity%" is not a useful thing to show a manager. */
  allocationPct: number | null;
  isOverAllocated: boolean;
}

export interface WorkloadRow {
  person: CapacityPerson;
  cells: WorkloadCell[];
  totals: {
    capacityHours: number;
    bookedHours: number;
    loggedHours: number;
    timeOffHours: number;
    allocationPct: number | null;
    overAllocatedBuckets: number;
  };
}

/**
 * The threshold at which a bucket is called over-allocated.
 *
 * 100% exactly is NOT over-allocated — a person booked to precisely their capacity is fully
 * booked, which is the intended state, and flagging it would light up the whole board on a
 * well-planned sprint. The 2% tolerance absorbs rounding on fractional day rates (a 7.5-hour day
 * booked at 2.5h × 3 tasks) rather than reporting a phantom overrun of a few minutes.
 */
export const OVER_ALLOCATION_THRESHOLD_PCT = 102;

/** Builds week (or day) buckets covering [from, to]. Weeks start on the first working day of the
 *  workspace's week, so the grid lines up with how the team actually thinks about a week. */
export function buildBuckets(
  from: Date,
  to: Date,
  granularity: "day" | "week",
  workingDays: WorkingDays = DEFAULT_WORKING_DAYS
): Bucket[] {
  const buckets: Bucket[] = [];
  const start = toDay(from);
  const end = toDay(to);
  if (end < start) return buckets;

  if (granularity === "day") {
    for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) {
      buckets.push({
        start: dayKey(cursor),
        end: dayKey(cursor),
        label: dayKey(cursor).slice(5),
        workingDays: isWorkingDay(cursor, workingDays) ? 1 : 0
      });
      if (buckets.length > 400) break;
    }
    return buckets;
  }

  // Align to the workspace's first working weekday (Monday in the default config) so a "week"
  // column means the same thing on the board as it does to the team.
  const weekStartDow = [...workingDays].sort((a, b) => a - b)[0] ?? 1;
  let cursor = start;
  while (cursor.getUTCDay() !== weekStartDow) {
    cursor = addDays(cursor, -1);
    if (dayKey(cursor) < dayKey(addDays(start, -7))) break;
  }

  while (cursor <= end) {
    const bucketEnd = addDays(cursor, 6);
    // Clamp to the requested range so the first and last columns report the capacity that
    // actually falls inside the window, not a full week of it.
    const effectiveStart = cursor < start ? start : cursor;
    const effectiveEnd = bucketEnd > end ? end : bucketEnd;
    buckets.push({
      start: dayKey(cursor),
      end: dayKey(bucketEnd),
      label: dayKey(cursor).slice(5),
      workingDays: workingDaysBetween(effectiveStart, effectiveEnd, workingDays)
    });
    cursor = addDays(cursor, 7);
    if (buckets.length > 200) break;
  }
  return buckets;
}

/** Assembles the grid. Pure — every input is passed in, which is what makes it testable. */
export function buildWorkload(params: {
  people: CapacityPerson[];
  bookings: BookingSpan[];
  logged: LoggedSpan[];
  buckets: Bucket[];
  workingDays: WorkingDays;
  defaultWeeklyCapacityHours: number;
}): WorkloadRow[] {
  const { people, bookings, logged, buckets, workingDays, defaultWeeklyCapacityHours } = params;
  const workingDaysPerWeek = workingDays.length || 5;
  const defaults = { weeklyCapacityHours: defaultWeeklyCapacityHours, workingDaysPerWeek };

  const bookingsByUser = new Map<string, BookingSpan[]>();
  for (const b of bookings) {
    if (!bookingsByUser.has(b.userId)) bookingsByUser.set(b.userId, []);
    bookingsByUser.get(b.userId)!.push(b);
  }
  const loggedByUser = new Map<string, LoggedSpan[]>();
  for (const l of logged) {
    if (!loggedByUser.has(l.userId)) loggedByUser.set(l.userId, []);
    loggedByUser.get(l.userId)!.push(l);
  }

  return people.map((person) => {
    const theirBookings = bookingsByUser.get(person.id) ?? [];
    const theirLogged = loggedByUser.get(person.id) ?? [];

    const cells: WorkloadCell[] = buckets.map((bucket) => {
      const from = toDay(bucket.start);
      const to = toDay(bucket.end);

      let booked = 0;
      let timeOff = 0;
      for (const b of theirBookings) {
        const hours = bookedHoursInRange(b, from, to, workingDays);
        if (b.isTimeOff) timeOff += hours;
        else booked += hours;
      }

      let loggedHours = 0;
      for (const l of theirLogged) {
        const day = toDay(l.workDate);
        if (day >= from && day <= to) loggedHours += l.hours;
      }

      const gross = capacityForBucket(person, bucket, defaults);
      // Time off reduces what is AVAILABLE rather than counting as load. A week of leave should
      // read as "unavailable", not as "100% booked", or planners fill it.
      const available = Math.max(0, Math.round((gross - timeOff) * 100) / 100);
      const allocationPct = available > 0 ? Math.round((booked / available) * 100) : null;

      return {
        bucketStart: bucket.start,
        capacityHours: available,
        bookedHours: Math.round(booked * 100) / 100,
        timeOffHours: Math.round(timeOff * 100) / 100,
        loggedHours: Math.round(loggedHours * 100) / 100,
        allocationPct,
        // Someone with zero available time and any booking at all is over-allocated, which the
        // percentage cannot express (it is null) — so it is stated explicitly here.
        isOverAllocated: allocationPct === null ? booked > 0 : allocationPct >= OVER_ALLOCATION_THRESHOLD_PCT
      };
    });

    const sum = (pick: (c: WorkloadCell) => number) => Math.round(cells.reduce((s, c) => s + pick(c), 0) * 100) / 100;
    const capacityHours = sum((c) => c.capacityHours);
    const bookedHours = sum((c) => c.bookedHours);

    return {
      person,
      cells,
      totals: {
        capacityHours,
        bookedHours,
        loggedHours: sum((c) => c.loggedHours),
        timeOffHours: sum((c) => c.timeOffHours),
        allocationPct: capacityHours > 0 ? Math.round((bookedHours / capacityHours) * 100) : null,
        overAllocatedBuckets: cells.filter((c) => c.isOverAllocated).length
      }
    };
  });
}

/**
 * Bookings that overlap in time for the same person, with their combined daily rate exceeding
 * that person's daily capacity.
 *
 * Reported, never prevented. Double-booking is sometimes deliberate — a person genuinely split
 * across two projects for a fortnight — and a system that refuses the second booking forces
 * planners to record something untrue instead. What matters is that it is visible.
 */
export function findConflicts(
  bookings: BookingSpan[],
  person: Pick<CapacityPerson, "weeklyCapacityHours" | "plannedUtilizationPct">,
  defaults: { weeklyCapacityHours: number; workingDaysPerWeek: number }
): Array<{ aId: string; bId: string; overlapStart: string; overlapEnd: string; combinedHoursPerDay: number }> {
  const dailyCapacity =
    ((person.weeklyCapacityHours ?? defaults.weeklyCapacityHours) / (defaults.workingDaysPerWeek || 5)) *
    ((person.plannedUtilizationPct ?? 100) / 100);

  const out: Array<{ aId: string; bId: string; overlapStart: string; overlapEnd: string; combinedHoursPerDay: number }> = [];
  const live = bookings.filter((b) => !b.isTimeOff);
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i];
      const b = live[j];
      const start = toDay(a.startDate) > toDay(b.startDate) ? toDay(a.startDate) : toDay(b.startDate);
      const end = toDay(a.endDate) < toDay(b.endDate) ? toDay(a.endDate) : toDay(b.endDate);
      if (end < start) continue;
      const combined = a.hoursPerDay + b.hoursPerDay;
      if (combined <= dailyCapacity) continue;
      out.push({
        aId: a.id,
        bId: b.id,
        overlapStart: dayKey(start),
        overlapEnd: dayKey(end),
        combinedHoursPerDay: Math.round(combined * 100) / 100
      });
    }
  }
  return out;
}

/* ================================================================== *
 * DB shell
 * ================================================================== */

export async function loadWorkload(params: {
  from: Date;
  to: Date;
  granularity?: "day" | "week";
  userIds?: string[];
  projectId?: string;
}): Promise<{ buckets: Bucket[]; rows: WorkloadRow[]; workingDays: number[] }> {
  const settings = await getPlanningSettings();
  const workingDays = settings.workingDays;
  const buckets = buildBuckets(params.from, params.to, params.granularity ?? "week", workingDays);

  const people = await prisma.user.findMany({
    where: {
      deletedAt: null,
      status: "ACTIVE",
      ...(params.userIds?.length ? { id: { in: params.userIds } } : {}),
      // Scoping by project means "people assigned to it", which is the same membership the
      // ticket-assignment rules already use — not "people who happen to have logged time",
      // which would make someone who helped out once look like a team member forever.
      ...(params.projectId ? { projectAssignments: { some: { projectId: params.projectId } } } : {})
    },
    select: {
      id: true,
      name: true,
      email: true,
      avatarUrl: true,
      weeklyCapacityHours: true,
      plannedUtilizationPct: true
    },
    orderBy: { name: "asc" }
  });
  if (people.length === 0) return { buckets, rows: [], workingDays };

  const ids = people.map((p) => p.id);
  // Two grouped queries, never per-person loops — the workload board over 60 people and 12 weeks
  // would otherwise fire 720 round trips and time out on exactly the workspace that needs it.
  const [bookingRows, loggedRows] = await Promise.all([
    prisma.resourceBooking.findMany({
      where: {
        userId: { in: ids },
        ...(params.projectId ? { projectId: params.projectId } : {}),
        // Overlap, not containment: a booking that starts before the window and ends inside it
        // is very much on screen, and filtering it out is how a board ends up under-reporting.
        startDate: { lte: params.to },
        endDate: { gte: params.from }
      },
      select: {
        id: true, userId: true, projectId: true, ticketId: true,
        startDate: true, endDate: true, hoursPerDay: true, isTimeOff: true, note: true
      }
    }),
    prisma.timesheet.findMany({
      where: {
        userId: { in: ids },
        deletedAt: null,
        // APPROVED only. A draft or rejected entry is not evidence of anything, and counting it
        // would make "actual" mean something different here from every other number in the app.
        status: "APPROVED",
        workDate: { gte: params.from, lte: params.to },
        ...(params.projectId ? { projectId: params.projectId } : {})
      },
      select: { userId: true, workDate: true, totalHours: true }
    })
  ]);

  const rows = buildWorkload({
    people: people.map((p) => ({
      id: p.id,
      name: p.name,
      email: p.email,
      avatarUrl: p.avatarUrl,
      weeklyCapacityHours: p.weeklyCapacityHours ? Number(p.weeklyCapacityHours) : null,
      plannedUtilizationPct: p.plannedUtilizationPct
    })),
    bookings: bookingRows.map((b) => ({
      id: b.id,
      userId: b.userId,
      projectId: b.projectId,
      ticketId: b.ticketId,
      startDate: b.startDate,
      endDate: b.endDate,
      hoursPerDay: Number(b.hoursPerDay),
      isTimeOff: b.isTimeOff,
      note: b.note
    })),
    logged: loggedRows.map((l) => ({ userId: l.userId, workDate: l.workDate, hours: Number(l.totalHours) })),
    buckets,
    workingDays,
    defaultWeeklyCapacityHours: settings.defaultWeeklyCapacityHours
  });

  return { buckets, rows, workingDays };
}
