/**
 * 7.0.0 overtime: timesheet hours above the expected day and week.
 *
 * THE GATE: attendance on (toggle AND plan, isAttendanceOn) AND GlobalAttendanceSettings.
 * overtimeEnabled. Off (the default), every route refuses, payroll keeps its old columns and
 * analytics carry no overtime key: nothing here runs.
 *
 * THE NUMBER (leave-calc.ts#overtimeForWeek, pure):
 *   - expected per day = leave-capacity.service.ts#expectedHoursByDay — the person's shift on that
 *     work date (attendance-shift.service.ts), else the workspace day; 0 on a weekend, a holiday or
 *     full-day leave, half on a half day. A night shift's hours belong to its START date (the work
 *     date the timesheet is logged on), so a 22:00-06:00 shift is one 8-hour day, not two halves;
 *   - worked per day = timesheet hours on the work date (not REJECTED, not deleted);
 *   - daily overtime = Σ max(0, worked − expected − daily threshold); weekly = max(0, Σworked −
 *     Σexpected − weekly threshold); the week's overtime is the LARGER of the two, never the sum.
 * Weeks are ISO weeks (Monday `weekStart`).
 *
 * APPROVAL (overtimeRequireApproval, OFF by default): a person claims a finished week; the hours are
 * computed here when the claim is made, never taken from the client. Decided exactly like
 * regularisation and comp-off (leave.service.ts#resolveDecisionRight — manager, admin pool, super
 * admin override, active delegate), through the same inbox and nav badge. Approval is a conditional
 * PENDING → APPROVED update: of two racing decisions exactly one wins, the other gets 409.
 *
 * PAYROLL: approval on → APPROVED claim hours; off → the computed hours. A week is counted in the
 * month its Monday falls in, so a week is never paid twice across a month boundary.
 *
 * PRIVACY: there is no free-text reason on a claim. Team and org figures are aggregates, suppressed
 * below minGroupSize like every other group figure; no per-person ranking exists anywhere.
 */
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../config/prisma.js";
import { serverTimezone } from "../config/env.js";
import { AppError } from "../middleware/error.js";
import { getAttendanceSettings, isoDate } from "./attendance-settings.service.js";
import { todayKeyFor } from "./attendance-day-status.js";
import { assertAttendanceOn, isAttendanceOn } from "./attendance-punch.service.js";
import { audit } from "./audit.service.js";
import { dispatchNotification } from "./notify.service.js";
import { decisionEmail, requestedEmail } from "./attendance-request-mail.js";
import { NOT_DEACTIVATED } from "./people-visibility.service.js";
import { delegatesOf } from "./approval-delegation.service.js";
import { expectedHoursByDay } from "./leave-capacity.service.js";
import { addDaysKey, overtimeForWeek, weekStartOf, type OvertimeThresholds, type OvertimeWeek } from "./leave-calc.js";
import { resolveDecisionRight, type Fallback } from "./leave.service.js";

const toKey = (d: Date) => d.toISOString().slice(0, 10);
const dayStart = (k: string) => new Date(`${k}T00:00:00.000Z`);
const r2 = (n: number) => Math.round(n * 100) / 100;
const OUT_OF_SCOPE = "You can only decide overtime claims that are waiting on you.";
/** How far back a week may be claimed (its Monday, in days before today). */
export const MAX_CLAIM_DAYS_BACK = 60;
/** Weeks one read may cover. */
export const MAX_OVERTIME_WEEKS = 26;

export const overtimeClaimBody = z.object({ weekStart: isoDate }).strict();
export const overtimeDecisionBody = z
  .object({ decision: z.enum(["APPROVE", "REJECT"]), note: z.string().trim().max(2000).optional() })
  .strict()
  .refine((b) => b.decision === "APPROVE" || Boolean(b.note), { message: "Add a note explaining the rejection." });

export function thresholdsOf(s: Record<string, unknown>): OvertimeThresholds {
  return { dailyThresholdHours: Number(s.overtimeDailyThresholdHours ?? 0), weeklyThresholdHours: Number(s.overtimeWeeklyThresholdHours ?? 0) };
}

export async function isOvertimeOn(): Promise<boolean> {
  if (!(await isAttendanceOn())) return false;
  return Boolean((await getAttendanceSettings()).overtimeEnabled);
}

export async function assertOvertimeOn(): Promise<void> {
  await assertAttendanceOn();
  if (!(await getAttendanceSettings()).overtimeEnabled) {
    throw new AppError(403, "Overtime is off for this workspace. A super admin can enable it in Workspace Settings → Attendance & Leave.");
  }
}

async function assertClaimsOn(): Promise<void> {
  await assertOvertimeOn();
  if (!(await getAttendanceSettings()).overtimeRequireApproval) {
    throw new AppError(403, "Overtime does not need approval in this workspace: it is counted automatically.");
  }
}

/* ------------------------------------------------------------------ *
 * Computation
 * ------------------------------------------------------------------ */

/** The Mondays of every week touching [from, to]. Pure. */
export function weeksIn(from: string, to: string): string[] {
  const out: string[] = [];
  for (let w = weekStartOf(from); w <= to; w = addDaysKey(w, 7)) out.push(w);
  return out;
}

/** Overtime per person per ISO week touching [from, to] (whole weeks). Does not check the gate. */
export async function computeOvertime(userIds: readonly string[], from: string, to: string, thresholds: OvertimeThresholds): Promise<Map<string, OvertimeWeek[]>> {
  const out = new Map<string, OvertimeWeek[]>();
  if (userIds.length === 0 || to < from) return out;
  const weeks = weeksIn(from, to);
  const first = weeks[0];
  const last = addDaysKey(weeks.at(-1)!, 6);
  const [expected, sheets] = await Promise.all([
    expectedHoursByDay(userIds, first, last),
    prisma.timesheet.findMany({
      where: { userId: { in: [...userIds] }, workDate: { gte: dayStart(first), lte: dayStart(last) }, status: { not: "REJECTED" }, deletedAt: null },
      select: { userId: true, workDate: true, totalHours: true }
    })
  ]);
  const worked = new Map<string, number>();
  for (const t of sheets) {
    const k = `${t.userId}|${toKey(t.workDate)}`;
    worked.set(k, (worked.get(k) ?? 0) + Number(t.totalHours));
  }
  for (const id of userIds) {
    const exp = expected.get(id);
    out.set(
      id,
      weeks.map((w) => {
        const days = [];
        for (let i = 0; i < 7; i++) {
          const d = addDaysKey(w, i);
          days.push({ date: d, worked: r2(worked.get(`${id}|${d}`) ?? 0), expected: exp?.get(d) ?? 0 });
        }
        return overtimeForWeek(w, days, thresholds);
      })
    );
  }
  return out;
}

type ClaimRow = Prisma.OvertimeClaimGetPayload<object> & { user?: { id: string; name: string; email: string; avatarUrl?: string | null } | null };

export function publicClaim(r: ClaimRow) {
  return {
    id: r.id,
    user: r.user ? { id: r.user.id, name: r.user.name, email: r.user.email, avatarUrl: r.user.avatarUrl ?? null } : undefined,
    weekStart: toKey(r.weekStart),
    hours: Number(r.hours),
    workedHours: Number(r.workedHours),
    expectedHours: Number(r.expectedHours),
    status: r.status,
    approverId: r.approverId,
    decidedById: r.decidedById,
    onBehalfOfId: r.onBehalfOfId,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    decisionNote: r.decisionNote,
    createdAt: r.createdAt.toISOString()
  };
}

const USER_SELECT = { select: { id: true, name: true, email: true, avatarUrl: true } } as const;

/** My overtime per week over a range, with each week's claim when approval is on. */
export async function getMyOvertime(userId: string, range: { from: string; to: string }) {
  await assertOvertimeOn();
  if (weeksIn(range.from, range.to).length > MAX_OVERTIME_WEEKS) throw new AppError(422, `Ask for at most ${MAX_OVERTIME_WEEKS} weeks at a time.`);
  const settings = await getAttendanceSettings();
  const weeks = (await computeOvertime([userId], range.from, range.to, thresholdsOf(settings))).get(userId) ?? [];
  const claims = settings.overtimeRequireApproval
    ? await prisma.overtimeClaim.findMany({
        where: { userId, weekStart: { in: weeks.map((w) => dayStart(w.weekStart)) }, status: { in: ["PENDING", "APPROVED"] } }
      })
    : [];
  const claimOf = new Map(claims.map((c) => [toKey(c.weekStart), publicClaim(c)]));
  return {
    requireApproval: Boolean(settings.overtimeRequireApproval),
    thresholds: thresholdsOf(settings),
    totalHours: r2(weeks.reduce((s, w) => s + w.overtimeHours, 0)),
    weeks: weeks.map((w) => ({ ...w, claim: claimOf.get(w.weekStart) ?? null }))
  };
}

/* ------------------------------------------------------------------ *
 * Claims
 * ------------------------------------------------------------------ */

async function lockPerson(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM \`User\` WHERE id = ${userId} FOR UPDATE`;
}

async function approverRecipients(request: { userId: string; approverId: string | null }, fallback: Fallback) {
  if (request.approverId) {
    const manager = await prisma.user.findFirst({ where: { id: request.approverId, status: "ACTIVE", deletedAt: null }, select: { id: true, name: true } });
    if (manager) return [manager, ...(await delegatesOf(manager.id)).filter((d) => d.id !== request.userId && d.id !== manager.id)];
  }
  const roles = fallback === "SUPER_ADMINS" ? ["SUPER_ADMIN"] : ["SUPER_ADMIN", "ADMIN"];
  return prisma.user.findMany({
    where: { status: "ACTIVE", deletedAt: null, isAgent: false, id: { not: request.userId }, role: { name: { in: roles as never } } },
    select: { id: true, name: true },
    take: 25
  });
}

/** Why this week cannot be claimed today, or null. Pure. */
export function claimWeekProblem(weekStart: string, today: string): string | null {
  if (weekStartOf(weekStart) !== weekStart) return "weekStart must be a Monday.";
  if (addDaysKey(weekStart, 6) >= today) return "A week can be claimed once it is over.";
  if (weekStart < addDaysKey(today, -MAX_CLAIM_DAYS_BACK)) return `Overtime can be claimed up to ${MAX_CLAIM_DAYS_BACK} days back.`;
  return null;
}

export async function requestOvertimeClaim(input: { userId: string; weekStart: string; now?: Date }) {
  await assertClaimsOn();
  const now = input.now ?? new Date();
  const settings = await getAttendanceSettings();
  const person = await prisma.user.findFirst({ where: { id: input.userId, ...NOT_DEACTIVATED }, select: { id: true, name: true, timezone: true, managerId: true } });
  if (!person) throw new AppError(404, "User not found");
  const problem = claimWeekProblem(input.weekStart, todayKeyFor(now, person.timezone, serverTimezone));
  if (problem) throw new AppError(422, problem, { code: "OVERTIME_OUT_OF_RANGE" });
  const week = (await computeOvertime([person.id], input.weekStart, input.weekStart, thresholdsOf(settings))).get(person.id)![0];
  if (week.overtimeHours <= 0) throw new AppError(422, "There is no overtime in that week to claim.", { code: "OVERTIME_NONE" });

  const created = await prisma.$transaction(async (tx) => {
    await lockPerson(tx, person.id);
    const open = await tx.overtimeClaim.findFirst({ where: { userId: person.id, weekStart: dayStart(input.weekStart), status: { in: ["PENDING", "APPROVED"] } }, select: { id: true } });
    if (open) throw new AppError(409, "You already have a claim for that week.", { code: "OVERTIME_DUPLICATE" });
    return tx.overtimeClaim.create({
      data: {
        userId: person.id,
        weekStart: dayStart(input.weekStart),
        hours: week.overtimeHours,
        workedHours: week.workedHours,
        expectedHours: week.expectedHours,
        status: "PENDING",
        approverId: person.managerId ?? null
      },
      include: { user: USER_SELECT }
    });
  });
  await audit(person.id, "attendance.overtime_claimed", "OvertimeClaim", created.id, { weekStart: input.weekStart, hours: week.overtimeHours });
  const fallback: Fallback = settings.leaveApprovalFallback ?? "ADMINS";
  for (const r of await approverRecipients(created, fallback)) {
    await dispatchNotification({
      userId: r.id,
      category: "leave.requested",
      title: `${person.name} claimed overtime`,
      body: `Week of ${input.weekStart} · ${week.overtimeHours}h`,
      link: "/app/attendance/team",
      email: requestedEmail({ approverName: r.name, employeeName: person.name, kind: "overtime claim", summary: `Week of ${input.weekStart}, ${week.overtimeHours}h` }),
      metadata: { overtimeClaimId: created.id }
    });
  }
  return publicClaim(created);
}

export async function listMyOvertimeClaims(userId: string) {
  await assertClaimsOn();
  const rows = await prisma.overtimeClaim.findMany({ where: { userId }, orderBy: { weekStart: "desc" }, take: 200 });
  return rows.map((r) => publicClaim(r));
}

export async function cancelOvertimeClaim(userId: string, id: string, now: Date = new Date()) {
  await assertClaimsOn();
  const row = await prisma.overtimeClaim.findFirst({ where: { id, userId } });
  if (!row) throw new AppError(404, "Overtime claim not found");
  if (row.status !== "PENDING") throw new AppError(409, "Only a pending claim can be cancelled.", { code: "OVERTIME_NOT_CANCELLABLE" });
  const claimed = await prisma.overtimeClaim.updateMany({ where: { id, userId, status: "PENDING" }, data: { status: "CANCELLED", cancelledAt: now } });
  if (claimed.count !== 1) throw new AppError(409, "This claim changed while you were cancelling it. Refresh and try again.");
  await audit(userId, "attendance.overtime_cancelled", "OvertimeClaim", id, {});
  return publicClaim({ ...row, status: "CANCELLED", cancelledAt: now });
}

async function isActiveApprover(id: string | null): Promise<boolean> {
  if (!id) return false;
  return Boolean(await prisma.user.findFirst({ where: { id, ...NOT_DEACTIVATED }, select: { id: true } }));
}

export async function listOvertimeInbox(actor: { id: string; role: string }, now: Date = new Date()) {
  await assertClaimsOn();
  const settings = await getAttendanceSettings();
  const fallback: Fallback = settings.leaveApprovalFallback ?? "ADMINS";
  const rows = await prisma.overtimeClaim.findMany({ where: { status: "PENDING", userId: { not: actor.id } }, orderBy: { weekStart: "asc" }, take: 500, include: { user: USER_SELECT } });
  const approverIds = [...new Set(rows.map((r) => r.approverId).filter((x): x is string => Boolean(x)))];
  const active = approverIds.length ? await prisma.user.findMany({ where: { id: { in: approverIds }, ...NOT_DEACTIVATED }, select: { id: true } }) : [];
  const activeIds = new Set(active.map((u) => u.id));
  const out = [];
  for (const r of rows) {
    const right = await resolveDecisionRight(actor, r, Boolean(r.approverId && activeIds.has(r.approverId)), fallback, now);
    if (right && right.right !== "OVERRIDE") out.push({ ...publicClaim(r), onBehalfOf: right.onBehalfOfId });
  }
  return { total: out.length, items: out };
}

export async function decideOvertimeClaim(input: { actor: { id: string; role: string }; requestId: string; decision: "APPROVE" | "REJECT"; note?: string | null; now?: Date }) {
  await assertClaimsOn();
  const now = input.now ?? new Date();
  const settings = await getAttendanceSettings();
  const fallback: Fallback = settings.leaveApprovalFallback ?? "ADMINS";
  const request = await prisma.overtimeClaim.findUnique({ where: { id: input.requestId } });
  // Same 403 for "no such claim" and "not yours": the id is not a probe.
  if (!request) throw new AppError(403, OUT_OF_SCOPE);
  const right = await resolveDecisionRight(input.actor, request, await isActiveApprover(request.approverId), fallback, now);
  if (!right) throw new AppError(403, OUT_OF_SCOPE);
  if (request.status !== "PENDING") throw new AppError(409, `This claim is already ${request.status.toLowerCase()}.`, { code: "OVERTIME_ALREADY_DECIDED" });
  const approve = input.decision === "APPROVE";
  const claimed = await prisma.overtimeClaim.updateMany({
    where: { id: request.id, status: "PENDING" },
    data: {
      status: approve ? "APPROVED" : "REJECTED",
      decidedById: input.actor.id,
      onBehalfOfId: right.onBehalfOfId,
      decidedAt: now,
      decisionNote: input.note?.trim() || null,
      overriddenBySuperAdmin: right.right === "OVERRIDE"
    }
  });
  if (claimed.count !== 1) throw new AppError(409, "This claim has just been decided by someone else.", { code: "OVERTIME_ALREADY_DECIDED" });
  const weekStart = toKey(request.weekStart);
  await audit(input.actor.id, approve ? "attendance.overtime_approved" : "attendance.overtime_rejected", "OvertimeClaim", request.id, {
    weekStart,
    hours: Number(request.hours),
    overriddenBySuperAdmin: right.right === "OVERRIDE",
    ...(right.onBehalfOfId ? { onBehalfOf: right.onBehalfOfId } : {})
  });
  await dispatchNotification({
    userId: request.userId,
    category: "leave.decided",
    title: `Your overtime for the week of ${weekStart} was ${approve ? "approved" : "rejected"}`,
    body: approve ? `${Number(request.hours)}h approved` : (input.note?.trim() ?? ""),
    link: "/app/attendance",
    email: await decisionEmail(request.userId, input.actor, { kind: "overtime claim", approve, summary: `Week of ${weekStart}, ${Number(request.hours)}h`, note: input.note ?? null }),
    metadata: { overtimeClaimId: request.id }
  });
  const decided = await prisma.overtimeClaim.findUniqueOrThrow({ where: { id: request.id }, include: { user: USER_SELECT } });
  return publicClaim(decided);
}

/* ------------------------------------------------------------------ *
 * Payroll and analytics
 * ------------------------------------------------------------------ */

/**
 * Overtime hours per person for the weeks whose Monday falls in [from, to] (a payroll month): the
 * APPROVED claim hours when approval is on, else the computed hours. Null while overtime is off.
 */
export async function overtimeHoursForPeriod(userIds: readonly string[], from: string, to: string): Promise<{ basis: "APPROVED" | "COMPUTED"; hours: Map<string, number> } | null> {
  if (!(await isOvertimeOn())) return null;
  const settings = await getAttendanceSettings();
  const hours = new Map<string, number>();
  if (userIds.length === 0) return { basis: settings.overtimeRequireApproval ? "APPROVED" : "COMPUTED", hours };
  if (settings.overtimeRequireApproval) {
    const claims = await prisma.overtimeClaim.findMany({
      where: { userId: { in: [...userIds] }, status: "APPROVED", weekStart: { gte: dayStart(from), lte: dayStart(to) } },
      select: { userId: true, hours: true }
    });
    for (const c of claims) hours.set(c.userId, r2((hours.get(c.userId) ?? 0) + Number(c.hours)));
    return { basis: "APPROVED", hours };
  }
  const mondays = weeksIn(from, to).filter((w) => w >= from);
  if (mondays.length === 0) return { basis: "COMPUTED", hours };
  const computed = await computeOvertime(userIds, mondays[0], mondays.at(-1)!, thresholdsOf(settings));
  for (const [id, weeks] of computed) hours.set(id, r2(weeks.filter((w) => w.weekStart >= from && w.weekStart <= to).reduce((s, w) => s + w.overtimeHours, 0)));
  return { basis: "COMPUTED", hours };
}

export type OvertimeAnalytics =
  | { audience: "me"; basis: "APPROVED" | "COMPUTED"; hours: number }
  | { audience: "team" | "org"; basis: "APPROVED" | "COMPUTED"; people: number; suppressed: boolean; totalHours: number | null; averagePerPerson: number | null; peopleWithOvertime: number | null };

/**
 * The analytics figure: my own hours, or a group's pooled hours — suppressed below minGroupSize
 * (never one person's overtime with the name filed off). No per-person breakdown: no leaderboards.
 * Undefined while overtime is off, so analytics responses are unchanged.
 */
export async function overtimeAnalytics(audience: "me" | "team" | "org", userIds: readonly string[], range: { from: string; to: string }, minGroupSize: number): Promise<OvertimeAnalytics | undefined> {
  const period = await overtimeHoursForPeriod(userIds, range.from, range.to);
  if (!period) return undefined;
  const values = userIds.map((id) => period.hours.get(id) ?? 0);
  const total = r2(values.reduce((s, v) => s + v, 0));
  if (audience === "me") return { audience, basis: period.basis, hours: total };
  if (userIds.length < minGroupSize) {
    return { audience, basis: period.basis, people: userIds.length, suppressed: true, totalHours: null, averagePerPerson: null, peopleWithOvertime: null };
  }
  return {
    audience,
    basis: period.basis,
    people: userIds.length,
    suppressed: false,
    totalHours: total,
    averagePerPerson: r2(total / userIds.length),
    peopleWithOvertime: values.filter((v) => v > 0).length
  };
}
