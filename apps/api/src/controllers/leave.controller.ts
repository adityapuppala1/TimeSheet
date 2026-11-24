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
import { scopeColumns } from "../utils/scope-columns.js";
import { assertKnownScopeSites } from "../services/policy-scope-sites.service.js";
import { z } from "zod";
import { prisma } from "../config/prisma.js";
import { requireAuth, requireSuperAdmin } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import { preserveTenantContext, upload } from "../middleware/upload.js";
import { validate } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import { processUpload } from "../services/attachment-storage.service.js";
import { deleteStoredLeaveUpload } from "../services/leave-upload-cleanup.service.js";
import { getAttendanceEntitlements, getAttendanceSettings, isoDate } from "../services/attendance-settings.service.js";
import { spanDays } from "../services/attendance-team.service.js";
import { attendanceOrLeaveOn, expectedHoursFor } from "../services/leave-capacity.service.js";
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
  previewLeave,
  previewQuery,
  publicLeaveType
} from "../services/leave.service.js";
import { runLeaveAccrual } from "../workers/leave-accrual.worker.js";
import { buildPayrollReport, payrollCsv } from "../services/payroll-export.service.js";
import { createDelegation, delegateCandidates, delegationBody, listDelegations, revokeDelegation } from "../services/approval-delegation.service.js";
import {
  cancelCompOff,
  compOffDecisionBody,
  compOffEligibility,
  compOffRequestBody,
  compOffSettingsBody,
  assertCompOffOn,
  decideCompOff,
  expireCompOffCredits,
  isCompOffOn,
  listCompOffInbox,
  listMyCompOff,
  publicCompOffSettings,
  requestCompOff
} from "../services/comp-off.service.js";

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
  const [enabled, settings, compOff] = await Promise.all([isLeaveOn(), getAttendanceSettings(), isCompOffOn()]);
  res.json({ enabled, leaveYearStartMonth: settings.leaveYearStartMonth, compOffEnabled: compOff });
});

/* ----------------------------- employee ----------------------------- */

leaveRouter.get("/types", requireAuth, async (req, res) => {
  await assertLeaveOn();
  // 7.0.0: only the types in the caller's scope (employment type / site).
  res.json({ items: await listLeaveTypes(false, req.user!.id) });
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

/** The Apply screen live summary: days, excluded days, balance before/after, overlap, approver. Writes nothing. */
leaveRouter.get("/me/preview", requireAuth, async (req, res) => {
  await assertLeaveOn();
  res.json(await previewLeave(req.user!.id, previewQuery.parse(req.query)));
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
  let result: Awaited<ReturnType<typeof applyLeave>>;
  try {
    result = await applyLeave({
      userId: req.user!.id,
      ...body,
      attachment: attachment ? { url: attachment.url, fileName: attachment.fileName, mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes } : null,
      source: "WEB",
      actorId: req.user!.id
    });
  } catch (error) {
    // The document was stored before apply validated the request; nothing points at it now.
    if (attachment) await deleteStoredLeaveUpload(attachment.storageKey);
    throw error;
  }
  res.status(201).json(result);
});

/** The requester cancels their own (a SUPER_ADMIN may cancel anyone's, including started leave). */
leaveRouter.post("/me/requests/:id/cancel", requireAuth, async (req, res) => {
  await assertLeaveOn();
  const comment = typeof req.body?.comment === "string" ? req.body.comment : null;
  res.json(await cancelLeave({ actor: actorOf(req), requestId: String(req.params.id), comment }));
});

/** Gated like its siblings: holidays and leave are Attendance & Leave data (either part on + plan). */
leaveRouter.get("/me/expected-hours", requireAuth, async (req, res) => {
  if (!(await attendanceOrLeaveOn())) {
    throw new AppError(403, "Attendance & Leave is off for this workspace, so there are no holidays or leave to count.");
  }
  const { from, to } = rangeQuery(req.query, 366);
  const result = (await expectedHoursFor([req.user!.id], from, to)).get(req.user!.id);
  if (!result) throw new AppError(404, "User not found");
  res.json({ from, to, ...result });
});

/* ----------------------------- comp-off (7.0.0) ----------------------------- */

leaveRouter.get("/me/comp-off/eligibility", requireAuth, async (req, res) => {
  await assertCompOffOn();
  const { date } = z.object({ date: isoDate }).passthrough().parse(req.query);
  res.json(await compOffEligibility(req.user!.id, date));
});

leaveRouter.get("/me/comp-off", requireAuth, async (req, res) => {
  res.json({ items: await listMyCompOff(req.user!.id) });
});

leaveRouter.post("/me/comp-off", requireAuth, validate(z.object({ body: compOffRequestBody })), async (req, res) => {
  const body = compOffRequestBody.parse(req.body);
  res.status(201).json(await requestCompOff({ userId: req.user!.id, workDate: body.workDate, reason: body.reason ?? null }));
});

leaveRouter.post("/me/comp-off/:id/cancel", requireAuth, async (req, res) => {
  res.json(await cancelCompOff(req.user!.id, String(req.params.id)));
});

leaveRouter.get("/comp-off/inbox", requireAuth, async (req, res) => {
  res.json(await listCompOffInbox(actorOf(req)));
});

leaveRouter.post("/comp-off/inbox/:id/decision", requireAuth, validate(z.object({ body: compOffDecisionBody })), async (req, res) => {
  const body = compOffDecisionBody.parse(req.body);
  res.json(await decideCompOff({ actor: actorOf(req), requestId: String(req.params.id), decision: body.decision, note: body.note ?? null }));
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
  const inbox = await listInbox(actorOf(req), {
    scope: q.scope,
    status: q.status,
    page: q.page ? Number(q.page) : undefined,
    pageSize: q.pageSize ? Number(q.pageSize) : undefined
  });
  // 7.0.0: comp-off requests waiting on me, for the nav badge (only when comp-off is on).
  const pendingView = (q.status ?? "PENDING") === "PENDING" && (q.scope ?? "mine") === "mine";
  const compOffPending = pendingView && (await isCompOffOn()) ? (await listCompOffInbox(actorOf(req))).total : undefined;
  res.json(compOffPending === undefined ? inbox : { ...inbox, compOffPending });
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
  const [settings, entitlements, locked] = await Promise.all([getAttendanceSettings(), getAttendanceEntitlements(), leaveYearLocked()]);
  res.json({
    settings: {
      leaveEnabled: settings.leaveEnabled,
      leaveYearStartMonth: settings.leaveYearStartMonth,
      trustExternalApprovals: settings.trustExternalApprovals,
      leaveApprovalFallback: settings.leaveApprovalFallback
    },
    entitled: entitlements.leaveManagementEnabled,
    effective: settings.leaveEnabled && entitlements.leaveManagementEnabled,
    // The settings UI disables the start-month picker and says why (the PUT refuses with the same text).
    leaveYearLocked: locked,
    leaveYearLockedMessage: locked ? LEAVE_YEAR_LOCKED_MESSAGE : null
  });
});

admin.put("/settings", validate(z.object({ body: leaveSettingsBody })), async (req, res) => {
  await assertLeaveEntitled();
  const body = leaveSettingsBody.parse(req.body);
  if (body.leaveEnabled === true && (await prisma.leaveType.count({ where: { enabled: true } })) === 0) {
    throw new AppError(409, "Enable at least one leave type before switching leave on.");
  }
  await assertLeaveYearChangeAllowed(body.leaveYearStartMonth);
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

export const LEAVE_YEAR_LOCKED_MESSAGE =
  "The leave year start month can't be changed once leave has been requested or balances posted: every balance and request is filed under its leave year, and moving the boundary would re-file them. Keep the current start month.";

/**
 * Every ledger row and request carries a leaveYear computed from the start month at the time. A new
 * start month would silently re-slice years that already hold balances, so it may only change while
 * there is no leave data at all.
 */
async function assertLeaveYearChangeAllowed(next: number | undefined): Promise<void> {
  if (next === undefined) return;
  const current = (await getAttendanceSettings()).leaveYearStartMonth ?? 1;
  if (next === current) return;
  if (await leaveYearLocked()) throw new AppError(409, LEAVE_YEAR_LOCKED_MESSAGE, { code: "LEAVE_YEAR_LOCKED" });
}

async function leaveYearLocked(): Promise<boolean> {
  const [ledger, request] = await Promise.all([
    prisma.leaveBalanceLedger.findFirst({ select: { id: true } }),
    prisma.leaveRequest.findFirst({ select: { id: true } })
  ]);
  return Boolean(ledger || request);
}

admin.get("/comp-off", async (_req, res) => {
  const [settings, entitlements] = await Promise.all([getAttendanceSettings(), getAttendanceEntitlements()]);
  res.json({ settings: publicCompOffSettings(settings), entitled: entitlements.leaveManagementEnabled });
});

admin.put("/comp-off", validate(z.object({ body: compOffSettingsBody })), async (req, res) => {
  await assertLeaveEntitled();
  const body = compOffSettingsBody.parse(req.body);
  const current = publicCompOffSettings(await getAttendanceSettings());
  const next = { ...current, ...body };
  if (next.compOffHalfDayHours > next.compOffFullDayHours) throw new AppError(422, "The half-day threshold can't be more than the full-day one.");
  if (next.compOffEnabled) {
    const type = await prisma.leaveType.findUnique({ where: { code: next.compOffLeaveTypeCode }, select: { enabled: true } });
    if (!type?.enabled) {
      throw new AppError(409, `Enable the ${next.compOffLeaveTypeCode} leave type first: comp-off credits it, and people spend it by applying for that type.`, { code: "COMPOFF_TYPE_DISABLED" });
    }
  }
  const updated = await prisma.globalAttendanceSettings.upsert({
    where: { id: "global" },
    update: { ...body, updatedById: req.user!.id },
    create: { id: "global", ...body, updatedById: req.user!.id }
  });
  await audit(req.user!.id, "leave.compoff_settings_updated", "GlobalAttendanceSettings", "global", body);
  res.json(publicCompOffSettings(updated));
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
  await assertKnownScopeSites(body.scopeSiteIds);
  try {
    const created = await prisma.leaveType.create({ data: scopeColumns(body) });
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
  await assertKnownScopeSites(body.scopeSiteIds);
  try {
    const updated = await prisma.leaveType.update({ where: { id }, data: scopeColumns(body) });
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
  const result = { ...(await runLeaveAccrual()), compOffExpired: await expireCompOffCredits() };
  await audit(req.user!.id, "leave.accrual_run", "LeaveBalanceLedger", undefined, result);
  res.json(result);
});

/* ----------------------------- approval delegation (7.0.0) ----------------------------- */

leaveRouter.get("/delegations", requireAuth, async (req, res) => {
  await assertLeaveOn();
  const scope = req.query.scope === "all" ? "all" : "mine";
  res.json({ items: await listDelegations(actorOf(req), scope) });
});

leaveRouter.get("/delegations/candidates", requireAuth, async (req, res) => {
  await assertLeaveOn();
  const q = typeof req.query.q === "string" ? req.query.q.trim() : undefined;
  res.json({ items: await delegateCandidates(req.user!.id, q || undefined) });
});

leaveRouter.post("/delegations", requireAuth, validate(z.object({ body: delegationBody })), async (req, res) => {
  await assertLeaveOn();
  res.status(201).json(await createDelegation(actorOf(req), delegationBody.parse(req.body)));
});

leaveRouter.post("/delegations/:id/revoke", requireAuth, async (req, res) => {
  await assertLeaveOn();
  res.json(await revokeDelegation(actorOf(req), String(req.params.id)));
});

/* ----------------------------- payroll export (7.0.0) ----------------------------- */

/** ADMIN and SUPER_ADMIN: the monthly per-person report, as JSON or (format=csv) a CSV download. */
leaveRouter.get("/payroll", requireAuth, async (req, res) => {
  if (req.user!.role !== "ADMIN" && req.user!.role !== "SUPER_ADMIN") throw new AppError(403, "Only an administrator can export payroll.");
  const month = typeof req.query.month === "string" ? req.query.month : "";
  const report = await buildPayrollReport(month);
  await audit(req.user!.id, "attendance.payroll_exported", "PayrollReport", month, { month, rows: report.rows.length, format: req.query.format === "csv" ? "csv" : "json" });
  if (req.query.format === "csv") {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="payroll-${month}.csv"`);
    res.send(payrollCsv(report));
    return;
  }
  res.json(report);
});
