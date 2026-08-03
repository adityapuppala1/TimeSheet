/**
 * Auth routes. WHY the refresh token lives in an httpOnly cookie rather than the response
 * body (the pre-hardening design): a token any JS on the page can read (localStorage, or a
 * body a client chooses to persist) is a token any XSS payload can steal too. An httpOnly
 * cookie is invisible to page JS entirely — the browser attaches it automatically on
 * requests to `/api/auth/*` (see the cookie's `path`), and that's the only way it moves.
 * The access token is still handed back in the response body (short-lived, 15 min by
 * default) for the frontend to hold in memory and send as `Authorization: Bearer <token>`.
 */
import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { controlPrisma } from "../config/control-prisma.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { requireAuth } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import { avatarUpload, preserveTenantContext } from "../middleware/upload.js";
import { validate } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import { buildProfilePayload, changePassword, completeSsoLogin, login, refresh, requestPasswordReset, resetPassword } from "../services/auth.service.js";
import { getOnboardingStatus } from "../services/onboarding.service.js";
import { authenticateLdap } from "../services/sso.service.js";
import { dispatchTransactional } from "../services/notify.service.js";
import { templates } from "../services/mail-templates.js";
import { processAvatar } from "../utils/image.js";
import { sanitizeRichText } from "../utils/sanitize.js";

export const authRouter = Router();

const REFRESH_COOKIE = "refreshToken";

function refreshCookieOptions(expiresAt?: Date) {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/api/auth",
    expires: expiresAt
  };
}

/**
 * Public (unauthenticated) — the login page calls this before rendering, to know which
 * buttons to show for the org the current subdomain resolved to (see middleware/tenant.ts,
 * already run for this route since it's a normal /api/auth/* route, unlike the SSO
 * start/callback routes which bypass it — see controllers/sso.controller.ts's header comment).
 */
authRouter.get("/sso-methods", async (_req, res) => {
  const { orgId } = requireTenantContext();
  const [configs, authMethod] = await Promise.all([
    controlPrisma.orgSsoConfig.findMany({ where: { organizationId: orgId, isEnabled: true } }),
    controlPrisma.orgAuthMethod.findUnique({ where: { organizationId: orgId } })
  ]);
  const isFullyConfigured = (c: (typeof configs)[number]) => {
    if (c.providerType === "SAML") return Boolean(c.idpEntityId && c.idpSsoUrl && c.idpCertificate);
    if (c.providerType === "LDAP") return Boolean(c.ldapUrl && c.ldapBindDn && c.encryptedLdapBindCredential && c.ldapSearchBase);
    return Boolean(c.clientId && c.encryptedClientSecret);
  };

  res.json({
    passwordEnabled: (authMethod?.passwordLoginEnabled ?? true) && !authMethod?.requireSsoOnly,
    providers: configs.filter(isFullyConfigured).map((c) => c.providerType)
  });
});

authRouter.post(
  "/login",
  validate(z.object({ body: z.object({ email: z.string().email(), password: z.string().min(8), rememberMe: z.boolean().optional() }) })),
  async (req, res) => {
    const result = await login(req.body.email, req.body.password, req.body.rememberMe, req.headers["user-agent"], req.ip);
    res.cookie(REFRESH_COOKIE, result.refreshToken, refreshCookieOptions(result.refreshTokenExpiresAt));
    res.json({ accessToken: result.accessToken, user: result.user });
  }
);

/** LDAP is the one SSO provider that's a direct bind rather than a redirect (see
 *  services/sso.service.ts's LDAP section), so unlike Google/Microsoft/SAML it has no separate
 *  entry in controllers/sso.controller.ts — it's resolved via the normal Host-header tenant
 *  middleware exactly like password login, and returns the same JSON shape as /login rather
 *  than a redirect. */
authRouter.post(
  "/login/ldap",
  validate(z.object({ body: z.object({ email: z.string().email(), password: z.string().min(1) }) })),
  async (req, res) => {
    const { orgId } = requireTenantContext();
    const identity = await authenticateLdap(orgId, req.body.email, req.body.password);
    const result = await completeSsoLogin(orgId, identity, req.headers["user-agent"], req.ip);
    res.cookie(REFRESH_COOKIE, result.refreshToken, refreshCookieOptions(result.refreshTokenExpiresAt));
    res.json({ accessToken: result.accessToken, user: result.user });
  }
);

authRouter.post("/refresh", async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE];
  const result = await refresh(token);
  res.cookie(REFRESH_COOKIE, result.refreshToken, refreshCookieOptions(result.refreshTokenExpiresAt));
  res.json({ accessToken: result.accessToken });
});

authRouter.post("/logout", requireAuth, async (req, res) => {
  if (req.sessionId) {
    await prisma.session.update({ where: { id: req.sessionId }, data: { revokedAt: new Date() } }).catch(() => undefined);
  } else {
    // Access token predates the sid claim — fall back to the safest option, revoke everything.
    await prisma.session.updateMany({ where: { userId: req.user!.id, revokedAt: null }, data: { revokedAt: new Date() } });
  }
  res.clearCookie(REFRESH_COOKIE, { path: "/api/auth" });
  res.status(204).send();
});

/** "Log out everywhere" — distinct from /logout, which only ends the calling device's session. */
authRouter.post("/logout-all", requireAuth, async (req, res) => {
  await prisma.session.updateMany({ where: { userId: req.user!.id, revokedAt: null }, data: { revokedAt: new Date() } });
  res.clearCookie(REFRESH_COOKIE, { path: "/api/auth" });
  res.status(204).send();
});

authRouter.get("/sessions", requireAuth, async (req, res) => {
  const sessions = await prisma.session.findMany({
    where: { userId: req.user!.id, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
    select: { id: true, userAgent: true, ipAddress: true, createdAt: true, expiresAt: true }
  });
  res.json(sessions.map((s) => ({ ...s, current: s.id === req.sessionId })));
});

authRouter.delete("/sessions/:id", requireAuth, async (req, res) => {
  const session = await prisma.session.findFirst({ where: { id: String(req.params.id), userId: req.user!.id } });
  if (!session) throw new AppError(404, "Session not found");
  await prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
  res.status(204).send();
});

/**
 * The 15-second liveness beat the app shell polls. Two jobs in one cheap round-trip:
 * 1. If this session was revoked (admin force-logout, single-device sign-out), requireAuth
 *    answers 401 within one beat — which is what makes an admin's "sign out everywhere" land
 *    on the target's screen in seconds instead of whenever they next click something.
 * 2. requireAuth's throttled lastSeenAt stamp keeps an open-but-idle tab "online" in the admin
 *    panels — the honest answer to "who will lose work if I start maintenance now?".
 * Deliberately not /me: this runs 4×/min per signed-in user, and /me rebuilds the full profile
 * payload every call; this does two indexed lookups.
 */
authRouter.get("/heartbeat", requireAuth, async (_req, res) => {
  res.json({ ok: true });
});

authRouter.get("/me", requireAuth, async (req, res) => {
  res.json(await buildProfilePayload(req.user!.id));
});

/**
 * Whether first-run setup still blocks this person.
 *
 * Its own endpoint rather than a field on /me because it reads workspace face-verification policy
 * as well as the user row, and /me is on the hot path of every page load. Computed server-side —
 * a gate the client decides for itself is a gate anyone can open with devtools.
 */
authRouter.get("/onboarding-status", requireAuth, async (req, res) => {
  res.json(await getOnboardingStatus(req.user!.id));
});

authRouter.post(
  "/forgot-password",
  validate(z.object({ body: z.object({ email: z.string().email() }) })),
  async (req, res) => {
    const result = await requestPasswordReset(req.body.email);
    // Only look up / email a real match, but the response is identical either way —
    // otherwise the response itself becomes an account-enumeration oracle.
    if (result) {
      await dispatchTransactional({
        to: result.user.email,
        templateKey: "reset",
        vars: { resetUrl: result.resetUrl, appUrl: env.APP_BASE_URL },
        fallback: { subject: "Reset your Timesheet Portal password", html: templates.reset(result.resetUrl) }
      });
    }
    res.status(202).json({ message: "If the account exists, reset instructions were sent." });
  }
);

authRouter.post(
  "/reset-password",
  validate(z.object({ body: z.object({ token: z.string().min(10), password: z.string().min(8) }) })),
  async (req, res) => {
    await resetPassword(req.body.token, req.body.password);
    res.status(204).send();
  }
);

authRouter.post(
  "/change-password",
  requireAuth,
  validate(
    z.object({
      body: z.object({
        currentPassword: z.string().min(8),
        nextPassword: z.string().min(8)
      })
    })
  ),
  async (req, res) => {
    await changePassword(req.user!.id, req.body.currentPassword, req.body.nextPassword, req.sessionId);
    res.status(204).send();
  }
);

const profilePatchSchema = z.object({
  body: z.object({
    name: z.string().min(2).max(80).optional(),
    bio: z.string().max(600).optional().nullable(),
    phoneNumber: z.string().max(40).optional().nullable(),
    timezone: z.string().max(80).optional().nullable()
  })
});

authRouter.patch("/profile", requireAuth, validate(profilePatchSchema), async (req, res) => {
  const data: any = {};
  if (typeof req.body.name === "string") data.name = req.body.name.trim();
  if ("bio" in req.body) {
    data.bio = req.body.bio === null ? null : sanitizeRichText(req.body.bio ?? "").slice(0, 600) || null;
  }
  if ("phoneNumber" in req.body) data.phoneNumber = req.body.phoneNumber === null ? null : (req.body.phoneNumber ?? "").trim() || null;
  if ("timezone" in req.body) data.timezone = req.body.timezone === null ? null : (req.body.timezone ?? "").trim() || null;

  if (Object.keys(data).length === 0) throw new AppError(422, "No profile fields provided");

  await prisma.user.update({ where: { id: req.user!.id }, data });
  await audit(req.user!.id, "user.profile_updated", "User", req.user!.id, data);
  res.json(await buildProfilePayload(req.user!.id));
});

authRouter.post("/avatar", requireAuth, preserveTenantContext(avatarUpload.single("avatar")), async (req, res) => {
  const file = (req as any).file as Express.Multer.File | undefined;
  if (!file?.buffer) throw new AppError(422, "No avatar file provided");

  const destDir = path.join(env.UPLOAD_DIR, "avatars");
  let processed;
  try {
    processed = await processAvatar(file.buffer, req.user!.id, destDir);
  } catch {
    throw new AppError(422, "Could not decode image — corrupted or unsupported format");
  }

  const before = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { avatarUrl: true } });
  const avatarUrl = `/uploads/avatars/${processed.filename}`;

  await prisma.user.update({ where: { id: req.user!.id }, data: { avatarUrl } });
  await audit(req.user!.id, "user.avatar_updated", "User", req.user!.id, {
    width: processed.width,
    height: processed.height,
    sizeBytes: processed.sizeBytes,
    mimeType: processed.mimeType
  });

  if (before?.avatarUrl && before.avatarUrl.startsWith("/uploads/avatars/")) {
    const oldPath = path.join(env.UPLOAD_DIR, "avatars", path.basename(before.avatarUrl));
    fs.promises.unlink(oldPath).catch(() => undefined);
  }

  res.json(await buildProfilePayload(req.user!.id));
});

authRouter.delete("/avatar", requireAuth, async (req, res) => {
  const before = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { avatarUrl: true } });
  await prisma.user.update({ where: { id: req.user!.id }, data: { avatarUrl: null } });
  await audit(req.user!.id, "user.avatar_removed", "User", req.user!.id);
  if (before?.avatarUrl && before.avatarUrl.startsWith("/uploads/avatars/")) {
    const oldPath = path.join(env.UPLOAD_DIR, "avatars", path.basename(before.avatarUrl));
    fs.promises.unlink(oldPath).catch(() => undefined);
  }
  res.json(await buildProfilePayload(req.user!.id));
});
