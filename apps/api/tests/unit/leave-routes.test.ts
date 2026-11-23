/**
 * V17 Phase B — the leave HTTP surfaces through their real routers: /api/leave (employee, approver,
 * super-admin), the public API (leave:read / leave:write grants) and leave items on the signed
 * attendance webhook. The data lives in the in-memory world; only identity, plan entitlements,
 * planning settings, audit, events and notifications are mocked.
 */
import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addType, addUser, credit, emptyWorld, fakePrisma, type LeaveWorld } from "../helpers/leave-world.js";

let world: LeaveWorld = emptyWorld();
let client: Record<string, unknown> = fakePrisma(world);
let me = { id: "emp", name: "emp", email: "emp@x.io", role: "EMPLOYEE", permissions: [] as string[] };
let grants: string[] = [];
const entitlements: Record<string, boolean> = {};

vi.mock("../../src/config/prisma.js", () => ({ prisma: new Proxy({}, { get: (_t, key: string) => client[key] }) }));
vi.mock("../../src/config/tenant-context.js", async () => ({
  ...(await vi.importActual<typeof import("../../src/config/tenant-context.js")>("../../src/config/tenant-context.js")),
  requireTenantContext: () => ({ orgId: "org-1", orgSlug: "acme" })
}));
vi.mock("../../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/middleware/auth.js")>("../../src/middleware/auth.js");
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.user = { ...me } as never;
      next();
    }
  };
});
vi.mock("../../src/services/plan-limits.service.js", () => ({
  isPlanningCapabilityAllowed: async (_o: string, cap: string) => Boolean(entitlements[cap]),
  getPlanningEntitlements: async () => ({ ...entitlements })
}));
vi.mock("../../src/services/planning.service.js", () => ({ getPlanningSettings: async () => ({ workingDays: [1, 2, 3, 4, 5], defaultWeeklyCapacityHours: 40 }) }));
vi.mock("../../src/services/audit.service.js", () => ({ audit: async () => undefined }));
vi.mock("../../src/services/domain-events.js", () => ({ emitDomainEvent: () => undefined }));
vi.mock("../../src/services/notify.service.js", () => ({ dispatchNotification: async () => undefined }));
vi.mock("../../src/services/attendance-ingest.service.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/services/attendance-ingest.service.js")>("../../src/services/attendance-ingest.service.js");
  return { ...actual, assertIngestAllowed: async () => undefined };
});
vi.mock("../../src/utils/encryption.js", () => ({ decryptSecret: (s: string) => s, encryptSecret: (s: string) => s }));

const { leaveRouter } = await import("../../src/controllers/leave.controller.js");
const { publicLeaveRouter } = await import("../../src/controllers/public-leave.controller.js");
const { handleAttendanceWebhook, signAttendancePayload } = await import("../../src/services/attendance-webhook.service.js");
const { errorHandler } = await import("../../src/middleware/error.js");

function app() {
  const a = express();
  a.use(express.json());
  a.use("/leave", leaveRouter);
  a.use("/public", (req, _res, next) => {
    (req as unknown as { apiKey: unknown }).apiKey = { id: "key-1", scope: "WRITE", grants };
    next();
  }, publicLeaveRouter);
  a.use(errorHandler);
  return a;
}

const as = (id: string) => {
  const u = world.users.find((x) => x.id === id)!;
  me = { id, name: id, email: u.email, role: u.role.name, permissions: [] };
};

beforeEach(() => {
  world = emptyWorld();
  client = fakePrisma(world);
  Object.assign(entitlements, { leaveManagementEnabled: true, attendanceIntegrationsEnabled: true, attendanceEnabled: true });
  grants = [];
  addUser(world, { id: "super", role: "SUPER_ADMIN" });
  addUser(world, { id: "mgr", role: "MANAGER" });
  addUser(world, { id: "other-mgr", role: "MANAGER" });
  addUser(world, { id: "emp", managerId: "mgr" });
  addType(world, { code: "PL", annualQuota: 12 });
  credit(world, "emp", "type-PL", 2026, 12, "ACCRUAL", "k1");
  credit(world, "emp", "type-PL", 2027, 12, "ACCRUAL", "k2");
  as("emp");
});

const future = { leaveTypeCode: "PL", startDate: "2027-01-04", endDate: "2027-01-06" };

describe("/api/leave gates", () => {
  it("GET /status answers 200 either way", async () => {
    expect((await request(app()).get("/leave/status")).body).toMatchObject({ enabled: true });
    world.settings.leaveEnabled = false;
    expect((await request(app()).get("/leave/status")).body).toMatchObject({ enabled: false });
  });

  it("every other route is 403 with leave off (toggle) or off-plan", async () => {
    world.settings.leaveEnabled = false;
    expect((await request(app()).get("/leave/me/balances")).status).toBe(403);
    world.settings.leaveEnabled = true;
    entitlements.leaveManagementEnabled = false;
    const res = await request(app()).post("/leave/me/requests").send(future);
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/plan/);
  });
});

describe("/api/leave employee + approver flow", () => {
  it("apply → inbox → approve → balance, over HTTP", async () => {
    const applied = await request(app()).post("/leave/me/requests").send(future);
    expect(applied.status).toBe(201);
    expect(applied.body.request).toMatchObject({ status: "PENDING", days: 3 });

    as("mgr");
    const inbox = await request(app()).get("/leave/inbox");
    expect(inbox.body.items.map((i: { id: string }) => i.id)).toEqual([applied.body.request.id]);
    const decided = await request(app()).post(`/leave/inbox/${applied.body.request.id}/decision`).send({ decision: "APPROVE" });
    expect(decided.status).toBe(200);
    expect(decided.body.status).toBe("APPROVED");

    as("emp");
    const balances = await request(app()).get("/leave/me/balances?year=2027");
    expect(balances.body.balances[0]).toMatchObject({ balance: 9, available: 9 });
    const ledger = await request(app()).get("/leave/me/ledger?year=2027");
    expect(ledger.body.items.map((l: { kind: string }) => l.kind).sort()).toEqual(["ACCRUAL", "DEBIT"]);
  });

  it("days are never taken from the client", async () => {
    const res = await request(app()).post("/leave/me/requests").send({ ...future, days: 0.5 });
    expect(res.status).toBe(422);
  });

  it("another manager gets 403 on the decision, and on a made-up id the same 403", async () => {
    const applied = await request(app()).post("/leave/me/requests").send(future);
    as("other-mgr");
    const a = await request(app()).post(`/leave/inbox/${applied.body.request.id}/decision`).send({ decision: "APPROVE" });
    const b = await request(app()).post(`/leave/inbox/nope/decision`).send({ decision: "APPROVE" });
    expect([a.status, b.status]).toEqual([403, 403]);
    expect(a.body.message).toBe(b.body.message);
  });

  it("a rejection needs a note", async () => {
    const applied = await request(app()).post("/leave/me/requests").send(future);
    as("mgr");
    expect((await request(app()).post(`/leave/inbox/${applied.body.request.id}/decision`).send({ decision: "REJECT" })).status).toBe(422);
  });

  it("bulk decision returns 207 with a result per id", async () => {
    const a = await request(app()).post("/leave/me/requests").send(future);
    const b = await request(app()).post("/leave/me/requests").send({ ...future, startDate: "2027-01-11", endDate: "2027-01-11" });
    as("mgr");
    const res = await request(app()).post("/leave/inbox/bulk-decision").send({ ids: [a.body.request.id, b.body.request.id, "x"], decision: "APPROVE" });
    expect(res.status).toBe(207);
    expect(res.body.results.map((r: { ok: boolean }) => r.ok)).toEqual([true, true, false]);
  });

  it("the employee cannot open the team calendar; the manager can, without reasons", async () => {
    await request(app()).post("/leave/me/requests").send({ ...future, reason: "private" });
    expect((await request(app()).get("/leave/team?from=2027-01-01&to=2027-01-31")).status).toBe(403);
    as("mgr");
    const res = await request(app()).get("/leave/team?from=2027-01-01&to=2027-01-31");
    expect(res.body.items).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toContain("private");
  });
});

describe("/api/leave/admin", () => {
  it("is super admin only", async () => {
    as("mgr");
    expect((await request(app()).get("/leave/admin/settings")).status).toBe(403);
  });

  it("refuses to switch leave on with no enabled type, and writes need the plan", async () => {
    as("super");
    world.leaveType[0].enabled = false;
    expect((await request(app()).put("/leave/admin/settings").send({ leaveEnabled: true })).status).toBe(409);
    entitlements.leaveManagementEnabled = false;
    expect((await request(app()).put("/leave/admin/settings").send({ leaveYearStartMonth: 4 })).status).toBe(403);
    expect((await request(app()).get("/leave/admin/settings")).status).toBe(200);
  });

  it("creates and updates types; a duplicate code is 409", async () => {
    as("super");
    const body = {
      code: "CL",
      name: "Casual",
      colour: "info",
      annualQuota: 6,
      accrual: "YEARLY_UPFRONT",
      carryForwardMax: 0,
      allowHalfDay: true,
      isPaid: true,
      requiresApproval: true,
      requiresDocumentAfterDays: null,
      allowNegative: false,
      enabled: true,
      sortOrder: 5
    };
    expect((await request(app()).post("/leave/admin/types").send(body)).status).toBe(201);
    expect((await request(app()).post("/leave/admin/types").send(body)).status).toBe(409);
    expect((await request(app()).put("/leave/admin/types/type-PL").send({ annualQuota: 15 })).body.annualQuota).toBe(15);
  });

  it("a manual adjustment is a ledger row", async () => {
    as("super");
    const res = await request(app()).post("/leave/admin/adjustments").send({ userId: "emp", leaveTypeId: "type-PL", leaveYear: 2027, delta: -1.5, reason: "Correction" });
    expect(res.status).toBe(201);
    expect(world.leaveBalanceLedger.at(-1)).toMatchObject({ kind: "ADJUSTMENT", delta: -1.5, actorId: "super" });
  });
});

describe("public API /leave-requests", () => {
  const item = { email: "emp@x.io", leaveType: "PL", startDate: "2027-01-04", endDate: "2027-01-05", status: "APPROVED", externalRef: "hr-9" };

  it("needs leave:write — a WRITE key alone opens nothing", async () => {
    const res = await request(app()).post("/public/leave-requests").send(item);
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/leave:write/);
  });

  it("accepts with the grant; trust decides the status", async () => {
    grants = ["leave:write"];
    const res = await request(app()).post("/public/leave-requests").send(item);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: "RECEIVED", leaveStatus: "PENDING" });
    world.settings.trustExternalApprovals = true;
    const batch = await request(app()).post("/public/leave-requests").send([{ ...item, externalRef: "hr-10", startDate: "2027-01-11", endDate: "2027-01-11" }, item]);
    expect(batch.status).toBe(207);
    expect(batch.body.results.map((r: { status: string; leaveStatus?: string }) => [r.status, r.leaveStatus])).toEqual([
      ["RECEIVED", "APPROVED"],
      ["DUPLICATE", "PENDING"]
    ]);
  });

  it("GET needs leave:read and never returns the reason", async () => {
    grants = ["leave:write"];
    await request(app()).post("/public/leave-requests").send({ ...item, reason: "secret surgery" });
    expect((await request(app()).get("/public/leave-requests?from=2027-01-01&to=2027-01-31")).status).toBe(403);
    grants = ["leave:read"];
    const res = await request(app()).get("/public/leave-requests?from=2027-01-01&to=2027-01-31");
    expect(res.status).toBe(200);
    expect(res.body.items[0]).toMatchObject({ days: 2, status: "PENDING", leaveType: { code: "PL" } });
    expect(JSON.stringify(res.body)).not.toContain("surgery");
  });

  it("is refused without the integrations entitlement", async () => {
    grants = ["leave:write"];
    entitlements.attendanceIntegrationsEnabled = false;
    expect((await request(app()).post("/public/leave-requests").send(item)).status).toBe(403);
  });
});

describe("leave items on the signed attendance webhook", () => {
  const SOURCE = "6f1c2b9e-1111-4222-8333-944455556666";
  function deliver(items: unknown[], eventId = crypto.randomUUID()) {
    const raw = JSON.stringify(items);
    const ts = String(Math.floor(Date.now() / 1000));
    return handleAttendanceWebhook({
      sourceId: SOURCE,
      rawBody: raw,
      headers: {
        "x-timesphere-timestamp": ts,
        "x-timesphere-event-id": eventId,
        "x-timesphere-signature": signAttendancePayload("s3cret", ts, eventId, raw)
      }
    });
  }

  beforeEach(() => {
    client.attendanceSource = {
      findUnique: async () => ({ id: SOURCE, enabled: true, kind: "WEBHOOK", secretEncrypted: "s3cret", matchField: "EMAIL" })
    };
  });

  it("routes { kind: 'leave' } items to leave and honours trust", async () => {
    world.settings.trustExternalApprovals = true;
    const out = await deliver([{ kind: "leave", email: "emp@x.io", leaveType: "PL", startDate: "2027-01-04", endDate: "2027-01-04", status: "APPROVED", externalRef: "hr-1" }]);
    expect(out.status).toBe(202);
    expect((out.body as { results: unknown[] }).results[0]).toMatchObject({ status: "RECEIVED", leaveStatus: "APPROVED" });
    expect(world.leaveRequest[0]).toMatchObject({ source: "WEBHOOK", dedupeKey: `WEBHOOK:${SOURCE}:hr-1` });
  });

  it("rejects leave items (and only them) when leave is off", async () => {
    world.settings.leaveEnabled = false;
    const out = await deliver([{ kind: "leave", email: "emp@x.io", leaveType: "PL", startDate: "2027-01-04", endDate: "2027-01-04", externalRef: "hr-2" }]);
    expect((out.body as { results: Array<{ status: string; error: string }> }).results[0]).toMatchObject({ status: "REJECTED", error: expect.stringMatching(/Leave is off/) });
    expect(world.leaveRequest).toHaveLength(0);
  });
});
