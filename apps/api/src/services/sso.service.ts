/**
 * SSO (Google + Microsoft OIDC) — Phase B4 of the multi-tenant SaaS work. Each org configures
 * its OWN OAuth app credentials per provider (OrgSsoConfig, control-plane schema), so this
 * file never assumes a single fixed client id/secret the way a typical single-tenant OIDC
 * integration would.
 *
 * WHY a single fixed callback URL works across every org: the alternative — registering a
 * distinct redirect URI per org with Google/Microsoft — would mean an org's admin has to keep
 * their OAuth app's redirect URI in sync with this app's domain forever. Instead, org identity
 * travels through the OAuth `state` parameter (see signSsoState/verifySsoState below), signed
 * so it can't be tampered with, and the callback resolves org purely from that — never from
 * the request's Host header, which for the callback is just wherever we told the provider to
 * redirect to, not necessarily the org's own subdomain.
 *
 * WHY no server-side session store for the PKCE code_verifier: this app has none (sessions
 * are represented by the Session DB table + JWT, not `req.session`), so instead of adding one
 * just for this one flow, the code_verifier travels inside the same signed `state` JWT as the
 * org id — it never needs to be looked up server-side between the redirect and the callback.
 * SAML is the one exception, and only because it has to be: `validateInResponseTo` compares an
 * assertion against a request id that CANNOT travel in the RelayState (the IdP echoes the id
 * from the AuthnRequest it received, not from RelayState), so that one flow keeps a small
 * module-level store — see samlRequestIdCache below for its limits.
 */
import * as client from "openid-client";
import { SAML, ValidateInResponseTo, type CacheProvider } from "@node-saml/node-saml";
import { Client as LdapClient, type Entry as LdapEntry } from "ldapts";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { AppError } from "../middleware/error.js";
import { controlPrisma } from "../config/control-prisma.js";
import { decryptSecret } from "../utils/encryption.js";
import { JWT_ALGORITHM } from "../utils/security.js";

export type OidcProviderType = "GOOGLE" | "MICROSOFT";
export type SsoProviderType = OidcProviderType | "SAML" | "LDAP";

const STATE_TTL_SECONDS = 10 * 60;

interface SsoStatePayload {
  orgId: string;
  /**
   * Narrowed to the REDIRECT providers, which is all this state is ever minted for. LDAP is a
   * direct bind with no round-trip and so no state, and typing this as the full `SsoProviderType`
   * meant a caller reading the provider back out had to handle an "LDAP" case that cannot occur —
   * exactly where a stray `as` would get written instead.
   */
  provider: Exclude<SsoProviderType, "LDAP">;
  /** PKCE verifier — OIDC (Google/Microsoft) only; SAML has no equivalent concept. */
  codeVerifier?: string;
}

/** Signed with the same secret used for access tokens — this JWT never leaves the OAuth/SAML
 *  redirect round-trip and carries no session-granting power on its own (it only unlocks the
 *  *next* step of a login that still requires a real assertion/code exchange with the IdP).
 *  Doubles as SAML's RelayState value — same signed-JWT-carries-org-identity trick, just
 *  handed to `getAuthorizeUrlAsync` instead of an OAuth `state` parameter. */
export function signSsoState(payload: SsoStatePayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: STATE_TTL_SECONDS,
    issuer: "timesphere-sso",
    algorithm: JWT_ALGORITHM
  });
}

export function verifySsoState(state: string): SsoStatePayload {
  try {
    // `algorithms` pinned for the same reason utils/security.ts pins it on every other verify in
    // this app: the algorithm must come from us, never from the token's own header.
    return jwt.verify(state, env.JWT_ACCESS_SECRET, {
      algorithms: [JWT_ALGORITHM],
      issuer: "timesphere-sso"
    }) as unknown as SsoStatePayload;
  } catch {
    throw new AppError(400, "This sign-in link has expired or is invalid — please try signing in again.");
  }
}

function issuerFor(provider: OidcProviderType, tenantHint?: string | null): URL {
  if (provider === "GOOGLE") return new URL("https://accounts.google.com");
  return new URL(`https://login.microsoftonline.com/${tenantHint || "common"}/v2.0`);
}

function callbackUrl(provider: OidcProviderType): string {
  return `${env.APP_BASE_URL.replace(/\/$/, "")}/api/auth/sso/${provider.toLowerCase()}/callback`;
}

/** Fetches this org's OrgSsoConfig row for a provider and throws a clear error if it isn't
 *  fully configured/enabled — every caller (start + callback) needs this same check. */
export async function getEnabledSsoConfig(
  orgId: string,
  provider: OidcProviderType
): Promise<{ clientId: string; encryptedClientSecret: string; tenantHint: string | null }> {
  const config = await controlPrisma.orgSsoConfig.findUnique({ where: { organizationId_providerType: { organizationId: orgId, providerType: provider } } });
  if (!config?.isEnabled || !config.clientId || !config.encryptedClientSecret) {
    throw new AppError(404, `${provider === "GOOGLE" ? "Google" : "Microsoft"} sign-in isn't configured for this workspace.`);
  }
  // Reconstructed rather than returning `config` directly — TS's narrowing of clientId/
  // encryptedClientSecret to non-null above doesn't propagate through this function's
  // inferred return type to callers (same cross-function-boundary quirk as elsewhere in this
  // phase), so the explicit return type annotation + this shape make it real, not asserted.
  return { clientId: config.clientId, encryptedClientSecret: config.encryptedClientSecret, tenantHint: config.tenantHint };
}

/** Builds a fresh OIDC client configuration — not cached across calls. Discovery is one extra
 *  HTTPS round-trip per login (to the provider's own well-known metadata endpoint), which is
 *  an acceptable cost for how infrequently people log in relative to page loads; add caching
 *  here later if it ever shows up as a real bottleneck. */
async function buildOidcConfig(provider: OidcProviderType, ssoConfig: { clientId: string; encryptedClientSecret: string; tenantHint: string | null }) {
  const clientSecret = decryptSecret(ssoConfig.encryptedClientSecret);
  return client.discovery(issuerFor(provider, ssoConfig.tenantHint), ssoConfig.clientId, clientSecret);
}

export async function buildAuthorizationRedirect(orgId: string, provider: OidcProviderType): Promise<string> {
  const ssoConfig = await getEnabledSsoConfig(orgId, provider);
  const config = await buildOidcConfig(provider, ssoConfig);

  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const state = signSsoState({ orgId, provider, codeVerifier });

  const redirectTo = client.buildAuthorizationUrl(config, {
    redirect_uri: callbackUrl(provider),
    scope: "openid email profile",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state
  });
  return redirectTo.href;
}

/**
 * Stamps "a real person got in through this provider, just now".
 *
 * This is the signal `OrgAuthMethod.requireSsoOnly` is gated on, so it must be written on the
 * SUCCESS path only and only after a session actually exists — see the column comment in
 * prisma/control/schema.prisma for why a connection test could not do this job.
 *
 * Best-effort by design: a control-plane write must never be able to fail a sign-in that has
 * already succeeded. Losing one stamp costs the admin one more sign-in before they can require
 * SSO; throwing here would cost a user their session for a bookkeeping row.
 */
export async function recordSsoLoginSuccess(orgId: string, provider: SsoProviderType): Promise<void> {
  try {
    await controlPrisma.orgSsoConfig.updateMany({
      where: { organizationId: orgId, providerType: provider },
      data: { lastSuccessfulLoginAt: new Date() }
    });
  } catch {
    /* see above — never fails the login it is recording */
  }
}

export interface SsoIdentity {
  email: string;
  name: string | null;
  emailVerified: boolean;
}

/** Completes the token exchange for a callback request and returns the verified identity.
 *  `currentUrl` must be the callback's own full URL (including the `code`/`state` query
 *  string) exactly as the provider redirected to it. */
export async function completeAuthorizationCodeGrant(currentUrl: URL, expectedState: string): Promise<{ orgId: string; identity: SsoIdentity }> {
  const { orgId, provider, codeVerifier } = verifySsoState(expectedState);
  // "LDAP" was in this guard and is now unreachable by the type — the state payload is minted only
  // for the redirect providers, so the compiler removes the case rather than the check being lost.
  if (provider === "SAML" || !codeVerifier) {
    throw new AppError(400, "State/provider mismatch.");
  }
  const ssoConfig = await getEnabledSsoConfig(orgId, provider);
  const config = await buildOidcConfig(provider, ssoConfig);

  const tokens = await client.authorizationCodeGrant(config, currentUrl, { pkceCodeVerifier: codeVerifier, expectedState }, { redirect_uri: callbackUrl(provider) });

  const claims = tokens.claims();
  if (!claims?.email || typeof claims.email !== "string") {
    throw new AppError(400, "The identity provider didn't return an email address — sign-in can't continue.");
  }

  return {
    orgId,
    identity: {
      email: claims.email,
      name: typeof claims.name === "string" ? claims.name : null,
      emailVerified: claims.email_verified === true
    }
  };
}

// ---------------------------------------------------------------------------------------------
// SAML (Phase B5)
// ---------------------------------------------------------------------------------------------

const DEFAULT_SP_ENTITY_ID = `${env.APP_BASE_URL.replace(/\/$/, "")}/api/auth/sso/saml/metadata`;

function samlCallbackUrl(): string {
  return `${env.APP_BASE_URL.replace(/\/$/, "")}/api/auth/sso/saml/acs`;
}

interface SamlConfig {
  idpEntityId: string;
  idpSsoUrl: string;
  idpCertificate: string;
  spEntityId: string | null;
}

/** Same "fetch + validate + reconstruct" shape as getEnabledSsoConfig above, kept as a
 *  separate function (rather than a generic one branching on provider) since SAML's required
 *  fields and error copy are entirely different from the OIDC providers'. */
export async function getEnabledSamlConfig(orgId: string): Promise<SamlConfig> {
  const config = await controlPrisma.orgSsoConfig.findUnique({ where: { organizationId_providerType: { organizationId: orgId, providerType: "SAML" } } });
  if (!config?.isEnabled || !config.idpEntityId || !config.idpSsoUrl || !config.idpCertificate) {
    throw new AppError(404, "SAML sign-in isn't configured for this workspace.");
  }
  return { idpEntityId: config.idpEntityId, idpSsoUrl: config.idpSsoUrl, idpCertificate: config.idpCertificate, spEntityId: config.spEntityId };
}

/**
 * The AuthnRequest ids this server has issued and not yet seen answered — what makes
 * `validateInResponseTo` possible at all.
 *
 * WHY IT IS NEEDED: node-saml defaults `validateInResponseTo` to `never`, and with it off a
 * captured `SAMLResponse` is replayable against the ACS endpoint for its entire `NotOnOrAfter`
 * window (minutes, at most IdP defaults). The assertion is signed, so replaying it mints a real
 * session for the user it names — the signature proves WHO, never HOW MANY TIMES. Pinning each
 * response to a request WE issued, and forgetting that request the moment it is answered, is the
 * control that closes it.
 *
 * WHY A SHARED MODULE-LEVEL STORE rather than node-saml's built-in InMemoryCacheProvider: this
 * file builds a FRESH `SAML` instance per call (see buildSamlClient), so the default provider —
 * which lives on the instance — would save the request id into an object that is garbage by the
 * time the ACS POST arrives, and every login would fail. The `orgId` prefix keeps two tenants'
 * ids disjoint even though the store is one map.
 *
 * WHY `always` AND NOT `ifPresent`: `ifPresent` validates only when the IdP echoed an
 * InResponseTo, so stripping that one attribute from a captured response skips the check
 * entirely. `always` costs nothing here because IdP-INITIATED SSO IS ALREADY IMPOSSIBLE in this
 * implementation — completeSamlLogin refuses any ACS POST without a RelayState that we signed,
 * and only buildSamlAuthorizationRedirect below ever mints one. So there is no working flow that
 * `always` breaks.
 *
 * LIMITATIONS, stated rather than implied (same shape as services/webhook-replay.ts's):
 * - PER PROCESS. A second Node process behind a load balancer has its own map, so an AuthnRequest
 *   issued by one and answered at the other fails to validate. Unlike the webhook store, that is
 *   a FAILED LOGIN rather than a missed replay catch — this is safe here only because the app
 *   runs as a single Node process (see the database-per-organization note in the root README),
 *   and it is the thing to revisit first if that ever stops being true.
 * - A RESTART mid-login costs the user one retry, for the same reason.
 */
const SAML_REQUEST_TTL_MS = STATE_TTL_SECONDS * 1000;
/** `/saml/start` is unauthenticated, so the number of ids in flight is attacker-influenced.
 *  Evicting the oldest can only cost a genuine user a retry — it grants nothing — which makes a
 *  hard cap the right trade against unbounded growth. */
const SAML_MAX_PENDING_REQUESTS = 10_000;
const samlRequestIds = new Map<string, { value: string; expiresAt: number }>();

function purgeExpiredSamlRequestIds(now: number): void {
  // Constant TTL, so insertion order IS expiry order: the first live key means every later one is.
  for (const [key, entry] of samlRequestIds) {
    if (entry.expiresAt > now) break;
    samlRequestIds.delete(key);
  }
}

/** node-saml's CacheProvider contract, backed by the shared map above and scoped to one org —
 *  NUL separator for the same reason auth.service.ts's lockoutKey uses one: it cannot occur in
 *  either half, so no two (org, request id) pairs can collide into one key. */
function samlRequestIdCache(orgId: string): CacheProvider {
  const scope = (key: string | null) => `${orgId}\u0000${key ?? ""}`;
  return {
    async saveAsync(key, value) {
      const now = Date.now();
      purgeExpiredSamlRequestIds(now);
      if (samlRequestIds.has(scope(key))) return null;
      samlRequestIds.set(scope(key), { value, expiresAt: now + SAML_REQUEST_TTL_MS });
      while (samlRequestIds.size > SAML_MAX_PENDING_REQUESTS) {
        const oldest = samlRequestIds.keys().next();
        if (oldest.done) break;
        samlRequestIds.delete(oldest.value);
      }
      return { value, createdAt: now };
    },
    async getAsync(key) {
      const entry = samlRequestIds.get(scope(key));
      return entry && entry.expiresAt > Date.now() ? entry.value : null;
    },
    async removeAsync(key) {
      samlRequestIds.delete(scope(key));
      return key;
    }
  };
}

/** Test seam — the map is module state shared by every test in a file. */
export function __resetSamlRequestIdsForTests(): void {
  samlRequestIds.clear();
}

/** Test seam — lets a test assert that issuing an AuthnRequest actually recorded its id. */
export function __hasSamlRequestIdForTests(orgId: string, requestId: string): boolean {
  return samlRequestIds.has(`${orgId}\u0000${requestId}`);
}

/** Not cached across calls — same reasoning as buildOidcConfig: constructing a SAML instance
 *  is cheap (no network round-trip, unlike OIDC discovery), so there's nothing worth caching.
 *  The request-id cache it is handed deliberately IS shared across instances; see above. */
function buildSamlClient(config: SamlConfig, orgId: string): SAML {
  return new SAML({
    callbackUrl: samlCallbackUrl(),
    entryPoint: config.idpSsoUrl,
    issuer: config.spEntityId || DEFAULT_SP_ENTITY_ID,
    idpCert: config.idpCertificate,
    validateInResponseTo: ValidateInResponseTo.always,
    cacheProvider: samlRequestIdCache(orgId)
  });
}

export async function buildSamlAuthorizationRedirect(orgId: string): Promise<string> {
  const config = await getEnabledSamlConfig(orgId);
  const saml = buildSamlClient(config, orgId);
  const relayState = signSsoState({ orgId, provider: "SAML" });
  return saml.getAuthorizeUrlAsync(relayState, "", {});
}

/** `body` is the ACS endpoint's raw POST form body (`SAMLResponse` + `RelayState`), which is
 *  why the SAML route needs express.urlencoded() — unlike every other route in this app, which
 *  only ever receives JSON. RelayState carries org identity exactly like OIDC's `state` param;
 *  node-saml doesn't return it from validatePostResponseAsync so it's read here, separately,
 *  straight off the body. */
export async function completeSamlLogin(body: Record<string, string>): Promise<{ orgId: string; identity: SsoIdentity }> {
  const relayState = body.RelayState;
  if (!relayState) throw new AppError(400, "Missing RelayState parameter.");
  const { orgId, provider } = verifySsoState(relayState);
  if (provider !== "SAML") throw new AppError(400, "State/provider mismatch.");

  const config = await getEnabledSamlConfig(orgId);
  const saml = buildSamlClient(config, orgId);

  // Rejects a response whose InResponseTo names a request this server never issued, or already
  // saw answered — see samlRequestIdCache above for why that is the replay boundary.
  const { profile } = await saml.validatePostResponseAsync(body);
  const email = profile?.email ?? (typeof profile?.nameID === "string" ? profile.nameID : null);
  if (!email) {
    throw new AppError(400, "The identity provider didn't return an email address — sign-in can't continue.");
  }

  return {
    orgId,
    identity: {
      email,
      name: typeof profile?.displayName === "string" ? profile.displayName : null,
      emailVerified: true
    }
  };
}

// ---------------------------------------------------------------------------------------------
// LDAP / Active Directory
// ---------------------------------------------------------------------------------------------
// Unlike Google/Microsoft/SAML, LDAP has no redirect round-trip at all — the login form posts
// email+password straight to this app, which binds to the directory on the user's behalf. So
// there's no `state`/RelayState carrying org identity through a provider redirect; the org is
// already known from the normal Host-header tenant resolution that ran for this request (see
// controllers/auth.controller.ts's "/login/ldap" route), same as password login.

interface LdapConfig {
  url: string;
  bindDn: string;
  bindCredential: string;
  searchBase: string;
  userFilter: string;
  tlsRejectUnauthorized: boolean;
}

/** Same "fetch + validate" shape as getEnabledSsoConfig/getEnabledSamlConfig above. */
export async function getEnabledLdapConfig(orgId: string): Promise<LdapConfig> {
  const config = await controlPrisma.orgSsoConfig.findUnique({ where: { organizationId_providerType: { organizationId: orgId, providerType: "LDAP" } } });
  if (!config?.isEnabled || !config.ldapUrl || !config.ldapBindDn || !config.encryptedLdapBindCredential || !config.ldapSearchBase) {
    throw new AppError(404, "LDAP sign-in isn't configured for this workspace.");
  }
  return {
    url: config.ldapUrl,
    bindDn: config.ldapBindDn,
    bindCredential: decryptSecret(config.encryptedLdapBindCredential),
    searchBase: config.ldapSearchBase,
    userFilter: config.ldapUserFilter || "(mail={{email}})",
    tlsRejectUnauthorized: config.ldapTlsRejectUnauthorized
  };
}

function createLdapClient(config: LdapConfig): LdapClient {
  // tlsOptions makes ldapts negotiate TLS on connect — only pass it for ldaps:// URLs. Handing
  // it to a plain ldap:// connection makes the client attempt a TLS handshake against a server
  // speaking plaintext LDAP, which just hangs/resets rather than falling back gracefully.
  const useTls = config.url.startsWith("ldaps://");
  return new LdapClient({
    url: config.url,
    ...(useTls ? { tlsOptions: { rejectUnauthorized: config.tlsRejectUnauthorized } } : {}),
    connectTimeout: 5000,
    timeout: 8000
  });
}

/** Escapes an LDAP filter value per RFC 4515 — the submitted email is untrusted user input
 *  being interpolated into a search filter string, so this is the LDAP-injection defense. */
function escapeLdapFilterValue(value: string): string {
  return value.replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

function firstAttrValue(entry: LdapEntry, name: string): string | null {
  const value = entry[name];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
}

/** Binds as the service account to locate the user's DN, then rebinds as that DN with the
 *  submitted password to actually verify it — the standard "search + bind" LDAP auth pattern,
 *  since a user's own login name is rarely their full DN. Success yields the same SsoIdentity
 *  shape every other provider produces, so it flows into completeSsoLogin unchanged. */
export async function authenticateLdap(orgId: string, email: string, password: string): Promise<SsoIdentity> {
  const config = await getEnabledLdapConfig(orgId);
  const filter = config.userFilter.replace("{{email}}", escapeLdapFilterValue(email));

  const serviceClient = createLdapClient(config);
  let entry: LdapEntry | undefined;
  try {
    await serviceClient.bind(config.bindDn, config.bindCredential);
    const { searchEntries } = await serviceClient.search(config.searchBase, {
      filter,
      scope: "sub",
      attributes: ["dn", "mail", "cn", "displayName"]
    });
    entry = searchEntries[0];
  } catch {
    throw new AppError(502, "Couldn't reach the directory server — contact your workspace admin.");
  } finally {
    await serviceClient.unbind().catch(() => undefined);
  }

  if (!entry) throw new AppError(401, "Invalid email or password.");

  const userClient = createLdapClient(config);
  try {
    await userClient.bind(entry.dn, password);
  } catch {
    throw new AppError(401, "Invalid email or password.");
  } finally {
    await userClient.unbind().catch(() => undefined);
  }

  return {
    email: firstAttrValue(entry, "mail") || email,
    name: firstAttrValue(entry, "displayName") || firstAttrValue(entry, "cn"),
    emailVerified: true
  };
}
