/**
 * A workspace page may make credentialed requests only to its OWN workspace (security audit #13).
 *
 * THE DEFECT: CORS accepted every `*.ROOT_DOMAIN` origin with credentials, and sibling subdomains are
 * "same-site", so the SameSite=Lax refresh cookie rides along. A script on `a.<root>` could POST
 * `b.<root>/api/auth/refresh` and read B's access token out of the response. (It needs script on a
 * sibling subdomain — no XSS was found — but the wildcard was granting more than anything uses.)
 *
 * WHAT ACTUALLY CALLS THE API, mapped before changing anything:
 *  - development: Vite on :5173 proxies /api to :4000 with the Host header preserved, and the page's
 *    Origin is localhost / a LAN address / `*.localhost` — the allow-list or the dev LAN rule, both
 *    untouched here;
 *  - e2e: the same Vite; Playwright's request contexts send no Origin at all;
 *  - production: nginx serves SPA and API on ONE origin and forwards `Host $host`, so a workspace
 *    page's Origin hostname IS the request's Host;
 *  - the platform console lives on the root domain, an explicit WEB_ORIGIN entry, not a wildcard
 *    match; a split deployment (VITE_API_URL) lists its SPA origin explicitly too.
 * So the wildcard branch alone gains the rule "Origin hostname must equal Host", ports aside —
 * nginx's `$host` drops the port, and scheme and port are already pinned against WEB_ORIGIN.
 *
 * And `/auth/refresh` and `/auth/sso/handoff` check the same rule themselves, so the property does not
 * depend on the CORS middleware staying where it is mounted.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

vi.mock("../../src/config/control-prisma.js", () => ({ controlPrisma: { orgAuthMethod: { findUnique: vi.fn().mockResolvedValue(null) } } }));
const refresh = vi.fn(async () => ({ accessToken: "a", refreshToken: null, refreshTokenExpiresAt: new Date(), persistentCookie: true }));
const redeemHandoffCode = vi.fn(async () => ({ ok: false }));
vi.mock("../../src/services/auth.service.js", async (importActual) => ({
  ...(await importActual<typeof import("../../src/services/auth.service.js")>()),
  refresh
}));
vi.mock("../../src/services/sso-handoff.service.js", () => ({ redeemHandoffCode }));

const { isOriginAllowedForHost } = await import("../../src/config/origins.js");
const { env } = await import("../../src/config/env.js");
const { authRouter } = await import("../../src/controllers/auth.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");
const { tenantContext } = await import("../../src/config/tenant-context.js");

const ROOT = "timesphere.test";
const LIST = ["https://timesphere.test", "http://localhost:5173"];

describe("isOriginAllowedForHost", () => {
  it("lets a workspace page call its own workspace", () => {
    expect(isOriginAllowedForHost("https://acme.timesphere.test", "acme.timesphere.test", LIST, false, ROOT)).toBe(true);
  });

  it("refuses a workspace page calling a SIBLING workspace", () => {
    expect(isOriginAllowedForHost("https://acme.timesphere.test", "beta.timesphere.test", LIST, false, ROOT)).toBe(false);
  });

  it("compares hostnames, not ports — nginx's $host carries none", () => {
    const list = ["https://timesphere.test:8443"];
    expect(isOriginAllowedForHost("https://acme.timesphere.test:8443", "acme.timesphere.test", list, false, ROOT)).toBe(true);
  });

  it("leaves explicitly listed origins alone — the platform console and split deployments", () => {
    expect(isOriginAllowedForHost("https://timesphere.test", "api.timesphere.test", LIST, false, ROOT)).toBe(true);
  });

  it("leaves the development LAN rule alone — Vite's own origin", () => {
    expect(isOriginAllowedForHost("http://acme.localhost:5173", "acme.localhost:5173", LIST, true, ROOT)).toBe(true);
    expect(isOriginAllowedForHost("http://192.168.1.20:5173", "localhost:4000", LIST, true, ROOT)).toBe(true);
  });

  it("treats a request with no Origin as not cross-origin, as before", () => {
    expect(isOriginAllowedForHost(undefined, "beta.timesphere.test", LIST, false, ROOT)).toBe(true);
  });

  it("still refuses an origin outside the deployment entirely", () => {
    expect(isOriginAllowedForHost("https://evil.example", "acme.timesphere.test", LIST, false, ROOT)).toBe(false);
  });
});

describe("/auth/refresh and /auth/sso/handoff check Origin themselves", () => {
  const saved = { root: env.ROOT_DOMAIN, web: env.WEB_ORIGIN, nodeEnv: env.NODE_ENV };
  afterEach(() => {
    env.ROOT_DOMAIN = saved.root;
    env.WEB_ORIGIN = saved.web;
    env.NODE_ENV = saved.nodeEnv;
    vi.clearAllMocks();
  });

  function buildApp() {
    env.ROOT_DOMAIN = ROOT;
    env.WEB_ORIGIN = LIST.join(",");
    env.NODE_ENV = "production";
    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    app.use((_req, _res, next) => tenantContext.run({ orgId: "org-b", orgSlug: "beta", client: {} as never }, () => next()));
    app.use("/api/auth", authRouter);
    app.use(errorHandler);
    return app;
  }

  it("refuses a refresh sent from a sibling workspace, before the cookie is even read", async () => {
    const res = await request(buildApp())
      .post("/api/auth/refresh")
      .set("Host", "beta.timesphere.test")
      .set("Origin", "https://acme.timesphere.test")
      .set("Cookie", "refreshToken=whatever");
    expect(res.status).toBe(403);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("serves a refresh from the workspace's own page", async () => {
    const res = await request(buildApp())
      .post("/api/auth/refresh")
      .set("Host", "beta.timesphere.test")
      .set("Origin", "https://beta.timesphere.test")
      .set("Cookie", "refreshToken=whatever");
    expect(res.status).toBe(200);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("serves a refresh with no Origin at all (a same-origin GET-style caller, curl, the e2e request context)", async () => {
    const res = await request(buildApp()).post("/api/auth/refresh").set("Host", "beta.timesphere.test").set("Cookie", "refreshToken=x");
    expect(res.status).toBe(200);
  });

  it("refuses a handoff redeemed from a sibling workspace's page", async () => {
    const res = await request(buildApp())
      .post("/api/auth/sso/handoff")
      .set("Host", "beta.timesphere.test")
      .set("Origin", "https://acme.timesphere.test")
      .send({ code: "abc" });
    expect(res.status).toBe(403);
    expect(redeemHandoffCode).not.toHaveBeenCalled();
  });
});
