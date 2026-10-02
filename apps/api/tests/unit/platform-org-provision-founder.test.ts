/**
 * POST /platform-admin/organizations/:id/provision — the founder's first password (review R1-6).
 *
 * The OPERATOR types it. It skipped the password policy every other admin-typed password meets
 * (user create, CSV import, resets — utils/password-policy.ts) and was not flagged
 * `mustChangePassword`, so it escaped both the policy and the gate: "the rule lives in one caller".
 * Now it meets the policy, and the founder is created behind the tenant's change-password gate, so
 * the password they actually keep is one they chose.
 *
 * Self-serve signup also provisions, but there the founder chose the password, so it must NOT be
 * flagged — which is why the flag is the console route's to pass, not the provisioning service's.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const ORG = { id: "org-1", slug: "acme", status: "PROVISIONING" };
const ACTOR = { id: "pa-1", name: "Ops", email: "ops@timesphere.app", role: "OPERATOR" as const };
const REASON = "Ticket 5120 - onboarding Acme";

const control = {
  organization: { findUnique: vi.fn() },
  platformAuditLog: { create: vi.fn() }
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

vi.mock("../../src/config/with-org-tenant.js", () => ({ withOrgTenant: vi.fn(async (_slug: string, fn: () => Promise<unknown>) => fn()) }));
vi.mock("../../src/services/notify.service.js", () => ({ dispatchTransactional: vi.fn() }));
vi.mock("../../src/services/platform-mail.service.js", () => ({ sendPlatformTemplate: vi.fn(), resolvePlatformMailConfig: vi.fn() }));
const provisionOrganization = vi.fn();
vi.mock("../../src/services/provisioning.service.js", () => ({ provisionOrganization }));
vi.mock("../../src/services/platform-admin-analytics.service.js", () => ({ getPlatformAnalytics: vi.fn() }));
vi.mock("../../src/services/org-domain.service.js", () => ({ addDomain: vi.fn(), listDomains: vi.fn(), removeDomain: vi.fn(), verifyDomain: vi.fn() }));
vi.mock("../../src/services/workspace-directory.service.js", () => ({ workspaceUrlForSlug: (slug: string) => `https://${slug}.example.test` }));

const { platformAdminRouter } = await import("../../src/controllers/platform-admin.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/platform-admin", platformAdminRouter);
  app.use(errorHandler);
  return app;
}

const provision = (adminPassword: string, adminEmail = "jane@acme.example") =>
  request(buildApp()).post(`/api/platform-admin/organizations/${ORG.id}/provision`).set("X-Platform-Reason", REASON).send({ adminEmail, adminName: "Jane Doe", adminPassword });

beforeEach(() => {
  vi.clearAllMocks();
  control.organization.findUnique.mockResolvedValue(ORG);
  provisionOrganization.mockResolvedValue({ organizationId: ORG.id, databaseName: "ts_acme", schemaVersion: "1", domainClaim: { outcome: "claimed", domain: "acme.example" } });
});

describe("the founder password an operator types when provisioning", () => {
  it("is refused when it is one of the most common passwords, before anything is provisioned", async () => {
    const res = await provision("password123");
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/most commonly used/i);
    expect(provisionOrganization).not.toHaveBeenCalled();
  });

  it("is refused when it is built from the founder's own address", async () => {
    const res = await provision("JaneJane-2026", "jane@acme.example");
    expect(res.status).toBe(422);
    expect(provisionOrganization).not.toHaveBeenCalled();
  });

  it("creates the founder behind the change-password gate, so the password they keep is their own", async () => {
    const res = await provision("Plum-Harbour-Lantern-7");
    expect(res.status).toBe(200);
    expect(provisionOrganization).toHaveBeenCalledWith(ORG.id, expect.objectContaining({ adminPassword: "Plum-Harbour-Lantern-7", mustChangePassword: true }));
  });
});
