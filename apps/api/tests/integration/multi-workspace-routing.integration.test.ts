/**
 * Two workspaces, one deployment, over real HTTP — the coverage that did not exist.
 *
 * WHY THIS FILE IS HERE. Everything about multi-workspace routing was tested as pure functions:
 * `resolveOrgSlug` against hostnames, `isOriginAllowed` against origins. Both passed throughout the
 * period when subdomain routing did not work in a browser at all, because the defects were in how
 * the pieces COMPOSE — a proxy replacing `Host` before the router sees it, and a CORS layer refusing
 * the very origin the router had just accepted. The Playwright suite runs against one organization
 * and would not have caught either.
 *
 * So this drives the real middleware stack with supertest: the real `cors()` configured the way
 * app.ts configures it, the real `resolveTenant`, and a probe route that reports which workspace the
 * request arrived in. No database and no browser — the control plane and the tenant client are faked
 * so the code under test is the routing, not Prisma.
 *
 * THE SHAPE IT PINS, which is the thing that confused everybody: a same-origin GET carries no
 * `Origin` header, so the login page renders perfectly; the POST that follows carries one and was
 * refused. A test that only checked GETs would have reported the whole system healthy.
 */
import express from "express";
import cors from "cors";
import request from "supertest";
import { beforeAll, describe, expect, it, vi } from "vitest";

/** Two workspaces and one archived-looking stranger, as the control plane would report them. */
const ORGS: Record<string, { id: string; slug: string; status: string }> = {
  default: { id: "org-default", slug: "default", status: "ACTIVE" },
  acme: { id: "org-acme", slug: "acme", status: "ACTIVE" }
};

vi.mock("../../src/config/control-prisma.js", () => ({
  controlPrisma: {
    organization: {
      findUnique: async ({ where }: { where: { slug: string } }) => {
        const org = ORGS[where.slug];
        // `database` must be present or `resolveActiveOrgBySlug` 404s — the DSN is decrypted by a
        // mocked `decryptSecret` below and never used, because `getTenantClient` is faked too.
        return org ? { ...org, database: { encryptedDsn: "encrypted:" + org.slug } } : null;
      }
    },
    orgDomain: {
      findUnique: async ({ where }: { where: { domain: string } }) =>
        where.domain === "time.acme.example"
          ? { verifiedAt: new Date(), organization: { slug: "acme" } }
          : null
    }
  }
}));

vi.mock("../../src/config/prisma.js", () => ({
  getTenantClient: async () => ({}),
  prisma: {}
}));

vi.mock("../../src/utils/encryption.js", () => ({
  decryptSecret: (value: string) => value,
  encryptSecret: (value: string) => value
}));

type App = ReturnType<typeof express>;
let app: App;

beforeAll(async () => {
  // Set BEFORE the first import: `config/env.ts` parses process.env once, and dotenv fills in an
  // ABSENT variable from the developer's own .env — so "" rather than delete, the same hermeticity
  // lesson as tenant-host-routing.test.ts.
  process.env.ROOT_DOMAIN = "timesphere.test";
  process.env.WEB_ORIGIN = "https://timesphere.test";
  process.env.NODE_ENV = "production"; // so the private-LAN development shortcut cannot mask anything

  const [{ resolveTenant }, { isOriginAllowed }, { tenantContext }] = await Promise.all([
    import("../../src/middleware/tenant.js"),
    import("../../src/config/origins.js"),
    import("../../src/config/tenant-context.js")
  ]);
  const { errorHandler, AppError } = await import("../../src/middleware/error.js");

  const allowList = ["https://timesphere.test"];
  const verifiedCustomDomains = (hostname: string) => hostname === "time.acme.example";

  app = express();
  // Mirrors app.ts: CORS first, then JSON, then tenant resolution, then the routers.
  app.use(
    cors({
      origin(origin, callback) {
        if (isOriginAllowed(origin, allowList, false, process.env.ROOT_DOMAIN, verifiedCustomDomains)) {
          return callback(null, true);
        }
        // `AppError`, exactly as app.ts does. A plain Error falls through errorHandler's generic
        // 500 branch, which would make this fixture report a server fault for a correctly enforced
        // refusal — and the first version of this file did precisely that.
        callback(new AppError(403, "Origin not allowed"));
      },
      credentials: true
    })
  );
  app.use(express.json());
  app.use("/api", resolveTenant);
  // The probe: reports the workspace this request actually landed in.
  const whoami = (_req: express.Request, res: express.Response) =>
    res.json({ slug: tenantContext.getStore()?.orgSlug ?? null });
  app.get("/api/whoami", whoami);
  app.post("/api/whoami", whoami);
  app.use(errorHandler);
});

describe("which workspace a request lands in", () => {
  it.each([
    ["acme.timesphere.test", "acme"],
    ["default.timesphere.test", "default"],
    ["timesphere.test", "default"],
    ["www.timesphere.test", "default"]
  ])("GET with Host %s -> %s", async (host, slug) => {
    const res = await request(app).get("/api/whoami").set("Host", host);
    expect(res.status).toBe(200);
    expect(res.body.slug).toBe(slug);
  });

  it("404s a workspace that does not exist, without saying so differently", async () => {
    const res = await request(app).get("/api/whoami").set("Host", "nobody.timesphere.test");
    expect(res.status).toBe(404);
  });

  it("routes a verified custom domain to its workspace", async () => {
    const res = await request(app).get("/api/whoami").set("Host", "time.acme.example");
    expect(res.body.slug).toBe("acme");
  });
});

describe("the proxy that rewrites Host", () => {
  it("sends every workspace to the default one — the regression, reproduced", async () => {
    /**
     * WHAT A MISCONFIGURED PROXY DOES, and why nothing catches it: the request is well-formed, the
     * response is 200, and the workspace is simply the wrong one. This is what Vite's
     * `changeOrigin: true` did on every developer machine, and what nginx's `proxy_pass` does by
     * default without `proxy_set_header Host $host`.
     */
    const res = await request(app).get("/api/whoami").set("Host", "localhost:4000");
    expect(res.status).toBe(200);
    expect(res.body.slug).toBe("default");
  });
});

describe("CORS and the router have to agree", () => {
  it("accepts a write from a workspace's own origin, and lands it in that workspace", async () => {
    // The composition that was broken: the router accepts `acme.timesphere.test` as a workspace
    // while CORS refused the identical string as an origin.
    const res = await request(app)
      .post("/api/whoami")
      .set("Host", "acme.timesphere.test")
      .set("Origin", "https://acme.timesphere.test")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.slug).toBe("acme");
  });

  it("renders the page and then refuses the write, if CORS disagrees", async () => {
    /**
     * THE FAILURE SHAPE THAT COST TWO SESSIONS TO UNDERSTAND. A same-origin GET sends no `Origin`
     * header, so it sails through and the login page renders with the right branding and the right
     * SSO buttons. The POST that follows carries one. Asserted as a PAIR, because either half alone
     * describes a system that looks fine.
     */
    const host = "acme.timesphere.test";
    const stranger = "https://evil.example.com";

    const read = await request(app).get("/api/whoami").set("Host", host);
    expect(read.status).toBe(200);

    const write = await request(app).post("/api/whoami").set("Host", host).set("Origin", stranger).send({});
    expect(write.status).toBe(403);
  });

  it("accepts a write from a verified custom domain", async () => {
    const res = await request(app)
      .post("/api/whoami")
      .set("Host", "time.acme.example")
      .set("Origin", "https://time.acme.example")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.slug).toBe("acme");
  });

  it("refuses a workspace origin over plain http on an https deployment", async () => {
    // The transport is pinned even though the subdomain floats — otherwise a network attacker who
    // can answer http gets an origin the API believes.
    const res = await request(app)
      .post("/api/whoami")
      .set("Host", "acme.timesphere.test")
      .set("Origin", "http://acme.timesphere.test")
      .send({});
    expect(res.status).toBe(403);
  });
});

describe("isolation between the two workspaces", () => {
  it("never leaks one workspace's context into the next request", async () => {
    /**
     * `tenantContext` is AsyncLocalStorage, and the failure mode of getting that wrong is the worst
     * one this product has: a request served with another customer's database. Interleaved on
     * purpose rather than run in sequence — a leak that only appears under concurrency is exactly
     * the kind a sequential test misses.
     */
    const hosts = ["acme", "default", "acme", "default", "acme"].map((s) => `${s}.timesphere.test`);
    const results = await Promise.all(hosts.map((host) => request(app).get("/api/whoami").set("Host", host)));
    expect(results.map((r) => r.body.slug)).toEqual(["acme", "default", "acme", "default", "acme"]);
  });
});
