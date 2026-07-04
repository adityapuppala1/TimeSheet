/**
 * Workspace-wide settings the SUPER_ADMIN configures from Workspace Settings: notification
 * channels/reminder schedule (original MVP), plus `/ticketing` (SLA hours, opt-in analytics
 * toggles) and `/ai` (master + per-feature AI toggles, model choice, budget) added for the v2
 * ticketing+AI roadmap. Each section is a singleton row (id="global") upserted on read so the
 * very first GET ever made seeds sane defaults instead of requiring a manual seed step.
 * Email-intake's own settings (IMAP connection, routing rules) live in a separate
 * email-intake.controller.ts since they involve credentials, not just booleans/numbers.
 */
import { Router } from "express";
import { z } from "zod";
import { notificationPreferenceKeys } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { serverTimezone } from "../config/env.js";
import { requireAuth, requireSuperAdmin } from "../middleware/auth.js";
import { env } from "../config/env.js";
import { validate } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import { getGlobalNotificationSettings } from "../services/notify.service.js";
import { getGlobalAISettings, getMonthlyAIUsageSummary } from "../services/ai.service.js";
import { getGlobalTicketSettings } from "../services/ticket.service.js";

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

settingsRouter.get("/ticketing", async (_req, res) => {
  res.json(await getGlobalTicketSettings());
});

const ticketingSchema = z.object({
  body: z
    .object({
      slaLowHours: z.coerce.number().int().min(1).max(2000).optional(),
      slaMediumHours: z.coerce.number().int().min(1).max(2000).optional(),
      slaHighHours: z.coerce.number().int().min(1).max(2000).optional(),
      slaCriticalHours: z.coerce.number().int().min(1).max(2000).optional(),
      enableCostAnalytics: z.boolean().optional(),
      enableLeaderboard: z.boolean().optional()
    })
    .strict()
});

settingsRouter.patch("/ticketing", requireSuperAdmin, validate(ticketingSchema), async (req, res) => {
  const data: Record<string, unknown> = { ...req.body, updatedById: req.user!.id };
  const updated = await prisma.globalTicketSettings.upsert({
    where: { id: "global" },
    update: data,
    create: { id: "global", ...data }
  });
  await audit(req.user!.id, "settings.ticketing_updated", "GlobalTicketSettings", "global", req.body);
  res.json(updated);
});

settingsRouter.get("/ai", async (_req, res) => {
  const settings = await getGlobalAISettings();
  res.json({ ...settings, apiKeyConfigured: Boolean(env.ANTHROPIC_API_KEY) });
});

settingsRouter.get("/ai/usage-summary", async (_req, res) => {
  res.json(await getMonthlyAIUsageSummary());
});

const aiSettingsSchema = z.object({
  body: z
    .object({
      aiEnabled: z.boolean().optional(),
      autoTriageEnabled: z.boolean().optional(),
      autoTriageAutoApply: z.boolean().optional(),
      duplicateDetectionEnabled: z.boolean().optional(),
      writingAssistantEnabled: z.boolean().optional(),
      commentSummaryEnabled: z.boolean().optional(),
      workspaceSearchEnabled: z.boolean().optional(),
      emailIngestionEnabled: z.boolean().optional(),
      weeklyDigestEnabled: z.boolean().optional(),
      model: z.string().min(1).max(80).optional(),
      confidenceThreshold: z.coerce.number().min(0).max(1).optional(),
      monthlyBudgetUsd: z.coerce.number().min(0).optional().nullable()
    })
    .strict()
});

settingsRouter.patch("/ai", requireSuperAdmin, validate(aiSettingsSchema), async (req, res) => {
  const data: Record<string, unknown> = { ...req.body, updatedById: req.user!.id };
  const updated = await prisma.globalAISettings.upsert({
    where: { id: "global" },
    update: data,
    create: { id: "global", ...data }
  });
  await audit(req.user!.id, "settings.ai_updated", "GlobalAISettings", "global", req.body);
  res.json(updated);
});
