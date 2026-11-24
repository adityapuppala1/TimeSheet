/**
 * 7.0.0 — regularisation: a person asks to add or correct the punch-in / punch-out of a past day,
 * with a reason, and the manager decides.
 *
 * THE GATE: attendance on (toggle AND plan, assertAttendanceOn) AND
 * GlobalAttendanceSettings.regularizationEnabled. Off (the default), every route refuses and nothing
 * here runs. Phase A decided "no corrections"; this is opt-in for workspaces that want them.
 *
 * RULES (never taken from the client):
 *   - a PAST day: before today in the person's zone, and at most regularizationMaxDaysBack ago;
 *   - punch-in must belong to that work date (shift-aware: currentWorkDay, the same rule ingest
 *     uses), punch-out after punch-in, within 24 hours, and not in the future;
 *   - one PENDING request per day, and at most regularizationMonthlyCap PENDING + APPROVED requests
 *     per calendar month of the day corrected. Both checked under a row lock on the person, so two
 *     requests sent at once cannot both slip under the cap.
 *
 * WHO DECIDES: exactly the leave rule (leave.service.ts#resolveDecisionRight — the manager, the admin
 * pool when there is none, a super admin override, an active delegate on the approver's behalf).
 *
 * THE WRITE: approval claims PENDING → APPROVED with a conditional update (a racing second approval
 * gets 409), then calls ingestPunch with source REGULARIZATION and externalRef `REG:<id>`. That
 * source outranks every other one, so it takes the record over; ingest keeps the replaced punch on
 * the new event (`input.previous`) and marks the old events SUPERSEDED — nothing is deleted. The
 * request also keeps the punch it saw when it was made (originalPunchInAt / originalPunchOutAt).
 *
 * PRIVACY: the reason is shown to the requester and to people who may decide the request. Every
 * other view (team timeline, analytics, exports) sees only that the day's source is a correction.
 */
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../config/prisma.js";
import { serverTimezone } from "../config/env.js";
import { AppError } from "../middleware/error.js";
import { getAttendanceSettings, isoDate } from "./attendance-settings.service.js";
import { todayKeyFor } from "./attendance-day-status.js";
import { currentWorkDay } from "./attendance-shift.service.js";
import { assertAttendanceOn, isAttendanceOn } from "./attendance-punch.service.js";
import { ingestPunch, parseInstant } from "./attendance-ingest.service.js";
import { audit } from "./audit.service.js";
import { dispatchNotification } from "./notify.service.js";
import { decisionEmail, requestedEmail } from "./attendance-request-mail.js";
import { NOT_DEACTIVATED } from "./people-visibility.service.js";
import { addDaysKey } from "./leave-calc.js";
import { delegatesOf } from "./approval-delegation.service.js";
import { resolveDecisionRight, type Fallback } from "./leave.service.js";

const toKey = (d: Date) => d.toISOString().slice(0, 10);
const dayStart = (k: string) => new Date(`${k}T00:00:00.000Z`);
const OUT_OF_SCOPE = "You can only decide correction requests that are waiting on you.";
const MAX_SHIFT_MS = 24 * 60 * 60 * 1000;
const FUTURE_TOLERANCE_MS = 10 * 60 * 1000;

/** ISO-8601 instants with a zone; parseInstant is the one parser (a bare local time is refused). */
const instant = z.string().trim().min(16).max(40);

export const regularizationRequestBody = z
  .object({
    workDate: isoDate,
    punchInAt: instant,
    punchOutAt: instant.nullable().optional(),
    reason: z.string().trim().min(3).max(2000)
  })
  .strict();

export const regularizationDecisionBody = z
  .object({ decision: z.enum(["APPROVE", "REJECT"]), note: z.string().trim().max(2000).optional() })
  .strict()
  .refine((b) => b.decision === "APPROVE" || Boolean(b.note), { message: "Add a note explaining the rejection." });

export const regularizationSettingsBody = z
  .object({
    regularizationEnabled: z.boolean(),
    regularizationMaxDaysBack: z.number().int().min(1).max(60),
    regularizationMonthlyCap: z.number().int().min(1).max(31)
  })
  .partial()
  .strict();

export function publicRegularizationSettings(s: Record<string, unknown>) {
  return {
    regularizationEnabled: Boolean(s.regularizationEnabled),
    regularizationMaxDaysBack: Number(s.regularizationMaxDaysBack ?? 7),
    regularizationMonthlyCap: Number(s.regularizationMonthlyCap ?? 3)
  };
}

export async function isRegularizationOn(): Promise<boolean> {
  if (!(await isAttendanceOn())) return false;
  return Boolean((await getAttendanceSettings()).regularizationEnabled);
}

export async function assertRegularizationOn(): Promise<void> {
  await assertAttendanceOn();
  if (!(await getAttendanceSettings()).regularizationEnabled) {
    throw new AppError(403, "Attendance corrections are off for this workspace. A super admin can enable them in Workspace Settings → Attendance & Leave.");
  }
}

type Row = Prisma.AttendanceRegularizationRequestGetPayload<object> & {
  user?: { id: string; name: string; email: string; avatarUrl?: string | null } | null;
};

/** `withReason: false` for any viewer who is neither the requester nor someone who may decide. */
export function publicRegularization(r: Row, opts: { withReason: boolean }) {
  return {
    id: r.id,
    user: r.user ? { id: r.user.id, name: r.user.name, email: r.user.email, avatarUrl: r.user.avatarUrl ?? null } : undefined,
    workDate: toKey(r.workDate),
    punchInAt: r.punchInAt.toISOString(),
    punchOutAt: r.punchOutAt?.toISOString() ?? null,
    originalPunchInAt: r.originalPunchInAt?.toISOString() ?? null,
    originalPunchOutAt: r.originalPunchOutAt?.toISOString() ?? null,
    reason: opts.withReason ? r.reason : null,
    status: r.status,
    approverId: r.approverId,
    decidedById: r.decidedById,
    onBehalfOfId: r.onBehalfOfId,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    decisionNote: opts.withReason ? r.decisionNote : null,
    createdAt: r.createdAt.toISOString()
  };
}

const USER_SELECT = { select: { id: true, name: true, email: true, avatarUrl: true } } as const;

/* ------------------------------------------------------------------ *
 * Pure checks (exported for tests)
 * ------------------------------------------------------------------ */

/** Why `workDate` cannot be corrected today, or null. */
export function daysBackProblem(workDate: string, today: string, maxDaysBack: number): string | null {
  if (workDate >= today) return "Corrections are for past days. Punch in or out as usual for today.";
  if (workDate < addDaysKey(today, -maxDaysBack)) return `Corrections can be asked for up to ${maxDaysBack} day(s) back.`;
  return null;
}

/** Why the punch pair cannot be a punch, or null. */
export function punchPairProblem(punchInAt: Date | null, punchOutAt: Date | null, outSent: boolean, now: Date): string | null {
  if (!punchInAt) return "punchInAt must be an ISO-8601 timestamp with a timezone.";
  if (outSent && !punchOutAt) return "punchOutAt must be an ISO-8601 timestamp with a timezone.";
  if (punchOutAt && punchOutAt <= punchInAt) return "Punch-out must be after punch-in.";
  if (punchOutAt && punchOutAt.getTime() - punchInAt.getTime() > MAX_SHIFT_MS) return "A day's punch can't be longer than 24 hours.";
  const latest = (punchOutAt ?? punchInAt).getTime();
  if (latest > now.getTime() + FUTURE_TOLERANCE_MS) return "That time hasn't happened yet.";
  return null;
}

/** The calendar month (YYYY-MM) bounds of a day key, as DATE instants. */
export function monthBounds(workDate: string): { gte: Date; lt: Date } {
  const [y, m] = workDate.split("-").map(Number);
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return { gte: dayStart(`${workDate.slice(0, 7)}-01`), lt: dayStart(next) };
}

/* ------------------------------------------------------------------ *
 * Request / list / cancel
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

export interface RegularizationInput {
  userId: string;
  workDate: string;
  punchInAt: string;
  punchOutAt?: string | null;
  reason: string;
  now?: Date;
}

export async function requestRegularization(input: RegularizationInput) {
  await assertRegularizationOn();
  const now = input.now ?? new Date();
  const settings = await getAttendanceSettings();
  const person = await prisma.user.findFirst({
    where: { id: input.userId, ...NOT_DEACTIVATED },
    select: { id: true, name: true, timezone: true, managerId: true }
  });
  if (!person) throw new AppError(404, "User not found");

  const today = todayKeyFor(now, person.timezone, serverTimezone);
  const tooOld = daysBackProblem(input.workDate, today, Number(settings.regularizationMaxDaysBack ?? 7));
  if (tooOld) throw new AppError(422, tooOld, { code: "REGULARIZATION_OUT_OF_RANGE" });

  const punchInAt = parseInstant(input.punchInAt);
  const outSent = input.punchOutAt != null && input.punchOutAt !== "";
  const punchOutAt = outSent ? parseInstant(input.punchOutAt) : null;
  const bad = punchPairProblem(punchInAt, punchOutAt, outSent, now);
  if (bad || !punchInAt) throw new AppError(422, bad ?? "Invalid punch.", { code: "REGULARIZATION_INVALID_PUNCH" });
  // The same work-date rule ingest will apply on approval (a night shift files on its start date).
  const filed = (await currentWorkDay(person.id, punchInAt, person.timezone, serverTimezone)).dateKey;
  if (filed !== input.workDate) {
    throw new AppError(422, `That punch-in falls on ${filed}, not ${input.workDate}.`, { code: "REGULARIZATION_INVALID_PUNCH" });
  }

  const cap = Number(settings.regularizationMonthlyCap ?? 3);
  const created = await prisma.$transaction(async (tx) => {
    await lockPerson(tx, person.id);
    const open = await tx.attendanceRegularizationRequest.findFirst({
      where: { userId: person.id, workDate: dayStart(input.workDate), status: "PENDING" },
      select: { id: true }
    });
    if (open) throw new AppError(409, "You already have a correction waiting for that day.", { code: "REGULARIZATION_DUPLICATE" });
    const used = await tx.attendanceRegularizationRequest.count({
      where: { userId: person.id, workDate: monthBounds(input.workDate), status: { in: ["PENDING", "APPROVED"] } }
    });
    if (used >= cap) throw new AppError(422, `You can ask for up to ${cap} correction(s) a month.`, { code: "REGULARIZATION_CAP" });
    const existing = await tx.attendanceRecord.findUnique({
      where: { userId_workDate: { userId: person.id, workDate: dayStart(input.workDate) } },
      select: { punchInAt: true, punchOutAt: true }
    });
    return tx.attendanceRegularizationRequest.create({
      data: {
        userId: person.id,
        workDate: dayStart(input.workDate),
        punchInAt,
        punchOutAt,
        originalPunchInAt: existing?.punchInAt ?? null,
        originalPunchOutAt: existing?.punchOutAt ?? null,
        reason: input.reason.trim(),
        status: "PENDING",
        approverId: person.managerId ?? null
      },
      include: { user: USER_SELECT }
    });
  });

  // The reason is not in the audit metadata or the notification: it is read in the app, by deciders.
  await audit(person.id, "attendance.regularization_requested", "AttendanceRegularizationRequest", created.id, { workDate: input.workDate });
  const fallback: Fallback = settings.leaveApprovalFallback ?? "ADMINS";
  for (const r of await approverRecipients(created, fallback)) {
    await dispatchNotification({
      userId: r.id,
      category: "leave.requested",
      title: `${person.name} asked to correct their attendance`,
      body: `For ${input.workDate}`,
      link: "/app/attendance/team",
      email: requestedEmail({ approverName: r.name, employeeName: person.name, kind: "attendance correction", summary: `For ${input.workDate}` }),
      metadata: { regularizationRequestId: created.id }
    });
  }
  return publicRegularization(created, { withReason: true });
}

export async function listMyRegularizations(userId: string) {
  await assertRegularizationOn();
  const rows = await prisma.attendanceRegularizationRequest.findMany({ where: { userId }, orderBy: { workDate: "desc" }, take: 200 });
  return rows.map((r) => publicRegularization(r, { withReason: true }));
}

export async function cancelRegularization(userId: string, id: string, now: Date = new Date()) {
  await assertRegularizationOn();
  const row = await prisma.attendanceRegularizationRequest.findFirst({ where: { id, userId } });
  if (!row) throw new AppError(404, "Correction request not found");
  if (row.status !== "PENDING") throw new AppError(409, "Only a pending correction can be cancelled.", { code: "REGULARIZATION_NOT_CANCELLABLE" });
  const claimed = await prisma.attendanceRegularizationRequest.updateMany({ where: { id, userId, status: "PENDING" }, data: { status: "CANCELLED", cancelledAt: now } });
  if (claimed.count !== 1) throw new AppError(409, "This request changed while you were cancelling it. Refresh and try again.");
  await audit(userId, "attendance.regularization_cancelled", "AttendanceRegularizationRequest", id, {});
  return publicRegularization({ ...row, status: "CANCELLED", cancelledAt: now }, { withReason: true });
}

/* ------------------------------------------------------------------ *
 * Approver
 * ------------------------------------------------------------------ */

async function isActiveApprover(id: string | null): Promise<boolean> {
  if (!id) return false;
  return Boolean(await prisma.user.findFirst({ where: { id, ...NOT_DEACTIVATED }, select: { id: true } }));
}

export async function listRegularizationInbox(actor: { id: string; role: string }, now: Date = new Date()) {
  await assertRegularizationOn();
  const settings = await getAttendanceSettings();
  const fallback: Fallback = settings.leaveApprovalFallback ?? "ADMINS";
  const rows = await prisma.attendanceRegularizationRequest.findMany({
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
    // Only what is theirs to decide; an override right is not "waiting on them" and sees nothing here.
    if (right && right.right !== "OVERRIDE") out.push({ ...publicRegularization(r, { withReason: true }), onBehalfOf: right.onBehalfOfId });
  }
  return { total: out.length, items: out };
}

export async function decideRegularization(input: {
  actor: { id: string; role: string };
  requestId: string;
  decision: "APPROVE" | "REJECT";
  note?: string | null;
  now?: Date;
}) {
  await assertRegularizationOn();
  const now = input.now ?? new Date();
  const settings = await getAttendanceSettings();
  const fallback: Fallback = settings.leaveApprovalFallback ?? "ADMINS";
  const request = await prisma.attendanceRegularizationRequest.findUnique({ where: { id: input.requestId } });
  // Same 403 for "no such request" and "not yours": the id is not a probe.
  if (!request) throw new AppError(403, OUT_OF_SCOPE);
  const right = await resolveDecisionRight(input.actor, request, await isActiveApprover(request.approverId), fallback, now);
  if (!right) throw new AppError(403, OUT_OF_SCOPE);
  if (request.status !== "PENDING") throw new AppError(409, `This request is already ${request.status.toLowerCase()}.`, { code: "REGULARIZATION_ALREADY_DECIDED" });
  const approve = input.decision === "APPROVE";

  // Claim first: of two racing decisions exactly one moves PENDING on; the other gets 409 and
  // never reaches ingest.
  const claimed = await prisma.attendanceRegularizationRequest.updateMany({
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
  if (claimed.count !== 1) throw new AppError(409, "This request has just been decided by someone else.", { code: "REGULARIZATION_ALREADY_DECIDED" });

  if (approve) {
    try {
      const result = await ingestPunch({
        kind: "REGULARIZATION",
        userId: request.userId,
        punchInAt: request.punchInAt,
        punchOutAt: request.punchOutAt,
        // Unique per request: even a replayed approval cannot write the day twice.
        externalRef: `REG:${request.id}`,
        rawPayload: { regularizationRequestId: request.id, decidedById: input.actor.id },
        now
      });
      if (result.status !== "ACCEPTED" && result.status !== "DUPLICATE") {
        throw new AppError(409, result.reason ?? "The correction could not be applied.", { code: "REGULARIZATION_NOT_APPLIED" });
      }
      await prisma.attendanceRegularizationRequest.update({ where: { id: request.id }, data: { eventId: result.eventId } });
    } catch (error) {
      // Put the request back so it can be decided again rather than sit APPROVED with no punch.
      await prisma.attendanceRegularizationRequest.updateMany({
        where: { id: request.id, status: "APPROVED", eventId: null },
        data: { status: "PENDING", decidedById: null, onBehalfOfId: null, decidedAt: null, decisionNote: null, overriddenBySuperAdmin: false }
      });
      throw error;
    }
  }

  await audit(input.actor.id, approve ? "attendance.regularization_approved" : "attendance.regularization_rejected", "AttendanceRegularizationRequest", request.id, {
    workDate: toKey(request.workDate),
    overriddenBySuperAdmin: right.right === "OVERRIDE",
    ...(right.onBehalfOfId ? { onBehalfOf: right.onBehalfOfId } : {})
  });
  await dispatchNotification({
    userId: request.userId,
    category: "leave.decided",
    title: `Your attendance correction for ${toKey(request.workDate)} was ${approve ? "approved" : "rejected"}`,
    body: approve ? "Your attendance for that day now shows the corrected times." : (input.note?.trim() ?? ""),
    link: "/app/attendance",
    email: await decisionEmail(request.userId, input.actor, { kind: "attendance correction", approve, summary: `For ${toKey(request.workDate)}`, note: input.note ?? null }),
    metadata: { regularizationRequestId: request.id }
  });
  const decided = await prisma.attendanceRegularizationRequest.findUniqueOrThrow({ where: { id: request.id }, include: { user: USER_SELECT } });
  return publicRegularization(decided, { withReason: true });
}
