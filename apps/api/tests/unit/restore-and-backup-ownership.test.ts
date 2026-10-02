/**
 * M8 — a snapshot and a backup destination belong to ONE workspace, and the console did not check.
 *
 *  - `restoreSnapshot` checked the typed slug against the TARGET workspace and never looked at whose
 *    snapshot it was, so workspace A's data could be restored into workspace B (two-person, but an
 *    approver reading "restore acme-….sql into globex" is not who should be catching that).
 *  - `runBackup` accepted any `destinationId`, including another workspace's own destination, so one
 *    customer's database could be written into another customer's bucket. Only the policy route
 *    checked ownership.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const control = {
  organization: { findUnique: vi.fn() },
  backupDestination: { findUnique: vi.fn() },
  backupRun: { create: vi.fn(), update: vi.fn() },
  orgBackupPolicy: { update: vi.fn() }
};
vi.mock("../../src/config/control-prisma.js", () => ({ controlPrisma: control }));
vi.mock("../../src/services/retention.service.js", () => ({ getRetentionSettings: vi.fn(async () => ({ snapshotDir: null })) }));
vi.mock("../../src/services/platform-audit.service.js", () => ({ platformAudit: vi.fn() }));
vi.mock("../../src/services/company-domain-claims.service.js", () => ({ reclaimAfterRestore: vi.fn() }));
vi.mock("../../src/services/backup-destination.service.js", () => ({ adapterFor: vi.fn() }));
vi.mock("../../src/services/platform-mail.service.js", () => ({ sendPlatformTemplate: vi.fn() }));

const { env } = await import("../../src/config/env.js");
const { restoreSnapshot } = await import("../../src/services/platform-backup.service.js");
const { runBackup } = await import("../../src/services/backup.service.js");

beforeEach(() => {
  vi.clearAllMocks();
  env.TENANT_DB_PROVISION_BASE_URL = "mysql://root@127.0.0.1:3306";
});

describe("restoreSnapshot", () => {
  it("refuses to restore one workspace's snapshot into another", async () => {
    control.organization.findUnique.mockResolvedValue({ id: "org-globex", slug: "globex", ownerEmail: null, database: null });
    await expect(restoreSnapshot("acme-2026-10-02T10-00-00-000Z.sql", "org-globex", "globex", "b@timesphere.app")).rejects.toMatchObject({
      statusCode: 422,
      message: expect.stringMatching(/acme/)
    });
  });

  it("refuses a file whose name says nothing about whose it is", async () => {
    control.organization.findUnique.mockResolvedValue({ id: "org-globex", slug: "globex", ownerEmail: null, database: null });
    await expect(restoreSnapshot("dump.sql", "org-globex", "globex", "b@timesphere.app")).rejects.toMatchObject({ statusCode: 422 });
  });

  it("does not mistake a slug that is a prefix of another for a match", async () => {
    control.organization.findUnique.mockResolvedValue({ id: "org-acme", slug: "acme", ownerEmail: null, database: null });
    await expect(restoreSnapshot("acme-corp-2026-10-02T10-00-00-000Z.sql", "org-acme", "acme", "b@timesphere.app")).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe("runBackup", () => {
  const org = { id: "org-a", slug: "acme", name: "Acme", planTier: "ENTERPRISE", trialTier: null, database: { databaseName: "tenant_acme", encryptedDsn: "x" }, backupPolicy: null };

  it("refuses a destination that belongs to a different workspace, and records no run", async () => {
    control.organization.findUnique.mockResolvedValue(org);
    control.backupDestination.findUnique.mockResolvedValue({ id: "dest-b", name: "Globex S3", kind: "S3", organizationId: "org-b" });
    await expect(runBackup("org-a", { kind: "MANUAL", actorLabel: "ops@timesphere.app", destinationId: "dest-b" })).rejects.toMatchObject({ statusCode: 403 });
    expect(control.backupRun.create).not.toHaveBeenCalled();
  });

  it("still accepts a platform-owned destination", async () => {
    control.organization.findUnique.mockResolvedValue({ ...org, database: null });
    control.backupDestination.findUnique.mockResolvedValue({ id: "dest-p", name: "Platform S3", kind: "S3", organizationId: null });
    control.backupRun.create.mockResolvedValue({ id: "run-1" });
    // No database registered, so it is recorded as SKIPPED — the point is that it got past ownership.
    await expect(runBackup("org-a", { kind: "MANUAL", actorLabel: "ops@timesphere.app", destinationId: "dest-p" })).resolves.toMatchObject({ status: "SKIPPED" });
  });
});
