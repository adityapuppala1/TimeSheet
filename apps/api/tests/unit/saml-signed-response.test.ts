/**
 * SAML sign-in, end to end through node-saml's REAL signature verification, with responses signed
 * the way real identity providers sign them (see tests/helpers/saml-idp.ts).
 *
 * WHY THIS FILE EXISTS. No test in this repository completed a signed SAML login, so nobody noticed
 * that `buildSamlClient` left node-saml 5's defaults in place — `wantAuthnResponseSigned: true` AND
 * `wantAssertionsSigned: true` — which demand BOTH signatures. Entra ID's default is "Sign SAML
 * assertion" and Google Workspace signs only the assertion, so SAML sign-in through either failed with
 * "Invalid document signature" (audit H2). The fix accepts either placement; these tests prove that,
 * and prove the things that must STILL be refused: nothing signed, a second smuggled-in assertion
 * (signature wrapping), and a signature from a key the workspace never configured.
 *
 * They also pin the message checks node-saml does not do for us (audit M5, L1): the IdP's issuer,
 * the Destination and Recipient the response was addressed to, a clock-skew allowance, certificate
 * rollover bundles, and where the email address comes from.
 */
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IDP_A_CERT,
  IDP_A_KEY,
  IDP_B_CERT,
  IDP_B_KEY,
  assertionXml,
  responseXml,
  signAssertion,
  signResponse,
  toBase64,
  type AssertionOptions
} from "../helpers/saml-idp.js";

interface RequestIdRow {
  id: string;
  organizationId: string;
  requestId: string;
  value: string;
  expiresAt: Date;
}

const { ssoRow, requestIds, orgRow } = vi.hoisted(() => ({
  ssoRow: { current: null as Record<string, unknown> | null },
  requestIds: new Map<string, RequestIdRow>(),
  orgRow: { current: { slug: "acme", domains: [] as Array<{ domain: string }> } }
}));

vi.mock("../../src/config/control-prisma.js", () => {
  let nextId = 0;
  return {
    controlPrisma: {
      orgSsoConfig: { findUnique: async () => ssoRow.current },
      organization: { findUnique: async () => orgRow.current },
      samlRequestId: {
        create: async ({ data }: { data: Omit<RequestIdRow, "id"> }) => {
          const row = { id: `rid-${++nextId}`, ...data };
          requestIds.set(row.id, row);
          return row;
        },
        findUnique: async ({ where }: { where: { organizationId_requestId: { organizationId: string; requestId: string } } }) =>
          [...requestIds.values()].find(
            (r) => r.organizationId === where.organizationId_requestId.organizationId && r.requestId === where.organizationId_requestId.requestId
          ) ?? null,
        deleteMany: async ({ where }: { where: { id?: string; organizationId?: string; requestId?: string; expiresAt?: { lt: Date } } }) => {
          const doomed = [...requestIds.values()].filter(
            (r) =>
              (where.id === undefined || r.id === where.id) &&
              (where.requestId === undefined || r.requestId === where.requestId) &&
              (where.expiresAt === undefined || r.expiresAt < where.expiresAt.lt)
          );
          for (const row of doomed) requestIds.delete(row.id);
          return { count: doomed.length };
        }
      }
    }
  };
});

const { buildSamlAuthorizationRedirect, completeSamlLogin, signSsoState } = await import("../../src/services/sso.service.js");

const IDP_ENTITY = "https://idp.example.test/entity";
// vitest.config.ts sets APP_BASE_URL=http://localhost:5173 — these are what the app derives from it.
const ACS = "http://localhost:5173/api/auth/sso/saml/acs";
const SP_ENTITY = "http://localhost:5173/api/auth/sso/saml/metadata";

function config(overrides: Record<string, unknown> = {}) {
  return {
    isEnabled: true,
    idpEntityId: IDP_ENTITY,
    idpSsoUrl: "https://idp.example.test/sso",
    idpCertificate: IDP_A_CERT,
    spEntityId: null,
    lastSuccessfulLoginAt: null,
    ...overrides
  };
}

/** Starts a real sign-in so the AuthnRequest id is one this server issued. */
async function startSignIn(): Promise<string> {
  const redirect = await buildSamlAuthorizationRedirect("org-1");
  const xml = zlib.inflateRawSync(Buffer.from(new URL(redirect).searchParams.get("SAMLRequest") ?? "", "base64")).toString("utf8");
  return /ID="([^"]+)"/.exec(xml)?.[1] ?? "";
}

function assertionFor(requestId: string, extra: Partial<AssertionOptions> = {}): string {
  return assertionXml({ issuer: IDP_ENTITY, audience: SP_ENTITY, inResponseTo: requestId, recipient: ACS, nameId: "sam@acme.example", ...extra });
}

const envelope = (requestId: string, body: string, destination: string | null = ACS) =>
  responseXml({ issuer: IDP_ENTITY, inResponseTo: requestId, destination, body });

const acs = (xml: string, hosts: string[] = ["localhost:5173"]) =>
  completeSamlLogin({ SAMLResponse: toBase64(xml), RelayState: signSsoState({ orgId: "org-1", provider: "SAML" }) }, { hosts });

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  requestIds.clear();
  ssoRow.current = config();
  orgRow.current = { slug: "acme", domains: [] };
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

describe("either signature placement is accepted (H2)", () => {
  it("accepts an assertion-only signature — Entra's and Google Workspace's default", async () => {
    const id = await startSignIn();
    const { identity } = await acs(envelope(id, signAssertion(assertionFor(id))));
    expect(identity.email).toBe("sam@acme.example");
  });

  it("accepts a response-only signature, the assertion inside it unsigned", async () => {
    const id = await startSignIn();
    const { identity } = await acs(signResponse(envelope(id, assertionFor(id))));
    expect(identity.email).toBe("sam@acme.example");
  });

  it("accepts both signed, which already worked and must keep working", async () => {
    const id = await startSignIn();
    const { orgId } = await acs(signResponse(envelope(id, signAssertion(assertionFor(id)))));
    expect(orgId).toBe("org-1");
  });
});

describe("what must still be refused", () => {
  it("refuses a response with no signature anywhere", async () => {
    const id = await startSignIn();
    await expect(acs(envelope(id, assertionFor(id)))).rejects.toThrow(/signature/i);
  });

  it("refuses a second, unsigned assertion smuggled in beside a signed one (signature wrapping)", async () => {
    const id = await startSignIn();
    const signed = signAssertion(assertionFor(id));
    const forged = assertionFor(id, { id: "_evil", nameId: "admin@acme.example" });
    await expect(acs(envelope(id, signed + forged))).rejects.toThrow(/multiple assertions/i);
  });

  it("refuses an assertion signed by a key this workspace never configured", async () => {
    const id = await startSignIn();
    await expect(acs(envelope(id, signAssertion(assertionFor(id), IDP_B_KEY, IDP_B_CERT)))).rejects.toThrow(/signature/i);
  });

  it("refuses a response-level signature from the wrong key too", async () => {
    const id = await startSignIn();
    await expect(acs(signResponse(envelope(id, assertionFor(id)), IDP_B_KEY, IDP_B_CERT))).rejects.toThrow(/signature/i);
  });
});

describe("certificate rollover: a PEM bundle of several certificates (M5)", () => {
  it("accepts a response signed by EITHER certificate in the bundle", async () => {
    ssoRow.current = config({ idpCertificate: `${IDP_B_CERT}\n${IDP_A_CERT}` });
    const first = await startSignIn();
    await expect(acs(envelope(first, signAssertion(assertionFor(first), IDP_A_KEY, IDP_A_CERT)))).resolves.toBeTruthy();
    const second = await startSignIn();
    await expect(acs(envelope(second, signAssertion(assertionFor(second), IDP_B_KEY, IDP_B_CERT)))).resolves.toBeTruthy();
  });

  it("still accepts a bare base64 certificate with no PEM armour, which Okta's metadata carries", async () => {
    const bare = IDP_A_CERT.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "\r\n");
    ssoRow.current = config({ idpCertificate: bare });
    const id = await startSignIn();
    await expect(acs(envelope(id, signAssertion(assertionFor(id))))).resolves.toBeTruthy();
  });
});

describe("clock skew (M5)", () => {
  it("accepts an assertion from an IdP whose clock runs a minute ahead of ours", async () => {
    const id = await startSignIn();
    await expect(acs(envelope(id, signAssertion(assertionFor(id, { clockOffsetMs: 60_000 }))))).resolves.toBeTruthy();
  });

  it("still refuses one from ten minutes in the future", async () => {
    const id = await startSignIn();
    await expect(acs(envelope(id, signAssertion(assertionFor(id, { clockOffsetMs: 10 * 60_000 }))))).rejects.toThrow(/not yet valid/i);
  });
});

describe("the IdP issuer (M5)", () => {
  it("refuses an assertion issued by a different entity than the one configured", async () => {
    const id = await startSignIn();
    await expect(acs(envelope(id, signAssertion(assertionFor(id, { issuer: "https://other-idp.example.test/entity" }))))).rejects.toMatchObject({
      code: "SSO_CONFIG"
    });
  });

  it("tolerates a trailing slash and letter case, the two ways a hand-typed entity ID drifts", async () => {
    ssoRow.current = config({ idpEntityId: "HTTPS://IDP.example.test/entity/" });
    const id = await startSignIn();
    await expect(acs(envelope(id, signAssertion(assertionFor(id))))).resolves.toBeTruthy();
  });

  it("on a configuration people already sign in with, warns instead of refusing — nobody is locked out", async () => {
    ssoRow.current = config({ lastSuccessfulLoginAt: new Date("2026-09-01") });
    const id = await startSignIn();
    await expect(acs(envelope(id, signAssertion(assertionFor(id, { issuer: "https://other-idp.example.test/entity" }))))).resolves.toBeTruthy();
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/issuer/i);
  });
});

describe("Destination and Recipient (M5)", () => {
  it("refuses a response whose Destination is another service provider's ACS", async () => {
    const id = await startSignIn();
    await expect(acs(envelope(id, signAssertion(assertionFor(id)), "https://evil.example.net/acs"))).rejects.toMatchObject({ code: "SSO_CONFIG" });
  });

  it("refuses an assertion whose SubjectConfirmationData Recipient is another service provider", async () => {
    const id = await startSignIn();
    await expect(acs(envelope(id, signAssertion(assertionFor(id, { recipient: "https://evil.example.net/acs" }))))).rejects.toMatchObject({
      code: "SSO_CONFIG"
    });
  });

  it("accepts a response that carries neither, since both are optional in the protocol", async () => {
    const id = await startSignIn();
    await expect(acs(envelope(id, signAssertion(assertionFor(id, { recipient: null })), null))).resolves.toBeTruthy();
  });

  it("accepts the ACS on the workspace's own hostname, which is where most admins registered it", async () => {
    const id = await startSignIn();
    const own = "https://acme.timesphere.example/api/auth/sso/saml/acs";
    await expect(acs(envelope(id, signAssertion(assertionFor(id, { recipient: own })), own), ["acme.timesphere.example"])).resolves.toBeTruthy();
  });

  it("accepts the ACS on a verified custom domain even when the POST arrived at another host", async () => {
    orgRow.current = { slug: "acme", domains: [{ domain: "time.acme.example" }] };
    const id = await startSignIn();
    const custom = "https://time.acme.example/api/auth/sso/saml/acs";
    await expect(acs(envelope(id, signAssertion(assertionFor(id, { recipient: custom })), custom), ["localhost:5173"])).resolves.toBeTruthy();
  });

  it("on a configuration people already sign in with, warns instead of refusing", async () => {
    ssoRow.current = config({ lastSuccessfulLoginAt: new Date("2026-09-01") });
    const id = await startSignIn();
    await expect(acs(envelope(id, signAssertion(assertionFor(id)), "https://evil.example.net/acs"))).resolves.toBeTruthy();
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/Destination/);
  });
});

describe("where the email address comes from (L1)", () => {
  it("reads Entra's emailaddress claim", async () => {
    const id = await startSignIn();
    const assertion = assertionFor(id, {
      nameId: "AAAAAAAAAAAAAAAAAAAAAOPaqueEntraPairwiseId",
      nameIdFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
      attributes: { "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress": "sam@acme.example" }
    });
    const { identity } = await acs(envelope(id, signAssertion(assertion)));
    expect(identity.email).toBe("sam@acme.example");
  });

  it("refuses a PERSISTENT NameID as an email, even with no other source of one", async () => {
    const id = await startSignIn();
    const assertion = assertionFor(id, { nameId: "sam@acme.example", nameIdFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent" });
    await expect(acs(envelope(id, signAssertion(assertion)))).rejects.toThrow(/email address/i);
  });

  it("refuses a TRANSIENT NameID as an email", async () => {
    const id = await startSignIn();
    const assertion = assertionFor(id, { nameId: "_3f7b3dcf-1674-4ecd-92c8-1544f346baf8", nameIdFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:transient" });
    await expect(acs(envelope(id, signAssertion(assertion)))).rejects.toThrow(/email address/i);
  });

  it("still uses an emailAddress-format NameID, which is how most IdPs send it", async () => {
    const id = await startSignIn();
    const { identity } = await acs(envelope(id, signAssertion(assertionFor(id))));
    expect(identity.email).toBe("sam@acme.example");
  });

  it("refuses an email attribute that is not syntactically an address", async () => {
    const id = await startSignIn();
    const assertion = assertionFor(id, {
      nameIdFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:transient",
      nameId: "_abc",
      attributes: { email: "not an address" }
    });
    await expect(acs(envelope(id, signAssertion(assertion)))).rejects.toThrow(/email address/i);
  });
});
