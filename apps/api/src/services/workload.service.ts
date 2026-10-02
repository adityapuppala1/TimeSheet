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
import { platformDayStart } from "../utils/date-window.js";
import { platformDayKey } from "../utils/platform-time.js";

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
  /**
   * The part of [start, end] the requested range actually covers. A week column at either edge of
   * the board is cut by the range — the board opens on TODAY, so its first column is partial on
   * every day but Monday — and every sum in the column must be over these days, not the full week.
   * Capacity already was (`workingDays` is clamped); bookings, logged hours, leave and tickets were
   * not, so a person booked solidly read 250% on a Thursday. Absent = the whole bucket.
   */
  effectiveStart?: string;
  effectiveEnd?: string;
}

/** The days a bucket's figures are summed over — see `Bucket.effectiveStart`. */
export function bucketSpan(bucket: Pick<Bucket, "start" | "end" | "effectiveStart" | "effectiveEnd">): { from: Date; to: Date } {
  return { from: toDay(bucket.effectiveStart ?? bucket.start), to: toDay(bucket.effectiveEnd ?? bucket.end) };
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

/**
 * V12 3.20 — a ticket as a unit of load. The reference measures a workload board by sprint
 * points or task count as well as time; here a ticket counts in a bucket when its scheduled span
 * overlaps it, or — when nobody has scheduled it — when its SLA date falls in it. The same
 * "scheduled vs SLA date" rule the calendar uses, so the two surfaces agree about where a ticket is.
 */
export interface TicketLoad {
  userId: string;
  startDate: Date | null;
  endDate: Date | null;
  dueAt: Date | null;
  storyPoints: number | null;
}

/** Statuses that no longer count as load. Reopened does. */
export const CLOSED_FOR_LOAD = ["RESOLVED", "CLOSED"] as const;

/** One bucket spanning the whole board, for window totals — from the first column's first COVERED
 *  day to the last column's last covered day. */
function windowOf(buckets: Bucket[]): Bucket {
  const first = buckets[0];
  const last = buckets.at(-1);
  return {
    start: first?.effectiveStart ?? first?.start ?? "1970-01-01",
    end: last?.effectiveEnd ?? last?.end ?? "1970-01-01",
    label: "",
    workingDays: 0
  };
}

export function ticketLoadForBucket(tickets: TicketLoad[], bucket: Bucket): { ticketCount: number; storyPoints: number } {
  const { from, to } = bucketSpan(bucket);
  let ticketCount = 0;
  let storyPoints = 0;
  for (const t of tickets) {
    let inBucket = false;
    if (t.startDate && t.endDate) {
      const s = toDay(t.startDate);
      const e = toDay(t.endDate);
      inBucket = s <= to && e >= from;
    } else if (t.dueAt) {
      const d = toDay(t.dueAt);
      inBucket = d >= from && d <= to;
    }
    if (!inBucket) continue;
    ticketCount += 1;
    storyPoints += t.storyPoints ?? 0;
  }
  return { ticketCount, storyPoints: Math.round(storyPoints * 10) / 10 };
}

export interface WorkloadCell {
  bucketStart: string;
  capacityHours: number;
  bookedHours: number;
  /** V12 3.20: open tickets assigned to the person that sit in this bucket, and their points. */
  ticketCount: number;
  storyPoints: number;
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
    ticketCount: number;
    storyPoints: number;
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
        workingDays: isWorkingDay(cursor, workingDays) ? 1 : 0,
        effectiveStart: dayKey(cursor),
        effectiveEnd: dayKey(cursor)
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
      workingDays: workingDaysBetween(effectiveStart, effectiveEnd, workingDays),
      effectiveStart: dayKey(effectiveStart),
      effectiveEnd: dayKey(effectiveEnd)
    });
    cursor = addDays(cursor, 7);
    if (buckets.length > 200) break;
  }
  return buckets;
}

/** Assembles the grid. Pure — every input is passed in, which is what makes it testable. */
function groupByUser<T extends { userId: string }>(rows: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const list = map.get(row.userId);
    if (list) list.push(row);
    else map.set(row.userId, [row]);
  }
  return map;
}

export function buildWorkload(params: {
  people: CapacityPerson[];
  bookings: BookingSpan[];
  logged: LoggedSpan[];
  /** Optional so every existing caller and test stands; absent = zero tickets everywhere. */
  tickets?: TicketLoad[];
  buckets: Bucket[];
  workingDays: WorkingDays;
  defaultWeeklyCapacityHours: number;
}): WorkloadRow[] {
  const { people, bookings, logged, buckets, workingDays, defaultWeeklyCapacityHours } = params;
  const ticketsByUser = groupByUser(params.tickets ?? []);
  const workingDaysPerWeek = workingDays.length || 5;
  const defaults = { weeklyCapacityHours: defaultWeeklyCapacityHours, workingDaysPerWeek };

  const bookingsByUser = groupByUser(bookings);
  const loggedByUser = groupByUser(logged);

  return people.map((person) => {
    const theirBookings = bookingsByUser.get(person.id) ?? [];
    const theirLogged = loggedByUser.get(person.id) ?? [];
    const theirTickets = ticketsByUser.get(person.id) ?? [];

    const cells: WorkloadCell[] = buckets.map((bucket) => {
      // The COVERED days, the same ones `capacityForBucket` counts — see `Bucket.effectiveStart`.
      const { from, to } = bucketSpan(bucket);

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

      const load = ticketLoadForBucket(theirTickets, bucket);
      return {
        bucketStart: bucket.start,
        capacityHours: available,
        bookedHours: Math.round(booked * 100) / 100,
        ticketCount: load.ticketCount,
        storyPoints: load.storyPoints,
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
        overAllocatedBuckets: cells.filter((c) => c.isOverAllocated).length,
        // Distinct tickets, not the sum of per-bucket counts: a two-week ticket is one ticket.
        ...ticketLoadForBucket(theirTickets, windowOf(buckets))
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

/**
 * V12 7.3 — the board grouped by project, people inside (the reference's "primary group List,
 * also group by Assignee"). A project row totals its people's HOURS, tickets and points but has
 * no capacity: capacity belongs to a person, not a project (the reference measures capacity only
 * on assignee rows). A person's row inside a project counts only that project's bookings, logged
 * hours and tickets against the person's whole capacity — "how much of Ana is on this project".
 */
export interface WorkloadGroup {
  project: { id: string; code: string; name: string; color: string | null };
  rows: WorkloadRow[];
  totals: { bookedHours: number; loggedHours: number; ticketCount: number; storyPoints: number };
}

/** Split one board's inputs per project and build each project's own rows. Pure. */
export function groupWorkloadByProject(params: {
  projects: WorkloadGroup["project"][];
  membership: Array<{ userId: string; projectId: string }>;
  people: CapacityPerson[];
  bookings: BookingSpan[];
  logged: Array<LoggedSpan & { projectId: string | null }>;
  tickets: Array<TicketLoad & { projectId: string }>;
  buckets: Bucket[];
  workingDays: WorkingDays;
  defaultWeeklyCapacityHours: number;
}): WorkloadGroup[] {
  const peopleById = new Map(params.people.map((p) => [p.id, p]));
  return params.projects
    .map((project) => {
      const memberIds = new Set(params.membership.filter((m) => m.projectId === project.id).map((m) => m.userId));
      // Someone booked or ticketed on a project they are not assigned to still belongs on its row.
      for (const b of params.bookings) if (b.projectId === project.id) memberIds.add(b.userId);
      for (const t of params.tickets) if (t.projectId === project.id) memberIds.add(t.userId);
      const people = [...memberIds].map((id) => peopleById.get(id)).filter((p): p is CapacityPerson => Boolean(p));
      const rows = buildWorkload({
        people,
        bookings: params.bookings.filter((b) => b.projectId === project.id),
        logged: params.logged.filter((l) => l.projectId === project.id),
        tickets: params.tickets.filter((t) => t.projectId === project.id),
        buckets: params.buckets,
        workingDays: params.workingDays,
        defaultWeeklyCapacityHours: params.defaultWeeklyCapacityHours
      });
      const sum = (pick: (r: WorkloadRow) => number) => Math.round(rows.reduce((s, r) => s + pick(r), 0) * 100) / 100;
      return {
        project,
        rows,
        totals: {
          bookedHours: sum((r) => r.totals.bookedHours),
          loggedHours: sum((r) => r.totals.loggedHours),
          ticketCount: sum((r) => r.totals.ticketCount),
          storyPoints: sum((r) => r.totals.storyPoints)
        }
      };
    })
    .filter((g) => g.rows.length > 0)
    .sort((a, b) => a.project.name.localeCompare(b.project.name));
}

export async function loadWorkload(params: {
  from: Date;
  to: Date;
  granularity?: "day" | "week";
  userIds?: string[];
  projectId?: string;
  /** Several projects at once — a custom dashboard's scope. People assigned to ANY of them, and
   *  only those projects' bookings, hours and tickets. Ignored when `projectId` is given. */
  projectIds?: string[];
  /** V12 7.3: also return the board grouped by project, people inside. */
  groupBy?: "project";
}): Promise<{ buckets: Bucket[]; rows: WorkloadRow[]; workingDays: number[]; groups?: WorkloadGroup[] }> {
  const projectScope: string[] | undefined = params.projectId ? [params.projectId] : params.projectIds;
  const settings = await getPlanningSettings();
  const workingDays = settings.workingDays;
  const buckets = buildBuckets(params.from, params.to, params.granularity ?? "week", workingDays);

  const people = await prisma.user.findMany({
    where: {
      deletedAt: null,
      status: "ACTIVE",
      // An AI teammate is an ACTIVE user row, so without this it appears here as a person with the
      // workspace's default capacity and nothing booked — a permanently idle colleague nobody hired.
      // The same exclusion `seat-count.service.ts` makes, for the same reason: an identity is not a
      // headcount. What agents actually did is a separate series — `loadAgentWorkload` below.
      isAgent: false,
      ...(params.userIds?.length ? { id: { in: params.userIds } } : {}),
      // Scoping by project means "people assigned to it", which is the same membership the
      // ticket-assignment rules already use — not "people who happen to have logged time",
      // which would make someone who helped out once look like a team member forever.
      ...(projectScope ? { projectAssignments: { some: { projectId: { in: projectScope } } } } : {})
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
  const [bookingRows, loggedRows, ticketRows] = await Promise.all([
    prisma.resourceBooking.findMany({
      where: {
        userId: { in: ids },
        ...(projectScope ? { projectId: { in: projectScope } } : {}),
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
        ...(projectScope ? { projectId: { in: projectScope } } : {})
      },
      select: { userId: true, workDate: true, totalHours: true, projectId: true }
    }),
    // V12 3.20: open tickets assigned to these people that touch the window — scheduled span
    // overlapping it, or SLA date inside it when unscheduled.
    prisma.ticket.findMany({
      where: {
        assigneeId: { in: ids },
        deletedAt: null,
        status: { notIn: [...CLOSED_FOR_LOAD] },
        ...(projectScope ? { projectId: { in: projectScope } } : {}),
        OR: [
          { startDate: { lte: params.to }, endDate: { gte: params.from } },
          { startDate: null, dueAt: { gte: params.from, lte: params.to } }
        ]
      },
      select: { assigneeId: true, startDate: true, endDate: true, dueAt: true, storyPoints: true, projectId: true }
    })
  ]);

  const capacityPeople: CapacityPerson[] = people.map((p) => ({
    id: p.id,
    name: p.name,
    email: p.email,
    avatarUrl: p.avatarUrl,
    weeklyCapacityHours: p.weeklyCapacityHours ? Number(p.weeklyCapacityHours) : null,
    plannedUtilizationPct: p.plannedUtilizationPct
  }));
  const logged = loggedRows.map((l) => ({ userId: l.userId, workDate: l.workDate, hours: Number(l.totalHours), projectId: l.projectId ?? null }));
  const tickets = ticketRows.map((t) => ({
    userId: t.assigneeId!,
    startDate: t.startDate,
    endDate: t.endDate,
    dueAt: t.dueAt,
    storyPoints: t.storyPoints === null ? null : Number(t.storyPoints),
    projectId: t.projectId
  }));
  const rows = buildWorkload({
    people: capacityPeople,
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
    logged,
    tickets,
    buckets,
    workingDays,
    defaultWeeklyCapacityHours: settings.defaultWeeklyCapacityHours
  });

  if (params.groupBy !== "project") return { buckets, rows, workingDays };

  // The projects on the board: every assignment of these people plus anything booked or
  // ticketed — then the names, in one query.
  const membership = await prisma.userProjectAssignment.findMany({
    where: { userId: { in: ids }, ...(projectScope ? { projectId: { in: projectScope } } : {}) },
    select: { userId: true, projectId: true }
  });
  const projectIds = new Set<string>(membership.map((m) => m.projectId));
  for (const b of bookingRows) if (b.projectId) projectIds.add(b.projectId);
  for (const t of tickets) projectIds.add(t.projectId);
  const projects = await prisma.project.findMany({
    where: { id: { in: [...projectIds] }, deletedAt: null },
    select: { id: true, code: true, name: true, color: true }
  });
  const groups = groupWorkloadByProject({
    projects,
    membership,
    people: capacityPeople,
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
    logged,
    tickets,
    buckets,
    workingDays,
    defaultWeeklyCapacityHours: settings.defaultWeeklyCapacityHours
  });
  return { buckets, rows, workingDays, groups };
}

/* ================================================================== *
 * The agent series
 * ================================================================== */

/**
 * What the AI teammates did over the same buckets — deliberately NOT as extra rows on the board above.
 *
 * WHY IT IS A SEPARATE SHAPE AND NOT A `WorkloadRow`: every column of that row is about capacity. An
 * agent has none — there is no weekly hours figure, no leave, and therefore no allocation percentage
 * that means anything. Rendering one anyway (100%? 0%?) would be inventing a number, and a board where
 * some rows' percentages mean a different thing from others is worse than a board with two sections.
 *
 * WHY THE HOURS COME FROM THE LEDGER AND NOT FROM `AgentRun`: the ledger is the place this product has
 * already decided agent work is recorded, with its duration, its cost, and — where the workspace's own
 * approved hours give a baseline — how much human work it stands in for. Reading run rows directly
 * would be a second definition of "what an agent did", and the first disagreement between them is a
 * number nobody can explain.
 */
export interface AgentWorkloadCell {
  bucketStart: string;
  /** Wall-clock hours the runs took. Not comparable to a person's logged hours and never summed with
   *  them — see the header. */
  workedHours: number;
  costUsd: number;
  /** Null when NO entry in this bucket had a measurable baseline. Zero would say "displaced nothing",
   *  which is a different claim from "we cannot tell". */
  displacedMinutes: number | null;
  runs: number;
}

export interface AgentWorkloadRow {
  agent: { id: string; name: string; avatarUrl: string | null };
  cells: AgentWorkloadCell[];
  totals: { workedHours: number; costUsd: number; displacedMinutes: number | null; runs: number; measuredRuns: number };
}

export async function loadAgentWorkload(params: { from: Date; to: Date; buckets: Bucket[]; projectId?: string }): Promise<AgentWorkloadRow[]> {
  // `from`/`to` are calendar DAYS (UTC midnight, from `toDay`) and `occurredAt` is a timestamp, so
  // the window is the instants those days begin and end on the platform's calendar. `lte: to` was
  // midnight UTC of the last day: every run after 05:30 IST on it was cut off the board.
  const entries = await prisma.agentWorkEntry.findMany({
    where: {
      occurredAt: { gte: platformDayStart(toDay(params.from)), lt: platformDayStart(addDays(toDay(params.to), 1)) },
      ...(params.projectId ? { projectId: params.projectId } : {})
    },
    select: { agentUserId: true, occurredAt: true, durationSeconds: true, costUsd: true, displacedMinutes: true }
  });
  if (entries.length === 0) return [];

  const agents = await prisma.user.findMany({
    where: { id: { in: [...new Set(entries.map((e) => e.agentUserId))] } },
    select: { id: true, name: true, avatarUrl: true }
  });
  const byId = new Map(agents.map((a) => [a.id, a]));

  /** Which bucket a moment falls in. The buckets are contiguous and ordered, so the last one whose
   *  start is not after the entry wins — the same rule the human side uses. */
  const bucketFor = (at: Date): string | null => {
    let found: string | null = null;
    // The run's day on the platform's calendar — a run at 01:00 IST on a Monday is Monday's work.
    const day = platformDayKey(at);
    for (const bucket of params.buckets) {
      if (day >= bucket.start) found = bucket.start;
      else break;
    }
    return found;
  };

  const rows = new Map<string, AgentWorkloadRow>();
  for (const entry of entries) {
    const agent = byId.get(entry.agentUserId);
    if (!agent) continue;
    let row = rows.get(agent.id);
    if (!row) {
      row = {
        agent,
        cells: params.buckets.map((b) => ({ bucketStart: b.start, workedHours: 0, costUsd: 0, displacedMinutes: null, runs: 0 })),
        totals: { workedHours: 0, costUsd: 0, displacedMinutes: null, runs: 0, measuredRuns: 0 }
      };
      rows.set(agent.id, row);
    }

    const key = bucketFor(entry.occurredAt);
    const cell = row.cells.find((c) => c.bucketStart === key);
    const cost = Number(entry.costUsd);
    const hours = entry.durationSeconds / 3600;

    row.totals.workedHours += hours;
    row.totals.costUsd += cost;
    row.totals.runs += 1;
    if (entry.displacedMinutes != null) {
      row.totals.displacedMinutes = (row.totals.displacedMinutes ?? 0) + entry.displacedMinutes;
      row.totals.measuredRuns += 1;
    }
    if (cell) {
      cell.workedHours += hours;
      cell.costUsd += cost;
      cell.runs += 1;
      if (entry.displacedMinutes != null) cell.displacedMinutes = (cell.displacedMinutes ?? 0) + entry.displacedMinutes;
    }
  }

  const round = (n: number) => Number(n.toFixed(2));
  return [...rows.values()]
    .map((row) => ({
      ...row,
      cells: row.cells.map((c) => ({ ...c, workedHours: round(c.workedHours), costUsd: Number(c.costUsd.toFixed(4)) })),
      totals: { ...row.totals, workedHours: round(row.totals.workedHours), costUsd: Number(row.totals.costUsd.toFixed(4)) }
    }))
    .sort((a, b) => b.totals.costUsd - a.totals.costUsd);
}
