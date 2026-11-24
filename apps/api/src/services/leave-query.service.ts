/**
 * V17 Phase B — "who is on approved leave, on which days, and for which half?", in ONE query.
 *
 * This replaces the Phase A stubs (attendance-punch.service.ts#findLeaveForDay / findLeaveInRange)
 * and is what the day-status resolver, the punch-in reminder, the missed-day rule, Team Activity,
 * the timeline, analytics, expected hours and the capacity board all read. Kept in its own small
 * module, importing nothing but prisma and settings, so every one of those can depend on it
 * without an import cycle through leave.service.ts.
 *
 * GATED ON THE WORKSPACE TOGGLE ONLY (GlobalAttendanceSettings.leaveEnabled), not the plan: the
 * check runs on every page load of the punch-in prompt and on every reminder sweep, and a single
 * settings read is the cheap half. With leave off this returns "no leave" without touching
 * LeaveRequest at all.
 */
import { prisma } from "../config/prisma.js";
import { getAttendanceSettings } from "./attendance-settings.service.js";
import { dayPortions, mergePortions, type LeaveHalf } from "./leave-calc.js";

export interface LeaveOnDay {
  /** The leave type's CODE ("PL"), stable across renames. */
  type: string;
  /** FULL, or the half taken. Two half-day requests on one day merge to FULL. */
  half: LeaveHalf;
}

export type LeaveLookup = (userId: string, dateKey: string) => LeaveOnDay | null;

const NONE: LeaveLookup = () => null;

async function leaveModuleToggleOn(): Promise<boolean> {
  const settings = await getAttendanceSettings();
  return Boolean(settings?.leaveEnabled);
}

const toKey = (d: Date) => d.toISOString().slice(0, 10);

/** Approved leave for many people over [from, to] as a lookup. One query. */
export async function loadApprovedLeave(userIds: readonly string[], from: string, to: string): Promise<LeaveLookup> {
  if (userIds.length === 0 || to < from) return NONE;
  if (!(await leaveModuleToggleOn())) return NONE;
  const rows = await prisma.leaveRequest.findMany({
    where: {
      userId: { in: [...userIds] },
      status: "APPROVED",
      startDate: { lte: new Date(`${to}T00:00:00Z`) },
      endDate: { gte: new Date(`${from}T00:00:00Z`) }
    },
    select: { userId: true, startDate: true, endDate: true, startHalf: true, endHalf: true, leaveType: { select: { code: true } } }
  });
  if (rows.length === 0) return NONE;
  const map = new Map<string, LeaveOnDay>();
  for (const r of rows) {
    const portions = dayPortions({ startDate: toKey(r.startDate), endDate: toKey(r.endDate), startHalf: r.startHalf, endHalf: r.endHalf });
    for (const [dateKey, half] of portions) {
      if (dateKey < from || dateKey > to) continue;
      const key = `${r.userId}|${dateKey}`;
      const prior = map.get(key);
      map.set(key, { type: prior?.type ?? r.leaveType.code, half: mergePortions(prior?.half, half) });
    }
  }
  return (userId, dateKey) => map.get(`${userId}|${dateKey}`) ?? null;
}

/** Fraction of `dateKey` on approved leave (0, 0.5 or 1) — the expected-hours / capacity view. */
export function leaveFractionOf(lookup: LeaveLookup, userId: string, dateKey: string): number {
  const leave = lookup(userId, dateKey);
  if (!leave) return 0;
  return leave.half === "FULL" ? 1 : 0.5;
}
