/**
 * What the OIDC callback does with the ID token it gets back — the claims that decide WHO is
 * signing in, since completeSsoLogin (auth.service.ts) matches an account by email address alone.
 *
 * TWO THINGS ARE PINNED HERE, and they are different in kind:
 *
 *  - OUR RULES. Google must assert `email_verified: true` or the sign-in is refused; Microsoft is
 *    not held to that (Entra v2 ID tokens normally omit the claim, so the same rule would lock every
 *    Microsoft user out), and a Microsoft sign-in through the multi-tenant authority is logged.
 *
 *  - THE LIBRARY'S BEHAVIOUR on Microsoft's `common` authority. Whether a blank tenant ID is an
 *    exposure or merely broken depends entirely on what openid-client does with a discovery document
 *    whose issuer is the literal `https://login.microsoftonline.com/{tenantid}/v2.0`. It ACCEPTS it,
 *    and then checks each ID token's `iss` against that template filled in from the token's own
 *    `tid` — so a token from ANY directory passes. That is the nOAuth precondition, and it is
 *    asserted here so that a library upgrade which changes it (in either direction) shows up as a
 *    failing test rather than as a surprise in production.
 *
 * The whole exchange runs for real through openid-client — discovery, authorization-response
 * validation, the token request, ID-token claim validation — against a stubbed `fetch` that answers
 * with realistic provider documents. Nothing reaches Google or Microsoft: an unexpected URL throws.
 * The control plane is faked for the same reason sso-handoff.test.ts fakes it.
 *
 * NOTE ON SIGNATURES: openid-client 6 does not verify an ID token's signature when it arrives
 * straight from the token endpoint over TLS (OIDC Core 3.1.3.7 step 6 permits this), so no JWKS is
 * served below. The tokens are still genuinely RS256-signed, because the library does check `alg`.
 */
import { generateKeyPairSync } from "node:crypto";
import jwt from "jsonwebtoken";
import * as client from "openid-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface SsoRow {
  isEnabled: boolean;
  clientId: string;
  encryptedClientSecret: string;
  tenantHint: string | null;
}

/** Stands in for the one OrgSsoConfig row the callback reads. Set per test. */
let ssoRow: SsoRow | null = null;

vi.mock("../../src/config/control-prisma.js", () => ({
  controlPrisma: {
    orgSsoConfig: {
      findUnique: async () => ssoRow
    }
  }
}));

const { completeAuthorizationCodeGrant, signSsoState } = await import("../../src/services/sso.service.js");
const { encryptSecret } = await import("../../src/utils/encryption.js");

const CLIENT_ID = "11111111-2222-3333-4444-555555555555";
/** The customer's own directory, and somebody else's. */
const HOME_TENANT = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER_TENANT = "bbbbbbbb-0000-4000-8000-000000000002";
/** Microsoft's fixed directory id for personal (MSA) accounts — what `tid` is for outlook.com users. */
const PERSONAL_ACCOUNTS_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

function idToken(claims: Record<string, unknown>): string {
  return jwt.sign(claims, privateKey, { algorithm: "RS256", keyid: "test-key", expiresIn: 600 });
}

/** A trimmed copy of what https://login.microsoftonline.com/<authority>/v2.0/.well-known/openid-configuration
 *  returns. The load-bearing field is `issuer`: for the multi-tenant authorities Microsoft publishes
 *  the literal placeholder `{tenantid}`, which never equals the URL it was fetched from. */
function microsoftDiscovery(authority: string) {
  const base = `https://login.microsoftonline.com/${authority}`;
  const multi = authority === "common" || authority === "organizations";
  return {
    token_endpoint: `${base}/oauth2/v2.0/token`,
    token_endpoint_auth_methods_supported: ["client_secret_post", "private_key_jwt", "client_secret_basic"],
    jwks_uri: `${base}/discovery/v2.0/keys`,
    response_modes_supported: ["query", "fragment", "form_post"],
    subject_types_supported: ["pairwise"],
    id_token_signing_alg_values_supported: ["RS256"],
    response_types_supported: ["code", "id_token", "code id_token", "id_token token"],
    scopes_supported: ["openid", "profile", "email", "offline_access"],
    issuer: `https://login.microsoftonline.com/${multi ? "{tenantid}" : authority}/v2.0`,
    request_uri_parameter_supported: false,
    userinfo_endpoint: "https://graph.microsoft.com/oidc/userinfo",
    authorization_endpoint: `${base}/oauth2/v2.0/authorize`,
    end_session_endpoint: `${base}/oauth2/v2.0/logout`,
    claims_supported: ["sub", "iss", "aud", "exp", "iat", "auth_time", "acr", "nonce", "preferred_username", "name", "tid", "ver", "at_hash", "c_hash", "email"],
    tenant_region_scope: null,
    cloud_instance_name: "microsoftonline.com"
  };
}

const GOOGLE_DISCOVERY = {
  issuer: "https://accounts.google.com",
  authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  token_endpoint: "https://oauth2.googleapis.com/token",
  userinfo_endpoint: "https://openidconnect.googleapis.com/v1/userinfo",
  jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
  response_types_supported: ["code", "token", "id_token", "code token", "code id_token", "token id_token", "code token id_token", "none"],
  subject_types_supported: ["public"],
  id_token_signing_alg_values_supported: ["RS256"],
  scopes_supported: ["openid", "email", "profile"],
  token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
  claims_supported: ["aud", "email", "email_verified", "exp", "family_name", "given_name", "iat", "iss", "name", "picture", "sub"],
  code_challenge_methods_supported: ["plain", "S256"]
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Answers exactly the URLs in `routes`; anything else is a test bug (or a real network call). */
function stubFetch(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(url);
    const route = routes[url];
    if (!route) throw new Error(`unexpected fetch in a unit test: ${url}`);
    return route();
  });
  return calls;
}

function stubMicrosoft(authority: string, claims: Record<string, unknown>) {
  const discovery = microsoftDiscovery(authority);
  return stubFetch({
    [`https://login.microsoftonline.com/${authority}/v2.0/.well-known/openid-configuration`]: () => json(discovery),
    [discovery.token_endpoint]: () => json({ token_type: "Bearer", access_token: "at", expires_in: 3600, id_token: idToken(claims) })
  });
}

function stubGoogle(claims: Record<string, unknown>) {
  return stubFetch({
    "https://accounts.google.com/.well-known/openid-configuration": () => json(GOOGLE_DISCOVERY),
    [GOOGLE_DISCOVERY.token_endpoint]: () => json({ token_type: "Bearer", access_token: "at", expires_in: 3600, id_token: idToken(claims) })
  });
}

/** Runs the real callback: a state we signed, a callback URL carrying it, the full token exchange. */
async function callback(provider: "GOOGLE" | "MICROSOFT") {
  const state = signSsoState({ orgId: "org-acme", provider, codeVerifier: "v".repeat(43) });
  const url = new URL(`http://localhost:5173/api/auth/sso/${provider.toLowerCase()}/callback?code=auth-code&state=${encodeURIComponent(state)}`);
  return completeAuthorizationCodeGrant(url, state);
}

/**
 * The issuer the library compared a refused token's `iss` against. openid-client re-wraps
 * oauth4webapi's error under a generic "unexpected JWT claim value" message, so the specific claim
 * and its expected value are two `cause`s down — and the EXPECTED value is the evidence that
 * matters, because under `common` it is derived from the token itself.
 */
async function refusedIssuerCheck(attempt: Promise<unknown>): Promise<{ claim: string; expected: string }> {
  const error = await attempt.then(
    () => { throw new Error("expected the sign-in to be refused"); },
    (err: unknown) => err as { cause?: { cause?: { claim: string; expected: string } } }
  );
  const detail = error.cause?.cause;
  if (!detail) throw new Error(`refused, but not by a JWT claim check: ${String(error)}`);
  return detail;
}

function microsoftClaims(tid: string, extra: Record<string, unknown> = {}) {
  // No `email_verified` — Entra v2 ID tokens normally do not carry it, which is the whole reason the
  // Google rule cannot be applied to Microsoft.
  return { iss: `https://login.microsoftonline.com/${tid}/v2.0`, aud: CLIENT_ID, sub: "subject-1", tid, email: "sam@acme.example", name: "Sam", ver: "2.0", ...extra };
}

function googleClaims(extra: Record<string, unknown> = {}) {
  return { iss: "https://accounts.google.com", aud: CLIENT_ID, sub: "google-subject-1", email: "sam@acme.example", name: "Sam", ...extra };
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  ssoRow = { isEnabled: true, clientId: CLIENT_ID, encryptedClientSecret: encryptSecret("client-secret"), tenantHint: null };
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => vi.unstubAllGlobals());

describe("Google sign-in requires a verified email address", () => {
  it("refuses an ID token that says the address is NOT verified", async () => {
    stubGoogle(googleClaims({ email_verified: false }));
    await expect(callback("GOOGLE")).rejects.toMatchObject({ statusCode: 403, message: expect.stringMatching(/hasn't verified the email address/i) });
  });

  it("refuses an ID token that does not say either way", async () => {
    // Fails closed: an absent claim is not a verified address.
    stubGoogle(googleClaims());
    await expect(callback("GOOGLE")).rejects.toMatchObject({ statusCode: 403 });
  });

  it("refuses a truthy non-boolean, which `=== true` exists to catch", async () => {
    stubGoogle(googleClaims({ email_verified: "false" }));
    await expect(callback("GOOGLE")).rejects.toMatchObject({ statusCode: 403 });
  });

  it("accepts a verified address, so ordinary Google users are unaffected", async () => {
    stubGoogle(googleClaims({ email_verified: true }));
    const { orgId, identity } = await callback("GOOGLE");
    expect(orgId).toBe("org-acme");
    expect(identity).toEqual({ email: "sam@acme.example", name: "Sam", emailVerified: true });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("Microsoft sign-in is not held to email_verified", () => {
  it("accepts an Entra ID token with no email_verified claim at all", async () => {
    ssoRow!.tenantHint = HOME_TENANT;
    stubMicrosoft(HOME_TENANT, microsoftClaims(HOME_TENANT));
    const { identity } = await callback("MICROSOFT");
    expect(identity.email).toBe("sam@acme.example");
    expect(identity.emailVerified).toBe(false);
    // A tenant ID is set, so this is the configuration we recommend — nothing to warn about.
    expect(warn).not.toHaveBeenCalled();
  });

  it("refuses a token from another directory when the tenant ID IS set", async () => {
    // The protection a tenant ID buys, shown working: Microsoft's per-tenant discovery publishes a
    // concrete issuer, and a token minted in any other directory fails the `iss` check.
    ssoRow!.tenantHint = HOME_TENANT;
    stubMicrosoft(HOME_TENANT, microsoftClaims(OTHER_TENANT));
    const refused = await refusedIssuerCheck(callback("MICROSOFT"));
    expect(refused).toMatchObject({ claim: "iss", expected: `https://login.microsoftonline.com/${HOME_TENANT}/v2.0` });
  });
});

describe('Microsoft "common" — what the library actually does with a blank tenant ID', () => {
  it("discovery against /common/v2.0 SUCCEEDS despite the {tenantid} issuer", async () => {
    // The question this file was written to answer. If this ever starts throwing, a blank tenant ID
    // has become a broken configuration rather than an open one, and the settings card's warning
    // and the server log in sso.service.ts must change to say so.
    stubFetch({
      "https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration": () => json(microsoftDiscovery("common"))
    });
    const config = await client.discovery(new URL("https://login.microsoftonline.com/common/v2.0"), CLIENT_ID, "client-secret");
    expect(config.serverMetadata().issuer).toBe("https://login.microsoftonline.com/{tenantid}/v2.0");
  });

  it("accepts a token minted in ANY directory — the nOAuth precondition", async () => {
    stubMicrosoft("common", microsoftClaims(OTHER_TENANT));
    const { identity } = await callback("MICROSOFT");
    expect(identity.email).toBe("sam@acme.example");
  });

  it("accepts a personal Microsoft account too", async () => {
    stubMicrosoft("common", microsoftClaims(PERSONAL_ACCOUNTS_TENANT));
    await expect(callback("MICROSOFT")).resolves.toMatchObject({ orgId: "org-acme" });
  });

  it("still checks the issuer — against the token's own tid, which is why the check proves nothing", async () => {
    // Negative control: issuer validation is not simply OFF under `common`. A token whose `iss`
    // disagrees with its own `tid` is refused — and the value it was held to is built from that
    // `tid`, i.e. from the token. An attacker's real token never disagrees with itself.
    stubMicrosoft("common", microsoftClaims(OTHER_TENANT, { iss: `https://login.microsoftonline.com/${HOME_TENANT}/v2.0` }));
    const refused = await refusedIssuerCheck(callback("MICROSOFT"));
    expect(refused).toMatchObject({ claim: "iss", expected: `https://login.microsoftonline.com/${OTHER_TENANT}/v2.0` });
  });

  it("logs one warning naming the org and token directory, never the email", async () => {
    stubMicrosoft("common", microsoftClaims(OTHER_TENANT));
    await callback("MICROSOFT");
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain("org-acme");
    expect(line).toContain(OTHER_TENANT);
    expect(line).not.toContain("sam@acme.example");
  });

  it("treats a hand-typed multi-tenant alias the same as a blank field", async () => {
    ssoRow!.tenantHint = "organizations";
    stubMicrosoft("organizations", microsoftClaims(OTHER_TENANT));
    await callback("MICROSOFT");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
