/**
 * Workspace Settings → Company domains: a super admin may SEE which email domains route people to
 * this workspace. Pinned:
 *  - super admin only — which domains a workspace claims is not every member's business;
 *  - the workspace is the TENANT CONTEXT's, so no request can read another workspace's claims;
 *  - read-only: there is no write verb here (reassigning a claim is an operator action).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

let actor = { id: "sa-1", name: "Boss", email: "b@acme.com", role: "SUPER_ADMIN", permissions: [] as string[] };
vi.mock("../../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/middleware/auth.js")>("../../src/middleware/auth.js");
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.user = { ...actor } as never;
      next();
    }
  };
});
vi.mock("../../src/config/tenant-context.js", () => ({ requireTenantContext: () => ({ orgId: "org-1", orgSlug: "acme" }) }));
const claimsForOrg = vi.fn(async () => [{ domain: "acme.com", status: "UNVERIFIED", source: "SIGNUP", createdAt: new Date("2026-10-01T00:00:00Z") }]);
vi.mock("../../src/services/company-domain-claims.service.js", () => ({ claimsForOrg }));

const { companyDomainsRouter } = await import("../../src/controllers/company-domains.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");
const app = () => {
  const a = express();
  a.use(express.json());
  a.use("/api/settings/company-domains", companyDomainsRouter);
  a.use(errorHandler);
  return a;
};

beforeEach(() => {
  vi.clearAllMocks();
  actor = { id: "sa-1", name: "Boss", email: "b@acme.com", role: "SUPER_ADMIN", permissions: [] };
});

describe("GET /api/settings/company-domains", () => {
  it("lists this workspace's claims to a super admin", async () => {
    const res = await request(app()).get("/api/settings/company-domains?orgId=someone-else");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ domain: "acme.com", status: "UNVERIFIED", source: "SIGNUP", createdAt: "2026-10-01T00:00:00.000Z" }]);
    expect(claimsForOrg).toHaveBeenCalledWith("org-1");
  });

  it("refuses anyone who is not a super admin, even an admin who manages users", async () => {
    actor = { ...actor, role: "ADMIN", permissions: ["users:manage"] };
    expect((await request(app()).get("/api/settings/company-domains")).status).toBe(403);
    expect(claimsForOrg).not.toHaveBeenCalled();
  });

  it("has no write verb", async () => {
    expect((await request(app()).post("/api/settings/company-domains").send({ domain: "evil.com" })).status).toBe(404);
  });
});
