/**
 * 7.0.0 — comp-off: leave credit for working on a weekend or holiday.
 *
 * THE GATE: leave on (leaveEnabled AND the leaveManagementEnabled plan, assertLeaveOn) AND
 * GlobalAttendanceSettings.compOffEnabled. Off, every route refuses and nothing here runs.
 *
 * ELIGIBILITY is never taken from the client:
 *   - the day must be a WEEKEND or HOLIDAY for that person, per resolveDayStatus (the one resolver),
 *     with their own holiday calendar and optional-holiday opt-ins;
 *   - the hours are the person's timesheet hours on that day (not REJECTED, not deleted);
 *   - at least compOffFullDayHours earns 1 day, at least compOffHalfDayHours earns 0.5;
 *   - not in the future, at most MAX_BACKDATE_DAYS ago, and one open (pending/approved) request per day.
 *
 * WHO DECIDES: exactly the leave rule (leave.service.ts#resolveDecisionRight — the manager, the
 * admin pool, a super admin override, and an active delegate on the approver's behalf).
 *
 * THE CREDIT is a ledger row (ADJUSTMENT, +days) in the leave year of the worked day, keyed
 * `COMPOFF:<requestId>` (UNIQUE), written in the same transaction as the PENDING → APPROVED
 * conditional update. Two racing approvals: one claims the row, the other gets 409; even without that
 * guard the second insert would fail on the key and roll back. EXPIRY (optional) is
 * `COMPOFF-EXPIRY:<requestId>`, posted by the nightly accrual worker: it takes back what is still
 * unspent of that credit (never more than the type's balance), so a credit already used is not
 * clawed back into a negative balance.
 */
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../config/prisma.js";
import { serverTimezone } from "../config/env.js";
import { AppError } from "../middleware/error.js";
import { getAttendanceSettings, isoDate } from "./attendance-settings.service.js";
import { resolveDayStatus, todayKeyFor } from "./attendance-day-status.js";
import { loadHolidays } from "./attendance-team.service.js";
import { audit } from "./audit.service.js";
import { emitDomainEvent } from "./domain-events.js";
import { dispatchNotification } from "./notify.service.js";
import { getPlanningSettings } from "./planning.service.js";
import { NOT_DEACTIVATED } from "./people-visibility.service.js";
import { settleLateMovement } from "./leave-settlement.service.js";
import { addDaysKey, leaveYearOf } from "./leave-calc.js";
import { delegatesOf } from "./approval-delegation.service.js";
import { assertLeaveOn, isLeaveOn, MAX_BACKDATE_DAYS, resolveDecisionRight, type Fallback } from "./leave.service.js";

const toKey = (d: Date) => d.toISOString().slice(0, 10);
const dayStart = (k: string) => new Date(`${k}T00:00:00.000Z`);
const r2 = (n: number) => Math.round(n * 100) / 100;
const OUT_OF_SCOPE = "You can only decide comp-off requests that are waiting on you.";

export const compOffRequestBody = z.object({ workDate: isoDate, reason: z.string().trim().max(2000).optional() }).strict();
export const compOffDecisionBody = z
  .object({ decision: z.enum(["APPROVE", "REJECT"]), note: z.string().trim().max(2000).optional() })
  .strict()
  .refine((b) => b.decision === "APPROVE" || Boolean(b.note), { message: "Add a note explaining the rejection." });
export const compOffSettingsBody = z
  .object({
    compOffEnabled: z.boolean(),
    compOffHalfDayHours: z.number().min(0.5).max(24),
    compOffFullDayHours: z.number().min(0.5).max(24),
    compOffLeaveTypeCode: z.string().trim().regex(/^[A-Z][A-Z0-9_]{0,19}$/),
    compOffExpiryDays: z.number().int().min(1).max(3650).nullable()
  })
  .partial()
  .strict();

/** Pure: the credit a day's hours earn. */
export function compOffDaysFor(hours: number, halfDayHours: number, fullDayHours: number): 0 | 0.5 | 1 {
  if (hours >= fullDayHours) return 1;
  if (hours >= halfDayHours) return 0.5;
  return 0;
}

export async function isCompOffOn(): Promise<boolean> {
  if (!(await isLeaveOn())) return false;
  return Boolean((await getAttendanceSettings()).compOffEnabled);
}

export async function assertCompOffOn(): Promise<void> {
  await assertLeaveOn();
  if (!(await getAttendanceSettings()).compOffEnabled) {
    throw new AppError(403, "Comp-off is off for this workspace. A super admin can enable it in Workspace Settings → Attendance & Leave.");
  }
}

export function publicCompOffSettings(s: Record<string, unknown>) {
  return {
    compOffEnabled: Boolean(s.compOffEnabled),
    compOffHalfDayHours: Number(s.compOffHalfDayHours ?? 4),
    compOffFullDayHours: Number(s.compOffFullDayHours ?? 8),
    compOffLeaveTypeCode: String(s.compOffLeaveTypeCode ?? "CO"),
    compOffExpiryDays: s.compOffExpiryDays == null ? null : Number(s.compOffExpiryDays)
  };
}

type CompOffRow = Prisma.CompOffRequestGetPayload<object> & { user?: { id: string; name: string; email: string; avatarUrl?: string | null } | null };

export function publicCompOff(r: CompOffRow, opts: { withReason?: boolean } = { withReason: true }) {
  return {
    id: r.id,
    user: r.user ? { id: r.user.id, name: r.user.name, email: r.user.email, avatarUrl: r.user.avatarUrl ?? null } : undefined,
    workDate: toKey(r.workDate),
    dayKind: r.dayKind,
    hoursLogged: Number(r.hoursLogged),
    days: Number(r.days),
    reason: opts.withReason === false ? null : r.reason,
    status: r.status,
    approverId: r.approverId,
    decidedById: r.decidedById,
    onBehalfOfId: r.onBehalfOfId,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    decisionNote: opts.withReason === false ? null : r.decisionNote,
    leaveYear: r.leaveYear,
    expiresOn: r.expiresOn ? toKey(r.expiresOn) : null,
    expiredAt: r.expiredAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString()
  };
}

const USER_SELECT = { select: { id: true, name: true, email: true, avatarUrl: true } } as const;

/* ------------------------------------------------------------------ *
 * Eligibility
 * ------------------------------------------------------------------ */

export interface CompOffEligibility {
  workDate: string;
  eligible: boolean;
  dayKind: "WEEKEND" | "HOLIDAY" | null;
  holidayName: string | null;
  hoursLogged: number;
  days: 0 | 0.5 | 1;
  /** Why not, in words, when not eligible. */
  problem: string | null;
  thresholds: { halfDayHours: number; fullDayHours: number };
}

async function loggedHours(db: Prisma.TransactionClient | typeof prisma, userId: string, workDate: string): Promise<number> {
  const rows = await db.timesheet.findMany({
    where: { userId, workDate: dayStart(workDate), status: { not: "REJECTED" }, deletedAt: null },
    select: { totalHours: true }
  });
  return r2(rows.reduce((s, r) => s + Number(r.totalHours), 0));
}

export async function compOffEligibility(userId: string, workDate: string, now: Date = new Date(), db: Prisma.TransactionClient | typeof prisma = prisma): Promise<CompOffEligibility> {
  const [settings, planning, person] = await Promise.all([
    getAttendanceSettings(),
    getPlanningSettings(),
    db.user.findUnique({ where: { id: userId }, select: { id: true, timezone: true, holidayCalendarId: true } })
  ]);
  if (!person) throw new AppError(404, "User not found");
  const half = Number(settings.compOffHalfDayHours ?? 4);
  const full = Number(settings.compOffFullDayHours ?? 8);
  const base = { workDate, thresholds: { halfDayHours: half, fullDayHours: full } };
  const today = todayKeyFor(now, person.timezone, serverTimezone);
  if (workDate > today) return { ...base, eligible: false, dayKind: null, holidayName: null, hoursLogged: 0, days: 0, problem: "That day has not happened yet." };
  if (workDate < addDaysKey(today, -MAX_BACKDATE_DAYS)) {
    return { ...base, eligible: false, dayKind: null, holidayName: null, hoursLogged: 0, days: 0, problem: `Comp-off can be requested up to ${MAX_BACKDATE_DAYS} days after the day worked.` };
  }
  const holidayOf = await loadHolidays([person.holidayCalendarId], workDate, workDate);
  const day = resolveDayStatus({
    dateKey: workDate,
    workingDays: planning.workingDays,
    holiday: holidayOf(person.holidayCalendarId, workDate, person.id),
    leave: null,
    punchedIn: false,
    now,
    timeZone: person.timezone,
    fallbackZone: serverTimezone
  });
  const dayKind = day.status === "WEEKEND" || day.status === "HOLIDAY" ? day.status : null;
  const hoursLogged = await loggedHours(db, userId, workDate);
  const days = dayKind ? compOffDaysFor(hoursLogged, half, full) : 0;
  let problem: string | null = null;
  if (!dayKind) problem = "Comp-off is only for working on a weekend or a holiday.";
  else if (days === 0) problem = `Log at least ${half} hour(s) on that day to request half a day (${full} for a full day).`;
  return { ...base, eligible: problem === null, dayKind, holidayName: day.holidayName, hoursLogged, days, problem };
}

/* ------------------------------------------------------------------ *
 * Request / cancel
 * ------------------------------------------------------------------ */

async function lockPerson(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM \`User\` WHERE id = ${userId} FOR UPDATE`;
}

async function approverRecipients(request: { userId: string; approverId: string | null }, fallback: Fallback) {
  if (request.approverId) {
    const manager = await prisma.user.findFirst({ where: { id: request.approverId, status: "ACTIVE", deletedAt: null }, select: { id: true } });
    if (manager) return [manager, ...(await delegatesOf(manager.id)).filter((d) => d.id !== request.userId && d.id !== manager.id)];
  }
  const roles = fallback === "SUPER_ADMINS" ? ["SUPER_ADMIN"] : ["SUPER_ADMIN", "ADMIN"];
  return prisma.user.findMany({
    where: { status: "ACTIVE", deletedAt: null, isAgent: false, id: { not: request.userId }, role: { name: { in: roles as never } } },
    select: { id: true },
    take: 25
  });
}

function webhookPayload(r: CompOffRow, person: { email: string; employeeCode?: string | null }, leaveTypeCode?: string | null) {
  return {
    id: r.id,
    employee: { email: person.email, employeeCode: person.employeeCode ?? null },
    workDate: toKey(r.workDate),
    dayKind: r.dayKind,
    days: Number(r.days),
    status: r.status,
    leaveType: leaveTypeCode ?? null,
    expiresOn: r.expiresOn ? toKey(r.expiresOn) : null
  };
}

export async function requestCompOff(input: { userId: string; workDate: string; reason?: string | null; now?: Date }) {
  await assertCompOffOn();
  const now = input.now ?? new Date();
  const settings = await getAttendanceSettings();
  const person = await prisma.user.findUnique({ where: { id: input.userId }, select: { id: true, name: true, email: true, employeeCode: true, managerId: true } });
  if (!person) throw new AppError(404, "User not found");
  const created = await prisma.$transaction(async (tx) => {
    await lockPerson(tx, input.userId);
    const elig = await compOffEligibility(input.userId, input.workDate, now, tx);
    if (!elig.eligible) throw new AppError(422, elig.problem ?? "Not eligible for comp-off.", { code: "COMPOFF_NOT_ELIGIBLE" });
    const open = await tx.compOffRequest.findFirst({
      where: { userId: input.userId, workDate: dayStart(input.workDate), status: { in: ["PENDING", "APPROVED"] } },
      select: { id: true }
    });
    if (open) throw new AppError(409, "You already have a comp-off request for that day.", { code: "COMPOFF_DUPLICATE" });
    return tx.compOffRequest.create({
      data: {
        userId: input.userId,
        workDate: dayStart(input.workDate),
        dayKind: elig.dayKind!,
        hoursLogged: elig.hoursLogged,
        days: elig.days,
        reason: input.reason?.trim() || null,
        status: "PENDING",
        approverId: person.managerId ?? null
      },
      include: { user: USER_SELECT }
    });
  });
  await audit(input.userId, "compoff.requested", "CompOffRequest", created.id, { workDate: input.workDate, days: Number(created.days) });
  emitDomainEvent("compoff.requested", webhookPayload(created, person, settings.compOffLeaveTypeCode));
  const fallback: Fallback = settings.leaveApprovalFallback ?? "ADMINS";
  for (const r of await approverRecipients(created, fallback)) {
    // In-app through the normal pipeline (category leave.requested, so the approver's leave email
    // preference governs it). No reason in the text: it is for the decider, read in the app.
    await dispatchNotification({
      userId: r.id,
      category: "leave.requested",
      title: `${person.name} requested comp-off`,
      body: `Worked ${input.workDate} · ${Number(created.days)} day(s)`,
      link: "/app/attendance?tab=leave-inbox",
      metadata: { compOffRequestId: created.id }
    });
  }
  return publicCompOff(created);
}

export async function listMyCompOff(userId: string) {
  await assertCompOffOn();
  const rows = await prisma.compOffRequest.findMany({ where: { userId }, orderBy: { workDate: "desc" }, take: 200 });
  return rows.map((r) => publicCompOff(r));
}

export async function cancelCompOff(userId: string, id: string, now: Date = new Date()) {
  await assertCompOffOn();
  const row = await prisma.compOffRequest.findFirst({ where: { id, userId } });
  if (!row) throw new AppError(404, "Comp-off request not found");
  if (row.status !== "PENDING") throw new AppError(409, "Only a pending comp-off request can be cancelled.", { code: "COMPOFF_NOT_CANCELLABLE" });
  const claimed = await prisma.compOffRequest.updateMany({ where: { id, status: "PENDING" }, data: { status: "CANCELLED", cancelledAt: now } });
  if (claimed.count !== 1) throw new AppError(409, "This request changed while you were cancelling it. Refresh and try again.");
  await audit(userId, "compoff.cancelled", "CompOffRequest", id, {});
  return publicCompOff({ ...row, status: "CANCELLED", cancelledAt: now });
}

/* ------------------------------------------------------------------ *
 * Approver
 * ------------------------------------------------------------------ */

export async function listCompOffInbox(actor: { id: string; role: string }, now: Date = new Date()) {
  await assertCompOffOn();
  const settings = await getAttendanceSettings();
  const fallback: Fallback = settings.leaveApprovalFallback ?? "ADMINS";
  const rows = await prisma.compOffRequest.findMany({
    where: { status: "PENDING", userId: { not: actor.id } },
    orderBy: { workDate: "asc" },
    take: 500,
    include: { user: USER_SELECT }
  });
  const approverIds = [...new Set(rows.map((r) => r.approverId).filter((x): x is string => Boolean(x)))];
  const active = approverIds.length ? await prisma.user.findMany({ where: { id: { in: approverIds }, ...NOT_DEACTIVATED }, select: { id: true } }) : [];
  const activeIds = new Set(active.map((u) => u.id));
  const out = [];
  for (const r of rows) {
    const right = await resolveDecisionRight(actor, r, Boolean(r.approverId && activeIds.has(r.approverId)), fallback, now);
    // A super admin's OVERRIDE is not "waiting on them": the inbox lists what is theirs to decide.
    if (right && right.right !== "OVERRIDE") out.push({ ...publicCompOff(r), onBehalfOf: right.onBehalfOfId });
  }
  return { total: out.length, items: out };
}

export async function decideCompOff(input: { actor: { id: string; role: string; name?: string | null }; requestId: string; decision: "APPROVE" | "REJECT"; note?: string | null; now?: Date }) {
  await assertCompOffOn();
  const now = input.now ?? new Date();
  const settings = await getAttendanceSettings();
  const fallback: Fallback = settings.leaveApprovalFallback ?? "ADMINS";
  const request = await prisma.compOffRequest.findUnique({ where: { id: input.requestId } });
  if (!request) throw new AppError(403, OUT_OF_SCOPE);
  const approverActive = request.approverId
    ? Boolean(await prisma.user.findFirst({ where: { id: request.approverId, ...NOT_DEACTIVATED }, select: { id: true } }))
    : false;
  const right = await resolveDecisionRight(input.actor, request, approverActive, fallback, now);
  if (!right) throw new AppError(403, OUT_OF_SCOPE);
  if (request.status !== "PENDING") throw new AppError(409, `This request is already ${request.status.toLowerCase()}.`, { code: "COMPOFF_ALREADY_DECIDED" });
  const approve = input.decision === "APPROVE";
  const days = Number(request.days);
  const workDate = toKey(request.workDate);
  const leaveYear = leaveYearOf(workDate, settings.leaveYearStartMonth ?? 1);
  const type = approve ? await prisma.leaveType.findUnique({ where: { code: settings.compOffLeaveTypeCode ?? "CO" } }) : null;
  if (approve && !type) throw new AppError(409, `The comp-off leave type (${settings.compOffLeaveTypeCode ?? "CO"}) does not exist. An admin must create it.`, { code: "COMPOFF_TYPE_MISSING" });
  const today = todayKeyFor(now, null, serverTimezone);
  const expiresOn = approve && settings.compOffExpiryDays ? addDaysKey(today, Number(settings.compOffExpiryDays)) : null;
  const person = await prisma.user.findUnique({ where: { id: request.userId }, select: { id: true, name: true, email: true, employeeCode: true } });

  const decided = await prisma.$transaction(async (tx) => {
    await lockPerson(tx, request.userId);
    const claimed = await tx.compOffRequest.updateMany({
      where: { id: request.id, status: "PENDING" },
      data: {
        status: approve ? "APPROVED" : "REJECTED",
        decidedById: input.actor.id,
        onBehalfOfId: right.onBehalfOfId,
        decidedAt: now,
        decisionNote: input.note?.trim() || null,
        overriddenBySuperAdmin: right.right === "OVERRIDE",
        ...(approve ? { leaveTypeId: type!.id, leaveYear, expiresOn: expiresOn ? dayStart(expiresOn) : null } : {})
      }
    });
    if (claimed.count !== 1) throw new AppError(409, "This request has just been decided by someone else.", { code: "COMPOFF_ALREADY_DECIDED" });
    if (approve) {
      await tx.leaveBalanceLedger.create({
        data: {
          userId: request.userId,
          leaveTypeId: type!.id,
          leaveYear,
          delta: days,
          kind: "ADJUSTMENT",
          reason: `Comp-off for ${workDate}`,
          refRequestId: request.id,
          actorId: input.actor.id,
          idempotencyKey: `COMPOFF:${request.id}`
        }
      });
      await settleLateMovement(tx, { userId: request.userId, type: type!, year: leaveYear, sourceKey: `COMPOFF:${request.id}`, actorId: input.actor.id });
    }
    return tx.compOffRequest.findUniqueOrThrow({ where: { id: request.id }, include: { user: USER_SELECT } });
  });

  await audit(input.actor.id, approve ? "compoff.approved" : "compoff.rejected", "CompOffRequest", request.id, {
    days,
    workDate,
    overriddenBySuperAdmin: right.right === "OVERRIDE",
    ...(right.onBehalfOfId ? { onBehalfOf: right.onBehalfOfId } : {})
  });
  if (approve && person) emitDomainEvent("compoff.approved", webhookPayload(decided, person, type?.code));
  await dispatchNotification({
    userId: request.userId,
    category: "leave.decided",
    title: `Your comp-off for ${workDate} was ${approve ? "approved" : "rejected"}`,
    body: approve ? `${days} day(s) added to ${type!.name}${expiresOn ? `, use by ${expiresOn}` : ""}` : (input.note?.trim() ?? ""),
    link: "/app/attendance?tab=leave",
    metadata: { compOffRequestId: request.id }
  });
  return publicCompOff(decided);
}

/* ------------------------------------------------------------------ *
 * Expiry (called by the nightly accrual worker)
 * ------------------------------------------------------------------ */

/**
 * Takes back what is unspent of every approved credit whose expiresOn has passed: min(credit, the
 * type's balance in that leave year), never below zero. Keyed `COMPOFF-EXPIRY:<id>`, so a re-run (or
 * two instances) cannot expire twice. Runs whether or not comp-off is still switched on — a credit
 * granted with an expiry keeps it — but only while leave itself is on.
 */
export async function expireCompOffCredits(now: Date = new Date()): Promise<number> {
  if (!(await isLeaveOn())) return 0;
  const today = todayKeyFor(now, null, serverTimezone);
  const due = await prisma.compOffRequest.findMany({
    where: { status: "APPROVED", expiredAt: null, expiresOn: { lte: dayStart(today) } },
    take: 5000
  });
  let expired = 0;
  for (const r of due) {
    if (!r.leaveTypeId || r.leaveYear == null) continue;
    await prisma.$transaction(async (tx) => {
      await lockPerson(tx, r.userId);
      const sums = await tx.leaveBalanceLedger.groupBy({ by: ["leaveTypeId"], where: { userId: r.userId, leaveTypeId: r.leaveTypeId!, leaveYear: r.leaveYear! }, _sum: { delta: true } });
      const balance = Number(sums[0]?._sum.delta ?? 0);
      const take = r2(Math.min(Number(r.days), Math.max(0, balance)));
      if (take > 0) {
        const exists = await tx.leaveBalanceLedger.findFirst({ where: { idempotencyKey: `COMPOFF-EXPIRY:${r.id}` }, select: { id: true } });
        if (!exists) {
          await tx.leaveBalanceLedger.create({
            data: {
              userId: r.userId,
              leaveTypeId: r.leaveTypeId!,
              leaveYear: r.leaveYear!,
              delta: -take,
              kind: "ADJUSTMENT",
              reason: `Comp-off for ${toKey(r.workDate)} expired`,
              refRequestId: r.id,
              idempotencyKey: `COMPOFF-EXPIRY:${r.id}`
            }
          });
          expired += 1;
        }
      }
      await tx.compOffRequest.updateMany({ where: { id: r.id, expiredAt: null }, data: { expiredAt: now } });
    });
  }
  return expired;
}
