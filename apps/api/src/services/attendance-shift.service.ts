/**
 * 7.0.0 shifts/rosters: which shift a person works on a given work date.
 *
 * RESOLUTION (one place, so the punch, the pop-up, Team Activity and lateness never disagree):
 * the person's own assignment covering the date beats a team assignment (managerId = their
 * manager); among several, the latest effectiveFrom wins. No assignment = null = the workspace day,
 * so a workspace that never defines a shift behaves exactly as before.
 *
 * The time arithmetic (midnight crossing, work date = start date, end instant) is pure and lives
 * in attendance-day-status.ts so the resolver stays the single source of day status.
 */
import { z } from "zod";
import { prisma } from "../config/prisma.js";
import { shiftExpectedMinutes, workDateKeyFor, type ShiftWindow } from "./attendance-day-status.js";

export interface ResolvedShift extends ShiftWindow {
  id: string;
  name: string;
  crossesMidnight: boolean;
  expectedMinutes: number;
}

const minuteOfDay = z.number().int().min(0).max(1439);

export const shiftBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    startMinute: minuteOfDay,
    endMinute: minuteOfDay,
    breakMinutes: z.number().int().min(0).max(720).default(0),
    workingDays: z.array(z.number().int().min(0).max(6)).min(1).max(7)
  })
  .strict()
  .refine((s) => s.startMinute !== s.endMinute, { message: "A shift must not start and end at the same minute." });

const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const shiftAssignmentBody = z
  .object({
    shiftId: z.string().min(1).max(64),
    userId: z.string().min(1).max(64).optional(),
    managerId: z.string().min(1).max(64).optional(),
    effectiveFrom: dateKey,
    effectiveTo: dateKey.nullable().optional()
  })
  .strict()
  .refine((a) => Boolean(a.userId) !== Boolean(a.managerId), { message: "Assign either one person or one team." })
  .refine((a) => !a.effectiveTo || a.effectiveTo >= a.effectiveFrom, { message: "effectiveTo must not be before effectiveFrom." });

function toWindow(s: { id: string; name: string; startMinute: number; endMinute: number; breakMinutes: number; workingDays: unknown }): ResolvedShift {
  const workingDays = Array.isArray(s.workingDays) ? (s.workingDays as unknown[]).filter((d): d is number => typeof d === "number") : [];
  const w = { startMinute: s.startMinute, endMinute: s.endMinute, breakMinutes: s.breakMinutes, workingDays };
  return { id: s.id, name: s.name, ...w, crossesMidnight: s.endMinute <= s.startMinute, expectedMinutes: shiftExpectedMinutes(w) };
}

type Candidate = { userId: string | null; managerId: string | null; effectiveFrom: Date };

/** Pure: pick the winning assignment for one person among those covering the date. */
export function pickAssignment<T extends Candidate>(rows: readonly T[], userId: string): T | null {
  const own = rows.filter((r) => r.userId === userId);
  const pool = own.length ? own : rows.filter((r) => r.userId === null);
  let best: T | null = null;
  for (const r of pool) if (!best || r.effectiveFrom.getTime() > best.effectiveFrom.getTime()) best = r;
  return best;
}

/** The shifts of many people on one work date (Team Activity, lateness). Missing key = workspace day. */
export async function shiftsForUsers(people: ReadonlyArray<{ id: string; managerId: string | null }>, dateKeyValue: string): Promise<Map<string, ResolvedShift>> {
  const out = new Map<string, ResolvedShift>();
  if (people.length === 0) return out;
  const day = new Date(`${dateKeyValue}T00:00:00Z`);
  const userIds = people.map((p) => p.id);
  const managerIds = [...new Set(people.map((p) => p.managerId).filter((m): m is string => Boolean(m)))];
  const rows = await prisma.attendanceShiftAssignment.findMany({
    where: {
      effectiveFrom: { lte: day },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: day } }],
      AND: [{ OR: [{ userId: { in: userIds } }, ...(managerIds.length ? [{ managerId: { in: managerIds } }] : [])] }]
    },
    include: { shift: true }
  });
  for (const p of people) {
    const mine = rows.filter((r) => r.userId === p.id || (r.userId === null && r.managerId !== null && r.managerId === p.managerId));
    const win = pickAssignment(mine, p.id);
    if (win) out.set(p.id, toWindow(win.shift));
  }
  return out;
}

/**
 * Shifts of many people over [from, to], in one query: per person a lookup by work date. A day with
 * no covering assignment returns null (the workspace day). Same precedence as shiftsForUsers.
 */
export async function shiftsForUsersInRange(
  people: ReadonlyArray<{ id: string; managerId: string | null }>,
  from: string,
  to: string
): Promise<Map<string, (dateKey: string) => ResolvedShift | null>> {
  const out = new Map<string, (dateKey: string) => ResolvedShift | null>();
  if (people.length === 0 || to < from) return out;
  const userIds = people.map((p) => p.id);
  const managerIds = [...new Set(people.map((p) => p.managerId).filter((m): m is string => Boolean(m)))];
  const rows = await prisma.attendanceShiftAssignment.findMany({
    where: {
      effectiveFrom: { lte: new Date(`${to}T00:00:00Z`) },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: new Date(`${from}T00:00:00Z`) } }],
      AND: [{ OR: [{ userId: { in: userIds } }, ...(managerIds.length ? [{ managerId: { in: managerIds } }] : [])] }]
    },
    include: { shift: true }
  });
  if (rows.length === 0) return out;
  for (const p of people) {
    const mine = rows.filter((r) => r.userId === p.id || (r.userId === null && r.managerId !== null && r.managerId === p.managerId));
    if (mine.length === 0) continue;
    const cache = new Map<string, ResolvedShift | null>();
    out.set(p.id, (key) => {
      if (cache.has(key)) return cache.get(key) ?? null;
      const day = new Date(`${key}T00:00:00Z`).getTime();
      const covering = mine.filter((r) => r.effectiveFrom.getTime() <= day && (!r.effectiveTo || r.effectiveTo.getTime() >= day));
      const win = pickAssignment(covering, p.id);
      const s = win ? toWindow(win.shift) : null;
      cache.set(key, s);
      return s;
    });
  }
  return out;
}

export async function shiftForUser(userId: string, dateKeyValue: string): Promise<ResolvedShift | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, managerId: true } });
  if (!user) return null;
  return (await shiftsForUsers([user], dateKeyValue)).get(userId) ?? null;
}

/**
 * The work date `now` belongs to for this person, and the shift on it. A night shift is looked up
 * on yesterday's key first: at 02:00 the person is still on the shift that started last night.
 */
export async function currentWorkDay(
  userId: string,
  now: Date,
  timeZone: string | null | undefined,
  fallbackZone: string | null | undefined
): Promise<{ dateKey: string; shift: ResolvedShift | null }> {
  const localKey = workDateKeyFor(now, timeZone, fallbackZone, null);
  const yesterday = new Date(`${localKey}T12:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const prevKey = yesterday.toISOString().slice(0, 10);
  const prevShift = await shiftForUser(userId, prevKey);
  if (prevShift && workDateKeyFor(now, timeZone, fallbackZone, prevShift) === prevKey) return { dateKey: prevKey, shift: prevShift };
  const shift = await shiftForUser(userId, localKey);
  return { dateKey: localKey, shift };
}

export function publicShift(s: ResolvedShift | null) {
  if (!s) return null;
  return {
    id: s.id,
    name: s.name,
    startMinute: s.startMinute,
    endMinute: s.endMinute,
    breakMinutes: s.breakMinutes,
    workingDays: [...s.workingDays],
    crossesMidnight: s.crossesMidnight,
    expectedMinutes: s.expectedMinutes
  };
}
