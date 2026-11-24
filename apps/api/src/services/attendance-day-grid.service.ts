/**
 * V17 integrations (7.0.0) — leave, holidays and attendance absence on the Home dashboard and the
 * Reports page. "What was each visible person's day, for every day in a window?"
 *
 * NOTHING HERE DECIDES A STATUS. Each day goes through the shared pure resolver
 * (attendance-day-status.ts), holidays through attendance-team.service.ts#loadHolidays and approved
 * leave through leave-query.service.ts#loadApprovedLeave — the same three every other attendance
 * surface reads, so the dashboard can never disagree with Team Activity about a day.
 *
 * GATE: the module is on when attendance (toggle AND plan) or leave (toggle AND plan) is on. With
 * both off the answer is `{ enabled: false }` and no other table is read. With leave on but
 * attendance off there is no punch to judge, so a working day is never called ABSENT or PRESENT:
 * it is PENDING ("no attendance verdict"), and the client draws it exactly as it does today.
 *
 * WHO: the dashboard's own scope (team-scope.service.ts#teamScopeUserIds) — users:manage sees
 * everyone, anyone else sees themselves plus their direct reports — so the grid's rows and the
 * statuses on them come from one rule.
 *
 * PRIVACY: the leave TYPE (code and name) and the half only. Never a reason, a decision note, an
 * attachment, or a coordinate: the records query selects userId and workDate and nothing else.
 *
 * NO N+1: people once, then one query per fact (holidays, leave, leave-type names, records,
 * timesheet hours) for everyone at once.
 */
import { prisma } from "../config/prisma.js";
import { serverTimezone } from "../config/env.js";
import { AppError } from "../middleware/error.js";
import { getPlanningSettings } from "./planning.service.js";
import { resolveDayStatus, type AttendanceDayStatus } from "./attendance-day-status.js";
import { isAttendanceOn } from "./attendance-punch.service.js";
import { loadHolidays } from "./attendance-team.service.js";
import { loadApprovedLeave } from "./leave-query.service.js";
import { isLeaveOn } from "./leave.service.js";
import { teamScopeUserIds } from "./team-scope.service.js";

export const MAX_GRID_DAYS = 93;
const DAY_MS = 86_400_000;

export interface GridDay {
  status: AttendanceDayStatus;
  holidayName?: string;
  leaveTypeCode?: string;
  leaveTypeName?: string;
  /** Set only for a half day of approved leave on a working day. */
  halfDay?: "FIRST_HALF" | "SECOND_HALF";
}

export interface GridSummary {
  /** Workspace working days in the window that are not a holiday for this person (leave included). */
  workingDays: number;
  holidays: number;
  /** Leave days by type code; a half day counts 0.5. */
  leaveDays: Record<string, number>;
  presentDays: number;
  absentDays: number;
  loggedHours: number;
}

export interface GridPerson {
  userId: string;
  name: string;
  days: Record<string, GridDay>;
  summary: GridSummary;
}

export type DayGridResponse =
  | { enabled: false }
  | {
      enabled: true;
      attendanceEnabled: boolean;
      leaveEnabled: boolean;
      from: string;
      to: string;
      leaveTypes: Array<{ code: string; name: string }>;
      people: GridPerson[];
    };

/** One resolved day as the client sees it, folded into the person's summary. */
function gridDayOf(
  r: ReturnType<typeof resolveDayStatus>,
  leave: { type: string } | null,
  attendanceEnabled: boolean,
  summary: GridSummary,
  usedCodes: Set<string>
): GridDay {
  // Leave on with attendance off: no punch exists to judge, so no ABSENT / PRESENT verdict.
  const noVerdict = !attendanceEnabled && (r.status === "ABSENT" || r.status === "PRESENT");
  const status: AttendanceDayStatus = noVerdict ? "PENDING" : r.status;
  const day: GridDay = { status };
  if (status === "HOLIDAY" && r.holidayName) {
    day.holidayName = r.holidayName;
    summary.holidays += 1;
  }
  if (leave && (status === "LEAVE" || r.leaveHalf)) {
    day.leaveTypeCode = leave.type;
    usedCodes.add(leave.type);
    if (r.leaveHalf) day.halfDay = r.leaveHalf;
    summary.leaveDays[leave.type] = (summary.leaveDays[leave.type] ?? 0) + (r.leaveHalf ? 0.5 : 1);
  }
  // Working days = the calendar's working days minus holidays; leave is taken OUT of them.
  if (status !== "WEEKEND" && status !== "HOLIDAY") summary.workingDays += 1;
  if (status === "PRESENT") summary.presentDays += 1;
  if (status === "ABSENT") summary.absentDays += 1;
  return day;
}

function dateKeys(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/** Query-string window, coerced here because validate() discards its parse. */
export function parseGridRange(query: Record<string, unknown>): { from: string; to: string } {
  const from = typeof query.from === "string" ? query.from.slice(0, 10) : "";
  const to = typeof query.to === "string" ? query.to.slice(0, 10) : "";
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!iso.test(from) || !iso.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
    throw new AppError(422, "Send `from` and `to` as YYYY-MM-DD.");
  }
  if (to < from) throw new AppError(422, "`to` must be on or after `from`.");
  if ((Date.parse(to) - Date.parse(from)) / DAY_MS + 1 > MAX_GRID_DAYS) throw new AppError(422, `Ask for at most ${MAX_GRID_DAYS} days at a time.`);
  return { from, to };
}

export async function getDayGrid(
  actor: { id: string; permissions: string[] },
  range: { from: string; to: string },
  now: Date = new Date()
): Promise<DayGridResponse> {
  const [attendanceEnabled, leaveEnabled] = await Promise.all([isAttendanceOn(), isLeaveOn()]);
  if (!attendanceEnabled && !leaveEnabled) return { enabled: false };

  const scoped = await teamScopeUserIds(actor);
  const people = await prisma.user.findMany({
    where: { id: scoped, deletedAt: null, status: "ACTIVE", isAgent: false },
    select: { id: true, name: true, timezone: true, holidayCalendarId: true },
    orderBy: { name: "asc" },
    take: 5000
  });
  const ids = people.map((p) => p.id);
  const { from, to } = range;
  const fromDate = new Date(`${from}T00:00:00Z`);
  const toDate = new Date(`${to}T00:00:00Z`);

  const [planning, holidayOf, leaveOf, records, sheets] = await Promise.all([
    getPlanningSettings(),
    loadHolidays(people.map((p) => p.holidayCalendarId), from, to),
    // loadApprovedLeave gates on the toggle only; the plan half is isLeaveOn above.
    leaveEnabled ? loadApprovedLeave(ids, from, to) : Promise.resolve(() => null),
    attendanceEnabled && ids.length
      ? prisma.attendanceRecord.findMany({ where: { userId: { in: ids }, workDate: { gte: fromDate, lte: toDate } }, select: { userId: true, workDate: true } })
      : Promise.resolve([] as Array<{ userId: string; workDate: Date }>),
    ids.length
      ? prisma.timesheet.findMany({
          where: { userId: { in: ids }, deletedAt: null, workDate: { gte: fromDate, lte: toDate } },
          select: { userId: true, totalHours: true }
        })
      : Promise.resolve([] as Array<{ userId: string; totalHours: unknown }>)
  ]);

  const punched = new Set(records.map((r) => `${r.userId}|${r.workDate.toISOString().slice(0, 10)}`));
  const hoursBy = new Map<string, number>();
  for (const s of sheets) hoursBy.set(s.userId, (hoursBy.get(s.userId) ?? 0) + Number(s.totalHours ?? 0));

  const keys = dateKeys(from, to);
  const usedCodes = new Set<string>();
  const out: GridPerson[] = people.map((p) => {
    const days: Record<string, GridDay> = {};
    const summary: GridSummary = { workingDays: 0, holidays: 0, leaveDays: {}, presentDays: 0, absentDays: 0, loggedHours: 0 };
    for (const key of keys) {
      const holiday = holidayOf(p.holidayCalendarId, key);
      const leave = leaveOf(p.id, key);
      const r = resolveDayStatus({
        dateKey: key,
        workingDays: planning.workingDays,
        holiday,
        leave,
        punchedIn: punched.has(`${p.id}|${key}`),
        now,
        timeZone: p.timezone,
        fallbackZone: serverTimezone
      });
      days[key] = gridDayOf(r, leave, attendanceEnabled, summary, usedCodes);
    }
    summary.loggedHours = Math.round((hoursBy.get(p.id) ?? 0) * 100) / 100;
    return { userId: p.id, name: p.name, days, summary };
  });

  const types = usedCodes.size
    ? await prisma.leaveType.findMany({ where: { code: { in: [...usedCodes] } }, select: { code: true, name: true } })
    : [];
  const nameOf = new Map(types.map((t) => [t.code, t.name]));
  for (const person of out) {
    for (const day of Object.values(person.days)) {
      if (day.leaveTypeCode) day.leaveTypeName = nameOf.get(day.leaveTypeCode) ?? day.leaveTypeCode;
    }
  }

  return {
    enabled: true,
    attendanceEnabled,
    leaveEnabled,
    from,
    to,
    leaveTypes: [...usedCodes].sort().map((code) => ({ code, name: nameOf.get(code) ?? code })),
    people: out
  };
}
