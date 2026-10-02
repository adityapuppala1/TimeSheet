/**
 * The SSO start, callback and ACS routes — WHERE a sign-in begins and WHERE a failure sends the
 * person, driven through the real router with supertest.
 *
 * TWO DEFECTS ARE PINNED HERE.
 *
 *  - H4: the start routes resolved the workspace with `resolveOrgSlug` alone, which maps every
 *    hostname outside ROOT_DOMAIN to DEFAULT_ORG_SLUG. On a verified custom domain the login page
 *    (whose `/sso-methods` goes through resolveTenant, custom domains included) showed Acme's buttons,
 *    and pressing one started the DEFAULT workspace's flow — another customer's.
 *
 *  - M3 / auth #18: every failure on these routes reached the JSON error handler, on the API host,
 *    outside the SPA. Cancelling at the IdP (`?error=access_denied`) was a 500 with the full callback
 *    URL in the log. Every failure now redirects to that workspace's login page with a code.
 *
 * ROOT_DOMAIN is set for this file (multi-org mode) — it is the mode both defects live in. The OIDC
 * and SAML protocol work itself is replaced: what is under test is the routing around it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.hoisted(() => {
  process.env.ROOT_DOMAIN = "timesphere.example";
});

const orgs = [
  { id: "org-default", slug: "default", status: "ACTIVE" },
  { id: "org-acme", slug: "acme", status: "ACTIVE" }
];

const { sso, completeSsoLogin } = vi.hoisted(() => ({
  sso: {
    buildAuthorizationRedirect: vi.fn(),
    buildSamlAuthorizationRedirect: vi.fn(),
    completeAuthorizationCodeGrant: vi.fn(),
    completeSamlLogin: vi.fn()
  },
  completeSsoLogin: vi.fn()
}));

vi.mock("../../src/config/control-prisma.js", async () => {
  const { encryptSecret } = await vi.importActual<typeof import("../../src/utils/encryption.js")>("../../src/utils/encryption.js");
  const withDb = (org: (typeof orgs)[number] | undefined) =>
    org ? { ...org, database: { encryptedDsn: encryptSecret("mysql://tenant") } } : null;
  return {
    controlPrisma: {
      organization: {
        findUnique: async ({ where }: { where: { slug?: string; id?: string } }) => withDb(orgs.find((o) => o.slug === where.slug || o.id === where.id)),
        findUniqueOrThrow: async ({ where }: { where: { id: string } }) => withDb(orgs.find((o) => o.id === where.id))
      },
      orgDomain: {
        findUnique: async ({ where }: { where: { domain: string } }) =>
          where.domain === "time.acme.example" ? { verifiedAt: new Date(), organization: { slug: "acme" } } : null
      },
      orgSsoConfig: { updateMany: async () => ({ count: 1 }) },
      ssoHandoffCode: { create: async () => ({}), deleteMany: async () => ({ count: 0 }) }
    }
  };
});
vi.mock("../../src/config/prisma.js", () => ({ getTenantClient: async () => ({}) }));
vi.mock("../../src/services/auth.service.js", () => ({ completeSsoLogin }));
vi.mock("../../src/services/sso.service.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/services/sso.service.js")>("../../src/services/sso.service.js");
  return { ...actual, ...sso };
});

const { ssoRouter } = await import("../../src/controllers/sso.controller.js");
const { signSsoState } = await import("../../src/services/sso.service.js");
const { AppError } = await import("../../src/middleware/error.js");
const { ssoErrorCodeFor } = await import("../../src/utils/sso-error-code.js");

function app() {
  const a = express();
  a.use("/api/auth/sso", ssoRouter);
  return a;
}

const ACME_LOGIN = "https://acme.timesphere.example/login";
const stateFor = (orgId: string, provider: "GOOGLE" | "MICROSOFT" | "SAML" = "GOOGLE") =>
  signSsoState({ orgId, provider, ...(provider === "SAML" ? {} : { codeVerifier: "v".repeat(43) }) });

let logged: string[];

beforeEach(() => {
  vi.clearAllMocks();
  sso.buildAuthorizationRedirect.mockImplementation(async (orgId: string) => `https://idp.example/authorize?for=${orgId}`);
  sso.buildSamlAuthorizationRedirect.mockImplementation(async (orgId: string) => `https://idp.example/saml?for=${orgId}`);
  logged = [];
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
  }
});

describe("SSO started on a verified custom domain (H4)", () => {
  it("starts the custom domain's OWN workspace's Google flow, not the default one", async () => {
    const res = await request(app()).get("/api/auth/sso/google/start").set("Host", "time.acme.example");
    expect(res.status).toBe(302);
    expect(sso.buildAuthorizationRedirect).toHaveBeenCalledWith("org-acme", "GOOGLE");
    expect(res.headers.location).toContain("for=org-acme");
  });

  it("does the same for SAML", async () => {
    await request(app()).get("/api/auth/sso/saml/start").set("Host", "time.acme.example");
    expect(sso.buildSamlAuthorizationRedirect).toHaveBeenCalledWith("org-acme");
  });

  it("still resolves an ordinary workspace subdomain exactly as before", async () => {
    await request(app()).get("/api/auth/sso/microsoft/start").set("Host", "acme.timesphere.example");
    expect(sso.buildAuthorizationRedirect).toHaveBeenCalledWith("org-acme", "MICROSOFT");
  });

  it("sends a failed start on a custom domain back to THAT domain's login page", async () => {
    sso.buildAuthorizationRedirect.mockRejectedValue(new AppError(404, "Google sign-in isn't configured for this workspace."));
    const res = await request(app()).get("/api/auth/sso/google/start").set("Host", "time.acme.example");
    expect(res.headers.location).toBe("https://time.acme.example/login?sso_error=config");
  });
});

describe("every SSO failure lands on the workspace's login page with a code (M3)", () => {
  it("turns the IdP's access_denied into `cancelled`, not a 500", async () => {
    const res = await request(app()).get(`/api/auth/sso/google/callback?error=access_denied&state=${encodeURIComponent(stateFor("org-acme"))}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${ACME_LOGIN}?sso_error=cancelled`);
    expect(sso.completeAuthorizationCodeGrant).not.toHaveBeenCalled();
  });

  it("reports any other provider error as `failed`", async () => {
    const res = await request(app()).get(`/api/auth/sso/microsoft/callback?error=server_error&state=${encodeURIComponent(stateFor("org-acme", "MICROSOFT"))}`);
    expect(res.headers.location).toBe(`${ACME_LOGIN}?sso_error=failed`);
  });

  it("sends an expired or forged state to the deployment's own login page, since the workspace is unknown", async () => {
    sso.completeAuthorizationCodeGrant.mockRejectedValue(new AppError(400, "expired", { code: "SSO_EXPIRED" }));
    const res = await request(app()).get("/api/auth/sso/google/callback?code=c&state=not-a-real-state");
    expect(res.headers.location).toBe("http://localhost:5173/login?sso_error=expired");
  });

  it("maps a refused unverified Google address to `email_unverified`", async () => {
    sso.completeAuthorizationCodeGrant.mockRejectedValue(new AppError(403, "unverified", { code: "SSO_EMAIL_UNVERIFIED" }));
    const res = await request(app()).get(`/api/auth/sso/google/callback?code=c&state=${encodeURIComponent(stateFor("org-acme"))}`);
    expect(res.headers.location).toBe(`${ACME_LOGIN}?sso_error=email_unverified`);
  });

  it.each([
    [new AppError(403, "Account is not active", { code: "SSO_INACTIVE" }), "inactive"],
    [new AppError(402, "This workspace has reached its seat limit"), "seat_limit"],
    [new AppError(503, "maintenance", { code: "MAINTENANCE" }), "maintenance"],
    [new AppError(403, "This is an automation identity and cannot be signed in to."), "not_allowed"],
    [new Error("database exploded"), "failed"]
  ])("maps a sign-in refused by %s to `%s`", async (error, code) => {
    sso.completeAuthorizationCodeGrant.mockResolvedValue({ orgId: "org-acme", identity: { email: "sam@acme.example", name: "Sam", emailVerified: true } });
    completeSsoLogin.mockRejectedValue(error);
    const res = await request(app()).get(`/api/auth/sso/google/callback?code=c&state=${encodeURIComponent(stateFor("org-acme"))}`);
    expect(res.headers.location).toBe(`${ACME_LOGIN}?sso_error=${code}`);
  });

  it("redirects a failed SAML ACS post to the RelayState's workspace", async () => {
    sso.completeSamlLogin.mockRejectedValue(new Error("Invalid signature"));
    const res = await request(app())
      .post("/api/auth/sso/saml/acs")
      .type("form")
      .send({ SAMLResponse: "PHg+", RelayState: stateFor("org-acme", "SAML") });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${ACME_LOGIN}?sso_error=failed`);
  });

  it("sends a start for a hostname that is no workspace to the deployment's login page", async () => {
    const res = await request(app()).get("/api/auth/sso/google/start").set("Host", "nobody.timesphere.example");
    expect(res.headers.location).toBe("http://localhost:5173/login?sso_error=failed");
  });

  it("never logs the callback's query string — it carries the authorization code", async () => {
    sso.completeAuthorizationCodeGrant.mockRejectedValue(new Error("token endpoint said no"));
    await request(app()).get(`/api/auth/sso/google/callback?code=SECRET-AUTH-CODE&state=${encodeURIComponent(stateFor("org-acme"))}`);
    await request(app()).get(`/api/auth/sso/google/callback?error=access_denied&error_description=x&state=${encodeURIComponent(stateFor("org-acme"))}`);
    expect(logged.join("\n")).not.toContain("SECRET-AUTH-CODE");
    expect(logged.join("\n")).not.toContain("state=");
  });

  it("still completes a sign-in that succeeds", async () => {
    sso.completeAuthorizationCodeGrant.mockResolvedValue({ orgId: "org-acme", identity: { email: "sam@acme.example", name: "Sam", emailVerified: true } });
    completeSsoLogin.mockResolvedValue({ accessToken: "a", refreshToken: "r", refreshTokenExpiresAt: new Date(Date.now() + 60_000), user: {} });
    const res = await request(app()).get(`/api/auth/sso/google/callback?code=c&state=${encodeURIComponent(stateFor("org-acme"))}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).not.toContain("sso_error");
  });
});

describe("ssoErrorCodeFor", () => {
  it("prefers the explicit SSO code over the status", () => {
    expect(ssoErrorCodeFor(new AppError(403, "x", { code: "SSO_NOT_PROVISIONED" }))).toBe("not_provisioned");
    expect(ssoErrorCodeFor(new AppError(400, "x", { code: "SSO_CONFIG" }))).toBe("config");
  });

  it("falls back to `failed` for anything it does not recognise", () => {
    expect(ssoErrorCodeFor(new AppError(500, "x"))).toBe("failed");
    expect(ssoErrorCodeFor("a string")).toBe("failed");
  });
});
