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
import { controlPrisma } from "../config/control-prisma.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { serverTimezone } from "../config/env.js";
import { requireAuth, requireSuperAdmin } from "../middleware/auth.js";
import { env } from "../config/env.js";
import { AppError } from "../middleware/error.js";
import { validate } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import { getGlobalNotificationSettings } from "../services/notify.service.js";
import { getGlobalAISettings, getMonthlyAIUsageSummary, getWeeklyAIUsageTrend } from "../services/ai.service.js";
import { getAllowedSsoProviders } from "../services/plan-limits.service.js";
import { getGlobalTicketSettings } from "../services/ticket.service.js";
import { encryptSecret } from "../utils/encryption.js";

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

/**
 * BYOK: `apiKey` is write-only — a saved key is never returned, only `apiKeySet: boolean`
 * (same masking convention as EmailIntakeSettings.imapPassword). `apiKeyConfigured` stays for
 * backward compatibility (true when either a stored key OR the env var fallback is usable for
 * the current provider) since the frontend's existing "is AI actually usable" check reads it.
 */
settingsRouter.get("/ai", async (_req, res) => {
  const { apiKey, ...settings } = await getGlobalAISettings();
  const apiKeySet = Boolean(apiKey);
  const apiKeyConfigured = settings.provider === "ANTHROPIC" ? apiKeySet || Boolean(env.ANTHROPIC_API_KEY) : apiKeySet;
  res.json({ ...settings, apiKeySet, apiKeyConfigured });
});

settingsRouter.get("/ai/usage-summary", async (_req, res) => {
  res.json(await getMonthlyAIUsageSummary());
});

settingsRouter.get("/ai/usage-trend", async (req, res) => {
  const weeks = Math.min(26, Math.max(1, Number(req.query.weeks) || 8));
  res.json(await getWeeklyAIUsageTrend(weeks));
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
      monthlyBudgetUsd: z.coerce.number().min(0).optional().nullable(),
      provider: z.enum(["ANTHROPIC", "OPENAI_COMPATIBLE"]).optional(),
      baseUrl: z.string().max(300).optional().nullable(),
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
  const { apiKey: _omit, ...safeUpdated } = updated;
  res.json({ ...safeUpdated, apiKeySet: Boolean(updated.apiKey) });
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
