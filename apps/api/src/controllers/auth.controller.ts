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
import { roles, ACCENT_IDS, AI_ANSWER_STYLES, DENSITIES, THEME_MODES, type AccentId, type AiAnswerStyle } from "@timesheet/shared";
import { env } from "../config/env.js";
import { avatarsDir, resolveWithin } from "../config/storage-paths.js";
import { prisma } from "../config/prisma.js";
import { controlPrisma } from "../config/control-prisma.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { requireAuth } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import { avatarUpload, preserveTenantContext } from "../middleware/upload.js";
import { validate } from "../middleware/validate.js";
import { audit } from "../services/audit.service.js";
import {
  buildProfilePayload,
  changePassword,
  completeSsoLogin,
  endSessions,
  login,
  refresh,
  requestPasswordReset,
  resetPassword,
  switchActiveRole
} from "../services/auth.service.js";
import { getOnboardingStatus } from "../services/onboarding.service.js";
import { authenticateLdap, recordSsoLoginSuccess } from "../services/sso.service.js";
import {
  checkVerificationCode,
  countRecentVerificationCodes,
  findWorkspacesForEmail,
  newVerificationCode,
  storeVerificationCode
} from "../services/workspace-directory.service.js";
import { withOrgTenant } from "../config/with-org-tenant.js";
import { isRootDomainRequest } from "../middleware/tenant.js";
import { dispatchTransactional } from "../services/notify.service.js";
import { templates } from "../services/mail-templates.js";
import { processAvatar } from "../utils/image.js";
import { isValidTimezone, normalizePhoneNumber } from "../utils/phone.js";
import { sanitizeRichText } from "../utils/sanitize.js";
import { isPrivateIpAddress, parseUserAgent } from "../utils/user-agent.js";
import { attachDeviceId } from "../utils/device-cookie.js";
import { REFRESH_COOKIE, clearRefreshCookie, refreshCookieOptions } from "../utils/refresh-cookie.js";
import { redeemHandoffCode } from "../services/sso-handoff.service.js";

export const authRouter = Router();

/** Finder codes one address may be sent per hour (security audit #5). */
export const DISCOVERY_CODES_PER_ADDRESS_PER_HOUR = 3;


/**
 * Public (unauthenticated) — the login page calls this before rendering, to know which
 * buttons to show for the org the current subdomain resolved to (see middleware/tenant.ts,
 * already run for this route since it's a normal /api/auth/* route, unlike the SSO
 * start/callback routes which bypass it — see controllers/sso.controller.ts's header comment).
 */
authRouter.get("/sso-methods", async (req, res) => {
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
    providers: configs.filter(isFullyConfigured).map((c) => c.providerType),
    /**
     * TRUE when this request arrived at the deployment's BARE ROOT DOMAIN rather than at any
     * workspace — so the login page can send the visitor to the workspace finder instead of
     * rendering a sign-in form for a workspace they did not ask for.
     *
     * WHY IT RIDES ON THIS RESPONSE. The login page already awaits this call before it can decide
     * which buttons to draw, so the answer costs nothing extra and arrives before anything is
     * rendered. A dedicated endpoint would be a second round trip to learn something about the same
     * request.
     *
     * WHY IT EXISTS AT ALL. `isRootDomainRequest` was written for exactly this, documented as "what
     * lets the routing layer serve the finder", and had NO CALLERS anywhere in the repository — so
     * the apex went on resolving to `DEFAULT_ORG_SLUG` and serving one specific customer's branded
     * login page to everybody who typed the domain without a subdomain. Both `.env.example` and
     * docs/DEPLOYMENT.md described the fixed behaviour; only the code disagreed.
     *
     * Always `false` on a single-org deployment, where the bare domain IS the one workspace and
     * there is nothing to choose between.
     */
    apex: isRootDomainRequest(req)
  });
});

authRouter.post(
  "/login",
  validate(z.object({ body: z.object({ email: z.string().email(), password: z.string().min(8), rememberMe: z.boolean().optional() }) })),
  async (req, res) => {
    // One browser, one session row — see utils/device-cookie.ts for why this is a grouping key
    // and never an authenticator.
    const deviceId = attachDeviceId(req, res);
    const result = await login(req.body.email, req.body.password, req.body.rememberMe, req.headers["user-agent"], req.ip, deviceId);
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
    const deviceId = attachDeviceId(req, res);
    const result = await completeSsoLogin(orgId, identity, req.headers["user-agent"], req.ip, deviceId);
    // Same stamp the redirect-based providers get in sso.controller.ts#finishSsoLogin. LDAP has no
    // callback to hang it on, so it goes here — and after the session exists, for the same reason.
    await recordSsoLoginSuccess(orgId, "LDAP");
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

/**
 * Sign out of THIS browser. Deliberately NOT behind `requireAuth` (security audit #9).
 *
 * It used to be, so it inherited every reason `requireAuth` refuses — 503 during maintenance for
 * anyone but a super admin, 402 on a lapsed plan, 401 once the access token had expired in an idle
 * tab — and each refusal left the refresh cookie and the server session alive, so the next page load
 * signed the person straight back in. The session is now named by the refresh cookie (and by an
 * access token's `sid` when one is sent); see auth.service.ts#endSessions.
 *
 * THE COOKIE IS ALWAYS CLEARED and the answer is always 204: before any work here, and again by
 * app.ts ahead of tenant resolution, so even a workspace that can no longer be resolved removes it.
 * A revocation that fails is logged — the browser is still signed out, and the session dies with its
 * own expiry.
 */
authRouter.post("/logout", async (req, res) => {
  clearRefreshCookie(res);
  const header = req.headers.authorization ?? "";
  try {
    await endSessions({
      refreshToken: req.cookies?.[REFRESH_COOKIE],
      accessToken: header.startsWith("Bearer ") ? header.slice(7).trim() : undefined
    });
  } catch (error) {
    console.error(`[auth] sign-out could not revoke its session: ${(error as Error).message}`);
  }
  res.status(204).send();
});

/** "Log out everywhere" — distinct from /logout, which only ends the calling device's session. */
authRouter.post("/logout-all", requireAuth, async (req, res) => {
  await prisma.session.updateMany({ where: { userId: req.user!.id, revokedAt: null }, data: { revokedAt: new Date() } });
  clearRefreshCookie(res);
  res.status(204).send();
});

/**
 * The signed-in person's own devices.
 *
 * DECODED, NOT RAW. This used to return the verbatim `userAgent` string and let the page render
 * it, which meant the answer to "is there a session here that shouldn't be?" was a wall of
 * "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)…" — technically
 * complete and practically unreadable. `parseUserAgent` already existed for the admin panel, which
 * had the same problem and solved it; this route simply stopped being the exception.
 *
 * ORDERED BY LAST ACTIVITY, not creation: "which of these is stale?" is the question being asked,
 * and creation time answers a different one. `lastSeenAt` is what the heartbeat maintains.
 *
 * The raw string is deliberately NOT returned alongside the label. It is a fingerprinting surface
 * with no remaining purpose once the label exists, and the one place that genuinely needs the
 * original — an admin investigating — reads the database.
 */
authRouter.get("/sessions", requireAuth, async (req, res) => {
  const sessions = await prisma.session.findMany({
    where: { userId: req.user!.id, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: [{ lastSeenAt: "desc" }, { createdAt: "desc" }],
    select: { id: true, userAgent: true, ipAddress: true, createdAt: true, expiresAt: true, lastSeenAt: true }
  });

  res.json(
    sessions.map((session) => {
      const device = parseUserAgent(session.userAgent);
      return {
        id: session.id,
        ipAddress: session.ipAddress,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        lastSeenAt: session.lastSeenAt,
        current: session.id === req.sessionId,
        device: device.label,
        browser: device.browser,
        os: device.os,
        formFactor: device.formFactor,
        // On a LAN deployment every address is a 192.168.x and a column of them tells an admin
        // nothing. Saying which are local removes that ambiguity where it matters. A display
        // hint, never an authorization input.
        privateNetwork: isPrivateIpAddress(session.ipAddress)
      };
    })
  );
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
 * Self-service switch among roles you already hold — granting a NEW role is SUPER_ADMIN-only,
 * from User Management (see user.controller.ts). No JWT re-issue: the access token carries no
 * role claims, so the next request under the existing token is already governed by the new role.
 */
authRouter.post(
  "/switch-role",
  requireAuth,
  validate(z.object({ body: z.object({ role: z.enum(roles) }).strict() })),
  async (req, res) => {
    res.json(await switchActiveRole(req.user!.id, req.body.role));
  }
);

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

/**
 * Work an unauthenticated mail route does AFTER it has already answered.
 *
 * WHY REPLY FIRST (security audit #6). Both mail-sending routes below answer the same body whether
 * or not the address matched — but they used to answer only after the lookup, the token write and
 * the SMTP send for a real account, and after a single lookup for an unknown one. The difference
 * was measurable from outside, so the response TIME said whether the address existed even though
 * the body did not. Replying first leaves nothing about the address to time.
 *
 * Errors are caught and logged rather than passed on: the response is already on the wire, so
 * there is nobody left to send an error to, and Express would only complain about headers.
 */
async function afterReply(label: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    console.error(`[auth] ${label} failed after replying: ${(error as Error).message}`);
  }
}

authRouter.post(
  "/forgot-password",
  validate(z.object({ body: z.object({ email: z.string().email() }) })),
  async (req, res) => {
    // Identical whether or not the address matched, and sent before anything is looked up — see
    // `afterReply` for why the ORDER matters as much as the wording.
    res.status(202).json({ message: "If the account exists, reset instructions were sent." });

    await afterReply("forgot-password", async () => {
      // Null for an unknown or inactive address, for a workspace that has password sign-in switched
      // off, and for an address already sent its hourly allowance of links (auth.service.ts).
      const result = await requestPasswordReset(req.body.email);
      if (!result) return;
      await dispatchTransactional({
        to: result.user.email,
        templateKey: "reset",
        vars: { resetUrl: result.resetUrl, appUrl: env.APP_BASE_URL },
        fallback: { subject: "Reset your Timesheet Portal password", html: templates.reset(result.resetUrl) },
        // The rendered body contains the LIVE reset token, which the database stores only as a
        // hash precisely so database access cannot yield a usable one — and the retry queue's
        // stored body would hand that straight back. Never persisted, therefore never retried —
        // a token that expires in thirty minutes is worthless by the time a retry would run, and
        // asking for another link is one click.
        sensitive: true
      });
    });
  }
);

/**
 * POST /sso/handoff — redeem a one-time code minted by the SSO callback, on the workspace's own
 * hostname.
 *
 * WHY THE SESSION ARRIVES THIS WAY. OAuth requires one registered `redirect_uri`, so every
 * workspace's sign-in returns to a single callback host. The cookie has to be written by a request
 * whose `Host` is the workspace, or the browser cannot read it — see
 * services/sso-handoff.service.ts. This route is the second half of that hop, and it runs behind the
 * normal tenant middleware, so `requireTenantContext()` below is the workspace the browser is
 * actually on.
 *
 * THE ORG CHECK IS THE SECURITY PROPERTY. The code is bound to the organization it was minted for,
 * and redeeming it anywhere else fails — otherwise a code for one workspace could be redeemed at
 * another's origin and write the first workspace's refresh cookie onto the second's hostname.
 *
 * ONE MESSAGE FOR BOTH FAILURES, deliberately: an expired code and a code for another workspace are
 * both "this did not work, sign in again", and distinguishing them would tell an anonymous caller
 * whether a code they hold is real.
 *
 * Not rate-limited beyond the global limiter: the code is 32 random bytes and single-use, so there
 * is nothing to guess at a rate worth limiting.
 */
authRouter.post(
  "/sso/handoff",
  validate(z.object({ body: z.object({ code: z.string().min(1).max(200) }) })),
  async (req, res) => {
    const { orgId } = requireTenantContext();
    const result = await redeemHandoffCode(req.body.code, orgId);
    if (!result.ok) throw new AppError(401, "This sign-in link has expired. Please sign in again.");

    res.cookie(REFRESH_COOKIE, result.payload.refreshToken, refreshCookieOptions(result.payload.refreshTokenExpiresAt));
    res.json({ accessToken: result.payload.accessToken, user: result.payload.user });
  }
);

/* ─────────────────────────────────────────────────────────────────────────────────────────────
 * Workspace discovery — "I don't remember my workspace address".
 *
 * TWO STEPS, AND THE SPLIT IS THE SECURITY PROPERTY. A single endpoint that answered "which
 * workspaces is bob@acme.com in?" would tell anybody who asked that bob@acme.com exists and where
 * he works — reintroducing, one route over, exactly the enumeration `resolveActiveOrgBySlug` goes
 * out of its way to prevent. So `start` always answers 202 whether or not the address matched, and
 * the list is only reachable by returning a code sent to that address.
 *
 * It is the same bar `/forgot-password` above already sets, and for the same reason: the cost of
 * discovery should be an inbox the attacker does not control.
 * ───────────────────────────────────────────────────────────────────────────────────────────── */

authRouter.post(
  "/workspaces/start",
  validate(z.object({ body: z.object({ email: z.string().email() }) })),
  async (req, res) => {
    const email: string = req.body.email;
    // The token is minted even for a miss, and is a real, unguessable token. Skipping it for
    // unknown addresses would make the RESPONSE the oracle the 202 exists to close — a client
    // could tell a hit from a miss by whether it got one. Minted in memory and handed back BEFORE
    // anything is looked up, for the timing reason `afterReply` explains.
    const minted = newVerificationCode();
    res.status(202).json({ token: minted.token, message: "If that address belongs to a workspace, a code is on its way." });

    await afterReply("workspaces/start", async () => {
      // Three codes per address per hour (audit #5), counted in the control plane every replica
      // shares. Past it nothing is stored or sent; the token already returned simply never
      // verifies, exactly like a miss.
      if ((await countRecentVerificationCodes(email, "discover")) >= DISCOVERY_CODES_PER_ADDRESS_PER_HOUR) return;
      const workspaces = await findWorkspacesForEmail(email);
      // Stored for a miss too — `/workspaces/verify` must treat both the same way.
      await storeVerificationCode(email, "discover", minted);
      if (workspaces.length === 0) return;

      // Sent through the FIRST matched workspace's own tenant context, so it uses that workspace's
      // configured SMTP and logs to its own EmailLog — a control-plane route has no mail settings
      // of its own, and attributing the send to the workspace it is about is the honest place for
      // it to appear in delivery analytics.
      await withOrgTenant(workspaces[0].slug, async () => {
        await dispatchTransactional({
          to: email,
          templateKey: "workspace.find",
          vars: { code: minted.code, appUrl: env.APP_BASE_URL },
          fallback: {
            // Not in the subject — see the same note on the registered template: EmailLog stores
            // subjects even for `sensitive` mail, and workspace admins can read them.
            subject: "Your TimeSphere verification code",
            html: templates.workspaceFind(minted.code)
          },
          // The body contains a LIVE code. Never persisted, therefore never retried — same
          // reasoning as the password-reset mail above.
          sensitive: true
        });
      });
    });
  }
);

authRouter.post(
  "/workspaces/verify",
  validate(z.object({ body: z.object({ token: z.string().min(1).max(200), code: z.string().min(4).max(12) }) })),
  async (req, res) => {
    const check = await checkVerificationCode(req.body.token, req.body.code, "discover");
    if (!check.ok) {
      // Deliberately does NOT distinguish "wrong code" from "this address matched nothing" — the
      // two must look identical, or the failure message becomes the oracle again.
      throw new AppError(
        check.reason === "exhausted" ? 429 : 400,
        check.reason === "exhausted"
          ? "Too many attempts. Request a new code."
          : "That code isn't right, or it has expired. Request a new one."
      );
    }
    res.json({ workspaces: await findWorkspacesForEmail(check.email) });
  }
);

authRouter.post(
  "/reset-password",
  validate(z.object({ body: z.object({ token: z.string().min(10).max(200), password: z.string().min(8) }) })),
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
      // The authoritative "not the same password" rule is `changePassword`'s hash comparison —
      // this is the free half of it: identical strings never need a bcrypt round-trip, and the
      // error arrives attached to the field the user has to fix.
      body: z
        .object({
          currentPassword: z.string().min(8),
          nextPassword: z.string().min(8)
        })
        .refine((body) => body.currentPassword !== body.nextPassword, {
          message: "Your new password must be different from your current one.",
          path: ["nextPassword"]
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
    timezone: z.string().max(80).optional().nullable(),
    // Validated against the SHARED definition, not a local enum: a palette id the API accepted but
    // the web did not know would save cleanly and then paint nothing. `null` clears the preference
    // (back to "follow the OS, default accent"); an absent key leaves it untouched.
    appearance: z
      .object({
        mode: z.enum(THEME_MODES).optional().nullable(),
        accent: z.enum(ACCENT_IDS as [AccentId, ...AccentId[]]).optional().nullable(),
        density: z.enum(DENSITIES).optional().nullable()
      })
      .strict()
      .optional()
      .nullable(),
    // Same rule as `appearance` above, and the same reason: validated against the SHARED list, so a
    // style the API accepted but neither the picker nor AI_ANSWER_STYLE_GUIDANCE knew would save
    // cleanly and then do nothing — which is worse than refusing it, because the person would
    // believe they had changed something.
    aiPreferences: z
      .object({
        answerStyle: z.enum(AI_ANSWER_STYLES as unknown as [AiAnswerStyle, ...AiAnswerStyle[]]).optional().nullable()
      })
      .strict()
      .optional()
      .nullable()
  })
});

authRouter.patch("/profile", requireAuth, validate(profilePatchSchema), async (req, res) => {
  const data: any = {};
  if (typeof req.body.name === "string") data.name = req.body.name.trim();
  if ("bio" in req.body) {
    data.bio = req.body.bio === null ? null : sanitizeRichText(req.body.bio ?? "").slice(0, 600) || null;
  }
  if ("phoneNumber" in req.body) {
    const raw = req.body.phoneNumber === null ? "" : (req.body.phoneNumber ?? "").trim();
    if (!raw) {
      data.phoneNumber = null;
    } else {
      // Validated and normalized SERVER-side — the client's own check is convenience, not a
      // boundary. Stored as E.164 so every consumer starts from one canonical format.
      const check = normalizePhoneNumber(raw);
      if (!check.ok) throw new AppError(422, check.message);
      data.phoneNumber = check.e164;
    }
  }
  if ("timezone" in req.body) {
    const tz = req.body.timezone === null ? "" : (req.body.timezone ?? "").trim();
    if (!tz) {
      data.timezone = null;
    } else {
      if (!isValidTimezone(tz)) throw new AppError(422, `"${tz}" is not a valid IANA timezone (e.g. Asia/Kolkata, America/New_York).`);
      data.timezone = tz;
    }
  }

  if ("appearance" in req.body) {
    // Stored as exactly the validated shape and nothing else — a JSON column is a place where
    // extra keys accumulate unless the write is explicit about what it keeps.
    const a = req.body.appearance;
    data.appearance =
      a === null
        ? null
        : { ...(a.mode ? { mode: a.mode } : {}), ...(a.accent ? { accent: a.accent } : {}), ...(a.density ? { density: a.density } : {}) };
  }

  if ("aiPreferences" in req.body) {
    // "default" is the ABSENCE of a preference, not a preference, so choosing it clears the row
    // rather than storing the word. The browser copy has always behaved that way
    // (apps/web/src/lib/ai-answer-style.ts), and if the server disagreed, "reset" would leave a
    // stored preference behind that the person believes they deleted. That is a retention promise.
    const prefs = req.body.aiPreferences;
    const style = prefs === null ? null : prefs?.answerStyle;
    data.aiPreferences = !style || style === "default" ? null : { answerStyle: style };
  }

  if (Object.keys(data).length === 0) throw new AppError(422, "No profile fields provided");

  await prisma.user.update({ where: { id: req.user!.id }, data });
  await audit(req.user!.id, "user.profile_updated", "User", req.user!.id, data);
  res.json(await buildProfilePayload(req.user!.id));
});

/**
 * Maps a stored `User.avatarUrl` back to the file it names, or `null` if it names nothing we own.
 *
 * The value comes out of the database, but it was ALSO written there by this controller in two
 * different shapes across two versions (flat `avatars/<file>`, and per-user `avatars/<id>/<file>`),
 * so it can't be parsed by assuming either. `resolveWithin` is what makes reading it safe: the
 * relative part is joined onto the avatars directory and rejected outright if it lands anywhere
 * else, so even a row someone managed to poison can only ever address a file inside that tree.
 */
function resolveAvatarFile(avatarUrl: string | null | undefined): string | null {
  const prefix = "/uploads/avatars/";
  if (!avatarUrl?.startsWith(prefix)) return null;
  return resolveWithin(avatarsDir(), decodeURIComponent(avatarUrl.slice(prefix.length)));
}

authRouter.post("/avatar", requireAuth, preserveTenantContext(avatarUpload.single("avatar")), async (req, res) => {
  const file = (req as any).file as Express.Multer.File | undefined;
  if (!file?.buffer) throw new AppError(422, "No avatar file provided");

  // Per-user subdirectory: an avatar tree with one flat directory per install becomes tens of
  // thousands of sibling files (every re-upload adds one until the old is unlinked), which is
  // slow to list and impossible to reason about when someone asks "delete this person's data".
  // Legacy flat avatars are untouched and keep serving — see the deletion path below, which
  // resolves whatever URL is on the row rather than assuming either layout.
  const destDir = path.join(avatarsDir(), req.user!.id);
  await fs.promises.mkdir(destDir, { recursive: true });
  let processed;
  try {
    processed = await processAvatar(file.buffer, req.user!.id, destDir);
  } catch (error) {
    // RE-THROW A DELIBERATE AppError. This catch was written for sharp failing on a corrupt file,
    // and a bare `catch {}` rewrote EVERY error as "could not decode" — including, once the malware
    // scan moved inside processAvatar, "the scanner is unreachable" and "this file is infected".
    // Telling somebody their PNG is corrupt when it was actually refused by a virus scanner is the
    // worst kind of wrong message: it sends them to re-export the image instead of to an admin.
    if (error instanceof AppError) throw error;
    throw new AppError(422, "Could not decode image — corrupted or unsupported format");
  }

  const before = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { avatarUrl: true } });
  const avatarUrl = `/uploads/avatars/${req.user!.id}/${processed.filename}`;

  await prisma.user.update({ where: { id: req.user!.id }, data: { avatarUrl } });
  await audit(req.user!.id, "user.avatar_updated", "User", req.user!.id, {
    width: processed.width,
    height: processed.height,
    sizeBytes: processed.sizeBytes,
    mimeType: processed.mimeType
  });

  const oldPath = resolveAvatarFile(before?.avatarUrl);
  if (oldPath) fs.promises.unlink(oldPath).catch(() => undefined);

  res.json(await buildProfilePayload(req.user!.id));
});

authRouter.delete("/avatar", requireAuth, async (req, res) => {
  const before = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { avatarUrl: true } });
  await prisma.user.update({ where: { id: req.user!.id }, data: { avatarUrl: null } });
  await audit(req.user!.id, "user.avatar_removed", "User", req.user!.id);
  const oldPath = resolveAvatarFile(before?.avatarUrl);
  if (oldPath) fs.promises.unlink(oldPath).catch(() => undefined);
  res.json(await buildProfilePayload(req.user!.id));
});
