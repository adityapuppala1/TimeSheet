/**
 * V17 Phase B — expected hours and capacity, now that approved leave and holidays are real data.
 *
 *   expected hours = (working days − holidays − leave days) × daily hours
 *   daily hours    = weeklyCapacityHours ÷ the workspace's working days per week
 * with a half day of leave counting 0.5 (leave-calc.ts#expectedHours is the arithmetic).
 *
 * WHO READS THIS:
 *   - GET /api/leave/me/expected-hours (dashboard / digest consumers);
 *   - the capacity board (workload.service.ts) and the utilisation table
 *     (timesheet-analytics.service.ts): approved leave and holidays now reduce what is AVAILABLE,
 *     without anyone having to mirror leave as an `isTimeOff` booking.
 *
 * NO DOUBLE COUNTING: a workspace that already books leave as `isTimeOff` and now also approves it
 * here must not lose the day twice. mergedTimeOffHours takes, per day, the LARGER of the booked
 * time off and the absence — never the sum. isTimeOff bookings keep working exactly as before for
 * anyone with no approved leave.
 */
import { prisma } from "../config/prisma.js";
import { getAttendanceSettings } from "./attendance-settings.service.js";
import { loadHolidays } from "./attendance-team.service.js";
import { getPlanningSettings } from "./planning.service.js";
import { addDaysKey, expectedHours, type ExpectedHours } from "./leave-calc.js";
import { leaveFractionOf, loadApprovedLeave } from "./leave-query.service.js";

export interface AbsencePerson {
  id: string;
  holidayCalendarId: string | null;
  /** Null = the workspace default. */
  weeklyCapacityHours: number | null;
}

/** Hours unavailable per person per day (holiday = a full day, leave = its fraction). */
export type AbsenceMap = Map<string, Map<string, number>>;

const weekday = (key: string) => new Date(`${key}T12:00:00Z`).getUTCDay();
const r2 = (n: number) => Math.round(n * 100) / 100;

function workingDayKeys(from: string, to: string, workingDays: readonly number[]): string[] {
  const keys: string[] = [];
  for (let d = from; d <= to; d = addDaysKey(d, 1)) if (workingDays.includes(weekday(d))) keys.push(d);
  return keys;
}

export async function absenceByPerson(
  people: readonly AbsencePerson[],
  from: string,
  to: string,
  workingDays: readonly number[],
  defaultWeeklyCapacityHours: number
): Promise<AbsenceMap> {
  const out: AbsenceMap = new Map();
  if (people.length === 0 || to < from) return out;
  // Holidays and leave are Attendance & Leave data: a workspace that never switched either part on
  // keeps exactly the capacity it had (and pays one settings read, not two queries).
  const settings = await getAttendanceSettings();
  if (!settings?.attendanceEnabled && !settings?.leaveEnabled) return out;
  const [holidayOf, leaveOf] = await Promise.all([
    loadHolidays(people.map((p) => p.holidayCalendarId), from, to),
    loadApprovedLeave(people.map((p) => p.id), from, to)
  ]);
  const perWeek = workingDays.length || 5;
  for (const p of people) {
    const perDay = (p.weeklyCapacityHours ?? defaultWeeklyCapacityHours) / perWeek;
    const days = new Map<string, number>();
    for (const d of workingDayKeys(from, to, workingDays)) {
      const fraction = holidayOf(p.holidayCalendarId, d) ? 1 : leaveFractionOf(leaveOf, p.id, d);
      if (fraction > 0) days.set(d, r2(perDay * fraction));
    }
    if (days.size) out.set(p.id, days);
  }
  return out;
}

/**
 * Time off inside [from, to] for one person: per working day, the larger of what isTimeOff bookings
 * claim and what the absence map says. Pure.
 */
export function mergedTimeOffHours(
  bookings: ReadonlyArray<{ startDate: Date; endDate: Date; hoursPerDay: number }>,
  absence: Map<string, number> | undefined,
  from: string,
  to: string,
  workingDays: readonly number[]
): number {
  let total = 0;
  for (let d = from; d <= to; d = addDaysKey(d, 1)) {
    if (!workingDays.includes(weekday(d))) continue;
    let booked = 0;
    for (const b of bookings) {
      const s = b.startDate.toISOString().slice(0, 10);
      const e = b.endDate.toISOString().slice(0, 10);
      if (d >= s && d <= e) booked += b.hoursPerDay;
    }
    total += Math.max(booked, absence?.get(d) ?? 0);
  }
  return r2(total);
}

/** Expected hours per person over [from, to]. Three queries however many people. */
export async function expectedHoursFor(userIds: readonly string[], from: string, to: string): Promise<Map<string, ExpectedHours>> {
  const out = new Map<string, ExpectedHours>();
  if (userIds.length === 0 || to < from) return out;
  const [planning, people] = await Promise.all([
    getPlanningSettings(),
    prisma.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, holidayCalendarId: true, weeklyCapacityHours: true } })
  ]);
  const [holidayOf, leaveOf] = await Promise.all([
    loadHolidays(people.map((p) => p.holidayCalendarId), from, to),
    loadApprovedLeave(people.map((p) => p.id), from, to)
  ]);
  for (const p of people) {
    out.set(
      p.id,
      expectedHours({
        from,
        to,
        workingDays: planning.workingDays,
        isHoliday: (d) => Boolean(holidayOf(p.holidayCalendarId, d)),
        leaveFraction: (d) => leaveFractionOf(leaveOf, p.id, d),
        weeklyCapacityHours: p.weeklyCapacityHours != null ? Number(p.weeklyCapacityHours) : planning.defaultWeeklyCapacityHours
      })
    );
  }
  return out;
}
