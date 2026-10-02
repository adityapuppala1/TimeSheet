/**
 * "Test connection" on the Single sign-on tab — a request this server makes to an address a tenant
 * admin typed. That makes it an internal network probe unless every hop is guarded (audit M8):
 *
 *  - The SAML test followed redirects with `fetch`'s default, after the egress guard had checked only
 *    the FIRST URL. An IdP URL on the public internet that answered `302 Location: http://169.254.
 *    169.254/...` walked the probe into cloud metadata, and the status code came back to the admin.
 *  - The LDAP test echoed the raw socket/bind error — "connect ECONNREFUSED 10.0.0.5:389" versus a
 *    timeout is a port scanner's answer. On a multi-org deployment (ROOT_DOMAIN set) the admin is a
 *    customer, not the operator, so the detail is withheld there.
 *  - Test-connection needed neither the plan nor an enabled provider; it is now gated on the plan
 *    entitlement exactly as enabling is.
 *
 * And audit L6: a Microsoft test cannot verify the client ID or secret (Azure answers before it looks
 * at them), so it is recorded as UNVERIFIED — "configuration looks valid" — never as a pass.
 *
 * The egress guard is replaced by one that refuses private addresses: in a unit test NODE_ENV is not
 * production, so the real guard allows everything, and the point here is that it is CALLED per hop.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";

const { guard, ldap, allowedProviders, ssoRow, updates } = vi.hoisted(() => ({
  guard: { calls: [] as string[] },
  ldap: { bindError: null as Error | null },
  allowedProviders: { current: ["GOOGLE", "MICROSOFT", "SAML", "LDAP"] },
  ssoRow: { current: null as Record<string, unknown> | null },
  updates: [] as Array<Record<string, unknown>>
}));

vi.mock("../../src/utils/egress.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/utils/egress.js")>("../../src/utils/egress.js");
  const { AppError } = await vi.importActual<typeof import("../../src/middleware/error.js")>("../../src/middleware/error.js");
  return {
    ...actual,
    assertPublicEgressTarget: async (raw: string, label = "This URL") => {
      guard.calls.push(raw);
      const host = new URL(raw).hostname;
      if (host.startsWith("169.254.") || host.startsWith("10.")) throw new AppError(422, `${label} points at a private address`);
      return new URL(raw);
    }
  };
});

vi.mock("ldapts", () => ({
  Client: class {
    async bind() {
      if (ldap.bindError) throw ldap.bindError;
    }
    async search() {
      return { searchEntries: [{ dn: "cn=a" }] };
    }
    async unbind() {}
  }
}));

const actor = { id: "sa-1", name: "Root", email: "sa@x.io", role: "SUPER_ADMIN", permissions: [] as string[] };
vi.mock("../../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/middleware/auth.js")>("../../src/middleware/auth.js");
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.user = { ...actor, permissions: [...actor.permissions] };
      next();
    }
  };
});
vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/services/plan-limits.service.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/services/plan-limits.service.js")>("../../src/services/plan-limits.service.js");
  return { ...actual, getAllowedSsoProviders: async () => allowedProviders.current };
});
vi.mock("../../src/config/control-prisma.js", () => ({
  controlPrisma: {
    orgSsoConfig: {
      findUnique: async () => ssoRow.current,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return { ...ssoRow.current, ...data };
      }
    }
  }
}));

const { testSamlConnection, testLdapConnection } = await import("../../src/services/sso-validation.service.js");
const { settingsRouter } = await import("../../src/controllers/settings.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");
const { encryptSecret } = await import("../../src/utils/encryption.js");
const { IDP_A_CERT } = await import("../helpers/saml-idp.js");

type Hop = { status: number; location?: string };
function stubFetch(hops: Record<string, Hop>) {
  const calls: Array<{ url: string; redirect?: string }> = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), redirect: init?.redirect });
    const hop = hops[String(url)];
    if (!hop) throw new Error(`unexpected fetch ${String(url)}`);
    return new Response(null, { status: hop.status, headers: hop.location ? { location: hop.location } : {} });
  });
  return calls;
}

const SAML = { idpEntityId: "https://idp.example.test/entity", idpCertificate: IDP_A_CERT };

beforeEach(() => {
  guard.calls = [];
  ldap.bindError = null;
  allowedProviders.current = ["GOOGLE", "MICROSOFT", "SAML", "LDAP"];
  updates.length = 0;
});
afterEach(() => vi.unstubAllGlobals());

describe("the SAML sign-on URL probe follows redirects only through the egress guard", () => {
  it("refuses a redirect into a private address, and never fetches it", async () => {
    const calls = stubFetch({ "https://idp.example.test/sso": { status: 302, location: "http://169.254.169.254/latest/meta-data/" } });
    const result = await testSamlConnection({ ...SAML, idpSsoUrl: "https://idp.example.test/sso" });

    expect(result.ok).toBe(false);
    expect(calls.map((c) => c.url)).toEqual(["https://idp.example.test/sso"]);
    expect(guard.calls).toContain("http://169.254.169.254/latest/meta-data/");
    // Redirects are followed BY US, hop by hop — never by fetch itself.
    expect(calls[0].redirect).toBe("manual");
  });

  it("follows a redirect to another public address, checking it first", async () => {
    const calls = stubFetch({
      "https://idp.example.test/sso": { status: 302, location: "/login" },
      "https://idp.example.test/login": { status: 200 }
    });
    const result = await testSamlConnection({ ...SAML, idpSsoUrl: "https://idp.example.test/sso" });

    expect(result.ok).toBe(true);
    expect(calls.map((c) => c.url)).toEqual(["https://idp.example.test/sso", "https://idp.example.test/login"]);
    expect(guard.calls).toEqual(["https://idp.example.test/sso", "https://idp.example.test/login"]);
  });

  it("gives up on a redirect loop instead of following it forever", async () => {
    stubFetch({ "https://idp.example.test/a": { status: 302, location: "https://idp.example.test/a" } });
    const result = await testSamlConnection({ ...SAML, idpSsoUrl: "https://idp.example.test/a" });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/redirect/i);
  });
});

describe("the LDAP test's error detail", () => {
  const input = {
    url: "ldap://10.0.0.5:389",
    bindDn: "cn=svc",
    bindCredential: "x",
    searchBase: "dc=acme",
    userFilter: "(mail={{email}})",
    tlsRejectUnauthorized: true
  };

  it("is withheld on a multi-org deployment — the raw socket error is a port scanner's answer", async () => {
    ldap.bindError = new Error("connect ECONNREFUSED 10.0.0.5:389");
    const result = await testLdapConnection({ ...input, revealErrors: false });
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain("ECONNREFUSED");
    expect(result.message).not.toContain("10.0.0.5");
  });

  it("is kept on a single-org install, where the admin IS the operator", async () => {
    ldap.bindError = new Error("connect ECONNREFUSED 10.0.0.5:389");
    const result = await testLdapConnection({ ...input, revealErrors: true });
    expect(result.message).toContain("ECONNREFUSED");
  });
});

describe("POST /settings/sso/:provider/test-connection", () => {
  let client: PrismaClient;
  function app() {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => runInTenant(client, async () => next(), "org-1").catch(next));
    a.use("/api/settings", settingsRouter);
    a.use(errorHandler);
    return a;
  }
  beforeEach(() => {
    client = createFakeTenantClient();
  });

  it("is gated on the plan entitlement, exactly as enabling the provider is", async () => {
    allowedProviders.current = ["GOOGLE"];
    ssoRow.current = {
      id: "cfg-1",
      providerType: "LDAP",
      ldapUrl: "ldaps://dc.acme.example",
      ldapBindDn: "cn=svc",
      encryptedLdapBindCredential: encryptSecret("x"),
      ldapSearchBase: "dc=acme",
      ldapTlsRejectUnauthorized: true
    };
    const res = await request(app()).post("/api/settings/sso/ldap/test-connection").send({});
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/plan/i);
    expect(updates).toHaveLength(0);
  });

  it("records a Microsoft result as UNVERIFIED, not PASS — the credentials were never checked", async () => {
    ssoRow.current = {
      id: "cfg-2",
      providerType: "MICROSOFT",
      clientId: "client",
      encryptedClientSecret: encryptSecret("secret"),
      tenantHint: "aaaaaaaa-0000-4000-8000-000000000001"
    };
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ token_endpoint: "https://login.microsoftonline.com/x/oauth2/v2.0/token" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    const res = await request(app()).post("/api/settings/sso/microsoft/test-connection").send({});
    expect(res.status).toBe(200);
    expect(updates[0]?.lastTestStatus).toBe("UNVERIFIED");
    expect(res.body.status).toBe("UNVERIFIED");
    expect(String(updates[0]?.lastTestMessage)).toMatch(/Configuration looks valid — credentials are verified on first sign-in/);
  });
});
