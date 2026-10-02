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

/**
 * The Microsoft authorities that admit accounts the customer does not control: a blank tenant ID
 * (which issuerFor turns into `common`), and the three aliases an admin could type by hand —
 * `organizations` (any work directory) and `consumers` (any personal account) included.
 *
 * WHY THIS MATTERS, measured rather than assumed: `common` WORKS. openid-client 6.x special-cases
 * login.microsoftonline.com — discovery tolerates the `{tenantid}` placeholder issuer, and the
 * ID-token issuer check is then built from the token's OWN `tid` claim (openid-client
 * build/index.js handleEntraId + the Configuration constructor; oauth4webapi validateIssuer). So a
 * token minted for any directory passes, and the only thing tying the sign-in to this workspace is
 * the app registration's client id. completeSsoLogin matches people by `email` alone, and Entra's
 * `email` claim is the user's `mail` attribute, which an admin of ANY directory can set to any
 * address — the "nOAuth" pattern. tests/unit/sso-oidc-claims.test.ts pins the library behaviour.
 *
 * WARNED, NOT REFUSED: every workspace that has Microsoft sign-in working with this field blank
 * would lose it on deploy, and that is not a call to make silently on their behalf. The settings
 * card says it plainly; completeAuthorizationCodeGrant logs each sign-in that takes this route.
 */
const MULTI_TENANT_MICROSOFT_AUTHORITIES = new Set(["common", "organizations", "consumers"]);

export function isMultiTenantMicrosoftAuthority(tenantHint: string | null | undefined): boolean {
  const hint = (tenantHint ?? "").trim().toLowerCase();
  return hint === "" || MULTI_TENANT_MICROSOFT_AUTHORITIES.has(hint);
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
  /** Informational once it reaches here. The one place it DECIDES anything is the Google branch
   *  of completeAuthorizationCodeGrant, which refuses an unverified address before an identity is
   *  ever built — see the comment there for why that check is Google-only. */
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

  /**
   * GOOGLE HAS TO VOUCH FOR THE ADDRESS, because here the address IS the identity:
   * completeSsoLogin (auth.service.ts) signs somebody into an existing account by `email` alone,
   * and creates one when nothing matches. An address Google has not verified is one the account
   * holder merely typed in, so accepting it would let a Google account carrying a colleague's
   * address sign in as that colleague.
   *
   * Nothing legitimate is refused: Google includes `email_verified` in every ID token issued for
   * the `email` scope (requested in buildAuthorizationRedirect), and it is `true` for every
   * Workspace account and every confirmed consumer account. `=== true` rather than truthiness so a
   * malformed value fails closed.
   *
   * NOT applied to Microsoft: Entra v2 ID tokens normally carry no `email_verified` at all, so the
   * same rule would refuse every Microsoft sign-in. Microsoft's exposure is the multi-tenant
   * authority instead — see isMultiTenantMicrosoftAuthority and the warning below.
   */
  if (provider === "GOOGLE" && claims.email_verified !== true) {
    throw new AppError(
      403,
      "Google hasn't verified the email address on this account, so it can't be used to sign in here. Contact your workspace admin."
    );
  }

  if (provider === "MICROSOFT" && isMultiTenantMicrosoftAuthority(ssoConfig.tenantHint)) {
    // One line per sign-in, naming the org and the directory the token came from — the `tid` is
    // what lets an operator spot a sign-in from a directory that is not the customer's. Never the
    // email: this is an operational warning about the CONFIGURATION, not a record of who signed in.
    const tid = typeof claims.tid === "string" ? claims.tid : "unknown";
    console.warn(
      `[sso] org ${orgId}: Microsoft sign-in accepted through the multi-tenant authority (tenant ID not set; token tenant ${tid}). Any Microsoft account can sign in to this workspace and is matched by email — set the Directory (tenant) ID in Settings → Single sign-on.`
    );
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
 * WHY THE CONTROL PLANE (`SamlRequestId`) rather than node-saml's built-in InMemoryCacheProvider
 * or a module-level map, which is what this was: `/saml/start` and `/saml/acs` are two requests,
 * and the Helm chart runs 2–10 API replicas with no session affinity. A per-process store refused
 * a genuine response as "InResponseTo is not valid" whenever the two requests reached different
 * pods — at random, which is the worst kind of sign-in failure. SsoHandoffCode made the same move
 * for the same reason. Rows are scoped by `organizationId`, so two tenants' ids stay disjoint.
 *
 * WHY `always` AND NOT `ifPresent`: `ifPresent` validates only when the IdP echoed an
 * InResponseTo, so stripping that one attribute from a captured response skips the check
 * entirely. `always` costs nothing here because IdP-INITIATED SSO IS ALREADY IMPOSSIBLE in this
 * implementation — completeSamlLogin refuses any ACS POST without a RelayState that we signed,
 * and only buildSamlAuthorizationRedirect below ever mints one. So there is no working flow that
 * `always` breaks.
 *
 * A RESTART or rolling deploy no longer loses an in-flight sign-in; the row outlives the process.
 */
const SAML_REQUEST_TTL_MS = STATE_TTL_SECONDS * 1000;

/**
 * node-saml's CacheProvider contract over `SamlRequestId`, scoped to one org — and to ONE
 * validation, because buildSamlClient constructs a fresh `SAML` (and so a fresh provider) per call.
 *
 * THE FIRST READ OF AN ID CLAIMS IT. node-saml reads an id twice while validating one response —
 * the Response's InResponseTo, then the SubjectConfirmationData's — and removes it only at the end.
 * A plain read-then-remove would let two replicas accept the same response in the window between
 * them. So `getAsync` finds the row and deletes it by primary key, and only the caller whose
 * `deleteMany` reports a count of 1 gets the value back; that answer is remembered in `claimed`
 * so this same validation's second read still sees it. A replay, or the loser of a race, finds
 * nothing and is refused as "InResponseTo is not valid". Same atomic-claim shape as
 * sso-handoff.service.ts#redeemHandoffCode.
 */
function samlRequestIdStore(orgId: string): CacheProvider {
  const claimed = new Map<string, string>();
  return {
    async saveAsync(key, value) {
      const now = Date.now();
      // Opportunistic sweep, awaited and swallowed for the reason issueHandoffCode gives: one indexed
      // DELETE over a table holding ten minutes of traffic, and a failed sweep must not fail a start.
      try {
        await controlPrisma.samlRequestId.deleteMany({ where: { expiresAt: { lt: new Date(now) } } });
      } catch {
        /* the rows are expired and unusable either way */
      }
      try {
        await controlPrisma.samlRequestId.create({
          data: { organizationId: orgId, requestId: key, value, expiresAt: new Date(now + SAML_REQUEST_TTL_MS) }
        });
      } catch (error) {
        // node-saml's contract for "already present" is null; anything else is a real failure.
        if ((error as { code?: string }).code === "P2002") return null;
        throw error;
      }
      return { value, createdAt: now };
    },
    async getAsync(key) {
      const already = claimed.get(key);
      if (already !== undefined) return already;
      const row = await controlPrisma.samlRequestId.findUnique({
        where: { organizationId_requestId: { organizationId: orgId, requestId: key } }
      });
      if (!row) return null;
      const won = await controlPrisma.samlRequestId.deleteMany({ where: { id: row.id } });
      if (won.count === 0 || row.expiresAt.getTime() <= Date.now()) return null;
      claimed.set(key, row.value);
      return row.value;
    },
    async removeAsync(key) {
      if (key === null) return null;
      claimed.delete(key);
      await controlPrisma.samlRequestId.deleteMany({ where: { organizationId: orgId, requestId: key } });
      return key;
    }
  };
}

/** Not cached across calls — same reasoning as buildOidcConfig: constructing a SAML instance
 *  is cheap (no network round-trip, unlike OIDC discovery), so there's nothing worth caching.
 *  The request-id store it is handed is the shared control-plane table; see above. */
function buildSamlClient(config: SamlConfig, orgId: string): SAML {
  return new SAML({
    callbackUrl: samlCallbackUrl(),
    entryPoint: config.idpSsoUrl,
    issuer: config.spEntityId || DEFAULT_SP_ENTITY_ID,
    idpCert: config.idpCertificate,
    validateInResponseTo: ValidateInResponseTo.always,
    cacheProvider: samlRequestIdStore(orgId)
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
