/**
 * Team Activity (V17 A5) — "who is in today, and what did their day look like?"
 *
 * WHO SEES WHOM — the rule every route here applies, and the same shape standup.service.ts and
 * ticketProjectScope already use, so the workspace has one answer to "whose day may I read":
 *   - SUPER_ADMIN and ADMIN: everyone counted as a person (COUNTED_PEOPLE), with an optional
 *     manager filter.
 *   - MANAGER and TEAM_LEAD: their DIRECT reports (User.managerId = them). Not the whole subtree:
 *     the codebase has no "indirect reports" read scope anywhere (team.controller.ts, the stand-up
 *     picker and approvals all stop at direct reports), and attendance is not the place to widen it.
 *   - Everybody else: 403 on the team routes. Their own days are /me/history.
 * The timeline route re-checks the SAME rule for the one id it is asked about, so guessing another
 * person's id answers 403, never their history (IDOR).
 *
 * LOCATION PRIVACY: no route here returns a coordinate, to anyone. The team list carries a coarse
 * label only — "Location shared" when the punch carried a fix, "Network only" when it carried an IP
 * and nothing else, "Not captured" otherwise. Reverse geocoding would mean sending employees' GPS
 * to a third party, and a manager deciding "was this person in?" needs to know evidence exists, not
 * where someone's kitchen is. Raw coordinates stay in AttendanceRecord for the admin evidence path
 * that a later privacy setting may open; none exists yet, so none is served.
 *
 * NO N+1: the list loads its people once, then one query per FACT (records, holidays, timesheets,
 * reasons, reminder notifications) for every person at once, then joins in memory. The query count
 * is the same for 3 people and 3,000 (tests/unit/attendance-team.test.ts counts the calls).
 */
import type { AttendanceSourceKind, Prisma } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { serverTimezone } from "../config/env.js";
import { AppError } from "../middleware/error.js";
import { COUNTED_PEOPLE } from "./people-visibility.service.js";
import { getPlanningSettings } from "./planning.service.js";
import { resolveDayStatus, type AttendanceDayStatus } from "./attendance-day-status.js";
import { shiftsForUsers, type ResolvedShift } from "./attendance-shift.service.js";
import { findLeaveInRange } from "./attendance-punch.service.js";
import { halfLabel } from "./leave-calc.js";
import { getAttendanceSettings } from "./attendance-settings.service.js";

const UNRESTRICTED_ROLES = new Set(["SUPER_ADMIN", "ADMIN"]);
const MANAGING_ROLES = new Set(["MANAGER", "TEAM_LEAD"]);

const SOURCE_LABELS: Record<AttendanceSourceKind, string> = {
  WEB: "Web",
  API: "API",
  WEBHOOK: "Integration",
  MCP: "AI assistant",
  CSV: "Import",
  REGULARIZATION: "Correction"
};

/** The audit actions that mean "this person signed in". Written by auth.service.ts. */
export const LOGIN_ACTIONS = ["auth.login_succeeded", "auth.sso_login"] as const;
/** Timesheet audit actions shown on the timeline (create = draft/submitted, then edits). */
const TIMESHEET_ACTIONS = ["timesheet.draft", "timesheet.submitted", "timesheet.updated"] as const;

const DAY_MS = 86_400_000;
/** A zone can be up to 14h either side of UTC, so a local day's instants live in this UTC window. */
const ZONE_SLACK_MS = 14 * 3_600_000;
export const MAX_TIMELINE_DAYS = 31;
export const MAX_HISTORY_DAYS = 93;

export interface TeamScope {
  unrestricted: boolean;
}

/** Whether `role` may open Team Activity at all. Pure. */
export function teamScopeFor(role: string): TeamScope | null {
  if (UNRESTRICTED_ROLES.has(role)) return { unrestricted: true };
  if (MANAGING_ROLES.has(role)) return { unrestricted: false };
  return null;
}

export function assertTeamScope(role: string): TeamScope {
  const scope = teamScopeFor(role);
  if (!scope) throw new AppError(403, "Team attendance is available to managers, team leads and admins.");
  return scope;
}

/** The people `actorId` may see, as a Prisma filter. */
export function peopleWhere(scope: TeamScope, actorId: string, managerFilter?: string | null): Prisma.UserWhereInput {
  if (scope.unrestricted) return { ...COUNTED_PEOPLE, ...(managerFilter ? { managerId: managerFilter } : {}) };
  return { ...COUNTED_PEOPLE, managerId: actorId };
}

/** 7.0.0: a matched work site ("At Head office" / "Outside work sites") is said instead, when there is one. */
export type LocationLabel = "Location shared" | "Network only" | "Not captured" | (string & {});

/** The coarse label a manager sees instead of a coordinate. Pure. */
export function locationLabel(record: { lat: unknown; lng: unknown; ip: string | null; siteLabel?: string | null }): LocationLabel {
  if (record.siteLabel) return record.siteLabel;
  if (record.lat != null && record.lng != null) return "Location shared";
  if (record.ip) return "Network only";
  return "Not captured";
}

export type FaceResult = "PASSED" | "FLAGGED" | "NONE";

export function faceResult(record: { faceAttemptId: string | null; flagged: boolean }): FaceResult {
  if (record.flagged) return "FLAGGED";
  return record.faceAttemptId ? "PASSED" : "NONE";
}

export type TimesheetDayState = "SUBMITTED" | "DRAFT" | "NONE";

/** One day's entries folded to a single state: anything past draft counts as submitted. Pure. */
export function timesheetDayState(statuses: readonly string[]): TimesheetDayState {
  if (statuses.length === 0) return "NONE";
  return statuses.some((s) => s !== "DRAFT") ? "SUBMITTED" : "DRAFT";
}

function dayStart(dateKey: string): Date {
  return new Date(`${dateKey}T00:00:00Z`);
}

function addDays(dateKey: string, days: number): string {
  return new Date(dayStart(dateKey).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Holidays for a set of calendars over a date range, keyed `calendarId|dateKey`. Two queries at most.
 *
 * 7.0.0 OPTIONAL HOLIDAYS: an optional holiday is a holiday only for a person who opted into it
 * (HolidayOptIn). Pass that person's id as the third argument; without it — or without an opt-in —
 * an optional holiday is a working day. Mandatory holidays are unchanged.
 */
export async function loadHolidays(calendarIds: Array<string | null>, from: string, to: string) {
  const defaultId = calendarIds.some((id) => !id)
    ? ((await prisma.holidayCalendar.findFirst({ where: { isDefault: true }, select: { id: true } }))?.id ?? null)
    : null;
  const ids = [...new Set(calendarIds.map((id) => id ?? defaultId).filter((id): id is string => Boolean(id)))];
  const rows = ids.length
    ? await prisma.holiday.findMany({
        where: { calendarId: { in: ids }, date: { gte: dayStart(from), lte: dayStart(to) } },
        select: { id: true, calendarId: true, date: true, name: true, isOptional: true }
      })
    : [];
  const optionalIds = rows.filter((h) => h.isOptional).map((h) => h.id);
  const optIns = optionalIds.length
    ? await prisma.holidayOptIn.findMany({ where: { holidayId: { in: optionalIds } }, select: { userId: true, holidayId: true } })
    : [];
  const optedIn = new Set(optIns.map((o) => `${o.userId}|${o.holidayId}`));
  const map = new Map(rows.map((h) => [`${h.calendarId}|${h.date.toISOString().slice(0, 10)}`, h]));
  return (calendarId: string | null, dateKey: string, userId?: string) => {
    const h = map.get(`${calendarId ?? defaultId}|${dateKey}`);
    if (!h) return null;
    if (h.isOptional && !(userId && optedIn.has(`${userId}|${h.id}`))) return null;
    return { name: h.name };
  };
}

export interface TeamTodayQuery {
  date: string;
  search?: string;
  status?: AttendanceDayStatus;
  source?: AttendanceSourceKind;
  managerId?: string | null;
  page: number;
  pageSize: number;
}

export interface TeamTodayRow {
  user: { id: string; name: string; email: string; avatarUrl: string | null; title: string };
  status: AttendanceDayStatus;
  holidayName: string | null;
  /** Approved leave on the day (Phase B): the type code and FULL or the half taken. */
  leave: { type: string; half: "FULL" | "FIRST_HALF" | "SECOND_HALF" } | null;
  punch: {
    punchInAt: string;
    source: AttendanceSourceKind;
    sourceLabel: string;
    location: LocationLabel;
    face: FaceResult;
  } | null;
  timesheet: { state: TimesheetDayState; hours: number };
  missedReason: { code: string; note: string | null } | null;
  reminderSent: boolean;
}

export type StatusSummary = Record<AttendanceDayStatus, number>;

function emptySummary(): StatusSummary {
  return { PRESENT: 0, PENDING: 0, ABSENT: 0, HOLIDAY: 0, WEEKEND: 0, LEAVE: 0 };
}

/** PRESENT rows whose punch-in is after the expected start, in the person's own zone. Pure. */
export function countLate(
  localMinuteOf: (instant: Date, zone: string | null) => number,
  rows: ReadonlyArray<Pick<TeamTodayRow, "status" | "punch" | "user">>,
  zoneOf: ReadonlyMap<string, string | null>,
  expectedStartMinute: number | ((userId: string) => number)
): number {
  const startOf = typeof expectedStartMinute === "number" ? () => expectedStartMinute : expectedStartMinute;
  let n = 0;
  for (const r of rows) {
    if (r.status !== "PRESENT" || !r.punch) continue;
    // A night shift's start is in the evening; a punch after midnight is minutes past 1440 of its start day.
    let minute = localMinuteOf(new Date(r.punch.punchInAt), zoneOf.get(r.user.id) ?? null);
    const start = startOf(r.user.id);
    if (start >= 720 && minute < start - 720) minute += 1440;
    if (minute > start) n += 1;
  }
  return n;
}

export async function getTeamDay(actor: { id: string; role: string }, query: TeamTodayQuery, now: Date = new Date()) {
  const scope = assertTeamScope(actor.role);
  const where = peopleWhere(scope, actor.id, query.managerId);
  const term = query.search?.trim();
  if (term) where.OR = [{ name: { contains: term } }, { email: { contains: term } }];

  const people = await prisma.user.findMany({
    where,
    select: { id: true, name: true, email: true, avatarUrl: true, timezone: true, holidayCalendarId: true, managerId: true, role: { select: { name: true } } },
    orderBy: { name: "asc" },
    take: 5000
  });
  const ids = people.map((p) => p.id);
  const workDate = dayStart(query.date);
  const windowFrom = new Date(workDate.getTime() - ZONE_SLACK_MS);
  const windowTo = new Date(workDate.getTime() + DAY_MS + ZONE_SLACK_MS);

  const [planning, holidayOf, leaveOf, records, sheets, reasons, reminders] = ids.length
    ? await Promise.all([
        getPlanningSettings(),
        loadHolidays(people.map((p) => p.holidayCalendarId), query.date, query.date),
        findLeaveInRange(ids, query.date, query.date),
        prisma.attendanceRecord.findMany({
          where: { userId: { in: ids }, workDate },
          select: { userId: true, punchInAt: true, source: true, lat: true, lng: true, ip: true, faceAttemptId: true, flagged: true, siteLabel: true, sourceRef: { select: { name: true } } }
        }),
        prisma.timesheet.findMany({ where: { userId: { in: ids }, workDate }, select: { userId: true, status: true, totalHours: true } }),
        prisma.missedDayReason.findMany({ where: { userId: { in: ids }, workDate }, select: { userId: true, reasonCode: true, note: true } }),
        prisma.notification.findMany({
          where: { userId: { in: ids }, category: "reminder.punch_in", createdAt: { gte: windowFrom, lt: windowTo } },
          select: { userId: true, body: true }
        })
      ])
    : [null, null, null, [], [], [], []];

  // 7.0.0: each person's shift on this work date (missing = the workspace day).
  const shiftOf = ids.length ? await shiftsForUsers(people, query.date) : new Map<string, ResolvedShift>();
  const recordBy = new Map(records.map((r) => [r.userId, r]));
  const reasonBy = new Map(reasons.map((r) => [r.userId, r]));
  // The reminder names its own date in the body (daily-reminder.worker.ts), which is what ties a
  // notification to THIS local day rather than the neighbouring one inside the UTC slack window.
  const remindedIds = new Set(reminders.filter((n) => n.body.includes(query.date)).map((n) => n.userId));
  const sheetsBy = new Map<string, { statuses: string[]; hours: number }>();
  for (const s of sheets) {
    const entry = sheetsBy.get(s.userId) ?? { statuses: [], hours: 0 };
    entry.statuses.push(s.status);
    entry.hours += Number(s.totalHours);
    sheetsBy.set(s.userId, entry);
  }

  const all: TeamTodayRow[] = people.map((p) => {
    const record = recordBy.get(p.id);
    const day = resolveDayStatus({
      dateKey: query.date,
      workingDays: planning?.workingDays ?? [1, 2, 3, 4, 5],
      holiday: holidayOf ? holidayOf(p.holidayCalendarId, query.date, p.id) : null,
      leave: leaveOf ? leaveOf(p.id, query.date) : null,
      punchedIn: Boolean(record),
      now,
      timeZone: p.timezone,
      fallbackZone: serverTimezone,
      shift: shiftOf.get(p.id) ?? null
    });
    const sheet = sheetsBy.get(p.id);
    const reason = reasonBy.get(p.id);
    const leave = leaveOf ? leaveOf(p.id, query.date) : null;
    return {
      user: { id: p.id, name: p.name, email: p.email, avatarUrl: p.avatarUrl, title: p.role.name },
      status: day.status,
      holidayName: day.holidayName,
      leave: leave ? { type: leave.type, half: leave.half ?? "FULL" } : null,
      punch: record
        ? {
            punchInAt: record.punchInAt.toISOString(),
            source: record.source,
            sourceLabel: record.sourceRef?.name ?? SOURCE_LABELS[record.source],
            location: locationLabel(record),
            face: faceResult(record)
          }
        : null,
      timesheet: { state: timesheetDayState(sheet?.statuses ?? []), hours: Math.round((sheet?.hours ?? 0) * 100) / 100 },
      missedReason: reason ? { code: reason.reasonCode, note: reason.note } : null,
      reminderSent: remindedIds.has(p.id)
    };
  });

  // The summary counts the whole visible team for the day, before the status/source filter — the
  // chips are how someone picks a filter, so they must not shrink to the one they picked.
  const summary = emptySummary();
  for (const row of all) summary[row.status] += 1;
  // Late is counted here over EVERYONE in scope (not just the page the client holds), in each
  // person's own zone, and only when an admin switched lateness on. Like the board it respects the
  // source filter (not the status one), so the tile equals what clicking it shows.
  const settings = ids.length ? await getAttendanceSettings() : null;
  const zoneOf = new Map(people.map((p) => [p.id, p.timezone]));
  const lateRows = query.source ? all.filter((row) => row.punch?.source === query.source) : all;
  let late: number | null = null;
  if (settings?.latenessEnabled) {
    const { localMinuteOf } = await import("./attendance-analytics.service.js");
    const workspaceStart = settings.expectedStartMinute ?? 600;
    late = countLate(localMinuteOf, lateRows, zoneOf, (userId) => shiftOf.get(userId)?.startMinute ?? workspaceStart);
  }

  const filtered = all.filter(
    (row) => (!query.status || row.status === query.status) && (!query.source || row.punch?.source === query.source)
  );
  const start = (query.page - 1) * query.pageSize;
  return {
    date: query.date,
    summary,
    late,
    total: filtered.length,
    page: query.page,
    pageSize: query.pageSize,
    rows: filtered.slice(start, start + query.pageSize)
  };
}

/** 403 when the person is not someone `actor` may see — and the SAME 403 when they do not exist,
 *  so probing ids reveals nothing about which ids are real. */
async function assertMaySee(actor: { id: string; role: string }, userId: string) {
  const scope = assertTeamScope(actor.role);
  const person = await prisma.user.findFirst({
    where: { id: userId, ...peopleWhere(scope, actor.id) },
    select: { id: true, name: true, email: true, timezone: true, holidayCalendarId: true }
  });
  if (!person) throw new AppError(403, "You can only view the attendance of people who report to you.");
  return person;
}

export type TimelineKind = "LOGIN" | "PUNCH_IN" | "TIMESHEET_CREATED" | "TIMESHEET_SUBMITTED" | "TIMESHEET_UPDATED" | "MISSED_REASON" | "REMINDER_EMAIL" | "LEAVE";

export interface TimelineEvent {
  kind: TimelineKind;
  at: string;
  label: string;
  detail: string | null;
}

/** Oldest first; ties keep their source order so a punch never jumps ahead of the login before it. */
export function mergeTimeline(events: TimelineEvent[]): TimelineEvent[] {
  return events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.at.localeCompare(b.e.at) || a.i - b.i)
    .map(({ e }) => e);
}

function timesheetKind(action: string): TimelineKind {
  if (action === "timesheet.submitted") return "TIMESHEET_SUBMITTED";
  if (action === "timesheet.updated") return "TIMESHEET_UPDATED";
  return "TIMESHEET_CREATED";
}

const TIMESHEET_LABELS: Record<string, string> = {
  TIMESHEET_CREATED: "Timesheet entry created",
  TIMESHEET_SUBMITTED: "Timesheet entry submitted",
  TIMESHEET_UPDATED: "Timesheet entry updated"
};

export async function getPersonTimeline(actor: { id: string; role: string }, userId: string, from: string, to: string) {
  const person = await assertMaySee(actor, userId);
  const fromAt = new Date(dayStart(from).getTime() - ZONE_SLACK_MS);
  const toAt = new Date(dayStart(to).getTime() + DAY_MS + ZONE_SLACK_MS);

  const [logins, records, sheetAudits, reasons, emails, leaveOf] = await Promise.all([
    prisma.auditLog.findMany({
      where: { actorId: userId, action: { in: [...LOGIN_ACTIONS] }, createdAt: { gte: fromAt, lt: toAt } },
      select: { action: true, createdAt: true },
      orderBy: { createdAt: "asc" },
      take: 500
    }),
    prisma.attendanceRecord.findMany({
      where: { userId, workDate: { gte: dayStart(from), lte: dayStart(to) } },
      select: { punchInAt: true, source: true, sourceRef: { select: { name: true } } }
    }),
    prisma.auditLog.findMany({
      where: { actorId: userId, entity: "Timesheet", action: { in: [...TIMESHEET_ACTIONS] }, createdAt: { gte: fromAt, lt: toAt } },
      select: { action: true, createdAt: true },
      orderBy: { createdAt: "asc" },
      take: 1000
    }),
    prisma.missedDayReason.findMany({
      where: { userId, workDate: { gte: dayStart(from), lte: dayStart(to) } },
      select: { workDate: true, reasonCode: true, createdAt: true }
    }),
    prisma.emailLog.findMany({
      where: { to: person.email, template: { startsWith: "reminder." }, createdAt: { gte: fromAt, lt: toAt } },
      select: { template: true, subject: true, status: true, createdAt: true },
      take: 200
    }),
    findLeaveInRange([userId], from, to)
  ]);
  const leaveEvents: TimelineEvent[] = [];
  for (let key = from; key <= to; key = addDays(key, 1)) {
    const leave = leaveOf(userId, key);
    if (!leave) continue;
    const half = leave.half && leave.half !== "FULL" ? `, ${halfLabel(leave.half)}` : "";
    // Pinned to the start of the day: leave is a property of the day, not of a moment in it.
    leaveEvents.push({ kind: "LEAVE", at: `${key}T00:00:00.000Z`, label: "On leave", detail: `${leave.type}${half}` });
  }

  const events: TimelineEvent[] = [
    ...logins.map((l) => ({
      kind: "LOGIN" as const,
      at: l.createdAt.toISOString(),
      label: "Signed in",
      detail: l.action === "auth.sso_login" ? "Single sign-on" : "Password"
    })),
    ...records.map((r) => ({
      kind: "PUNCH_IN" as const,
      at: r.punchInAt.toISOString(),
      label: "Punched in",
      detail: r.sourceRef?.name ?? SOURCE_LABELS[r.source]
    })),
    ...sheetAudits.map((a) => {
      const kind = timesheetKind(a.action);
      return { kind, at: a.createdAt.toISOString(), label: TIMESHEET_LABELS[kind], detail: null };
    }),
    ...reasons.map((r) => ({
      kind: "MISSED_REASON" as const,
      at: r.createdAt.toISOString(),
      label: "Missed-day reason given",
      detail: `${r.reasonCode} for ${r.workDate.toISOString().slice(0, 10)}`
    })),
    ...emails.map((e) => ({
      kind: "REMINDER_EMAIL" as const,
      at: e.createdAt.toISOString(),
      label: "Reminder email",
      detail: `${e.subject} (${e.status.toLowerCase()})`
    })),
    ...leaveEvents
  ];

  return {
    user: { id: person.id, name: person.name, timezone: person.timezone },
    from,
    to,
    events: mergeTimeline(events)
  };
}

/** The caller's own days, oldest first, each judged by the shared resolver. */
export async function getMyHistory(userId: string, from: string, to: string, now: Date = new Date()) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true, holidayCalendarId: true } });
  if (!user) throw new AppError(404, "User not found");
  const [planning, holidayOf, leaveOf, records, sheets, reasons] = await Promise.all([
    getPlanningSettings(),
    loadHolidays([user.holidayCalendarId], from, to),
    findLeaveInRange([userId], from, to),
    prisma.attendanceRecord.findMany({
      where: { userId, workDate: { gte: dayStart(from), lte: dayStart(to) } },
      select: { workDate: true, punchInAt: true, punchOutAt: true, source: true, flagged: true, faceAttemptId: true, siteLabel: true, sourceRef: { select: { name: true } } }
    }),
    prisma.timesheet.findMany({ where: { userId, workDate: { gte: dayStart(from), lte: dayStart(to) } }, select: { workDate: true, totalHours: true } }),
    // The reason CODE only, and only the person's own: notes stay with the person and their approver.
    prisma.missedDayReason.findMany({ where: { userId, workDate: { gte: dayStart(from), lte: dayStart(to) } }, select: { workDate: true, reasonCode: true } })
  ]);
  const hoursBy = new Map<string, number>();
  for (const t of sheets) hoursBy.set(t.workDate.toISOString().slice(0, 10), (hoursBy.get(t.workDate.toISOString().slice(0, 10)) ?? 0) + Number(t.totalHours));
  const reasonBy = new Map(reasons.map((r) => [r.workDate.toISOString().slice(0, 10), r.reasonCode]));
  const recordBy = new Map(records.map((r) => [r.workDate.toISOString().slice(0, 10), r]));
  const days = [];
  for (let key = from; key <= to; key = addDays(key, 1)) {
    const record = recordBy.get(key);
    const day = resolveDayStatus({
      dateKey: key,
      workingDays: planning.workingDays,
      holiday: holidayOf(user.holidayCalendarId, key, userId),
      leave: leaveOf(userId, key),
      punchedIn: Boolean(record),
      now,
      timeZone: user.timezone,
      fallbackZone: serverTimezone
    });
    days.push({
      date: key,
      status: day.status,
      holidayName: day.holidayName,
      punchInAt: record?.punchInAt.toISOString() ?? null,
      punchOutAt: record?.punchOutAt?.toISOString() ?? null,
      sourceLabel: record ? (record.sourceRef?.name ?? SOURCE_LABELS[record.source]) : null,
      face: record ? faceResult(record) : null,
      // 7.0.0: the matched work site, never a coordinate.
      siteLabel: record?.siteLabel ?? null,
      isWorkingDay: day.isWorkingDay,
      leave: leaveOf(userId, key),
      hours: hoursBy.get(key) ?? null,
      reasonCode: reasonBy.get(key) ?? null
    });
  }
  return { from, to, days };
}

/** Days between two keys, inclusive. Pure. */
export function spanDays(from: string, to: string): number {
  return Math.round((dayStart(to).getTime() - dayStart(from).getTime()) / DAY_MS) + 1;
}
