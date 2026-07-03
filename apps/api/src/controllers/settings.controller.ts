import { Router } from "express";
import { z } from "zod";
import { notificationPreferenceKeys } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { serverTimezone } from "../config/env.js";
import { requireAuth, requireSuperAdmin } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import { getGlobalNotificationSettings } from "../services/notify.service.js";

export const settingsRouter = Router();
settingsRouter.use(requireAuth);

/**
 * Pack the persisted settings with read-only runtime info so the UI can show
 * one banner for "where do the reminder hours fire". serverTimezone is the
 * effective IANA zone the Node process is honouring (defaults to Asia/Kolkata).
 */
function withRuntimeMeta(settings: any) {
  const now = new Date();
  const offsetMinutes = -now.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const offsetHours = Math.floor(Math.abs(offsetMinutes) / 60).toString().padStart(2, "0");
  const offsetRemMinutes = (Math.abs(offsetMinutes) % 60).toString().padStart(2, "0");
  return {
    ...settings,
    serverTimezone,
    serverUtcOffset: `UTC${offsetSign}${offsetHours}:${offsetRemMinutes}`,
    serverNow: now.toISOString()
  };
}

settingsRouter.get("/notifications", async (_req, res) => {
  const settings = await getGlobalNotificationSettings();
  res.json(withRuntimeMeta(settings));
});

const updateSchema = z.object({
  body: z
    .object({
      ...Object.fromEntries(
        notificationPreferenceKeys.map((key) => [key, z.boolean().optional()])
      ),
      dailyReminderHour: z.coerce.number().int().min(0).max(23).optional(),
      escalationReminderHour: z.coerce.number().int().min(0).max(23).optional(),
      remindOnWeekdaysOnly: z.boolean().optional(),
      bccSuperAdminOnAllEmails: z.boolean().optional()
    })
    .strict()
});

settingsRouter.patch("/notifications", requireSuperAdmin, validate(updateSchema), async (req, res) => {
  const data: Record<string, boolean | number> = {};
  for (const key of notificationPreferenceKeys) {
    if (typeof req.body[key] === "boolean") data[key] = req.body[key];
  }
  if (typeof req.body.dailyReminderHour === "number") data.dailyReminderHour = req.body.dailyReminderHour;
  if (typeof req.body.escalationReminderHour === "number") data.escalationReminderHour = req.body.escalationReminderHour;
  if (typeof req.body.remindOnWeekdaysOnly === "boolean") data.remindOnWeekdaysOnly = req.body.remindOnWeekdaysOnly;
  if (typeof req.body.bccSuperAdminOnAllEmails === "boolean") data.bccSuperAdminOnAllEmails = req.body.bccSuperAdminOnAllEmails;

  const updated = await prisma.globalNotificationSettings.upsert({
    where: { id: "global" },
    update: { ...data, updatedById: req.user!.id },
    create: { id: "global", ...data, updatedById: req.user!.id }
  });
  await audit(req.user!.id, "settings.notifications_updated", "GlobalNotificationSettings", "global", data);
  res.json(withRuntimeMeta(updated));
});
