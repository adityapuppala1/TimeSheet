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
 *   biometric swipe is still a day off. A HALF day of leave does not: the other half is owed, so
 *   the day is judged on its punch and only annotated (`leaveHalf`).
 * - ABSENT is only ever a verdict on a day that is OVER in the person's own timezone. Until then
 *   it is PENDING — at 09:05 nobody is absent, they are just not in yet. Deciding "over" on the
 *   server's clock is the exact bug utils/recipient-time.ts exists to close.
 *
 * WHY PURE: the inputs are four small facts (working days, the holiday if any, leave if any, the
 * record if any) plus the clock. Loading them is the caller's job; keeping I/O out makes the
 * timezone edge cases testable without a database (tests/unit/attendance-day-status.test.ts).
 */
import { zonedParts, zonedWallTimeToUtc } from "../utils/recipient-time.js";

export type AttendanceDayStatus = "WEEKEND" | "HOLIDAY" | "LEAVE" | "PRESENT" | "ABSENT" | "PENDING";

export interface DayStatusInput {
  /** The person's local calendar day being judged, `YYYY-MM-DD`. */
  dateKey: string;
  /** GlobalPlanningSettings.workingDays — 0 = Sunday … 6 = Saturday. */
  workingDays: readonly number[];
  /** The holiday on `dateKey` in the person's calendar, if any. */
  holiday: { name: string } | null;
  /**
   * Approved leave covering `dateKey` (Phase B). `half` absent or FULL = the whole day off. A HALF
   * day is still a working day: the person owes the other half, so it falls through to the punch
   * check and the result carries `leaveHalf` instead.
   */
  leave: { type: string; half?: "FULL" | "FIRST_HALF" | "SECOND_HALF" } | null;
  /** The AttendanceRecord for `dateKey`, from ANY source. */
  punchedIn: boolean;
  /** The clock, injected for tests. */
  now: Date;
  /** User.timezone; falls back to `fallbackZone`, then the server's zone (zonedParts' rules). */
  timeZone: string | null | undefined;
  fallbackZone?: string | null;
  /**
   * 7.0.0 shifts: the person's shift for `dateKey`, if one is assigned. When set it replaces the
   * workspace working days, and the day only turns ABSENT once the SHIFT has ended (for a night
   * shift that is the next calendar morning). Absent = the workspace day, exactly as before.
   */
  shift?: ShiftWindow | null;
}

/** A shift as the resolver needs it. Minutes from local midnight; end <= start means it crosses midnight. */
export interface ShiftWindow {
  startMinute: number;
  endMinute: number;
  breakMinutes: number;
  workingDays: readonly number[];
}

export function shiftCrossesMidnight(shift: Pick<ShiftWindow, "startMinute" | "endMinute">): boolean {
  return shift.endMinute <= shift.startMinute;
}

/** Paid minutes in one shift: its span (wrapping midnight when it crosses) minus the break, never below 0. */
export function shiftExpectedMinutes(shift: Pick<ShiftWindow, "startMinute" | "endMinute" | "breakMinutes">): number {
  const span = shiftCrossesMidnight(shift) ? shift.endMinute + 1440 - shift.startMinute : shift.endMinute - shift.startMinute;
  return Math.max(0, span - shift.breakMinutes);
}

function addDays(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The instant a shift that STARTS on `dateKey` ends, in the person's zone. */
export function shiftEndUtc(dateKey: string, shift: ShiftWindow, timeZone: string | null | undefined, fallbackZone?: string | null): Date {
  const endKey = shiftCrossesMidnight(shift) ? addDays(dateKey, 1) : dateKey;
  return zonedWallTimeToUtc(endKey, Math.floor(shift.endMinute / 60), shift.endMinute % 60, timeZone, fallbackZone);
}

/**
 * The work date a moment belongs to. Without a night shift that is just the local day. With one,
 * the work date is the day the shift STARTED: a 22:00-06:00 shift punched at 02:00 on the 24th is
 * the 23rd's shift. The split point is the middle of the off-shift gap, so an early arrival for
 * tonight still counts as tonight and a late leaver from last night still counts as last night.
 */
export function workDateKeyFor(now: Date, timeZone: string | null | undefined, fallbackZone?: string | null, shift?: ShiftWindow | null): string {
  const parts = zonedParts(now, timeZone, fallbackZone);
  if (!shift || !shiftCrossesMidnight(shift)) return parts.dateKey;
  // Minutes since local midnight (DST-day drift of an hour cannot move a mid-gap split point).
  const minute = Math.floor((now.getTime() - zonedWallTimeToUtc(parts.dateKey, 0, 0, timeZone, fallbackZone).getTime()) / 60000);
  const split = shift.endMinute + Math.floor((shift.startMinute - shift.endMinute) / 2);
  return minute < split ? addDays(parts.dateKey, -1) : parts.dateKey;
}

export interface DayStatusResult {
  status: AttendanceDayStatus;
  /** Whether a punch is expected on this day at all (false for weekend/holiday/leave). */
  isWorkingDay: boolean;
  holidayName: string | null;
  /** Set only when a HALF day of approved leave falls on this working day. */
  leaveHalf?: "FIRST_HALF" | "SECOND_HALF";
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
  const workingDays = input.shift ? input.shift.workingDays : input.workingDays;
  if (!workingDays.includes(weekdayOfDateKey(input.dateKey))) {
    return { status: "WEEKEND", isWorkingDay: false, holidayName: null };
  }
  if (input.holiday) {
    return { status: "HOLIDAY", isWorkingDay: false, holidayName: input.holiday.name };
  }
  const half = input.leave?.half;
  if (input.leave && (!half || half === "FULL")) {
    return { status: "LEAVE", isWorkingDay: false, holidayName: null };
  }
  // Spread only when set, so every full-day / no-leave result keeps its exact Phase A shape.
  const halfLeave = half === "FIRST_HALF" || half === "SECOND_HALF" ? { leaveHalf: half } : {};
  if (input.punchedIn) {
    return { status: "PRESENT", isWorkingDay: true, holidayName: null, ...halfLeave };
  }
  // YYYY-MM-DD keys compare correctly as strings. The day is over once the person's own "today"
  // has moved past it — so a day in the future is PENDING too, never ABSENT.
  if (input.shift) {
    const over = input.now.getTime() >= shiftEndUtc(input.dateKey, input.shift, input.timeZone, input.fallbackZone).getTime();
    return { status: over ? "ABSENT" : "PENDING", isWorkingDay: true, holidayName: null, ...halfLeave };
  }
  const today = todayKeyFor(input.now, input.timeZone, input.fallbackZone);
  return { status: input.dateKey < today ? "ABSENT" : "PENDING", isWorkingDay: true, holidayName: null, ...halfLeave };
}
