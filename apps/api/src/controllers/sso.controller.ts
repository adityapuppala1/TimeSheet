/**
 * SSO start/callback routes. Deliberately mounted on `app` BEFORE the blanket
 * `app.use("/api", resolveTenant)` in app.ts, so these two routes never go through the normal
 * subdomain-based tenant-resolution middleware:
 *  - `/start` resolves org from the Host header itself (via the same resolveRequestOrgSlug the
 *    normal middleware uses, verified custom domains first) since it only needs the control-plane,
 *    not a tenant DB connection, to build the redirect.
 *  - `/callback` CANNOT rely on the Host header at all — the provider redirects back to one
 *    fixed callback URL shared by every org, so by definition it isn't that org's own
 *    subdomain. Org identity instead comes entirely from the signed `state` parameter (see
 *    services/sso.service.ts), and this handler manually resolves+attaches the right tenant
 *    context for the one write (find-or-create user, create session) it needs to make.
 */
import express, { Router, type Request, type Response } from "express";
import { z } from "zod";
import { controlPrisma } from "../config/control-prisma.js";
import { getTenantClient } from "../config/prisma.js";
import { tenantContext } from "../config/tenant-context.js";
import { env } from "../config/env.js";
import { resolveActiveOrgBySlug, resolveRequestOrgSlug } from "../middleware/tenant.js";
import { AppError } from "../middleware/error.js";
import { ssoErrorCodeFor, ssoErrorCodeForProviderError, type SsoErrorCode } from "../utils/sso-error-code.js";
import { completeSsoLogin } from "../services/auth.service.js";
import { attachDeviceId } from "../utils/device-cookie.js";
import {
  buildAuthorizationRedirect,
  buildSamlAuthorizationRedirect,
  completeAuthorizationCodeGrant,
  completeSamlLogin,
  recordSsoLoginSuccess,
  verifySsoState,
  type OidcProviderType
} from "../services/sso.service.js";
import { decryptSecret } from "../utils/encryption.js";
import { issueHandoffCode } from "../services/sso-handoff.service.js";
import { workspaceUrlForSlug } from "../services/workspace-directory.service.js";

export const ssoRouter = Router();

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

const providerParam = z.enum(["google", "microsoft"]).transform((v) => v.toUpperCase() as OidcProviderType);

/** Shared tail for every SSO callback (OIDC + SAML alike): resolve the tenant for the org the
 *  signed state/RelayState named, run completeSsoLogin inside that tenant's context, set the
 *  refresh cookie, and redirect into the app — identical to what a normal password login's
 *  establishSession tail does, just reached from a different front door. */
async function finishSsoLogin(
  req: import("express").Request,
  res: import("express").Response,
  orgId: string,
  identity: Parameters<typeof completeSsoLogin>[1],
  /** Which provider got this person in — recorded so `requireSsoOnly` can tell a configuration
   *  that demonstrably works from one that has merely been filled in. */
  provider: "GOOGLE" | "MICROSOFT" | "SAML"
) {
  const org = await controlPrisma.organization.findUniqueOrThrow({ where: { id: orgId }, include: { database: true } });
  if (!org.database) throw new AppError(404, "Unknown workspace.");
  const dsn = decryptSecret(org.database.encryptedDsn);
  const tenantClient = await getTenantClient(org.id, dsn);

  // Read/mint BEFORE the redirect that ends this response — see utils/device-cookie.ts. Without
  // it, SSO users would be the one login path still adding a session row per sign-in.
  const deviceId = attachDeviceId(req, res);
  const result = await tenantContext.run({ orgId: org.id, orgSlug: org.slug, client: tenantClient }, () =>
    completeSsoLogin(org.id, identity, req.headers["user-agent"], req.ip, deviceId)
  );

  // AFTER the session exists, never before: this stamp is evidence that a sign-in completed, and
  // recording it for one that then failed is exactly the false assurance the gate exists to avoid.
  await recordSsoLoginSuccess(org.id, provider);

  /**
   * WHERE THIS BROWSER ACTUALLY BELONGS, which is not necessarily where the callback landed.
   *
   * OAuth requires ONE registered `redirect_uri`, so every workspace's sign-in comes back to the
   * host in `APP_BASE_URL`. Tenant resolution copes (the org comes from the signed state) but the
   * SESSION did not: the refresh cookie was written for the callback host and the browser was then
   * sent to `WEB_ORIGIN[0]`, so somebody who started at `acme.example.com` landed on a different
   * origin holding a cookie it cannot read — a sign-in that succeeds and shows a login page.
   *
   * Single-org deployments never take the second branch: with no ROOT_DOMAIN, `workspaceUrlForSlug`
   * IS `APP_BASE_URL`, so `sameOrigin` is true and the redirect below is byte-for-byte the one this
   * function has always done.
   */
  const workspaceUrl = workspaceUrlForSlug(org.slug);
  const landing = env.WEB_ORIGIN.split(",")[0].trim();
  const sameOrigin = originOf(workspaceUrl) === originOf(landing);

  if (sameOrigin) {
    res.cookie(REFRESH_COOKIE, result.refreshToken, refreshCookieOptions(result.refreshTokenExpiresAt));
    res.redirect(`${landing}/app`);
    return;
  }

  // Different origin: the cookie would be useless here. Park the session behind a one-time code and
  // let the workspace's own hostname redeem it, so the cookie is written by a request whose Host is
  // the workspace. See services/sso-handoff.service.ts for the code's lifetime and bindings.
  const code = await issueHandoffCode({
    orgId: org.id,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    refreshTokenExpiresAt: result.refreshTokenExpiresAt,
    user: result.user
  });
  res.redirect(`${workspaceUrl}/sso/handoff?code=${encodeURIComponent(code)}`);
}

/** Scheme+host+port, or the input when it is not a URL — used only to compare two configured bases. */
function originOf(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return value;
  }
}

/* ── Failures go back to the login page, never to JSON ──────────────────────────────────────────
   These routes are full-page navigations on the API host, outside the SPA. Handing a failure to the
   JSON error handler left a person who cancelled at Google, hit the seat limit or arrived during
   maintenance staring at `{"message":...}` with no way back (audit M3). Every failure now redirects
   to the login page of the workspace the attempt was for, with a code the page turns into words —
   see utils/sso-error-code.ts for why a code and not the message. */

const deploymentBase = () => env.APP_BASE_URL.replace(/\/$/, "");

/** The login page's origin for a workspace — the SAME rule finishSsoLogin applies to a success, so a
 *  failure lands where the success would have. */
function workspaceLoginBase(slug: string): string {
  const workspaceUrl = workspaceUrlForSlug(slug);
  const landing = env.WEB_ORIGIN.split(",")[0].trim();
  return originOf(workspaceUrl) === originOf(landing) ? landing : workspaceUrl;
}

/** When only the org id is known (callback/ACS, from the signed state). Unknown org — a forged or
 *  expired state — goes to the deployment's own login page, the one address that always exists. */
async function loginBaseForOrgId(orgId: string | null): Promise<string> {
  if (!orgId) return deploymentBase();
  try {
    const org = await controlPrisma.organization.findUnique({ where: { id: orgId }, select: { slug: true } });
    return org ? workspaceLoginBase(org.slug) : deploymentBase();
  } catch {
    return deploymentBase();
  }
}

/** The org a state/RelayState names, if it verifies — used only to choose where a FAILURE goes. */
function orgIdFromState(state: string): string | null {
  if (!state) return null;
  try {
    return verifySsoState(state).orgId;
  } catch {
    return null;
  }
}

/**
 * Sends the browser back with `?sso_error=`, and records the failures an operator can act on.
 *
 * NEVER THE REQUEST URL. The error handler logged `req.originalUrl` for every 500, and on the OIDC
 * callback that is the authorization code and the signed state. Only the error's own name and
 * message are written, and only for `failed`/`config` — a cancelled or inactive sign-in is a person's
 * answer, not something to page anyone about.
 */
function failSsoRedirect(res: Response, route: string, orgId: string | null, base: string, error: unknown, code: SsoErrorCode = ssoErrorCodeFor(error)) {
  if (code === "failed" || code === "config") {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : "unknown error";
    console.warn(`[sso] ${route} failed for org ${orgId ?? "unknown"} (${code}): ${detail}`);
  }
  if (!res.headersSent) res.redirect(`${base}/login?sso_error=${code}`);
}

/**
 * Which workspace a START request is for, resolved exactly as resolveTenant resolves it — verified
 * custom domain first (audit H4; see resolveRequestOrgSlug). Returns where to send a failure too: back
 * to the custom domain the person was on when they started there.
 */
async function resolveStartingWorkspace(req: Request): Promise<{ orgId: string; loginBase: string } | null> {
  try {
    const { slug, customDomain } = await resolveRequestOrgSlug(req);
    const org = await resolveActiveOrgBySlug(slug, req);
    return { orgId: org.id, loginBase: customDomain ? `https://${customDomain}` : workspaceLoginBase(org.slug) };
  } catch {
    return null;
  }
}

// SAML routes are registered BEFORE the parameterized `/:provider/start` + `/:provider/callback`
// OIDC routes below — Express matches routes in registration order, and `/:provider/start`
// would otherwise swallow `/saml/start` (matching "saml" as the :provider param) since it's a
// more general pattern registered against the same router.
ssoRouter.get("/saml/start", async (req, res) => {
  const workspace = await resolveStartingWorkspace(req);
  if (!workspace) return failSsoRedirect(res, "saml start", null, deploymentBase(), null, "failed");
  try {
    res.redirect(await buildSamlAuthorizationRedirect(workspace.orgId));
  } catch (error) {
    failSsoRedirect(res, "saml start", workspace.orgId, workspace.loginBase, error);
  }
});

// SAML uses POST binding (the IdP's browser-form-posts the assertion here), unlike OIDC's
// GET-redirect callback — this is the one route in the whole app that needs a form-encoded
// body parser, scoped locally rather than adding express.urlencoded() globally in app.ts.
ssoRouter.post("/saml/acs", express.urlencoded({ extended: false }), async (req, res) => {
  const body = (req.body ?? {}) as Record<string, string>;
  const signedOrgId = orgIdFromState(typeof body.RelayState === "string" ? body.RelayState : "");
  try {
    // The host this POST arrived at, as the browser named it and as a proxy recorded it — the ACS
    // location the response's Destination/Recipient are checked against (sso.service.ts).
    const forwarded = req.headers["x-forwarded-host"];
    const hosts = [req.headers.host, Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0]?.trim()].filter(
      (host): host is string => Boolean(host)
    );
    const { orgId, identity } = await completeSamlLogin(body, { hosts });
    await finishSsoLogin(req, res, orgId, identity, "SAML");
  } catch (error) {
    failSsoRedirect(res, "saml acs", signedOrgId, await loginBaseForOrgId(signedOrgId), error);
  }
});

ssoRouter.get("/:provider/start", async (req, res) => {
  const provider = providerParam.parse(req.params.provider);
  const workspace = await resolveStartingWorkspace(req);
  if (!workspace) return failSsoRedirect(res, `${provider.toLowerCase()} start`, null, deploymentBase(), null, "failed");
  try {
    res.redirect(await buildAuthorizationRedirect(workspace.orgId, provider));
  } catch (error) {
    failSsoRedirect(res, `${provider.toLowerCase()} start`, workspace.orgId, workspace.loginBase, error);
  }
});

ssoRouter.get("/:provider/callback", async (req, res) => {
  const route = `${providerParam.parse(req.params.provider).toLowerCase()} callback`; // the real provider comes back out of the signed state
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const signedOrgId = orgIdFromState(state);

  // The IdP's own answer, checked before anything else. `access_denied` is somebody pressing Cancel;
  // it used to reach openid-client, which threw a non-AppError — a 500 — and the handler logged the URL.
  if (typeof req.query.error === "string") {
    const base = await loginBaseForOrgId(signedOrgId);
    return failSsoRedirect(res, route, signedOrgId, base, null, ssoErrorCodeForProviderError(req.query.error));
  }

  try {
    if (!state) throw new AppError(400, "Missing state parameter.", { code: "SSO_EXPIRED" });
    const currentUrl = new URL(req.originalUrl, `${req.protocol}://${req.get("host")}`);
    const { orgId, identity } = await completeAuthorizationCodeGrant(currentUrl, state);
    // The provider is read back out of the SIGNED state, deliberately, not from `req.params` —
    // the param is attacker-controlled and this stamp decides whether a workspace may turn off
    // password login. Same reason the comment above says the real provider comes from the state.
    await finishSsoLogin(req, res, orgId, identity, verifySsoState(state).provider);
  } catch (error) {
    failSsoRedirect(res, route, signedOrgId, await loginBaseForOrgId(signedOrgId), error);
  }
});
