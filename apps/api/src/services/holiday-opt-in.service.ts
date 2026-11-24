/**
 * 7.0.0 — optional holidays a person opts into.
 *
 * An optional (restricted) holiday is a WORKING day for everyone until they opt in; then it is a
 * holiday for them everywhere the day-status resolver runs (attendance-team.service.ts#loadHolidays
 * and attendance-punch.service.ts#findHoliday both read HolidayOptIn).
 *
 * RULES (all enforced here, the only writer):
 *   - Attendance & Leave on (toggle + plan); otherwise 403 like the rest of the module.
 *   - The holiday is optional and in the person's OWN calendar (their assigned one, else the default).
 *   - It has not passed yet (the person's own today). Opting out of a past day would rewrite history.
 *   - The calendar's maxOptionalPerYear caps opt-ins per calendar year; NULL means no cap, 0 means
 *     none may be taken. Checked under a row lock on the person so two quick taps cannot exceed it.
 */
import { effectiveCalendarId } from "./attendance-team.service.js";
import { prisma } from "../config/prisma.js";
import { serverTimezone } from "../config/env.js";
import { AppError } from "../middleware/error.js";
import { todayKeyFor } from "./attendance-day-status.js";
import { attendanceOrLeaveOn } from "./leave-capacity.service.js";
import { audit } from "./audit.service.js";

const key = (d: Date) => d.toISOString().slice(0, 10);

async function assertOn(): Promise<void> {
  if (!(await attendanceOrLeaveOn())) throw new AppError(403, "Attendance & Leave is off for this workspace.");
}

async function loadEligible(userId: string, holidayId: string, now: Date) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, timezone: true, holidayCalendarId: true } });
  if (!user) throw new AppError(404, "User not found");
  const calendarId = await effectiveCalendarId(user.holidayCalendarId, user.id);
  if (!calendarId) throw new AppError(404, "Holiday not found");
  const holiday = await prisma.holiday.findFirst({
    where: { id: holidayId, calendarId },
    select: { id: true, date: true, name: true, isOptional: true, calendar: { select: { id: true, maxOptionalPerYear: true } } }
  });
  // Not in their calendar reads as not found: it is not a holiday they can take.
  if (!holiday) throw new AppError(404, "Holiday not found");
  if (!holiday.isOptional) throw new AppError(422, `${holiday.name} is not optional; it is a holiday for everyone.`, { code: "HOLIDAY_NOT_OPTIONAL" });
  if (key(holiday.date) < todayKeyFor(now, user.timezone, serverTimezone)) {
    throw new AppError(409, `${holiday.name} has already passed.`, { code: "HOLIDAY_PASSED" });
  }
  return { user, holiday };
}

/** Pure: may one more optional holiday be taken, given the cap and how many are already taken? */
export function withinOptionalCap(max: number | null, taken: number): boolean {
  return max === null || taken < max;
}

export async function optInHoliday(userId: string, holidayId: string, now: Date = new Date()) {
  await assertOn();
  const { holiday } = await loadEligible(userId, holidayId, now);
  const year = holiday.date.getUTCFullYear();
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM \`User\` WHERE id = ${userId} FOR UPDATE`;
    const existing = await tx.holidayOptIn.findUnique({ where: { userId_holidayId: { userId, holidayId } } });
    if (existing) return { created: false };
    const taken = await tx.holidayOptIn.count({
      where: {
        userId,
        holiday: { calendarId: holiday.calendar.id, date: { gte: new Date(Date.UTC(year, 0, 1)), lte: new Date(Date.UTC(year, 11, 31)) } }
      }
    });
    if (!withinOptionalCap(holiday.calendar.maxOptionalPerYear, taken)) {
      const max = holiday.calendar.maxOptionalPerYear ?? 0;
      throw new AppError(409, `You can take ${max} optional ${max === 1 ? "holiday" : "holidays"} in ${year}, and you have taken ${taken}.`, {
        code: "OPTIONAL_HOLIDAY_LIMIT"
      });
    }
    await tx.holidayOptIn.create({ data: { userId, holidayId } });
    return { created: true };
  });
  if (result.created) await audit(userId, "attendance.optional_holiday_taken", "Holiday", holidayId, { date: key(holiday.date) });
  return { holidayId, optedIn: true, created: result.created };
}

export async function optOutHoliday(userId: string, holidayId: string, now: Date = new Date()) {
  await assertOn();
  const { holiday } = await loadEligible(userId, holidayId, now);
  const removed = await prisma.holidayOptIn.deleteMany({ where: { userId, holidayId } });
  if (removed.count > 0) await audit(userId, "attendance.optional_holiday_dropped", "Holiday", holidayId, { date: key(holiday.date) });
  return { holidayId, optedIn: false };
}
