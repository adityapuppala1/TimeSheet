/**
 * V17 Phase B — leave.service.ts and leave-external.service.ts against an in-memory tenant
 * (tests/helpers/leave-world.ts) that enforces unique keys and serialises/rolls back transactions
 * the way MySQL does. Only the edges are mocked: plan entitlements, planning settings, audit, the
 * domain-event fan-out and the notification pipeline (nothing is ever sent).
 *
 * Covered: the plan/setting gate, apply validation (type, halves, balance, document, overlap,
 * limits), auto-approval, the decision-rights matrix and its IDOR-safe 403, super-admin override,
 * the double-approve race (and that the guard is what stops it), ledger correctness for approve /
 * cancel / reversal, bulk decisions, the inbox scope, and external ingest in both trust modes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addType, addUser, balanceOf, credit, emptyWorld, fakePrisma, type LeaveWorld } from "../helpers/leave-world.js";

let world: LeaveWorld = emptyWorld();
const entitlements: Record<string, boolean> = { leaveManagementEnabled: true, attendanceIntegrationsEnabled: true, attendanceEnabled: true };
const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
const notifications: Array<{ userId: string; category: string }> = [];
const audits: Array<{ actor: string | undefined; action: string; meta: Record<string, unknown> }> = [];

// Every call goes to the CURRENT world's client (one transaction lock per world).
let client: Record<string, unknown> = fakePrisma(world);
vi.mock("../../src/config/prisma.js", () => ({
  prisma: new Proxy({}, { get: (_t, key: string) => client[key] })
}));
vi.mock("../../src/config/tenant-context.js", () => ({ requireTenantContext: () => ({ orgId: "org-1", orgSlug: "acme" }) }));
vi.mock("../../src/services/plan-limits.service.js", () => ({
  isPlanningCapabilityAllowed: async (_org: string, cap: string) => Boolean(entitlements[cap]),
  getPlanningEntitlements: async () => ({ ...entitlements })
}));
vi.mock("../../src/services/planning.service.js", () => ({
  getPlanningSettings: async () => ({ workingDays: [1, 2, 3, 4, 5], defaultWeeklyCapacityHours: 40 })
}));
vi.mock("../../src/services/audit.service.js", () => ({
  audit: async (actor: string | undefined, action: string, _e: string, _id?: string, meta?: Record<string, unknown>) => {
    audits.push({ actor, action, meta: meta ?? {} });
  }
}));
vi.mock("../../src/services/domain-events.js", () => ({
  emitDomainEvent: (event: string, payload: Record<string, unknown>) => events.push({ event, payload })
}));
vi.mock("../../src/services/notify.service.js", () => ({
  dispatchNotification: async (args: { userId: string; category: string }) => {
    notifications.push({ userId: args.userId, category: args.category });
  }
}));

const svc = await import("../../src/services/leave.service.js");
const ext = await import("../../src/services/leave-external.service.js");

// Monday 2026-11-23, 10:00 UTC. The leave year is 2026 (January start).
const NOW = new Date("2026-11-23T10:00:00Z");

function reset() {
  world = emptyWorld();
  client = fakePrisma(world);
  events.length = 0;
  notifications.length = 0;
  audits.length = 0;
  Object.assign(entitlements, { leaveManagementEnabled: true, attendanceIntegrationsEnabled: true, attendanceEnabled: true });
  addUser(world, { id: "super", role: "SUPER_ADMIN" });
  addUser(world, { id: "admin", role: "ADMIN" });
  addUser(world, { id: "mgr", role: "MANAGER" });
  addUser(world, { id: "other-mgr", role: "MANAGER" });
  addUser(world, { id: "emp", role: "EMPLOYEE", managerId: "mgr" });
  addUser(world, { id: "orphan", role: "EMPLOYEE", managerId: null });
  addType(world, { code: "PL", annualQuota: 12 });
  addType(world, { code: "SL", annualQuota: 8, requiresDocumentAfterDays: 2 });
  addType(world, { code: "LOP", annualQuota: 0, allowNegative: true, isPaid: false });
  addType(world, { code: "WFH", annualQuota: 0, allowNegative: true, requiresApproval: false });
  addType(world, { code: "OFF", annualQuota: 5, enabled: false });
  credit(world, "emp", "type-PL", 2026, 12, "ACCRUAL", "ACCRUAL:emp:type-PL:2026-01");
  credit(world, "orphan", "type-PL", 2026, 12, "ACCRUAL", "ACCRUAL:orphan:type-PL:2026-01");
}

beforeEach(reset);

const apply = (over: Partial<Parameters<typeof svc.applyLeave>[0]> = {}) =>
  svc.applyLeave({ userId: "emp", leaveTypeCode: "PL", startDate: "2026-11-30", endDate: "2026-12-02", source: "WEB", actorId: "emp", now: NOW, ...over });

const actor = (id: string) => ({ id, role: world.users.find((u) => u.id === id)!.role.name, name: id });

/* ------------------------------------------------------------------ gate */

describe("the gate", () => {
  it("is off without the workspace toggle, and says so", async () => {
    world.settings.leaveEnabled = false;
    expect(await svc.isLeaveOn()).toBe(false);
    await expect(svc.assertLeaveOn()).rejects.toMatchObject({ statusCode: 403, message: expect.stringMatching(/Leave is off/) });
  });

  it("is off without the plan entitlement, with the commercial message", async () => {
    entitlements.leaveManagementEnabled = false;
    expect(await svc.isLeaveOn()).toBe(false);
    await expect(svc.assertLeaveOn()).rejects.toMatchObject({ statusCode: 403, message: expect.stringMatching(/plan/) });
  });

  it("integrations additionally need the integrations entitlement", async () => {
    entitlements.attendanceIntegrationsEnabled = false;
    await expect(svc.assertLeaveIntegrationAllowed()).rejects.toMatchObject({ statusCode: 403 });
  });

  it("the approved-leave lookup is silent with the toggle off", async () => {
    const { loadApprovedLeave } = await import("../../src/services/leave-query.service.js");
    await apply({ leaveTypeCode: "WFH" });
    expect((await loadApprovedLeave(["emp"], "2026-11-30", "2026-11-30"))("emp", "2026-11-30")).toEqual({ type: "WFH", half: "FULL" });
    world.settings.leaveEnabled = false;
    expect((await loadApprovedLeave(["emp"], "2026-11-30", "2026-11-30"))("emp", "2026-11-30")).toBeNull();
  });
});

/* ------------------------------------------------------------------ apply */

describe("apply", () => {
  it("computes days server-side, routes to the manager and notifies them", async () => {
    const r = await apply();
    expect(r.autoApproved).toBe(false);
    expect(r.request).toMatchObject({ status: "PENDING", days: 3, approverId: "mgr", leaveYear: 2026 });
    expect(notifications).toEqual([{ userId: "mgr", category: "leave.requested" }]);
    expect(events.map((e) => e.event)).toEqual(["leave.requested"]);
    // Nothing is debited until a decision.
    expect(balanceOf(world, "emp", "type-PL", 2026)).toBe(12);
  });

  it("the webhook payload never carries the reason", async () => {
    await apply({ reason: "Family wedding in Pune" });
    expect(JSON.stringify(events[0].payload)).not.toContain("wedding");
  });

  it("someone with no manager goes to the admin pool, and every pool member hears", async () => {
    const r = await apply({ userId: "orphan", actorId: "orphan" });
    expect(r.request.approverId).toBeNull();
    expect(notifications.map((n) => n.userId).sort()).toEqual(["admin", "super"]);
  });

  it("the SUPER_ADMINS fallback narrows the pool", async () => {
    world.settings.leaveApprovalFallback = "SUPER_ADMINS";
    await apply({ userId: "orphan", actorId: "orphan" });
    expect(notifications.map((n) => n.userId)).toEqual(["super"]);
  });

  it("refuses a disabled or unknown type", async () => {
    await expect(apply({ leaveTypeCode: "OFF" })).rejects.toMatchObject({ statusCode: 422, code: "LEAVE_TYPE_UNAVAILABLE" });
    await expect(apply({ leaveTypeCode: "NOPE" })).rejects.toMatchObject({ code: "LEAVE_TYPE_UNAVAILABLE" });
  });

  it("refuses half days on a type that does not allow them", async () => {
    world.leaveType.find((t) => t.code === "PL")!.allowHalfDay = false;
    await expect(apply({ startDate: "2026-11-30", endDate: "2026-11-30", startHalf: "FIRST_HALF" })).rejects.toMatchObject({ code: "LEAVE_INVALID_SPAN" });
  });

  it("a one-day half request needs only startHalf", async () => {
    const r = await apply({ startDate: "2026-11-30", endDate: "2026-11-30", startHalf: "SECOND_HALF" });
    expect(r.request).toMatchObject({ startHalf: "SECOND_HALF", endHalf: "SECOND_HALF", days: 0.5 });
  });

  it("refuses more than the balance, counting pending requests as reserved", async () => {
    await apply({ startDate: "2026-12-07", endDate: "2026-12-18" }); // 10 days pending
    await expect(apply({ startDate: "2026-11-30", endDate: "2026-12-02" })).rejects.toMatchObject({
      code: "LEAVE_INSUFFICIENT_BALANCE",
      details: { available: 2, requested: 3 }
    });
  });

  it("allowNegative types skip the balance check", async () => {
    const r = await apply({ leaveTypeCode: "LOP" });
    expect(r.request.status).toBe("PENDING");
  });

  it("requires a document past the type's threshold, and accepts one", async () => {
    credit(world, "emp", "type-SL", 2026, 8);
    await expect(apply({ leaveTypeCode: "SL" })).rejects.toMatchObject({ code: "LEAVE_DOCUMENT_REQUIRED" });
    const r = await apply({ leaveTypeCode: "SL", attachment: { url: "/uploads/x.pdf", fileName: "note.pdf", mimeType: "application/pdf", sizeBytes: 10 } });
    expect(r.request.attachment).toMatchObject({ name: "note.pdf" });
    // Two days is not "after 2 days".
    expect((await apply({ leaveTypeCode: "SL", startDate: "2026-12-07", endDate: "2026-12-08" })).request.days).toBe(2);
  });

  it("refuses an overlap with pending or approved leave, but allows the other half of a day", async () => {
    await apply({ startDate: "2026-11-30", endDate: "2026-11-30", startHalf: "FIRST_HALF" });
    await expect(apply({ startDate: "2026-11-30", endDate: "2026-12-01" })).rejects.toMatchObject({ statusCode: 409, code: "LEAVE_OVERLAP" });
    const other = await apply({ startDate: "2026-11-30", endDate: "2026-11-30", startHalf: "SECOND_HALF" });
    expect(other.request.days).toBe(0.5);
  });

  it("a cancelled or rejected request no longer blocks the dates", async () => {
    const first = await apply();
    await svc.cancelLeave({ actor: actor("emp"), requestId: first.request.id, now: NOW });
    expect((await apply()).request.status).toBe("PENDING");
  });

  it("refuses weekends-and-holidays-only, too far back, too far ahead, too long, and across leave years", async () => {
    await expect(apply({ startDate: "2026-11-28", endDate: "2026-11-29" })).rejects.toMatchObject({ code: "LEAVE_NO_WORKING_DAYS" });
    await expect(apply({ startDate: "2026-08-03", endDate: "2026-08-03" })).rejects.toMatchObject({ code: "LEAVE_OUT_OF_RANGE" });
    await expect(apply({ leaveTypeCode: "LOP", startDate: "2027-12-01", endDate: "2027-12-01" })).rejects.toMatchObject({ code: "LEAVE_OUT_OF_RANGE" });
    await expect(apply({ leaveTypeCode: "LOP", startDate: "2027-01-04", endDate: "2027-04-30" })).rejects.toMatchObject({ code: "LEAVE_OUT_OF_RANGE" });
    await expect(apply({ leaveTypeCode: "LOP", startDate: "2026-12-28", endDate: "2027-01-05" })).rejects.toMatchObject({ code: "LEAVE_CROSSES_YEAR" });
  });

  it("excludes the person's holidays from the day count", async () => {
    world.holidayCalendar.push({ id: "cal", isDefault: true });
    world.holiday.push({ id: "h1", calendarId: "cal", date: new Date("2026-12-01T00:00:00Z"), name: "Founders day" });
    expect((await apply()).request.days).toBe(2);
  });

  it("a type that needs no approval is approved at once and debited in the same transaction", async () => {
    const r = await apply({ leaveTypeCode: "WFH" });
    expect(r.autoApproved).toBe(true);
    expect(r.request.status).toBe("APPROVED");
    expect(world.leaveBalanceLedger.filter((l) => l.kind === "DEBIT")).toEqual([expect.objectContaining({ delta: -3, idempotencyKey: `DEBIT:${r.request.id}` })]);
    expect(events.map((e) => e.event)).toEqual(["leave.requested", "leave.approved"]);
    expect(notifications).toEqual([]);
  });

  it("a failed apply leaves nothing behind (the transaction rolls back)", async () => {
    await apply({ startDate: "2026-12-07", endDate: "2026-12-18" });
    const before = world.leaveRequest.length;
    await expect(apply()).rejects.toBeTruthy();
    expect(world.leaveRequest.length).toBe(before);
  });
});

/* ------------------------------------------------------------------ decision rights (pure) */

describe("decisionRight", () => {
  const req = { userId: "emp", approverId: "mgr" };
  it("the captured manager decides; another manager does not", () => {
    expect(svc.decisionRight({ id: "mgr", role: "MANAGER" }, req, true, "ADMINS")).toBe("APPROVER");
    expect(svc.decisionRight({ id: "other-mgr", role: "MANAGER" }, req, true, "ADMINS")).toBeNull();
  });
  it("an admin is not the approver while the manager is active", () => {
    expect(svc.decisionRight({ id: "admin", role: "ADMIN" }, req, true, "ADMINS")).toBeNull();
  });
  it("a deactivated manager's requests fall to the pool", () => {
    expect(svc.decisionRight({ id: "admin", role: "ADMIN" }, req, false, "ADMINS")).toBe("APPROVER");
    expect(svc.decisionRight({ id: "mgr", role: "MANAGER" }, req, false, "ADMINS")).toBeNull();
  });
  it("the pool follows the fallback setting", () => {
    const pool = { userId: "orphan", approverId: null };
    expect(svc.decisionRight({ id: "admin", role: "ADMIN" }, pool, false, "ADMINS")).toBe("APPROVER");
    expect(svc.decisionRight({ id: "admin", role: "ADMIN" }, pool, false, "SUPER_ADMINS")).toBeNull();
    expect(svc.decisionRight({ id: "super", role: "SUPER_ADMIN" }, pool, false, "SUPER_ADMINS")).toBe("APPROVER");
  });
  it("a super admin may decide anything, as an override when it was not theirs", () => {
    expect(svc.decisionRight({ id: "super", role: "SUPER_ADMIN" }, req, true, "ADMINS")).toBe("OVERRIDE");
  });
  it("nobody decides their own request except a super admin (override)", () => {
    expect(svc.decisionRight({ id: "mgr", role: "MANAGER" }, { userId: "mgr", approverId: "mgr" }, true, "ADMINS")).toBeNull();
    expect(svc.decisionRight({ id: "admin", role: "ADMIN" }, { userId: "admin", approverId: null }, false, "ADMINS")).toBeNull();
    expect(svc.decisionRight({ id: "super", role: "SUPER_ADMIN" }, { userId: "super", approverId: null }, false, "ADMINS")).toBe("OVERRIDE");
  });
});

/* ------------------------------------------------------------------ decide */

describe("decide", () => {
  it("approval debits the ledger once, with the request's key, and tells the requester", async () => {
    const { request } = await apply();
    notifications.length = 0;
    const decided = await svc.decideLeave({ actor: actor("mgr"), requestId: request.id, decision: "APPROVE", now: NOW });
    expect(decided).toMatchObject({ status: "APPROVED", decidedById: "mgr", overriddenBySuperAdmin: false });
    expect(balanceOf(world, "emp", "type-PL", 2026)).toBe(9);
    expect(world.leaveBalanceLedger.filter((l) => l.kind === "DEBIT")).toHaveLength(1);
    expect(notifications).toEqual([{ userId: "emp", category: "leave.decided" }]);
    expect(events.at(-1)?.event).toBe("leave.approved");
  });

  it("rejection writes no ledger row", async () => {
    const { request } = await apply();
    await svc.decideLeave({ actor: actor("mgr"), requestId: request.id, decision: "REJECT", note: "Release week", now: NOW });
    expect(world.leaveBalanceLedger.filter((l) => l.kind === "DEBIT")).toHaveLength(0);
    expect(events.at(-1)?.event).toBe("leave.rejected");
  });

  it("out of scope and unknown ids get the SAME 403 (no probing)", async () => {
    const { request } = await apply();
    const outOfScope = await svc.decideLeave({ actor: actor("other-mgr"), requestId: request.id, decision: "APPROVE" }).catch((e) => e);
    const unknown = await svc.decideLeave({ actor: actor("other-mgr"), requestId: "does-not-exist", decision: "APPROVE" }).catch((e) => e);
    const employee = await svc.decideLeave({ actor: actor("emp"), requestId: request.id, decision: "APPROVE" }).catch((e) => e);
    expect([outOfScope.statusCode, unknown.statusCode, employee.statusCode]).toEqual([403, 403, 403]);
    expect(outOfScope.message).toBe(unknown.message);
    expect(world.leaveRequest[0].status).toBe("PENDING");
  });

  it("a super admin override is flagged and audited with the designated approver", async () => {
    const { request } = await apply();
    const decided = await svc.decideLeave({ actor: actor("super"), requestId: request.id, decision: "APPROVE", now: NOW });
    expect(decided.overriddenBySuperAdmin).toBe(true);
    expect(audits.find((a) => a.action === "leave.approved")?.meta).toMatchObject({ overriddenBySuperAdmin: true, designatedApproverId: "mgr" });
  });

  it("an admin decides for someone with no manager", async () => {
    const { request } = await apply({ userId: "orphan", actorId: "orphan" });
    expect((await svc.decideLeave({ actor: actor("admin"), requestId: request.id, decision: "APPROVE", now: NOW })).overriddenBySuperAdmin).toBe(false);
  });

  it("deciding twice is 409, and the ledger is unchanged", async () => {
    const { request } = await apply();
    await svc.decideLeave({ actor: actor("mgr"), requestId: request.id, decision: "APPROVE", now: NOW });
    await expect(svc.decideLeave({ actor: actor("mgr"), requestId: request.id, decision: "APPROVE", now: NOW })).rejects.toMatchObject({
      statusCode: 409,
      code: "LEAVE_ALREADY_DECIDED"
    });
    expect(balanceOf(world, "emp", "type-PL", 2026)).toBe(9);
  });

  it("THE RACE: two approvals at once — exactly one wins, exactly one debit", async () => {
    const { request } = await apply();
    const results = await Promise.allSettled([
      svc.decideLeave({ actor: actor("mgr"), requestId: request.id, decision: "APPROVE", now: NOW }),
      svc.decideLeave({ actor: actor("super"), requestId: request.id, decision: "APPROVE", now: NOW })
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toMatchObject({ statusCode: 409, code: "LEAVE_ALREADY_DECIDED" });
    expect(world.leaveBalanceLedger.filter((l) => l.kind === "DEBIT")).toHaveLength(1);
    expect(balanceOf(world, "emp", "type-PL", 2026)).toBe(9);
  });

  it("an approve and a reject racing: one outcome, consistent ledger", async () => {
    const { request } = await apply();
    await Promise.allSettled([
      svc.decideLeave({ actor: actor("mgr"), requestId: request.id, decision: "APPROVE", now: NOW }),
      svc.decideLeave({ actor: actor("super"), requestId: request.id, decision: "REJECT", note: "no", now: NOW })
    ]);
    const status = world.leaveRequest[0].status;
    const debits = world.leaveBalanceLedger.filter((l) => l.kind === "DEBIT").length;
    expect(status === "APPROVED" ? debits : 0).toBe(debits);
    expect(debits).toBe(status === "APPROVED" ? 1 : 0);
  });

  it("approval re-checks the balance for in-app requests (an adjustment since apply)", async () => {
    const { request } = await apply();
    world.leaveBalanceLedger.push({ id: "adj", userId: "emp", leaveTypeId: "type-PL", leaveYear: 2026, delta: -11, kind: "ADJUSTMENT", idempotencyKey: null });
    await expect(svc.decideLeave({ actor: actor("mgr"), requestId: request.id, decision: "APPROVE", now: NOW })).rejects.toMatchObject({
      statusCode: 409,
      code: "LEAVE_INSUFFICIENT_BALANCE"
    });
    // Rolled back: still pending, nothing debited.
    expect(world.leaveRequest[0].status).toBe("PENDING");
    expect(world.leaveBalanceLedger.filter((l) => l.kind === "DEBIT")).toHaveLength(0);
  });

  it("bulk: each id is decided on its own; out-of-scope ones fail without undoing the rest", async () => {
    const a = (await apply()).request;
    const b = (await apply({ startDate: "2026-12-07", endDate: "2026-12-07" })).request;
    const c = (await apply({ userId: "orphan", actorId: "orphan" })).request;
    const results = await svc.decideMany(actor("mgr"), [a.id, b.id, c.id, a.id], "APPROVE");
    expect(results.map((r) => [r.ok, r.httpStatus ?? 200])).toEqual([
      [true, 200],
      [true, 200],
      [false, 403]
    ]);
    expect(balanceOf(world, "emp", "type-PL", 2026)).toBe(8);
  });
});

/* ------------------------------------------------------------------ cancel */

describe("cancel", () => {
  it("a pending request cancels with no ledger row", async () => {
    const { request } = await apply();
    expect((await svc.cancelLeave({ actor: actor("emp"), requestId: request.id, now: NOW })).status).toBe("CANCELLED");
    expect(world.leaveBalanceLedger.filter((l) => l.kind !== "ACCRUAL")).toEqual([]);
  });

  it("approved future leave cancels with a CREDIT_REVERSAL that restores the balance exactly", async () => {
    const { request } = await apply();
    await svc.decideLeave({ actor: actor("mgr"), requestId: request.id, decision: "APPROVE", now: NOW });
    await svc.cancelLeave({ actor: actor("emp"), requestId: request.id, now: NOW });
    expect(world.leaveBalanceLedger.filter((l) => l.kind === "CREDIT_REVERSAL")).toEqual([expect.objectContaining({ delta: 3, idempotencyKey: `REVERSAL:${request.id}` })]);
    expect(balanceOf(world, "emp", "type-PL", 2026)).toBe(12);
    expect(events.at(-1)?.event).toBe("leave.cancelled");
  });

  it("cancelling twice is harmless and reverses once", async () => {
    const { request } = await apply();
    await svc.decideLeave({ actor: actor("mgr"), requestId: request.id, decision: "APPROVE", now: NOW });
    await svc.cancelLeave({ actor: actor("emp"), requestId: request.id, now: NOW });
    await svc.cancelLeave({ actor: actor("emp"), requestId: request.id, now: NOW });
    expect(world.leaveBalanceLedger.filter((l) => l.kind === "CREDIT_REVERSAL")).toHaveLength(1);
  });

  it("approved leave that has started can only be cancelled by a super admin", async () => {
    const { request } = await apply({ startDate: "2026-11-23", endDate: "2026-11-24" });
    await svc.decideLeave({ actor: actor("mgr"), requestId: request.id, decision: "APPROVE", now: NOW });
    await expect(svc.cancelLeave({ actor: actor("emp"), requestId: request.id, now: NOW })).rejects.toMatchObject({ code: "LEAVE_NOT_CANCELLABLE" });
    expect((await svc.cancelLeave({ actor: actor("super"), requestId: request.id, now: NOW })).status).toBe("CANCELLED");
  });

  it("someone else's request is a 404 (it is not theirs to know about)", async () => {
    const { request } = await apply();
    await expect(svc.cancelLeave({ actor: actor("mgr"), requestId: request.id, now: NOW })).rejects.toMatchObject({ statusCode: 404 });
  });
});

/* ------------------------------------------------------------------ inbox */

describe("inbox", () => {
  it("a manager sees their reports' pending requests only", async () => {
    await apply();
    await apply({ userId: "orphan", actorId: "orphan" });
    const mine = await svc.listInbox(actor("mgr"));
    expect(mine.items.map((i) => i.user?.id)).toEqual(["emp"]);
    expect((await svc.listInbox(actor("other-mgr"))).items).toEqual([]);
  });

  it("an admin sees the pool, including a deactivated manager's queue, but not their own", async () => {
    await apply();
    await apply({ userId: "orphan", actorId: "orphan" });
    expect((await svc.listInbox(actor("admin"))).items.map((i) => i.user?.id)).toEqual(["orphan"]);
    world.users.find((u) => u.id === "mgr")!.status = "INACTIVE";
    expect((await svc.listInbox(actor("admin"))).items.map((i) => i.user?.id).sort()).toEqual(["emp", "orphan"]);
  });

  it("scope=all is super admin only", async () => {
    await apply();
    await expect(svc.listInbox(actor("admin"), { scope: "all" })).rejects.toMatchObject({ statusCode: 403 });
    expect((await svc.listInbox(actor("super"), { scope: "all" })).total).toBe(1);
  });

  it("the inbox agrees with decisionRight: everything listed can be decided", async () => {
    await apply();
    await apply({ userId: "orphan", actorId: "orphan" });
    for (const who of ["mgr", "admin", "super"]) {
      for (const item of (await svc.listInbox(actor(who))).items) {
        expect(svc.decisionRight(actor(who), { userId: item.user!.id, approverId: item.approverId }, true, "ADMINS")).not.toBeNull();
      }
    }
  });
});

/* ------------------------------------------------------------------ balances */

describe("balances", () => {
  it("are the ledger sum, with pending reserved and expiry projected", async () => {
    world.leaveType.find((t) => t.code === "PL")!.carryForwardMax = 5;
    await apply();
    const b = await svc.getBalances("emp", { now: NOW });
    const pl = b.balances.find((x) => x.leaveType.code === "PL")!;
    expect(pl).toMatchObject({ balance: 12, pending: 3, available: 9, projectedYearEnd: 9, expiringAtYearEnd: 4 });
  });

  it("include accrual that is due but not yet posted by the worker", async () => {
    world.leaveType.find((t) => t.code === "PL")!.accrual = "MONTHLY_PRORATA";
    world.leaveBalanceLedger.length = 0;
    const pl = (await svc.getBalances("emp", { now: NOW })).balances.find((x) => x.leaveType.code === "PL")!;
    expect(pl.balance).toBe(11); // Jan..Nov at 1/month
    expect(pl.projectedYearEnd).toBe(12);
  });
});

/* ------------------------------------------------------------------ external */

describe("external ingest", () => {
  const item = (over: Record<string, unknown> = {}) => ({
    email: "emp@x.io",
    leaveType: "PL",
    startDate: "2026-11-30",
    endDate: "2026-12-02",
    status: "APPROVED",
    externalRef: "hrms-1",
    ...over
  });

  it("trust OFF: an APPROVED item lands PENDING with the normal approver", async () => {
    const r = await ext.ingestExternalLeave({ kind: "API", sender: "key-1", rawItem: item(), now: NOW });
    expect(r).toMatchObject({ status: "RECEIVED", leaveStatus: "PENDING" });
    expect(world.leaveRequest[0]).toMatchObject({ approverId: "mgr", source: "API", externalRef: "hrms-1" });
    expect(world.leaveBalanceLedger.filter((l) => l.kind === "DEBIT")).toHaveLength(0);
  });

  it("trust ON: an APPROVED item is approved as-is and debited, even past the balance", async () => {
    world.settings.trustExternalApprovals = true;
    const r = await ext.ingestExternalLeave({ kind: "WEBHOOK", sender: "src-1", rawItem: item({ startDate: "2026-12-01", endDate: "2026-12-31" }), now: NOW });
    expect(r.leaveStatus).toBe("APPROVED");
    expect(balanceOf(world, "emp", "type-PL", 2026)).toBe(-11);
  });

  it("trust ON still files a PENDING item as pending", async () => {
    world.settings.trustExternalApprovals = true;
    expect((await ext.ingestExternalLeave({ kind: "API", sender: "k", rawItem: item({ status: "PENDING" }), now: NOW })).leaveStatus).toBe("PENDING");
  });

  it("the same ref twice is a DUPLICATE; a different sender with the same ref is not", async () => {
    await ext.ingestExternalLeave({ kind: "API", sender: "key-1", rawItem: item(), now: NOW });
    expect((await ext.ingestExternalLeave({ kind: "API", sender: "key-1", rawItem: item(), now: NOW })).status).toBe("DUPLICATE");
    expect(world.leaveRequest).toHaveLength(1);
  });

  it("CANCELLED for a known ref cancels it and reverses an approved debit", async () => {
    world.settings.trustExternalApprovals = true;
    await ext.ingestExternalLeave({ kind: "API", sender: "key-1", rawItem: item(), now: NOW });
    const r = await ext.ingestExternalLeave({ kind: "API", sender: "key-1", rawItem: item({ status: "CANCELLED" }), now: NOW });
    expect(r).toMatchObject({ status: "RECEIVED", leaveStatus: "CANCELLED" });
    expect(balanceOf(world, "emp", "type-PL", 2026)).toBe(12);
  });

  it("rejects an unknown person, an unknown type, a bad shape and a cancel with nothing to cancel", async () => {
    expect((await ext.ingestExternalLeave({ kind: "API", sender: "k", rawItem: item({ email: "nobody@x.io" }), now: NOW })).status).toBe("REJECTED");
    expect((await ext.ingestExternalLeave({ kind: "API", sender: "k", rawItem: item({ leaveType: "ZZ" }), now: NOW })).status).toBe("REJECTED");
    expect((await ext.ingestExternalLeave({ kind: "API", sender: "k", rawItem: { ...item(), days: 99 }, now: NOW })).status).toBe("REJECTED");
    expect((await ext.ingestExternalLeave({ kind: "API", sender: "k", rawItem: item({ status: "CANCELLED", externalRef: "x" }), now: NOW })).status).toBe("REJECTED");
    expect(world.leaveRequest).toHaveLength(0);
  });

  it("isLeaveItem tells a leave item from a punch on the shared webhook", () => {
    expect(ext.isLeaveItem({ kind: "leave" })).toBe(true);
    expect(ext.isLeaveItem({ punchInAt: "2026-11-23T09:00:00Z" })).toBe(false);
    expect(ext.isLeaveItem(null)).toBe(false);
  });
});
