/**
 * Platform-admin console routes — mounted in app.ts BEFORE the blanket tenant-resolution
 * middleware (same reasoning as controllers/sso.controller.ts's header comment): a platform
 * admin operates ACROSS tenants by definition, so nothing here should ever depend on which
 * org a Host header happens to resolve to. Auth is entirely separate from tenant auth — see
 * middleware/platform-admin-auth.ts and utils/platform-admin-security.ts.
 */
import { Router } from "express";
import { z } from "zod";
import { platformCapabilities, platformRoleHas, UNLIMITED_PLAN_ITEMS } from "@timesheet/shared";
import { env } from "../config/env.js";
import { controlPrisma } from "../config/control-prisma.js";
import { AppError } from "../middleware/error.js";
import { capturePlatformReason, requirePlatformAdmin, requirePlatformCapability, requirePlatformReason } from "../middleware/platform-admin-auth.js";
import { validate } from "../middleware/validate.js";
import { platformAuditFor } from "../services/platform-audit.service.js";
import {
  beginPlatformAdminMfa,
  changePlatformAdminPassword,
  confirmPlatformAdminMfa,
  countPlatformAdminRecoveryCodes,
  disablePlatformAdminMfa,
  platformAdminLogin,
  platformAdminRefresh,
  platformAdminVerifyMfa,
  usesSeededPassword
} from "../services/platform-admin-auth.service.js";
import { getPlatformAnalytics } from "../services/platform-admin-analytics.service.js";
import { provisionOrganization } from "../services/provisioning.service.js";
import { addDomain, listDomains, removeDomain, verifyDomain } from "../services/org-domain.service.js";
import { workspaceUrlForSlug } from "../services/workspace-directory.service.js";
import { withOrgTenant } from "../config/with-org-tenant.js";
import { dispatchTransactional } from "../services/notify.service.js";
import { templates } from "../services/mail-templates.js";
import { encryptSecret } from "../utils/encryption.js";
import { generateTempPassword, hashPassword } from "../utils/security.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { audit } from "../services/audit.service.js";

export const platformAdminRouter = Router();

/** Router-wide, so any action can carry a reason even where one is not demanded — see the
 *  middleware's own comment. It refuses nothing, including on the open `/auth/*` routes. */
platformAdminRouter.use(capturePlatformReason);

/**
 * `before`/`after` snapshots go through JSON, and two Prisma column types do not survive that on
 * their own: `BigInt` throws outright, and `Decimal` would serialise as an object. Both become
 * strings — an audit diff is read by a person, and "50.00" is the honest rendering of a money
 * column in a log.
 */
function asJson(value: unknown) {
  return JSON.parse(JSON.stringify(value, (_key, v) => (typeof v === "bigint" || v?.constructor?.name === "Decimal" ? String(v) : v)));
}

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

/**
 * `.strict()`, which it was not. Every other body schema in this file rejects an unknown key with
 * a 422; the one on the console's front door quietly accepted anything extra and dropped it. That
 * is not a vulnerability by itself — nothing read the extra keys — but "the sign-in endpoint is
 * the lax one" is precisely backwards, and a future field added here would have shipped with no
 * shape enforcement at all.
 */
platformAdminRouter.post(
  "/auth/login",
  validate(z.object({ body: z.object({ email: z.string().email(), password: z.string().min(8) }).strict() })),
  async (req, res) => {
    const result = await platformAdminLogin(req.body.email, req.body.password, req.headers["user-agent"], req.ip);
    // NO COOKIE ON A CHALLENGE. The refresh cookie is the session; setting one here would let a
    // caller who never completed the second factor mint access tokens from `/auth/refresh` alone.
    if (result.mfaRequired) {
      res.json({ mfaRequired: true, challengeToken: result.challengeToken, expiresInSeconds: result.expiresInSeconds });
      return;
    }
    res.cookie(REFRESH_COOKIE, result.refreshToken, refreshCookieOptions(result.refreshTokenExpiresAt));
    res.json({ accessToken: result.accessToken, admin: result.admin });
  }
);

/**
 * The second half of a sign-in. Its own route, so it gets its own rate limiter in app.ts — the
 * limiter on `/auth/login` does not cover it, and a six-digit code with no limiter is a code with
 * a million guesses.
 */
platformAdminRouter.post(
  "/auth/login/totp",
  validate(
    z.object({
      body: z.object({ challengeToken: z.string().min(1), code: z.string().min(1).max(64), recovery: z.boolean().optional() }).strict()
    })
  ),
  async (req, res) => {
    const result = await platformAdminVerifyMfa(req.body.challengeToken, req.body.code, {
      userAgent: req.headers["user-agent"],
      ipAddress: req.ip,
      recovery: req.body.recovery === true
    });
    res.cookie(REFRESH_COOKIE, result.refreshToken, refreshCookieOptions(result.refreshTokenExpiresAt));
    res.json({ accessToken: result.accessToken, admin: result.admin, usedRecoveryCode: result.usedRecoveryCode });
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
  // The seeded-password flag rides on the session-restore path too, so the banner survives a
  // reload — a warning that only shows on the sign-in that just happened is easy to miss. The role
  // and MFA state ride along for the same reason: the console hides what this operator cannot use,
  // and it has to know that on a restored session as well as on a fresh sign-in.
  const admin = await controlPrisma.platformAdminUser.findUnique({
    where: { id: req.platformAdmin!.id },
    select: { passwordHash: true, mfaEnabled: true }
  });
  res.json({
    ...req.platformAdmin,
    mfaEnabled: admin?.mfaEnabled ?? false,
    usingSeededPassword: admin ? await usesSeededPassword(admin.passwordHash) : false
  });
});

const changePasswordSchema = z.object({
  body: z.object({ currentPassword: z.string().min(8), newPassword: z.string().min(12).max(200) }).strict()
});

platformAdminRouter.post("/auth/change-password", requirePlatformAdmin, validate(changePasswordSchema), async (req, res) => {
  const result = await changePlatformAdminPassword(req.platformAdmin!.id, req.platformAdminSessionId!, req.body.currentPassword, req.body.newPassword);
  res.json({ ...result, usingSeededPassword: false });
});

/* ---------- The operator's own second factor ----------
 *
 * Every one of these is about the CALLER'S OWN account and needs no capability beyond being signed
 * in — the same rule `/auth/change-password` and the session routes already follow. A READ_ONLY
 * operator must be able to harden their own login; making that a privilege would be absurd.
 *
 * ENROLMENT IS OPT-IN, NOT FORCED, and that is a deliberate 5.0.0 decision rather than an
 * oversight. Flipping a mandatory second factor on at upgrade time locks out every existing
 * operator on the spot — the same failure mode as a restrictive role default, for the same reason:
 * nobody has enrolled yet, and the people who would fix it are the people who are locked out. The
 * console nags instead, and a later release can require it once the fleet has enrolled.
 */
platformAdminRouter.get("/auth/mfa", requirePlatformAdmin, async (req, res) => {
  const admin = await controlPrisma.platformAdminUser.findUnique({
    where: { id: req.platformAdmin!.id },
    select: { mfaEnabled: true, mfaEnrolledAt: true }
  });
  res.json({
    enabled: admin?.mfaEnabled ?? false,
    enrolledAt: admin?.mfaEnrolledAt ?? null,
    recoveryCodesRemaining: admin?.mfaEnabled ? await countPlatformAdminRecoveryCodes(req.platformAdmin!.id) : 0
  });
});

platformAdminRouter.post("/auth/mfa/begin", requirePlatformAdmin, async (req, res) => {
  res.json(await beginPlatformAdminMfa(req.platformAdmin!.id));
});

platformAdminRouter.post(
  "/auth/mfa/confirm",
  requirePlatformAdmin,
  validate(z.object({ body: z.object({ code: z.string().min(6).max(10) }).strict() })),
  async (req, res) => {
    const result = await confirmPlatformAdminMfa(req.platformAdmin!.id, req.body.code);
    await platformAuditFor(req)("platform_admin.mfa_enabled", "PlatformAdminUser", req.platformAdmin!.id, { email: req.platformAdmin!.email });
    res.json(result);
  }
);

platformAdminRouter.post(
  "/auth/mfa/disable",
  requirePlatformAdmin,
  validate(z.object({ body: z.object({ currentPassword: z.string().min(8) }).strict() })),
  async (req, res) => {
    const result = await disablePlatformAdminMfa(req.platformAdmin!.id, req.body.currentPassword);
    await platformAuditFor(req)("platform_admin.mfa_disabled", "PlatformAdminUser", req.platformAdmin!.id, { email: req.platformAdmin!.email });
    res.json(result);
  }
);

/* ============================== Organizations ==================================
 *
 * WHY EVERY ROUTE BELOW REPEATS `requirePlatformAdmin` INSTEAD OF ONE `router.use`: `/auth/login`
 * and `/auth/refresh` live on this same router and must stay open. The capability guard follows
 * the same shape for the same reason — see platform-admin-console.controller.ts, whose every route
 * is authenticated and which therefore does the opposite.
 */

const readOnly = requirePlatformCapability(platformCapabilities.PLATFORM_READ);
const support = requirePlatformCapability(platformCapabilities.PLATFORM_SUPPORT);
const billing = requirePlatformCapability(platformCapabilities.PLATFORM_BILLING);
const operate = requirePlatformCapability(platformCapabilities.PLATFORM_OPERATE);

platformAdminRouter.get("/organizations", requirePlatformAdmin, readOnly, async (_req, res) => {
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
platformAdminRouter.post("/organizations", requirePlatformAdmin, operate, validate(createOrgSchema), async (req, res) => {
  const existing = await controlPrisma.organization.findUnique({ where: { slug: req.body.slug } });
  if (existing) throw new AppError(409, "An organization with this slug already exists.");

  const org = await controlPrisma.organization.create({
    data: { name: req.body.name, slug: req.body.slug, planTier: req.body.planTier, status: "PROVISIONING" }
  });
  // Creating a workspace wrote no audit row at all until 5.0.0 — the control plane's trail began
  // at the first thing done TO an org and had nothing to say about where the org came from.
  await platformAuditFor(req)("organization.created", "Organization", org.id, { slug: org.slug, planTier: org.planTier }, { after: { slug: org.slug, planTier: org.planTier, status: org.status } });
  res.status(201).json(org);
});

platformAdminRouter.get("/organizations/:id", requirePlatformAdmin, readOnly, async (req, res) => {
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
      // GRACE was missing, so the one status the lifecycle worker actually sets could never be set
      // or cleared from the console — an org it had lapsed could only be moved by SQL.
      status: z.enum(["PROVISIONING", "ACTIVE", "GRACE", "SUSPENDED", "ARCHIVED"]).optional(),
      suspendedReason: z.string().max(500).optional().nullable(),
      seatLimitOverride: z.number().int().positive().optional().nullable(),
      aiMonthlyBudgetCeilingOverride: z.number().nonnegative().optional().nullable()
    })
    .strict()
});

/**
 * The one route in the console whose authorization is PER FIELD rather than per route.
 *
 * It carries two genuinely different jobs behind one PATCH. Moving a workspace onto a different
 * plan, raising its seat cap or its AI budget is a commercial decision — that is BILLING's job and
 * it is the only org write BILLING gets. Suspending a workspace, archiving it, or renaming it is
 * an operational one, and a finance role has no business taking a customer offline. Splitting the
 * route in two would have been the tidier shape and would have broken every existing console
 * caller; splitting the FIELDS keeps the contract and puts the check where the authority actually
 * differs.
 */
const BILLING_ORG_FIELDS = new Set(["planTier", "seatLimitOverride", "aiMonthlyBudgetCeilingOverride"]);

platformAdminRouter.patch("/organizations/:id", requirePlatformAdmin, requirePlatformReason, validate(updateOrgSchema), async (req, res) => {
  const admin = req.platformAdmin!;
  const touched = Object.keys(req.body as Record<string, unknown>);
  const commercialOnly = touched.length > 0 && touched.every((key) => BILLING_ORG_FIELDS.has(key));
  const capability = commercialOnly ? platformCapabilities.PLATFORM_BILLING : platformCapabilities.PLATFORM_OPERATE;
  if (!platformRoleHas(admin.role, capability)) {
    throw new AppError(
      403,
      commercialOnly
        ? `Changing a workspace's plan, seats or AI budget needs "${capability}". You are ${admin.role}.`
        : `Changing a workspace's name or lifecycle status needs "${capability}" — a billing role may only move plan, seats and AI budget. You are ${admin.role}.`
    );
  }

  const before = await controlPrisma.organization.findUnique({ where: { id: String(req.params.id) } });
  if (!before) throw new AppError(404, "Organization not found");

  const data: Record<string, unknown> = { ...req.body };
  if (req.body.status === "SUSPENDED") data.suspendedAt = new Date();
  if (req.body.status && req.body.status !== "SUSPENDED") {
    data.suspendedAt = null;
    if (!("suspendedReason" in req.body)) data.suspendedReason = null;
  }
  const org = await controlPrisma.organization.update({ where: { id: String(req.params.id) }, data }).catch(() => null);
  if (!org) throw new AppError(404, "Organization not found");

  // No audit row existed for this until 5.0.0 — a workspace could be suspended, moved to a
  // different tier or archived and the control plane's own trail said nothing about it.
  await platformAuditFor(req)("organization.updated", "Organization", org.id, { slug: org.slug, fields: touched }, {
    before: { planTier: before.planTier, status: before.status, name: before.name, seatLimitOverride: before.seatLimitOverride, aiMonthlyBudgetCeilingOverride: before.aiMonthlyBudgetCeilingOverride?.toString() ?? null },
    after: { planTier: org.planTier, status: org.status, name: org.name, seatLimitOverride: org.seatLimitOverride, aiMonthlyBudgetCeilingOverride: org.aiMonthlyBudgetCeilingOverride?.toString() ?? null }
  });
  res.json(org);
});

/**
 * POST /organizations/:id/restore-password-login — the break-glass for an SSO-only lockout.
 *
 * `OrgAuthMethod.requireSsoOnly` turns off password sign-in for a whole workspace, and an org whose
 * SSO then breaks has nobody left who can sign in — not even the super admin who set it. Until this
 * route existed, recovery was a hand-written UPDATE against the control-plane database.
 *
 * WHY IT LIVES HERE AND NOT AS A SUPER-ADMIN PASSWORD BYPASS. The obvious alternative is letting a
 * SUPER_ADMIN always sign in with a password regardless of the policy. That is a permanent hole in
 * the exact guarantee an org buys SSO-only for: a compliance-driven customer turns it on precisely
 * so that no password reaches their most privileged account. Support-mediated recovery keeps the
 * guarantee intact and still ends the outage — it is how Okta and Google Workspace handle the same
 * situation.
 *
 * It writes the LEAST it can: password login back on, SSO-only off. It does not touch the SSO
 * configuration, because the org's own admin needs to see what was broken in order to fix it.
 */
platformAdminRouter.post("/organizations/:id/restore-password-login", requirePlatformAdmin, support, requirePlatformReason, async (req, res) => {
  const orgId = String(req.params.id);
  const org = await controlPrisma.organization.findUnique({ where: { id: orgId }, select: { id: true, slug: true } });
  if (!org) throw new AppError(404, "Organization not found");

  const previous = await controlPrisma.orgAuthMethod.findUnique({ where: { organizationId: orgId } });
  const updated = await controlPrisma.orgAuthMethod.upsert({
    where: { organizationId: orgId },
    update: { passwordLoginEnabled: true, requireSsoOnly: false },
    create: { organizationId: orgId, passwordLoginEnabled: true, requireSsoOnly: false }
  });

  /*
   * THIS WROTE NO AUDIT ROW AT ALL UNTIL 5.0.0, and of everything in this file it is the one that
   * most needed one. It turns off a security control a customer deliberately turned on — SSO-only
   * — from outside their workspace, where their own audit log cannot see it. The tenant's log gets
   * nothing because there is no tenant session and no user to attribute it to; the control plane's
   * trail is the only place this can be recorded, and until now it was not recorded anywhere.
   */
  await platformAuditFor(req)("org_auth.password_login_restored", "Organization", orgId, { slug: org.slug }, {
    before: { passwordLoginEnabled: previous?.passwordLoginEnabled ?? true, requireSsoOnly: previous?.requireSsoOnly ?? false },
    after: { passwordLoginEnabled: updated.passwordLoginEnabled, requireSsoOnly: updated.requireSsoOnly }
  });

  res.json({
    orgSlug: org.slug,
    passwordLoginEnabled: updated.passwordLoginEnabled,
    requireSsoOnly: updated.requireSsoOnly,
    message: `Password sign-in is back on for ${org.slug}. Their admin can sign in and fix the SSO configuration.`
  });
});

const resetAdminPasswordSchema = z.object({
  body: z.object({ email: z.string().email() }).strict()
});

/**
 * The rescue for a workspace whose only administrator is locked out and cannot use
 * /forgot-password — their SMTP is misconfigured, or the mailbox is the thing they lost. The
 * platform admin names the account; a one-time password is generated (never chosen — an operator
 * should never know a customer's password of their own choosing), returned ONCE in this response
 * and stored only as a hash, with `mustChangePassword` set so the tenant app prompts them to
 * replace it on first sign-in.
 *
 * Deliberately narrow: the target must already be a SUPER_ADMIN in that workspace. This is a lock
 * to be picked for the owner, not a way for the platform to mint itself a login inside a customer's
 * data — the audit row is written inside the tenant's own log, where the customer can see it.
 */
platformAdminRouter.post(
  "/organizations/:id/reset-admin-password",
  requirePlatformAdmin,
  support,
  requirePlatformReason,
  validate(resetAdminPasswordSchema),
  async (req, res) => {
    const orgId = String(req.params.id);
    const org = await controlPrisma.organization.findUnique({ where: { id: orgId }, select: { id: true, slug: true, status: true } });
    if (!org) throw new AppError(404, "Organization not found");
    if (org.status !== "ACTIVE") throw new AppError(409, `Workspace "${org.slug}" is ${org.status.toLowerCase()} — there is no administrator to reset yet.`);

    const email = String(req.body.email).trim().toLowerCase();
    const actor = req.platformAdmin!;

    const result = await withOrgTenant(org.slug, async () => {
      const client = requireTenantContext().client;
      const user = await client.user.findFirst({
        where: { email, deletedAt: null },
        select: { id: true, name: true, status: true, role: { select: { name: true } } }
      });
      if (!user) throw new AppError(404, `No account with that email in "${org.slug}".`);
      if (user.role.name !== "SUPER_ADMIN") {
        throw new AppError(403, `${email} is not a super administrator of "${org.slug}" — only the workspace owner can be reset from here; their own admins reset everyone else.`);
      }

      const password = generateTempPassword();
      await client.user.update({
        where: { id: user.id },
        data: { passwordHash: await hashPassword(password), mustChangePassword: true, status: user.status === "INACTIVE" ? "ACTIVE" : user.status }
      });
      // The same rule the tenant's own reset applies (user.controller.ts): a new hash evicts
      // nobody by itself, so whoever holds the old sessions is signed out everywhere.
      await client.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
      // GUEST, not USER: the actor is a real person but not a member of this workspace, so there is
      // no tenant `actorId` to point at. The label carries who it was, in the customer's own log.
      await audit(
        undefined,
        "user.password_reset_by_platform",
        "User",
        user.id,
        // The operator's own words, not the constant "platform-admin rescue" this used to carry.
        // The customer reading their own log deserves to see WHY somebody outside their workspace
        // reset their owner's password, and a fixed string answers a different question.
        { by: actor.email, reason: req.platformReason ?? "platform-admin rescue" },
        { actorType: "GUEST", actorLabel: `platform-admin:${actor.email}` }
      );
      return { userId: user.id, name: user.name, password };
    });

    // ALSO in the control plane's own trail. The row above lands in the customer's log, which is
    // right and is not enough: "which operator went into which workspace, and why" is a question
    // asked of the platform, and no tenant database can answer it about every tenant.
    await platformAuditFor(req)("org_admin.password_reset", "Organization", orgId, { slug: org.slug, targetEmail: email, targetUserId: result.userId });

    res.json({
      orgSlug: org.slug,
      email,
      name: result.name,
      /** Shown once. Not stored, not logged, not mailed — it goes to the customer by whatever channel the operator trusts. */
      temporaryPassword: result.password,
      url: workspaceUrlForSlug(org.slug),
      message: `One-time password issued for ${email}. They have been signed out everywhere and will be asked to choose their own password at sign-in.`
    });
  }
);

/* ---------- Custom domains ---------- */

platformAdminRouter.get("/organizations/:id/domains", requirePlatformAdmin, readOnly, async (req, res) => {
  res.json({ domains: await listDomains(String(req.params.id)), rootDomain: env.ROOT_DOMAIN ?? null });
});

platformAdminRouter.post(
  "/organizations/:id/domains",
  requirePlatformAdmin,
  operate,
  validate(z.object({ body: z.object({ domain: z.string().min(3).max(253) }).strict() })),
  async (req, res) => {
    const org = await controlPrisma.organization.findUnique({ where: { id: String(req.params.id) }, select: { id: true } });
    if (!org) throw new AppError(404, "Organization not found");
    res.status(201).json(await addDomain(org.id, req.body.domain, env.ROOT_DOMAIN));
  }
);

platformAdminRouter.post("/organizations/:id/domains/:domainId/verify", requirePlatformAdmin, operate, async (req, res) => {
  res.json(await verifyDomain(String(req.params.id), String(req.params.domainId)));
});

platformAdminRouter.delete("/organizations/:id/domains/:domainId", requirePlatformAdmin, operate, async (req, res) => {
  await removeDomain(String(req.params.id), String(req.params.domainId));
  res.status(204).end();
});

/* ---------- Routing readout ---------- */

/**
 * GET /routing — what this deployment does with a hostname, and what would change if ROOT_DOMAIN
 * were set.
 *
 * WHY IT EXISTS. `ROOT_DOMAIN` switches the deployment between two genuinely different routing
 * behaviours, and there was no way to see which one is active short of reading env on the server.
 * Worse, the consequences of setting it are invisible until traffic arrives: every workspace URL
 * has to already resolve under that root, and the bare domain stops serving DEFAULT_ORG_SLUG and
 * starts serving the workspace finder. Both are the right behaviours and both will surprise
 * somebody who flips the variable without looking.
 *
 * So this reports the mode, the URL each workspace is reachable at under it, and — when it is NOT
 * set — a preview of what each would become. It is a read-only dry run for a change that cannot be
 * undone quietly.
 */
platformAdminRouter.get("/routing", requirePlatformAdmin, readOnly, async (_req, res) => {
  const orgs = await controlPrisma.organization.findMany({
    where: { status: { not: "ARCHIVED" } },
    select: { id: true, slug: true, name: true, status: true, domains: { where: { verifiedAt: { not: null } }, select: { domain: true } } },
    orderBy: { slug: "asc" }
  });

  res.json({
    mode: env.ROOT_DOMAIN ? "multi-org" : "single-org",
    rootDomain: env.ROOT_DOMAIN ?? null,
    defaultOrgSlug: env.DEFAULT_ORG_SLUG,
    appBaseUrl: env.APP_BASE_URL,
    /** What the bare domain currently serves, which is the surprising half of the switch. */
    apexServes: env.ROOT_DOMAIN ? "the workspace finder" : `the "${env.DEFAULT_ORG_SLUG}" workspace`,
    organizations: orgs.map((org) => ({
      slug: org.slug,
      name: org.name,
      status: org.status,
      customDomain: org.domains[0]?.domain ?? null,
      /** Live under the current mode. */
      url: org.domains[0] ? `https://${org.domains[0].domain}` : workspaceUrlForSlug(org.slug),
      /** What it WOULD be if ROOT_DOMAIN were set — null when it already is. */
      urlIfRootDomainSet: env.ROOT_DOMAIN ? null : `https://${org.slug}.<ROOT_DOMAIN>`
    }))
  });
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
platformAdminRouter.post("/organizations/:id/provision", requirePlatformAdmin, operate, requirePlatformReason, validate(provisionOrgSchema), async (req, res) => {
  const result = await provisionOrganization(String(req.params.id), req.body);

  /*
   * PROVISIONING WROTE NO AUDIT ROW UNTIL 5.0.0. It creates a physical database, runs every tenant
   * migration against it, seeds roles, and mints a real administrator account inside a customer's
   * workspace. The tenant's own log starts existing halfway through that and cannot describe who
   * asked for it; the control plane's trail is where it belongs, and it was silent.
   *
   * The admin's PASSWORD is not in the metadata and must never be. The address is, because "which
   * account did we create in there" is exactly the question this row is asked later.
   */
  await platformAuditFor(req)("organization.provisioned", "Organization", String(req.params.id), { adminEmail: req.body.adminEmail, databaseName: result.databaseName }, { after: { schemaVersion: result.schemaVersion } });

  /*
   * THE NEW ADMIN LEARNS WHERE TO SIGN IN FROM THE PRODUCT, NOT FROM A HANDOVER NOTE.
   *
   * Self-serve signup has always sent the welcome email with the workspace URL; this path — the one
   * a platform admin uses to onboard a customer — sent nothing, and the ops guide compensated with
   * "hand the credentials over out-of-band". Half of that is right: the PASSWORD must travel
   * out-of-band and never in mail. The URL and the welcome are not secrets, and an admin who has to
   * guess `<slug>.<root domain>` from a Slack message is how "login is broken" tickets start.
   *
   * Sent through the tenant's own transactional path (same template, same per-org channel gating,
   * same delivery analytics) so it behaves exactly like every other mail this workspace sends.
   * Failure to send is reported in the response, not thrown: the org IS provisioned at this point,
   * and a mail hiccup must not read as a failed provision.
   */
  const org = await controlPrisma.organization.findUnique({ where: { id: result.organizationId }, select: { slug: true } });
  const url = org ? workspaceUrlForSlug(org.slug) : null;
  let welcomeSent = false;
  if (org) {
    try {
      await withOrgTenant(org.slug, async () => {
        await dispatchTransactional({
          to: req.body.adminEmail,
          templateKey: "welcome",
          vars: { name: req.body.adminName, appUrl: url ?? "" },
          fallback: { subject: "Welcome to TimeSphere", html: templates.welcome(req.body.adminName) }
        });
      });
      welcomeSent = true;
    } catch {
      welcomeSent = false;
    }
  }
  res.json({ ...result, url, welcomeSent });
});

/* ============================== Plan tier limits ================================== */

platformAdminRouter.get("/plan-tier-limits", requirePlatformAdmin, readOnly, async (_req, res) => {
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
      ...Object.fromEntries(quotaKeys.map((key) => [key, z.number().int().nonnegative().max(UNLIMITED_PLAN_ITEMS).optional()])),
      // Managed backups. Not in `capabilityKeys`/`quotaKeys` because the cadence is an enum rather
      // than a boolean or a count, and folding it into either list would make the generated console
      // form render it as the wrong control.
      backupFrequency: z.enum(["NONE", "WEEKLY", "DAILY", "HOURLY"]).optional(),
      maxBackupDestinations: z.number().int().nonnegative().max(50).optional(),
      backupPitrEnabled: z.boolean().optional(),

      /*
       * The list price (5.0.0). NULLABLE, and the null is the whole point: it means "this tier has
       * no list price" — Enterprise, which is priced per contract — and it is NOT the same value as
       * 0, which means free. The console must be able to send either, so `.nullable()` rather than
       * only `.optional()`: leaving the field out keeps what is stored, sending `null` clears it.
       *
       * Minor units, integer, so no price ever touches a float. The ceiling is arbitrary but finite:
       * a mistyped price is a number every revenue figure in the console then multiplies by the
       * whole fleet's seat count, and $10,000 per seat per month is far past any real plan.
       */
      listPricePerSeatMinor: z.number().int().nonnegative().max(1_000_000).nullable().optional(),
      // ISO-4217, upper-cased by the client. Length-pinned rather than enum'd: a deployment billing
      // in a currency this file did not think of is not an error.
      listPriceCurrency: z.string().regex(/^[A-Z]{3}$/, "A three-letter ISO-4217 code, e.g. USD.").optional()
    })
    .strict()
});

platformAdminRouter.patch("/plan-tier-limits/:tier", requirePlatformAdmin, billing, validate(planTierLimitSchema), async (req, res) => {
  const tier = req.params.tier as "STARTER" | "TEAM" | "ENTERPRISE";
  const before = await controlPrisma.planTierLimit.findUnique({ where: { tier } });
  const updated = await controlPrisma.planTierLimit.update({ where: { tier }, data: req.body });
  // Retuning what a whole plan tier is entitled to wrote nothing to the audit trail until 5.0.0 —
  // it changes what every customer on that tier can do, and nothing recorded that it happened.
  await platformAuditFor(req)("plan_tier.updated", "PlanTierLimit", tier, { fields: Object.keys(req.body as Record<string, unknown>) }, {
    before: before ? asJson(before) : undefined,
    after: asJson(updated)
  });
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
platformAdminRouter.get("/billing-settings", requirePlatformAdmin, billing, async (_req, res) => {
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

platformAdminRouter.patch("/billing-settings", requirePlatformAdmin, billing, validate(billingSettingsSchema), async (req, res) => {
  const data: Record<string, unknown> = {};
  if (typeof req.body.secretKey === "string") data.encryptedSecretKey = req.body.secretKey.length > 0 ? encryptSecret(req.body.secretKey) : null;
  if (typeof req.body.webhookSigningSecret === "string")
    data.encryptedWebhookSigningSecret = req.body.webhookSigningSecret.length > 0 ? encryptSecret(req.body.webhookSigningSecret) : null;
  if (req.body.priceIdTeam !== undefined) data.priceIdTeam = req.body.priceIdTeam;
  if (req.body.priceIdEnterprise !== undefined) data.priceIdEnterprise = req.body.priceIdEnterprise;

  const updated = await controlPrisma.platformBillingSettings.upsert({ where: { id: "global" }, update: data, create: { id: "global", ...data } });
  /*
   * Another route that wrote nothing until 5.0.0. It sets the merchant-of-record credentials for
   * every paying customer on the platform — pointing them at a different Stripe account is the
   * single most valuable thing anybody could do from this console, and it left no trace.
   *
   * WHICH keys changed is recorded; the keys themselves are not, and neither is any prefix of
   * them. An audit row that quotes a secret is a second copy of the secret.
   */
  await platformAuditFor(req)("platform_billing.updated", "PlatformBillingSettings", "global", { fields: Object.keys(req.body as Record<string, unknown>) }, {
    after: {
      secretKeySet: Boolean(updated.encryptedSecretKey),
      webhookSigningSecretSet: Boolean(updated.encryptedWebhookSigningSecret),
      priceIdTeam: updated.priceIdTeam,
      priceIdEnterprise: updated.priceIdEnterprise
    }
  });
  res.json({
    secretKeySet: Boolean(updated.encryptedSecretKey),
    webhookSigningSecretSet: Boolean(updated.encryptedWebhookSigningSecret),
    priceIdTeam: updated.priceIdTeam,
    priceIdEnterprise: updated.priceIdEnterprise
  });
});

/* ================================== Analytics =================================== */

platformAdminRouter.get("/analytics", requirePlatformAdmin, readOnly, async (_req, res) => {
  res.json(await getPlatformAnalytics());
});
