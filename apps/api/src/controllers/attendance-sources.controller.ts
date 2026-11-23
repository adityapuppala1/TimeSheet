/**
 * /api/attendance/admin — Sources & integrations (V17 A3): inbound sources, their webhook secrets,
 * the delivery log, replay, test events and CSV import.
 *
 * Super admin only, and EVERY route needs the `attendanceIntegrationsEnabled` entitlement — the
 * settings tab renders its locked card from GET /settings (attendance-settings.controller.ts), so
 * nothing here has to answer for a plan without integrations.
 *
 * SECRETS: generated server-side (32 random bytes), stored encrypted, returned exactly once — on
 * create and on rotate. No route ever reads one back. The test event is signed server-side with
 * the stored secret and run through the same handler a device hits, so a green test proves the
 * real path, not a mock of it.
 */
import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { requireAuth, requireSuperAdmin } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import { validate } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import { isPlanningCapabilityAllowed } from "../services/plan-limits.service.js";
import { assertIngestAllowed, replayUnmatchedEvent } from "../services/attendance-ingest.service.js";
import { commitCsv, validateCsv, CSV_MAX_CHARS } from "../services/attendance-csv.service.js";
import {
  EVENT_ID_HEADER,
  handleAttendanceWebhook,
  SIGNATURE_HEADER,
  signAttendancePayload,
  TIMESTAMP_HEADER
} from "../services/attendance-webhook.service.js";
import { encryptSecret, decryptSecret } from "../utils/encryption.js";

export const attendanceSourcesRouter = Router();
attendanceSourcesRouter.use(requireAuth, requireSuperAdmin);
attendanceSourcesRouter.use(async (_req, _res, next) => {
  if (!(await isPlanningCapabilityAllowed(requireTenantContext().orgId, "attendanceIntegrationsEnabled"))) {
    throw new AppError(403, "Attendance integrations are not included in this plan. Upgrade to Enterprise to use them.");
  }
  next();
});

const idParams = z.object({ id: z.string().min(1).max(64) });
const KINDS = ["WEBHOOK", "API", "CSV"] as const;
const MATCH = ["EMAIL", "EMPLOYEE_CODE", "EXTERNAL_ID"] as const;

/** Relative on purpose: the client prefixes its own origin, which is the tenant's host. */
export const webhookPathFor = (id: string) => `/api/integrations/attendance/${id}`;

function newSecret(): string {
  return `whsec_${crypto.randomBytes(32).toString("hex")}`;
}

const SOURCE_SELECT = {
  id: true,
  name: true,
  kind: true,
  matchField: true,
  priority: true,
  enabled: true,
  lastEventAt: true,
  createdAt: true,
  secretEncrypted: true
} as const;

function present(row: { id: string; kind: string; secretEncrypted: string | null } & Record<string, unknown>) {
  const { secretEncrypted, ...rest } = row;
  return { ...rest, hasSecret: Boolean(secretEncrypted), webhookPath: row.kind === "WEBHOOK" ? webhookPathFor(row.id) : null };
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "P2002";
}

/* ------------------------------------------------------------------ *
 * Sources
 * ------------------------------------------------------------------ */

attendanceSourcesRouter.get("/sources", async (_req, res) => {
  const rows = await prisma.attendanceSource.findMany({ orderBy: [{ priority: "desc" }, { name: "asc" }], select: SOURCE_SELECT });
  res.json(rows.map(present));
});

const createSourceBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    kind: z.enum(KINDS),
    matchField: z.enum(MATCH).optional(),
    priority: z.number().int().min(-1000).max(1000).optional(),
    enabled: z.boolean().optional()
  })
  .strict();

attendanceSourcesRouter.post("/sources", validate(z.object({ body: createSourceBody })), async (req, res) => {
  const body = createSourceBody.parse(req.body);
  const secret = body.kind === "WEBHOOK" ? newSecret() : null;
  try {
    const created = await prisma.attendanceSource.create({
      data: { ...body, secretEncrypted: secret ? encryptSecret(secret) : null },
      select: SOURCE_SELECT
    });
    await audit(req.user!.id, "attendance.source_created", "AttendanceSource", created.id, { name: created.name, kind: created.kind });
    res.status(201).json({ ...present(created), secret });
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError(409, "A source with that name already exists.");
    throw error;
  }
});

const updateSourceBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    matchField: z.enum(MATCH),
    priority: z.number().int().min(-1000).max(1000),
    enabled: z.boolean()
  })
  .partial()
  .strict();

attendanceSourcesRouter.patch("/sources/:id", validate(z.object({ params: idParams, body: updateSourceBody })), async (req, res) => {
  const body = updateSourceBody.parse(req.body);
  try {
    const updated = await prisma.attendanceSource.update({ where: { id: String(req.params.id) }, data: body, select: SOURCE_SELECT });
    await audit(req.user!.id, "attendance.source_updated", "AttendanceSource", updated.id, body);
    res.json(present(updated));
  } catch (error) {
    if ((error as { code?: string }).code === "P2025") throw new AppError(404, "Source not found");
    if (isUniqueViolation(error)) throw new AppError(409, "A source with that name already exists.");
    throw error;
  }
});

attendanceSourcesRouter.delete("/sources/:id", validate(z.object({ params: idParams })), async (req, res) => {
  const existing = await prisma.attendanceSource.findUnique({ where: { id: String(req.params.id) }, select: { id: true, name: true } });
  if (!existing) throw new AppError(404, "Source not found");
  // Records and events keep their rows (SetNull) — deleting a device must not erase attendance.
  await prisma.attendanceSource.delete({ where: { id: existing.id } });
  await audit(req.user!.id, "attendance.source_deleted", "AttendanceSource", existing.id, { name: existing.name });
  res.status(204).send();
});

attendanceSourcesRouter.post("/sources/:id/rotate-secret", validate(z.object({ params: idParams })), async (req, res) => {
  const existing = await prisma.attendanceSource.findUnique({ where: { id: String(req.params.id) }, select: { id: true, kind: true } });
  if (!existing) throw new AppError(404, "Source not found");
  if (existing.kind !== "WEBHOOK") throw new AppError(422, "Only webhook sources have a signing secret.");
  const secret = newSecret();
  await prisma.attendanceSource.update({ where: { id: existing.id }, data: { secretEncrypted: encryptSecret(secret) } });
  await audit(req.user!.id, "attendance.source_secret_rotated", "AttendanceSource", existing.id, {});
  res.json({ secret });
});

attendanceSourcesRouter.post("/sources/:id/test", validate(z.object({ params: idParams })), async (req, res) => {
  const source = await prisma.attendanceSource.findUnique({ where: { id: String(req.params.id) } });
  if (!source) throw new AppError(404, "Source not found");
  if (source.kind !== "WEBHOOK" || !source.secretEncrypted) throw new AppError(422, "Test events are for webhook sources.");
  if (!source.enabled) throw new AppError(422, "Enable the source first — a disabled source answers 404 to everyone, tests included.");
  await assertIngestAllowed("WEBHOOK");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = JSON.stringify({ test: true, identifier: "test", punchInAt: new Date().toISOString(), externalRef: `test-${crypto.randomUUID()}` });
  const result = await handleAttendanceWebhook({
    sourceId: source.id,
    rawBody,
    headers: {
      [TIMESTAMP_HEADER]: timestamp,
      [SIGNATURE_HEADER]: signAttendancePayload(decryptSecret(source.secretEncrypted), timestamp, rawBody),
      [EVENT_ID_HEADER]: `test-${crypto.randomUUID()}`
    }
  });
  res.json(result.body);
});

/* ------------------------------------------------------------------ *
 * Delivery log
 * ------------------------------------------------------------------ */

const STATUSES = ["ACCEPTED", "DUPLICATE", "SUPERSEDED", "UNMATCHED", "REJECTED"] as const;

attendanceSourcesRouter.get("/events", async (req, res) => {
  const status = typeof req.query.status === "string" && (STATUSES as readonly string[]).includes(req.query.status) ? (req.query.status as (typeof STATUSES)[number]) : undefined;
  const sourceId = typeof req.query.sourceId === "string" && req.query.sourceId ? req.query.sourceId.slice(0, 64) : undefined;
  const take = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const cursor = typeof req.query.cursor === "string" && req.query.cursor ? req.query.cursor.slice(0, 64) : undefined;
  const rows = await prisma.attendanceEvent.findMany({
    where: { ...(status ? { status } : {}), ...(sourceId ? { sourceId } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      source: true,
      status: true,
      reason: true,
      externalRef: true,
      identifier: true,
      userId: true,
      workDate: true,
      punchInAt: true,
      punchOutAt: true,
      isTest: true,
      createdAt: true,
      rawPayload: true,
      sourceRef: { select: { id: true, name: true } }
    }
  });
  const userIds = [...new Set(rows.map((r) => r.userId).filter((v): v is string => Boolean(v)))];
  const users = userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }) : [];
  const byId = new Map(users.map((u) => [u.id, u]));
  const page = rows.slice(0, take);
  res.json({
    events: page.map((r) => ({
      ...r,
      workDate: r.workDate ? r.workDate.toISOString().slice(0, 10) : null,
      person: r.userId ? (byId.get(r.userId) ?? null) : null
    })),
    nextCursor: rows.length > take ? page[page.length - 1].id : null
  });
});

attendanceSourcesRouter.post("/events/:id/replay", validate(z.object({ params: idParams })), async (req, res) => {
  const result = await replayUnmatchedEvent(String(req.params.id));
  await audit(req.user!.id, "attendance.event_replayed", "AttendanceEvent", String(req.params.id), { result: result.status });
  res.json(result);
});

/* ------------------------------------------------------------------ *
 * CSV import
 * ------------------------------------------------------------------ */

const importBody = z
  .object({
    csv: z.string().min(1).max(CSV_MAX_CHARS),
    matchField: z.enum(MATCH).default("EMAIL"),
    sourceId: z.string().max(64).nullable().optional()
  })
  .strict();

async function resolveCsvSource(sourceId: string | null | undefined): Promise<string | null> {
  if (!sourceId) return null;
  const source = await prisma.attendanceSource.findUnique({ where: { id: sourceId }, select: { id: true, kind: true, enabled: true } });
  if (!source || source.kind !== "CSV" || !source.enabled) throw new AppError(422, "Pick an enabled CSV source, or none.");
  return source.id;
}

attendanceSourcesRouter.post("/import/preview", validate(z.object({ body: importBody })), async (req, res) => {
  await assertIngestAllowed("CSV");
  const body = importBody.parse(req.body);
  await resolveCsvSource(body.sourceId);
  const { rows, headerErrors } = await validateCsv(body.csv, body.matchField);
  res.json({
    headerErrors,
    total: rows.length,
    valid: rows.filter((r) => r.errors.length === 0).length,
    // The preview is capped; the commit re-reads the whole file anyway.
    rows: rows.slice(0, 200).map((r) => ({ ...r, person: r.person ? { id: r.person.id, name: r.person.name } : null }))
  });
});

attendanceSourcesRouter.post("/import/commit", validate(z.object({ body: importBody })), async (req, res) => {
  await assertIngestAllowed("CSV");
  const body = importBody.parse(req.body);
  const sourceId = await resolveCsvSource(body.sourceId);
  const summary = await commitCsv(body.csv, body.matchField, sourceId);
  await audit(req.user!.id, "attendance.csv_imported", "AttendanceEvent", "csv", summary);
  res.json(summary);
});
