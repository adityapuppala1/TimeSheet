/**
 * WHAT: the single answer to "what was this person's day?" — WEEKEND, HOLIDAY, LEAVE, PRESENT,
 * ABSENT or PENDING — as one PURE function. Every attendance surface (the punch-in pop-up, the
 * 11:00 reminder, Team Activity, analytics) calls this rather than re-deriving the order.
 *
 * WHY THE ORDER IS FIXED (weekend → holiday → leave → punched in → absent):
 * - A weekend or holiday is not a day anyone owes a punch on, even if they punched in anyway, so
 *   those win over PRESENT. A punch on a holiday is still kept (the record is returned alongside)
 *   but the day is not a working day and must never count as one in a ratio.
 * - Leave (Phase B) sits ABOVE "punched in" for the same reason: an approved day off with a stray
 *   biometric swipe is still a day off.
 * - ABSENT is only ever a verdict on a day that is OVER in the person's own timezone. Until then
 *   it is PENDING — at 09:05 nobody is absent, they are just not in yet. Deciding "over" on the
 *   server's clock is the exact bug utils/recipient-time.ts exists to close.
 *
 * WHY PURE: the inputs are four small facts (working days, the holiday if any, leave if any, the
 * record if any) plus the clock. Loading them is the caller's job; keeping I/O out makes the
 * timezone edge cases testable without a database (tests/unit/attendance-day-status.test.ts).
 */
import { zonedParts } from "../utils/recipient-time.js";

export type AttendanceDayStatus = "WEEKEND" | "HOLIDAY" | "LEAVE" | "PRESENT" | "ABSENT" | "PENDING";

export interface DayStatusInput {
  /** The person's local calendar day being judged, `YYYY-MM-DD`. */
  dateKey: string;
  /** GlobalPlanningSettings.workingDays — 0 = Sunday … 6 = Saturday. */
  workingDays: readonly number[];
  /** The holiday on `dateKey` in the person's calendar, if any. */
  holiday: { name: string } | null;
  /** Approved leave covering `dateKey`. Always null until Phase B wires findLeaveForDay. */
  leave: { type: string } | null;
  /** The AttendanceRecord for `dateKey`, from ANY source. */
  punchedIn: boolean;
  /** The clock, injected for tests. */
  now: Date;
  /** User.timezone; falls back to `fallbackZone`, then the server's zone (zonedParts' rules). */
  timeZone: string | null | undefined;
  fallbackZone?: string | null;
}

export interface DayStatusResult {
  status: AttendanceDayStatus;
  /** Whether a punch is expected on this day at all (false for weekend/holiday/leave). */
  isWorkingDay: boolean;
  holidayName: string | null;
}

/** Weekday of a calendar key. Computed at UTC noon so no zone or DST rule can move the day. */
export function weekdayOfDateKey(dateKey: string): number {
  return new Date(`${dateKey}T12:00:00Z`).getUTCDay();
}

/** The person's current local `YYYY-MM-DD`. */
export function todayKeyFor(now: Date, timeZone: string | null | undefined, fallbackZone?: string | null): string {
  return zonedParts(now, timeZone, fallbackZone).dateKey;
}

export function resolveDayStatus(input: DayStatusInput): DayStatusResult {
  if (!input.workingDays.includes(weekdayOfDateKey(input.dateKey))) {
    return { status: "WEEKEND", isWorkingDay: false, holidayName: null };
  }
  if (input.holiday) {
    return { status: "HOLIDAY", isWorkingDay: false, holidayName: input.holiday.name };
  }
  if (input.leave) {
    return { status: "LEAVE", isWorkingDay: false, holidayName: null };
  }
  if (input.punchedIn) {
    return { status: "PRESENT", isWorkingDay: true, holidayName: null };
  }
  // YYYY-MM-DD keys compare correctly as strings. The day is over once the person's own "today"
  // has moved past it — so a day in the future is PENDING too, never ABSENT.
  const today = todayKeyFor(input.now, input.timeZone, input.fallbackZone);
  return { status: input.dateKey < today ? "ABSENT" : "PENDING", isWorkingDay: true, holidayName: null };
}
