/**
 * SSO start/callback routes. Deliberately mounted on `app` BEFORE the blanket
 * `app.use("/api", resolveTenant)` in app.ts, so these two routes never go through the normal
 * subdomain-based tenant-resolution middleware:
 *  - `/start` resolves org from the Host header itself (via the same resolveOrgSlug used by
 *    the normal middleware) since it only needs the control-plane, not a tenant DB connection,
 *    to build the redirect.
 *  - `/callback` CANNOT rely on the Host header at all — the provider redirects back to one
 *    fixed callback URL shared by every org, so by definition it isn't that org's own
 *    subdomain. Org identity instead comes entirely from the signed `state` parameter (see
 *    services/sso.service.ts), and this handler manually resolves+attaches the right tenant
 *    context for the one write (find-or-create user, create session) it needs to make.
 */
import express, { Router } from "express";
import { z } from "zod";
import { controlPrisma } from "../config/control-prisma.js";
import { getTenantClient } from "../config/prisma.js";
import { tenantContext } from "../config/tenant-context.js";
import { env } from "../config/env.js";
import { resolveActiveOrgBySlug, resolveOrgSlug } from "../middleware/tenant.js";
import { AppError } from "../middleware/error.js";
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

  res.cookie(REFRESH_COOKIE, result.refreshToken, refreshCookieOptions(result.refreshTokenExpiresAt));
  res.redirect(`${env.WEB_ORIGIN.split(",")[0].trim()}/app`);
}

// SAML routes are registered BEFORE the parameterized `/:provider/start` + `/:provider/callback`
// OIDC routes below — Express matches routes in registration order, and `/:provider/start`
// would otherwise swallow `/saml/start` (matching "saml" as the :provider param) since it's a
// more general pattern registered against the same router.
ssoRouter.get("/saml/start", async (req, res, next) => {
  try {
    const org = await resolveActiveOrgBySlug(resolveOrgSlug(req), req);
    const redirectUrl = await buildSamlAuthorizationRedirect(org.id);
    res.redirect(redirectUrl);
  } catch (error) {
    next(error);
  }
});

// SAML uses POST binding (the IdP's browser-form-posts the assertion here), unlike OIDC's
// GET-redirect callback — this is the one route in the whole app that needs a form-encoded
// body parser, scoped locally rather than adding express.urlencoded() globally in app.ts.
ssoRouter.post("/saml/acs", express.urlencoded({ extended: false }), async (req, res, next) => {
  try {
    const { orgId, identity } = await completeSamlLogin(req.body as Record<string, string>);
    await finishSsoLogin(req, res, orgId, identity, "SAML");
  } catch (error) {
    next(error);
  }
});

ssoRouter.get("/:provider/start", async (req, res, next) => {
  try {
    const provider = providerParam.parse(req.params.provider);
    const org = await resolveActiveOrgBySlug(resolveOrgSlug(req), req);
    const redirectUrl = await buildAuthorizationRedirect(org.id, provider);
    res.redirect(redirectUrl);
  } catch (error) {
    next(error);
  }
});

ssoRouter.get("/:provider/callback", async (req, res, next) => {
  try {
    providerParam.parse(req.params.provider); // validated for a clean 400 if garbage; the real provider comes back out of the signed state
    const state = String(req.query.state ?? "");
    if (!state) throw new AppError(400, "Missing state parameter.");

    const currentUrl = new URL(req.originalUrl, `${req.protocol}://${req.get("host")}`);
    const { orgId, identity } = await completeAuthorizationCodeGrant(currentUrl, state);
    // The provider is read back out of the SIGNED state, deliberately, not from `req.params` —
    // the param is attacker-controlled and this stamp decides whether a workspace may turn off
    // password login. Same reason the comment above says the real provider comes from the state.
    await finishSsoLogin(req, res, orgId, identity, verifySsoState(state).provider);
  } catch (error) {
    next(error);
  }
});
