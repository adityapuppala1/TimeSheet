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
import { notificationPreferenceKeys, permissions, roles } from "@timesheet/shared";
import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { controlPrisma } from "../config/control-prisma.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { serverTimezone } from "../config/env.js";
import { getLoggingStatus } from "../config/logger.js";
import { describeStorageLayout, validateDirectory } from "../config/storage-paths.js";
import { requireAuth, requirePermission, requireSuperAdmin } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import { validate } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import { describeAutonomyCatalogue, setCapabilityLevel } from "../services/ai-autonomy.service.js";
import {
  assertFaceEntitlement,
  findCoveredUnenrolledUserIds,
  getFaceSettings,
  isFaceFeatureAllowedForOrg,
  notifyEnrollmentRequired
} from "../services/face.service.js";
import { getGlobalNotificationSettings } from "../services/notify.service.js";
import { getGlobalAISettings, getEnabledProviderConfigs, getAIUsageBreakdown, getAIUsageDailyDetail, getWeeklyAIUsageTrend, getAIFeatureUsage, listAvailableOpenAICompatibleModels, resolveApiKey } from "../services/ai.service.js";
import { buildAiUsageWorkbook } from "../services/ai-usage-export.service.js";
import {
  listProviderConfigs,
  createProviderConfig,
  updateProviderConfig,
  deleteProviderConfig,
  reorderProviderConfigs,
  getSuggestedProviderOrder
} from "../services/ai-provider-config.service.js";
import { getAIQualitySummary } from "../services/ai-quality.service.js";
import { getAllowedSsoProviders } from "../services/plan-limits.service.js";
import { getGlobalTicketSettings } from "../services/ticket.service.js";
import { describeMcpCatalogue, generateMcpToken, getGlobalMcpSettings, updateGlobalMcpSettings } from "../services/mcp.service.js";
import { MCP_TOOLS } from "../services/mcp-tools.js";
import { decryptSecret, encryptSecret } from "../utils/encryption.js";
import { egressUrl } from "../utils/egress.js";
import { getTransportStatus, invalidateMailTransportCache } from "../services/mail.service.js";
import { attemptWebhookDelivery, nextRetryAt, WEBHOOK_EVENTS } from "../services/webhook-dispatch.service.js";
import {
  buildGitHubAuthorizeUrl,
  listGitHubBranches,
  listGitHubPullRequests,
  listGitHubRepos,
  signGitConnectState
} from "../services/git-provider.service.js";
import crypto from "node:crypto";
import nodemailer from "nodemailer";

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

/**
 * The ONLY settings route any authenticated role may read — a deliberately tiny projection of the
 * handful of workspace flags that non-settings pages genuinely need to render correctly.
 *
 * WHY this exists: Workspace Settings is SUPER_ADMIN-only (see App.tsx's RequireRole on the
 * `settings` route), and every other GET below is `requireSuperAdmin` to match. But two ordinary
 * pages legitimately depend on a workspace flag: the ticket create-dialog needs
 * `autoTriageAutoApply` to decide whether to pre-fill an AI suggestion or show an accept chip
 * (an EMPLOYEE hits this), and Insights needs `enableCostAnalytics`/`enableLeaderboard` to know
 * whether those panels exist at all (a MANAGER/TEAM_LEAD hits this). Handing those pages the
 * whole `/ai` or `/ticketing` config object would leak model names, budgets, SLA policy and
 * provider details to every employee just to answer three booleans — so they get exactly the
 * three booleans instead.
 *
 * Keep this projection minimal on purpose: anything added here becomes readable by every role.
 */
settingsRouter.get("/effective-flags", async (_req, res) => {
  const [ai, ticketing] = await Promise.all([getGlobalAISettings(), getGlobalTicketSettings()]);
  res.json({
    autoTriageAutoApply: ai.aiEnabled && ai.autoTriageEnabled && ai.autoTriageAutoApply,
    enableCostAnalytics: ticketing.enableCostAnalytics,
    enableLeaderboard: ticketing.enableLeaderboard
  });
});

/**
 * ── STORAGE & LOG PATHS ARE ENV-ONLY, AND THAT IS A DELIBERATE SECURITY DECISION ────────────
 *
 * These two routes READ the effective filesystem layout and VALIDATE a candidate directory.
 * Neither writes a path anywhere. There is no PATCH, on purpose:
 *
 *  1. The paths are PROCESS-WIDE; SUPER_ADMIN is PER-TENANT. This deployment runs a database per
 *     organization behind one Node process, so a super admin of org A persisting a storage root
 *     would silently redirect org B's uploads — a tenant-scoped role reconfiguring a
 *     platform-scoped resource is a tenant-isolation break however carefully the path is
 *     validated.
 *  2. An arbitrary absolute path that the app then WRITES to is close to arbitrary file write
 *     scoped to whatever the service account can reach, and the static mounts turn parts of it
 *     into arbitrary file READ. Validation (absolute, no "..", exists, writable) stops mistakes;
 *     it does not stop someone who has the field and means it — `C:\inetpub\wwwroot` and
 *     `/etc/cron.d` are absolute, existing and writable.
 *  3. Compromising one super-admin account currently yields settings changes. It must not also
 *     yield a foothold on the filesystem.
 *
 * What the admin actually needs — "where are my files going right now, and is that directory
 * healthy?" — is answered in full by GET, and "will this new path work before I commit to it?"
 * by the validator, which returns the same verdict the app will reach at 3am. Applying it is one
 * .env line and a restart, which is also the only change that leaves an audit trail outside the
 * application's own database.
 */
settingsRouter.get("/storage", requireSuperAdmin, async (_req, res) => {
  res.json({ storage: describeStorageLayout(), logging: getLoggingStatus() });
});

const directoryProbeSchema = z.object({ body: z.object({ path: z.string().max(4096) }).strict() });

/**
 * Dry-run a directory the operator is considering. Audited because it is a filesystem probe
 * driven by user input: it stats a caller-supplied path and, if that succeeds, creates and
 * immediately deletes a uniquely-named probe file to establish real writability (see
 * storage-paths.ts on why fs.access is not good enough on either Windows or a read-only mount).
 * SUPER_ADMIN only, and it never reads, lists or returns directory CONTENT.
 */
settingsRouter.post("/storage/validate-directory", requireSuperAdmin, validate(directoryProbeSchema), async (req, res) => {
  const result = validateDirectory(req.body.path);
  await audit(req.user!.id, "settings.storage_path_validated", "StorageConfig", "global", {
    candidate: req.body.path,
    ok: result.ok
  });
  res.json(result.ok ? { ok: true, path: result.path } : { ok: false, message: result.message });
});

settingsRouter.get("/notifications", requireSuperAdmin, async (_req, res) => {
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
      bccSuperAdminOnAllEmails: z.boolean().optional(),
      // Per-role mute matrix. Keys are constrained to the known preference keys and values to the
      // known roles so a typo can't silently persist a mute that no UI can ever clear again —
      // this column is free-form JSON at the DB level, so this schema IS its only integrity check.
      emailRoleMutes: z
        .record(
          z.enum(notificationPreferenceKeys as unknown as [string, ...string[]]),
          z.array(z.enum(roles as unknown as [string, ...string[]]))
        )
        .optional()
    })
    .strict()
});

settingsRouter.patch("/notifications", requireSuperAdmin, validate(updateSchema), async (req, res) => {
  const data: Record<string, boolean | number | Record<string, string[]>> = {};
  for (const key of notificationPreferenceKeys) {
    if (typeof req.body[key] === "boolean") data[key] = req.body[key];
  }
  if (typeof req.body.dailyReminderHour === "number") data.dailyReminderHour = req.body.dailyReminderHour;
  if (typeof req.body.escalationReminderHour === "number") data.escalationReminderHour = req.body.escalationReminderHour;
  if (typeof req.body.remindOnWeekdaysOnly === "boolean") data.remindOnWeekdaysOnly = req.body.remindOnWeekdaysOnly;
  if (typeof req.body.bccSuperAdminOnAllEmails === "boolean") data.bccSuperAdminOnAllEmails = req.body.bccSuperAdminOnAllEmails;
  // Sent whole-object, not merged per key: the matrix UI always PATCHes the complete map, and a
  // merge would make un-ticking the last muted role for a category impossible to express.
  // Categories with an empty list are dropped so the stored JSON stays the mutes, not the grid.
  if (req.body.emailRoleMutes && typeof req.body.emailRoleMutes === "object") {
    data.emailRoleMutes = Object.fromEntries(
      Object.entries(req.body.emailRoleMutes as Record<string, string[]>).filter(([, list]) => list.length > 0)
    );
  }

  const updated = await prisma.globalNotificationSettings.upsert({
    where: { id: "global" },
    update: { ...data, updatedById: req.user!.id },
    create: { id: "global", ...data, updatedById: req.user!.id }
  });
  await audit(req.user!.id, "settings.notifications_updated", "GlobalNotificationSettings", "global", data);
  res.json(withRuntimeMeta(updated));
});

settingsRouter.get("/ticketing", requireSuperAdmin, async (_req, res) => {
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
      enableLeaderboard: z.boolean().optional(),
      blockResolveOnFailingTests: z.boolean().optional(),
      // Verified Work Attestation — see services/attestation.service.ts. NOTE: this schema is
      // `.strict()`, so a new GlobalTicketSettings field MUST be listed here or the PATCH 400s.
      defaultCurrency: z.string().length(3).optional(),
      enableAttestations: z.boolean().optional(),
      enableAttestationSharing: z.boolean().optional()
    })
    .strict()
});

settingsRouter.patch("/ticketing", requireSuperAdmin, validate(ticketingSchema), async (req, res) => {
  const data: Record<string, unknown> = { ...req.body, updatedById: req.user!.id };
  // Normalised so "usd" and "USD" can't read as two different currencies when an attestation
  // refuses to mix them.
  if (typeof data.defaultCurrency === "string") data.defaultCurrency = data.defaultCurrency.toUpperCase();
  const updated = await prisma.globalTicketSettings.upsert({
    where: { id: "global" },
    update: data,
    create: { id: "global", ...data }
  });
  await audit(req.user!.id, "settings.ticketing_updated", "GlobalTicketSettings", "global", req.body);
  res.json(updated);
});

/**
 * Ticket rules engine CRUD — see prisma/schema.prisma's TicketRule doc comment and
 * ticket.service.ts#applyTicketRules for how these evaluate. `order` controls evaluation
 * sequence (first match wins); ascending on every read so the UI can render/reorder plainly.
 */
settingsRouter.get("/ticket-rules", requireSuperAdmin, async (_req, res) => {
  const rules = await prisma.ticketRule.findMany({
    orderBy: { order: "asc" },
    include: {
      conditionProject: { select: { id: true, name: true, code: true } },
      actionAssignee: { select: { id: true, name: true } },
      actionLabel: { select: { id: true, name: true, color: true } },
      actionNotifyUser: { select: { id: true, name: true } }
    }
  });
  res.json(rules);
});

const ticketRuleSchema = z.object({
  body: z
    .object({
      name: z.string().min(1).max(120),
      isActive: z.boolean().optional(),
      order: z.coerce.number().int().min(0).optional(),
      conditionProjectId: z.string().uuid().nullable().optional(),
      conditionPriority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).nullable().optional(),
      conditionSource: z.enum(["MANUAL", "EMAIL", "API", "CHAT"]).nullable().optional(),
      conditionSenderDomain: z.string().max(255).nullable().optional(),
      actionAssigneeId: z.string().uuid().nullable().optional(),
      actionLabelId: z.string().uuid().nullable().optional(),
      actionNotifyUserId: z.string().uuid().nullable().optional()
    })
    .strict()
});

settingsRouter.post("/ticket-rules", requireSuperAdmin, validate(ticketRuleSchema), async (req, res) => {
  const rule = await prisma.ticketRule.create({ data: req.body });
  await audit(req.user!.id, "settings.ticket_rule_created", "TicketRule", rule.id, req.body);
  res.status(201).json(rule);
});

const ticketRuleUpdateSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: ticketRuleSchema.shape.body.partial()
});

settingsRouter.patch("/ticket-rules/:id", requireSuperAdmin, validate(ticketRuleUpdateSchema), async (req, res) => {
  const rule = await prisma.ticketRule.update({ where: { id: String(req.params.id) }, data: req.body });
  await audit(req.user!.id, "settings.ticket_rule_updated", "TicketRule", rule.id, req.body);
  res.json(rule);
});

settingsRouter.delete("/ticket-rules/:id", requireSuperAdmin, async (req, res) => {
  await prisma.ticketRule.delete({ where: { id: String(req.params.id) } });
  await audit(req.user!.id, "settings.ticket_rule_deleted", "TicketRule", String(req.params.id));
  res.status(204).send();
});

/**
 * BYOK: `apiKey` is write-only — a saved key is never returned, only `apiKeySet: boolean` (same
 * masking convention as EmailIntakeSettings.imapPassword) — describes the DEPRECATED singleton
 * field above, kept only as the source the provider-list migration copied from.
 *
 * `apiKeyConfigured` answers a different, still-live question — "would an AI call actually work
 * right now" — so it is computed from the PRIMARY entry in the ranked provider list (V9,
 * provider-priority) instead: `resolveApiKey` already encodes the one exception that matters,
 * ANTHROPIC with no stored key still counts as configured when the server's own
 * ANTHROPIC_API_KEY is set.
 */
settingsRouter.get("/ai", requireSuperAdmin, async (_req, res) => {
  const { apiKey, ...settings } = await getGlobalAISettings();
  const apiKeySet = Boolean(apiKey);
  const [primary] = await getEnabledProviderConfigs();
  const apiKeyConfigured = Boolean(resolveApiKey(primary));
  res.json({ ...settings, apiKeySet, apiKeyConfigured });
});

/** `?from=&to=` are ISO dates from the client's DateRangePicker; absent defaults to the current
 *  calendar month, matching what this route showed before it took a range at all. `to` is
 *  exclusive downstream, so the caller's inclusive last day is added back here — a picker showing
 *  "through Aug 25" must actually include every row written ON Aug 25. */
function parseUsageRange(req: { query: Record<string, unknown> }): { from: Date; to: Date } {
  const now = new Date();
  const from = req.query.from ? new Date(String(req.query.from)) : new Date(now.getFullYear(), now.getMonth(), 1);
  const toParam = req.query.to ? new Date(String(req.query.to)) : now;
  const to = new Date(toParam.getFullYear(), toParam.getMonth(), toParam.getDate() + 1);
  return { from, to };
}

settingsRouter.get("/ai/usage-summary", requireSuperAdmin, async (req, res) => {
  const { from, to } = parseUsageRange(req);
  const feature = req.query.feature ? String(req.query.feature) : undefined;
  res.json(await getAIUsageBreakdown({ from, to, feature }));
});

/** Per-feature AI QUALITY (as opposed to cost, above) — see services/ai-quality.service.ts for
 *  why the headline number is parse-failure rate and not thumbs-up rate. */
settingsRouter.get("/ai/quality-summary", requireSuperAdmin, async (req, res) => {
  const windowDays = Math.min(180, Math.max(1, Number(req.query.windowDays) || 30));
  res.json(await getAIQualitySummary(windowDays));
});

settingsRouter.get("/ai/usage-trend", requireSuperAdmin, async (req, res) => {
  const { from, to } = parseUsageRange(req);
  res.json(await getWeeklyAIUsageTrend({ from, to }));
});

/** The provider × model breakdown, PLUS a day × feature × provider × model detail sheet, as a real
 *  workbook — same range/feature params as usage-summary, so what somebody sees on screen is
 *  exactly what they download. No row cap: rows are bounded by this app's own AI call volume,
 *  never the thousands a ticket/change export can reach. */
settingsRouter.get("/ai/usage-export.xlsx", requireSuperAdmin, async (req, res) => {
  const { from, to } = parseUsageRange(req);
  const feature = req.query.feature ? String(req.query.feature) : undefined;
  const [breakdown, dailyRows] = await Promise.all([
    getAIUsageBreakdown({ from, to, feature }),
    getAIUsageDailyDetail({ from, to, feature })
  ]);
  const buffer = await buildAiUsageWorkbook(breakdown.rows, dailyRows, {
    generatedBy: req.user!.name,
    workspace: requireTenantContext().orgSlug,
    from: breakdown.from,
    to: breakdown.to,
    feature: feature ?? null
  });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="ai-usage-${breakdown.from}-to-${breakdown.to}.xlsx"`);
  res.setHeader("X-Export-Rows-Included", String(breakdown.rows.length + dailyRows.length));
  res.setHeader("Access-Control-Expose-Headers", "X-Export-Rows-Included, Content-Disposition");
  res.send(buffer);
});

/** Per-feature token consumption, cumulative and day by day — "what is spending the budget",
 *  as opposed to usage-summary's "what did we spend". Capped at a quarter: the response carries a
 *  row per day per feature, and a year of it would be a large payload built to be skimmed. */
settingsRouter.get("/ai/feature-usage", requireSuperAdmin, async (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
  res.json(await getAIFeatureUsage(days));
});

// Exported for the schema-vs-registry guard test: every featureToggle the capability registry
// declares MUST be accepted here, because the AI tab's per-capability switches PATCH this exact
// route with exactly those keys — and this schema is `.strict()`, so a missing key is a 400 an
// admin sees as "Unrecognized key(s)" with no obvious cause. That is not hypothetical: the
// Project-risk, Plan-breakdown and Chat-triage switches all 400'd for exactly this reason after
// the autonomy card unified the toggles.
export const aiSettingsSchema = z.object({
  body: z
    .object({
      aiEnabled: z.boolean().optional(),
      autoTriageEnabled: z.boolean().optional(),
      autoTriageAutoApply: z.boolean().optional(),
      chatIngestionEnabled: z.boolean().optional(),
      projectRiskAgentEnabled: z.boolean().optional(),
      changeRiskNarrativeEnabled: z.boolean().optional(),
      changeDraftAssistEnabled: z.boolean().optional(),
      changeConflictBriefEnabled: z.boolean().optional(),
      changePirAssistEnabled: z.boolean().optional(),
      planBreakdownEnabled: z.boolean().optional(),
      requirementsStudioEnabled: z.boolean().optional(),
      duplicateDetectionEnabled: z.boolean().optional(),
      writingAssistantEnabled: z.boolean().optional(),
      commentSummaryEnabled: z.boolean().optional(),
      workspaceSearchEnabled: z.boolean().optional(),
      emailIngestionEnabled: z.boolean().optional(),
      weeklyDigestEnabled: z.boolean().optional(),
      ciFailureTriageEnabled: z.boolean().optional(),
      aiPrReviewSummaryEnabled: z.boolean().optional(),
      findingTriageEnabled: z.boolean().optional(),
      securityWeeklyDigestEnabled: z.boolean().optional(),
      statusReportEnabled: z.boolean().optional(),
      faceReviewSummaryEnabled: z.boolean().optional(),
      facePolicyCopilotEnabled: z.boolean().optional(),
      bugPatternDigestEnabled: z.boolean().optional(),
      assigneeSuggestionAiEnabled: z.boolean().optional(),
      staleTicketNudgeEnabled: z.boolean().optional(),
      aiPrInlineReviewEnabled: z.boolean().optional(),
      emailFailureTriageEnabled: z.boolean().optional(),
      // AI quality loop — see prisma AIInteraction. NOTE: this schema is `.strict()`, so a new
      // GlobalAISettings field MUST be listed here or the PATCH 400s with no obvious cause.
      aiCaptureEnabled: z.boolean().optional(),
      aiCaptureContentEnabled: z.boolean().optional(),
      aiCaptureRetentionDays: z.coerce.number().int().min(1).max(365).optional(),
      aiEvalJudgeEnabled: z.boolean().optional(),
      // The master latch for autonomy. Per-capability levels are NOT here — they live in their own
      // table behind /settings/ai/autonomy, precisely so this `.strict()` schema does not grow a
      // field per capability. This one boolean is the exception, and it is listed here because the
      // comment above is right: leaving it out would 400 the PATCH with no obvious cause.
      aiAutonomyEnabled: z.boolean().optional(),
      model: z.string().min(1).max(80).optional(),
      confidenceThreshold: z.coerce.number().min(0).max(1).optional(),
      monthlyBudgetUsd: z.coerce.number().min(0).optional().nullable(),
      provider: z.enum(["ANTHROPIC", "OPENAI_COMPATIBLE"]).optional(),
      // SSRF-validated at save time so a bad endpoint is refused on the form rather than
      // silently failing every later model call — see utils/egress.ts. Empty string stays legal:
      // it is how the UI CLEARS a configured endpoint.
      baseUrl: egressUrl(300).or(z.literal("")).optional().nullable(),
      // Empty string means "clear the stored key" (switch back to the env var fallback); a
      // non-empty string is encrypted before it ever touches the database. Omitting the field
      // entirely leaves whatever key is already stored untouched.
      apiKey: z.string().max(2000).optional()
    })
    .strict()
});

settingsRouter.patch("/ai", requireSuperAdmin, validate(aiSettingsSchema), async (req, res) => {
  const { apiKey, ...rest } = req.body as Record<string, unknown> & { apiKey?: string };
  const data: Record<string, unknown> = { ...rest, updatedById: req.user!.id };
  if (typeof apiKey === "string") data.apiKey = apiKey.length > 0 ? encryptSecret(apiKey) : null;

  const updated = await prisma.globalAISettings.upsert({
    where: { id: "global" },
    update: data,
    create: { id: "global", ...data }
  });
  await audit(req.user!.id, "settings.ai_updated", "GlobalAISettings", "global", { ...req.body, apiKey: undefined });
  // Deliberately destructured-and-discarded: the idiomatic way to strip one field from an object
  // without hand-listing every other one. sonarjs doesn't recognize the underscore convention this
  // codebase uses for it elsewhere.
  // eslint-disable-next-line sonarjs/no-unused-vars -- rest-sibling omit pattern
  const { apiKey: _omit, ...safeUpdated } = updated;
  res.json({ ...safeUpdated, apiKeySet: Boolean(updated.apiKey) });
});

/**
 * THE RANKED PROVIDER LIST (V9, provider-priority) — replaces `provider`/`baseUrl`/`apiKey`/
 * `model` on `aiSettingsSchema` above as the actual BYOK surface. Those four fields are left in
 * place (see the schema comment on GlobalAISettings) but nothing in the current UI writes to them
 * any more; this is where a Super Admin adds, edits, reorders, and removes providers.
 *
 * Its own sub-resource for the same reason `/ai/autonomy` is: a `.strict()` PATCH schema for a
 * LIST doesn't make sense (you don't "patch" a list's shape), and this now owns credentials —
 * mixing it into the general settings PATCH would make one giant handler respond wrong to a
 * partial payload that happened to omit a provider a caller didn't mean to touch.
 */
const providerConfigBodySchema = z.object({
  provider: z.enum(["ANTHROPIC", "OPENAI_COMPATIBLE"]),
  label: z.string().max(60).optional().nullable(),
  // SSRF-validated at save time — see utils/egress.ts. Empty string/omitted both mean "no base
  // URL", matching ANTHROPIC's own default (baseUrl is meaningless for the native Messages API).
  baseUrl: egressUrl(300).or(z.literal("")).optional().nullable(),
  model: z.string().min(1).max(80),
  // Non-empty encrypts before it ever touches the database; omitted on CREATE means "no key yet"
  // (legal for a local Ollama/LM Studio, which needs none); omitted on UPDATE leaves the stored
  // key untouched, same convention as GlobalAISettings.apiKey.
  apiKey: z.string().max(2000).optional(),
  enabled: z.boolean().optional()
});

const createProviderConfigSchema = z.object({ body: providerConfigBodySchema.strict() });
settingsRouter.get("/ai/providers", requireSuperAdmin, async (_req, res) => {
  res.json(await listProviderConfigs());
});
settingsRouter.post("/ai/providers", requireSuperAdmin, validate(createProviderConfigSchema), async (req, res) => {
  res.status(201).json(await createProviderConfig(req.body, req.user!.id));
});

const updateProviderConfigSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: providerConfigBodySchema.partial().strict()
});
settingsRouter.patch("/ai/providers/:id", requireSuperAdmin, validate(updateProviderConfigSchema), async (req, res) => {
  res.json(await updateProviderConfig(String(req.params.id), req.body, req.user!.id));
});

settingsRouter.delete("/ai/providers/:id", requireSuperAdmin, async (req, res) => {
  await deleteProviderConfig(String(req.params.id), req.user!.id);
  res.status(204).end();
});

const reorderProviderConfigSchema = z.object({
  body: z.object({ orderedIds: z.array(z.string().uuid()).min(1) }).strict()
});
settingsRouter.post("/ai/providers/reorder", requireSuperAdmin, validate(reorderProviderConfigSchema), async (req, res) => {
  res.json(await reorderProviderConfigs(req.body.orderedIds, req.user!.id));
});

/** A RECOMMENDATION, not an automatic change — see getSuggestedProviderOrder's own header for why
 *  this stays a suggestion an admin applies (via the existing reorder endpoint) rather than
 *  something this route applies on its own. */
settingsRouter.get("/ai/providers/suggested-order", requireSuperAdmin, async (_req, res) => {
  res.json(await getSuggestedProviderOrder());
});

/**
 * AUTONOMY — how much authority each AI capability has, as opposed to whether it runs at all.
 *
 * Deliberately its own sub-resource rather than more fields on `aiSettingsSchema`: that schema is
 * `.strict()` and there are twenty-two capabilities, each with a level and five guardrails. Folding
 * them in would make the most-edited schema in the file grow by a field per capability shipped.
 *
 * `requireSuperAdmin` and NOT a new permission key — adding one would need idempotent backfill SQL
 * across every tenant database, for a screen only super admins can reach anyway.
 */
settingsRouter.get("/ai/autonomy", requireSuperAdmin, async (_req, res) => {
  res.json(await describeAutonomyCatalogue());
});

const autonomySchema = z.object({
  body: z
    .object({
      capability: z.string().min(1).max(60),
      level: z.enum(["SUGGEST", "AUTO_APPLY", "AUTONOMOUS"]),
      // Guardrails are only read above SUGGEST. `null` clears one back to the registry default;
      // omitting it leaves whatever is stored.
      maxChangesPerRun: z.coerce.number().int().min(1).max(200).nullable().optional(),
      maxRunsPerDay: z.coerce.number().int().min(1).max(1000).nullable().optional(),
      maxCostUsdPerRun: z.coerce.number().min(0).max(1000).nullable().optional(),
      undoWindowHours: z.coerce.number().int().min(1).max(720).nullable().optional(),
      scopeProjectIds: z.array(z.string().uuid()).nullable().optional()
    })
    .strict()
});

settingsRouter.patch("/ai/autonomy", requireSuperAdmin, validate(autonomySchema), async (req, res) => {
  const { capability, level, ...guardrails } = req.body as {
    capability: string;
    level: "SUGGEST" | "AUTO_APPLY" | "AUTONOMOUS";
  } & Record<string, unknown>;

  // setCapabilityLevel throws 404 for an unknown capability and 422 for a level above the
  // product's ceiling — the first of the two clamps. resolveAutonomy applies the same rule again
  // on read, because a bad request and a row that arrived some other way are different threats.
  const resolved = await setCapabilityLevel({
    capability,
    level,
    updatedById: req.user!.id,
    guardrails: guardrails as Parameters<typeof setCapabilityLevel>[0]["guardrails"]
  });

  await audit(req.user!.id, "settings.ai_autonomy_updated", "AiCapabilityPolicy", capability, {
    requested: level,
    effective: resolved.effectiveLevel
  }, {
    // An administrator raising what a machine may do unattended is exactly the row an auditor
    // comes looking for, so it records the transition rather than just the new value.
    before: { level: resolved.requestedLevel === level ? undefined : resolved.requestedLevel },
    after: { level, effective: resolved.effectiveLevel },
    ipAddress: req.ip
  });

  res.json(resolved);
});

const availableModelsSchema = z.object({
  body: z
    .object({
      // All optional so the settings UI can preview models against a not-yet-saved draft
      // (provider just switched, a key just typed) — same "explicit inline value, falling back
      // to what's already saved" convention as /mail/test-connection above. Anthropic is
      // deliberately not handled here: its model list is small/stable and already a fixed
      // dropdown in the UI (packages/shared's `aiModels`), not something worth a live API call.
      baseUrl: egressUrl(300).or(z.literal("")).optional(),
      apiKey: z.string().max(2000).optional()
    })
    .strict()
});

/**
 * Lists the real model ids an OpenAI-compatible endpoint serves, so the BYOK model field can be
 * a picker instead of a free-text guess. Never throws on a remote failure — an unreachable
 * endpoint, a bad key, or a provider that doesn't implement `/models` all just mean "nothing to
 * show," and the UI falls back to manual entry, exactly like /mail/test-connection's `{ ok:
 * false }` shape rather than a hard error.
 */
settingsRouter.post("/ai/available-models", requireSuperAdmin, validate(availableModelsSchema), async (req, res) => {
  const saved = await getGlobalAISettings();
  const baseUrl = req.body.baseUrl || saved.baseUrl;
  if (!baseUrl) return res.json({ ok: false, models: [], message: "No base URL configured for this provider." });

  const apiKey = typeof req.body.apiKey === "string" && req.body.apiKey.length > 0 ? req.body.apiKey : resolveApiKey(saved);

  try {
    const models = await listAvailableOpenAICompatibleModels(baseUrl, apiKey);
    res.json({ ok: true, models });
  } catch (error) {
    res.json({ ok: false, models: [], message: (error as Error).message });
  }
});

/**
 * SSO configuration (Phase B4) — lives entirely in the control-plane database (OrgSsoConfig/
 * OrgAuthMethod), not the tenant database, since it's about how people authenticate INTO this
 * org, not something the org's own tenant schema needs to know about. `clientSecretSet`
 * mirrors the same write-only-secret masking convention used everywhere else in this app
 * (GlobalAISettings.apiKey, EmailIntakeSettings.imapPassword) — the encrypted value is never
 * returned to the client, only whether one is saved.
 */
settingsRouter.get("/sso", requireSuperAdmin, async (_req, res) => {
  const { orgId } = requireTenantContext();
  const [configs, authMethod] = await Promise.all([
    controlPrisma.orgSsoConfig.findMany({ where: { organizationId: orgId } }),
    controlPrisma.orgAuthMethod.findUnique({ where: { organizationId: orgId } })
  ]);
  res.json({
    providers: configs.map((c) => ({
      provider: c.providerType,
      isEnabled: c.isEnabled,
      clientId: c.clientId,
      clientSecretSet: Boolean(c.encryptedClientSecret),
      tenantHint: c.tenantHint,
      idpEntityId: c.idpEntityId,
      idpSsoUrl: c.idpSsoUrl,
      idpCertificateSet: Boolean(c.idpCertificate),
      spEntityId: c.spEntityId,
      ldapUrl: c.ldapUrl,
      ldapBindDn: c.ldapBindDn,
      ldapBindCredentialSet: Boolean(c.encryptedLdapBindCredential),
      ldapSearchBase: c.ldapSearchBase,
      ldapUserFilter: c.ldapUserFilter,
      ldapTlsRejectUnauthorized: c.ldapTlsRejectUnauthorized
    })),
    passwordLoginEnabled: authMethod?.passwordLoginEnabled ?? true,
    requireSsoOnly: authMethod?.requireSsoOnly ?? false
  });
});

const ssoConfigSchema = z.object({
  params: z.object({ provider: z.enum(["google", "microsoft", "saml", "ldap"]) }),
  body: z
    .object({
      isEnabled: z.boolean().optional(),
      // OIDC (Google/Microsoft) fields.
      clientId: z.string().max(255).optional().nullable(),
      // Empty string clears the stored secret; omit to leave it untouched (same convention as
      // GlobalAISettings.apiKey above).
      clientSecret: z.string().max(2000).optional(),
      tenantHint: z.string().max(255).optional().nullable(),
      // SAML fields — idpCertificate is the IdP's PUBLIC signing cert, not a secret, so unlike
      // clientSecret it's stored (and can be read back as "set") without masking.
      idpEntityId: z.string().max(500).optional().nullable(),
      idpSsoUrl: z.string().max(500).url().optional().nullable(),
      idpCertificate: z.string().max(10_000).optional().nullable(),
      spEntityId: z.string().max(500).optional().nullable(),
      // LDAP fields — ldapBindCredential follows the same empty-string-clears / omit-leaves
      // convention as clientSecret above.
      ldapUrl: z.string().max(500).optional().nullable(),
      ldapBindDn: z.string().max(500).optional().nullable(),
      ldapBindCredential: z.string().max(2000).optional(),
      ldapSearchBase: z.string().max(500).optional().nullable(),
      ldapUserFilter: z.string().max(255).optional().nullable(),
      ldapTlsRejectUnauthorized: z.boolean().optional()
    })
    .strict()
});

const SSO_PROVIDER_LABEL: Record<"GOOGLE" | "MICROSOFT" | "SAML" | "LDAP", string> = {
  GOOGLE: "Google",
  MICROSOFT: "Microsoft",
  SAML: "SAML",
  LDAP: "LDAP"
};

settingsRouter.patch("/sso/:provider", requireSuperAdmin, validate(ssoConfigSchema), async (req, res) => {
  const { orgId } = requireTenantContext();
  const providerType = String(req.params.provider).toUpperCase() as "GOOGLE" | "MICROSOFT" | "SAML" | "LDAP";

  // Plan-tier enforcement (Phase B7): an org can only ENABLE a provider its tier allows —
  // editing/saving credentials for a not-yet-enabled provider is still allowed (so an org
  // mid-upgrade can stage config ahead of time), only flipping isEnabled: true is gated.
  if (req.body.isEnabled === true) {
    const allowed = await getAllowedSsoProviders(orgId);
    if (!allowed.includes(providerType)) {
      throw new AppError(403, `${SSO_PROVIDER_LABEL[providerType]} sign-in isn't available on this workspace's current plan.`);
    }
  }

  const { clientSecret, ldapBindCredential, ...rest } = req.body as Record<string, unknown> & {
    clientSecret?: string;
    ldapBindCredential?: string;
  };
  const data: Record<string, unknown> = { ...rest };
  if (typeof clientSecret === "string") data.encryptedClientSecret = clientSecret.length > 0 ? encryptSecret(clientSecret) : null;
  if (typeof ldapBindCredential === "string") data.encryptedLdapBindCredential = ldapBindCredential.length > 0 ? encryptSecret(ldapBindCredential) : null;

  const updated = await controlPrisma.orgSsoConfig.upsert({
    where: { organizationId_providerType: { organizationId: orgId, providerType } },
    update: data,
    create: { organizationId: orgId, providerType, ...data }
  });
  await audit(req.user!.id, "settings.sso_updated", "OrgSsoConfig", updated.id, { provider: providerType, ...req.body, clientSecret: undefined, ldapBindCredential: undefined });
  res.json({
    provider: updated.providerType,
    isEnabled: updated.isEnabled,
    clientId: updated.clientId,
    clientSecretSet: Boolean(updated.encryptedClientSecret),
    tenantHint: updated.tenantHint,
    idpEntityId: updated.idpEntityId,
    idpSsoUrl: updated.idpSsoUrl,
    idpCertificateSet: Boolean(updated.idpCertificate),
    spEntityId: updated.spEntityId,
    ldapUrl: updated.ldapUrl,
    ldapBindDn: updated.ldapBindDn,
    ldapBindCredentialSet: Boolean(updated.encryptedLdapBindCredential),
    ldapSearchBase: updated.ldapSearchBase,
    ldapUserFilter: updated.ldapUserFilter,
    ldapTlsRejectUnauthorized: updated.ldapTlsRejectUnauthorized
  });
});

const authMethodSchema = z.object({
  body: z.object({ passwordLoginEnabled: z.boolean().optional(), requireSsoOnly: z.boolean().optional() }).strict()
});

settingsRouter.patch("/auth-method", requireSuperAdmin, validate(authMethodSchema), async (req, res) => {
  const { orgId } = requireTenantContext();
  const updated = await controlPrisma.orgAuthMethod.upsert({
    where: { organizationId: orgId },
    update: req.body,
    create: { organizationId: orgId, ...req.body }
  });
  await audit(req.user!.id, "settings.auth_method_updated", "OrgAuthMethod", updated.id, req.body);
  res.json({ passwordLoginEnabled: updated.passwordLoginEnabled, requireSsoOnly: updated.requireSsoOnly });
});

/**
 * Security/CI ingestion (docs/ROADMAP.md's "Security assessment suite") — the bearer token
 * controllers/devops-webhook.controller.ts checks on every POST to /api/devops/:orgSlug/*.
 * Same write-only-secret convention as GlobalAISettings.apiKey/EmailIntakeSettings.imapPassword:
 * the plaintext is shown to the admin exactly once (right after generating/rotating it) and
 * never again — only `tokenSet: boolean` comes back from GET.
 */
settingsRouter.get("/security-ingestion", requireSuperAdmin, async (_req, res) => {
  const { orgSlug } = requireTenantContext();
  const settings = await prisma.ingestionSettings.findUnique({ where: { id: "global" } });
  res.json({
    tokenSet: Boolean(settings?.encryptedToken),
    orgSlug,
    findingsWebhookPath: `/api/devops/${orgSlug}/findings`,
    testRunsWebhookPath: `/api/devops/${orgSlug}/test-runs`,
    fallbackProjectId: settings?.fallbackProjectId ?? null,
    autoReopenEnabled: settings?.autoReopenEnabled ?? false,
    codeownersAssignEnabled: settings?.codeownersAssignEnabled ?? false,
    autoCreateTicketOnCiFailureEnabled: settings?.autoCreateTicketOnCiFailureEnabled ?? false,
    sarifFindingsWebhookPath: `/api/devops/${orgSlug}/findings/sarif`,
    sbomWebhookPath: `/api/devops/${orgSlug}/sbom`,
    errorEventsWebhookPath: `/api/devops/${orgSlug}/error-events`
  });
});

const ingestionFallbackProjectSchema = z.object({
  body: z.object({ fallbackProjectId: z.string().uuid().nullable() }).strict()
});

/** A CRITICAL/HIGH finding with no explicit ticketKey auto-creates a ticket here — see
 *  services/security-report.service.ts#maybeAutoCreateTicketForFinding. Null disables
 *  auto-ticket-creation entirely (findings are still stored, just never turned into tickets). */
settingsRouter.patch("/security-ingestion/fallback-project", requireSuperAdmin, validate(ingestionFallbackProjectSchema), async (req, res) => {
  const updated = await prisma.ingestionSettings.upsert({
    where: { id: "global" },
    update: { fallbackProjectId: req.body.fallbackProjectId },
    create: { id: "global", fallbackProjectId: req.body.fallbackProjectId }
  });
  await audit(req.user!.id, "settings.security_ingestion_fallback_project_updated", "IngestionSettings", "global", { fallbackProjectId: req.body.fallbackProjectId });
  res.json({ fallbackProjectId: updated.fallbackProjectId });
});

const autoReopenSchema = z.object({
  body: z.object({ autoReopenEnabled: z.boolean() }).strict()
});

/** See services/security-report.service.ts#maybeReopenTicketOnRegression — deterministic
 *  (matches on a CI-supplied ticketKey), off by default, its own explicit opt-in. */
settingsRouter.patch("/security-ingestion/auto-reopen", requireSuperAdmin, validate(autoReopenSchema), async (req, res) => {
  const updated = await prisma.ingestionSettings.upsert({
    where: { id: "global" },
    update: { autoReopenEnabled: req.body.autoReopenEnabled },
    create: { id: "global", autoReopenEnabled: req.body.autoReopenEnabled }
  });
  await audit(req.user!.id, "settings.security_ingestion_auto_reopen_updated", "IngestionSettings", "global", { autoReopenEnabled: req.body.autoReopenEnabled });
  res.json({ autoReopenEnabled: updated.autoReopenEnabled });
});

const codeownersAssignSchema = z.object({
  body: z.object({ codeownersAssignEnabled: z.boolean() }).strict()
});

/** See services/security-report.service.ts#maybeAssignFindingViaCodeowners — fallback assignee
 *  resolution (CODEOWNERS, then last committer) for an auto-created security ticket when no
 *  ModuleAssigneeRule matches. Needs a connected GitConnection and at least one
 *  User.githubUsername set to ever actually resolve anyone — off by default. */
settingsRouter.patch("/security-ingestion/codeowners-assign", requireSuperAdmin, validate(codeownersAssignSchema), async (req, res) => {
  const updated = await prisma.ingestionSettings.upsert({
    where: { id: "global" },
    update: { codeownersAssignEnabled: req.body.codeownersAssignEnabled },
    create: { id: "global", codeownersAssignEnabled: req.body.codeownersAssignEnabled }
  });
  await audit(req.user!.id, "settings.security_ingestion_codeowners_assign_updated", "IngestionSettings", "global", {
    codeownersAssignEnabled: req.body.codeownersAssignEnabled
  });
  res.json({ codeownersAssignEnabled: updated.codeownersAssignEnabled });
});

const autoCreateTicketOnCiFailureSchema = z.object({
  body: z.object({ autoCreateTicketOnCiFailureEnabled: z.boolean() }).strict()
});

/** See services/security-report.service.ts#maybeAutoCreateTicketForCiFailure — a FAILED test run
 *  with no ticket reference at all auto-creates one, with a flaky-test dedup guard. Off by
 *  default, same posture as autoReopenEnabled above. */
settingsRouter.patch(
  "/security-ingestion/auto-create-ticket-on-ci-failure",
  requireSuperAdmin,
  validate(autoCreateTicketOnCiFailureSchema),
  async (req, res) => {
    const updated = await prisma.ingestionSettings.upsert({
      where: { id: "global" },
      update: { autoCreateTicketOnCiFailureEnabled: req.body.autoCreateTicketOnCiFailureEnabled },
      create: { id: "global", autoCreateTicketOnCiFailureEnabled: req.body.autoCreateTicketOnCiFailureEnabled }
    });
    await audit(req.user!.id, "settings.security_ingestion_auto_create_ticket_on_ci_failure_updated", "IngestionSettings", "global", {
      autoCreateTicketOnCiFailureEnabled: req.body.autoCreateTicketOnCiFailureEnabled
    });
    res.json({ autoCreateTicketOnCiFailureEnabled: updated.autoCreateTicketOnCiFailureEnabled });
  }
);

const vaptFindingSchema = z.object({
  title: z.string().min(1).max(255),
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  description: z.string().max(20000).optional(),
  cwe: z.string().max(40).optional(),
  filePath: z.string().max(500).optional(),
  lineNumber: z.coerce.number().int().positive().optional(),
  ticketKey: z.string().max(20).optional()
});

const vaptReportSchema = z.object({
  body: z.object({
    // Free text identifying who/what ran the assessment (a named consultant, a pentest firm,
    // an internal red-team exercise) — stored as SecurityFinding.tool, same field the CI
    // ingestion path uses for "semgrep"/"gitleaks"/etc., so a VAPT finding renders in the
    // ticket Security tab / PDF report identically to an automated one.
    assessor: z.string().min(1).max(120),
    findings: z.array(vaptFindingSchema).min(1).max(500)
  })
});

/**
 * VAPT (Vulnerability Assessment & Penetration Testing) is the one security-assessment type
 * that never arrives through the CI ingestion webhook (devops-webhook.controller.ts) — it's a
 * periodic, human-led assessment, not a per-push automated scan (see
 * docs/SECURITY_DEVOPS_INTEGRATIONS.md §4). An admin uploads its findings here as structured
 * JSON (exported/converted from whatever the assessor delivered — a PDF report itself isn't
 * parsed, since extracting structured findings from an arbitrary PDF layout is unreliable
 * without a fixed template) — created rows land in the exact same `SecurityFinding` table as
 * the automated types, so the per-ticket report/PDF/digest render them identically.
 */
settingsRouter.post("/security-ingestion/vapt-report", requireSuperAdmin, validate(vaptReportSchema), async (req, res) => {
  const { assessor, findings } = req.body as z.infer<typeof vaptReportSchema>["body"];

  let ticketAttached = 0;
  const created = await Promise.all(
    findings.map(async (f) => {
      let ticketId: string | null = null;
      if (f.ticketKey) {
        const ticket = await prisma.ticket.findFirst({
          where: { deletedAt: null, key: f.ticketKey.toUpperCase() },
          select: { id: true }
        });
        ticketId = ticket?.id ?? null;
        if (ticketId) ticketAttached += 1;
      }
      return prisma.securityFinding.create({
        data: {
          ticketId,
          type: "VAPT",
          tool: assessor,
          severity: f.severity,
          title: f.title,
          description: f.description,
          cwe: f.cwe,
          filePath: f.filePath,
          lineNumber: f.lineNumber
        }
      });
    })
  );

  await audit(req.user!.id, "settings.vapt_report_uploaded", "SecurityFinding", undefined, {
    assessor,
    count: created.length,
    ticketAttached
  });
  res.status(201).json({ created: created.length, ticketAttached });
});

settingsRouter.post("/security-ingestion/rotate-token", requireSuperAdmin, async (req, res) => {
  const token = crypto.randomBytes(32).toString("hex");
  await prisma.ingestionSettings.upsert({
    where: { id: "global" },
    update: { encryptedToken: encryptSecret(token) },
    create: { id: "global", encryptedToken: encryptSecret(token) }
  });
  await audit(req.user!.id, "settings.security_ingestion_token_rotated", "IngestionSettings", "global");
  // The only response across this whole app that ever returns a secret in plaintext — by
  // design, this is the one moment the admin can see it; GET above only ever reports
  // tokenSet: true afterward. Rotating invalidates whatever CI/scanner config used the old
  // token, same trade-off as rotating any other webhook secret in this app.
  res.json({ token });
});

settingsRouter.delete("/security-ingestion/token", requireSuperAdmin, async (req, res) => {
  await prisma.ingestionSettings.upsert({
    where: { id: "global" },
    update: { encryptedToken: null },
    create: { id: "global", encryptedToken: null }
  });
  await audit(req.user!.id, "settings.security_ingestion_disabled", "IngestionSettings", "global");
  res.status(204).send();
});

/**
 * Inbound SCIM 2.0 provisioning — same GET-status/rotate-token/delete-token shape as
 * security-ingestion above, targeting ScimSettings instead of IngestionSettings. See
 * scim.controller.ts for the actual /Users endpoints an IdP calls with this token.
 */
settingsRouter.get("/scim", requireSuperAdmin, async (_req, res) => {
  const { orgSlug } = requireTenantContext();
  const settings = await prisma.scimSettings.findUnique({ where: { id: "global" } });
  res.json({
    tokenSet: Boolean(settings?.encryptedToken),
    isEnabled: settings?.isEnabled ?? false,
    baseUrl: `/api/scim/${orgSlug}/v2`
  });
});

const scimEnabledSchema = z.object({ body: z.object({ isEnabled: z.boolean() }).strict() });

settingsRouter.patch("/scim/enabled", requireSuperAdmin, validate(scimEnabledSchema), async (req, res) => {
  const updated = await prisma.scimSettings.upsert({
    where: { id: "global" },
    update: { isEnabled: req.body.isEnabled },
    create: { id: "global", isEnabled: req.body.isEnabled }
  });
  await audit(req.user!.id, "settings.scim_enabled_updated", "ScimSettings", "global", { isEnabled: req.body.isEnabled });
  res.json({ isEnabled: updated.isEnabled });
});

settingsRouter.post("/scim/rotate-token", requireSuperAdmin, async (req, res) => {
  const token = crypto.randomBytes(32).toString("hex");
  await prisma.scimSettings.upsert({
    where: { id: "global" },
    update: { encryptedToken: encryptSecret(token) },
    create: { id: "global", encryptedToken: encryptSecret(token) }
  });
  await audit(req.user!.id, "settings.scim_token_rotated", "ScimSettings", "global");
  // Same one-time-plaintext-reveal trade-off as /security-ingestion/rotate-token above.
  res.json({ token });
});

settingsRouter.delete("/scim/token", requireSuperAdmin, async (req, res) => {
  await prisma.scimSettings.upsert({
    where: { id: "global" },
    update: { encryptedToken: null, isEnabled: false },
    create: { id: "global", encryptedToken: null, isEnabled: false }
  });
  await audit(req.user!.id, "settings.scim_disabled", "ScimSettings", "global");
  res.status(204).send();
});

/**
 * Outbound SMTP ("Mail server") — same masked-secret pattern as email-intake.controller.ts's
 * IMAP settings (GET returns `passwordSet: boolean`, never the plaintext; PATCH only overwrites
 * the password when a non-empty string is sent). See services/mail.service.ts's header comment
 * for how this relates to the .env SMTP_* fallback and the transport cache invalidation below.
 */
function serializeMailSettings(settings: { password: string | null; [key: string]: unknown }) {
  const { password, ...rest } = settings;
  return { ...rest, passwordSet: Boolean(password) };
}

settingsRouter.get("/mail", requireSuperAdmin, async (_req, res) => {
  const settings = await prisma.globalMailSettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" }
  });
  res.json(serializeMailSettings(settings));
});

settingsRouter.get("/mail/transport-status", requireSuperAdmin, async (_req, res) => {
  res.json(await getTransportStatus());
});

const mailSettingsSchema = z.object({
  body: z
    .object({
      host: z.string().max(255).optional().nullable(),
      port: z.coerce.number().int().min(1).max(65535).optional(),
      secure: z.boolean().optional(),
      user: z.string().max(255).optional().nullable(),
      // Empty string clears the stored password (falls back to no-auth or the .env password,
      // same convention as EmailIntakeSettings.imapPassword); omit to leave it untouched.
      password: z.string().max(500).optional(),
      fromAddress: z.string().max(255).optional().nullable(),
      // Throttle. The bounds mirror `THROTTLE_BOUNDS` in mail.service.ts, which clamps whatever
      // is stored anyway — validating here means the admin gets told, rather than silently
      // getting a different number than the one they typed.
      maxConnections: z.coerce.number().int().min(1).max(20).optional(),
      maxMessagesPerWindow: z.coerce.number().int().min(1).max(5000).optional(),
      rateWindowMs: z.coerce.number().int().min(1000).max(3_600_000).optional()
    })
    .strict()
});

settingsRouter.patch("/mail", requireSuperAdmin, validate(mailSettingsSchema), async (req, res) => {
  const data: Record<string, unknown> = { updatedById: req.user!.id };
  if ("host" in req.body) data.host = req.body.host || null;
  if (typeof req.body.port === "number") data.port = req.body.port;
  if (typeof req.body.secure === "boolean") data.secure = req.body.secure;
  if ("user" in req.body) data.user = req.body.user || null;
  if (typeof req.body.password === "string") data.password = req.body.password.length > 0 ? encryptSecret(req.body.password) : null;
  if ("fromAddress" in req.body) data.fromAddress = req.body.fromAddress || null;
  if (typeof req.body.maxConnections === "number") data.maxConnections = req.body.maxConnections;
  if (typeof req.body.maxMessagesPerWindow === "number") data.maxMessagesPerWindow = req.body.maxMessagesPerWindow;
  if (typeof req.body.rateWindowMs === "number") data.rateWindowMs = req.body.rateWindowMs;

  const updated = await prisma.globalMailSettings.upsert({
    where: { id: "global" },
    update: data,
    create: { id: "global", ...data }
  });
  invalidateMailTransportCache();
  await audit(req.user!.id, "settings.mail_updated", "GlobalMailSettings", "global", { ...req.body, password: undefined });
  res.json(serializeMailSettings(updated));
});

const mailTestConnectionSchema = z.object({
  body: z.object({
    host: z.string().min(1).optional(),
    port: z.coerce.number().int().min(1).max(65535).optional(),
    secure: z.boolean().optional(),
    user: z.string().min(1).optional(),
    password: z.string().min(1).optional()
  })
});

settingsRouter.post("/mail/test-connection", requireSuperAdmin, validate(mailTestConnectionSchema), async (req, res) => {
  const saved = await prisma.globalMailSettings.findUnique({ where: { id: "global" } });
  const host = req.body.host || saved?.host;
  const port = req.body.port ?? saved?.port ?? 587;
  const secure = req.body.secure ?? saved?.secure ?? false;
  const user = req.body.user || saved?.user || undefined;
  let password = req.body.password;
  if (!password && saved?.password) {
    try {
      password = decryptSecret(saved.password);
    } catch {
      throw new AppError(422, "The saved password can't be read — re-enter it below and try again.");
    }
  }

  if (!host) throw new AppError(422, "Host is required to test the connection.");

  try {
    const transport = nodemailer.createTransport({ host, port, secure, auth: user ? { user, pass: password } : undefined });
    await transport.verify();
    res.json({ ok: true, message: `Connected to ${host}:${port}.` });
  } catch (error) {
    res.json({ ok: false, message: (error as Error).message });
  }
});

// ---------- Public API keys & outbound webhooks ----------
// See docs/ROADMAP.md's "Public REST API + outbound webhooks" theme, controllers/
// public-api.controller.ts (the API keys authenticate against), and services/
// webhook-dispatch.service.ts (what the webhooks receive). Admin-only, same as every other
// settings surface in this file.

settingsRouter.get("/api-keys", requireSuperAdmin, async (_req, res) => {
  const keys = await prisma.apiKey.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      keyPrefix: true,
      scope: true,
      lastUsedAt: true,
      createdAt: true,
      revokedAt: true,
      expiresAt: true,
      createdBy: { select: { id: true, name: true } }
    }
  });
  res.json(keys);
});

/**
 * Reads an optional `expiresAt` off a request body as a real `Date`, refusing one already past.
 *
 * WHY THIS EXISTS RATHER THAN AN INLINE COMPARISON (a real, previously-shipping bug — do not
 * inline this again): `middleware/validate.ts` runs `schema.parse({ body, params, query })` and
 * DISCARDS the result. Zod's `z.coerce.date()` therefore validates the value but never writes the
 * coerced Date back, so `req.body.expiresAt` is still the raw ISO **string** in the handler.
 *
 * `"2020-01-01T00:00:00.000Z" <= new Date()` then does not compare dates at all: a relational
 * operator takes the Date with hint "number" (a timestamp) and coerces the string to `NaN`, and
 * every comparison involving NaN is false. The guard was dead code that always passed — which is
 * how a key could be created already expired. It then authenticates nothing, and the admin debugs
 * their integration instead of their typo.
 *
 * Returns `null` for "not supplied", which is what both callers store to mean "never expires".
 */
export function parseOptionalExpiry(value: unknown): Date | null {
  if (value === undefined || value === null || value === "") return null;
  const when = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(when.getTime())) throw new AppError(422, "That expiry isn't a valid date.");
  if (when <= new Date()) throw new AppError(422, "That expiry is already in the past.");
  return when;
}

const createApiKeySchema = z.object({
  body: z
    .object({
      name: z.string().min(1).max(120),
      scope: z.enum(["READ", "WRITE"]).default("READ"),
      /** Absolute expiry. Omitted means it never expires, which is the pre-existing behaviour and
       *  what every key issued before this field existed does — same shape and same reasoning as
       *  the MCP credential's `expiresAt` below. */
      expiresAt: z.coerce.date().optional()
    })
    .strict()
});

settingsRouter.post("/api-keys", requireSuperAdmin, validate(createApiKeySchema), async (req, res) => {
  // Refused, not silently dropped: a key created already-expired would authenticate nothing, and
  // the admin would debug their integration rather than their typo. See `parseOptionalExpiry` for
  // why this cannot be an inline comparison against `req.body.expiresAt`.
  const keyExpiresAt = parseOptionalExpiry(req.body.expiresAt);

  const plaintext = `tsk_${crypto.randomBytes(24).toString("hex")}`;
  const keyHash = crypto.createHash("sha256").update(plaintext).digest("hex");
  const created = await prisma.apiKey.create({
    data: {
      name: req.body.name,
      scope: req.body.scope,
      keyHash,
      keyPrefix: plaintext.slice(0, 12),
      createdById: req.user!.id,
      expiresAt: keyExpiresAt
    }
  });
  await audit(req.user!.id, "settings.api_key_created", "ApiKey", created.id, {
    name: created.name,
    scope: created.scope,
    expiresAt: created.expiresAt
  });
  // Same one-time-plaintext-reveal pattern as /security-ingestion/rotate-token above — this
  // response is the only place the full key is ever visible again.
  res.status(201).json({ id: created.id, name: created.name, scope: created.scope, expiresAt: created.expiresAt, key: plaintext });
});

settingsRouter.delete("/api-keys/:id", requireSuperAdmin, async (req, res) => {
  const existing = await prisma.apiKey.findUnique({ where: { id: String(req.params.id) } });
  if (!existing) throw new AppError(404, "API key not found");
  await prisma.apiKey.update({ where: { id: existing.id }, data: { revokedAt: new Date() } });
  await audit(req.user!.id, "settings.api_key_revoked", "ApiKey", existing.id, { name: existing.name });
  res.status(204).send();
});

// ---------- MCP server ----------
// The admin surface for controllers/mcp.controller.ts. Super-admin only, like every other
// credential-issuing surface in this file — but the stakes are higher here than for an API key,
// because an MCP credential acts AS a named person and the thing holding it is a language model
// reading text this workspace ingests from strangers. See prisma/schema.prisma#GlobalMcpSettings
// for why every default is the closed one.

settingsRouter.get("/mcp", requireSuperAdmin, async (_req, res) => {
  const settings = await getGlobalMcpSettings();
  const credentials = await prisma.mcpCredential.findMany({
    where: { revokedAt: null },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      tokenPrefix: true,
      lastUsedAt: true,
      createdAt: true,
      // So the list can say what a credential is limited to. A narrowed credential that looks
      // identical to an unrestricted one in the UI is a narrowing nobody trusts.
      allowedTools: true,
      expiresAt: true,
      user: { select: { id: true, name: true, email: true, role: { select: { name: true } } } },
      createdBy: { select: { name: true } }
    }
  });
  res.json({
    enabled: settings.enabled,
    allowWrites: settings.allowWrites,
    updatedAt: settings.updatedAt,
    tools: describeMcpCatalogue(settings),
    credentials: credentials.map((c) => ({
      id: c.id,
      name: c.name,
      tokenPrefix: c.tokenPrefix,
      lastUsedAt: c.lastUsedAt,
      createdAt: c.createdAt,
      actingAs: { id: c.user.id, name: c.user.name, email: c.user.email, role: c.user.role.name },
      createdBy: c.createdBy?.name ?? null,
      // Null means "whatever the workspace allows". The UI needs to be able to tell the two
      // apart — a narrowed credential that looks unrestricted is a narrowing nobody trusts.
      allowedTools: Array.isArray(c.allowedTools) ? (c.allowedTools as string[]) : null,
      expiresAt: c.expiresAt
    }))
  });
});

const updateMcpSchema = z.object({
  body: z.object({
    enabled: z.boolean().optional(),
    allowWrites: z.boolean().optional(),
    /// `{ "<tool name>": true | false }`. Only names the server actually publishes are accepted —
    /// a typo silently persisting as a key nobody reads would look exactly like a tool that
    /// refuses to turn on.
    toolOverrides: z.record(z.string(), z.boolean()).optional()
  })
});

settingsRouter.patch("/mcp", requireSuperAdmin, validate(updateMcpSchema), async (req, res) => {
  const overrides = req.body.toolOverrides as Record<string, boolean> | undefined;
  if (overrides) {
    const known = new Set(MCP_TOOLS.map((t) => t.name));
    const unknown = Object.keys(overrides).filter((name) => !known.has(name));
    if (unknown.length) throw new AppError(422, `Unknown MCP tool(s): ${unknown.join(", ")}`);
  }
  const settings = await updateGlobalMcpSettings(req.user!.id, {
    enabled: req.body.enabled,
    allowWrites: req.body.allowWrites,
    toolOverrides: overrides
  });
  await audit(req.user!.id, "settings.mcp_updated", "GlobalMcpSettings", "global", {
    enabled: settings.enabled,
    allowWrites: settings.allowWrites,
    toolOverrides: overrides
  });
  res.json({
    enabled: settings.enabled,
    allowWrites: settings.allowWrites,
    updatedAt: settings.updatedAt,
    tools: describeMcpCatalogue(settings)
  });
});

const createMcpCredentialSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(120),
    userId: z.string().uuid(),
    /** Tool names this credential may call. Omitted or empty means "whatever the workspace
     *  allows", which is what every credential issued before this existed does. It can only
     *  narrow — see services/mcp.service.ts#narrowEnablementToCredential. */
    allowedTools: z.array(z.string().max(60)).optional(),
    /** Absolute expiry. Omitted means it never expires, which is the pre-existing behaviour. */
    expiresAt: z.coerce.date().optional()
  })
});

settingsRouter.post("/mcp/credentials", requireSuperAdmin, validate(createMcpCredentialSchema), async (req, res) => {
  // The bound user must be a real, live account in THIS workspace — the whole security model is
  // that the credential's authority is that person's authority, which is meaningless if they are
  // deactivated or belong somewhere else.
  const target = await prisma.user.findFirst({
    where: { id: req.body.userId, deletedAt: null, status: "ACTIVE" },
    select: { id: true, name: true, email: true, role: { select: { name: true } } }
  });
  if (!target) throw new AppError(422, "Pick an active user in this workspace for the credential to act as.");

  // Refused rather than silently dropped: a super admin who mistypes a tool name should find out
  // now, not when the assistant reports that a tool they thought they had granted does not exist.
  const requestedTools = (req.body.allowedTools as string[] | undefined)?.filter(Boolean) ?? [];
  if (requestedTools.length) {
    const known = new Set(MCP_TOOLS.map((t) => t.name));
    const unknown = requestedTools.filter((n) => !known.has(n));
    if (unknown.length) throw new AppError(422, `Unknown MCP tool(s): ${unknown.join(", ")}`);
  }
  // Was the same dead comparison as the API-key route above — see `parseOptionalExpiry`. This one
  // PRE-DATES the API-key expiry work; fixed here because the two must not disagree about what an
  // expiry means, and because an MCP credential minted already-expired is the worse of the two
  // failures: it acts as a named person, so its silence looks like a permissions problem.
  const mcpExpiresAt = parseOptionalExpiry(req.body.expiresAt);

  const { plaintext, tokenHash, tokenPrefix } = generateMcpToken();
  const created = await prisma.mcpCredential.create({
    data: {
      name: req.body.name,
      tokenHash,
      tokenPrefix,
      userId: target.id,
      createdById: req.user!.id,
      allowedTools: requestedTools.length ? requestedTools : Prisma.DbNull,
      expiresAt: mcpExpiresAt
    }
  });
  await audit(req.user!.id, "settings.mcp_credential_created", "McpCredential", created.id, {
    name: created.name,
    actingAsUserId: target.id,
    actingAsRole: target.role.name,
    // What it was NARROWED to is the interesting half of this row — "acts as an admin" and "acts
    // as an admin but may only read tickets" are very different grants.
    allowedTools: requestedTools.length ? requestedTools : "all",
    expiresAt: created.expiresAt
  }, { ipAddress: req.ip });
  // Same one-time-plaintext-reveal convention as the API key above — this response is the only
  // place the full token is ever visible.
  res.status(201).json({
    id: created.id,
    name: created.name,
    token: plaintext,
    actingAs: { id: target.id, name: target.name, email: target.email, role: target.role.name },
    allowedTools: requestedTools.length ? requestedTools : null,
    expiresAt: created.expiresAt
  });
});

settingsRouter.delete("/mcp/credentials/:id", requireSuperAdmin, async (req, res) => {
  const existing = await prisma.mcpCredential.findUnique({ where: { id: String(req.params.id) } });
  if (!existing) throw new AppError(404, "MCP credential not found");
  await prisma.mcpCredential.update({ where: { id: existing.id }, data: { revokedAt: new Date() } });
  await audit(req.user!.id, "settings.mcp_credential_revoked", "McpCredential", existing.id, { name: existing.name });
  res.status(204).send();
});

settingsRouter.get("/webhooks", requireSuperAdmin, async (_req, res) => {
  const webhooks = await prisma.outboundWebhook.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      url: true,
      events: true,
      isActive: true,
      lastDeliveryAt: true,
      lastDeliveryStatus: true,
      createdAt: true,
      createdBy: { select: { id: true, name: true } }
    }
  });
  res.json(webhooks);
});

const createWebhookSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(120),
    // `egressUrl` rather than `z.string().url()`: the latter accepts file://, http://localhost
    // and http://169.254.169.254 alike, which is how this field became an SSRF surface. 500 to
    // match the OutboundWebhook.url column, so an over-long URL is refused here instead of
    // truncating at the INSERT.
    url: egressUrl(500),
    events: z.array(z.enum(WEBHOOK_EVENTS)).min(1)
  })
});

settingsRouter.post("/webhooks", requireSuperAdmin, validate(createWebhookSchema), async (req, res) => {
  const secret = crypto.randomBytes(32).toString("hex");
  const created = await prisma.outboundWebhook.create({
    data: { name: req.body.name, url: req.body.url, events: req.body.events, secret, createdById: req.user!.id }
  });
  await audit(req.user!.id, "settings.webhook_created", "OutboundWebhook", created.id, { name: created.name, url: created.url });
  // Same one-time-reveal as API keys above — the signing secret is needed once, to configure
  // HMAC verification on the receiving end (see docs/API.md's "Public API" section).
  res.status(201).json({ id: created.id, name: created.name, url: created.url, events: created.events, secret });
});

const updateWebhookSchema = z.object({
  body: z.object({ isActive: z.boolean().optional(), events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).optional() }).strict()
});

settingsRouter.patch("/webhooks/:id", requireSuperAdmin, validate(updateWebhookSchema), async (req, res) => {
  const existing = await prisma.outboundWebhook.findUnique({ where: { id: String(req.params.id) } });
  if (!existing) throw new AppError(404, "Webhook not found");
  const updated = await prisma.outboundWebhook.update({ where: { id: existing.id }, data: req.body });
  await audit(req.user!.id, "settings.webhook_updated", "OutboundWebhook", existing.id, req.body);
  res.json({ id: updated.id, name: updated.name, url: updated.url, events: updated.events, isActive: updated.isActive });
});

settingsRouter.delete("/webhooks/:id", requireSuperAdmin, async (req, res) => {
  const existing = await prisma.outboundWebhook.findUnique({ where: { id: String(req.params.id) } });
  if (!existing) throw new AppError(404, "Webhook not found");
  await prisma.outboundWebhook.delete({ where: { id: existing.id } });
  await audit(req.user!.id, "settings.webhook_deleted", "OutboundWebhook", existing.id, { name: existing.name });
  res.status(204).send();
});

/** Recent non-delivered attempts (pending retry, or exhausted) — see
 *  workers/webhook-retry.worker.ts and webhook-dispatch.service.ts for the retry mechanism this
 *  surfaces. A successfully-delivered attempt never needed a row here in the first place. */
settingsRouter.get("/webhooks/:id/deliveries", requireSuperAdmin, async (req, res) => {
  const webhook = await prisma.outboundWebhook.findUnique({ where: { id: String(req.params.id) } });
  if (!webhook) throw new AppError(404, "Webhook not found");
  const deliveries = await prisma.webhookDelivery.findMany({
    where: { webhookId: webhook.id, status: { in: ["pending", "exhausted"] } },
    orderBy: { createdAt: "desc" },
    take: 50
  });
  res.json(deliveries);
});

/** Manual retry — for an admin who doesn't want to wait for the next 5-minute sweep, or for a
 *  delivery that already exhausted its automatic attempts (this resets the attempt count, since
 *  a human retrying implies they believe the receiving end is fixed now). */
settingsRouter.post("/webhooks/:id/deliveries/:deliveryId/retry", requireSuperAdmin, async (req, res) => {
  const webhook = await prisma.outboundWebhook.findUnique({ where: { id: String(req.params.id) } });
  if (!webhook) throw new AppError(404, "Webhook not found");
  const delivery = await prisma.webhookDelivery.findFirst({ where: { id: String(req.params.deliveryId), webhookId: webhook.id } });
  if (!delivery) throw new AppError(404, "Delivery not found");

  const body = JSON.stringify(delivery.payload);
  const outcome = await attemptWebhookDelivery(webhook.url, webhook.secret, delivery.event, body);
  await prisma.outboundWebhook.update({ where: { id: webhook.id }, data: { lastDeliveryAt: new Date(), lastDeliveryStatus: outcome.status } });

  const updated = outcome.ok
    ? await prisma.webhookDelivery.update({ where: { id: delivery.id }, data: { status: "delivered", lastError: null } })
    : await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: { attempt: 1, status: "pending", nextAttemptAt: nextRetryAt(1), lastError: outcome.error ?? outcome.status }
      });
  await audit(req.user!.id, "settings.webhook_delivery_retried", "WebhookDelivery", delivery.id, { outcome: outcome.status });
  res.json(updated);
});

// ---------- Live git-provider (GitHub) connection ----------
// See docs/ROADMAP.md's "Live git-provider App integration" item and
// services/git-provider.service.ts's header for the OAuth design (each org brings its own
// GitHub OAuth App, same as OrgSsoConfig does for Google/Microsoft). The actual OAuth callback
// lives in controllers/git-connection.controller.ts (mounted pre-tenant-resolution, since
// GitHub's redirect carries org identity in a signed `state` param, not the Host header) —
// everything here is post-login, admin-only configuration and read-only GitHub API proxying.

settingsRouter.get("/git", requireSuperAdmin, async (req, res) => {
  const connection = await prisma.gitConnection.findUnique({ where: { id: "global" } });
  const { orgSlug } = requireTenantContext();
  res.json({
    connected: Boolean(connection?.encryptedAccessToken),
    clientIdSet: Boolean(connection?.clientId),
    accountLogin: connection?.accountLogin ?? null,
    connectedAt: connection?.connectedAt ?? null,
    webhookSecretSet: Boolean(connection?.encryptedWebhookSecret),
    // Not a secret itself — safe to always return, unlike the webhook secret below. Shown so
    // the admin can copy-paste it into each repo's GitHub webhook config without guessing the
    // URL shape (see controllers/git-webhook.controller.ts's own comment on why this is a
    // per-repo webhook, not one org-wide URL GitHub calls automatically).
    webhookUrl: `${req.protocol}://${req.get("host")}/api/git/webhook/${orgSlug}`,
    /** One URL per non-GitHub provider, all verified against the SAME webhook secret. Paste the
     *  matching one into the provider's webhook config: GitLab (Secret token), Bitbucket
     *  (Secret), Gitea/Forgejo (Secret, HMAC), Azure DevOps (basic-auth password or ?token=).
     *  See docs/SECURITY_DEVOPS_INTEGRATIONS.md § Git webhooks. */
    providerWebhookUrls: Object.fromEntries(
      ["gitlab", "bitbucket", "gitea", "forgejo", "azure-devops"].map((p) => [
        p,
        `${req.protocol}://${req.get("host")}/api/git/webhook/${orgSlug}/${p}`
      ])
    )
  });
});

settingsRouter.post("/git/webhook-secret/rotate", requireSuperAdmin, async (req, res) => {
  const secret = crypto.randomBytes(32).toString("hex");
  await prisma.gitConnection.upsert({
    where: { id: "global" },
    update: { encryptedWebhookSecret: encryptSecret(secret) },
    create: { id: "global", encryptedWebhookSecret: encryptSecret(secret) }
  });
  await audit(req.user!.id, "settings.git_webhook_secret_rotated", "GitConnection", "global");
  // Same one-time-plaintext-reveal trade-off as /security-ingestion/rotate-token — this is a
  // secret pasted into potentially many external GitHub repo webhook configs, not held only by
  // this app, so rotating it means updating every repo's webhook secret on GitHub's side too.
  res.json({ secret });
});

const gitAppCredentialsSchema = z.object({
  body: z.object({ clientId: z.string().min(1).max(255), clientSecret: z.string().min(1).max(255) })
});

settingsRouter.patch("/git/app-credentials", requireSuperAdmin, validate(gitAppCredentialsSchema), async (req, res) => {
  await prisma.gitConnection.upsert({
    where: { id: "global" },
    update: { clientId: req.body.clientId, encryptedClientSecret: encryptSecret(req.body.clientSecret) },
    create: { id: "global", clientId: req.body.clientId, encryptedClientSecret: encryptSecret(req.body.clientSecret) }
  });
  await audit(req.user!.id, "settings.git_app_credentials_saved", "GitConnection", "global");
  res.json({ clientIdSet: true });
});

settingsRouter.get("/git/connect", requireSuperAdmin, async (req, res) => {
  const connection = await prisma.gitConnection.findUnique({ where: { id: "global" } });
  if (!connection?.clientId) {
    throw new AppError(422, "Save your GitHub OAuth App's client ID/secret first (above), then connect.");
  }
  const { orgId } = requireTenantContext();
  const state = signGitConnectState({ orgId, userId: req.user!.id });
  res.json({ url: buildGitHubAuthorizeUrl(connection.clientId, state) });
});

settingsRouter.delete("/git", requireSuperAdmin, async (req, res) => {
  await prisma.gitConnection.updateMany({
    where: { id: "global" },
    data: { encryptedAccessToken: null, accountLogin: null, connectedById: null, connectedAt: null }
  });
  await audit(req.user!.id, "settings.git_disconnected", "GitConnection", "global");
  res.status(204).send();
});

async function requireGitAccessToken(): Promise<string> {
  const connection = await prisma.gitConnection.findUnique({ where: { id: "global" } });
  if (!connection?.encryptedAccessToken) throw new AppError(422, "Connect GitHub from Workspace Settings -> Security & DevOps first.");
  return decryptSecret(connection.encryptedAccessToken);
}

/**
 * These three proxy GitHub's API with the ORG'S decrypted OAuth token, so their response is the
 * private repo/branch/PR inventory of whatever account the admin connected — not workspace
 * configuration. They were `requireAuth` only, which made that inventory readable by every
 * authenticated account in the tenant.
 *
 * NOT `requireSuperAdmin` like the rest of `/git/*`: their real consumer is the ticket Dev tab's
 * "Pick from GitHub" picker (web/src/pages/Tickets.tsx#BranchesPanel), which a normal engineer
 * uses to link a branch/PR to their ticket. TICKETS_WRITE is the permission that consumer already
 * requires to write the resulting `TicketBranch`, so gating on it keeps the feature working for
 * exactly the people who can act on the result. Every seeded role holds TICKETS_WRITE; the gate
 * bites for roles an admin has narrowed (RolePermission rows are per-tenant data, not the enum)
 * and for anything holding a token without that grant.
 */
settingsRouter.get("/git/repos", requireAuth, requirePermission(permissions.TICKETS_WRITE), async (_req, res) => {
  const token = await requireGitAccessToken();
  res.json(await listGitHubRepos(token));
});

settingsRouter.get("/git/branches", requireAuth, requirePermission(permissions.TICKETS_WRITE), async (req, res) => {
  const repo = typeof req.query.repo === "string" ? req.query.repo : "";
  if (!repo) throw new AppError(422, "Query param 'repo' (owner/name) is required.");
  const token = await requireGitAccessToken();
  res.json(await listGitHubBranches(token, repo));
});

settingsRouter.get("/git/pulls", requireAuth, requirePermission(permissions.TICKETS_WRITE), async (req, res) => {
  const repo = typeof req.query.repo === "string" ? req.query.repo : "";
  if (!repo) throw new AppError(422, "Query param 'repo' (owner/name) is required.");
  const token = await requireGitAccessToken();
  res.json(await listGitHubPullRequests(token, repo));
});

/**
 * Face (identity) verification — see services/face.service.ts for why the thresholds have the
 * defaults they do and why this is off by default (it collects biometric data, which is a
 * special category under GDPR Art.9 and regulated by Illinois BIPA / India's DPDP Act).
 * Both GET and PATCH are super-admin, like every other workspace-configuration section. This GET
 * was previously auth-only, on the stated rationale that "any user's client needs the consent text
 * and retention window it has to display" — that rationale was stale: the enrollment dialog reads
 * consent text from `GET /api/face/status` (face.controller.ts's `consentText`, which falls back
 * to DEFAULT_CONSENT_TEXT), never from here. This route's only consumer is the settings card, so
 * gating it leaks nothing to the enrollment flow.
 */
settingsRouter.get("/face-verification", requireSuperAdmin, async (_req, res) => {
  const [settings, allowedByPlan] = await Promise.all([getFaceSettings(), isFaceFeatureAllowedForOrg()]);
  res.json({ ...settings, allowedByPlan });
});

const faceVerificationSchema = z.object({
  body: z
    .object({
      enabled: z.boolean().optional(),
      requireForTimesheet: z.boolean().optional(),
      requireForTicket: z.boolean().optional(),
      requireForApproval: z.boolean().optional(),
      challengeEnabled: z.boolean().optional(),
      // The insecure-context pass-through (see the schema comment): audited, off by default,
      // and deliberately super-admin-only like everything else on this route.
      insecureContextBypass: z.boolean().optional(),
      autoTriageHonestFailures: z.boolean().optional(),
      enforcementMode: z.enum(["ALL", "SELECTED"]).optional(),
      // Bounded well away from 0/1: a threshold of 0 matches literally anyone and 1 matches
      // nobody, and both are foot-guns an admin should not be able to set by typing in a box.
      matchThreshold: z.coerce.number().min(0.3).max(0.99).optional(),
      antispoofThreshold: z.coerce.number().min(0).max(0.99).optional(),
      livenessThreshold: z.coerce.number().min(0).max(0.99).optional(),
      maxAttempts: z.coerce.number().int().min(1).max(10).optional(),
      verificationTtlSeconds: z.coerce.number().int().min(30).max(3600).optional(),
      imageRetentionDays: z.coerce.number().int().min(0).max(3650).optional(),
      consentText: z.string().max(5000).nullable().optional()
    })
    .strict()
});

settingsRouter.patch("/face-verification", requireSuperAdmin, validate(faceVerificationSchema), async (req, res) => {
  // Plan-tier enforcement, same convention as SSO/chat: only ENABLING is gated (fail closed) —
  // editing thresholds/consent while below Enterprise stays allowed so an org mid-upgrade can
  // stage its configuration ahead of time.
  if (req.body.enabled === true) {
    await assertFaceEntitlement();
  }

  const data: Record<string, unknown> = { ...req.body, updatedById: req.user!.id };
  const updated = await prisma.globalFaceVerificationSettings.upsert({
    where: { id: "global" },
    update: data,
    create: { id: "global", ...data }
  });
  await audit(req.user!.id, "settings.face_verification_updated", "GlobalFaceVerificationSettings", "global", req.body);

  // Tell newly-covered, not-yet-enrolled users BEFORE their first blocked submission does.
  // Deduped inside (72h window), so repeated saves don't spam; fire-and-forget so a slow SMTP
  // server can't hold the settings PATCH open.
  const policyTouched =
    "enabled" in req.body || "enforcementMode" in req.body ||
    "requireForTimesheet" in req.body || "requireForTicket" in req.body || "requireForApproval" in req.body;
  if (policyTouched && updated.enabled) {
    findCoveredUnenrolledUserIds()
      .then((ids) => notifyEnrollmentRequired(ids, "face.enrollment_required"))
      .catch(() => undefined);
  }

  res.json(updated);
});
