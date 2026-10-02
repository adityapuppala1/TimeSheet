/**
 * provisionOrganization claims the owner's company domain — and a claim it cannot make never fails
 * the provisioning.
 *
 * THE GAP. Claims were made only by signup, by the one-off backfill and by hand. A workspace an
 * operator provisioned from the console got none, so once the backfill had run, Acme's colleagues
 * who had not signed in yet found "no workspace" at /signup and started a second, competing trial.
 *
 * WHY A CONFLICT IS NOT AN ERROR. By the time the claim is attempted the database exists, is migrated
 * and seeded, and the workspace is ACTIVE. Failing the request then would tell the operator a working
 * workspace failed to provision. The conflict travels back in the result and the audit row instead.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  orgFindUnique: vi.fn(),
  orgUpdate: vi.fn(),
  orgDatabaseUpsert: vi.fn(),
  claim: vi.fn()
}));

vi.mock("../../src/config/env.js", () => ({ env: { TENANT_DB_PROVISION_BASE_URL: "mysql://root:pw@db.internal:3306/mysql", ENCRYPTION_KEY: "6e74a4d4d87c469904ac4d9f7cd499934a54566bf7b8ee322364b36e60f84458" } }));
vi.mock("@prisma/client", () => ({
  PrismaClient: class {
    $executeRawUnsafe = vi.fn(async () => 0);
    $disconnect = vi.fn(async () => undefined);
  }
}));
vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
vi.mock("../../src/config/prisma.js", () => ({ getTenantClient: vi.fn(async () => ({})) }));
vi.mock("../../prisma/seed.js", () => ({ seedTenant: vi.fn(async () => undefined) }));
vi.mock("../../src/config/control-prisma.js", () => ({
  controlPrisma: { organization: { findUnique: m.orgFindUnique, update: m.orgUpdate }, orgDatabase: { upsert: m.orgDatabaseUpsert } }
}));
vi.mock("../../src/services/company-domain-claims.service.js", () => ({ claimDomainForProvisionedOrg: m.claim }));

const { provisionOrganization } = await import("../../src/services/provisioning.service.js");

const input = { adminEmail: "Admin@Acme.com", adminName: "Ada", adminPassword: "Password-12" };

beforeEach(() => {
  vi.clearAllMocks();
  m.orgFindUnique.mockResolvedValue({ id: "org-1", slug: "acme", status: "PROVISIONING" });
  m.orgUpdate.mockResolvedValue({});
  m.orgDatabaseUpsert.mockResolvedValue({});
});

describe("provisionOrganization and the company domain", () => {
  it("claims the owner's domain once the workspace is ACTIVE, and reports it", async () => {
    m.claim.mockResolvedValue({ outcome: "claimed", domain: "acme.com" });

    const result = await provisionOrganization("org-1", input);

    expect(m.claim).toHaveBeenCalledWith({ id: "org-1", ownerEmail: "admin@acme.com" });
    // After the status flip: the claim points strangers at a workspace that can actually take them.
    expect(m.orgUpdate.mock.invocationCallOrder[0]).toBeLessThan(m.claim.mock.invocationCallOrder[0]);
    expect(result.domainClaim).toEqual({ outcome: "claimed", domain: "acme.com" });
  });

  it("finishes provisioning when another workspace already holds the domain, and says which", async () => {
    const conflict = { outcome: "conflict", domain: "acme.com", heldBy: { id: "old", name: "Acme (2024)", slug: "acme-old" } };
    m.claim.mockResolvedValue(conflict);

    const result = await provisionOrganization("org-1", input);

    expect(result.domainClaim).toEqual(conflict);
    expect(result.organizationId).toBe("org-1");
  });

  it("finishes provisioning even when the claim itself fails", async () => {
    m.claim.mockRejectedValue(new Error("control plane hiccup"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await provisionOrganization("org-1", input);

    expect(result.domainClaim).toEqual({ outcome: "error", domain: null, detail: "control plane hiccup" });
  });
});
