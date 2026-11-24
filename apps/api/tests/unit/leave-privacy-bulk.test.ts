/**
 * V17 Phase B review fixes, service level:
 *   - the requester's reason and document reach ONLY whoever decides the request (the inbox, the
 *     decision response), and never an email or in-app notification (emails outlive the decision
 *     and are copied to the super-admin BCC);
 *   - bulk decisions send the requester notifications in the background (a hung SMTP server must
 *     not hold the response), and a bulk call is capped;
 *   - an UNTRUSTED external request is balance-checked on approval like an in-app one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addType, addUser, balanceOf, credit, emptyWorld, fakePrisma, type LeaveWorld } from "../helpers/leave-world.js";

let world: LeaveWorld = emptyWorld();
let client: Record<string, unknown> = fakePrisma(world);
const entitlements: Record<string, boolean> = { leaveManagementEnabled: true, attendanceIntegrationsEnabled: true };
const sent: Array<Record<string, any>> = [];
let hang = false;

vi.mock("../../src/config/prisma.js", () => ({ prisma: new Proxy({}, { get: (_t, key: string) => client[key] }) }));
vi.mock("../../src/config/tenant-context.js", () => ({ requireTenantContext: () => ({ orgId: "org-1", orgSlug: "acme" }) }));
vi.mock("../../src/services/plan-limits.service.js", () => ({
  isPlanningCapabilityAllowed: async (_o: string, cap: string) => Boolean(entitlements[cap]),
  getPlanningEntitlements: async () => ({ ...entitlements })
}));
vi.mock("../../src/services/planning.service.js", () => ({ getPlanningSettings: async () => ({ workingDays: [1, 2, 3, 4, 5], defaultWeeklyCapacityHours: 40 }) }));
vi.mock("../../src/services/audit.service.js", () => ({ audit: async () => undefined }));
vi.mock("../../src/services/domain-events.js", () => ({ emitDomainEvent: () => undefined }));
vi.mock("../../src/services/notify.service.js", () => ({
  dispatchNotification: (args: Record<string, any>) => {
    sent.push(args);
    // A hung SMTP leg: the promise never settles.
    return hang ? new Promise(() => undefined) : Promise.resolve();
  }
}));

const svc = await import("../../src/services/leave.service.js");
const ext = await import("../../src/services/leave-external.service.js");

const NOW = new Date("2026-11-23T10:00:00Z");
const REASON = "Hospital appointment for my father";
const actor = (id: string) => ({ id, role: world.users.find((u) => u.id === id)!.role.name, name: id });
const attachment = { url: "/uploads/leave/doc.pdf", fileName: "doc.pdf", mimeType: "application/pdf", sizeBytes: 10 };

beforeEach(() => {
  world = emptyWorld();
  client = fakePrisma(world);
  sent.length = 0;
  hang = false;
  addUser(world, { id: "super", role: "SUPER_ADMIN" });
  addUser(world, { id: "admin", role: "ADMIN" });
  addUser(world, { id: "mgr", role: "MANAGER" });
  addUser(world, { id: "other-mgr", role: "MANAGER" });
  addUser(world, { id: "emp", managerId: "mgr" });
  addType(world, { code: "PL", annualQuota: 12 });
  addType(world, { code: "LOP", annualQuota: 0, allowNegative: true });
  credit(world, "emp", "type-PL", 2026, 12, "ACCRUAL", "ACCRUAL:emp:type-PL:2026-01");
});

const apply = (over: Record<string, unknown> = {}) =>
  svc.applyLeave({ userId: "emp", leaveTypeCode: "PL", startDate: "2026-11-30", endDate: "2026-12-01", reason: REASON, attachment, source: "WEB", actorId: "emp", now: NOW, ...over });

describe("the reason never travels by notification", () => {
  it("the leave.requested email and in-app text carry no reason", async () => {
    await apply();
    expect(sent).toHaveLength(1);
    expect(sent[0].category).toBe("leave.requested");
    expect(JSON.stringify(sent[0])).not.toContain("Hospital");
    expect(sent[0].email.vars).not.toHaveProperty("reason");
    expect(sent[0].email.fallback.html).toContain("Open TimeSphere to review");
  });
});

describe("the reason and document are for the decider", () => {
  it("the approver's inbox shows them", async () => {
    await apply();
    const inbox = await svc.listInbox(actor("mgr"));
    expect(inbox.items[0]).toMatchObject({ reason: REASON, attachment: expect.objectContaining({ name: "doc.pdf" }) });
  });

  it("a super admin's scope=all shows them (they may decide anything)", async () => {
    await apply();
    expect((await svc.listInbox(actor("super"), { scope: "all" })).items[0].reason).toBe(REASON);
  });

  it("someone with no decision right sees nothing of the request", async () => {
    await apply();
    expect((await svc.listInbox(actor("other-mgr"))).items).toEqual([]);
  });

  it("a row the query returns but decisionRight denies is stripped (second lock)", async () => {
    await apply();
    // The captured approver has left: the request now belongs to the admin pool, not to them.
    world.users.find((u) => u.id === "mgr")!.status = "INACTIVE";
    const theirs = await svc.listInbox(actor("mgr"), { status: "ALL" });
    expect(theirs.items).toHaveLength(1);
    expect(theirs.items[0]).toMatchObject({ reason: null, attachment: null });
    expect((await svc.listInbox(actor("admin"))).items[0].reason).toBe(REASON);
  });

  it("the decision response carries them to the approver; bulk results carry no request text", async () => {
    const a = (await apply()).request;
    expect((await svc.decideLeave({ actor: actor("mgr"), requestId: a.id, decision: "APPROVE", now: NOW })).reason).toBe(REASON);
    const b = (await apply({ startDate: "2026-12-07", endDate: "2026-12-07" })).request;
    const results = await svc.decideMany(actor("mgr"), [b.id], "APPROVE");
    expect(results).toEqual([{ id: b.id, ok: true, status: "APPROVED" }]);
    expect(JSON.stringify(results)).not.toContain("Hospital");
  });
});

describe("bulk decisions", () => {
  it("a hanging notification dispatcher does not block the response", async () => {
    const ids = [];
    for (const d of ["2026-11-30", "2026-12-01", "2026-12-02"]) ids.push((await apply({ startDate: d, endDate: d })).request.id);
    hang = true;
    const outcome = await Promise.race([
      svc.decideMany(actor("mgr"), [...ids, "nope"], "APPROVE"),
      new Promise((resolve) => setTimeout(() => resolve("timed out"), 1000))
    ]);
    expect(outcome).toEqual([
      ...ids.map((id) => ({ id, ok: true, status: "APPROVED" })),
      { id: "nope", ok: false, error: expect.any(String), httpStatus: 403 }
    ]);
    expect(sent.filter((s) => s.category === "leave.decided")).toHaveLength(3);
  });

  it("is capped at 50 requests a call", async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `id-${i}`);
    await expect(svc.decideMany(actor("mgr"), ids, "APPROVE")).rejects.toMatchObject({ statusCode: 422 });
    expect(svc.bulkDecisionBody.safeParse({ ids, decision: "APPROVE" }).success).toBe(false);
    expect(svc.bulkDecisionBody.safeParse({ ids: ids.slice(0, 50), decision: "APPROVE" }).success).toBe(true);
  });
});

describe("untrusted external leave", () => {
  const item = (over: Record<string, unknown> = {}) => ({
    email: "emp@x.io",
    leaveType: "PL",
    startDate: "2026-12-01",
    endDate: "2026-12-31",
    status: "APPROVED",
    externalRef: "hrms-1",
    ...over
  });

  it("trust OFF: approving it re-checks the balance", async () => {
    await ext.ingestExternalLeave({ kind: "API", sender: "key-1", rawItem: item(), now: NOW });
    const req = world.leaveRequest[0];
    expect(req.status).toBe("PENDING");
    await expect(svc.decideLeave({ actor: actor("mgr"), requestId: req.id, decision: "APPROVE", now: NOW })).rejects.toMatchObject({
      statusCode: 409,
      code: "LEAVE_INSUFFICIENT_BALANCE"
    });
    expect(balanceOf(world, "emp", "type-PL", 2026)).toBe(12);
  });

  it("trust OFF still respects allowNegative", async () => {
    await ext.ingestExternalLeave({ kind: "API", sender: "key-1", rawItem: item({ leaveType: "LOP" }), now: NOW });
    const req = world.leaveRequest[0];
    expect((await svc.decideLeave({ actor: actor("mgr"), requestId: req.id, decision: "APPROVE", now: NOW })).status).toBe("APPROVED");
  });

  it("trust ON: a pending external request is approved as the source said, past the balance", async () => {
    world.settings.trustExternalApprovals = true;
    await ext.ingestExternalLeave({ kind: "API", sender: "key-1", rawItem: item({ status: "PENDING" }), now: NOW });
    const req = world.leaveRequest[0];
    expect((await svc.decideLeave({ actor: actor("mgr"), requestId: req.id, decision: "APPROVE", now: NOW })).status).toBe("APPROVED");
    expect(balanceOf(world, "emp", "type-PL", 2026)).toBe(-11);
  });
});
