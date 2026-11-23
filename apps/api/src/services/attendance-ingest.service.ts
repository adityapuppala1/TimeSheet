/**
 * Attendance ingest (V17 A3) — the ONE path every punch takes, whatever it came from: the web
 * pop-up, the public API, a signed biometric/HRMS webhook, an MCP client, or a CSV import.
 *
 * WHY ONE PATH: five sources each deciding "which person, which day, who wins" is five copies of
 * a rule that drift apart — the day a webhook resolves the date in UTC while the web resolves it in
 * the person's zone, the same swipe lands on two different days. So every source normalises its
 * input and calls `ingestPunch`, which owns:
 *
 *   1. the gate (attendance on; integrations entitlement for anything that is not the web),
 *   2. validation (a REJECTED event, never a thrown 500, so a bulk batch keeps going),
 *   3. dedupe on (kind, source, externalRef) — BEFORE the person is resolved, so "duplicate" can
 *      never be used to probe whether a person exists,
 *   4. person resolution, active users only. An unknown identifier is recorded as UNMATCHED, never
 *      an error: external callers see the same "RECEIVED" for a match and a miss (publicStatus),
 *   5. the work date, in the PERSON's timezone (a 23:30 UTC swipe in Kolkata is tomorrow),
 *   6. conflict resolution by rank, where the winner owns the AttendanceRecord and every loser is
 *      kept as an AttendanceEvent (SUPERSEDED) for audit.
 *
 * RANK: a WEBHOOK source ranks 1000 + its own priority (devices and HRMS are what an employer
 * actually trusts); everything else ranks by the workspace's apiPriority / webPriority /
 * mcpPriority / csvPriority (+ its source row's priority when it has one). Ties keep the existing
 * record: first in wins, so a resend can never flip the day back and forth.
 */
import crypto from "node:crypto";
import { Prisma, type AttendanceEventStatus, type AttendanceMatchField, type AttendanceSourceKind } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { redactCoordinates } from "../utils/redact-coordinates.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { serverTimezone } from "../config/env.js";
import { AppError } from "../middleware/error.js";
import { getAttendanceSettings } from "./attendance-settings.service.js";
import { todayKeyFor } from "./attendance-day-status.js";
import { isPlanningCapabilityAllowed } from "./plan-limits.service.js";

/** Raw payloads above this are stored as a truncated preview — a device that posts megabytes must
 *  not turn the delivery log into the biggest table in the database. */
export const RAW_PAYLOAD_CAP = 8_000;

/** How far into the future a punch may claim to be. Clock skew, not time travel. */
const FUTURE_TOLERANCE_MS = 10 * 60 * 1000;

const WEBHOOK_BASE_RANK = 1000;

export type PublicIngestStatus = "RECEIVED" | "DUPLICATE" | "REJECTED";

/**
 * What an EXTERNAL caller is told. ACCEPTED, SUPERSEDED and UNMATCHED all read "RECEIVED": telling
 * a device "no such person" would turn the endpoint into a directory of who works here. The admin
 * delivery log shows the real status.
 */
export function publicStatus(status: AttendanceEventStatus): PublicIngestStatus {
  if (status === "DUPLICATE") return "DUPLICATE";
  if (status === "REJECTED") return "REJECTED";
  return "RECEIVED";
}

export interface PunchEvidence {
  lat?: number | null;
  lng?: number | null;
  accuracyM?: number | null;
  ip?: string | null;
  userAgent?: string | null;
  faceAttemptId?: string | null;
  flagged?: boolean;
}

export interface IngestInput {
  kind: AttendanceSourceKind;
  sourceId?: string | null;
  /** Trusted callers (web, MCP) already know who is punching; everyone else sends an identifier. */
  userId?: string | null;
  /** The already-loaded person, for callers that authenticated them (web, MCP). Skips the lookup. */
  person?: { id: string; timezone: string | null } | null;
  identifier?: string | null;
  /** Overrides the source's matchField (the public API lets each item say which field it sent). */
  matchField?: AttendanceMatchField | null;
  punchInAt: string | Date;
  punchOutAt?: string | Date | null;
  externalRef?: string | null;
  evidence?: PunchEvidence;
  rawPayload?: unknown;
  isTest?: boolean;
  now?: Date;
  /** The caller already ran assertIngestAllowed (bulk routes check once, not 500 times). */
  gateChecked?: boolean;
  /** Runs inside the write transaction just before a NEW record is created (web consent capture). */
  beforeCreate?: (tx: Prisma.TransactionClient) => Promise<void>;
}

export interface IngestResult {
  eventId: string | null;
  status: AttendanceEventStatus;
  reason: string | null;
  recordId: string | null;
  /** True only when this call created the day's record. */
  created: boolean;
}

/* ------------------------------------------------------------------ *
 * Gate
 * ------------------------------------------------------------------ */

export async function assertIngestAllowed(kind: AttendanceSourceKind): Promise<void> {
  const settings = await getAttendanceSettings();
  const orgId = requireTenantContext().orgId;
  if (!settings?.attendanceEnabled || !(await isPlanningCapabilityAllowed(orgId, "attendanceEnabled"))) {
    throw new AppError(403, "Attendance is not enabled for this workspace.");
  }
  if (kind !== "WEB" && !(await isPlanningCapabilityAllowed(orgId, "attendanceIntegrationsEnabled"))) {
    throw new AppError(403, "Attendance integrations are not included in this plan. Upgrade to Enterprise to use them.");
  }
}

/** Non-throwing form, for reads that should answer "off" rather than fail. */
export async function isIngestAllowed(kind: AttendanceSourceKind): Promise<boolean> {
  try {
    await assertIngestAllowed(kind);
    return true;
  } catch (error) {
    if (error instanceof AppError) return false;
    throw error;
  }
}

/* ------------------------------------------------------------------ *
 * Pure helpers (exported for tests)
 * ------------------------------------------------------------------ */

export function capRawPayload(raw: unknown): Prisma.InputJsonValue | undefined {
  if (raw === undefined || raw === null) return undefined;
  let text: string;
  try {
    text = typeof raw === "string" ? raw : JSON.stringify(raw);
  } catch {
    return { unserializable: true };
  }
  if (text.length <= RAW_PAYLOAD_CAP) {
    return typeof raw === "string" ? { text } : (JSON.parse(text) as Prisma.InputJsonValue);
  }
  return { truncated: true, size: text.length, preview: text.slice(0, RAW_PAYLOAD_CAP) };
}

export function dedupeKeyFor(kind: AttendanceSourceKind, sourceId: string | null | undefined, externalRef: string | null | undefined): string | null {
  if (!externalRef) return null;
  const key = `${kind}:${sourceId ?? "-"}:${externalRef}`;
  // Hash only when it would overflow the column; short keys stay readable in the delivery log.
  return key.length <= 255 ? key : `${kind}:${sourceId ?? "-"}:sha256:${crypto.createHash("sha256").update(externalRef).digest("hex")}`;
}

/** An ISO-8601 instant WITH a zone (Z or ±hh:mm). A bare "2026-11-23T09:00" is refused: whose 09:00? */
const ISO_LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?/;
const ISO_ZONE = /(Z|[+-]\d{2}:?\d{2})$/;

export function parseInstant(value: string | Date | null | undefined): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== "string") return null;
  const v = value.trim();
  // Two halves, both required: a date-time at the start and a zone at the end, nothing between.
  const local = ISO_LOCAL.exec(v);
  const zone = ISO_ZONE.exec(v);
  if (!local || !zone || local[0].length + zone[0].length !== v.length) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

interface RankSettings {
  apiPriority?: number;
  webPriority?: number;
  mcpPriority?: number;
  csvPriority?: number;
}

export function rankOf(kind: AttendanceSourceKind, sourcePriority: number | null | undefined, settings: RankSettings): number {
  const own = sourcePriority ?? 0;
  switch (kind) {
    case "WEBHOOK":
      return WEBHOOK_BASE_RANK + own;
    case "API":
      return (settings.apiPriority ?? 30) + own;
    case "WEB":
      return (settings.webPriority ?? 20) + own;
    case "MCP":
      return (settings.mcpPriority ?? 20) + own;
    case "CSV":
      return (settings.csvPriority ?? 10) + own;
  }
}

/* ------------------------------------------------------------------ *
 * Person resolution
 * ------------------------------------------------------------------ */

const PERSON_SELECT = { id: true, timezone: true } as const;
type Person = { id: string; timezone: string | null };

/** Active, not deleted. A deactivated leaver's badge still swiping must not mark them present. */
async function resolvePerson(input: IngestInput, matchField: AttendanceMatchField): Promise<Person | null> {
  const active = { status: "ACTIVE" as const, deletedAt: null };
  if (input.userId) return prisma.user.findFirst({ where: { id: input.userId, ...active }, select: PERSON_SELECT });
  const raw = input.identifier?.trim();
  if (!raw) return null;
  if (matchField === "EMAIL") return prisma.user.findFirst({ where: { email: raw.toLowerCase(), ...active }, select: PERSON_SELECT });
  if (matchField === "EMPLOYEE_CODE") return prisma.user.findFirst({ where: { employeeCode: raw, ...active }, select: PERSON_SELECT });
  return prisma.user.findFirst({ where: { scimExternalId: raw, ...active }, select: PERSON_SELECT });
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "P2002";
}

/* ------------------------------------------------------------------ *
 * The ingest
 * ------------------------------------------------------------------ */

type EventData = Omit<Prisma.AttendanceEventUncheckedCreateInput, "source" | "status"> & { status: AttendanceEventStatus };
type SourceRow = { id: string; kind: AttendanceSourceKind; enabled: boolean; priority: number; matchField: AttendanceMatchField };
type EventRecorder = (data: EventData) => Promise<IngestResult>;

/** What the delivery log keeps of the input: enough to replay it, never the web punch's GPS. */
function normalizeInput(input: IngestInput, externalRef: string | null) {
  const ev = input.evidence;
  const hasLocation = ev?.lat != null && ev?.lng != null;
  const iso = (v: string | Date | null | undefined) => (v instanceof Date ? v.toISOString() : (v ?? null));
  return {
    identifier: input.identifier ?? null,
    matchField: input.matchField ?? null,
    punchInAt: iso(input.punchInAt),
    punchOutAt: iso(input.punchOutAt),
    externalRef,
    hasLocation,
    location: input.kind !== "WEB" && hasLocation ? { lat: ev!.lat!, lng: ev!.lng!, accuracyM: ev!.accuracyM ?? null } : null
  };
}

/** Why the input cannot be a punch at all, or null. Independent of who the person is. */
function shapeError(input: IngestInput, punchInAt: Date | null, punchOutAt: Date | null, now: Date): string | null {
  if (!punchInAt) return "punchInAt must be an ISO-8601 timestamp with a timezone (Z or ±hh:mm).";
  const outSent = input.punchOutAt != null && input.punchOutAt !== "";
  if (outSent && !punchOutAt) return "punchOutAt must be an ISO-8601 timestamp with a timezone.";
  if (punchOutAt && punchOutAt < punchInAt) return "punchOutAt is before punchInAt.";
  if (punchInAt.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) return "punchInAt is in the future.";
  if (!input.person && !input.userId && !input.identifier?.trim()) return "No person identifier was sent.";
  return null;
}

/** The record columns an incoming punch writes, shared by create and take-over. */
function recordFields(input: IngestInput, source: SourceRow | null, externalRef: string | null, punchInAt: Date, punchOutAt: Date | null) {
  const evidence = input.evidence ?? {};
  return {
    punchInAt,
    punchOutAt,
    lat: evidence.lat ?? null,
    lng: evidence.lng ?? null,
    accuracyM: evidence.accuracyM == null ? null : Math.round(evidence.accuracyM),
    ip: evidence.ip?.slice(0, 64) ?? null,
    userAgent: evidence.userAgent ?? null,
    faceAttemptId: evidence.faceAttemptId ?? null,
    flagged: Boolean(evidence.flagged),
    source: input.kind,
    sourceId: source?.id ?? null,
    externalRef
  };
}

interface SettleContext {
  input: IngestInput;
  personId: string;
  workDate: Date;
  punchInAt: Date;
  punchOutAt: Date | null;
  source: SourceRow | null;
  externalRef: string | null;
  raw: Prisma.InputJsonValue | undefined;
  eventBase: Omit<Prisma.AttendanceEventUncheckedCreateInput, "status">;
  normalized: ReturnType<typeof normalizeInput>;
  settings: RankSettings;
}

const MERGED = "Merged into the record this source already owns.";

/** Step 7, inside the transaction: create, merge, lose, or take over. */
async function settle(tx: Prisma.TransactionClient, c: SettleContext): Promise<IngestResult> {
  const existing = await tx.attendanceRecord.findUnique({
    where: { userId_workDate: { userId: c.personId, workDate: c.workDate } },
    include: { sourceRef: { select: { priority: true } } }
  });
  const fields = recordFields(c.input, c.source, c.externalRef, c.punchInAt, c.punchOutAt);
  const logEvent = async (
    status: AttendanceEventStatus,
    reason: string | null,
    recordId: string,
    extra: Partial<Prisma.AttendanceEventUncheckedCreateInput> = {}
  ) => (await tx.attendanceEvent.create({ data: { ...c.eventBase, ...extra, status, reason, recordId } })).id;

  if (!existing) {
    if (c.input.beforeCreate) await c.input.beforeCreate(tx);
    const created = await tx.attendanceRecord.create({ data: { ...fields, userId: c.personId, workDate: c.workDate, rawPayload: c.raw } });
    return { eventId: await logEvent("ACCEPTED", null, created.id), status: "ACCEPTED", reason: null, recordId: created.id, created: true };
  }

  // Same source again (a device sending the punch-out later): merge into the record it owns.
  if (existing.source === c.input.kind && (existing.sourceId ?? null) === (c.source?.id ?? null)) {
    const earliestIn = c.punchInAt < existing.punchInAt ? c.punchInAt : existing.punchInAt;
    const laterOut = c.punchOutAt && (!existing.punchOutAt || c.punchOutAt > existing.punchOutAt);
    await tx.attendanceRecord.update({
      where: { id: existing.id },
      data: { punchInAt: earliestIn, punchOutAt: laterOut ? c.punchOutAt : existing.punchOutAt }
    });
    return { eventId: await logEvent("ACCEPTED", MERGED, existing.id), status: "ACCEPTED", reason: MERGED, recordId: existing.id, created: false };
  }

  const incoming = rankOf(c.input.kind, c.source?.priority, c.settings);
  const current = rankOf(existing.source, existing.sourceRef?.priority, c.settings);
  if (incoming <= current) {
    const reason = `Kept the existing ${existing.source} punch (priority ${current} ≥ ${incoming}).`;
    return { eventId: await logEvent("SUPERSEDED", reason, existing.id), status: "SUPERSEDED", reason, recordId: existing.id, created: false };
  }

  // The newcomer outranks the record: it takes the record over, and the old owner's events become
  // SUPERSEDED. The previous punch (never its coordinates) is kept on the new event.
  const previous = {
    source: existing.source,
    sourceId: existing.sourceId,
    punchInAt: existing.punchInAt.toISOString(),
    punchOutAt: existing.punchOutAt?.toISOString() ?? null,
    externalRef: existing.externalRef,
    flagged: existing.flagged,
    faceAttemptId: existing.faceAttemptId
  };
  await tx.attendanceRecord.update({ where: { id: existing.id }, data: { ...fields, rawPayload: c.raw ?? Prisma.DbNull } });
  await tx.attendanceEvent.updateMany({
    where: { recordId: existing.id, status: "ACCEPTED" },
    data: { status: "SUPERSEDED", reason: `Overtaken by a higher-priority ${c.input.kind} punch (priority ${incoming} > ${current}).` }
  });
  const reason = `Replaced the ${existing.source} punch (priority ${current} < ${incoming}).`;
  const eventId = await logEvent("ACCEPTED", reason, existing.id, { input: { ...c.normalized, previous } as Prisma.InputJsonValue });
  return { eventId, status: "ACCEPTED", reason, recordId: existing.id, created: false };
}

async function loadSource(input: IngestInput): Promise<{ source: SourceRow | null; invalid: boolean }> {
  if (!input.sourceId) return { source: null, invalid: false };
  const source = await prisma.attendanceSource.findUnique({
    where: { id: input.sourceId },
    select: { id: true, kind: true, enabled: true, priority: true, matchField: true }
  });
  return { source, invalid: !source || !source.enabled || source.kind !== input.kind };
}

/** Steps 4-5: the dedupe check, then the person. Returns a finished result when either ends the ingest. */
async function dedupeAndResolve(
  input: IngestInput,
  source: SourceRow | null,
  dedupeKey: string | null,
  record: EventRecorder,
  now: Date
): Promise<{ done: IngestResult } | { person: Person }> {
  if (dedupeKey) {
    const seen = await prisma.attendanceEvent.findUnique({ where: { dedupeKey }, select: { id: true, recordId: true } });
    if (seen) return { done: await record({ status: "DUPLICATE", reason: `Already received as event ${seen.id}.`, recordId: seen.recordId }) };
  }
  const matchField = input.matchField ?? source?.matchField ?? "EMAIL";
  const person = input.person ?? (await resolvePerson(input, matchField));
  if (source) await touchSource(source.id, now);
  if (person) return { person };
  // Claims the dedupe key so a retry storm from a device is one row, not thousands; the admin's
  // replay releases it (replayUnmatchedEvent).
  const what = matchField.toLowerCase().replace("_", " ");
  return { done: await recordClaiming(record, { status: "UNMATCHED", reason: `No active person with that ${what}.`, dedupeKey }) };
}

export async function ingestPunch(input: IngestInput): Promise<IngestResult> {
  if (!input.gateChecked) await assertIngestAllowed(input.kind);
  const now = input.now ?? new Date();
  const externalRef = input.externalRef?.trim().slice(0, 191) || null;
  // The record keeps coordinates in its own columns (lat/lng, under the privacy settings) and
  // `input` keeps them for an admin replay; a second copy in the raw payload serves nobody.
  const raw = capRawPayload(input.kind === "WEB" ? input.rawPayload : redactCoordinates(input.rawPayload));
  const normalized = normalizeInput(input, externalRef);
  const base = {
    sourceId: input.sourceId ?? null,
    externalRef,
    identifier: input.identifier?.trim().slice(0, 191) || null,
    isTest: Boolean(input.isTest),
    input: normalized as Prisma.InputJsonValue,
    rawPayload: raw
  };
  const record: EventRecorder = async (data) => {
    const event = await prisma.attendanceEvent.create({ data: { ...base, ...data, source: input.kind } });
    return {
      eventId: event.id,
      status: data.status,
      reason: (data.reason as string | null) ?? null,
      recordId: (data.recordId as string | null) ?? null,
      created: false
    };
  };

  // 1. Shape.
  const punchInAt = parseInstant(input.punchInAt);
  const punchOutAt = input.punchOutAt == null || input.punchOutAt === "" ? null : parseInstant(input.punchOutAt);
  const invalid = shapeError(input, punchInAt, punchOutAt, now);
  if (invalid || !punchInAt) return record({ status: "REJECTED", reason: invalid });

  // 2. Source.
  const { source, invalid: badSource } = await loadSource(input);
  if (badSource) return record({ status: "REJECTED", reason: "That source is unknown, disabled, or of a different kind.", sourceId: null });

  // 3. Test deliveries prove the pipe, nothing else: no dedupe claim, no person lookup, no record.
  if (input.isTest) {
    if (source) await touchSource(source.id, now);
    return record({ status: "ACCEPTED", reason: "Test event: verified and logged; no attendance was recorded." });
  }

  // 4-5. Dedupe BEFORE the person lookup, so the answer cannot depend on whether they exist.
  const dedupeKey = dedupeKeyFor(input.kind, input.sourceId, externalRef);
  const resolved = await dedupeAndResolve(input, source, dedupeKey, record, now);
  if ("done" in resolved) return resolved.done;
  const person = resolved.person;

  // 6. The person's own calendar day.
  const workDate = new Date(todayKeyFor(punchInAt, person.timezone, serverTimezone) + "T00:00:00Z");
  const ctx: SettleContext = {
    input,
    personId: person.id,
    workDate,
    punchInAt,
    punchOutAt,
    source,
    externalRef,
    raw,
    normalized,
    settings: (await getAttendanceSettings()) ?? {},
    eventBase: { ...base, source: input.kind, userId: person.id, workDate, punchInAt, punchOutAt, dedupeKey }
  };

  // 7. Conflict resolution, in one transaction so two sources racing for the same day serialise on
  //    the (userId, workDate) unique key rather than both "winning".
  return settleWithRetry(ctx, dedupeKey, record);
}

async function settleWithRetry(ctx: SettleContext, dedupeKey: string | null, record: EventRecorder): Promise<IngestResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await prisma.$transaction((tx) => settle(tx, ctx));
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Either the dedupe key (a concurrent identical delivery) or the record key (two sources
      // creating the same day at once). The first is a duplicate; the second retries once, and
      // the retry sees the winner's row and runs conflict resolution against it.
      const target = String((error as { meta?: { target?: unknown } }).meta?.target ?? "");
      if (dedupeKey && (target.includes("dedupeKey") || attempt > 0)) {
        return record({ status: "DUPLICATE", reason: "Received concurrently with an identical delivery." });
      }
      if (attempt > 0) throw error;
    }
  }
  /* c8 ignore next */
  throw new AppError(500, "Attendance ingest did not settle.");
}

async function recordClaiming(record: (d: EventData) => Promise<IngestResult>, data: EventData & { dedupeKey: string | null }): Promise<IngestResult> {
  try {
    return await record(data);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return record({ status: "DUPLICATE", reason: "Received concurrently with an identical delivery." });
  }
}

/** Best effort: a stale "last event" timestamp is not worth failing a punch over. */
async function touchSource(id: string, now: Date): Promise<void> {
  await prisma.attendanceSource.update({ where: { id }, data: { lastEventAt: now } }).catch(() => undefined);
}

/**
 * Re-run an UNMATCHED event after the admin fixed the mapping (gave someone their employee code).
 * The old row releases its dedupe key and points at the new event, so the history reads as one
 * story rather than two unrelated deliveries.
 */
export async function replayUnmatchedEvent(eventId: string): Promise<IngestResult> {
  const event = await prisma.attendanceEvent.findUnique({ where: { id: eventId } });
  if (!event) throw new AppError(404, "Event not found");
  if (event.status !== "UNMATCHED") throw new AppError(409, "Only unmatched events can be replayed.");
  const saved = (event.input ?? {}) as {
    identifier?: string | null;
    matchField?: AttendanceMatchField | null;
    punchInAt?: string | null;
    punchOutAt?: string | null;
    location?: { lat: number; lng: number; accuracyM: number | null } | null;
  };
  await prisma.attendanceEvent.update({ where: { id: event.id }, data: { dedupeKey: null } });
  const result = await ingestPunch({
    kind: event.source,
    sourceId: event.sourceId,
    identifier: saved.identifier ?? event.identifier,
    matchField: saved.matchField ?? null,
    punchInAt: saved.punchInAt ?? "",
    punchOutAt: saved.punchOutAt ?? null,
    externalRef: event.externalRef,
    evidence: saved.location ?? undefined,
    rawPayload: event.rawPayload ?? undefined
  });
  await prisma.attendanceEvent.update({
    where: { id: event.id },
    data: { status: "SUPERSEDED", reason: `Replayed as event ${result.eventId ?? "-"} (${result.status}).`.slice(0, 255) }
  });
  return result;
}
