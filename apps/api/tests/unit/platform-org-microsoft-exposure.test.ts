/**
 * The platform console's org detail flags a workspace whose Microsoft sign-in accepts ANY directory
 * (audit C1, staged rollout step d) — read-only, with the directories it has actually been used from,
 * so an operator can see which customers are exposed and who they would shut out by pinning.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const ACTOR = { id: "pa-1", name: "Ops", email: "ops@timesphere.app", role: "SUPPORT" as const };
const ORG = { id: "org-1", slug: "acme", status: "ACTIVE", database: null, authMethod: null, ssoConfigs: [] as unknown[] };

const control = {
  organization: { findUnique: vi.fn() },
  orgSsoObservedTenant: {
    findMany: vi.fn().mockResolvedValue([
      { tenantId: "tid-home", emailDomain: "acme.example", count: 9, firstSeenAt: new Date("2026-10-02"), lastSeenAt: new Date("2026-10-02") },
      { tenantId: "tid-other", emailDomain: "elsewhere.example", count: 1, firstSeenAt: new Date("2026-10-02"), lastSeenAt: new Date("2026-10-02") }
    ])
  }
};
vi.mock("../../src/config/control-prisma.js", () => ({ controlPrisma: control }));
vi.mock("../../src/middleware/platform-admin-auth.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/middleware/platform-admin-auth.js")>();
  return {
    ...actual,
    requirePlatformAdmin: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.platformAdmin = { ...ACTOR };
      req.platformAdminSessionId = "sess-1";
      next();
    }
  };
});
vi.mock("../../src/services/notify.service.js", () => ({ dispatchTransactional: vi.fn() }));
vi.mock("../../src/services/provisioning.service.js", () => ({ provisionOrganization: vi.fn() }));
vi.mock("../../src/services/platform-admin-analytics.service.js", () => ({ getPlatformAnalytics: vi.fn() }));

const { platformAdminRouter } = await import("../../src/controllers/platform-admin.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/platform-admin", platformAdminRouter);
  a.use(errorHandler);
  return a;
}

beforeEach(() => control.organization.findUnique.mockReset());

describe("GET /platform-admin/organizations/:id — Microsoft sign-in exposure", () => {
  it("flags Microsoft sign-in with no tenant ID as accepting any directory, with the directories seen", async () => {
    control.organization.findUnique.mockResolvedValue({ ...ORG, ssoConfigs: [{ providerType: "MICROSOFT", isEnabled: true, tenantHint: null }] });
    const res = await request(app()).get("/api/platform-admin/organizations/org-1");
    expect(res.status).toBe(200);
    expect(res.body.microsoftSignIn).toMatchObject({
      acceptsAnyDirectory: true,
      observedDirectories: [
        { tenantId: "tid-home", count: 9, emailDomains: [{ domain: "acme.example", count: 9 }] },
        { tenantId: "tid-other", count: 1 }
      ]
    });
  });

  it("does not flag a pinned configuration", async () => {
    control.organization.findUnique.mockResolvedValue({ ...ORG, ssoConfigs: [{ providerType: "MICROSOFT", isEnabled: true, tenantHint: "tid-home" }] });
    const res = await request(app()).get("/api/platform-admin/organizations/org-1");
    expect(res.body.microsoftSignIn).toMatchObject({ acceptsAnyDirectory: false, tenantId: "tid-home" });
  });

  it("is null when Microsoft sign-in is not switched on", async () => {
    control.organization.findUnique.mockResolvedValue({ ...ORG, ssoConfigs: [{ providerType: "MICROSOFT", isEnabled: false, tenantHint: null }] });
    const res = await request(app()).get("/api/platform-admin/organizations/org-1");
    expect(res.body.microsoftSignIn).toBeNull();
  });
});
