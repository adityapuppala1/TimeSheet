/**
 * 7.0.0 approval delegation (services/approval-delegation.service.ts) and how leave.service.ts and
 * comp-off.service.ts honour it: the inbox, the badge total, decisions "on behalf of" in the audit,
 * notifications to the delegate, the date range, revocation, self-delegation, cycles, eligibility,
 * one hop only, and the self-decision rule still winning.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addType, addUser, credit, emptyWorld, fakePrisma, type LeaveWorld } from "../helpers/leave-world.js";

let world: LeaveWorld = emptyWorld();
const entitlements: Record<string, boolean> = { leaveManagementEnabled: true };
const notifications: Array<{ userId: string; category: string }> = [];
const audits: Array<{ actor: string | undefined; action: string; meta: Record<string, unknown> }> = [];

let client: Record<string, unknown> = fakePrisma(world);
vi.mock("../../src/config/prisma.js", () => ({ prisma: new Proxy({}, { get: (_t, key: string) => client[key] }) }));
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
vi.mock("../../src/services/domain-events.js", () => ({ emitDomainEvent: () => undefined }));
vi.mock("../../src/services/notify.service.js", () => ({
  dispatchNotification: async (args: { userId: string; category: string }) => {
    notifications.push({ userId: args.userId, category: args.category });
  }
}));

const del = await import("../../src/services/approval-delegation.service.js");
const leave = await import("../../src/services/leave.service.js");
const comp = await import("../../src/services/comp-off.service.js");

// The real clock is used for "today" by the delegation rule; ranges are built around it.
const NOW = new Date();
const key = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const actor = (id: string) => ({ id, role: world.users.find((u) => u.id === id)!.role.name, name: id });

beforeEach(() => {
  world = emptyWorld();
  client = fakePrisma(world);
  notifications.length = 0;
  audits.length = 0;
  addUser(world, { id: "super", role: "SUPER_ADMIN" });
  addUser(world, { id: "admin", role: "ADMIN" });
  addUser(world, { id: "mgr", role: "MANAGER" });
  addUser(world, { id: "cover", role: "MANAGER" });
  addUser(world, { id: "cover2", role: "TEAM_LEAD" });
  addUser(world, { id: "emp", role: "EMPLOYEE", managerId: "mgr" });
  addUser(world, { id: "emp2", role: "EMPLOYEE", managerId: "cover" });
  addType(world, { code: "PL", annualQuota: 12 });
  const year = Number(key(0).slice(0, 4));
  credit(world, "emp", "type-PL", year, 30, "ACCRUAL");
  credit(world, "emp", "type-PL", year + 1, 30, "ACCRUAL");
});

// A weekday two weeks out, so the request always costs a working day whatever today is.
const WORKDAY = [14, 15, 16].map(key).find((k) => ![0, 6].includes(new Date(`${k}T12:00:00Z`).getUTCDay()))!;
const applyFor = (userId = "emp") => leave.applyLeave({ userId, leaveTypeCode: "PL", startDate: WORKDAY, endDate: WORKDAY, source: "WEB", actorId: userId });

describe("pure rules", () => {
  it("self-delegation and cycles along overlapping ranges are cycles; disjoint ranges are not", () => {
    const e = (a: string, b: string, s = "2026-12-01", t = "2026-12-10") => ({ delegatorId: a, delegateId: b, startDate: s, endDate: t });
    expect(del.wouldCycle(e("a", "a"), [])).toBe(true);
    expect(del.wouldCycle(e("a", "b"), [e("b", "a")])).toBe(true);
    expect(del.wouldCycle(e("a", "b"), [e("b", "c"), e("c", "a")])).toBe(true);
    expect(del.wouldCycle(e("a", "b"), [e("b", "a", "2027-01-01", "2027-01-05")])).toBe(false);
    expect(del.wouldCycle(e("a", "b"), [e("c", "a")])).toBe(false);
  });

  it("inForce covers the range inclusively and never a revoked one", () => {
    expect(del.inForce({ startDate: "2026-12-01", endDate: "2026-12-03", revoked: false }, "2026-12-03")).toBe(true);
    expect(del.inForce({ startDate: "2026-12-01", endDate: "2026-12-03", revoked: false }, "2026-12-04")).toBe(false);
    expect(del.inForce({ startDate: "2026-12-01", endDate: "2026-12-03", revoked: true }, "2026-12-02")).toBe(false);
  });
});

describe("creating delegations", () => {
  it("refuses self-delegation, an ineligible delegate, a cycle, and someone else's approvals for a non-admin", async () => {
    await expect(del.createDelegation(actor("mgr"), { delegateId: "mgr", startDate: key(0), endDate: key(3) }, NOW)).rejects.toMatchObject({ code: "DELEGATION_SELF" });
    await expect(del.createDelegation(actor("mgr"), { delegateId: "emp2", startDate: key(0), endDate: key(3) }, NOW)).rejects.toMatchObject({ code: "DELEGATION_INELIGIBLE" });
    await del.createDelegation(actor("mgr"), { delegateId: "cover", startDate: key(0), endDate: key(3) }, NOW);
    await expect(del.createDelegation(actor("cover"), { delegateId: "mgr", startDate: key(2), endDate: key(5) }, NOW)).rejects.toMatchObject({ code: "DELEGATION_CYCLE" });
    await expect(del.createDelegation(actor("cover"), { delegatorId: "mgr", delegateId: "cover2", startDate: key(0), endDate: key(3) }, NOW)).rejects.toMatchObject({ statusCode: 403 });
    expect(world.approvalDelegation).toHaveLength(1);
  });

  it("an admin may set one for anyone; a stranger cannot revoke it (404)", async () => {
    const d = await del.createDelegation(actor("admin"), { delegatorId: "mgr", delegateId: "cover", startDate: key(0), endDate: key(3) }, NOW);
    expect(d).toMatchObject({ delegator: { id: "mgr" }, delegate: { id: "cover" }, active: true });
    await expect(del.revokeDelegation(actor("cover2"), d.id, NOW)).rejects.toMatchObject({ statusCode: 404 });
    expect((await del.listDelegations(actor("admin"), "all", NOW))).toHaveLength(1);
    await expect(del.listDelegations(actor("mgr"), "all", NOW)).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("the delegate sees and decides", () => {
  it("in range: inbox, badge total, decision on behalf of, and the approver keeps the right", async () => {
    const { request } = await applyFor();
    expect((await leave.listInbox(actor("cover"))).total).toBe(0);
    await del.createDelegation(actor("mgr"), { delegateId: "cover", startDate: key(-1), endDate: key(3) }, NOW);
    const inbox = await leave.listInbox(actor("cover"));
    expect(inbox.total).toBe(1);
    // The decider sees the reason field as the approver would (not stripped).
    expect(inbox.items[0].id).toBe(request.id);
    expect((await leave.listInbox(actor("mgr"))).total).toBe(1);
    const decided = await leave.decideLeave({ actor: actor("cover"), requestId: request.id, decision: "APPROVE" });
    expect(decided.status).toBe("APPROVED");
    expect(decided.overriddenBySuperAdmin).toBe(false);
    expect(audits.find((a) => a.action === "leave.approved")).toMatchObject({ actor: "cover", meta: { onBehalfOf: "mgr" } });
  });

  it("the delegate is notified of a new request while the delegation is in force", async () => {
    await del.createDelegation(actor("mgr"), { delegateId: "cover", startDate: key(0), endDate: key(3) }, NOW);
    await applyFor();
    expect(notifications.filter((n) => n.category === "leave.requested").map((n) => n.userId).sort()).toEqual(["cover", "mgr"]);
  });

  it("out of range, or revoked: nothing (same 403 as any stranger)", async () => {
    const { request } = await applyFor();
    const future = await del.createDelegation(actor("mgr"), { delegateId: "cover", startDate: key(5), endDate: key(9) }, NOW);
    expect((await leave.listInbox(actor("cover"))).total).toBe(0);
    await expect(leave.decideLeave({ actor: actor("cover"), requestId: request.id, decision: "APPROVE" })).rejects.toMatchObject({ statusCode: 403 });
    await del.revokeDelegation(actor("mgr"), future.id, NOW);
    const now = await del.createDelegation(actor("mgr"), { delegateId: "cover", startDate: key(0), endDate: key(2) }, NOW);
    expect((await leave.listInbox(actor("cover"))).total).toBe(1);
    await del.revokeDelegation(actor("cover"), now.id, NOW);
    expect((await leave.listInbox(actor("cover"))).total).toBe(0);
  });

  it("one hop only: the delegate's delegate gets nothing of the original approver", async () => {
    await applyFor();
    await del.createDelegation(actor("mgr"), { delegateId: "cover", startDate: key(0), endDate: key(3) }, NOW);
    await del.createDelegation(actor("cover"), { delegateId: "cover2", startDate: key(0), endDate: key(3) }, NOW);
    expect((await leave.listInbox(actor("cover2"))).total).toBe(0);
  });

  it("a delegate never decides their own request", async () => {
    addUser(world, { id: "lead", role: "TEAM_LEAD", managerId: "mgr" });
    credit(world, "lead", "type-PL", Number(WORKDAY.slice(0, 4)), 30, "ACCRUAL");
    await del.createDelegation(actor("mgr"), { delegateId: "lead", startDate: key(0), endDate: key(3) }, NOW);
    const { request } = await applyFor("lead");
    expect((await leave.listInbox(actor("lead"))).total).toBe(0);
    await expect(leave.decideLeave({ actor: actor("lead"), requestId: request.id, decision: "APPROVE" })).rejects.toMatchObject({ statusCode: 403 });
  });

  it("comp-off requests follow the same delegation", async () => {
    const sat = [...Array(14).keys()].map((i) => key(-i - 1)).find((k) => new Date(`${k}T12:00:00Z`).getUTCDay() === 6)!;
    world.timesheet.push({ id: "t1", userId: "emp", workDate: new Date(`${sat}T00:00:00.000Z`), totalHours: 8, status: "SUBMITTED", deletedAt: null });
    addType(world, { code: "CO", annualQuota: 0 });
    const r = await comp.requestCompOff({ userId: "emp", workDate: sat });
    await del.createDelegation(actor("mgr"), { delegateId: "cover", startDate: key(0), endDate: key(3) }, NOW);
    expect((await comp.listCompOffInbox(actor("cover"))).items[0]).toMatchObject({ id: r.id, onBehalfOf: "mgr" });
    const done = await comp.decideCompOff({ actor: actor("cover"), requestId: r.id, decision: "APPROVE" });
    expect(done).toMatchObject({ status: "APPROVED", onBehalfOfId: "mgr" });
  });
});
