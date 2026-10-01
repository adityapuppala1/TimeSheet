/**
 * Deleting a workspace under the retention policy releases its company-domain claims (signup
 * Phase 1). `findClaimForEmail` already reads an ARCHIVED workspace's claim as "none", so this is not
 * about the lookup — it is about the unique key: a claim row left behind would make the company's
 * NEXT signup fail with "your company already has a workspace", pointing at one that no longer exists.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-10-01T10:00:00Z");
const lapsedTrial = {
  id: "org-1",
  name: "Northwind",
  slug: "northwind",
  status: "SUSPENDED",
  planTier: "STARTER",
  trialTier: "TEAM",
  trialStartedAt: new Date(now.getTime() - 200 * DAY),
  trialEndsAt: new Date(now.getTime() - 185 * DAY),
  graceStartedAt: new Date(now.getTime() - 185 * DAY),
  stripeSubscriptionId: null,
  retentionHold: false,
  retentionNoticesSent: [],
  retentionDeletedAt: null,
  ownerEmail: null,
  database: null
};

const deletions: string[] = [];
const deleteMany = (table: string) => vi.fn(async ({ where }: { where: { organizationId: string } }) => {
  deletions.push(`${table}:${where.organizationId}`);
  return { count: 1 };
});
const control = {
  organization: { findUnique: vi.fn(async () => lapsedTrial), update: vi.fn(async () => ({})) },
  platformRetentionSettings: {
    findUnique: vi.fn(async () => null),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...data, snapshotDir: null, updatedAt: now }))
  },
  orgDatabase: { deleteMany: deleteMany("orgDatabase") },
  orgUserDirectory: { deleteMany: deleteMany("orgUserDirectory") },
  orgDomain: { deleteMany: deleteMany("orgDomain") },
  orgSsoConfig: { deleteMany: deleteMany("orgSsoConfig") },
  orgEmailDomain: { deleteMany: deleteMany("orgEmailDomain") },
  $transaction: vi.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops))
};
vi.mock("../../src/config/control-prisma.js", () => ({ controlPrisma: control }));
vi.mock("../../src/config/prisma.js", () => ({ prisma: {}, disconnectAllTenantClients: vi.fn(async () => undefined) }));
vi.mock("../../src/config/with-org-tenant.js", () => ({ withOrgTenant: vi.fn() }));
vi.mock("../../src/services/org-status.service.js", () => ({ forgetOrgStatus: vi.fn() }));
vi.mock("../../src/services/platform-audit.service.js", () => ({ platformAudit: vi.fn(async () => undefined) }));
vi.mock("../../src/services/platform-mail.service.js", () => ({ sendPlatformTemplate: vi.fn(async () => ({ ok: true })) }));
vi.mock("../../src/services/workspace-directory.service.js", () => ({ workspaceUrlForSlug: (s: string) => `https://${s}.example.test` }));

const { deleteWorkspaceUnderPolicy } = await import("../../src/services/retention.service.js");

beforeEach(() => {
  deletions.length = 0;
  vi.clearAllMocks();
});

describe("deleting a workspace under the retention policy", () => {
  it("releases its company-domain claims in the same transaction that archives it", async () => {
    const result = await deleteWorkspaceUnderPolicy("org-1", { actorLabel: "ops", force: true, now });
    expect(result.deleted).toBe(true);
    expect(deletions).toContain("orgEmailDomain:org-1");
    // In the transaction, not after it: a crash between the two would strand the claim.
    expect(control.$transaction).toHaveBeenCalledTimes(1);
    expect(control.orgEmailDomain.deleteMany).toHaveBeenCalledBefore(control.$transaction);
  });
});
