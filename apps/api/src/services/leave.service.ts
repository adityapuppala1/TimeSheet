/**
 * V17 Phase B — leave: types, balances, requests, approval.
 *
 * THE GATE: GlobalAttendanceSettings.leaveEnabled AND PlanTierLimit.leaveManagementEnabled, the same
 * toggle-AND-entitlement rule as attendance (isLeaveOn / assertLeaveOn). Independent of the
 * attendance toggle: a workspace may run leave without punch-in.
 *
 * WHO DECIDES (decisionRight — pure, and the ONLY place the rule lives):
 *   - the person's manager (User.managerId, captured as LeaveRequest.approverId when the request is
 *     made) — while that manager is still an active account;
 *   - otherwise the admin pool: any ADMIN or SUPER_ADMIN, or SUPER_ADMIN only, per
 *     GlobalAttendanceSettings.leaveApprovalFallback;
 *   - a SUPER_ADMIN may decide ANY request. When it was not theirs to decide, the request is marked
 *     overriddenBySuperAdmin and the audit row says so;
 *   - nobody decides their own request, except a SUPER_ADMIN (an override, flagged) — the sole
 *     super admin of a small workspace has no one else to ask.
 * The inbox lists exactly what decisionRight allows; a decision on anything else — including an id
 * that does not exist — is the SAME 403, so ids cannot be probed (IDOR).
 *
 * CONCURRENCY — why a double click can never debit twice:
 *   1. The decision is a CONDITIONAL update: `updateMany where { id, status: PENDING }`. Only one of
 *      two racing approvals sees count = 1; the other gets 409 and writes nothing.
 *   2. The debit is written in the SAME transaction with idempotencyKey `DEBIT:<requestId>`, which is
 *      UNIQUE in the database. Even if (1) were removed, the second insert fails and its transaction
 *      rolls back (tests/unit/leave-service.test.ts falsifies this guard on purpose).
 *   3. Writes that read a balance (apply, approve, cancel) first take a row lock on the person
 *      (SELECT … FOR UPDATE on User), so two different requests for the same person are judged one
 *      after the other, never both against the same stale sum.
 *
 * THE BALANCE is never stored: it is the sum of LeaveBalanceLedger rows (see schema.prisma). Days
 * are computed here from the dates (leave-calc.ts#countLeaveDays) and never accepted from a client.
 */
import type { AttendanceSourceKind, LeaveRequest, LeaveRequestStatus, LeaveType, Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../config/prisma.js";
import { serverTimezone } from "../config/env.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { AppError } from "../middleware/error.js";
import { getAttendanceSettings, isoDate } from "./attendance-settings.service.js";
import { todayKeyFor } from "./attendance-day-status.js";
import { assertTeamScope, loadHolidays, peopleWhere } from "./attendance-team.service.js";
import { audit } from "./audit.service.js";
import { emitDomainEvent } from "./domain-events.js";
import { dispatchNotification } from "./notify.service.js";
import { templates } from "./mail-templates.js";
import { getPlanningSettings } from "./planning.service.js";
import { isPlanningCapabilityAllowed } from "./plan-limits.service.js";
import { NOT_DEACTIVATED } from "./people-visibility.service.js";
import { carryChange, isYearSettled, settleLateMovement, settlementFacts } from "./leave-settlement.service.js";
import { runInBackground } from "../utils/run-in-background.js";
import {
  accrualDueThrough,
  addDaysKey,
  countLeaveDays,
  excludedDays,
  findClash,
  leaveYearBounds,
  halfLabel,
  leaveYearOf,
  rangeLabel,
  spanErrors,
  type LeaveHalf
} from "./leave-calc.js";

/* ------------------------------------------------------------------ *
 * Gate
 * ------------------------------------------------------------------ */

export async function isLeaveOn(): Promise<boolean> {
  const settings = await getAttendanceSettings();
  if (!settings?.leaveEnabled) return false;
  return isPlanningCapabilityAllowed(requireTenantContext().orgId, "leaveManagementEnabled");
}

export async function assertLeaveOn(): Promise<void> {
  const settings = await getAttendanceSettings();
  if (!settings?.leaveEnabled) {
    throw new AppError(403, "Leave is off for this workspace. A super admin can enable it in Workspace Settings → Attendance & Leave.");
  }
  if (!(await isPlanningCapabilityAllowed(requireTenantContext().orgId, "leaveManagementEnabled"))) {
    throw new AppError(403, "Leave management is not included in this plan. Upgrade to Enterprise to use it.");
  }
}

/** Integrations (public API, HRMS webhook) additionally need the attendance-integrations entitlement. */
export async function assertLeaveIntegrationAllowed(): Promise<void> {
  await assertLeaveOn();
  if (!(await isPlanningCapabilityAllowed(requireTenantContext().orgId, "attendanceIntegrationsEnabled"))) {
    throw new AppError(403, "Attendance integrations are not included in this plan. Upgrade to Enterprise to use them.");
  }
}

/* ------------------------------------------------------------------ *
 * Validation shapes (no z.coerce: validate() discards its parse)
 * ------------------------------------------------------------------ */

const half = z.enum(["FULL", "FIRST_HALF", "SECOND_HALF"]);

export const leaveTypeBody = z
  .object({
    code: z.string().trim().regex(/^[A-Z][A-Z0-9_]{0,19}$/, "Upper-case letters, digits and underscores (max 20)"),
    name: z.string().trim().min(1).max(80),
    colour: z.string().trim().regex(/^[a-z][a-z0-9-]{0,31}$/, "A colour token name such as primary or warning"),
    annualQuota: z.number().min(0).max(366),
    accrual: z.enum(["YEARLY_UPFRONT", "MONTHLY_PRORATA"]),
    carryForwardMax: z.number().min(0).max(366),
    allowHalfDay: z.boolean(),
    isPaid: z.boolean(),
    requiresApproval: z.boolean(),
    requiresDocumentAfterDays: z.number().int().min(0).max(366).nullable(),
    allowNegative: z.boolean(),
    enabled: z.boolean(),
    sortOrder: z.number().int().min(0).max(10000)
  })
  .strict();

export const leaveSettingsBody = z
  .object({
    leaveEnabled: z.boolean(),
    leaveYearStartMonth: z.number().int().min(1).max(12),
    trustExternalApprovals: z.boolean(),
    leaveApprovalFallback: z.enum(["ADMINS", "SUPER_ADMINS"])
  })
  .partial()
  .strict();

/** Strings only, so the same schema reads a JSON body and a multipart form (with a document). */
export const applyLeaveBody = z
  .object({
    leaveTypeId: z.string().trim().min(1).max(64).optional(),
    leaveTypeCode: z.string().trim().min(1).max(20).optional(),
    startDate: isoDate,
    endDate: isoDate,
    startHalf: half.optional(),
    endHalf: half.optional(),
    reason: z.string().trim().max(2000).optional()
  })
  .strict()
  .refine((b) => Boolean(b.leaveTypeId) !== Boolean(b.leaveTypeCode), { message: "Send leaveTypeId or leaveTypeCode (one of them)." });

export const decisionBody = z
  .object({
    decision: z.enum(["APPROVE", "REJECT"]),
    note: z.string().trim().max(2000).optional()
  })
  .strict()
  // A rejection with no word of why is the one message people complain about.
  .refine((b) => b.decision === "APPROVE" || Boolean(b.note), { message: "Add a note explaining the rejection." });

export const bulkDecisionBody = z
  .object({
    ids: z.array(z.string().min(1).max(64)).min(1).max(50),
    decision: z.enum(["APPROVE", "REJECT"]),
    note: z.string().trim().max(2000).optional()
  })
  .strict()
  .refine((b) => b.decision === "APPROVE" || Boolean(b.note), { message: "Add a note explaining the rejection." });

export const adjustmentBody = z
  .object({
    userId: z.string().min(1).max(64),
    leaveTypeId: z.string().min(1).max(64),
    leaveYear: z.number().int().min(2000).max(2100).optional(),
    delta: z.number().min(-366).max(366).refine((n) => n !== 0, "A zero adjustment changes nothing."),
    reason: z.string().trim().min(1).max(255)
  })
  .strict();

/* ------------------------------------------------------------------ *
 * Limits
 * ------------------------------------------------------------------ */

/** How far back a request may start: a forgotten sick day last month, not last year. */
export const MAX_BACKDATE_DAYS = 60;
/** How far ahead a request may end. */
export const MAX_AHEAD_DAYS = 366;
/** Calendar days one request may span. Longer absences are several requests (or an HR process). */
export const MAX_SPAN_DAYS = 93;
const POOL_NOTIFY_CAP = 25;
const EXTERNAL_SOURCES = new Set<AttendanceSourceKind>(["API", "WEBHOOK", "CSV"]);

/* ------------------------------------------------------------------ *
 * Decision rights (pure)
 * ------------------------------------------------------------------ */

export type Fallback = "ADMINS" | "SUPER_ADMINS";
export type DecisionRight = "APPROVER" | "OVERRIDE";

export function inApproverPool(role: string, fallback: Fallback): boolean {
  if (role === "SUPER_ADMIN") return true;
  return fallback === "ADMINS" && role === "ADMIN";
}

/**
 * May `actor` decide `request`, and as what? `approverActive` = the captured approver is still an
 * active account (a manager who left must not strand their reports' requests). Pure.
 */
export function decisionRight(
  actor: { id: string; role: string },
  request: { userId: string; approverId: string | null },
  approverActive: boolean,
  fallback: Fallback
): DecisionRight | null {
  if (actor.id === request.userId) return actor.role === "SUPER_ADMIN" ? "OVERRIDE" : null;
  const effective = request.approverId && approverActive ? request.approverId : null;
  if (effective === actor.id) return "APPROVER";
  if (effective === null && inApproverPool(actor.role, fallback)) return "APPROVER";
  if (actor.role === "SUPER_ADMIN") return "OVERRIDE";
  return null;
}

const OUT_OF_SCOPE = "You can only decide leave requests that are waiting on you.";

/* ------------------------------------------------------------------ *
 * Shapes returned to clients
 * ------------------------------------------------------------------ */

const toKey = (d: Date) => d.toISOString().slice(0, 10);
const num = (d: Prisma.Decimal | number) => Number(d);

type RequestRow = LeaveRequest & {
  leaveType: Pick<LeaveType, "id" | "code" | "name" | "colour" | "isPaid">;
  user?: { id: string; name: string; email: string; avatarUrl?: string | null } | null;
};

export function publicLeaveType(t: LeaveType) {
  return {
    id: t.id,
    code: t.code,
    name: t.name,
    colour: t.colour,
    annualQuota: num(t.annualQuota),
    accrual: t.accrual,
    carryForwardMax: num(t.carryForwardMax),
    allowHalfDay: t.allowHalfDay,
    isPaid: t.isPaid,
    requiresApproval: t.requiresApproval,
    requiresDocumentAfterDays: t.requiresDocumentAfterDays,
    allowNegative: t.allowNegative,
    enabled: t.enabled,
    sortOrder: t.sortOrder
  };
}

export function publicRequest(r: RequestRow) {
  return {
    id: r.id,
    user: r.user ? { id: r.user.id, name: r.user.name, email: r.user.email, avatarUrl: r.user.avatarUrl ?? null } : undefined,
    leaveType: { id: r.leaveType.id, code: r.leaveType.code, name: r.leaveType.name, colour: r.leaveType.colour, isPaid: r.leaveType.isPaid },
    startDate: toKey(r.startDate),
    endDate: toKey(r.endDate),
    startHalf: r.startHalf,
    endHalf: r.endHalf,
    days: num(r.days),
    leaveYear: r.leaveYear,
    reason: r.reason,
    status: r.status,
    attachment: r.attachmentUrl ? { name: r.attachmentName, mimeType: r.attachmentMimeType, size: r.attachmentSize, url: r.attachmentUrl } : null,
    approverId: r.approverId,
    decidedById: r.decidedById,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    decisionNote: r.decisionNote,
    overriddenBySuperAdmin: r.overriddenBySuperAdmin,
    cancelledAt: r.cancelledAt?.toISOString() ?? null,
    source: r.source,
    externalRef: r.externalRef,
    createdAt: r.createdAt.toISOString()
  };
}

export type PublicLeaveRequest = ReturnType<typeof publicRequest>;

/** A request as someone OTHER than the requester and approver may see it: no reason, note or file. */
export function withoutPrivateText(r: PublicLeaveRequest): Omit<PublicLeaveRequest, "reason" | "decisionNote" | "attachment"> {
  const copy: Partial<PublicLeaveRequest> = { ...r };
  delete copy.reason;
  delete copy.decisionNote;
  delete copy.attachment;
  return copy as Omit<PublicLeaveRequest, "reason" | "decisionNote" | "attachment">;
}

function autoNote(autoApprove: boolean, trusted: boolean): string | null {
  if (!autoApprove) return null;
  return trusted ? "Approved in the source system" : "Approved automatically (no approval needed)";
}

/** The webhook payload: facts an HRMS or payroll needs, never the free-text reason or note. */
function webhookPayload(r: RequestRow, person: { email: string; employeeCode?: string | null }) {
  return {
    id: r.id,
    employee: { email: person.email, employeeCode: person.employeeCode ?? null },
    leaveType: r.leaveType.code,
    startDate: toKey(r.startDate),
    endDate: toKey(r.endDate),
    startHalf: r.startHalf,
    endHalf: r.endHalf,
    days: num(r.days),
    status: r.status,
    source: r.source,
    externalRef: r.externalRef
  };
}

const REQUEST_INCLUDE = {
  leaveType: { select: { id: true, code: true, name: true, colour: true, isPaid: true } },
  user: { select: { id: true, name: true, email: true, avatarUrl: true } }
} as const;

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

export async function listLeaveTypes(includeDisabled: boolean) {
  const rows = await prisma.leaveType.findMany({
    where: includeDisabled ? {} : { enabled: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }]
  });
  return rows.map(publicLeaveType);
}

/* ------------------------------------------------------------------ *
 * Ledger helpers
 * ------------------------------------------------------------------ */

type Db = Prisma.TransactionClient | typeof prisma;

/** Serialises every balance-reading write for one person. Released at commit/rollback. */
async function lockPerson(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM \`User\` WHERE id = ${userId} FOR UPDATE`;
}

interface TypeBalanceFacts {
  ledgerSum: number;
  accrued: number;
  carried: number;
  used: number;
  adjusted: number;
  expired: number;
}

async function ledgerFacts(db: Db, userId: string, leaveYear: number, leaveTypeId?: string): Promise<Map<string, TypeBalanceFacts>> {
  const rows = await db.leaveBalanceLedger.groupBy({
    by: ["leaveTypeId", "kind"],
    where: { userId, leaveYear, ...(leaveTypeId ? { leaveTypeId } : {}) },
    _sum: { delta: true }
  });
  const out = new Map<string, TypeBalanceFacts>();
  for (const r of rows) {
    const facts = out.get(r.leaveTypeId) ?? { ledgerSum: 0, accrued: 0, carried: 0, used: 0, adjusted: 0, expired: 0 };
    const v = Number(r._sum.delta ?? 0);
    facts.ledgerSum += v;
    if (r.kind === "ACCRUAL") facts.accrued += v;
    else if (r.kind === "CARRY_FORWARD") facts.carried += v;
    else if (r.kind === "DEBIT" || r.kind === "CREDIT_REVERSAL") facts.used -= v;
    else if (r.kind === "ADJUSTMENT") facts.adjusted += v;
    else facts.expired -= v;
    out.set(r.leaveTypeId, facts);
  }
  return out;
}

async function pendingDays(db: Db, userId: string, leaveYear: number, leaveTypeId?: string, excludeId?: string): Promise<Map<string, number>> {
  const rows = await db.leaveRequest.groupBy({
    by: ["leaveTypeId"],
    where: { userId, leaveYear, status: "PENDING", ...(leaveTypeId ? { leaveTypeId } : {}), ...(excludeId ? { id: { not: excludeId } } : {}) },
    _sum: { days: true }
  });
  return new Map(rows.map((r) => [r.leaveTypeId, Number(r._sum.days ?? 0)]));
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function dueAccrual(type: Pick<LeaveType, "annualQuota" | "accrual">, leaveYear: number, startMonth: number, asOf: string, joined: Date | null): number {
  return accrualDueThrough({ annualQuota: num(type.annualQuota), accrual: type.accrual }, leaveYear, startMonth, asOf, joined ? toKey(joined) : null).reduce(
    (s, a) => s + a.amount,
    0
  );
}

/* ------------------------------------------------------------------ *
 * Balances
 * ------------------------------------------------------------------ */

export interface BalanceRow {
  leaveType: ReturnType<typeof publicLeaveType>;
  /** Ledger sum plus accrual that is due today but not yet posted by the worker. */
  balance: number;
  accrued: number;
  carriedForward: number;
  used: number;
  adjusted: number;
  expired: number;
  pending: number;
  /** balance − pending: what can still be asked for today. */
  available: number;
  /** Projected at year end: everything still to accrue, minus pending. */
  projectedYearEnd: number;
  /** Of the projected year-end balance, how much will NOT carry forward. */
  expiringAtYearEnd: number;
}

export async function getBalances(userId: string, opts: { year?: number; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const [settings, user, types] = await Promise.all([
    getAttendanceSettings(),
    prisma.user.findUnique({ where: { id: userId }, select: { timezone: true, createdAt: true } }),
    prisma.leaveType.findMany({ where: { enabled: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] })
  ]);
  if (!user) throw new AppError(404, "User not found");
  const startMonth = settings.leaveYearStartMonth ?? 1;
  const today = todayKeyFor(now, user.timezone, serverTimezone);
  const leaveYear = opts.year ?? leaveYearOf(today, startMonth);
  const bounds = leaveYearBounds(leaveYear, startMonth);
  // A past year is judged as of its last day; a future one as of the day before it starts.
  let asOf = today;
  if (today < bounds.from) asOf = addDaysKey(bounds.from, -1);
  else if (today > bounds.to) asOf = bounds.to;
  const [facts, pending] = await Promise.all([ledgerFacts(prisma, userId, leaveYear), pendingDays(prisma, userId, leaveYear)]);

  const rows: BalanceRow[] = types.map((t) => {
    const f = facts.get(t.id) ?? { ledgerSum: 0, accrued: 0, carried: 0, used: 0, adjusted: 0, expired: 0 };
    const unpostedNow = Math.max(0, r2(dueAccrual(t, leaveYear, startMonth, asOf, user.createdAt) - f.accrued));
    const unpostedYear = Math.max(0, r2(dueAccrual(t, leaveYear, startMonth, bounds.to, user.createdAt) - f.accrued));
    const p = pending.get(t.id) ?? 0;
    const balance = r2(f.ledgerSum + unpostedNow);
    const projectedYearEnd = r2(f.ledgerSum + unpostedYear - p);
    return {
      leaveType: publicLeaveType(t),
      balance,
      accrued: r2(f.accrued + unpostedNow),
      carriedForward: r2(f.carried),
      used: r2(f.used),
      adjusted: r2(f.adjusted),
      expired: r2(f.expired),
      pending: r2(p),
      available: r2(balance - p),
      projectedYearEnd,
      expiringAtYearEnd: projectedYearEnd > 0 ? r2(Math.max(0, projectedYearEnd - num(t.carryForwardMax))) : 0
    };
  });
  return { leaveYear, from: bounds.from, to: bounds.to, yearStartMonth: startMonth, balances: rows };
}

/** The ledger itself, newest first — "where did my days go?". */
export async function getLedger(userId: string, leaveYear: number) {
  const rows = await prisma.leaveBalanceLedger.findMany({
    where: { userId, leaveYear },
    orderBy: { createdAt: "desc" },
    take: 500,
    include: { leaveType: { select: { code: true, name: true } } }
  });
  return rows.map((r) => ({
    id: r.id,
    leaveType: r.leaveType,
    leaveYear: r.leaveYear,
    delta: num(r.delta),
    kind: r.kind,
    reason: r.reason,
    refRequestId: r.refRequestId,
    createdAt: r.createdAt.toISOString()
  }));
}

/* ------------------------------------------------------------------ *
 * Apply
 * ------------------------------------------------------------------ */

export interface LeaveAttachment {
  url: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export interface ApplyInput {
  userId: string;
  leaveTypeId?: string;
  leaveTypeCode?: string;
  startDate: string;
  endDate: string;
  startHalf?: LeaveHalf;
  endHalf?: LeaveHalf;
  reason?: string | null;
  attachment?: LeaveAttachment | null;
  source: AttendanceSourceKind;
  /** Who made the request (the person, or null for an integration). */
  actorId: string | null;
  externalRef?: string | null;
  dedupeKey?: string | null;
  /** An external system said "approved" and the workspace trusts it: approve as-is. */
  trustedApproval?: boolean;
  /** External sources: the HRMS owns the balance and the paperwork; record what it says. */
  external?: boolean;
  now?: Date;
}

export interface ApplyResult {
  request: PublicLeaveRequest;
  autoApproved: boolean;
}

async function resolveType(input: Pick<ApplyInput, "leaveTypeId" | "leaveTypeCode">) {
  const type = input.leaveTypeId
    ? await prisma.leaveType.findUnique({ where: { id: input.leaveTypeId } })
    : await prisma.leaveType.findUnique({ where: { code: (input.leaveTypeCode ?? "").toUpperCase() } });
  if (!type || !type.enabled) throw new AppError(422, "That leave type is not available.", { code: "LEAVE_TYPE_UNAVAILABLE" });
  return type;
}

/** Days between two keys (b − a). */
function daysBetween(a: string, b: string): number {
  return Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86_400_000);
}

/**
 * The date limits; returns the one leave year the span belongs to. External sources may record leave
 * further back or ahead (the HRMS already decided it), but never longer than a span or across years.
 */
function assertSpanAllowed(span: { startDate: string; endDate: string }, today: string, startMonth: number, external: boolean): number {
  if (!external && daysBetween(span.startDate, today) > MAX_BACKDATE_DAYS) {
    throw new AppError(422, `Leave can start at most ${MAX_BACKDATE_DAYS} days in the past.`, { code: "LEAVE_OUT_OF_RANGE" });
  }
  if (!external && daysBetween(today, span.endDate) > MAX_AHEAD_DAYS) {
    throw new AppError(422, `Leave can end at most ${MAX_AHEAD_DAYS} days ahead.`, { code: "LEAVE_OUT_OF_RANGE" });
  }
  if (daysBetween(span.startDate, span.endDate) + 1 > MAX_SPAN_DAYS) {
    throw new AppError(422, `One request can span at most ${MAX_SPAN_DAYS} days. Split it into several.`, { code: "LEAVE_OUT_OF_RANGE" });
  }
  const leaveYear = leaveYearOf(span.startDate, startMonth);
  if (leaveYearOf(span.endDate, startMonth) !== leaveYear) {
    throw new AppError(422, "A request cannot cross into the next leave year. Split it at the year boundary.", { code: "LEAVE_CROSSES_YEAR" });
  }
  return leaveYear;
}

export async function applyLeave(input: ApplyInput): Promise<ApplyResult> {
  const now = input.now ?? new Date();
  const type = await resolveType(input);
  const span = {
    startDate: input.startDate,
    endDate: input.endDate,
    startHalf: input.startHalf ?? "FULL",
    endHalf: input.endHalf ?? input.startHalf ?? "FULL"
  };
  // A one-day request needs only startHalf; mirror it so clients need not send both.
  if (span.startDate === span.endDate && !input.endHalf) span.endHalf = span.startHalf;
  const shapeProblems = spanErrors(span, type.allowHalfDay);
  if (shapeProblems.length) throw new AppError(422, shapeProblems[0], { code: "LEAVE_INVALID_SPAN" });

  const person = await prisma.user.findFirst({
    where: { id: input.userId, status: "ACTIVE", deletedAt: null },
    select: { id: true, name: true, email: true, employeeCode: true, timezone: true, holidayCalendarId: true, managerId: true, createdAt: true }
  });
  if (!person) throw new AppError(404, "User not found");

  const settings = await getAttendanceSettings();
  const startMonth = settings.leaveYearStartMonth ?? 1;
  const today = todayKeyFor(now, person.timezone, serverTimezone);
  const leaveYear = assertSpanAllowed(span, today, startMonth, Boolean(input.external));

  const [planning, holidayOf] = await Promise.all([
    getPlanningSettings(),
    loadHolidays([person.holidayCalendarId], span.startDate, span.endDate)
  ]);
  const days = countLeaveDays(span, { workingDays: planning.workingDays, isHoliday: (d) => Boolean(holidayOf(person.holidayCalendarId, d, person.id)) });
  if (days <= 0) throw new AppError(422, "Those dates are all weekends or holidays — there is nothing to take leave from.", { code: "LEAVE_NO_WORKING_DAYS" });

  if (!input.external && type.requiresDocumentAfterDays != null && days > type.requiresDocumentAfterDays && !input.attachment) {
    throw new AppError(422, `${type.name} longer than ${type.requiresDocumentAfterDays} day(s) needs a supporting document.`, {
      code: "LEAVE_DOCUMENT_REQUIRED",
      details: { afterDays: type.requiresDocumentAfterDays }
    });
  }

  // The manager is the approver only while they are an active account; otherwise the pool.
  const manager = person.managerId
    ? await prisma.user.findFirst({ where: { id: person.managerId, ...NOT_DEACTIVATED }, select: { id: true } })
    : null;
  const approverId = manager?.id ?? null;
  const autoApprove = !type.requiresApproval || Boolean(input.trustedApproval);

  const created = await prisma.$transaction(async (tx) => {
    await lockPerson(tx, person.id);
    const existing = await tx.leaveRequest.findMany({
      where: {
        userId: person.id,
        status: { in: ["PENDING", "APPROVED"] },
        startDate: { lte: new Date(`${span.endDate}T00:00:00Z`) },
        endDate: { gte: new Date(`${span.startDate}T00:00:00Z`) }
      },
      select: { id: true, startDate: true, endDate: true, startHalf: true, endHalf: true }
    });
    const clash = findClash(
      span,
      existing.map((e) => ({ id: e.id, startDate: toKey(e.startDate), endDate: toKey(e.endDate), startHalf: e.startHalf, endHalf: e.endHalf }))
    );
    if (clash) {
      throw new AppError(409, `This overlaps your leave from ${clash.startDate} to ${clash.endDate}.`, {
        code: "LEAVE_OVERLAP",
        details: { requestId: clash.id }
      });
    }

    if (!input.external && !type.allowNegative) {
      const facts = (await ledgerFacts(tx, person.id, leaveYear, type.id)).get(type.id);
      const pending = (await pendingDays(tx, person.id, leaveYear, type.id)).get(type.id) ?? 0;
      // Accrual due by the START of the leave counts: monthly credits that land before the trip.
      const due = dueAccrual(type, leaveYear, startMonth, span.startDate < today ? today : span.startDate, person.createdAt);
      const available = availableAfterAccrual(facts, due, pending);
      if (available < days) {
        throw new AppError(422, `Not enough ${type.name}: ${available} day(s) available, ${days} requested.`, {
          code: "LEAVE_INSUFFICIENT_BALANCE",
          details: { available, requested: days }
        });
      }
      if (autoApprove) await assertSettledCarryCovers(tx, person.id, type, leaveYear, days, type.name, 422);
    }

    const row = await tx.leaveRequest.create({
      data: {
        userId: person.id,
        leaveTypeId: type.id,
        startDate: new Date(`${span.startDate}T00:00:00Z`),
        endDate: new Date(`${span.endDate}T00:00:00Z`),
        startHalf: span.startHalf,
        endHalf: span.endHalf,
        days,
        leaveYear,
        reason: input.reason?.trim() || null,
        status: autoApprove ? "APPROVED" : "PENDING",
        attachmentUrl: input.attachment?.url ?? null,
        attachmentName: input.attachment?.fileName ?? null,
        attachmentMimeType: input.attachment?.mimeType ?? null,
        attachmentSize: input.attachment?.sizeBytes ?? null,
        approverId,
        decidedAt: autoApprove ? now : null,
        decisionNote: autoNote(autoApprove, Boolean(input.trustedApproval)),
        source: input.source,
        externalRef: input.externalRef ?? null,
        dedupeKey: input.dedupeKey ?? null
      },
      include: REQUEST_INCLUDE
    });
    if (autoApprove) {
      await tx.leaveBalanceLedger.create({
        data: {
          userId: person.id,
          leaveTypeId: type.id,
          leaveYear,
          delta: -days,
          kind: "DEBIT",
          reason: `${type.code} ${rangeLabel(span.startDate, span.endDate)}`,
          refRequestId: row.id,
          actorId: null,
          idempotencyKey: `DEBIT:${row.id}`
        }
      });
      await settleLateMovement(tx, { userId: person.id, type, year: leaveYear, sourceKey: `DEBIT:${row.id}` });
    }
    return row;
  });

  await audit(input.actorId ?? undefined, "leave.requested", "LeaveRequest", created.id, {
    leaveType: type.code,
    startDate: span.startDate,
    endDate: span.endDate,
    days,
    source: input.source,
    autoApproved: autoApprove
  });
  emitDomainEvent("leave.requested", webhookPayload(created, person));
  if (autoApprove) emitDomainEvent("leave.approved", webhookPayload(created, person));
  else await notifyApprovers(created, person, settings.leaveApprovalFallback);
  return { request: publicRequest(created), autoApproved: autoApprove };
}

/* ------------------------------------------------------------------ *
 * Preview — "what would this request cost?" without writing anything
 * ------------------------------------------------------------------ */

export const previewQuery = z
  .object({
    typeId: z.string().trim().min(1).max(64),
    start: isoDate,
    end: isoDate,
    startHalf: half.optional(),
    endHalf: half.optional()
  })
  .passthrough();

export interface LeavePreview {
  /** True when applyLeave would accept this exact request right now. */
  ok: boolean;
  /** Why not, in the same `code`s applyLeave throws. The first is the one to show. */
  problems: Array<{ code: string; message: string }>;
  days: number;
  excluded: ReturnType<typeof excludedDays>;
  balanceBefore: number | null;
  balanceAfter: number | null;
  allowNegative: boolean;
  overlap: { requestId: string; startDate: string; endDate: string } | null;
  documentRequired: boolean;
  requiresApproval: boolean;
  approver: { id: string; name: string; avatarUrl: string | null } | null;
}

/** assertSpanAllowed as data: the leave year, or the problem that stops the request. */
function spanLimits(span: { startDate: string; endDate: string }, today: string, startMonth: number): { leaveYear: number; problem: { code: string; message: string } | null } {
  try {
    return { leaveYear: assertSpanAllowed(span, today, startMonth, false), problem: null };
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return { leaveYear: leaveYearOf(span.startDate, startMonth), problem: { code: String(error.code ?? "LEAVE_OUT_OF_RANGE"), message: error.message } };
  }
}

/** Declined for lack of balance, unless the type allows a negative one. */
function shortBalanceProblem(type: { name: string; allowNegative: boolean }, available: number, days: number) {
  if (type.allowNegative || days <= 0 || available >= days) return null;
  return { code: "LEAVE_INSUFFICIENT_BALANCE", message: `Not enough ${type.name}: ${available} day(s) available, ${days} requested.` };
}

/** The person's manager as the approver, only while that account is active. */
async function activeApprover(managerId: string | null) {
  if (!managerId) return null;
  return prisma.user.findFirst({ where: { id: managerId, ...NOT_DEACTIVATED }, select: { id: true, name: true, avatarUrl: true } });
}

/**
 * Ledger sum plus accrual due but not yet posted, minus what is already pending. A year the
 * rollover has closed is judged as it stood BEFORE closing (its EXPIRY transfers are added back):
 * a December request decided in January draws on December's balance, and leave-settlement then
 * moves the effect into the new year.
 */
function availableAfterAccrual(facts: { ledgerSum: number; accrued: number; expired: number } | undefined, due: number, pending = 0): number {
  const ledger = (facts?.ledgerSum ?? 0) + (facts?.expired ?? 0);
  const posted = facts?.accrued ?? 0;
  return r2(ledger + Math.max(0, due - posted) - pending);
}

/**
 * A closed year's days may already have been carried into the next year AND spent there. Taking
 * `days` more from the closed year shrinks that carry (leave-settlement.service.ts); refuse when
 * the next year cannot absorb the shrink (no type that forbids a negative balance goes negative).
 */
async function assertSettledCarryCovers(
  tx: Prisma.TransactionClient,
  userId: string,
  type: Pick<LeaveType, "id" | "carryForwardMax">,
  year: number,
  days: number,
  label: string,
  status: 409 | 422
): Promise<void> {
  if (!(await isYearSettled(tx, userId, type.id, year))) return;
  const f = await settlementFacts(tx, userId, type.id, year);
  const change = carryChange(r2(f.activity - days), f.carried, num(type.carryForwardMax));
  if (change < 0 && r2(f.newYearSum + change) < 0) {
    const left = r2(f.newYearSum);
    throw new AppError(status, `${label}: ${year} has been closed and its carried-forward days are already used in ${year + 1} (${left} day(s) left there).`, {
      code: "LEAVE_INSUFFICIENT_BALANCE",
      details: { available: left, requested: days, closedYear: year }
    });
  }
}

/**
 * Read-only mirror of applyLeave's checks, for the Apply screen's live summary. It reuses the same
 * pure functions (spanErrors, countLeaveDays, findClash) so the number shown is the number charged.
 * It returns `problems` instead of throwing for a bad request, and never writes.
 */
export async function previewLeave(userId: string, q: z.infer<typeof previewQuery>, now: Date = new Date()): Promise<LeavePreview> {
  const type = await prisma.leaveType.findUnique({ where: { id: q.typeId } });
  if (!type || !type.enabled) throw new AppError(422, "That leave type is not available.", { code: "LEAVE_TYPE_UNAVAILABLE" });
  const span: { startDate: string; endDate: string; startHalf: LeaveHalf; endHalf: LeaveHalf } = {
    startDate: q.start,
    endDate: q.end,
    startHalf: q.startHalf ?? "FULL",
    endHalf: q.endHalf ?? q.startHalf ?? "FULL"
  };
  if (span.startDate === span.endDate && !q.endHalf) span.endHalf = span.startHalf;
  const problems: LeavePreview["problems"] = [];
  const shape = spanErrors(span, type.allowHalfDay);
  if (shape.length) problems.push({ code: "LEAVE_INVALID_SPAN", message: shape[0] });

  const person = await prisma.user.findFirst({
    where: { id: userId, status: "ACTIVE", deletedAt: null },
    select: { id: true, timezone: true, holidayCalendarId: true, managerId: true, createdAt: true }
  });
  if (!person) throw new AppError(404, "User not found");
  const settings = await getAttendanceSettings();
  const startMonth = settings.leaveYearStartMonth ?? 1;
  const today = todayKeyFor(now, person.timezone, serverTimezone);
  const limits = shape.length ? { leaveYear: leaveYearOf(q.start, startMonth), problem: null } : spanLimits(span, today, startMonth);
  const leaveYear = limits.leaveYear;
  if (limits.problem) problems.push(limits.problem);
  const base = {
    allowNegative: type.allowNegative,
    documentRequired: false,
    requiresApproval: type.requiresApproval,
    approver: null as LeavePreview["approver"]
  };
  if (problems.length) {
    return { ok: false, days: 0, excluded: [], balanceBefore: null, balanceAfter: null, overlap: null, ...base, problems };
  }

  const [planning, holidayOf, existing, facts, pending, manager] = await Promise.all([
    getPlanningSettings(),
    loadHolidays([person.holidayCalendarId], span.startDate, span.endDate),
    prisma.leaveRequest.findMany({
      where: {
        userId,
        status: { in: ["PENDING", "APPROVED"] },
        startDate: { lte: new Date(`${span.endDate}T00:00:00Z`) },
        endDate: { gte: new Date(`${span.startDate}T00:00:00Z`) }
      },
      select: { id: true, startDate: true, endDate: true, startHalf: true, endHalf: true }
    }),
    ledgerFacts(prisma, userId, leaveYear, type.id),
    pendingDays(prisma, userId, leaveYear, type.id),
    activeApprover(person.managerId)
  ]);
  const isHoliday = (d: string) => Boolean(holidayOf(person.holidayCalendarId, d, person.id));
  const days = countLeaveDays(span, { workingDays: planning.workingDays, isHoliday });
  const excluded = excludedDays(span, {
    workingDays: planning.workingDays,
    isHoliday,
    holidayName: (d) => holidayOf(person.holidayCalendarId, d, person.id)?.name ?? null
  });
  if (days <= 0) problems.push({ code: "LEAVE_NO_WORKING_DAYS", message: "Those dates are all weekends or holidays — there is nothing to take leave from." });

  const clash = findClash(
    span,
    existing.map((e) => ({ id: e.id, startDate: toKey(e.startDate), endDate: toKey(e.endDate), startHalf: e.startHalf, endHalf: e.endHalf }))
  );
  if (clash) problems.push({ code: "LEAVE_OVERLAP", message: `This overlaps your leave from ${clash.startDate} to ${clash.endDate}.` });

  const due = dueAccrual(type, leaveYear, startMonth, span.startDate < today ? today : span.startDate, person.createdAt);
  const available = availableAfterAccrual(facts.get(type.id), due, pending.get(type.id));
  const short = shortBalanceProblem(type, available, days);
  if (short) problems.push(short);
  return {
    ok: problems.length === 0,
    problems,
    days,
    excluded,
    balanceBefore: available,
    balanceAfter: r2(available - days),
    allowNegative: type.allowNegative,
    overlap: clash ? { requestId: clash.id, startDate: clash.startDate, endDate: clash.endDate } : null,
    documentRequired: type.requiresDocumentAfterDays != null && days > type.requiresDocumentAfterDays,
    requiresApproval: type.requiresApproval,
    approver: manager ? { id: manager.id, name: manager.name, avatarUrl: manager.avatarUrl ?? null } : null
  };
}

/* ------------------------------------------------------------------ *
 * Notifications
 * ------------------------------------------------------------------ */

function datesLabel(r: { startDate: Date; endDate: Date; startHalf: LeaveHalf; endHalf: LeaveHalf }): string {
  const s = toKey(r.startDate);
  const e = toKey(r.endDate);
  const h = (x: LeaveHalf) => (x === "FULL" ? "" : ` (${halfLabel(x)})`);
  return s === e ? `${s}${h(r.startHalf)}` : `${s}${h(r.startHalf)} to ${e}${h(r.endHalf)}`;
}

async function approverRecipients(request: { userId: string; approverId: string | null }, fallback: Fallback) {
  if (request.approverId) {
    const manager = await prisma.user.findFirst({ where: { id: request.approverId, status: "ACTIVE", deletedAt: null }, select: { id: true, name: true } });
    if (manager) return [manager];
  }
  const roles = fallback === "SUPER_ADMINS" ? ["SUPER_ADMIN"] : ["SUPER_ADMIN", "ADMIN"];
  return prisma.user.findMany({
    where: { status: "ACTIVE", deletedAt: null, isAgent: false, id: { not: request.userId }, role: { name: { in: roles as never } } },
    select: { id: true, name: true },
    take: POOL_NOTIFY_CAP
  });
}

async function notifyApprovers(request: RequestRow, person: { name: string }, fallback: Fallback): Promise<void> {
  const recipients = await approverRecipients(request, fallback);
  const vars = {
    employeeName: person.name,
    leaveType: request.leaveType.name,
    dates: datesLabel(request),
    days: String(num(request.days))
    // No reason on purpose: an email outlives the decision and is copied to the super-admin BCC.
    // The approver reads the reason (and any document) in the app.
  };
  for (const r of recipients) {
    await dispatchNotification({
      userId: r.id,
      category: "leave.requested",
      title: `${person.name} requested ${vars.leaveType}`,
      body: `${vars.dates} · ${vars.days} day(s)`,
      link: "/app/attendance?tab=leave-inbox",
      email: {
        templateKey: "leave.requested",
        vars: { ...vars, approverName: r.name },
        fallback: {
          subject: `${person.name} requested ${vars.days} day(s) of ${vars.leaveType}`,
          html: templates.leaveRequested({ ...vars, approverName: r.name })
        }
      },
      metadata: { leaveRequestId: request.id }
    });
  }
}

async function notifyRequester(request: RequestRow, decision: "approved" | "rejected", decidedBy: string): Promise<void> {
  const person = await prisma.user.findUnique({ where: { id: request.userId }, select: { name: true } });
  if (!person) return;
  const vars = {
    name: person.name,
    leaveType: request.leaveType.name,
    decision,
    decidedBy,
    dates: datesLabel(request),
    days: String(num(request.days)),
    note: request.decisionNote ?? "-"
  };
  await dispatchNotification({
    userId: request.userId,
    category: "leave.decided",
    title: `Your ${vars.leaveType} was ${decision}`,
    body: `${vars.dates} · ${vars.days} day(s)`,
    link: "/app/attendance?tab=leave",
    email: {
      templateKey: "leave.decided",
      vars,
      fallback: { subject: `Your ${vars.leaveType} request was ${decision}`, html: templates.leaveDecided(vars) }
    },
    metadata: { leaveRequestId: request.id }
  });
}

/* ------------------------------------------------------------------ *
 * Decide (approve / reject)
 * ------------------------------------------------------------------ */

async function isActiveAccount(id: string | null): Promise<boolean> {
  if (!id) return false;
  return Boolean(await prisma.user.findFirst({ where: { id, ...NOT_DEACTIVATED }, select: { id: true } }));
}

export interface DecideInput {
  actor: { id: string; role: string; name?: string | null };
  requestId: string;
  decision: "APPROVE" | "REJECT";
  note?: string | null;
  now?: Date;
}

export async function decideLeave(input: DecideInput): Promise<PublicLeaveRequest> {
  return decideOne(input, "await");
}

/**
 * Re-check the balance on approval? In-app requests always (unless the type allows a negative
 * balance). External ones (HRMS / API / CSV) only when the workspace does NOT trust the source's
 * approvals: an untrusted HRMS "approved" is just a request, and must not overdraw.
 */
function needsBalanceCheck(type: Pick<LeaveType, "allowNegative">, source: AttendanceSourceKind, trustExternal: boolean): boolean {
  if (type.allowNegative) return false;
  return !EXTERNAL_SOURCES.has(source) || !trustExternal;
}

async function decideOne(input: DecideInput, notify: "await" | "background"): Promise<PublicLeaveRequest> {
  const now = input.now ?? new Date();
  const settings = await getAttendanceSettings();
  const fallback: Fallback = settings.leaveApprovalFallback ?? "ADMINS";
  const request = await prisma.leaveRequest.findUnique({
    where: { id: input.requestId },
    include: { leaveType: true, user: { select: { id: true, name: true, email: true, employeeCode: true, avatarUrl: true, createdAt: true } } }
  });
  // Unknown id and someone else's request: one answer, so ids cannot be probed.
  if (!request) throw new AppError(403, OUT_OF_SCOPE);
  const right = decisionRight(input.actor, request, await isActiveAccount(request.approverId), fallback);
  if (!right) throw new AppError(403, OUT_OF_SCOPE);
  if (request.status !== "PENDING") {
    throw new AppError(409, `This request is already ${request.status.toLowerCase()}.`, { code: "LEAVE_ALREADY_DECIDED" });
  }
  const approve = input.decision === "APPROVE";
  const overridden = right === "OVERRIDE";
  const days = num(request.days);
  const type = request.leaveType;

  const decided = await prisma.$transaction(async (tx) => {
    await lockPerson(tx, request.userId);
    // THE guard: only the first of two racing decisions moves PENDING → anything.
    const claimed = await tx.leaveRequest.updateMany({
      where: { id: request.id, status: "PENDING" },
      data: {
        status: approve ? "APPROVED" : "REJECTED",
        decidedById: input.actor.id,
        decidedAt: now,
        decisionNote: input.note?.trim() || null,
        overriddenBySuperAdmin: overridden
      }
    });
    if (claimed.count !== 1) {
      throw new AppError(409, "This request has just been decided by someone else.", { code: "LEAVE_ALREADY_DECIDED" });
    }
    if (approve) {
      if (needsBalanceCheck(type, request.source, Boolean(settings.trustExternalApprovals))) {
        const startMonth = settings.leaveYearStartMonth ?? 1;
        const facts = (await ledgerFacts(tx, request.userId, request.leaveYear, type.id)).get(type.id);
        const due = dueAccrual(type, request.leaveYear, startMonth, toKey(request.startDate), request.user.createdAt);
        const balance = availableAfterAccrual(facts, due);
        if (balance < days) {
          throw new AppError(409, `${request.user.name} has ${balance} day(s) of ${type.name} left; this request needs ${days}.`, {
            code: "LEAVE_INSUFFICIENT_BALANCE",
            details: { available: balance, requested: days }
          });
        }
        await assertSettledCarryCovers(tx, request.userId, type, request.leaveYear, days, `${request.user.name}'s ${type.name}`, 409);
      }
      await tx.leaveBalanceLedger.create({
        data: {
          userId: request.userId,
          leaveTypeId: type.id,
          leaveYear: request.leaveYear,
          delta: -days,
          kind: "DEBIT",
          reason: `${type.code} ${rangeLabel(toKey(request.startDate), toKey(request.endDate))}`,
          refRequestId: request.id,
          actorId: input.actor.id,
          idempotencyKey: `DEBIT:${request.id}`
        }
      });
      await settleLateMovement(tx, { userId: request.userId, type, year: request.leaveYear, sourceKey: `DEBIT:${request.id}`, actorId: input.actor.id });
    }
    return tx.leaveRequest.findUniqueOrThrow({ where: { id: request.id }, include: REQUEST_INCLUDE });
  });

  await audit(input.actor.id, approve ? "leave.approved" : "leave.rejected", "LeaveRequest", request.id, {
    days,
    leaveType: type.code,
    overriddenBySuperAdmin: overridden,
    ...(overridden ? { designatedApproverId: request.approverId } : {})
  });
  emitDomainEvent(approve ? "leave.approved" : "leave.rejected", webhookPayload(decided, request.user));
  const told = notifyRequester(decided, approve ? "approved" : "rejected", input.actor.name ?? "your approver");
  if (notify === "await") await told;
  else runInBackground(told, "leave.decided notify");
  return publicRequest(decided);
}

/** One bulk call decides at most this many (the inbox selects a page; 50 keeps the response quick). */
export const BULK_DECISION_MAX = 50;

export async function decideMany(
  actor: DecideInput["actor"],
  ids: readonly string[],
  decision: "APPROVE" | "REJECT",
  note?: string | null
): Promise<Array<{ id: string; ok: boolean; status?: LeaveRequestStatus; error?: string; httpStatus?: number }>> {
  const unique = [...new Set(ids)];
  if (unique.length > BULK_DECISION_MAX) throw new AppError(422, `Decide at most ${BULK_DECISION_MAX} requests at a time.`);
  const results = [];
  // One by one: each is its own transaction, so one stale or out-of-scope id never undoes the rest.
  // The requester emails go out in the background: an SMTP round-trip per item would hold the
  // response open for minutes.
  for (const id of unique) {
    try {
      const r = await decideOne({ actor, requestId: id, decision, note }, "background");
      results.push({ id, ok: true, status: r.status });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      results.push({ id, ok: false, error: error.message, httpStatus: error.statusCode });
    }
  }
  return results;
}

/* ------------------------------------------------------------------ *
 * Cancel
 * ------------------------------------------------------------------ */

export interface CancelInput {
  actor: { id: string; role: string } | null;
  requestId: string;
  /** An HRMS cancelling its own leave may cancel leave that has started. */
  external?: boolean;
  /** Required when an administrator cancels someone else's leave; told to the person and audited. */
  comment?: string | null;
  now?: Date;
}

export async function cancelLeave(input: CancelInput): Promise<PublicLeaveRequest> {
  const now = input.now ?? new Date();
  const request = await prisma.leaveRequest.findUnique({
    where: { id: input.requestId },
    include: { leaveType: true, user: { select: { id: true, name: true, email: true, employeeCode: true, timezone: true, avatarUrl: true } } }
  });
  const own = request && input.actor && request.userId === input.actor.id;
  const superAdmin = input.actor?.role === "SUPER_ADMIN" || input.actor?.role === "ADMIN";
  if (!request || (!input.external && !own && !superAdmin)) throw new AppError(404, "Leave request not found");
  const byAdmin = !own && !input.external;
  const comment = input.comment?.trim() ?? "";
  if (byAdmin && request.status !== "CANCELLED" && comment.length === 0) {
    throw new AppError(422, "Add a comment saying why you are cancelling this leave; the person is told.", { code: "LEAVE_CANCEL_COMMENT_REQUIRED" });
  }
  if (request.status === "CANCELLED") return publicRequest({ ...request });
  if (request.status === "REJECTED") throw new AppError(409, "A rejected request cannot be cancelled.", { code: "LEAVE_NOT_CANCELLABLE" });

  const today = todayKeyFor(now, request.user.timezone, serverTimezone);
  const wasApproved = request.status === "APPROVED";
  if (wasApproved && !input.external && toKey(request.startDate) <= today && !superAdmin) {
    throw new AppError(409, "Leave that has already started can only be cancelled by an administrator.", { code: "LEAVE_NOT_CANCELLABLE" });
  }

  const updated = await prisma.$transaction(async (tx) => {
    await lockPerson(tx, request.userId);
    const claimed = await tx.leaveRequest.updateMany({
      where: { id: request.id, status: request.status },
      data: { status: "CANCELLED", cancelledAt: now }
    });
    if (claimed.count !== 1) throw new AppError(409, "This request changed while you were cancelling it. Refresh and try again.");
    if (wasApproved) {
      await tx.leaveBalanceLedger.create({
        data: {
          userId: request.userId,
          leaveTypeId: request.leaveTypeId,
          leaveYear: request.leaveYear,
          delta: num(request.days),
          kind: "CREDIT_REVERSAL",
          reason: `Cancelled ${request.leaveType.code} ${toKey(request.startDate)}`,
          refRequestId: request.id,
          actorId: input.actor?.id ?? null,
          idempotencyKey: `REVERSAL:${request.id}`
        }
      });
      await settleLateMovement(tx, {
        userId: request.userId,
        type: request.leaveType,
        year: request.leaveYear,
        sourceKey: `REVERSAL:${request.id}`,
        actorId: input.actor?.id ?? null
      });
    }
    return tx.leaveRequest.findUniqueOrThrow({ where: { id: request.id }, include: REQUEST_INCLUDE });
  });
  await audit(input.actor?.id, "leave.cancelled", "LeaveRequest", request.id, {
    wasApproved,
    reversedDays: wasApproved ? num(request.days) : 0,
    byAdmin,
    ...(byAdmin ? { comment: comment.slice(0, 500) } : {})
  });
  emitDomainEvent("leave.cancelled", webhookPayload(updated, request.user));
  if (byAdmin) await notifyCancelledByAdmin(request, comment.slice(0, 500));
  return publicRequest(updated);
}

async function notifyCancelledByAdmin(
  request: { id: string; userId: string; startDate: Date; endDate: Date; days: unknown; leaveType: { name: string } },
  comment: string
): Promise<void> {
  const dates = toKey(request.startDate) === toKey(request.endDate) ? toKey(request.startDate) : `${toKey(request.startDate)} to ${toKey(request.endDate)}`;
  await dispatchNotification({
    userId: request.userId,
    category: "leave.decided",
    title: `Your ${request.leaveType.name} was cancelled by an administrator`,
    body: `${dates} · ${comment}`,
    link: "/app/attendance?tab=leave",
    metadata: { leaveRequestId: request.id }
  });
}

/* ------------------------------------------------------------------ *
 * Lists
 * ------------------------------------------------------------------ */

export async function listMyRequests(userId: string, opts: { status?: LeaveRequestStatus; year?: number } = {}) {
  const rows = await prisma.leaveRequest.findMany({
    where: { userId, ...(opts.status ? { status: opts.status } : {}), ...(opts.year ? { leaveYear: opts.year } : {}) },
    orderBy: { startDate: "desc" },
    take: 500,
    include: REQUEST_INCLUDE
  });
  return rows.map(publicRequest);
}

/**
 * The approver's inbox, as a Prisma filter — the SAME rule as decisionRight, expressed as a query:
 * requests whose captured approver is me; plus, for pool members, those with no approver or whose
 * approver is no longer active. `scope: "all"` (SUPER_ADMIN only) is every request.
 */
export async function inboxWhere(
  actor: { id: string; role: string },
  scope: "mine" | "all",
  fallback: Fallback
): Promise<Prisma.LeaveRequestWhereInput> {
  if (scope === "all") {
    if (actor.role !== "SUPER_ADMIN") throw new AppError(403, "Only a super admin can see every leave request.");
    return {};
  }
  const clauses: Prisma.LeaveRequestWhereInput[] = [{ approverId: actor.id }];
  if (inApproverPool(actor.role, fallback)) {
    // Approvers of pending requests who have since been deactivated: their queue falls to the pool.
    const captured = await prisma.leaveRequest.findMany({
      where: { status: "PENDING", approverId: { not: null } },
      select: { approverId: true },
      distinct: ["approverId"],
      take: 5000
    });
    const ids = captured.map((c) => c.approverId).filter((id): id is string => Boolean(id));
    const active = ids.length ? await prisma.user.findMany({ where: { id: { in: ids }, ...NOT_DEACTIVATED }, select: { id: true } }) : [];
    const activeIds = new Set(active.map((u) => u.id));
    const stale = ids.filter((id) => !activeIds.has(id));
    clauses.push({ approverId: null }, ...(stale.length ? [{ approverId: { in: stale } }] : []));
  }
  return { OR: clauses, userId: { not: actor.id } };
}

export async function listInbox(
  actor: { id: string; role: string },
  opts: { scope?: "mine" | "all"; status?: LeaveRequestStatus | "ALL"; page?: number; pageSize?: number } = {}
) {
  const settings = await getAttendanceSettings();
  const where = await inboxWhere(actor, opts.scope ?? "mine", settings.leaveApprovalFallback ?? "ADMINS");
  const status = opts.status ?? "PENDING";
  const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 200);
  const page = Math.max(opts.page ?? 1, 1);
  const full: Prisma.LeaveRequestWhereInput = { ...where, ...(status === "ALL" ? {} : { status }) };
  const [total, rows] = await Promise.all([
    prisma.leaveRequest.count({ where: full }),
    prisma.leaveRequest.findMany({
      where: full,
      orderBy: status === "PENDING" ? { startDate: "asc" } : { updatedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: REQUEST_INCLUDE
    })
  ]);
  const [after, mayDecide] = await Promise.all([balanceAfterFor(rows), decisionRightsFor(actor, rows, settings.leaveApprovalFallback ?? "ADMINS")]);
  return {
    total,
    page,
    pageSize,
    items: rows.map((r) => {
      const item = publicRequest(r);
      // The reason and document are for whoever DECIDES this request, and nobody else.
      const visible = mayDecide(r) ? item : { ...item, reason: null, attachment: null };
      return { ...visible, balanceAfter: after.get(r.id) ?? null };
    })
  };
}

/**
 * Per row: does `actor` hold a decision right over it (decisionRight, the one rule)? The inbox
 * query already expresses the same rule, so this normally passes every row — it is the second
 * lock on the door, so a future change to inboxWhere cannot leak a reason by itself.
 */
async function decisionRightsFor(actor: { id: string; role: string }, rows: ReadonlyArray<RequestRow>, fallback: Fallback) {
  const approverIds = [...new Set(rows.map((r) => r.approverId).filter((x): x is string => Boolean(x)))];
  const active = approverIds.length ? await prisma.user.findMany({ where: { id: { in: approverIds }, ...NOT_DEACTIVATED }, select: { id: true } }) : [];
  const activeIds = new Set(active.map((u) => u.id));
  return (r: RequestRow) => decisionRight(actor, r, Boolean(r.approverId && activeIds.has(r.approverId)), fallback) !== null;
}

/**
 * For each PENDING row: what the requester will have left of this type if it is approved (balance
 * counting accrual due by the start date, minus this request). One ledger read per distinct
 * person-type-year on the page, so a page of fifty is a few queries, not fifty.
 */
async function balanceAfterFor(rows: ReadonlyArray<RequestRow>): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const pending = rows.filter((r) => r.status === "PENDING");
  if (pending.length === 0) return out;
  const settings = await getAttendanceSettings();
  const startMonth = settings.leaveYearStartMonth ?? 1;
  const people = await prisma.user.findMany({ where: { id: { in: [...new Set(pending.map((r) => r.userId))] } }, select: { id: true, createdAt: true } });
  const joined = new Map(people.map((u) => [u.id, u.createdAt]));
  const types = new Map<string, LeaveType>();
  for (const t of await prisma.leaveType.findMany({ where: { id: { in: [...new Set(pending.map((r) => r.leaveTypeId))] } } })) types.set(t.id, t);
  const facts = new Map<string, Awaited<ReturnType<typeof ledgerFacts>>>();
  for (const r of pending) {
    const type = types.get(r.leaveTypeId);
    if (!type) continue;
    const key = r.userId + "|" + r.leaveYear;
    if (!facts.has(key)) facts.set(key, await ledgerFacts(prisma, r.userId, r.leaveYear));
    const f = facts.get(key)!.get(type.id);
    const due = dueAccrual(type, r.leaveYear, startMonth, toKey(r.startDate), joined.get(r.userId) ?? null);
    out.set(r.id, r2(availableAfterAccrual(f, due) - num(r.days)));
  }
  return out;
}

/** A person's own request by id (404 for anyone else's — it is theirs, not an approver view). */
export async function getMyRequest(userId: string, id: string) {
  const row = await prisma.leaveRequest.findFirst({ where: { id, userId }, include: REQUEST_INCLUDE });
  if (!row) throw new AppError(404, "Leave request not found");
  return publicRequest(row);
}

/* ------------------------------------------------------------------ *
 * Admin: manual adjustment
 * ------------------------------------------------------------------ */

export async function adjustBalance(actorId: string, body: z.infer<typeof adjustmentBody>) {
  const [type, person, settings] = await Promise.all([
    prisma.leaveType.findUnique({ where: { id: body.leaveTypeId }, select: { id: true, code: true } }),
    prisma.user.findFirst({ where: { id: body.userId, deletedAt: null }, select: { id: true, timezone: true } }),
    getAttendanceSettings()
  ]);
  if (!type) throw new AppError(404, "Leave type not found");
  if (!person) throw new AppError(404, "User not found");
  const leaveYear = body.leaveYear ?? leaveYearOf(todayKeyFor(new Date(), person.timezone, serverTimezone), settings.leaveYearStartMonth ?? 1);
  const row = await prisma.leaveBalanceLedger.create({
    data: { userId: person.id, leaveTypeId: type.id, leaveYear, delta: body.delta, kind: "ADJUSTMENT", reason: body.reason, actorId }
  });
  await audit(actorId, "leave.balance_adjusted", "LeaveBalanceLedger", row.id, { userId: person.id, leaveType: type.code, leaveYear, delta: body.delta });
  return { id: row.id, leaveYear, delta: body.delta };
}

/* ------------------------------------------------------------------ *
 * Team calendar
 * ------------------------------------------------------------------ */

/**
 * Who in my team is off (approved or pending) over [from, to] — Team Activity's visibility rule
 * (managers: direct reports; admins: everyone; others: 403). Dates, type and status only: the
 * reason stays with the person and their approver's inbox.
 */
export async function listTeamLeave(actor: { id: string; role: string }, from: string, to: string, managerId?: string | null) {
  const scope = assertTeamScope(actor.role);
  const rows = await prisma.leaveRequest.findMany({
    where: {
      user: peopleWhere(scope, actor.id, managerId),
      status: { in: ["PENDING", "APPROVED"] },
      startDate: { lte: new Date(`${to}T00:00:00Z`) },
      endDate: { gte: new Date(`${from}T00:00:00Z`) }
    },
    orderBy: { startDate: "asc" },
    take: 2000,
    include: REQUEST_INCLUDE
  });
  return {
    from,
    to,
    items: rows.map((r) => withoutPrivateText(publicRequest(r)))
  };
}

