/**
 * Public REST API v1 — leave (V17 Phase B). Mounted inside publicApiRouter, so the Bearer key is
 * already authenticated; each route then demands its granular grant (`leave:read` / `leave:write`).
 * READ/WRITE scope alone opens nothing here, exactly like the attendance grants.
 *
 * Gated on leave being on (toggle + plan) AND the plan's attendance integrations: this is an
 * integration surface, the same reasoning as public-attendance.controller.ts.
 *
 * WRITES go through leave-external.service.ts, the same function the HRMS webhook uses: one item or
 * an array of up to 500, each idempotent on (API, key, externalRef), APPROVED honoured only when the
 * workspace trusts external approvals, CANCELLED cancelling an earlier item.
 *
 * READS return the request facts (who, type, dates, halves, days, status, source). Never the free-
 * text reason or decision note: an integration needs payroll facts, not people's words.
 */
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma.js";
import { AppError } from "../middleware/error.js";
import { requireApiGrant, type PublicApiRequest } from "../middleware/public-api-auth.js";
import { isoDate } from "../services/attendance-settings.service.js";
import { assertLeaveIntegrationAllowed } from "../services/leave.service.js";
import { ingestExternalLeave, type ExternalLeaveResult } from "../services/leave-external.service.js";

export const publicLeaveRouter = Router();

const MAX_ITEMS = 500;
const MAX_RANGE_DAYS = 366;

publicLeaveRouter.post("/leave-requests", requireApiGrant("leave:write"), async (req: PublicApiRequest, res) => {
  await assertLeaveIntegrationAllowed();
  const body: unknown = req.body;
  const isBatch = Array.isArray(body);
  const items = isBatch ? body : [body];
  if (items.length === 0 || items.length > MAX_ITEMS) throw new AppError(413, `Send between 1 and ${MAX_ITEMS} leave requests per call.`);
  const results: Array<ExternalLeaveResult & { index: number }> = [];
  for (const [index, rawItem] of items.entries()) {
    results.push({ index, ...(await ingestExternalLeave({ kind: "API", sender: req.apiKey!.id, rawItem })) });
  }
  if (isBatch) {
    res.status(207).json({ results });
    return;
  }
  res.status(results[0].status === "REJECTED" ? 422 : 202).json(results[0]);
});

const listQuery = z
  .object({
    from: isoDate,
    to: isoDate,
    employee: z.string().trim().max(191).optional(),
    status: z.enum(["PENDING", "APPROVED", "REJECTED", "CANCELLED"]).optional(),
    limit: z.string().regex(/^\d{1,4}$/).optional()
  })
  .passthrough();

publicLeaveRouter.get("/leave-requests", requireApiGrant("leave:read"), async (req: PublicApiRequest, res) => {
  await assertLeaveIntegrationAllowed();
  const q = listQuery.safeParse(req.query);
  if (!q.success) throw new AppError(422, "Pass from and to as YYYY-MM-DD.");
  const { from, to, employee, status } = q.data;
  if (to < from) throw new AppError(422, "to is before from.");
  if ((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000 > MAX_RANGE_DAYS) {
    throw new AppError(422, `The range is limited to ${MAX_RANGE_DAYS} days.`);
  }
  const take = Math.min(Math.max(Number(q.data.limit) || 500, 1), 2000);
  const rows = await prisma.leaveRequest.findMany({
    where: {
      startDate: { lte: new Date(`${to}T00:00:00Z`) },
      endDate: { gte: new Date(`${from}T00:00:00Z`) },
      ...(status ? { status } : {}),
      ...(employee ? { user: { OR: [{ email: employee.toLowerCase() }, { employeeCode: employee }] } } : {})
    },
    orderBy: [{ startDate: "asc" }, { createdAt: "asc" }],
    take,
    select: {
      id: true,
      startDate: true,
      endDate: true,
      startHalf: true,
      endHalf: true,
      days: true,
      leaveYear: true,
      status: true,
      source: true,
      externalRef: true,
      decidedAt: true,
      createdAt: true,
      leaveType: { select: { code: true, name: true, isPaid: true } },
      user: { select: { id: true, name: true, email: true, employeeCode: true } }
    }
  });
  res.json({
    items: rows.map((r) => ({
      ...r,
      days: Number(r.days),
      startDate: r.startDate.toISOString().slice(0, 10),
      endDate: r.endDate.toISOString().slice(0, 10)
    }))
  });
});
