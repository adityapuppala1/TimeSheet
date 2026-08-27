/**
 * Platform-admin console routes — mounted in app.ts BEFORE the blanket tenant-resolution
 * middleware (same reasoning as controllers/sso.controller.ts's header comment): a platform
 * admin operates ACROSS tenants by definition, so nothing here should ever depend on which
 * org a Host header happens to resolve to. Auth is entirely separate from tenant auth — see
 * middleware/platform-admin-auth.ts and utils/platform-admin-security.ts.
 */
import { Router } from "express";
import { z } from "zod";
import { UNLIMITED_PLAN_ITEMS } from "@timesheet/shared";
import { env } from "../config/env.js";
import { controlPrisma } from "../config/control-prisma.js";
import { AppError } from "../middleware/error.js";
import { requirePlatformAdmin } from "../middleware/platform-admin-auth.js";
import { validate } from "../middleware/validate.js";
import { platformAdminLogin, platformAdminRefresh } from "../services/platform-admin-auth.service.js";
import { getPlatformAnalytics } from "../services/platform-admin-analytics.service.js";
import { provisionOrganization } from "../services/provisioning.service.js";
import { encryptSecret } from "../utils/encryption.js";

export const platformAdminRouter = Router();

const REFRESH_COOKIE = "platformAdminRefreshToken";
const COOKIE_PATH = "/api/platform-admin/auth";

function refreshCookieOptions(expiresAt?: Date) {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: COOKIE_PATH,
    expires: expiresAt
  };
}

/* ================================== Auth ====================================== */

platformAdminRouter.post(
  "/auth/login",
  validate(z.object({ body: z.object({ email: z.string().email(), password: z.string().min(8) }) })),
  async (req, res) => {
    const result = await platformAdminLogin(req.body.email, req.body.password, req.headers["user-agent"], req.ip);
    res.cookie(REFRESH_COOKIE, result.refreshToken, refreshCookieOptions(result.refreshTokenExpiresAt));
    res.json({ accessToken: result.accessToken, admin: result.admin });
  }
);

platformAdminRouter.post("/auth/refresh", async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE];
  const result = await platformAdminRefresh(token);
  res.cookie(REFRESH_COOKIE, result.refreshToken, refreshCookieOptions(result.refreshTokenExpiresAt));
  res.json({ accessToken: result.accessToken });
});

platformAdminRouter.post("/auth/logout", requirePlatformAdmin, async (req, res) => {
  if (req.platformAdminSessionId) {
    await controlPrisma.platformAdminSession.update({ where: { id: req.platformAdminSessionId }, data: { revokedAt: new Date() } }).catch(() => undefined);
  }
  res.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
  res.status(204).send();
});

platformAdminRouter.get("/auth/me", requirePlatformAdmin, async (req, res) => {
  res.json(req.platformAdmin);
});

/* ============================== Organizations ================================== */

platformAdminRouter.get("/organizations", requirePlatformAdmin, async (_req, res) => {
  const orgs = await controlPrisma.organization.findMany({
    include: { database: { select: { host: true, databaseName: true, migratedAt: true, schemaVersion: true } } },
    orderBy: { createdAt: "desc" }
  });
  res.json(orgs);
});

const createOrgSchema = z.object({
  body: z
    .object({
      name: z.string().min(2).max(200),
      slug: z
        .string()
        .min(2)
        .max(63)
        .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "Lowercase letters, numbers, and hyphens only — no leading/trailing hyphen"),
      planTier: z.enum(["STARTER", "TEAM", "ENTERPRISE"]).default("STARTER")
    })
    .strict()
});

// Deliberately control-plane metadata only — NOT full provisioning (creating the physical
// database, running tenant migrations, seeding roles/an initial admin user). That automation
// is Phase B8's job; until then, a platform admin creates the Organization row here in
// PROVISIONING status and hands the org id to ops to finish physical setup (mirrors exactly
// how Phase B2's second tenant was manually provisioned before any of this console existed).
platformAdminRouter.post("/organizations", requirePlatformAdmin, validate(createOrgSchema), async (req, res) => {
  const existing = await controlPrisma.organization.findUnique({ where: { slug: req.body.slug } });
  if (existing) throw new AppError(409, "An organization with this slug already exists.");

  const org = await controlPrisma.organization.create({
    data: { name: req.body.name, slug: req.body.slug, planTier: req.body.planTier, status: "PROVISIONING" }
  });
  res.status(201).json(org);
});

platformAdminRouter.get("/organizations/:id", requirePlatformAdmin, async (req, res) => {
  const org = await controlPrisma.organization.findUnique({
    where: { id: String(req.params.id) },
    include: { database: true, ssoConfigs: true, authMethod: true }
  });
  if (!org) throw new AppError(404, "Organization not found");
  const { database, ssoConfigs, ...rest } = org;
  res.json({
    ...rest,
    database: database ? { host: database.host, databaseName: database.databaseName, migratedAt: database.migratedAt, schemaVersion: database.schemaVersion } : null,
    ssoConfigs: ssoConfigs.map((c) => ({ provider: c.providerType, isEnabled: c.isEnabled }))
  });
});

const updateOrgSchema = z.object({
  body: z
    .object({
      name: z.string().min(2).max(200).optional(),
      planTier: z.enum(["STARTER", "TEAM", "ENTERPRISE"]).optional(),
      status: z.enum(["PROVISIONING", "ACTIVE", "SUSPENDED", "ARCHIVED"]).optional(),
      suspendedReason: z.string().max(500).optional().nullable(),
      seatLimitOverride: z.number().int().positive().optional().nullable(),
      aiMonthlyBudgetCeilingOverride: z.number().nonnegative().optional().nullable()
    })
    .strict()
});

platformAdminRouter.patch("/organizations/:id", requirePlatformAdmin, validate(updateOrgSchema), async (req, res) => {
  const data: Record<string, unknown> = { ...req.body };
  if (req.body.status === "SUSPENDED") data.suspendedAt = new Date();
  if (req.body.status && req.body.status !== "SUSPENDED") {
    data.suspendedAt = null;
    if (!("suspendedReason" in req.body)) data.suspendedReason = null;
  }
  const org = await controlPrisma.organization.update({ where: { id: String(req.params.id) }, data }).catch(() => null);
  if (!org) throw new AppError(404, "Organization not found");
  res.json(org);
});

const provisionOrgSchema = z.object({
  body: z.object({
    adminEmail: z.string().email(),
    adminName: z.string().min(2).max(120),
    adminPassword: z.string().min(8)
  }).strict()
});

// Phase B8: turns the control-plane row created above into a real, working tenant — physical
// database, migrations, baseline seed data, and the one real admin account requested. See
// services/provisioning.service.ts for the full flow and its retry-safety guarantees.
platformAdminRouter.post("/organizations/:id/provision", requirePlatformAdmin, validate(provisionOrgSchema), async (req, res) => {
  const result = await provisionOrganization(String(req.params.id), req.body);
  res.json(result);
});

/* ============================== Plan tier limits ================================== */

platformAdminRouter.get("/plan-tier-limits", requirePlatformAdmin, async (_req, res) => {
  const limits = await controlPrisma.planTierLimit.findMany({ orderBy: { tier: "asc" } });
  res.json(limits);
});

/**
 * What a platform admin may tune on a tier.
 *
 * IT USED TO BE FIVE KEYS. `.strict()` rejects anything else with a 400, and the schema was never
 * widened when V6 added the planning layer, V8 added goals and change management, or 3.5.0 added
 * the practice update — so those fifteen entitlements were reachable only by a migration or by
 * hand-editing the control database. The console showed a "Features" section containing exactly
 * one checkbox while enforcing twenty-one.
 *
 * Quotas are bounded rather than unbounded: `UNLIMITED_PLAN_ITEMS` (1,000,000) is the sentinel the
 * shared constant uses for "no ceiling", so anything above it is meaningless and anything negative
 * is a footgun. Zero is a REAL value on every quota here — it means the tier cannot use that
 * resource at all — so `nonnegative`, never `positive`.
 */
const capabilityKeys = [
  "faceVerificationEnabled",
  "ganttEnabled",
  "resourceMgmtEnabled",
  "approvalsEnabled",
  "proofingEnabled",
  "customWorkflowsEnabled",
  "aiPmCopilotEnabled",
  "goalsEnabled",
  "changeManagementEnabled",
  "practiceUpdateEnabled"
] as const;

const quotaKeys = [
  "maxPortfolios",
  "maxRequestForms",
  "maxBlueprints",
  "maxCustomFields",
  "maxDashboards",
  "maxGoals",
  "maxChangePolicies"
] as const;

const planTierLimitSchema = z.object({
  params: z.object({ tier: z.enum(["STARTER", "TEAM", "ENTERPRISE"]) }),
  body: z
    .object({
      seatLimit: z.number().int().positive().optional(),
      aiMonthlyBudgetCeilingUsd: z.number().nonnegative().optional(),
      allowedSsoProviders: z.array(z.enum(["GOOGLE", "MICROSOFT", "SAML", "LDAP"])).optional(),
      allowedChatPlatforms: z.array(z.enum(["SLACK", "MICROSOFT_TEAMS", "GOOGLE_CHAT", "TELEGRAM"])).optional(),
      ...Object.fromEntries(capabilityKeys.map((key) => [key, z.boolean().optional()])),
      ...Object.fromEntries(quotaKeys.map((key) => [key, z.number().int().nonnegative().max(UNLIMITED_PLAN_ITEMS).optional()]))
    })
    .strict()
});

platformAdminRouter.patch("/plan-tier-limits/:tier", requirePlatformAdmin, validate(planTierLimitSchema), async (req, res) => {
  const updated = await controlPrisma.planTierLimit.update({ where: { tier: req.params.tier as "STARTER" | "TEAM" | "ENTERPRISE" }, data: req.body });
  res.json(updated);
});

/* ============================== Billing (Stripe) ================================== */

/**
 * Platform-wide Stripe configuration — one merchant-of-record account, not BYOK per-org (see
 * PlatformBillingSettings' schema doc comment). A platform admin creates a Restricted API Key
 * (Checkout Sessions + Customers + Subscriptions, write) and a webhook endpoint pointed at
 * `/api/billing/webhook` in the Stripe dashboard, then pastes both here alongside the two Price
 * IDs (TEAM/ENTERPRISE) created for this app's plan tiers. Same masked-secret GET/rotate shape
 * as every other credential in this app — the secret key and webhook signing secret are never
 * echoed back once set.
 */
platformAdminRouter.get("/billing-settings", requirePlatformAdmin, async (_req, res) => {
  const settings = await controlPrisma.platformBillingSettings.findUnique({ where: { id: "global" } });
  res.json({
    secretKeySet: Boolean(settings?.encryptedSecretKey),
    webhookSigningSecretSet: Boolean(settings?.encryptedWebhookSigningSecret),
    priceIdTeam: settings?.priceIdTeam ?? null,
    priceIdEnterprise: settings?.priceIdEnterprise ?? null
  });
});

const billingSettingsSchema = z.object({
  body: z
    .object({
      // Empty string clears the stored value; omitting the field leaves it untouched — same
      // convention as GlobalAISettings.apiKey in settings.controller.ts.
      secretKey: z.string().max(500).optional(),
      webhookSigningSecret: z.string().max(500).optional(),
      priceIdTeam: z.string().max(255).optional().nullable(),
      priceIdEnterprise: z.string().max(255).optional().nullable()
    })
    .strict()
});

platformAdminRouter.patch("/billing-settings", requirePlatformAdmin, validate(billingSettingsSchema), async (req, res) => {
  const data: Record<string, unknown> = {};
  if (typeof req.body.secretKey === "string") data.encryptedSecretKey = req.body.secretKey.length > 0 ? encryptSecret(req.body.secretKey) : null;
  if (typeof req.body.webhookSigningSecret === "string")
    data.encryptedWebhookSigningSecret = req.body.webhookSigningSecret.length > 0 ? encryptSecret(req.body.webhookSigningSecret) : null;
  if (req.body.priceIdTeam !== undefined) data.priceIdTeam = req.body.priceIdTeam;
  if (req.body.priceIdEnterprise !== undefined) data.priceIdEnterprise = req.body.priceIdEnterprise;

  const updated = await controlPrisma.platformBillingSettings.upsert({ where: { id: "global" }, update: data, create: { id: "global", ...data } });
  res.json({
    secretKeySet: Boolean(updated.encryptedSecretKey),
    webhookSigningSecretSet: Boolean(updated.encryptedWebhookSigningSecret),
    priceIdTeam: updated.priceIdTeam,
    priceIdEnterprise: updated.priceIdEnterprise
  });
});

/* ================================== Analytics =================================== */

platformAdminRouter.get("/analytics", requirePlatformAdmin, async (_req, res) => {
  res.json(await getPlatformAnalytics());
});
