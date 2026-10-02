/**
 * WHAT: what day it is for a given person — their `User.timezone`, falling back to the workspace
 * zone — in the two forms the timesheet code needs.
 *
 * WHY ONE HELPER: "did I log today" was answered three ways. `/reports/daily-status` used the
 * server's local date, the Inbox brief used the UTC date while claiming to match it, and the
 * future-date check on logging used the server's local date too. The server defaults to
 * Asia/Kolkata, so between 00:00 and 05:30 IST the brief asked about yesterday, and a New York user
 * on Friday evening could log Saturday because India had already reached it. The daily reminder
 * worker already asked the recipient's own clock (utils/recipient-time.ts); everything that asks
 * "today?" about a person now asks the same way.
 *
 * WHO CALLS THIS: controllers/timesheet.controller.ts (future-date check), controllers/
 * report.controller.ts (`/daily-status`), services/inbox.service.ts (the brief).
 */
import { prisma } from "../config/prisma.js";
import { serverTimezone } from "../config/env.js";
import { startOfZonedDayUtc, zonedTodayUtc } from "../utils/recipient-time.js";

export interface UserClock {
  /** Today as `workDate` stores it: UTC midnight of the person's local calendar day. */
  today: Date;
  /** The instant their local day began — what a "since this morning" `createdAt` filter compares against. */
  dayStart: Date;
}

export async function userClock(userId: string, now: Date = new Date()): Promise<UserClock> {
  const row = await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } });
  return {
    today: zonedTodayUtc(now, row?.timezone, serverTimezone),
    dayStart: startOfZonedDayUtc(now, row?.timezone, serverTimezone)
  };
}
