/**
 * 7.0.0 birthday and work-anniversary strip ("this week", Monday to Sunday). OFF by default
 * (GlobalAttendanceSettings.celebrationsEnabled, and Attendance & Leave on).
 *
 *   - Day and month only. Never the year of birth, never an age. An anniversary shows its years
 *     of service only when they are 1 or more (a joining day this week is not an anniversary).
 *   - People who opted out (User.celebrationsOptOut) are left out.
 *   - Visibility is the team view's: an unrestricted role sees everyone counted, a manager their
 *     direct reports; everyone also sees themselves. Nobody else.
 *   - The birth year: the tenant client omits User.dateOfBirth unless a query names it. Only
 *     getMyCelebrationProfile (the person) and adminCelebrationFields (super admins) return it.
 *   - A 29 February birthday falls on 28 February in a common year.
 */
import { z } from "zod";
import { prisma } from "../config/prisma.js";
import { serverTimezone } from "../config/env.js";
import { AppError } from "../middleware/error.js";
import { audit } from "./audit.service.js";
import { getAttendanceSettings } from "./attendance-settings.service.js";
import { todayKeyFor } from "./attendance-day-status.js";
import { peopleWhere, teamScopeFor } from "./attendance-team.service.js";
import { attendanceOrLeaveOn } from "./leave-capacity.service.js";
import { addDaysKey } from "./leave-calc.js";
import { COUNTED_PEOPLE } from "./people-visibility.service.js";

export interface CelebrationItem {
  userId: string;
  name: string;
  avatarUrl: string | null;
  kind: "BIRTHDAY" | "ANNIVERSARY";
  /** "MM-DD" — never a year. */
  monthDay: string;
  /** The day it falls on this week, "YYYY-MM-DD" (this week's year, not a birth year). */
  date: string;
  /** Anniversaries only, and only when >= 1. */
  years?: number;
}

const toKey = (d: Date) => d.toISOString().slice(0, 10);
const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** Pure: Monday..Sunday of the week holding `today`. */
export function weekOf(today: string): { from: string; to: string } {
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
  const from = addDaysKey(today, -((dow + 6) % 7));
  return { from, to: addDaysKey(from, 6) };
}

/** Pure: when "MM-DD" falls in year `y` (29 Feb → 28 Feb in a common year). */
function occurrence(monthDay: string, y: number): string {
  if (monthDay === "02-29" && !isLeap(y)) return `${y}-02-28`;
  return `${y}-${monthDay}`;
}

/** Pure: the celebrations falling in [from, to] (a week may straddle New Year). */
export function celebrationsInRange(
  people: ReadonlyArray<{ id: string; name: string; avatarUrl?: string | null; dateOfBirth?: Date | null; joinDate?: Date | null; celebrationsOptOut?: boolean }>,
  from: string,
  to: string
): CelebrationItem[] {
  const years = [...new Set([Number(from.slice(0, 4)), Number(to.slice(0, 4))])];
  const out: CelebrationItem[] = [];
  // Each occurrence of "MM-DD" inside [from, to] (two candidate years when the week crosses New Year).
  const hits = (day: Date) => {
    const key = toKey(day);
    return years.map((y) => ({ y, date: occurrence(key.slice(5), y), md: key.slice(5), since: Number(key.slice(0, 4)) })).filter((h) => h.date >= from && h.date <= to);
  };
  for (const p of people.filter((x) => !x.celebrationsOptOut)) {
    const base = { userId: p.id, name: p.name, avatarUrl: p.avatarUrl ?? null };
    for (const h of p.dateOfBirth ? hits(p.dateOfBirth) : []) out.push({ ...base, kind: "BIRTHDAY", monthDay: h.md, date: h.date });
    for (const h of p.joinDate ? hits(p.joinDate) : []) {
      if (h.y - h.since >= 1) out.push({ ...base, kind: "ANNIVERSARY", monthDay: h.md, date: h.date, years: h.y - h.since });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
}

export async function isCelebrationsOn(): Promise<boolean> {
  if (!(await attendanceOrLeaveOn())) return false;
  return Boolean((await getAttendanceSettings())?.celebrationsEnabled);
}

/** The strip for `actor`: { enabled:false } while off, so the web hides it without an error. */
export async function listCelebrations(actor: { id: string; role: string }, now = new Date()) {
  if (!(await isCelebrationsOn())) return { enabled: false as const, from: null, to: null, items: [] as CelebrationItem[] };
  const { from, to } = weekOf(todayKeyFor(now, null, serverTimezone));
  const scope = teamScopeFor(actor.role);
  const where = scope ? { OR: [peopleWhere(scope, actor.id), { id: actor.id }] } : { ...COUNTED_PEOPLE, id: actor.id };
  const people = await prisma.user.findMany({
    where: { AND: [where, { celebrationsOptOut: false }, { OR: [{ dateOfBirth: { not: null } }, { joinDate: { not: null } }] }] },
    // dateOfBirth is read here to find the day; only "MM-DD" ever leaves this function.
    select: { id: true, name: true, avatarUrl: true, dateOfBirth: true, joinDate: true, celebrationsOptOut: true },
    take: 5000
  });
  return { enabled: true as const, from, to, items: celebrationsInRange(people, from, to) };
}

/* ------------------------------------------------------------------ *
 * The person's own fields (Profile)
 * ------------------------------------------------------------------ */

const isoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && toKey(d) === s && s >= "1900-01-01";
  }, "Not a real date");

export const myCelebrationsBody = z
  .object({
    dateOfBirth: isoDay.nullable().optional(),
    celebrationsOptOut: z.boolean().optional()
  })
  .strict();

export async function getMyCelebrationProfile(userId: string) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { dateOfBirth: true, joinDate: true, celebrationsOptOut: true } });
  if (!u) throw new AppError(404, "User not found");
  return { enabled: await isCelebrationsOn(), dateOfBirth: u.dateOfBirth ? toKey(u.dateOfBirth) : null, joinDate: u.joinDate ? toKey(u.joinDate) : null, celebrationsOptOut: u.celebrationsOptOut };
}

export async function updateMyCelebrationProfile(userId: string, body: z.infer<typeof myCelebrationsBody>, now = new Date()) {
  const data: { dateOfBirth?: Date | null; celebrationsOptOut?: boolean } = {};
  if (body.dateOfBirth !== undefined) {
    if (body.dateOfBirth && body.dateOfBirth > todayKeyFor(now, null, serverTimezone)) throw new AppError(422, "A birthday cannot be in the future.");
    data.dateOfBirth = body.dateOfBirth ? new Date(`${body.dateOfBirth}T00:00:00Z`) : null;
  }
  if (body.celebrationsOptOut !== undefined) data.celebrationsOptOut = body.celebrationsOptOut;
  if (Object.keys(data).length === 0) throw new AppError(422, "Nothing to change.");
  await prisma.user.update({ where: { id: userId }, data, select: { id: true } });
  // Never the date in the audit row: it is read far more widely than a profile.
  await audit(userId, "user.celebrations_updated", "User", userId, { dateOfBirthSet: data.dateOfBirth === undefined ? undefined : Boolean(data.dateOfBirth), celebrationsOptOut: data.celebrationsOptOut });
  return getMyCelebrationProfile(userId);
}

/** Admin edit dialog: join date for admins; the full birthday only for a super admin. */
export async function adminCelebrationFields(targetId: string, actorRole: string) {
  const u = await prisma.user.findUnique({ where: { id: targetId }, select: { joinDate: true, celebrationsOptOut: true, ...(actorRole === "SUPER_ADMIN" ? { dateOfBirth: true } : {}) } });
  if (!u) throw new AppError(404, "User not found");
  const dob = (u as { dateOfBirth?: Date | null }).dateOfBirth;
  return { joinDate: u.joinDate ? toKey(u.joinDate) : null, celebrationsOptOut: u.celebrationsOptOut, ...(actorRole === "SUPER_ADMIN" ? { dateOfBirth: dob ? toKey(dob) : null } : {}) };
}

export const joinDateSchema = isoDay.nullable().optional();
