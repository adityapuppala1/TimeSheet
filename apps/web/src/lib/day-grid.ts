/**
 * 7.0.0 — leave, holidays and attendance on the Home dashboard's "Daily logging status" grid and
 * day timeline. Pure helpers, so the state mapping and the gap arithmetic are unit-tested without
 * rendering (tests: lib/day-grid.test.ts).
 *
 * THE RULE THAT MATTERS: a leave or holiday day is not a day anyone owed a timesheet on, so it is
 * never a gap, never in the "x/y" denominator and never in Plan hours. A HALF day of leave is still
 * a working day (the other half is owed): it stays in the denominator and plans 4h instead of 8h.
 *
 * With the module off there is no lookup, every helper here answers exactly what the grid computed
 * before 7.0.0, and the grid renders byte-for-byte what it did.
 */
import type { DayGridDay, DayGridResponse } from "../services/attendance-api";

export interface DayStatusLookup {
  attendanceEnabled: boolean;
  get(userId: string, dateKey: string): DayGridDay | undefined;
}

/** The lookup for an enabled response; undefined with the module off (the grid then ignores it). */
export function dayStatusLookup(res: DayGridResponse | undefined): DayStatusLookup | undefined {
  if (!res || !res.enabled) return undefined;
  const byUser = new Map(res.people.map((p) => [p.userId, p.days]));
  return { attendanceEnabled: res.attendanceEnabled, get: (userId, dateKey) => byUser.get(userId)?.[dateKey] };
}

export type GridCellState = "filled" | "missing" | "off" | "upcoming" | "leave" | "holiday";

/** Full-day leave or a holiday: a day nobody owed a timesheet on. */
export function isDayOff(day: DayGridDay | undefined): boolean {
  return day?.status === "LEAVE" || day?.status === "HOLIDAY";
}

/**
 * The cell's state. Anything logged is green whatever the day was (the popover then mentions the
 * leave or holiday); otherwise leave and holiday win over every other state, future days included.
 */
export function gridCellState(col: { expected: boolean; upcoming: boolean }, entryCount: number, day?: DayGridDay): GridCellState {
  if (entryCount > 0) return "filled";
  if (day?.status === "HOLIDAY") return "holiday";
  if (day?.status === "LEAVE") return "leave";
  if (col.upcoming) return "upcoming";
  return col.expected ? "missing" : "off";
}

/** A missed working day where attendance is on and nobody punched in. */
export function isAbsentMarker(state: GridCellState, day: DayGridDay | undefined, lookup: DayStatusLookup | undefined): boolean {
  return state === "missing" && Boolean(lookup?.attendanceEnabled) && day?.status === "ABSENT";
}

export interface DayTally {
  filledDays: number;
  expectedDays: number;
  gapDays: number;
  /** Planned hours: 8h per owed working day, 4h for a half day of leave. */
  plannedHours: number;
  /** Full days of leave or holiday that fell on working days already past or due. */
  offDays: number;
}

/** One person's totals over the columns. Without a lookup: exactly the pre-7.0.0 arithmetic. */
export function tallyPerson(
  cols: ReadonlyArray<{ key: string; expected: boolean; upcoming: boolean }>,
  entriesOn: (key: string) => number,
  dayOf: (key: string) => DayGridDay | undefined,
  hoursPerDay: number
): DayTally {
  const t: DayTally = { filledDays: 0, expectedDays: 0, gapDays: 0, plannedHours: 0, offDays: 0 };
  for (const c of cols) {
    const filled = entriesOn(c.key) > 0;
    if (filled) t.filledDays += 1;
    if (!c.expected || c.upcoming) continue;
    const day = dayOf(c.key);
    if (isDayOff(day)) {
      t.offDays += 1;
      continue;
    }
    t.expectedDays += 1;
    t.plannedHours += day?.halfDay ? hoursPerDay / 2 : hoursPerDay;
    if (!filled) t.gapDays += 1;
  }
  return t;
}

const HALF_WORDS = { FIRST_HALF: "first half", SECOND_HALF: "second half" } as const;

/** One sentence for the popover / accessible name; empty when there is nothing to add. */
/** " · text" when there is text, else "". */
const dot = (text: string | null | undefined): string => (text ? " · " + text : "");

export function dayNote(day: DayGridDay | undefined, absent: boolean, logged: boolean): string {
  if (!day) return "";
  const type = day.leaveTypeName && day.leaveTypeName !== day.leaveTypeCode ? `${day.leaveTypeName} (${day.leaveTypeCode})` : (day.leaveTypeCode ?? "");
  const extra = logged ? " Time was still logged on this day." : "";
  if (day.status === "HOLIDAY") return `Holiday${dot(day.holidayName)}.${extra}`;
  if (day.status === "LEAVE") return `On leave${dot(type)}.${extra}`;
  if (day.halfDay) return `Half-day leave${dot(type)}, ${HALF_WORDS[day.halfDay]}.`;
  if (absent) return "Did not punch in.";
  return "";
}

/** The timeline lane's small label: "On leave · PL", "Holiday · Diwali", "Not punched in". */
export function laneLabel(day: DayGridDay | undefined, attendanceEnabled: boolean): string | null {
  if (!day) return null;
  if (day.status === "LEAVE") return `On leave${dot(day.leaveTypeCode)}`;
  if (day.status === "HOLIDAY") return `Holiday${dot(day.holidayName)}`;
  if (day.halfDay) return `Half-day leave${dot(day.leaveTypeCode)}`;
  if (attendanceEnabled && day.status === "ABSENT") return "Not punched in";
  return null;
}

/** The dashboard asks for at most the server's 93-day window: the newest end of the range. */
export function clampGridRange(from: string, to: string, maxDays = 93): { from: string; to: string } {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  const earliest = end - (maxDays - 1) * 86_400_000;
  return { from: start < earliest ? new Date(earliest).toISOString().slice(0, 10) : from, to };
}
