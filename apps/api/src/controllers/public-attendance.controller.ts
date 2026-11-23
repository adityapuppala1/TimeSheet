/**
 * Public REST API v1 — attendance and holidays (V17 A3). Mounted inside publicApiRouter, so the
 * Bearer key is already authenticated; each route then demands its granular grant
 * (`attendance:read` / `attendance:write`). READ/WRITE scope alone opens nothing here — every key
 * minted before these grants existed keeps exactly its old reach (public-api-auth.ts).
 *
 * Integrations-gated: these routes are an integration, so the plan must include
 * attendanceIntegrationsEnabled and the workspace must have attendance switched on.
 *
 * PRIVACY: reads return the punch (who, which day, when, from which source) and never the raw
 * evidence — no coordinates, IP or user agent. An integration needs payroll facts, not GPS.
 */
import { Router } from "express";
import { prisma } from "../config/prisma.js";
import { AppError } from "../middleware/error.js";
import { requireApiGrant, type PublicApiRequest } from "../middleware/public-api-auth.js";
import { assertIngestAllowed, ingestPunch, publicStatus } from "../services/attendance-ingest.service.js";
import { externalPunchItem, identifierOf, MAX_ITEMS_PER_REQUEST, type ItemResult } from "../services/attendance-webhook.service.js";
import { isoDate } from "../services/attendance-settings.service.js";

export const publicAttendanceRouter = Router();

/** 93 days: a quarter, which is the longest window a payroll export plausibly asks for at once. */
const MAX_RANGE_DAYS = 93;

function parseRange(query: Record<string, unknown>): { from: Date; to: Date } {
  const from = typeof query.from === "string" ? query.from : "";
  const to = typeof query.to === "string" ? query.to : "";
  if (!isoDate.safeParse(from).success || !isoDate.safeParse(to).success) {
    throw new AppError(422, "Pass from and to as YYYY-MM-DD.");
  }
  const fromDate = new Date(`${from}T00:00:00Z`);
  const toDate = new Date(`${to}T00:00:00Z`);
  if (toDate < fromDate) throw new AppError(422, "to is before from.");
  if ((toDate.getTime() - fromDate.getTime()) / 86_400_000 > MAX_RANGE_DAYS) {
    throw new AppError(422, `The range is limited to ${MAX_RANGE_DAYS} days.`);
  }
  return { from: fromDate, to: toDate };
}

/** One item of a POST /attendance/punches body. Malformed items are REJECTED in place. */
async function ingestApiItem(index: number, rawItem: unknown, sourceId: string | null, apiKeyId: string): Promise<ItemResult> {
  const check = externalPunchItem.omit({ test: true }).safeParse(rawItem);
  if (!check.success) {
    return { index, status: "REJECTED", eventId: null, error: check.error.issues[0]?.message ?? "Invalid punch" };
  }
  const item = check.data;
  if (!item.externalRef) {
    // Required here (a webhook falls back to its event id; a REST client has nothing else).
    return { index, status: "REJECTED", eventId: null, error: "externalRef is required: it is the idempotency key." };
  }
  const { identifier, matchField } = identifierOf(item, "EMAIL");
  const result = await ingestPunch({
    kind: "API",
    sourceId,
    identifier,
    matchField,
    punchInAt: item.punchInAt,
    punchOutAt: item.punchOutAt ?? null,
    externalRef: item.externalRef,
    evidence: item.location ? { lat: item.location.lat, lng: item.location.lng, accuracyM: item.location.accuracyM ?? null } : undefined,
    rawPayload: { ...item, apiKeyId },
    gateChecked: true
  });
  return { index, status: publicStatus(result.status), eventId: result.eventId, ...(result.status === "REJECTED" && result.reason ? { error: result.reason } : {}) };
}

publicAttendanceRouter.post("/attendance/punches", requireApiGrant("attendance:write"), async (req: PublicApiRequest, res) => {
  await assertIngestAllowed("API");
  const body: unknown = req.body;
  const isBatch = Array.isArray(body);
  const items = isBatch ? body : [body];
  if (items.length === 0 || items.length > MAX_ITEMS_PER_REQUEST) {
    throw new AppError(413, `Send between 1 and ${MAX_ITEMS_PER_REQUEST} punches per request.`);
  }
  const sourceId = typeof req.query.sourceId === "string" && req.query.sourceId ? req.query.sourceId.slice(0, 64) : null;

  const results: ItemResult[] = [];
  for (const [index, rawItem] of items.entries()) {
    results.push(await ingestApiItem(index, rawItem, sourceId, req.apiKey!.id));
  }
  res.status(isBatch ? 207 : 202).json(isBatch ? { results } : results[0]);
});

publicAttendanceRouter.get("/attendance", requireApiGrant("attendance:read"), async (req: PublicApiRequest, res) => {
  await assertIngestAllowed("API");
  const { from, to } = parseRange(req.query);
  const employee = typeof req.query.employee === "string" ? req.query.employee.trim().slice(0, 191) : "";
  const take = Math.min(Math.max(Number(req.query.limit) || 500, 1), 2000);
  const records = await prisma.attendanceRecord.findMany({
    where: {
      workDate: { gte: from, lte: to },
      ...(employee ? { user: { OR: [{ email: employee.toLowerCase() }, { employeeCode: employee }] } } : {})
    },
    orderBy: [{ workDate: "asc" }, { punchInAt: "asc" }],
    take,
    select: {
      id: true,
      workDate: true,
      punchInAt: true,
      punchOutAt: true,
      source: true,
      flagged: true,
      sourceRef: { select: { id: true, name: true } },
      user: { select: { id: true, name: true, email: true, employeeCode: true } }
    }
  });
  res.json({ items: records.map((r) => ({ ...r, workDate: r.workDate.toISOString().slice(0, 10) })) });
});

publicAttendanceRouter.get("/holidays", requireApiGrant("attendance:read"), async (req: PublicApiRequest, res) => {
  await assertIngestAllowed("API");
  const { from, to } = parseRange(req.query);
  const holidays = await prisma.holiday.findMany({
    where: { date: { gte: from, lte: to } },
    orderBy: [{ date: "asc" }, { name: "asc" }],
    select: { date: true, name: true, isOptional: true, calendar: { select: { id: true, name: true, isDefault: true } } }
  });
  res.json({ items: holidays.map((h) => ({ ...h, date: h.date.toISOString().slice(0, 10) })) });
});
