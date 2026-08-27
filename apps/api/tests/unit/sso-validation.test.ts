/**
 * The SSO configuration guards, tested at the level where they actually decide something.
 *
 * WHAT THESE PIN, and why each one is here rather than being obvious:
 *
 *  - `describeCertificate` accepts both shapes an IdP console hands out (bare base64 from an Okta
 *    metadata blob, PEM armour from an ADFS export) and refuses prose. The old schema was
 *    `z.string().max(10_000)`, so prose saved cleanly and surfaced as an opaque error at a real
 *    user's first sign-in.
 *
 *  - The OIDC probe reads `invalid_grant` as SUCCESS. That inversion is the whole test and is the
 *    thing most likely to be "corrected" by someone who has not read why: the probe sends a
 *    deliberately invalid authorization code, so a correctly-configured client is EXPECTED to fail
 *    — with a complaint about the code. A complaint about the CLIENT means the credentials are
 *    wrong, which is what is being detected.
 *
 * `fetch` is stubbed rather than reaching a provider: these assert the decision logic, not
 * Google's uptime.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeCertificate, testOidcConnection } from "../../src/services/sso-validation.service.js";

// A real, self-signed certificate generated for this test. Long-dated on purpose: a fixture that
// expires turns into a mystery failure years later, on a test that is not about expiry.
// A REAL self-signed certificate, generated with openssl for this file. Long-dated on purpose:
// a fixture that expires turns into a mystery failure years later, on a test that is not about
// expiry. It carries no private key and secures nothing — it exists to be parsed.
const PEM = `-----BEGIN CERTIFICATE-----
MIIDQTCCAimgAwIBAgIUARvQCUFFNYkfn5OWlP2NN7ez9CAwDQYJKoZIhvcNAQEL
BQAwMDEYMBYGA1UEAwwPaWRwLmV4YW1wbGUuY29tMRQwEgYDVQQKDAtFeGFtcGxl
IElkUDAeFw0yNjA4MjcxNDA5MzZaFw0zNjA4MjQxNDA5MzZaMDAxGDAWBgNVBAMM
D2lkcC5leGFtcGxlLmNvbTEUMBIGA1UECgwLRXhhbXBsZSBJZFAwggEiMA0GCSqG
SIb3DQEBAQUAA4IBDwAwggEKAoIBAQC8QKyiMgBlVhRCxedK9+m1UwyiHbW2TJYg
y5URK1Uj23wkZC9JxRGf1typsi/xCBsBGFQtcIT6bcW0iWT5KaWgQ8kxYY7pmoWk
q8/697OUmOzeTPxZ8ijQYiklmex7ow5qkxMBHfi2Mdd4dZXgzH/7ldMdYOOK7gEE
ORGbpfIF4G0G28uL/iQFTV7KGEKTe+YF7Qbdk3wOwI0xR5JEIRZtPfhFz4Un48bf
mBH067GZ7d06OGd95R0W2yC7+hLfRCJQ/EwHTZ01B6h52ygiQjMsPYitnFmWJUf8
KUAJHncNUS7DIXhhN1fzuGoPl+gOIUP6wrhsaDhb9D0lBW7T3Dy3AgMBAAGjUzBR
MB0GA1UdDgQWBBSZrHFQvneNeg5wQL7ma/YJbsHe7TAfBgNVHSMEGDAWgBSZrHFQ
vneNeg5wQL7ma/YJbsHe7TAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUA
A4IBAQCCrpijZ7kpi8qSpG7pl+lWXWdCigaDgz99wDX4PKJNcb2qUUL6dypyIdmr
o+OcHp16IFyGXl5SbnUTrjhdr/JVkARtIlqwXBtViafjWJyxrn9nZow72odc7o78
ah5bI4CeX6XfKxES0gBEGWkty/+j9bKUWbuiI6wakwX2E+hV1keygHHfbFLcJh/0
HviB7r5l2XTk4WwapopmNiYUa3D42y9R8g5BioLR1yN8XlsdGdWufNMZCNAhMwiv
yNqbYa5jaHWt+K7bThpnPwohUCnpgfTnuJ1edJCWrkGvGK9UnCjj+OKKxIJh4z09
zqrvbtUrpJ14WNBK+fIurgZUqwQY
-----END CERTIFICATE-----`;

function stubFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let i = 0;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses[Math.min(i++, responses.length - 1)];
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body,
      text: async () => (typeof next.body === "string" ? next.body : JSON.stringify(next.body))
    } as unknown as Response;
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("describeCertificate", () => {
  it("reads a PEM-armoured certificate and reports its identity and expiry", () => {
    const facts = describeCertificate(PEM);
    expect(facts).not.toBeNull();
    expect(facts!.subject).toContain("idp.example.com");
    expect(facts!.expired).toBe(false);
    expect(facts!.fingerprint).toMatch(/^[0-9A-F:]+$/);
    expect(new Date(facts!.validTo).getTime()).toBeGreaterThan(Date.now());
  });

  it("reads the SAME certificate stripped of its armour, which is how Okta's metadata carries it", () => {
    const bare = PEM.replace(/-----[A-Z ]+-----/g, "").replace(new RegExp(String.raw`\s+`, "g"), "");
    const armoured = describeCertificate(PEM);
    const stripped = describeCertificate(bare);
    expect(stripped).not.toBeNull();
    // Same certificate, so the same fingerprint — this is what proves the un-armouring is faithful
    // rather than merely producing something that happens to parse.
    expect(stripped!.fingerprint).toBe(armoured!.fingerprint);
  });

  it("refuses prose, which the old max(10_000) schema accepted", () => {
    expect(describeCertificate("this is definitely a certificate, trust me")).toBeNull();
    expect(describeCertificate("")).toBeNull();
    expect(describeCertificate(null)).toBeNull();
    expect(describeCertificate(undefined)).toBeNull();
  });

  it("refuses base64 that is not a certificate", () => {
    // Well-formed base64, wrong contents — the shape a copy-paste from the wrong field produces.
    expect(describeCertificate("aGVsbG8gd29ybGQgdGhpcyBpcyBub3QgYSBjZXJ0aWZpY2F0ZQ==")).toBeNull();
  });
});

describe("testOidcConnection", () => {
  const base = {
    provider: "GOOGLE" as const,
    clientId: "client-abc.apps.googleusercontent.com",
    clientSecret: "secret-xyz",
    tenantHint: null,
    redirectUri: "https://acme.timesphere.app/api/auth/sso/google/callback"
  };
  const discovery = { status: 200, body: { token_endpoint: "https://oauth2.googleapis.com/token" } };

  it("reads invalid_grant as a PASS — the code was bad, which the probe made it", async () => {
    stubFetch([discovery, { status: 400, body: { error: "invalid_grant", error_description: "Bad Request" } }]);
    const result = await testOidcConnection(base);
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/accepted these credentials/i);
  });

  it("reads invalid_client as a FAIL and says where to re-copy the secret from", async () => {
    stubFetch([discovery, { status: 401, body: { error: "invalid_client", error_description: "The OAuth client was not found." } }]);
    const result = await testOidcConnection(base);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/rejected the client ID or secret/i);
    expect(result.message).toMatch(/shown only once/i);
  });

  it("names the redirect URI when the client is recognised but the request is refused", async () => {
    stubFetch([discovery, { status: 400, body: { error: "unauthorized_client", error_description: "redirect_uri mismatch" } }]);
    const result = await testOidcConnection(base);
    expect(result.ok).toBe(false);
    expect(result.message).toContain(base.redirectUri);
  });

  it("sends the probe to the token endpoint discovery advertised, not a hardcoded one", async () => {
    const calls = stubFetch([
      { status: 200, body: { token_endpoint: "https://oauth2.googleapis.com/v9/token" } },
      { status: 400, body: { error: "invalid_grant" } }
    ]);
    await testOidcConnection(base);
    expect(calls[0].url).toContain("accounts.google.com/.well-known/openid-configuration");
    expect(calls[1].url).toBe("https://oauth2.googleapis.com/v9/token");
  });

  it("does NOT claim to have verified Microsoft credentials, because it cannot", async () => {
    // The regression this pins is one this file actually shipped: Azure answers a bogus-code probe
    // with `invalid_grant` before it looks at the credentials, so the Google technique returned a
    // confident PASS for the literal client id "staged-ahead-of-upgrade". Measured against the live
    // endpoint. The Microsoft branch must therefore never send the token probe at all.
    const calls = stubFetch([{ status: 200, body: { token_endpoint: "https://login.microsoftonline.com/tid/oauth2/v2.0/token" } }]);
    const result = await testOidcConnection({ ...base, provider: "MICROSOFT", tenantHint: "tid", clientId: "obvious-junk" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("login.microsoftonline.com/tid/v2.0/.well-known/openid-configuration");
    expect(result.detail?.credentialsVerified).toBe(false);
    expect(result.message).toMatch(/can't confirm those/i);
  });

  it("blames the tenant ID, not the credentials, when Azure rejects discovery", async () => {
    stubFetch([{ status: 400, body: {} }]);
    const result = await testOidcConnection({ ...base, provider: "MICROSOFT", tenantHint: "not-a-real-tenant" });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/tenant/i);
    expect(result.message).toContain("not-a-real-tenant");
  });

  it("refuses to call a success a success if the provider somehow accepts the bogus code", async () => {
    // Unreachable in practice. Asserted anyway: if it ever happens, the assumption this entire
    // test strategy rests on is wrong, and silently reporting PASS would hide that.
    stubFetch([discovery, { status: 200, body: { access_token: "surprise" } }]);
    const result = await testOidcConnection(base);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/unexpectedly accepted/i);
  });
});
