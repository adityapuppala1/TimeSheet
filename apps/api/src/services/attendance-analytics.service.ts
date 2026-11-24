/**
 * Attendance analytics (V17 A6) — "what does the pattern look like?" for one person (me), a
 * manager's direct reports (team) and the whole workspace (org), plus the suggestions built on it.
 *
 * SHAPE: one loader (batched — one query per FACT for everybody in scope, never one per person),
 * then PURE functions over the loaded day facts. Every number a test asserts is computed by a pure
 * function over a fixture, so the arithmetic is checked without a database.
 *
 * WHO SEES WHAT: the same rule Team Activity uses (attendance-team.service.ts#peopleWhere). "me" is
 * open to anyone; "team" to managers/team leads (direct reports) and admins (everyone); "org" to
 * SUPER_ADMIN/ADMIN only.
 *
 * K-ANONYMITY: a group aggregate (a rate, a histogram, a reason breakdown) over fewer than
 * GlobalAttendanceSettings.minGroupSize people is suppressed — below that, "the team's average" is
 * one person's day with the name filed off. The per-person rows a manager sees are NOT suppressed:
 * they describe people the manager can already open one by one in Team Activity.
 *
 * LATENESS IS OPT-IN (latenessEnabled, default off). Without an agreed start time, "on time" is a
 * verdict against a rule nobody set; what IS meaningful everywhere is a person's punch-in moving
 * relative to their OWN median, so that trend (drift, minutes per week) is always reported and the
 * on-time rate only when an admin has set expectedStartMinute and switched lateness on.
 *
 * AI: the model receives only `buildAiPayload`'s output — an ALLOWLIST built field by field from
 * the aggregates: counts, rates, histograms, reason CODES and pseudonymous labels ("Person 3",
 * "Team 2", "Integration 1"). Never a name, email, id, coordinate, IP, face data or anyone's
 * free-text note (notes are not even loaded here). tests/unit/attendance-analytics.test.ts walks the
 * payload and fails on any of those. AI failure of any kind falls back to the rule-based list.
 */
import type { AttendanceSourceKind, Prisma } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { serverTimezone } from "../config/env.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { AppError } from "../middleware/error.js";
import { resolveDayStatus, todayKeyFor, weekdayOfDateKey, type AttendanceDayStatus } from "./attendance-day-status.js";
import { findLeaveInRange } from "./attendance-punch.service.js";
import { leaveForAi, leaveRules, loadLeaveAnalytics } from "./leave-analytics.js";
import { getAttendanceSettings } from "./attendance-settings.service.js";
import { assertTeamScope, faceResult, loadHolidays, LOGIN_ACTIONS, peopleWhere, type FaceResult } from "./attendance-team.service.js";
import { getPlanningSettings } from "./planning.service.js";
import { isPlanningCapabilityAllowed } from "./plan-limits.service.js";

export type AnalyticsAudience = "me" | "team" | "org";

export const DEFAULT_RANGE_DAYS = 30;
export const MAX_RANGE_DAYS = 180;
/** Fewer punch-ins than this and a trend line is noise, not a trend. */
const MIN_TREND_POINTS = 5;
/** Later by this many minutes per week counts as drifting. 10 min/week ≈ 40 min over a month. */
export const DRIFT_THRESHOLD_MIN_PER_WEEK = 10;
const UPCOMING_HOLIDAY_DAYS = 14;
const DAY_MS = 86_400_000;
const ZONE_SLACK_MS = 14 * 3_600_000;
const ADMIN_ROLES = new Set(["SUPER_ADMIN", "ADMIN"]);
const STATUSES: readonly AttendanceDayStatus[] = ["PRESENT", "ABSENT", "PENDING", "HOLIDAY", "WEEKEND", "LEAVE"];

/* ------------------------------------------------------------------ *
 * Day facts — what the pure functions consume
 * ------------------------------------------------------------------ */

export interface DayFact {
  date: string;
  weekday: number;
  status: AttendanceDayStatus;
  isWorkingDay: boolean;
  /** The day is over in the person's own zone (only closed days count toward "no timesheet"). */
  closed: boolean;
  /** Punch-in, minutes after the person's LOCAL midnight. */
  punchMinute: number | null;
  source: AttendanceSourceKind | null;
  face: FaceResult | null;
  hoursLogged: number;
  hasTimesheet: boolean;
  reasonCode: string | null;
  /** Phase B: a HALF day of approved leave on a working day — only half the day's hours are owed. */
  halfLeave?: boolean;
}

export interface PersonFacts {
  userId: string;
  name: string;
  managerId: string | null;
  weeklyCapacityHours: number;
  days: DayFact[];
}

export interface AnalyticsOptions {
  latenessEnabled: boolean;
  expectedStartMinute: number;
  workingDaysPerWeek: number;
  minGroupSize: number;
}

const minuteFormatters = new Map<string, Intl.DateTimeFormat | null>();

/** Minutes after local midnight of `instant` in `zone` (server zone when unusable). */
export function localMinuteOf(instant: Date, zone: string | null | undefined): number {
  const z = zone?.trim() || serverTimezone || "UTC";
  if (!minuteFormatters.has(z)) {
    try {
      minuteFormatters.set(z, new Intl.DateTimeFormat("en-GB", { timeZone: z, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }));
    } catch {
      minuteFormatters.set(z, null);
    }
  }
  const f = minuteFormatters.get(z);
  if (!f) return instant.getHours() * 60 + instant.getMinutes();
  const parts = f.formatToParts(instant);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

/* ------------------------------------------------------------------ *
 * Pure maths
 * ------------------------------------------------------------------ */

const round = (n: number, places = 3) => Math.round(n * 10 ** places) / 10 ** places;
const ratio = (num: number, den: number): number | null => (den > 0 ? round(num / den) : null);

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Least-squares slope of punch-in minute against calendar day, scaled to minutes PER WEEK.
 * Positive = getting later. Null under MIN_TREND_POINTS punches. Calendar days, not punch index, so
 * a week off does not compress the line.
 */
export function driftMinutesPerWeek(points: ReadonlyArray<{ date: string; minute: number }>): number | null {
  if (points.length < MIN_TREND_POINTS) return null;
  const base = new Date(`${points[0].date}T00:00:00Z`).getTime();
  const xs = points.map((p) => (new Date(`${p.date}T00:00:00Z`).getTime() - base) / DAY_MS);
  const ys = points.map((p) => p.minute);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  if (den === 0) return null;
  return round((num / den) * 7, 1);
}

function emptyStatusCounts(): Record<AttendanceDayStatus, number> {
  return Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<AttendanceDayStatus, number>;
}

function bump<K extends string>(map: Partial<Record<K, number>>, key: K, by = 1) {
  map[key] = (map[key] ?? 0) + by;
}

/** "09:30" for the 30-minute bucket a minute falls in. */
export function bucketLabel(minute: number): string {
  const start = Math.floor(minute / 30) * 30;
  return `${String(Math.floor(start / 60)).padStart(2, "0")}:${String(start % 60).padStart(2, "0")}`;
}

export interface SelfSummary {
  statusCounts: Record<AttendanceDayStatus, number>;
  /** PRESENT ÷ (PRESENT + ABSENT): pending days are not yet a verdict either way. */
  presenceRate: number | null;
  /** Share of punch-ins at or before the expected start; null unless lateness is switched on. */
  onTimeRate: number | null;
  medianPunchMinute: number | null;
  driftMinutesPerWeek: number | null;
  punchTrend: Array<{ date: string; minute: number }>;
  hours: { logged: number; expected: number };
  missedReasons: Record<string, number>;
  sources: Partial<Record<AttendanceSourceKind, number>>;
  /** ABSENT days per weekday (0 = Sunday), for the "Monday-heavy" rule. */
  absencesByWeekday: number[];
  presentNoTimesheetDays: number;
  closedPresentDays: number;
}

/** One person's range, summarised. Pure. */
export function summariseSelf(person: Pick<PersonFacts, "days" | "weeklyCapacityHours">, opts: AnalyticsOptions): SelfSummary {
  const days = person.days;
  const statusCounts = emptyStatusCounts();
  const missedReasons: Record<string, number> = {};
  const sources: Partial<Record<AttendanceSourceKind, number>> = {};
  const absencesByWeekday = [0, 0, 0, 0, 0, 0, 0];
  for (const d of days) {
    statusCounts[d.status] += 1;
    if (d.reasonCode) bump(missedReasons, d.reasonCode);
    if (d.source) bump(sources, d.source);
    if (d.status === "ABSENT") absencesByWeekday[d.weekday] += 1;
  }
  const logged = days.reduce((n, d) => n + d.hoursLogged, 0);
  // Expected hours accrue on every working day the range has reached, today included.
  // A half day of approved leave owes half the hours (Phase B).
  const expectedDays = days
    .filter((d) => d.isWorkingDay && (d.closed || d.status === "PRESENT"))
    .reduce((n, d) => n + (d.halfLeave ? 0.5 : 1), 0);
  const punchTrend = days.flatMap((d) => (d.punchMinute != null && d.isWorkingDay ? [{ date: d.date, minute: d.punchMinute }] : []));
  const onTime = punchTrend.filter((p) => p.minute <= opts.expectedStartMinute).length;
  const closedPresent = days.filter((d) => d.status === "PRESENT" && d.closed);
  const closedPresentDays = closedPresent.length;
  const presentNoTimesheetDays = closedPresent.filter((d) => !d.hasTimesheet).length;

  const perDay = opts.workingDaysPerWeek > 0 ? person.weeklyCapacityHours / opts.workingDaysPerWeek : 0;
  return {
    statusCounts,
    presenceRate: ratio(statusCounts.PRESENT, statusCounts.PRESENT + statusCounts.ABSENT),
    onTimeRate: opts.latenessEnabled ? ratio(onTime, punchTrend.length) : null,
    medianPunchMinute: median(punchTrend.map((p) => p.minute)),
    driftMinutesPerWeek: driftMinutesPerWeek(punchTrend),
    punchTrend,
    hours: { logged: round(logged, 2), expected: round(expectedDays * perDay, 2) },
    missedReasons,
    sources,
    absencesByWeekday,
    presentNoTimesheetDays,
    closedPresentDays
  };
}

export interface GroupAggregates {
  presenceRate: number | null;
  absenceRate: number | null;
  punchHistogram: Array<{ bucket: string; count: number }>;
  presentNoTimesheet: { days: number; rate: number | null };
  missedReasons: Record<string, number>;
  absencesByWeekday: number[];
}

export interface PersonRow {
  userId: string;
  name: string;
  presenceRate: number | null;
  medianPunchMinute: number | null;
  driftMinutesPerWeek: number | null;
  drifting: boolean;
  absentDays: number;
}

export interface GroupSummary {
  people: number;
  /** True when people < minGroupSize: `aggregates` is null rather than one person's day. */
  suppressed: boolean;
  aggregates: GroupAggregates | null;
}

/** A group's pooled figures, or a suppression marker below minGroupSize. Pure. */
export function summariseGroup(people: ReadonlyArray<PersonFacts>, opts: AnalyticsOptions): GroupSummary {
  if (people.length < opts.minGroupSize) return { people: people.length, suppressed: true, aggregates: null };
  let present = 0;
  let absent = 0;
  let noSheet = 0;
  let closedPresent = 0;
  const hist = new Map<string, number>();
  const missedReasons: Record<string, number> = {};
  const absencesByWeekday = [0, 0, 0, 0, 0, 0, 0];
  for (const p of people) {
    const s = summariseSelf(p, opts);
    present += s.statusCounts.PRESENT;
    absent += s.statusCounts.ABSENT;
    noSheet += s.presentNoTimesheetDays;
    closedPresent += s.closedPresentDays;
    for (const pt of s.punchTrend) hist.set(bucketLabel(pt.minute), (hist.get(bucketLabel(pt.minute)) ?? 0) + 1);
    for (const [code, n] of Object.entries(s.missedReasons)) bump(missedReasons, code, n);
    s.absencesByWeekday.forEach((n, i) => (absencesByWeekday[i] += n));
  }
  return {
    people: people.length,
    suppressed: false,
    aggregates: {
      presenceRate: ratio(present, present + absent),
      absenceRate: ratio(absent, present + absent),
      punchHistogram: [...hist.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([bucket, count]) => ({ bucket, count })),
      presentNoTimesheet: { days: noSheet, rate: ratio(noSheet, closedPresent) },
      missedReasons,
      absencesByWeekday
    }
  };
}

/** Per-person rows a manager may see (never suppressed — see the header). Drifting first. Pure. */
export function personRows(people: ReadonlyArray<PersonFacts>, opts: AnalyticsOptions): PersonRow[] {
  return people
    .map((p) => {
      const s = summariseSelf(p, opts);
      return {
        userId: p.userId,
        name: p.name,
        presenceRate: s.presenceRate,
        medianPunchMinute: s.medianPunchMinute,
        driftMinutesPerWeek: s.driftMinutesPerWeek,
        drifting: (s.driftMinutesPerWeek ?? 0) >= DRIFT_THRESHOLD_MIN_PER_WEEK,
        absentDays: s.statusCounts.ABSENT
      };
    })
    .sort((a, b) => (b.driftMinutesPerWeek ?? -Infinity) - (a.driftMinutesPerWeek ?? -Infinity) || a.name.localeCompare(b.name));
}

/* ------------------------------------------------------------------ *
 * Loading (batched)
 * ------------------------------------------------------------------ */

interface LoadedPerson {
  id: string;
  name: string;
  managerId: string | null;
  timezone: string | null;
  holidayCalendarId: string | null;
  weeklyCapacityHours: Prisma.Decimal | number | null;
}

function dayStart(dateKey: string): Date {
  return new Date(`${dateKey}T00:00:00Z`);
}

export function addDays(dateKey: string, days: number): string {
  return new Date(dayStart(dateKey).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

const PERSON_SELECT = { id: true, name: true, managerId: true, timezone: true, holidayCalendarId: true, weeklyCapacityHours: true } as const;

/** Day facts for every person in one pass: one query per fact, joined in memory. */
export async function loadPersonFacts(people: LoadedPerson[], from: string, to: string, now: Date) {
  const ids = people.map((p) => p.id);
  const planning = await getPlanningSettings();
  if (ids.length === 0) return { planning, people: [] as PersonFacts[] };
  const [holidayOf, leaveOf, records, sheets, reasons] = await Promise.all([
    loadHolidays(people.map((p) => p.holidayCalendarId), from, to),
    findLeaveInRange(ids, from, to),
    prisma.attendanceRecord.findMany({
      where: { userId: { in: ids }, workDate: { gte: dayStart(from), lte: dayStart(to) } },
      // Deliberately no lat/lng/ip/userAgent/rawPayload: analytics never needs them, so never loads them.
      select: { userId: true, workDate: true, punchInAt: true, source: true, faceAttemptId: true, flagged: true }
    }),
    prisma.timesheet.findMany({
      where: { userId: { in: ids }, workDate: { gte: dayStart(from), lte: dayStart(to) } },
      select: { userId: true, workDate: true, totalHours: true }
    }),
    // The reason CODE only. Notes are someone's own words and are never aggregated or sent anywhere.
    prisma.missedDayReason.findMany({
      where: { userId: { in: ids }, workDate: { gte: dayStart(from), lte: dayStart(to) } },
      select: { userId: true, workDate: true, reasonCode: true }
    })
  ]);
  const key = (userId: string, d: Date) => `${userId}|${d.toISOString().slice(0, 10)}`;
  const recordBy = new Map(records.map((r) => [key(r.userId, r.workDate), r]));
  const reasonBy = new Map(reasons.map((r) => [key(r.userId, r.workDate), r.reasonCode]));
  const hoursBy = new Map<string, number>();
  for (const s of sheets) hoursBy.set(key(s.userId, s.workDate), (hoursBy.get(key(s.userId, s.workDate)) ?? 0) + Number(s.totalHours));

  const facts: PersonFacts[] = people.map((p) => {
    const today = todayKeyFor(now, p.timezone, serverTimezone);
    const days: DayFact[] = [];
    for (let date = from; date <= to; date = addDays(date, 1)) {
      const record = recordBy.get(`${p.id}|${date}`);
      const day = resolveDayStatus({
        dateKey: date,
        workingDays: planning.workingDays,
        holiday: holidayOf(p.holidayCalendarId, date, p.id),
        leave: leaveOf(p.id, date),
        punchedIn: Boolean(record),
        now,
        timeZone: p.timezone,
        fallbackZone: serverTimezone
      });
      const hours = hoursBy.get(`${p.id}|${date}`);
      days.push({
        date,
        weekday: weekdayOfDateKey(date),
        status: day.status,
        isWorkingDay: day.isWorkingDay,
        closed: date < today,
        punchMinute: record ? localMinuteOf(record.punchInAt, p.timezone) : null,
        source: record?.source ?? null,
        face: record ? faceResult(record) : null,
        hoursLogged: hours ?? 0,
        hasTimesheet: hours !== undefined,
        reasonCode: reasonBy.get(`${p.id}|${date}`) ?? null,
        ...(day.leaveHalf ? { halfLeave: true } : {})
      });
    }
    return {
      userId: p.id,
      name: p.name,
      managerId: p.managerId,
      weeklyCapacityHours: p.weeklyCapacityHours != null ? Number(p.weeklyCapacityHours) : planning.defaultWeeklyCapacityHours,
      days
    };
  });
  return { planning, people: facts };
}

async function upcomingHolidays(calendarIds: Array<string | null>, today: string) {
  const ids = [...new Set(calendarIds.filter((id): id is string => Boolean(id)))];
  const rows = await prisma.holiday.findMany({
    where: {
      date: { gt: dayStart(today), lte: dayStart(addDays(today, UPCOMING_HOLIDAY_DAYS)) },
      OR: [{ calendarId: { in: ids } }, ...(calendarIds.some((id) => !id) ? [{ calendar: { isDefault: true } }] : [])]
    },
    select: { date: true, name: true },
    orderBy: { date: "asc" },
    take: 50
  });
  const seen = new Set<string>();
  return rows
    .map((h) => ({ date: h.date.toISOString().slice(0, 10), name: h.name }))
    .filter((h) => (seen.has(h.date) ? false : (seen.add(h.date), true)));
}

/* ------------------------------------------------------------------ *
 * Gates and the three audiences
 * ------------------------------------------------------------------ */

export interface AnalyticsRange {
  from: string;
  to: string;
}

export function assertOrgScope(role: string): void {
  if (!ADMIN_ROLES.has(role)) throw new AppError(403, "Organisation attendance analytics are for admins.");
}

async function analyticsOptions(planningWorkingDays: readonly number[]) {
  const settings = await getAttendanceSettings();
  const s = settings as NonNullable<typeof settings>;
  return {
    settings: s,
    opts: {
      latenessEnabled: Boolean(s.latenessEnabled),
      expectedStartMinute: s.expectedStartMinute ?? 600,
      workingDaysPerWeek: planningWorkingDays.length,
      minGroupSize: Math.max(3, s.minGroupSize ?? 5)
    } satisfies AnalyticsOptions
  };
}

const rangeOut = (r: AnalyticsRange, workingDays: number) => ({ from: r.from, to: r.to, days: Math.round((dayStart(r.to).getTime() - dayStart(r.from).getTime()) / DAY_MS) + 1, workingDays });

function workingDayCount(people: ReadonlyArray<PersonFacts>): number {
  return people[0]?.days.filter((d) => d.status !== "WEEKEND").length ?? 0;
}

export async function getMyAnalytics(userId: string, range: AnalyticsRange, now: Date = new Date()) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: PERSON_SELECT });
  if (!user) throw new AppError(404, "User not found");
  const { planning, people } = await loadPersonFacts([user], range.from, range.to, now);
  const { opts } = await analyticsOptions(planning.workingDays);
  const today = todayKeyFor(now, user.timezone, serverTimezone);
  return {
    audience: "me" as const,
    range: rangeOut(range, workingDayCount(people)),
    lateness: { enabled: opts.latenessEnabled, expectedStartMinute: opts.expectedStartMinute },
    summary: summariseSelf(people[0], opts),
    upcomingHolidays: await upcomingHolidays([user.holidayCalendarId], today),
    leave: await loadLeaveAnalytics({ audience: "me", people: [user], minGroupSize: opts.minGroupSize, range, today, workingDays: planning.workingDays, now })
  };
}

export type MyAnalytics = Awaited<ReturnType<typeof getMyAnalytics>>;

async function teamPeople(actor: { id: string; role: string }) {
  const scope = assertTeamScope(actor.role);
  return prisma.user.findMany({ where: peopleWhere(scope, actor.id), select: PERSON_SELECT, orderBy: { name: "asc" }, take: 5000 });
}

export async function getTeamAnalytics(actor: { id: string; role: string }, range: AnalyticsRange, now: Date = new Date()) {
  const loaded = await teamPeople(actor);
  const { planning, people } = await loadPersonFacts(loaded, range.from, range.to, now);
  const { opts } = await analyticsOptions(planning.workingDays);
  const today = todayKeyFor(now, null, serverTimezone);
  return {
    audience: "team" as const,
    range: rangeOut(range, workingDayCount(people)),
    minGroupSize: opts.minGroupSize,
    lateness: { enabled: opts.latenessEnabled, expectedStartMinute: opts.expectedStartMinute },
    group: summariseGroup(people, opts),
    people: personRows(people, opts),
    upcomingHolidays: await upcomingHolidays(loaded.map((p) => p.holidayCalendarId), today),
    leave: await loadLeaveAnalytics({ audience: "team", people: loaded, minGroupSize: opts.minGroupSize, range, today, workingDays: planning.workingDays, now })
  };
}

export type TeamAnalytics = Awaited<ReturnType<typeof getTeamAnalytics>>;

export interface SourceHealth {
  id: string;
  name: string;
  kind: AttendanceSourceKind;
  enabled: boolean;
  counts: Record<string, number>;
  lastEventAt: string | null;
  /** Working days (per the workspace week) since the last event, up to today. Null = never sent. */
  silentWorkingDays: number | null;
}

/** Working days strictly after `lastKey` up to and including `today`. Pure. */
export function workingDaysSince(lastKey: string, today: string, workingDays: readonly number[]): number {
  let n = 0;
  for (let d = addDays(lastKey, 1); d <= today; d = addDays(d, 1)) if (workingDays.includes(weekdayOfDateKey(d))) n += 1;
  return n;
}

/** Login counts per local hour (0-23), only for people in scope. Pure. */
export function loginHistogram(logins: ReadonlyArray<{ actorId: string | null; createdAt: Date }>, zoneOf: Map<string, string | null>): number[] {
  const hours = new Array<number>(24).fill(0);
  for (const l of logins) {
    if (!l.actorId || !zoneOf.has(l.actorId)) continue;
    hours[Math.floor(localMinuteOf(l.createdAt, zoneOf.get(l.actorId)) / 60)] += 1;
  }
  return hours;
}

/** By manager: each team is its own group, suppressed below minGroupSize like any other. Pure. */
function groupByManager(people: ReadonlyArray<PersonFacts>, managerName: Map<string, string>, opts: AnalyticsOptions) {
  const groups = new Map<string, PersonFacts[]>();
  for (const p of people) {
    const k = p.managerId ?? "none";
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  return [...groups.entries()]
    .map(([managerId, group]) => ({
      managerId: managerId === "none" ? null : managerId,
      managerName: managerId === "none" ? "No manager" : (managerName.get(managerId) ?? "Former manager"),
      ...summariseGroup(group, opts)
    }))
    .sort((a, b) => b.people - a.people);
}

/** By source and face: pooled over punches, suppressed when fewer than `min` PEOPLE are behind it. Pure. */
export function sourceAndFace(people: ReadonlyArray<PersonFacts>, min: number) {
  const sourcePeople = new Map<AttendanceSourceKind, Set<string>>();
  const sourcePunches = new Map<AttendanceSourceKind, number>();
  const facePeople = new Set<string>();
  const punched = people.flatMap((p) => p.days.filter((d) => d.source).map((d) => ({ userId: p.userId, source: d.source!, face: d.face })));
  for (const d of punched) {
    sourcePeople.set(d.source, (sourcePeople.get(d.source) ?? new Set()).add(d.userId));
    sourcePunches.set(d.source, (sourcePunches.get(d.source) ?? 0) + 1);
    if (d.face === "PASSED" || d.face === "FLAGGED") facePeople.add(d.userId);
  }
  const passed = punched.filter((d) => d.face === "PASSED").length;
  const flagged = punched.filter((d) => d.face === "FLAGGED").length;
  const bySource = [...sourcePunches.entries()].map(([source, punches]) => {
    const n = sourcePeople.get(source)?.size ?? 0;
    return n < min ? { source, people: n, suppressed: true, punches: null } : { source, people: n, suppressed: false, punches };
  });
  const checks = passed + flagged;
  const face =
    facePeople.size < min
      ? { suppressed: true, checks: null, passRate: null, flagRate: null }
      : { suppressed: false, checks, passRate: ratio(passed, checks), flagRate: ratio(flagged, checks) };
  return { bySource, face };
}

/** Integration health is about devices and feeds, not people — never suppressed. Pure. */
function integrationHealth(
  sources: ReadonlyArray<{ id: string; name: string; kind: AttendanceSourceKind; enabled: boolean; lastEventAt: Date | null }>,
  eventCounts: ReadonlyArray<{ sourceId: string | null; status: string; _count: { _all: number } }>,
  today: string,
  workingDays: readonly number[]
): SourceHealth[] {
  const counts = new Map<string, Record<string, number>>();
  for (const row of eventCounts.filter((r) => r.sourceId)) {
    counts.set(row.sourceId!, { ...counts.get(row.sourceId!), [row.status]: row._count._all });
  }
  return sources.map((s) => {
    const last = s.lastEventAt ? s.lastEventAt.toISOString() : null;
    return {
      id: s.id,
      name: s.name,
      kind: s.kind,
      enabled: s.enabled,
      counts: counts.get(s.id) ?? {},
      lastEventAt: last,
      silentWorkingDays: last ? workingDaysSince(todayKeyFor(new Date(last), null, serverTimezone), today, workingDays) : null
    };
  });
}

/**
 * The org trend: presence and absence per calendar day across everyone (PRESENT ÷ (PRESENT + ABSENT),
 * pending days are no verdict). Only for a group already past k-anonymity; a day nobody was judged on
 * is null, never 0%. Pure.
 */
export function dailyTrend(people: ReadonlyArray<PersonFacts>): Array<{ date: string; presenceRate: number | null; absenceRate: number | null; present: number; absent: number }> {
  const byDate = new Map<string, { present: number; absent: number }>();
  for (const person of people) {
    for (const d of person.days) {
      if (d.status !== "PRESENT" && d.status !== "ABSENT") continue;
      const row = byDate.get(d.date) ?? { present: 0, absent: 0 };
      if (d.status === "PRESENT") row.present += 1;
      else row.absent += 1;
      byDate.set(d.date, row);
    }
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, r]) => ({ date, presenceRate: ratio(r.present, r.present + r.absent), absenceRate: ratio(r.absent, r.present + r.absent), present: r.present, absent: r.absent }));
}

/** Average logged vs expected hours per person for the range (k-anonymous groups only). */
function orgHours(people: ReadonlyArray<PersonFacts>, opts: AnalyticsOptions): { logged: number; expected: number } {
  let logged = 0;
  let expected = 0;
  for (const p of people) {
    const h = summariseSelf(p, opts).hours;
    logged += h.logged;
    expected += h.expected;
  }
  const n = Math.max(1, people.length);
  return { logged: Math.round((logged / n) * 10) / 10, expected: Math.round((expected / n) * 10) / 10 };
}

export async function getOrgAnalytics(actor: { id: string; role: string }, range: AnalyticsRange, now: Date = new Date()) {
  assertOrgScope(actor.role);
  const loaded = await teamPeople(actor);
  const { planning, people } = await loadPersonFacts(loaded, range.from, range.to, now);
  const { opts } = await analyticsOptions(planning.workingDays);
  const today = todayKeyFor(now, null, serverTimezone);
  const fromAt = new Date(dayStart(range.from).getTime() - ZONE_SLACK_MS);
  const toAt = new Date(dayStart(range.to).getTime() + DAY_MS + ZONE_SLACK_MS);
  const ids = loaded.map((p) => p.id);
  const managerIds = [...new Set(loaded.map((p) => p.managerId).filter((id): id is string => Boolean(id)))];

  const [managers, logins, sources, eventCounts] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: managerIds } }, select: { id: true, name: true } }),
    prisma.auditLog.findMany({
      where: { action: { in: [...LOGIN_ACTIONS] }, actorId: { in: ids }, createdAt: { gte: fromAt, lt: toAt } },
      select: { actorId: true, createdAt: true },
      take: 100_000
    }),
    prisma.attendanceSource.findMany({ select: { id: true, name: true, kind: true, enabled: true, lastEventAt: true }, orderBy: { name: "asc" } }),
    prisma.attendanceEvent.groupBy({
      by: ["sourceId", "status"],
      where: { isTest: false, createdAt: { gte: fromAt, lt: toAt } },
      _count: { _all: true }
    })
  ]);

  const overall = summariseGroup(people, opts);
  const byManager = groupByManager(people, new Map(managers.map((m) => [m.id, m.name])), opts);
  const { bySource, face } = sourceAndFace(people, opts.minGroupSize);
  const zoneOf = new Map(loaded.map((p) => [p.id, p.timezone]));
  const loginPeople = new Set(logins.map((l) => l.actorId).filter((id): id is string => Boolean(id) && zoneOf.has(id!)));
  const logins24 = loginPeople.size < opts.minGroupSize ? null : loginHistogram(logins, zoneOf);
  const integrations = integrationHealth(sources, eventCounts, today, planning.workingDays);

  const holidayPersonDays = people.reduce((n, p) => n + p.days.filter((d) => d.status === "HOLIDAY").length, 0);
  const holidayDates = new Set(people.flatMap((p) => p.days.filter((d) => d.status === "HOLIDAY").map((d) => d.date)));

  return {
    audience: "org" as const,
    range: rangeOut(range, workingDayCount(people)),
    minGroupSize: opts.minGroupSize,
    lateness: { enabled: opts.latenessEnabled, expectedStartMinute: opts.expectedStartMinute },
    overall,
    trend: overall.suppressed ? null : dailyTrend(people),
    hours: overall.suppressed ? null : orgHours(people, opts),
    byManager,
    bySource,
    face,
    loginHistogram: logins24 ? { suppressed: false, hours: logins24 } : { suppressed: true, hours: null },
    integrations,
    holidays: { dates: holidayDates.size, personDays: holidayPersonDays },
    upcomingHolidays: await upcomingHolidays(loaded.map((p) => p.holidayCalendarId), today),
    leave: await loadLeaveAnalytics({ audience: "org", people: loaded, minGroupSize: opts.minGroupSize, range, today, workingDays: planning.workingDays, now })
  };
}

export type OrgAnalytics = Awaited<ReturnType<typeof getOrgAnalytics>>;
export type AnyAnalytics = MyAnalytics | TeamAnalytics | OrgAnalytics;

/* ------------------------------------------------------------------ *
 * Rule-based insights (pure, deterministic)
 * ------------------------------------------------------------------ */

export interface Insight {
  id: string;
  title: string;
  detail: string;
  severity: "info" | "warn";
  source: "rule" | "ai";
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pct = (r: number) => `${Math.round(r * 100)}%`;

function weekdayRule(absences: readonly number[], who: string): Insight | null {
  const total = absences.reduce((a, b) => a + b, 0);
  if (total < 3) return null;
  const top = absences.indexOf(Math.max(...absences));
  const share = absences[top] / total;
  if (share < 0.4) return null;
  return {
    id: "weekday-heavy",
    title: `${WEEKDAY_NAMES[top]}s account for ${pct(share)} of missed days`,
    detail: `${who} miss ${WEEKDAY_NAMES[top]}s more than any other day. An earlier punch-in reminder on ${WEEKDAY_NAMES[top]}s may help.`,
    severity: "warn",
    source: "rule"
  };
}

function forgotRule(reasons: Record<string, number>): Insight | null {
  const total = Object.values(reasons).reduce((a, b) => a + b, 0);
  const forgot = reasons.FORGOT ?? 0;
  if (total < 3 || forgot / total < 0.3) return null;
  return {
    id: "forgot-share",
    title: `"Forgot" is ${pct(forgot / total)} of missed-day reasons`,
    detail: "Most gaps are forgetfulness rather than absence. Switching on the punch-in reminder or the punch-in prompt usually closes them.",
    severity: "info",
    source: "rule"
  };
}

function noTimesheetRule(days: number, rate: number | null): Insight | null {
  if (rate == null || days < 3 || rate < 0.2) return null;
  return {
    id: "present-no-timesheet",
    title: `${pct(rate)} of present days have no timesheet`,
    detail: `${days} days had a punch-in but no time logged. A timesheet reminder at the end of the day would catch these.`,
    severity: "warn",
    source: "rule"
  };
}

function holidayRule(upcoming: ReadonlyArray<{ date: string }>): Insight | null {
  if (upcoming.length < 2) return null;
  return {
    id: "holiday-cluster",
    title: `${upcoming.length} holidays in the next ${UPCOMING_HOLIDAY_DAYS} days`,
    detail: `Holidays on ${upcoming.map((h) => h.date).join(", ")}. Plan cover and deadlines around them.`,
    severity: "info",
    source: "rule"
  };
}

function selfRules(data: MyAnalytics): Array<Insight | null> {
  const s = data.summary;
  const drift = s.driftMinutesPerWeek ?? 0;
  const hoursShare = s.hours.expected > 0 ? s.hours.logged / s.hours.expected : null;
  return [
    weekdayRule(s.absencesByWeekday, "You"),
    drift >= DRIFT_THRESHOLD_MIN_PER_WEEK
      ? { id: "drift", title: "Your punch-in is getting later", detail: `About ${Math.round(drift)} minutes later each week over this range.`, severity: "info", source: "rule" }
      : null,
    forgotRule(s.missedReasons),
    noTimesheetRule(s.presentNoTimesheetDays, ratio(s.presentNoTimesheetDays, s.closedPresentDays)),
    hoursShare != null && hoursShare < 0.8
      ? {
          id: "hours-short",
          title: `${pct(hoursShare)} of expected hours logged`,
          detail: `${s.hours.logged}h logged against about ${s.hours.expected}h expected for the working days so far.`,
          severity: "info",
          source: "rule"
        }
      : null,
    s.onTimeRate != null && s.onTimeRate < 0.7
      ? { id: "on-time", title: `${pct(s.onTimeRate)} of punch-ins by the expected start`, detail: "Your workspace has set an expected start time.", severity: "info", source: "rule" }
      : null
  ];
}

function groupRules(group: GroupSummary, minGroupSize: number): Array<Insight | null> {
  if (group.suppressed || !group.aggregates) {
    return [
      {
        id: "group-too-small",
        title: "Group figures are hidden",
        detail: `Fewer than ${minGroupSize} people are in scope, so group averages would describe individuals.`,
        severity: "info",
        source: "rule"
      }
    ];
  }
  const a = group.aggregates;
  return [weekdayRule(a.absencesByWeekday, "People"), forgotRule(a.missedReasons), noTimesheetRule(a.presentNoTimesheet.days, a.presentNoTimesheet.rate)];
}

function teamDriftRule(data: TeamAnalytics): Insight | null {
  const drifting = data.people.filter((p) => p.drifting).length;
  if (drifting === 0) return null;
  return {
    id: "drift",
    title: `${drifting} ${drifting === 1 ? "person's" : "people's"} punch-in is drifting later`,
    detail: `Later by ${DRIFT_THRESHOLD_MIN_PER_WEEK}+ minutes a week. Worth a light check-in, not a warning.`,
    severity: "info",
    source: "rule"
  };
}

function silentSourceRules(data: OrgAnalytics): Insight[] {
  return data.integrations
    .filter((s) => s.enabled && (s.silentWorkingDays ?? 0) >= 2)
    .map((s) => ({
      id: `source-silent:${s.id}`,
      title: `${s.name} has been silent for ${s.silentWorkingDays} working days`,
      detail: "No events have arrived from this integration. Check the device or feed.",
      severity: "warn",
      source: "rule"
    }));
}

/** The deterministic suggestions for an audience. Order is fixed so the list is stable. Pure. */
export function ruleInsights(data: AnyAnalytics): Insight[] {
  let out: Array<Insight | null>;
  if (data.audience === "me") out = selfRules(data);
  else if (data.audience === "team") out = [...groupRules(data.group, data.minGroupSize), teamDriftRule(data)];
  else out = [...groupRules(data.overall, data.minGroupSize), ...silentSourceRules(data)];
  out.push(holidayRule(data.upcomingHolidays));
  out.push(...leaveRules(data.leave));
  return out.filter((i): i is Insight => i !== null);
}

/* ------------------------------------------------------------------ *
 * The AI payload — an allowlist, built field by field
 * ------------------------------------------------------------------ */

function groupForAi(g: GroupSummary) {
  if (g.suppressed || !g.aggregates) return { people: g.people, suppressed: true };
  const a = g.aggregates;
  return {
    people: g.people,
    presenceRate: a.presenceRate,
    absenceRate: a.absenceRate,
    punchHistogram: a.punchHistogram.map((b) => ({ bucket: b.bucket, count: b.count })),
    presentNoTimesheetDays: a.presentNoTimesheet.days,
    presentNoTimesheetRate: a.presentNoTimesheet.rate,
    missedReasons: { ...a.missedReasons },
    absencesByWeekday: [...a.absencesByWeekday]
  };
}

/** Counts across a team's people — how many, never who. Only called at or above minGroupSize. */
function teamDistribution(people: TeamAnalytics["people"]) {
  const band = (lo: number, hi: number) => people.filter((p) => p.presenceRate !== null && p.presenceRate >= lo && p.presenceRate < hi).length;
  return {
    people: people.length,
    driftingPeople: people.filter((p) => p.drifting).length,
    presenceRateBands: { below50: band(0, 0.5), from50to80: band(0.5, 0.8), from80: band(0.8, Infinity) },
    peopleWithAbsences: people.filter((p) => p.absentDays > 0).length
  };
}

/**
 * The ONLY thing that reaches the model. Copies named numeric/enum fields; never spreads an input
 * object, so a field added to the analytics later cannot leak by default. People and teams become
 * "Person N" / "Team N", sources "Integration N" — the labels are positional, not stable ids.
 */
export function buildAiPayload(data: AnyAnalytics): Record<string, unknown> {
  const range = { from: data.range.from, to: data.range.to, workingDays: data.range.workingDays };
  const upcomingHolidayDates = data.upcomingHolidays.map((h) => h.date);
  if (data.audience === "me") {
    const s = data.summary;
    return {
      audience: "self",
      range,
      statusCounts: { ...s.statusCounts },
      presenceRate: s.presenceRate,
      onTimeRate: s.onTimeRate,
      medianPunchMinute: s.medianPunchMinute,
      driftMinutesPerWeek: s.driftMinutesPerWeek,
      hoursLogged: s.hours.logged,
      hoursExpected: s.hours.expected,
      missedReasons: { ...s.missedReasons },
      sources: { ...s.sources },
      absencesByWeekday: [...s.absencesByWeekday],
      presentNoTimesheetDays: s.presentNoTimesheetDays,
      upcomingHolidayDates,
      ...(data.leave ? { leave: leaveForAi(data.leave) } : {})
    };
  }
  if (data.audience === "team") {
    // Never a row per person: a positional label on a team of four is still a person. Only the
    // pooled group goes out, plus counts across people when there are enough of them to pool.
    return {
      audience: "team",
      range,
      group: groupForAi(data.group),
      ...(data.people.length >= data.minGroupSize ? { distribution: teamDistribution(data.people) } : {}),
      // Leave counts only at or above minGroupSize, like the distribution: below it a count of
      // "people off" on a team of two is a person.
      ...(data.leave && data.people.length >= data.minGroupSize ? { leave: leaveForAi(data.leave) } : {}),
      upcomingHolidayDates
    };
  }
  return {
    audience: "org",
    range,
    overall: groupForAi(data.overall),
    teams: data.byManager.filter((t) => !t.suppressed).map((t, i) => ({ label: `Team ${i + 1}`, ...groupForAi(t) })),
    bySource: data.bySource.map((s) => ({ source: s.source, people: s.people, punches: s.punches })),
    face: { checks: data.face.checks, passRate: data.face.passRate, flagRate: data.face.flagRate },
    loginsByHour: data.loginHistogram.hours ? [...data.loginHistogram.hours] : null,
    integrations: data.integrations.map((s, i) => ({
      label: `Integration ${i + 1}`,
      kind: s.kind,
      enabled: s.enabled,
      counts: { ...s.counts },
      silentWorkingDays: s.silentWorkingDays
    })),
    holidays: { dates: data.holidays.dates, personDays: data.holidays.personDays },
    ...(data.leave && !data.overall.suppressed ? { leave: leaveForAi(data.leave) } : {}),
    upcomingHolidayDates
  };
}

/* ------------------------------------------------------------------ *
 * Insights: rules always, AI when every gate is open, cached by frequency
 * ------------------------------------------------------------------ */

const AI_FLAG = { me: "aiInsightsSelf", team: "aiInsightsManager", org: "aiInsightsOrg" } as const;
const AI_AUDIENCE = { me: "self", team: "team", org: "org" } as const;
const FREQUENCY_MS = { DAILY: DAY_MS, WEEKLY: 7 * DAY_MS } as const;

export type AiStatus = "off" | "fresh" | "cached" | "unavailable";

/**
 * The frequency period an AI answer belongs to: the UTC day for DAILY, the ISO week for WEEKLY.
 * The cache is keyed on this, NOT on the requested range — keying on an arbitrary from/to let
 * every new range buy another model call, so "once a week" was really "once per URL".
 */
export function aiInsightPeriod(frequency: "DAILY" | "WEEKLY", now: Date): string {
  const day = now.toISOString().slice(0, 10);
  if (frequency === "DAILY") return day;
  // ISO 8601: the week belongs to the year of its Thursday.
  const d = new Date(`${day}T00:00:00Z`);
  const weekday = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function insightCacheKey(audience: AnalyticsAudience, scope: string, period: string): string {
  return `${audience}:${scope}:${period}`;
}

/**
 * AI facts are always computed over this fixed window (the last DEFAULT_RANGE_DAYS days), whatever
 * range the viewer asked for, so one cached answer per period is honest for every range.
 */
export function aiCanonicalRange(now: Date): AnalyticsRange {
  return defaultRange(now.toISOString().slice(0, 10));
}

async function aiInsightsFor(
  audience: AnalyticsAudience,
  scope: string,
  loadCanonical: () => Promise<AnyAnalytics>,
  actorId: string,
  now: Date
): Promise<{ status: AiStatus; insights: Insight[] }> {
  const settings = await getAttendanceSettings();
  if (!settings?.[AI_FLAG[audience]]) return { status: "off", insights: [] };
  if (!(await isPlanningCapabilityAllowed(requireTenantContext().orgId, "attendanceAiInsightsEnabled"))) return { status: "off", insights: [] };

  const toInsights = (rows: Array<{ title: string; detail: string }>): Insight[] =>
    rows.map((r, i) => ({ id: `ai:${i}`, title: r.title, detail: r.detail, severity: "info", source: "ai" }));
  const frequency = settings.aiInsightsFrequency ?? "WEEKLY";
  const cacheKey = insightCacheKey(audience, scope, aiInsightPeriod(frequency, now));
  try {
    const cached = await prisma.attendanceInsightCache.findUnique({ where: { cacheKey } });
    if (cached && cached.expiresAt > now && Array.isArray(cached.insights)) {
      return { status: "cached", insights: toInsights(cached.insights as Array<{ title: string; detail: string }>) };
    }
    const { generateAttendanceInsights } = await import("./ai.service.js");
    // Only on a miss: the canonical-window analytics cost a second read of the same tables.
    const data = await loadCanonical();
    const rows = await generateAttendanceInsights({ audience: AI_AUDIENCE[audience], facts: JSON.stringify(buildAiPayload(data)), userId: actorId });
    const expiresAt = new Date(now.getTime() + FREQUENCY_MS[frequency]);
    const json = rows.map((r) => ({ title: r.title, detail: r.detail }));
    await prisma.attendanceInsightCache.upsert({
      where: { cacheKey },
      create: { cacheKey, insights: json, expiresAt },
      update: { insights: json, expiresAt }
    });
    return { status: "fresh", insights: toInsights(rows) };
  } catch (error) {
    // Never the user's problem: AI off, over budget, provider down or a bad answer all mean
    // "rule-based suggestions only this time". Logged so an admin can see why.
    console.warn(`[attendance] AI insights unavailable for ${audience}: ${(error as Error).message}`);
    return { status: "unavailable", insights: [] };
  }
}

export async function getInsights(actor: { id: string; role: string }, audience: AnalyticsAudience, range: AnalyticsRange, now: Date = new Date()) {
  const load = (r: AnalyticsRange): Promise<AnyAnalytics> => {
    if (audience === "me") return getMyAnalytics(actor.id, r, now);
    if (audience === "team") return getTeamAnalytics(actor, r, now);
    return getOrgAnalytics(actor, r, now);
  };
  // Admins all see the same team (everyone), so they share one cache entry.
  let scope = "org";
  if (audience === "me") scope = actor.id;
  else if (audience === "team") scope = ADMIN_ROLES.has(actor.role) ? "all" : actor.id;
  // Rule-based insights follow the requested range; the AI part uses the canonical window.
  const data = await load(range);
  const rules = ruleInsights(data);
  const ai = await aiInsightsFor(audience, scope, () => load(aiCanonicalRange(now)), actor.id, now);
  const period = insightPeriod(audience, data.range);
  const dismissed = await dismissedInsightIds(actor.id, period);
  const insights = [...ai.insights, ...rules].filter((i) => !dismissed.has(i.id));
  return { audience, range: data.range, period, aiStatus: ai.status, insights, dismissedCount: dismissed.size };
}

/** The dismissal period: audience plus the range the viewer is looking at. Pure. */
export function insightPeriod(audience: AnalyticsAudience, range: { from: string; to: string }): string {
  return `${audience}:${range.from}:${range.to}`;
}

async function dismissedInsightIds(userId: string, period: string): Promise<Set<string>> {
  const rows = await prisma.attendanceInsightDismissal.findMany({ where: { userId, period }, select: { insightId: true } });
  return new Set(rows.map((r) => r.insightId));
}

/** Persists one dismissal; dismissing twice is a no-op (unique key). */
export async function dismissInsight(userId: string, insightId: string, period: string): Promise<void> {
  await prisma.attendanceInsightDismissal.upsert({
    where: { userId_insightId_period: { userId, insightId, period } },
    create: { userId, insightId, period },
    update: {}
  });
}

/** Default range: the last DEFAULT_RANGE_DAYS days ending on `today`. */
export function defaultRange(today: string): AnalyticsRange {
  return { from: addDays(today, -(DEFAULT_RANGE_DAYS - 1)), to: today };
}
