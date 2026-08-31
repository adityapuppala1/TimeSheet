/**
 * The two-person rule, and the reason that rides with it.
 *
 * THE CLAIM: the five irreversible console actions do not happen when they are asked for. They are
 * recorded, and a DIFFERENT operator has to countersign, at which point the ordinary handler runs
 * — now, against the database as it is now.
 *
 * WHY THE REPLAY MATTERS, AND WHY ONE OF THESE TESTS IS ENTIRELY ABOUT IT. The obvious alternative
 * is a flag: mark the thing "approved" and let the destructive service check it. That is wrong in a
 * way that only shows up in production, because the world moves between the request and the
 * approval — the org that was a lapsed trial on Monday started paying on Tuesday; the last other
 * owner was demoted an hour ago. A stored decision replayed blind carries Monday's facts into
 * Wednesday's database. "approval re-validates rather than replaying a stale decision" below is the
 * test that would go red if anybody ever swapped the replay for a flag.
 *
 * The audit service is REAL here (its only dependency is the control client, which is faked), so
 * the reason is asserted where it actually lands: on the row.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { PLATFORM_APPROVAL_TTL_HOURS } from "@timesheet/shared";

const OWNER_A = "00000000-0000-4000-8000-0000000000a1";
const OWNER_B = "00000000-0000-4000-8000-0000000000b2";
const SUPPORT_C = "00000000-0000-4000-8000-0000000000c3";
const SESSION_ID = "00000000-0000-4000-8000-0000000000ff";

const adminRows = new Map<string, Record<string, unknown>>();

/** A pending-action store with just enough behaviour to be honest: rows are found by id, and an
 *  update mutates the row every later read sees. A `vi.fn()` returning a constant would let an
 *  "already approved" bug pass. */
const pending = new Map<string, Record<string, unknown>>();
let idSeq = 0;

const table = () => ({
  findUnique: vi.fn().mockResolvedValue(null),
  findFirst: vi.fn().mockResolvedValue(null),
  findMany: vi.fn().mockResolvedValue([]),
  count: vi.fn().mockResolvedValue(0),
  create: vi.fn().mockResolvedValue({ id: "new" }),
  createMany: vi.fn().mockResolvedValue({ count: 0 }),
  update: vi.fn().mockResolvedValue({ id: "updated" }),
  updateMany: vi.fn().mockResolvedValue({ count: 0 }),
  upsert: vi.fn().mockResolvedValue({ id: "upserted" }),
  delete: vi.fn().mockResolvedValue({ id: "deleted" }),
  deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  groupBy: vi.fn().mockResolvedValue([]),
  aggregate: vi.fn().mockResolvedValue({ _count: { _all: 0 } })
});

const auditRows: Record<string, unknown>[] = [];

const control = {
  platformAdminUser: {
    ...table(),
    findUnique: vi.fn(async ({ where }: { where: { id?: string } }) => (where.id ? (adminRows.get(where.id) ?? null) : null)),
    // Honours the `where` the queue actually sends — status, role, and "not me". A fake that
    // ignored it would let "who could approve this?" answer with the requester themselves.
    findMany: vi.fn(async ({ where }: { where?: { status?: string; role?: string; id?: { not?: string } } } = {}) =>
      [...adminRows.values()]
        .filter((a) => (!where?.status || a.status === where.status) && (!where?.role || a.role === where.role) && (!where?.id?.not || a.id !== where.id.not))
        .map((a) => ({ ...a, _count: { sessions: 1 } }))
    ),
    count: vi.fn(async ({ where }: { where?: { role?: string; status?: string } } = {}) =>
      [...adminRows.values()].filter((a) => (!where?.role || a.role === where.role) && (!where?.status || a.status === where.status)).length
    ),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = { ...adminRows.get(where.id)!, ...data };
      adminRows.set(where.id, row);
      return row;
    }),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "new-admin", ...data }))
  },
  platformAdminSession: { ...table(), findUnique: vi.fn(async () => ({ revokedAt: null })) },
  pendingPlatformAction: {
    ...table(),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: `req-${++idSeq}`, status: "PENDING", approvedById: null, approvedByLabel: null, approvedAt: null, resolutionNote: null, requestedAt: new Date(), ...data };
      pending.set(row.id as string, row);
      return row;
    }),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => pending.get(where.id) ?? null),
    findMany: vi.fn(async () => [...pending.values()]),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = { ...pending.get(where.id)!, ...data };
      pending.set(where.id, row);
      return row;
    })
  },
  platformAuditLog: {
    ...table(),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      auditRows.push(data);
      return data;
    })
  },
  platformAdminRecoveryCode: table(),
  organization: table(),
  orgAuthMethod: table(),
  orgBackupPolicy: table(),
  backupDestination: table(),
  backupRun: table(),
  planTierLimit: table(),
  platformBillingSettings: table(),
  platformMailSettings: table(),
  platformEmailTemplate: table(),
  platformEmailLog: table(),
  trialFeedback: table(),
  salesLead: table()
};
vi.mock("../../src/config/control-prisma.js", () => ({ controlPrisma: control }));

const deleteWorkspaceUnderPolicy = vi.fn().mockResolvedValue({ deleted: true, databaseName: "acme_db" });
const restoreSnapshot = vi.fn().mockResolvedValue({ restored: true });
const deleteSnapshot = vi.fn().mockResolvedValue({ deleted: true });

vi.mock("../../src/services/retention.service.js", () => ({
  deleteWorkspaceUnderPolicy,
  getRetentionQueue: vi.fn().mockResolvedValue([]),
  getRetentionSettings: vi.fn().mockResolvedValue({}),
  runRetentionTick: vi.fn().mockResolvedValue({ sent: [], deleted: [] }),
  sendRetentionMarker: vi.fn().mockResolvedValue({ ok: true }),
  setRetentionHold: vi.fn().mockResolvedValue({}),
  updateRetentionSettings: vi.fn().mockResolvedValue({})
}));
vi.mock("../../src/services/platform-backup.service.js", () => ({
  deleteSnapshot,
  listSnapshots: vi.fn().mockResolvedValue([]),
  restoreSnapshot,
  snapshotPath: vi.fn().mockRejectedValue(new Error("no snapshot"))
}));
vi.mock("../../src/services/platform-mail.service.js", () => ({
  applyPlatformVars: (s: string) => s,
  getPlatformTransportStatus: vi.fn().mockResolvedValue({ configured: false }),
  renderPlatformTemplate: vi.fn().mockResolvedValue({}),
  resendPlatformEmail: vi.fn().mockResolvedValue({ ok: true }),
  resolvePlatformMailConfig: vi.fn().mockResolvedValue({ host: "" }),
  sendPlatformTemplate: vi.fn().mockResolvedValue({ ok: true })
}));
vi.mock("../../src/services/sales-lead.service.js", () => ({ resolveSalesInbox: vi.fn().mockResolvedValue("s@t.test"), SALES_LEAD_STATUSES: ["NEW"] as const }));
vi.mock("../../src/services/platform-admin-analytics.service.js", () => ({ getPlatformAnalytics: vi.fn().mockResolvedValue({}) }));
vi.mock("../../src/services/platform-email-analytics.service.js", () => ({ getPlatformEmailAnalytics: vi.fn().mockResolvedValue({}) }));
vi.mock("../../src/services/platform-maintenance.service.js", () => ({ broadcastMaintenance: vi.fn(), getFleetMaintenance: vi.fn().mockResolvedValue([]), listBroadcasts: vi.fn().mockResolvedValue([]) }));
vi.mock("../../src/services/platform-tenant-health.service.js", () => ({ getDatabaseMetrics: vi.fn(), getFleetHealth: vi.fn(), getTenantHealth: vi.fn() }));
vi.mock("../../src/services/tenant-db-metrics.service.js", () => ({ getTenantDbTrend: vi.fn(), runMaintenanceOperation: vi.fn(), sampleAllTenantDatabases: vi.fn() }));
vi.mock("../../src/services/platform-ai.service.js", () => ({
  ADVISOR_ACTIONS: [],
  adviseWorkspace: vi.fn(),
  decideAdvice: vi.fn(),
  getPlatformAiSettings: vi.fn().mockResolvedValue({}),
  listAdvice: vi.fn().mockResolvedValue([]),
  updatePlatformAiSettings: vi.fn()
}));
vi.mock("../../src/services/backup-destination.service.js", () => ({ DESTINATION_FIELDS: {}, describeSecret: () => ({}), encryptDestinationSecret: () => "e", testDestination: vi.fn() }));
vi.mock("../../src/services/backup.service.js", () => ({
  backupEntitlement: vi.fn().mockResolvedValue({ tier: "TEAM", frequency: "DAILY", maxDestinations: 5 }),
  nextRunAt: () => new Date(),
  planRetention: () => ({ keep: [], drop: [] }),
  runBackup: vi.fn(),
  runBackupTick: vi.fn(),
  sweepRetention: vi.fn(),
  testRestore: vi.fn()
}));

let app: express.Express;
let tokens: Record<string, string>;

beforeAll(async () => {
  const { platformAdminConsoleRouter } = await import("../../src/controllers/platform-admin-console.controller.js");
  const { errorHandler } = await import("../../src/middleware/error.js");
  const { signPlatformAdminAccessToken } = await import("../../src/utils/platform-admin-security.js");

  app = express();
  app.use(express.json());
  app.use("/api/platform-admin", platformAdminConsoleRouter);
  app.use(errorHandler);

  tokens = {
    [OWNER_A]: signPlatformAdminAccessToken(OWNER_A, SESSION_ID),
    [OWNER_B]: signPlatformAdminAccessToken(OWNER_B, SESSION_ID),
    [SUPPORT_C]: signPlatformAdminAccessToken(SUPPORT_C, SESSION_ID)
  };
}, 60_000);

beforeEach(() => {
  vi.clearAllMocks();
  pending.clear();
  auditRows.length = 0;
  idSeq = 0;
  adminRows.clear();
  adminRows.set(OWNER_A, { id: OWNER_A, email: "a@timesphere.app", name: "A", role: "OWNER", status: "ACTIVE", passwordHash: "x", mfaEnabled: false });
  adminRows.set(OWNER_B, { id: OWNER_B, email: "b@timesphere.app", name: "B", role: "OWNER", status: "ACTIVE", passwordHash: "x", mfaEnabled: false });
  adminRows.set(SUPPORT_C, { id: SUPPORT_C, email: "c@timesphere.app", name: "C", role: "OPERATOR", status: "ACTIVE", passwordHash: "x", mfaEnabled: false });
  control.organization.findUnique.mockResolvedValue({ id: "org-1", slug: "acme", name: "Acme" });
});

const REASON = encodeURIComponent("Ticket 4192 — the customer asked us to close the account.");

const as = (who: string, method: "post" | "delete" | "patch", path: string, body?: object) => {
  const req = request(app)[method](`/api/platform-admin${path}`).set("Authorization", `Bearer ${tokens[who]}`).set("X-Platform-Reason", REASON);
  return body ? req.send(body) : req;
};

describe("a destructive action is recorded, not performed", () => {
  it("answers 202 with a request id, and does not delete anything", async () => {
    const res = await as(OWNER_A, "post", "/retention/org-1/delete", { confirmSlug: "acme" });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ pending: true, action: "retention.delete", label: "Delete a workspace and its database" });
    expect(res.body.requestId).toBeTruthy();
    // THE assertion. If this ever fires, the whole mechanism is decoration.
    expect(deleteWorkspaceUnderPolicy).not.toHaveBeenCalled();
  });

  it("names who could countersign, from live sessions rather than from a list of names", async () => {
    const res = await as(OWNER_A, "post", "/retention/org-1/delete", { confirmSlug: "acme" });
    // The requester is excluded — they cannot approve their own, so listing them would be a lie.
    expect(res.body.approvers.map((a: { email: string }) => a.email)).toEqual(["b@timesphere.app"]);
    expect(res.body.approvers[0].liveSessions).toBe(1);
  });

  it("says so plainly when there is nobody else who could approve", async () => {
    adminRows.delete(OWNER_B);
    const res = await as(OWNER_A, "post", "/retention/org-1/delete", { confirmSlug: "acme" });
    expect(res.body.approvers).toHaveLength(0);
    expect(res.body.message).toMatch(/no other owner/i);
  });

  it("queues a snapshot restore and a snapshot delete the same way", async () => {
    expect((await as(OWNER_A, "post", "/backups/snap-1/restore", { organizationId: "org-1", confirmSlug: "acme" })).status).toBe(202);
    expect((await as(OWNER_A, "delete", "/backups/snap-1")).status).toBe(202);
    expect(restoreSnapshot).not.toHaveBeenCalled();
    expect(deleteSnapshot).not.toHaveBeenCalled();
  });

  it("refuses to queue at all without a reason — a request nobody explained is one nobody can approve", async () => {
    const res = await request(app).post("/api/platform-admin/retention/org-1/delete").set("Authorization", `Bearer ${tokens[OWNER_A]}`).send({ confirmSlug: "acme" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("REASON_REQUIRED");
    expect(pending.size).toBe(0);
  });
});

describe("who may approve", () => {
  const queue = async () => (await as(OWNER_A, "post", "/retention/org-1/delete", { confirmSlug: "acme" })).body.requestId as string;

  it("the requester cannot approve their own request", async () => {
    const id = await queue();
    const res = await as(OWNER_A, "post", `/governance/requests/${id}/approve`);

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/second signature/i);
    expect(deleteWorkspaceUnderPolicy).not.toHaveBeenCalled();
    expect(pending.get(id)!.status).toBe("PENDING");
  });

  it("a second owner can, and the action runs through the ordinary handler", async () => {
    const id = await queue();
    const res = await as(OWNER_B, "post", `/governance/requests/${id}/approve`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ approved: true, action: "retention.delete", result: { deleted: true } });
    expect(deleteWorkspaceUnderPolicy).toHaveBeenCalledTimes(1);
    // Attributed to the APPROVER, who is the person actually authorising it to happen now.
    expect(deleteWorkspaceUnderPolicy).toHaveBeenCalledWith("org-1", expect.objectContaining({ actorLabel: "b@timesphere.app" }));
    expect(pending.get(id)!.status).toBe("APPROVED");
  });

  it("an OPERATOR cannot approve — countersigning is an owner's job", async () => {
    const id = await queue();
    expect((await as(SUPPORT_C, "post", `/governance/requests/${id}/approve`)).status).toBe(403);
    expect(deleteWorkspaceUnderPolicy).not.toHaveBeenCalled();
  });

  it("an already-approved request cannot be run a second time", async () => {
    const id = await queue();
    await as(OWNER_B, "post", `/governance/requests/${id}/approve`);
    const again = await as(OWNER_B, "post", `/governance/requests/${id}/approve`);

    expect(again.status).toBe(409);
    expect(deleteWorkspaceUnderPolicy).toHaveBeenCalledTimes(1);
  });

  it("an expired request cannot be approved, and is marked expired rather than left to look live", async () => {
    const id = await queue();
    pending.set(id, { ...pending.get(id)!, expiresAt: new Date(Date.now() - 60_000) });

    const res = await as(OWNER_B, "post", `/governance/requests/${id}/approve`);

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(new RegExp(`${PLATFORM_APPROVAL_TTL_HOURS} hours`));
    expect(deleteWorkspaceUnderPolicy).not.toHaveBeenCalled();
    expect(pending.get(id)!.status).toBe("EXPIRED");
  });

  it("a withdrawn request cannot then be approved", async () => {
    const id = await queue();
    expect((await as(OWNER_A, "post", `/governance/requests/${id}/reject`, { note: "wrong workspace" })).status).toBe(200);
    expect((await as(OWNER_B, "post", `/governance/requests/${id}/approve`)).status).toBe(409);
    expect(deleteWorkspaceUnderPolicy).not.toHaveBeenCalled();
  });
});

describe("approval re-validates rather than replaying a stale decision", () => {
  it("refuses a demotion that has become the removal of the last owner since it was asked", async () => {
    // Asked while there are three owners: legal at request time, and never checked at request time.
    adminRows.set(SUPPORT_C, { ...adminRows.get(SUPPORT_C)!, role: "OWNER" });
    const queued = await as(OWNER_A, "patch", `/admins/${SUPPORT_C}`, { role: "READ_ONLY" });
    expect(queued.status).toBe(202);

    // The world moves. Two owners resign the hard way, leaving C as the only one.
    adminRows.set(OWNER_A, { ...adminRows.get(OWNER_A)!, role: "READ_ONLY" });

    // B approves… and the handler, running now, refuses on the fact that is true NOW.
    adminRows.set(OWNER_B, { ...adminRows.get(OWNER_B)!, role: "OWNER" });
    adminRows.set(SUPPORT_C, { ...adminRows.get(SUPPORT_C)!, role: "OWNER" });
    // Exactly one active OWNER other than the target? Make the target the last one.
    adminRows.set(OWNER_B, { ...adminRows.get(OWNER_B)!, role: "OWNER" });
    adminRows.delete(OWNER_A);
    control.platformAdminUser.count.mockResolvedValueOnce(1);

    const res = await as(OWNER_B, "post", `/governance/requests/${queued.body.requestId}/approve`);

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/last active owner/i);
    // The role did NOT change, and the request is consumed rather than left to be retried until
    // the world happens to allow it.
    expect(adminRows.get(SUPPORT_C)!.role).toBe("OWNER");
    expect(pending.get(queued.body.requestId)!.status).toBe("FAILED");
  });

  it("refuses a deletion whose confirmation no longer matches the workspace it named", async () => {
    const queued = await as(OWNER_A, "post", "/retention/org-1/delete", { confirmSlug: "acme" });

    // Renamed between the ask and the answer. A flag-based design would delete it anyway.
    control.organization.findUnique.mockResolvedValue({ id: "org-1", slug: "acme-renamed" });

    const res = await as(OWNER_B, "post", `/governance/requests/${queued.body.requestId}/approve`);
    expect(res.status).toBe(422);
    expect(deleteWorkspaceUnderPolicy).not.toHaveBeenCalled();
  });

  it("refuses a deletion of a workspace that no longer exists", async () => {
    const queued = await as(OWNER_A, "post", "/retention/org-1/delete", { confirmSlug: "acme" });
    control.organization.findUnique.mockResolvedValue(null);

    expect((await as(OWNER_B, "post", `/governance/requests/${queued.body.requestId}/approve`)).status).toBe(404);
    expect(deleteWorkspaceUnderPolicy).not.toHaveBeenCalled();
  });
});

describe("creating an operator is queued too — it is the console's clearest privilege escalation", () => {
  it("returns no password on the request, and the password only on the approval", async () => {
    const queued = await as(OWNER_A, "post", "/admins", { email: "new@timesphere.app", name: "New", role: "OPERATOR" });
    expect(queued.status).toBe(202);
    expect(JSON.stringify(queued.body)).not.toMatch(/temporaryPassword/);
    expect(control.platformAdminUser.create).not.toHaveBeenCalled();

    const approved = await as(OWNER_B, "post", `/governance/requests/${queued.body.requestId}/approve`);
    expect(approved.status).toBe(200);
    expect(approved.body.result).toMatchObject({ email: "new@timesphere.app", role: "OPERATOR" });
    expect(approved.body.result.temporaryPassword).toMatch(/^[A-Za-z0-9]{12}!7aQ$/);
  });

  it("refuses to create an account whose address is already taken — checked at approval", async () => {
    const queued = await as(OWNER_A, "post", "/admins", { email: "taken@timesphere.app", name: "Taken", role: "READ_ONLY" });
    control.platformAdminUser.findUnique.mockImplementation(async ({ where }: { where: { id?: string; email?: string } }) =>
      where.email ? { id: "existing" } : (adminRows.get(where.id!) ?? null)
    );

    expect((await as(OWNER_B, "post", `/governance/requests/${queued.body.requestId}/approve`)).status).toBe(409);
  });
});

describe("deactivating an account is deliberately NOT two-person", () => {
  it("happens immediately, because cutting off a leaked credential must not wait for anybody", async () => {
    const res = await request(app)
      .patch(`/api/platform-admin/admins/${SUPPORT_C}`)
      .set("Authorization", `Bearer ${tokens[OWNER_A]}`)
      .set("X-Platform-Reason", REASON)
      .send({ status: "INACTIVE" });

    expect(res.status).toBe(200);
    expect(adminRows.get(SUPPORT_C)!.status).toBe("INACTIVE");
    expect(pending.size).toBe(0);
  });
});

describe("platformAudit records the reason", () => {
  it("puts the operator's own words on the row, with the IP", async () => {
    await as(OWNER_A, "post", "/retention/org-1/delete", { confirmSlug: "acme" });

    const requested = auditRows.find((r) => r.action === "governance.requested");
    expect(requested).toBeTruthy();
    // Decoded back from the percent-encoded header — an em dash cannot travel raw in a header.
    expect(requested!.reason).toBe("Ticket 4192 — the customer asked us to close the account.");
    expect(requested!.ipAddress).toBeTruthy();
    expect(requested!.after).toEqual({ status: "PENDING" });
  });

  it("carries the same reason through to the row the approval writes, so the trail reads as one story", async () => {
    const queued = await as(OWNER_A, "post", "/retention/org-1/delete", { confirmSlug: "acme" });
    auditRows.length = 0;
    await as(OWNER_B, "post", `/governance/requests/${queued.body.requestId}/approve`);

    const approved = auditRows.find((r) => r.action === "governance.approved");
    expect(approved).toMatchObject({
      actorLabel: "b@timesphere.app",
      reason: "Ticket 4192 — the customer asked us to close the account.",
      before: { status: "PENDING" },
      after: { status: "APPROVED" }
    });
    // And the action's own row names both people.
    expect(auditRows.find((r) => r.action === "retention.deleted_with_approval")).toMatchObject({
      actorLabel: "b@timesphere.app",
      metadata: expect.objectContaining({ requestedBy: "a@timesphere.app" })
    });
  });

  it("records a reason on an ordinary tenant-touching action too, not only on the queued ones", async () => {
    await request(app)
      .patch(`/api/platform-admin/admins/${SUPPORT_C}`)
      .set("Authorization", `Bearer ${tokens[OWNER_A]}`)
      .set("X-Platform-Reason", REASON)
      .send({ status: "INACTIVE" });

    expect(auditRows.find((r) => r.action === "platform_admin.inactive")).toMatchObject({
      reason: "Ticket 4192 — the customer asked us to close the account.",
      before: { status: "ACTIVE" },
      after: { status: "INACTIVE" }
    });
  });
});

describe("the queue is visible to everyone, and answers honestly", () => {
  it("shows a request to a non-owner, marked as theirs or not", async () => {
    const queued = await as(OWNER_A, "post", "/retention/org-1/delete", { confirmSlug: "acme" });

    const mine = await request(app).get("/api/platform-admin/governance/requests").set("Authorization", `Bearer ${tokens[OWNER_A]}`);
    const theirs = await request(app).get("/api/platform-admin/governance/requests").set("Authorization", `Bearer ${tokens[SUPPORT_C]}`);

    expect(mine.body.rows[0]).toMatchObject({ id: queued.body.requestId, isMine: true, status: "PENDING", expired: false });
    expect(theirs.body.rows[0]).toMatchObject({ isMine: false });
    // The reason is the only input an approver has; it must be in the listing.
    expect(theirs.body.rows[0].reason).toBe("Ticket 4192 — the customer asked us to close the account.");
  });

  it("reports a lapsed request as expired without anybody having touched it", async () => {
    const queued = await as(OWNER_A, "post", "/retention/org-1/delete", { confirmSlug: "acme" });
    pending.set(queued.body.requestId, { ...pending.get(queued.body.requestId)!, expiresAt: new Date(Date.now() - 1000) });

    const res = await request(app).get("/api/platform-admin/governance/requests").set("Authorization", `Bearer ${tokens[OWNER_B]}`);
    expect(res.body.rows[0]).toMatchObject({ status: "PENDING", expired: true });
  });
});
