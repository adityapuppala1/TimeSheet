/**
 * /api/leave — V17 Phase B leave routes. Every route is signed-in only and refused (403, with the
 * reason) unless the leave gate is open — workspace toggle AND plan (leave.service.ts#assertLeaveOn).
 * GET /status is the one exception: it answers "is leave on?" as a normal 200 so the app shell can
 * decide whether to show leave at all.
 *
 *   employee   /me/*            balances, ledger, own requests, apply, cancel, expected hours
 *   approver   /inbox*          the decisions waiting on me (decisionRight is the rule), single+bulk
 *   manager    /team            who in my team is off (Team Activity's visibility rule)
 *   admin      /admin/*         SUPER_ADMIN: leave settings, types, adjustments, manual accrual run
 *
 * Applying accepts JSON or multipart (field `document` carries a supporting file, stored through
 * attachment-storage.service.ts like every other upload). Days are computed server-side; a `days`
 * field in the body is refused by the strict schema.
 */
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma.js";
import { requireAuth, requireSuperAdmin } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import { preserveTenantContext, upload } from "../middleware/upload.js";
import { validate } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import { processUpload } from "../services/attachment-storage.service.js";
import { getAttendanceEntitlements, getAttendanceSettings, isoDate } from "../services/attendance-settings.service.js";
import { spanDays } from "../services/attendance-team.service.js";
import { expectedHoursFor } from "../services/leave-capacity.service.js";
import {
  adjustBalance,
  adjustmentBody,
  applyLeave,
  applyLeaveBody,
  assertLeaveOn,
  bulkDecisionBody,
  cancelLeave,
  decideLeave,
  decideMany,
  decisionBody,
  getBalances,
  getLedger,
  getMyRequest,
  isLeaveOn,
  leaveSettingsBody,
  leaveTypeBody,
  listInbox,
  listLeaveTypes,
  listMyRequests,
  listTeamLeave,
  publicLeaveType
} from "../services/leave.service.js";
import { runLeaveAccrual } from "../workers/leave-accrual.worker.js";

export const leaveRouter = Router();

const STATUS = z.enum(["PENDING", "APPROVED", "REJECTED", "CANCELLED"]);
const yearQuery = z.object({ year: z.string().regex(/^\d{4}$/).optional() }).passthrough();

function rangeQuery(query: unknown, maxDays: number) {
  const { from, to } = z.object({ from: isoDate, to: isoDate }).passthrough().parse(query);
  if (to < from) throw new AppError(422, "`to` must be on or after `from`.");
  if (spanDays(from, to) > maxDays) throw new AppError(422, `Ask for at most ${maxDays} days at a time.`);
  return { from, to };
}

const actorOf = (req: { user?: { id: string; role: string; name?: string | null } }) => ({
  id: req.user!.id,
  role: req.user!.role,
  name: req.user!.name ?? null
});

/* ----------------------------- status (never 403) ----------------------------- */

leaveRouter.get("/status", requireAuth, async (_req, res) => {
  const [enabled, settings] = await Promise.all([isLeaveOn(), getAttendanceSettings()]);
  res.json({ enabled, leaveYearStartMonth: settings.leaveYearStartMonth });
});

/* ----------------------------- employee ----------------------------- */

leaveRouter.get("/types", requireAuth, async (_req, res) => {
  await assertLeaveOn();
  res.json({ items: await listLeaveTypes(false) });
});

leaveRouter.get("/me/balances", requireAuth, async (req, res) => {
  await assertLeaveOn();
  const { year } = yearQuery.parse(req.query);
  res.json(await getBalances(req.user!.id, { year: year ? Number(year) : undefined }));
});

leaveRouter.get("/me/ledger", requireAuth, async (req, res) => {
  await assertLeaveOn();
  const { year } = yearQuery.parse(req.query);
  const target = year ? Number(year) : (await getBalances(req.user!.id)).leaveYear;
  res.json({ leaveYear: target, items: await getLedger(req.user!.id, target) });
});

leaveRouter.get("/me/requests", requireAuth, async (req, res) => {
  await assertLeaveOn();
  const q = z.object({ status: STATUS.optional(), year: z.string().regex(/^\d{4}$/).optional() }).passthrough().parse(req.query);
  res.json({ items: await listMyRequests(req.user!.id, { status: q.status, year: q.year ? Number(q.year) : undefined }) });
});

leaveRouter.get("/me/requests/:id", requireAuth, async (req, res) => {
  await assertLeaveOn();
  res.json(await getMyRequest(req.user!.id, String(req.params.id)));
});

leaveRouter.post("/me/requests", requireAuth, preserveTenantContext(upload.single("document")), async (req, res) => {
  await assertLeaveOn();
  const body = applyLeaveBody.parse(req.body);
  const file = req.file;
  const attachment = file
    ? await processUpload(file, { userName: req.user!.name ?? req.user!.email, entityType: "leave", entityId: req.user!.id })
    : null;
  const result = await applyLeave({
    userId: req.user!.id,
    ...body,
    attachment: attachment ? { url: attachment.url, fileName: attachment.fileName, mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes } : null,
    source: "WEB",
    actorId: req.user!.id
  });
  res.status(201).json(result);
});

/** The requester cancels their own (a SUPER_ADMIN may cancel anyone's, including started leave). */
leaveRouter.post("/me/requests/:id/cancel", requireAuth, async (req, res) => {
  await assertLeaveOn();
  res.json(await cancelLeave({ actor: actorOf(req), requestId: String(req.params.id) }));
});

leaveRouter.get("/me/expected-hours", requireAuth, async (req, res) => {
  const { from, to } = rangeQuery(req.query, 366);
  const result = (await expectedHoursFor([req.user!.id], from, to)).get(req.user!.id);
  if (!result) throw new AppError(404, "User not found");
  res.json({ from, to, ...result });
});

/* ----------------------------- approver ----------------------------- */

leaveRouter.get("/inbox", requireAuth, async (req, res) => {
  await assertLeaveOn();
  const q = z
    .object({
      scope: z.enum(["mine", "all"]).optional(),
      status: z.union([STATUS, z.literal("ALL")]).optional(),
      page: z.string().regex(/^\d{1,4}$/).optional(),
      pageSize: z.string().regex(/^\d{1,3}$/).optional()
    })
    .passthrough()
    .parse(req.query);
  res.json(
    await listInbox(actorOf(req), {
      scope: q.scope,
      status: q.status,
      page: q.page ? Number(q.page) : undefined,
      pageSize: q.pageSize ? Number(q.pageSize) : undefined
    })
  );
});

leaveRouter.post("/inbox/bulk-decision", requireAuth, validate(z.object({ body: bulkDecisionBody })), async (req, res) => {
  await assertLeaveOn();
  const body = bulkDecisionBody.parse(req.body);
  const results = await decideMany(actorOf(req), body.ids, body.decision, body.note);
  res.status(207).json({ results });
});

leaveRouter.post("/inbox/:id/decision", requireAuth, validate(z.object({ body: decisionBody })), async (req, res) => {
  await assertLeaveOn();
  const body = decisionBody.parse(req.body);
  res.json(await decideLeave({ actor: actorOf(req), requestId: String(req.params.id), decision: body.decision, note: body.note }));
});

leaveRouter.get("/team", requireAuth, async (req, res) => {
  await assertLeaveOn();
  const { from, to } = rangeQuery(req.query, 93);
  const managerId = typeof req.query.managerId === "string" && req.query.managerId ? req.query.managerId.slice(0, 64) : null;
  res.json(await listTeamLeave(actorOf(req), from, to, managerId));
});

/* ----------------------------- admin (SUPER_ADMIN) ----------------------------- */

const admin = Router();
admin.use(requireAuth, requireSuperAdmin);
leaveRouter.use("/admin", admin);

/** Reads need no entitlement (the settings tab renders its locked state); writes need the plan. */
async function assertLeaveEntitled(): Promise<void> {
  if (!(await getAttendanceEntitlements()).leaveManagementEnabled) {
    throw new AppError(403, "Leave management is not included in this plan. Upgrade to Enterprise to use it.");
  }
}

admin.get("/settings", async (_req, res) => {
  const [settings, entitlements] = await Promise.all([getAttendanceSettings(), getAttendanceEntitlements()]);
  res.json({
    settings: {
      leaveEnabled: settings.leaveEnabled,
      leaveYearStartMonth: settings.leaveYearStartMonth,
      trustExternalApprovals: settings.trustExternalApprovals,
      leaveApprovalFallback: settings.leaveApprovalFallback
    },
    entitled: entitlements.leaveManagementEnabled,
    effective: settings.leaveEnabled && entitlements.leaveManagementEnabled
  });
});

admin.put("/settings", validate(z.object({ body: leaveSettingsBody })), async (req, res) => {
  await assertLeaveEntitled();
  const body = leaveSettingsBody.parse(req.body);
  if (body.leaveEnabled === true && (await prisma.leaveType.count({ where: { enabled: true } })) === 0) {
    throw new AppError(409, "Enable at least one leave type before switching leave on.");
  }
  const updated = await prisma.globalAttendanceSettings.upsert({
    where: { id: "global" },
    update: { ...body, updatedById: req.user!.id },
    create: { id: "global", ...body, updatedById: req.user!.id }
  });
  await audit(req.user!.id, "leave.settings_updated", "GlobalAttendanceSettings", "global", body);
  res.json({
    leaveEnabled: updated.leaveEnabled,
    leaveYearStartMonth: updated.leaveYearStartMonth,
    trustExternalApprovals: updated.trustExternalApprovals,
    leaveApprovalFallback: updated.leaveApprovalFallback
  });
});

admin.get("/types", async (_req, res) => {
  res.json({ items: await listLeaveTypes(true) });
});

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "P2002";
}

admin.post("/types", validate(z.object({ body: leaveTypeBody })), async (req, res) => {
  await assertLeaveEntitled();
  const body = leaveTypeBody.parse(req.body);
  try {
    const created = await prisma.leaveType.create({ data: body });
    await audit(req.user!.id, "leave.type_created", "LeaveType", created.id, body);
    res.status(201).json(publicLeaveType(created));
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError(409, "A leave type with that code already exists.");
    throw error;
  }
});

/** No DELETE: a type with history is disabled instead (LeaveType rows are Restrict-referenced). */
admin.put("/types/:id", validate(z.object({ body: leaveTypeBody.partial() })), async (req, res) => {
  await assertLeaveEntitled();
  const body = leaveTypeBody.partial().parse(req.body);
  const id = String(req.params.id);
  const existing = await prisma.leaveType.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw new AppError(404, "Leave type not found");
  try {
    const updated = await prisma.leaveType.update({ where: { id }, data: body });
    await audit(req.user!.id, "leave.type_updated", "LeaveType", id, body);
    res.json(publicLeaveType(updated));
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError(409, "A leave type with that code already exists.");
    throw error;
  }
});

admin.post("/adjustments", validate(z.object({ body: adjustmentBody })), async (req, res) => {
  await assertLeaveEntitled();
  res.status(201).json(await adjustBalance(req.user!.id, adjustmentBody.parse(req.body)));
});

admin.get("/balances/:userId", async (req, res) => {
  await assertLeaveOn();
  const { year } = yearQuery.parse(req.query);
  const userId = String(req.params.userId);
  const balances = await getBalances(userId, { year: year ? Number(year) : undefined });
  res.json({ ...balances, ledger: await getLedger(userId, balances.leaveYear) });
});

/** Posts what is due now (idempotent — the same keys the nightly run uses). Sends nothing. */
admin.post("/accrual/run", async (req, res) => {
  await assertLeaveOn();
  const result = await runLeaveAccrual();
  await audit(req.user!.id, "leave.accrual_run", "LeaveBalanceLedger", undefined, result);
  res.json(result);
});
