/**
 * 7.0.0 — workspace holidays for the workforce figures (admin-summary.service.ts).
 *
 * "Logging per working day" divided by every working weekday, so a public holiday on which nobody
 * logs read as a bad day. With Attendance & Leave on (toggle + plan) the DEFAULT calendar's
 * mandatory holidays on working weekdays are not working days. Off, this answers 0 and the figure
 * is exactly what it was. Optional holidays are a personal opt-in, so they stay working days here.
 */
import { prisma } from "../config/prisma.js";
import { attendanceOrLeaveOn } from "./leave-capacity.service.js";

/** Default-calendar mandatory holidays on a working weekday in [from, to] (UTC day keys). */
export async function defaultHolidayWorkingDays(from: Date, to: Date, workingDays: readonly number[]): Promise<number> {
  if (to < from || !(await attendanceOrLeaveOn())) return 0;
  const calendar = await prisma.holidayCalendar.findFirst({ where: { isDefault: true }, select: { id: true } });
  if (!calendar) return 0;
  const rows = await prisma.holiday.findMany({
    where: { calendarId: calendar.id, date: { gte: from, lte: to }, isOptional: false },
    select: { date: true }
  });
  const days = new Set(rows.filter((h) => workingDays.includes(h.date.getUTCDay())).map((h) => h.date.toISOString().slice(0, 10)));
  return days.size;
}
