/**
 * V17 Phase B — leave in the attendance analytics (Me / Team / Org), plus its rule insights.
 *
 * SAME PRIVACY RULES AS attendance-analytics.service.ts:
 *   - "me" sees their own leave and balances;
 *   - "team" (a manager's direct reports) sees who is off when — they approve that leave, so the
 *     calendar is theirs to see — but pooled utilisation per type is SUPPRESSED below minGroupSize,
 *     because an "average" over two people is one of them;
 *   - "org" sees counts only, never a name.
 * Reasons and decision notes are never loaded here: they are someone's own words.
 *
 * WHAT REACHES THE AI: only leaveForAi's output — counts per type code and per week, no names, no
 * ids, no dates of a named person (the allowlist test in attendance-analytics.test.ts covers it).
 */
import { prisma } from "../config/prisma.js";
import { addDaysKey, dayPortions, portionFraction } from "./leave-calc.js";
import { getBalances, isLeaveOn } from "./leave.service.js";
import type { Insight } from "./attendance-analytics.service.js";

/** How far ahead "upcoming leave" and coverage risk look. */
export const UPCOMING_LEAVE_DAYS = 28;
/** A team this small with two people off in one week is thin, whatever the share. */
export const SMALL_TEAM_SIZE = 8;
/** Larger teams are flagged when this share of them is off in one week. */
export const COVERAGE_RISK_SHARE = 0.25;
/** Balances expiring within this many days of the leave-year end are worth a nudge. */
export const EXPIRY_NUDGE_DAYS = 60;

export interface LeaveFact {
  userId: string;
  name: string;
  typeCode: string;
  typeName: string;
  status: "PENDING" | "APPROVED";
  startDate: string;
  endDate: string;
  startHalf: "FULL" | "FIRST_HALF" | "SECOND_HALF";
  endHalf: "FULL" | "FIRST_HALF" | "SECOND_HALF";
}

const weekday = (key: string) => new Date(`${key}T12:00:00Z`).getUTCDay();
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Monday of the week `dateKey` is in. */
export function weekOf(dateKey: string): string {
  const wd = weekday(dateKey);
  return addDaysKey(dateKey, wd === 0 ? -6 : 1 - wd);
}

/** Working-day leave inside [from, to] per type code, APPROVED only. Pure. */
export function utilisationByType(facts: readonly LeaveFact[], from: string, to: string, workingDays: readonly number[]) {
  const out = new Map<string, { code: string; name: string; days: number; people: Set<string> }>();
  for (const f of facts) {
    if (f.status !== "APPROVED") continue;
    for (const [d, half] of dayPortions(f)) {
      if (d < from || d > to || !workingDays.includes(weekday(d))) continue;
      const row = out.get(f.typeCode) ?? { code: f.typeCode, name: f.typeName, days: 0, people: new Set<string>() };
      row.days += portionFraction(half);
      row.people.add(f.userId);
      out.set(f.typeCode, row);
    }
  }
  return [...out.values()].map((r) => ({ code: r.code, name: r.name, days: r2(r.days), people: r.people.size })).sort((a, b) => a.code.localeCompare(b.code));
}

export interface CoverageWeek {
  weekStart: string;
  peopleOff: number;
  teamSize: number;
  share: number;
  atRisk: boolean;
}

/** People off (approved or pending, any working day) per week in [from, to]. Pure. */
export function coverageByWeek(facts: readonly LeaveFact[], teamSize: number, from: string, to: string, workingDays: readonly number[]): CoverageWeek[] {
  const weeks = new Map<string, Set<string>>();
  for (let w = weekOf(from); w <= to; w = addDaysKey(w, 7)) weeks.set(w, new Set());
  for (const f of facts) {
    for (const [d] of dayPortions(f)) {
      if (d < from || d > to || !workingDays.includes(weekday(d))) continue;
      weeks.get(weekOf(d))?.add(f.userId);
    }
  }
  return [...weeks.entries()].map(([weekStart, people]) => {
    const share = teamSize > 0 ? r2(people.size / teamSize) : 0;
    const atRisk = people.size >= 2 && (teamSize <= SMALL_TEAM_SIZE || share >= COVERAGE_RISK_SHARE);
    return { weekStart, peopleOff: people.size, teamSize, share, atRisk };
  });
}

export type LeaveAudience = "me" | "team" | "org";

export interface LeaveAnalytics {
  audience: LeaveAudience;
  /** Null when suppressed (fewer than minGroupSize people in a team/org view). */
  utilisation: ReturnType<typeof utilisationByType> | null;
  upcoming: {
    requests: number;
    people: number;
    /** Me: own entries. Team: entries with names (the manager approves them). Org: never. */
    entries: Array<{ name?: string; typeCode: string; startDate: string; endDate: string; status: string }> | null;
  };
  coverage: CoverageWeek[] | null;
  /** Me only. */
  expiring: Array<{ typeCode: string; days: number; yearEnd: string }> | null;
}

/** The pure assembly, so the k-anonymity rules are testable without a database. */
export function buildLeaveAnalytics(params: {
  audience: LeaveAudience;
  facts: readonly LeaveFact[];
  peopleCount: number;
  minGroupSize: number;
  range: { from: string; to: string };
  today: string;
  workingDays: readonly number[];
  expiring?: LeaveAnalytics["expiring"];
}): LeaveAnalytics {
  const { audience, facts, peopleCount, minGroupSize, range, today, workingDays } = params;
  const horizon = addDaysKey(today, UPCOMING_LEAVE_DAYS);
  const upcoming = facts.filter((f) => f.endDate >= today && f.startDate <= horizon);
  const suppressed = audience !== "me" && peopleCount < minGroupSize;
  return {
    audience,
    utilisation: suppressed ? null : utilisationByType(facts, range.from, range.to, workingDays),
    upcoming: {
      requests: upcoming.length,
      people: new Set(upcoming.map((f) => f.userId)).size,
      entries:
        audience === "org"
          ? null
          : upcoming
              .slice(0, 50)
              .map((f) => ({ ...(audience === "team" ? { name: f.name } : {}), typeCode: f.typeCode, startDate: f.startDate, endDate: f.endDate, status: f.status }))
    },
    coverage: audience === "me" ? null : coverageByWeek(upcoming, peopleCount, today, horizon, workingDays),
    expiring: audience === "me" ? (params.expiring ?? []) : null
  };
}

const toKey = (d: Date) => d.toISOString().slice(0, 10);

/** Loads the facts for a set of people; null when leave is off (the analytics just omit it). */
export async function loadLeaveAnalytics(params: {
  audience: LeaveAudience;
  people: ReadonlyArray<{ id: string; name: string }>;
  minGroupSize: number;
  range: { from: string; to: string };
  today: string;
  workingDays: readonly number[];
  now: Date;
}): Promise<LeaveAnalytics | null> {
  if (params.people.length === 0 || !(await isLeaveOn())) return null;
  const ids = params.people.map((p) => p.id);
  const nameOf = new Map(params.people.map((p) => [p.id, p.name]));
  const until = addDaysKey(params.today, UPCOMING_LEAVE_DAYS);
  const lo = params.range.from < params.today ? params.range.from : params.today;
  const hi = params.range.to > until ? params.range.to : until;
  const rows = await prisma.leaveRequest.findMany({
    where: {
      userId: { in: ids },
      status: { in: ["PENDING", "APPROVED"] },
      startDate: { lte: new Date(`${hi}T00:00:00Z`) },
      endDate: { gte: new Date(`${lo}T00:00:00Z`) }
    },
    // Never the reason or the decision note.
    select: { userId: true, status: true, startDate: true, endDate: true, startHalf: true, endHalf: true, leaveType: { select: { code: true, name: true } } },
    take: 20_000
  });
  const facts: LeaveFact[] = rows.map((r) => ({
    userId: r.userId,
    name: nameOf.get(r.userId) ?? "",
    typeCode: r.leaveType.code,
    typeName: r.leaveType.name,
    status: r.status as "PENDING" | "APPROVED",
    startDate: toKey(r.startDate),
    endDate: toKey(r.endDate),
    startHalf: r.startHalf,
    endHalf: r.endHalf
  }));
  let expiring: LeaveAnalytics["expiring"] = null;
  if (params.audience === "me") {
    const b = await getBalances(ids[0], { now: params.now });
    const nearEnd = addDaysKey(params.today, EXPIRY_NUDGE_DAYS) >= b.to;
    expiring = nearEnd ? b.balances.filter((x) => x.expiringAtYearEnd > 0).map((x) => ({ typeCode: x.leaveType.code, days: x.expiringAtYearEnd, yearEnd: b.to })) : [];
  }
  return buildLeaveAnalytics({ ...params, facts, peopleCount: ids.length, expiring });
}

/* ------------------------------------------------------------------ *
 * Rules and the AI allowlist
 * ------------------------------------------------------------------ */

export function leaveRules(leave: LeaveAnalytics | null | undefined): Insight[] {
  if (!leave) return [];
  const out: Insight[] = [];
  const risky = (leave.coverage ?? []).filter((w) => w.atRisk);
  if (risky.length) {
    const worst = risky.reduce((a, b) => (b.peopleOff > a.peopleOff ? b : a));
    out.push({
      id: "leave-coverage",
      title: `${worst.peopleOff} of ${worst.teamSize} people off in the week of ${worst.weekStart}`,
      detail: `${risky.length} week(s) in the next ${UPCOMING_LEAVE_DAYS} days have two or more people on leave at once. Check cover and deadlines for those weeks.`,
      severity: "warn",
      source: "rule"
    });
  }
  for (const e of leave.expiring ?? []) {
    out.push({
      id: `leave-expiring:${e.typeCode}`,
      title: `${e.days} day(s) of ${e.typeCode} will expire on ${e.yearEnd}`,
      detail: "Unused days above the carry-forward limit lapse at the end of the leave year. Plan time off before then.",
      severity: "info",
      source: "rule"
    });
  }
  return out;
}

/** Counts only: per type code, per week, never a name, id or a named person's dates. */
export function leaveForAi(leave: LeaveAnalytics | null | undefined): Record<string, unknown> | undefined {
  if (!leave) return undefined;
  return {
    approvedDaysByType: leave.utilisation ? Object.fromEntries(leave.utilisation.map((u) => [u.code, u.days])) : null,
    upcomingRequests: leave.upcoming.requests,
    upcomingPeople: leave.audience === "me" ? undefined : leave.upcoming.people,
    weeksAtRisk: leave.coverage ? leave.coverage.filter((w) => w.atRisk).length : undefined,
    expiringDaysByType: leave.expiring ? Object.fromEntries(leave.expiring.map((e) => [e.typeCode, e.days])) : undefined
  };
}
