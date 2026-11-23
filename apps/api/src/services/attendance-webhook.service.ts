/**
 * Signed inbound attendance webhooks (V17 A3) — a biometric terminal or an HRMS posting punches to
 * POST /api/integrations/attendance/:sourceId.
 *
 * THE SCHEME (documented in docs/API.md, deliberately the Stripe/Slack shape every integrator knows):
 *   X-TimeSphere-Timestamp: <unix seconds>
 *   X-TimeSphere-Event-Id:  <the sender's unique id for this delivery>
 *   X-TimeSphere-Signature: sha256=<hex HMAC-SHA256(secret, `${timestamp}.${eventId}.${rawBody}`)>
 *
 * WHY EACH PART:
 * - The timestamp is INSIDE the signed bytes, so it cannot be refreshed by someone replaying a
 *   captured delivery, and anything older than REPLAY_WINDOW_SECONDS is refused outright.
 * - The event id is signed too: otherwise a captured delivery could be replayed inside the window
 *   under a fresh id, which skips the replay memory below.
 * - Inside the window, the event id is remembered (services/webhook-replay.ts) — here the secret
 *   never travels with the request, which is exactly the case that module calls a real boundary.
 *   The ingest's (source, externalRef) dedupe is the durable second layer that survives restarts.
 * - The compare is constant-time (utils/security.ts#constantTimeEqual), over the hex digest.
 * - The secret is stored encrypted (utils/encryption.ts), not hashed: verifying an HMAC needs it.
 *   Same at-rest treatment as the git webhook secret.
 *
 * WHAT A CALLER LEARNS: unknown source, disabled source, wrong kind, module or plan off — all 404
 * with one message. A bad signature is 401. Nothing ever says whether a person exists: every item
 * reports RECEIVED / DUPLICATE / REJECTED (attendance-ingest.service.ts#publicStatus).
 */
import crypto from "node:crypto";
import { z } from "zod";
import type { AttendanceMatchField } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { AppError } from "../middleware/error.js";
import { decryptSecret } from "../utils/encryption.js";
import { constantTimeEqual } from "../utils/security.js";
import { isReplayedDelivery } from "./webhook-replay.js";
import { assertLeaveIntegrationAllowed } from "./leave.service.js";
import { ingestExternalLeave, isLeaveItem } from "./leave-external.service.js";
import { assertIngestAllowed, ingestPunch, publicStatus, type PublicIngestStatus } from "./attendance-ingest.service.js";

export const REPLAY_WINDOW_SECONDS = 300;
export const MAX_ITEMS_PER_REQUEST = 500;
export const WEBHOOK_BODY_LIMIT = "512kb";

export const SIGNATURE_HEADER = "x-timesphere-signature";
export const TIMESTAMP_HEADER = "x-timesphere-timestamp";
export const EVENT_ID_HEADER = "x-timesphere-event-id";

export function signAttendancePayload(secret: string, timestamp: string, eventId: string, rawBody: string): string {
  const digest = crypto.createHmac("sha256", secret).update(`${timestamp}.${eventId}.${rawBody}`).digest("hex");
  return "sha256=" + digest;
}

export type SignatureVerdict = "OK" | "MISSING" | "STALE" | "BAD_SIGNATURE";

/** Pure — the whole cryptographic decision, testable without HTTP. */
export function verifyAttendanceSignature(params: {
  secret: string;
  timestamp: string | undefined;
  eventId: string | undefined;
  signature: string | undefined;
  rawBody: string;
  nowMs?: number;
}): SignatureVerdict {
  const { secret, timestamp, eventId, signature, rawBody } = params;
  if (!timestamp || !signature || !eventId) return "MISSING";
  if (!/^\d{9,11}$/.test(timestamp)) return "STALE";
  const skew = Math.abs((params.nowMs ?? Date.now()) / 1000 - Number(timestamp));
  if (skew > REPLAY_WINDOW_SECONDS) return "STALE";
  const expected = signAttendancePayload(secret, timestamp, eventId, rawBody);
  return constantTimeEqual(expected, signature.trim()) ? "OK" : "BAD_SIGNATURE";
}

/** One punch as an external system sends it. Strict: an unknown field is a sender bug to surface. */
export const externalPunchItem = z
  .object({
    /** Interpreted by the source's match field (webhook) — or use one of the explicit fields. */
    identifier: z.string().trim().min(1).max(191).optional(),
    email: z.string().trim().min(1).max(191).optional(),
    employeeCode: z.string().trim().min(1).max(64).optional(),
    externalId: z.string().trim().min(1).max(191).optional(),
    punchInAt: z.string().min(1).max(40),
    punchOutAt: z.string().max(40).nullable().optional(),
    externalRef: z.string().trim().min(1).max(191).optional(),
    location: z
      .object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracyM: z.number().min(0).max(100000).optional() })
      .strict()
      .optional(),
    /** "Send test event": verified and logged, never recorded. */
    test: z.boolean().optional()
  })
  .strict();

export type ExternalPunchItem = z.infer<typeof externalPunchItem>;

/** Which identifier an item carries, and under which match field. Explicit fields win. */
export function identifierOf(item: ExternalPunchItem, fallback: AttendanceMatchField): { identifier: string | null; matchField: AttendanceMatchField } {
  if (item.email) return { identifier: item.email, matchField: "EMAIL" };
  if (item.employeeCode) return { identifier: item.employeeCode, matchField: "EMPLOYEE_CODE" };
  if (item.externalId) return { identifier: item.externalId, matchField: "EXTERNAL_ID" };
  return { identifier: item.identifier ?? null, matchField: fallback };
}

/** Each item through the ingest; a malformed one is REJECTED in place, never fails the batch. */
async function ingestItems(items: unknown[], source: { id: string; matchField: AttendanceMatchField }, eventId: string): Promise<ItemResult[]> {
  const results: ItemResult[] = [];
  let leaveGate: string | null | undefined;
  for (const [index, rawItem] of items.entries()) {
    // V17 Phase B: an HRMS may send leave on the same signed channel ({ "kind": "leave", ... }).
    if (isLeaveItem(rawItem)) {
      leaveGate ??= await leaveGateMessage();
      results.push(await ingestLeaveItem(index, rawItem, source, leaveGate));
      continue;
    }
    const check = externalPunchItem.safeParse(rawItem);
    if (!check.success) {
      results.push({ index, status: "REJECTED", eventId: null, error: check.error.issues[0]?.message ?? "Invalid punch" });
      continue;
    }
    const item = check.data;
    const { identifier, matchField } = identifierOf(item, source.matchField);
    const result = await ingestPunch({
      kind: "WEBHOOK",
      sourceId: source.id,
      identifier,
      matchField,
      punchInAt: item.punchInAt,
      punchOutAt: item.punchOutAt ?? null,
      // A device that sends no per-punch id is still idempotent per delivery.
      externalRef: item.externalRef ?? (items.length === 1 ? eventId : `${eventId}#${index}`),
      evidence: item.location ? { lat: item.location.lat, lng: item.location.lng, accuracyM: item.location.accuracyM ?? null } : undefined,
      rawPayload: rawItem,
      isTest: item.test === true,
      gateChecked: true
    });
    results.push({ index, status: publicStatus(result.status), eventId: result.eventId, ...(result.status === "REJECTED" && result.reason ? { error: result.reason } : {}) });
  }
  return results;
}

export interface ItemResult {
  index: number;
  status: PublicIngestStatus;
  eventId: string | null;
  /** Leave items only (Phase B). */
  leaveRequestId?: string | null;
  leaveStatus?: string;
  error?: string;
}

/** One leave item on the webhook, through the same function the public API uses. */
async function ingestLeaveItem(index: number, rawItem: unknown, source: { id: string; matchField: AttendanceMatchField }, gate: string | null): Promise<ItemResult> {
  if (gate) return { index, status: "REJECTED", eventId: null, error: gate };
  const leave = await ingestExternalLeave({ kind: "WEBHOOK", sender: source.id, rawItem, matchFallback: source.matchField });
  return {
    index,
    status: leave.status,
    eventId: null,
    leaveRequestId: leave.requestId,
    ...(leave.leaveStatus ? { leaveStatus: leave.leaveStatus } : {}),
    ...(leave.error ? { error: leave.error } : {})
  };
}

/** Null when leave items may be ingested; otherwise the reason each one is rejected. */
async function leaveGateMessage(): Promise<string | null> {
  try {
    await assertLeaveIntegrationAllowed();
    return null;
  } catch (error) {
    if (error instanceof AppError) return error.message;
    throw error;
  }
}

const NOT_FOUND = "Not found";

/**
 * The whole webhook, framework-free so "send test event" runs the exact same code path in-process
 * (signed server-side) as a real device does over HTTP.
 */
export async function handleAttendanceWebhook(params: {
  sourceId: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
  nowMs?: number;
}): Promise<{ status: number; body: unknown }> {
  const header = (name: string) => {
    const v = params.headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  const source = /^[0-9a-f-]{36}$/i.test(params.sourceId)
    ? await prisma.attendanceSource.findUnique({ where: { id: params.sourceId } })
    : null;
  if (!source || !source.enabled || source.kind !== "WEBHOOK" || !source.secretEncrypted) throw new AppError(404, NOT_FOUND);
  try {
    await assertIngestAllowed("WEBHOOK");
  } catch (error) {
    if (error instanceof AppError) throw new AppError(404, NOT_FOUND);
    throw error;
  }

  let secret: string;
  try {
    secret = decryptSecret(source.secretEncrypted);
  } catch {
    // A key rotation without re-encrypting is an operator problem, not the sender's; still 404 so a
    // broken source looks like no source.
    throw new AppError(404, NOT_FOUND);
  }
  // The event id is part of the signed bytes, so it must be present before verifying.
  const eventId = header(EVENT_ID_HEADER)?.trim();
  if (!eventId || eventId.length > 120) throw new AppError(400, "Send a unique X-TimeSphere-Event-Id (max 120 characters) with every delivery.");
  const verdict = verifyAttendanceSignature({
    secret,
    timestamp: header(TIMESTAMP_HEADER),
    eventId,
    signature: header(SIGNATURE_HEADER),
    rawBody: params.rawBody,
    nowMs: params.nowMs
  });
  if (verdict === "MISSING") throw new AppError(401, "Missing X-TimeSphere-Timestamp or X-TimeSphere-Signature.");
  if (verdict === "STALE") throw new AppError(401, "Timestamp outside the 5-minute window. Check the sender's clock.");
  if (verdict === "BAD_SIGNATURE") throw new AppError(401, "Signature mismatch.");

  // Checked only AFTER the signature: an unauthenticated caller must not be able to burn ids.
  if (isReplayedDelivery(`${requireTenantContext().orgId}:attendance:${source.id}`, eventId)) {
    return { status: 200, body: { duplicate: true, results: [] } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(params.rawBody);
  } catch {
    throw new AppError(400, "Body must be JSON: one punch object or an array of them.");
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  if (items.length === 0 || items.length > MAX_ITEMS_PER_REQUEST) {
    throw new AppError(413, `Send between 1 and ${MAX_ITEMS_PER_REQUEST} punches per delivery.`);
  }

  const results = await ingestItems(items, source, eventId);
  return { status: 202, body: { results } };
}
