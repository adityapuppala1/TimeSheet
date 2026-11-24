/**
 * /api/attendance/admin — workspace configuration for Attendance & Leave (V17 A1).
 *
 * Super admin only, like every other workspace switch. Reads are allowed without the plan
 * entitlement so the settings tab can render its locked/upgrade state from real data; every WRITE
 * refuses with 403 when the plan lacks `attendanceEnabled`, and the AI-insight toggles additionally
 * need `attendanceAiInsightsEnabled`. Server-side, because a hidden button is not a gate.
 *
 * Everything here is audited under `attendance.*`, the same as sibling settings.
 */
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma.js";
import { requireAuth, requireSuperAdmin } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import { validate } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import { COUNTED_PEOPLE } from "../services/people-visibility.service.js";
import {
  AI_INSIGHT_KEYS,
  assertAttendanceEntitled,
  attendanceSettingsBody,
  calendarBody,
  getAttendanceEntitlements,
  getAttendanceSettings,
  holidayBody,
  reasonOptionBody,
  toDateOnly,
  type AttendanceSettingsInput
} from "../services/attendance-settings.service.js";

export const attendanceSettingsRouter = Router();
attendanceSettingsRouter.use(requireAuth, requireSuperAdmin);

const idParams = z.object({ id: z.string().min(1).max(64) });

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "P2002";
}

function isNotFound(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "P2025";
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

attendanceSettingsRouter.get("/settings", async (_req, res) => {
  const [settings, entitlements] = await Promise.all([getAttendanceSettings(), getAttendanceEntitlements()]);
  res.json({
    settings,
    entitlements,
    // The AND, computed server-side so the client never offers what the API would refuse.
    effective: settings.attendanceEnabled && entitlements.attendanceEnabled
  });
});

/** How many people a workspace-wide attendance change touches — the settings confirm names it. */
attendanceSettingsRouter.get("/impact", async (_req, res) => {
  res.json({ people: await prisma.user.count({ where: COUNTED_PEOPLE }) });
});

attendanceSettingsRouter.put("/settings", validate(z.object({ body: attendanceSettingsBody })), async (req, res) => {
  await assertAttendanceEntitled();
  // validate() checks but does not replace req.body, so parse again for the typed, trimmed value.
  const body: AttendanceSettingsInput = attendanceSettingsBody.parse(req.body);

  const turningOnAi = AI_INSIGHT_KEYS.some((key) => body[key] === true);
  if (turningOnAi) {
    const entitlements = await getAttendanceEntitlements();
    if (!entitlements.attendanceAiInsightsEnabled) {
      throw new AppError(403, "Attendance AI insights are not included in this plan. Upgrade to Enterprise to use them.");
    }
  }
  if (body.missedDayReasonEnabled === true && (await prisma.missedReasonOption.count({ where: { enabled: true } })) === 0) {
    throw new AppError(409, "Enable at least one missed-day reason before turning on the missed-day reason rule.");
  }
  const data = { ...body, locationConsentText: body.locationConsentText === "" ? null : body.locationConsentText };

  const updated = await prisma.globalAttendanceSettings.upsert({
    where: { id: "global" },
    update: { ...data, updatedById: req.user!.id },
    create: { id: "global", ...data, updatedById: req.user!.id }
  });
  await audit(req.user!.id, "attendance.settings_updated", "GlobalAttendanceSettings", "global", body);
  res.json(updated);
});

/* ------------------------------------------------------------------ *
 * Holiday calendars
 * ------------------------------------------------------------------ */

attendanceSettingsRouter.get("/calendars", async (_req, res) => {
  const calendars = await prisma.holidayCalendar.findMany({
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    include: { holidays: { orderBy: { date: "asc" } }, _count: { select: { users: true } } }
  });
  res.json(
    calendars.map((c) => ({
      ...c,
      holidays: c.holidays.map((h) => ({ ...h, date: toDateOnly(h.date) }))
    }))
  );
});

/**
 * At most one default calendar. MariaDB has no partial unique index, so the invariant lives here,
 * inside the same transaction as the write that would break it. The FIRST calendar becomes the
 * default automatically — a workspace with calendars but no default would quietly give unassigned
 * people no holidays at all.
 */
attendanceSettingsRouter.post("/calendars", validate(z.object({ body: calendarBody })), async (req, res) => {
  await assertAttendanceEntitled();
  const body = calendarBody.parse(req.body);
  try {
    const created = await prisma.$transaction(async (tx) => {
      const existing = await tx.holidayCalendar.count();
      const isDefault = existing === 0 ? true : Boolean(body.isDefault);
      if (isDefault) await tx.holidayCalendar.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
      return tx.holidayCalendar.create({ data: { name: body.name, description: body.description ?? null, isDefault, maxOptionalPerYear: body.maxOptionalPerYear ?? null } });
    });
    await audit(req.user!.id, "attendance.calendar_created", "HolidayCalendar", created.id, body);
    res.status(201).json(created);
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError(409, "A calendar with that name already exists.");
    throw error;
  }
});

attendanceSettingsRouter.put(
  "/calendars/:id",
  validate(z.object({ params: idParams, body: calendarBody.partial() })),
  async (req, res) => {
    await assertAttendanceEntitled();
    const id = String(req.params.id);
    const body = calendarBody.partial().parse(req.body);
    try {
      const updated = await prisma.$transaction(async (tx) => {
        if (body.isDefault === true) {
          await tx.holidayCalendar.updateMany({ where: { isDefault: true, NOT: { id } }, data: { isDefault: false } });
        }
        return tx.holidayCalendar.update({ where: { id }, data: body });
      });
      await audit(req.user!.id, "attendance.calendar_updated", "HolidayCalendar", id, body);
      res.json(updated);
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError(409, "A calendar with that name already exists.");
      if (isNotFound(error)) throw new AppError(404, "Calendar not found");
      throw error;
    }
  }
);

attendanceSettingsRouter.delete("/calendars/:id", validate(z.object({ params: idParams })), async (req, res) => {
  await assertAttendanceEntitled();
  const id = String(req.params.id);
  const calendar = await prisma.holidayCalendar.findUnique({ where: { id }, select: { isDefault: true, name: true } });
  if (!calendar) throw new AppError(404, "Calendar not found");
  // Deleting the default would leave every unassigned person with no holidays and no warning.
  if (calendar.isDefault) throw new AppError(409, "Make another calendar the default before deleting this one.");
  // Holidays cascade; assigned people fall back to the default (onDelete: SetNull).
  await prisma.holidayCalendar.delete({ where: { id } });
  await audit(req.user!.id, "attendance.calendar_deleted", "HolidayCalendar", id, { name: calendar.name });
  res.status(204).end();
});

/* ------------------------------------------------------------------ *
 * Holidays
 * ------------------------------------------------------------------ */

const calendarParams = z.object({ id: z.string().min(1).max(64) });
const holidayParams = z.object({ id: z.string().min(1).max(64), holidayId: z.string().min(1).max(64) });

attendanceSettingsRouter.post(
  "/calendars/:id/holidays",
  validate(z.object({ params: calendarParams, body: holidayBody })),
  async (req, res) => {
    await assertAttendanceEntitled();
    const calendarId = String(req.params.id);
    const body = holidayBody.parse(req.body);
    const calendar = await prisma.holidayCalendar.findUnique({ where: { id: calendarId }, select: { id: true } });
    if (!calendar) throw new AppError(404, "Calendar not found");
    try {
      const created = await prisma.holiday.create({
        data: { calendarId, date: new Date(`${body.date}T00:00:00Z`), name: body.name, isOptional: Boolean(body.isOptional) }
      });
      await audit(req.user!.id, "attendance.holiday_created", "Holiday", created.id, { calendarId, ...body });
      res.status(201).json({ ...created, date: toDateOnly(created.date) });
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError(409, "This calendar already has a holiday on that date.");
      throw error;
    }
  }
);

attendanceSettingsRouter.put(
  "/calendars/:id/holidays/:holidayId",
  validate(z.object({ params: holidayParams, body: holidayBody.partial() })),
  async (req, res) => {
    await assertAttendanceEntitled();
    const calendarId = String(req.params.id);
    const holidayId = String(req.params.holidayId);
    const body = holidayBody.partial().parse(req.body);
    // Scoped by calendar too, so a holiday id from another calendar cannot be edited through this one.
    const existing = await prisma.holiday.findFirst({ where: { id: holidayId, calendarId }, select: { id: true } });
    if (!existing) throw new AppError(404, "Holiday not found");
    try {
      const updated = await prisma.holiday.update({
        where: { id: holidayId },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.isOptional !== undefined ? { isOptional: body.isOptional } : {}),
          ...(body.date !== undefined ? { date: new Date(`${body.date}T00:00:00Z`) } : {})
        }
      });
      await audit(req.user!.id, "attendance.holiday_updated", "Holiday", holidayId, { calendarId, ...body });
      res.json({ ...updated, date: toDateOnly(updated.date) });
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError(409, "This calendar already has a holiday on that date.");
      throw error;
    }
  }
);

attendanceSettingsRouter.delete(
  "/calendars/:id/holidays/:holidayId",
  validate(z.object({ params: holidayParams })),
  async (req, res) => {
    await assertAttendanceEntitled();
    const calendarId = String(req.params.id);
    const holidayId = String(req.params.holidayId);
    const result = await prisma.holiday.deleteMany({ where: { id: holidayId, calendarId } });
    if (result.count === 0) throw new AppError(404, "Holiday not found");
    await audit(req.user!.id, "attendance.holiday_deleted", "Holiday", holidayId, { calendarId });
    res.status(204).end();
  }
);

/* ------------------------------------------------------------------ *
 * Missed-day reason options
 * ------------------------------------------------------------------ */

attendanceSettingsRouter.get("/missed-reasons", async (_req, res) => {
  res.json(await prisma.missedReasonOption.findMany({ orderBy: [{ order: "asc" }, { label: "asc" }] }));
});

attendanceSettingsRouter.post("/missed-reasons", validate(z.object({ body: reasonOptionBody })), async (req, res) => {
  await assertAttendanceEntitled();
  const body = reasonOptionBody.parse(req.body);
  try {
    const created = await prisma.missedReasonOption.create({ data: body });
    await audit(req.user!.id, "attendance.reason_created", "MissedReasonOption", created.id, body);
    res.status(201).json(created);
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError(409, "A reason with that code already exists.");
    throw error;
  }
});

/**
 * With the rule on, at least one option must stay enabled: otherwise nobody could answer the prompt
 * (missedDayReasonState fails open in that case too, but the admin should be told, not surprised).
 */
async function assertNotLastEnabledReason(id: string): Promise<void> {
  const settings = await prisma.globalAttendanceSettings.findUnique({ where: { id: "global" }, select: { missedDayReasonEnabled: true } });
  if (!settings?.missedDayReasonEnabled) return;
  const option = await prisma.missedReasonOption.findUnique({ where: { id }, select: { enabled: true } });
  if (!option?.enabled) return;
  const others = await prisma.missedReasonOption.count({ where: { enabled: true, id: { not: id } } });
  if (others === 0) {
    throw new AppError(409, "This is the last enabled reason and the missed-day reason rule is on. Enable another reason, or turn the rule off first.");
  }
}

/** `code` is deliberately not editable: MissedDayReason rows store it, so renaming it would orphan
 *  history. Change the label instead, or disable the option and add a new one. */
const reasonUpdateBody = reasonOptionBody.omit({ code: true }).partial().strict();

attendanceSettingsRouter.put(
  "/missed-reasons/:id",
  validate(z.object({ params: idParams, body: reasonUpdateBody })),
  async (req, res) => {
    await assertAttendanceEntitled();
    const id = String(req.params.id);
    const body = reasonUpdateBody.parse(req.body);
    if (body.enabled === false) await assertNotLastEnabledReason(id);
    try {
      const updated = await prisma.missedReasonOption.update({ where: { id }, data: body });
      await audit(req.user!.id, "attendance.reason_updated", "MissedReasonOption", id, body);
      res.json(updated);
    } catch (error) {
      if (isNotFound(error)) throw new AppError(404, "Reason not found");
      throw error;
    }
  }
);

attendanceSettingsRouter.delete("/missed-reasons/:id", validate(z.object({ params: idParams })), async (req, res) => {
  await assertAttendanceEntitled();
  const id = String(req.params.id);
  await assertNotLastEnabledReason(id);
  const result = await prisma.missedReasonOption.deleteMany({ where: { id } });
  if (result.count === 0) throw new AppError(404, "Reason not found");
  await audit(req.user!.id, "attendance.reason_deleted", "MissedReasonOption", id);
  res.status(204).end();
});
