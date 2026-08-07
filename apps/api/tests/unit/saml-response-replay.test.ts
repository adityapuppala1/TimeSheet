/**
 * SAML ran on node-saml's defaults, and one of those defaults is `validateInResponseTo: never`.
 * With it off, the ACS endpoint accepts any correctly-signed assertion that is still inside its
 * `NotOnOrAfter` window, however many times it arrives — a signature proves WHO minted the
 * assertion, never how many times it may be spent. A captured `SAMLResponse` (a browser
 * extension, a shared machine, a proxy that logs POST bodies) was therefore a reusable session
 * for that whole window.
 *
 * Closing it needs somewhere to remember the AuthnRequest ids this server issued. These tests pin
 * both halves: that issuing a request records its id, and that a response naming an id we never
 * issued is refused BEFORE anything else about it is believed.
 */
import zlib from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockFindUnique } = vi.hoisted(() => ({ mockFindUnique: vi.fn() }));
vi.mock("../../src/config/control-prisma.js", () => ({
  controlPrisma: { orgSsoConfig: { findUnique: mockFindUnique } }
}));

const { buildSamlAuthorizationRedirect, completeSamlLogin, signSsoState, __resetSamlRequestIdsForTests, __hasSamlRequestIdForTests } =
  await import("../../src/services/sso.service.js");

/** node-saml only needs `idpCert` to be present to construct; it is parsed at signature-check
 *  time, which every case here stops short of. */
const SAML_CONFIG = {
  isEnabled: true,
  idpEntityId: "https://idp.example.com/entity",
  idpSsoUrl: "https://idp.example.com/sso",
  idpCertificate: "MIIDdummycertificatecontentsthatarenevrparsedinthesetests",
  spEntityId: null
};

/** The AuthnRequest id node-saml minted, dug back out of the redirect it built. */
function requestIdFromRedirect(redirectUrl: string): string {
  const samlRequest = new URL(redirectUrl).searchParams.get("SAMLRequest") ?? "";
  const xml = zlib.inflateRawSync(Buffer.from(samlRequest, "base64")).toString("utf8");
  return /ID="([^"]+)"/.exec(xml)?.[1] ?? "";
}

/** A response shaped enough to be parsed and reach the InResponseTo check — deliberately
 *  unsigned, because the point is that it never gets as far as caring. */
function samlResponse(inResponseTo: string | null): string {
  const attribute = inResponseTo === null ? "" : ` InResponseTo="${inResponseTo}"`;
  const xml =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"` +
    ` ID="_response-1" Version="2.0" IssueInstant="${new Date().toISOString()}"${attribute}>` +
    `<saml:Issuer>${SAML_CONFIG.idpEntityId}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    `</samlp:Response>`;
  return Buffer.from(xml, "utf8").toString("base64");
}

const acsBody = (inResponseTo: string | null) => ({
  SAMLResponse: samlResponse(inResponseTo),
  RelayState: signSsoState({ orgId: "org-1", provider: "SAML" as const })
});

beforeEach(() => {
  __resetSamlRequestIdsForTests();
  mockFindUnique.mockReset().mockResolvedValue(SAML_CONFIG);
});

describe("issuing an AuthnRequest records its id", () => {
  it("remembers the id it just put on the wire", async () => {
    const id = requestIdFromRedirect(await buildSamlAuthorizationRedirect("org-1"));

    expect(id).not.toBe("");
    expect(__hasSamlRequestIdForTests("org-1", id)).toBe(true);
  });

  it("scopes the id to its org — one process serves every tenant", async () => {
    const id = requestIdFromRedirect(await buildSamlAuthorizationRedirect("org-1"));
    expect(__hasSamlRequestIdForTests("org-2", id)).toBe(false);
  });

  it("mints a distinct id per login attempt", async () => {
    const first = requestIdFromRedirect(await buildSamlAuthorizationRedirect("org-1"));
    const second = requestIdFromRedirect(await buildSamlAuthorizationRedirect("org-1"));

    expect(first).not.toBe(second);
    expect(__hasSamlRequestIdForTests("org-1", first)).toBe(true);
    expect(__hasSamlRequestIdForTests("org-1", second)).toBe(true);
  });
});

describe("the ACS endpoint refuses a response it never asked for", () => {
  it("rejects an InResponseTo naming a request this server never issued", async () => {
    await expect(completeSamlLogin(acsBody("_never-issued"))).rejects.toThrow(/InResponseTo is not valid/i);
  });

  it("rejects a response with the InResponseTo attribute stripped, rather than waving it through", async () => {
    // `ifPresent` would let exactly this through: delete one attribute, skip the whole check.
    await expect(completeSamlLogin(acsBody(null))).rejects.toThrow(/InResponseTo is missing/i);
  });

  it("rejects an id issued for a DIFFERENT org's login", async () => {
    const id = requestIdFromRedirect(await buildSamlAuthorizationRedirect("org-2"));
    await expect(completeSamlLogin(acsBody(id))).rejects.toThrow(/InResponseTo is not valid/i);
  });

  it("gets past InResponseTo for an id this server did issue, and fails on the signature instead", async () => {
    const id = requestIdFromRedirect(await buildSamlAuthorizationRedirect("org-1"));

    // Not a pass — the assertion is unsigned, so it still ends in a rejection. What it shows is
    // that the request-id gate is not what stopped it: a genuine round-trip clears that gate, so
    // turning the check on did not break the flow.
    await expect(completeSamlLogin(acsBody(id))).rejects.not.toThrow(/InResponseTo/i);
  });

  it("consumes the id, so the same response arriving twice is refused the second time", async () => {
    const id = requestIdFromRedirect(await buildSamlAuthorizationRedirect("org-1"));
    await completeSamlLogin(acsBody(id)).catch(() => undefined);

    // This is the replay itself: identical bytes, still inside every window the IdP set.
    await expect(completeSamlLogin(acsBody(id))).rejects.toThrow(/InResponseTo is not valid/i);
  });

  it("still refuses an ACS POST with no RelayState at all — IdP-initiated SSO is not a flow here", async () => {
    await expect(completeSamlLogin({ SAMLResponse: samlResponse("_anything") })).rejects.toThrow(/RelayState/i);
  });
});
