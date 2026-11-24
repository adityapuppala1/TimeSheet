/**
 * V17 Phase B — leave arriving from outside: an HRMS on the signed attendance webhook, or any
 * client on POST /public/v1/leave-requests. One function for both, so they cannot drift.
 *
 * TRUST (GlobalAttendanceSettings.trustExternalApprovals):
 *   - ON: an item that says APPROVED is recorded APPROVED as-is and the ledger debited — the HRMS is
 *     the system of record and somebody already approved it there.
 *   - OFF: every item lands PENDING with the normal approver (manager → admin pool), whatever it says.
 * Either way an external item skips the in-app balance refusal and document rule: the HRMS owns
 * those, and refusing what already happened would only make the two systems disagree.
 *
 * IDEMPOTENT: the (source, sender, externalRef) triple is LeaveRequest.dedupeKey, unique in the
 * database. The same item twice is a DUPLICATE; the same ref with status CANCELLED cancels it
 * (reversing the debit when it had been approved).
 */
import { z } from "zod";
import type { AttendanceMatchField, AttendanceSourceKind } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { AppError } from "../middleware/error.js";
import { getAttendanceSettings, isoDate } from "./attendance-settings.service.js";
import { applyLeave, cancelLeave } from "./leave.service.js";

export const externalLeaveItem = z
  .object({
    /** Discriminates a leave item from a punch on the shared webhook. Optional on the REST route. */
    kind: z.literal("leave").optional(),
    identifier: z.string().trim().min(1).max(191).optional(),
    email: z.string().trim().min(1).max(191).optional(),
    employeeCode: z.string().trim().min(1).max(64).optional(),
    externalId: z.string().trim().min(1).max(191).optional(),
    leaveType: z.string().trim().min(1).max(20),
    startDate: isoDate,
    endDate: isoDate,
    startHalf: z.enum(["FULL", "FIRST_HALF", "SECOND_HALF"]).optional(),
    endHalf: z.enum(["FULL", "FIRST_HALF", "SECOND_HALF"]).optional(),
    status: z.enum(["PENDING", "APPROVED", "CANCELLED"]).default("PENDING"),
    externalRef: z.string().trim().min(1).max(191),
    reason: z.string().trim().max(2000).optional(),
    test: z.boolean().optional()
  })
  .strict();

export type ExternalLeaveItem = z.infer<typeof externalLeaveItem>;

export type ExternalLeaveStatus = "RECEIVED" | "DUPLICATE" | "REJECTED";

export interface ExternalLeaveResult {
  status: ExternalLeaveStatus;
  requestId: string | null;
  /** PENDING / APPROVED / CANCELLED once recorded. */
  leaveStatus?: string;
  error?: string;
}

/** True when a raw webhook item is a leave item rather than a punch. */
export function isLeaveItem(raw: unknown): boolean {
  return Boolean(raw) && typeof raw === "object" && (raw as { kind?: unknown }).kind === "leave";
}

function identifierOf(item: ExternalLeaveItem, fallback: AttendanceMatchField): { identifier: string | null; matchField: AttendanceMatchField } {
  if (item.email) return { identifier: item.email, matchField: "EMAIL" };
  if (item.employeeCode) return { identifier: item.employeeCode, matchField: "EMPLOYEE_CODE" };
  if (item.externalId) return { identifier: item.externalId, matchField: "EXTERNAL_ID" };
  return { identifier: item.identifier ?? null, matchField: fallback };
}

async function matchPerson(identifier: string | null, field: AttendanceMatchField) {
  const raw = identifier?.trim();
  if (!raw) return null;
  const active = { status: "ACTIVE" as const, deletedAt: null };
  if (field === "EMAIL") return prisma.user.findFirst({ where: { email: raw.toLowerCase(), ...active }, select: { id: true } });
  if (field === "EMPLOYEE_CODE") return prisma.user.findFirst({ where: { employeeCode: raw, ...active }, select: { id: true } });
  return prisma.user.findFirst({ where: { scimExternalId: raw, ...active }, select: { id: true } });
}

export function leaveDedupeKey(kind: AttendanceSourceKind, sender: string, externalRef: string): string {
  return `${kind}:${sender}:${externalRef}`.slice(0, 255);
}

/**
 * One external item. `sender` is the webhook source id or the API key id — part of the dedupe key,
 * so two integrations that happen to use the same ref never collide. Never throws for a bad item:
 * the batch reports it REJECTED in place.
 */
export async function ingestExternalLeave(params: {
  kind: AttendanceSourceKind;
  sender: string;
  rawItem: unknown;
  matchFallback?: AttendanceMatchField;
  now?: Date;
}): Promise<ExternalLeaveResult> {
  const parsed = externalLeaveItem.safeParse(params.rawItem);
  if (!parsed.success) return { status: "REJECTED", requestId: null, error: parsed.error.issues[0]?.message ?? "Invalid leave item" };
  const item = parsed.data;
  if (item.test) return { status: "RECEIVED", requestId: null };

  const dedupeKey = leaveDedupeKey(params.kind, params.sender, item.externalRef);
  const existing = await prisma.leaveRequest.findUnique({ where: { dedupeKey }, select: { id: true, status: true } });
  if (existing) {
    if (item.status === "CANCELLED" && (existing.status === "PENDING" || existing.status === "APPROVED")) {
      const cancelled = await cancelLeave({ actor: null, requestId: existing.id, external: true, now: params.now });
      return { status: "RECEIVED", requestId: existing.id, leaveStatus: cancelled.status };
    }
    return { status: "DUPLICATE", requestId: existing.id, leaveStatus: existing.status };
  }
  if (item.status === "CANCELLED") return { status: "REJECTED", requestId: null, error: "Nothing to cancel: no leave was received with that externalRef." };

  const { identifier, matchField } = identifierOf(item, params.matchFallback ?? "EMAIL");
  const person = await matchPerson(identifier, matchField);
  if (!person) return { status: "REJECTED", requestId: null, error: "No active person matches that identifier." };

  const settings = await getAttendanceSettings();
  try {
    const result = await applyLeave({
      userId: person.id,
      leaveTypeCode: item.leaveType,
      startDate: item.startDate,
      endDate: item.endDate,
      startHalf: item.startHalf,
      endHalf: item.endHalf,
      reason: item.reason ?? null,
      source: params.kind,
      actorId: null,
      externalRef: item.externalRef,
      dedupeKey,
      trustedApproval: item.status === "APPROVED" && settings.trustExternalApprovals,
      external: true,
      now: params.now
    });
    return { status: "RECEIVED", requestId: result.request.id, leaveStatus: result.request.status };
  } catch (error) {
    // Lost a race with an identical delivery: the other one recorded it.
    if ((error as { code?: string } | null)?.code === "P2002") {
      const winner = await prisma.leaveRequest.findUnique({ where: { dedupeKey }, select: { id: true, status: true } });
      return { status: "DUPLICATE", requestId: winner?.id ?? null, leaveStatus: winner?.status };
    }
    if (error instanceof AppError) return { status: "REJECTED", requestId: null, error: error.message };
    throw error;
  }
}
