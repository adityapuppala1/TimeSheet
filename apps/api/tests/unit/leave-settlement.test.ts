/**
 * V17 Phase B review fix — ledger movement in a leave year AFTER the rollover settled it
 * (services/leave-settlement.service.ts). Every scenario runs the real service and the real worker
 * against the in-memory tenant, and asserts the whole ledger outcome: the closed year back at zero,
 * the new year's carry re-computed under carryForwardMax, and re-runs writing nothing.
 *
 * Calendar: leave year = calendar year. 2026-12-14 and 2026-12-28 and 2027-01-04 are Mondays.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addType, addUser, balanceOf, credit, emptyWorld, fakePrisma, type LeaveWorld } from "../helpers/leave-world.js";

let world: LeaveWorld = emptyWorld();
let client: Record<string, unknown> = fakePrisma(world);
const entitlements: Record<string, boolean> = { leaveManagementEnabled: true };

vi.mock("../../src/config/prisma.js", () => ({ prisma: new Proxy({}, { get: (_t, key: string) => client[key] }) }));
vi.mock("../../src/config/tenant-context.js", () => ({ requireTenantContext: () => ({ orgId: "org-1", orgSlug: "acme" }) }));
vi.mock("../../src/services/plan-limits.service.js", () => ({
  isPlanningCapabilityAllowed: async (_o: string, cap: string) => Boolean(entitlements[cap]),
  getPlanningEntitlements: async () => ({ ...entitlements })
}));
vi.mock("../../src/services/planning.service.js", () => ({ getPlanningSettings: async () => ({ workingDays: [1, 2, 3, 4, 5], defaultWeeklyCapacityHours: 40 }) }));
vi.mock("../../src/services/audit.service.js", () => ({ audit: async () => undefined }));
vi.mock("../../src/services/domain-events.js", () => ({ emitDomainEvent: () => undefined }));
vi.mock("../../src/services/notify.service.js", () => ({ dispatchNotification: async () => undefined }));

const svc = await import("../../src/services/leave.service.js");
const { runLeaveAccrual } = await import("../../src/workers/leave-accrual.worker.js");

const NOV_23 = new Date("2026-11-23T10:00:00Z");
const JAN_2 = new Date("2027-01-02T05:00:00Z");
const JAN_4 = new Date("2027-01-04T10:00:00Z");
const JAN_5 = new Date("2027-01-05T05:00:00Z");

const actor = (id: string) => ({ id, role: world.users.find((u) => u.id === id)!.role.name, name: id });
const rows = (kind: string, year: number) => world.leaveBalanceLedger.filter((l) => l.userId === "emp" && l.kind === kind && l.leaveYear === year);

beforeEach(() => {
  world = emptyWorld();
  client = fakePrisma(world);
  addUser(world, { id: "super", role: "SUPER_ADMIN" });
  addUser(world, { id: "mgr", role: "MANAGER" });
  addUser(world, { id: "emp", managerId: "mgr" });
  // Yearly upfront 12, up to 5 carry.
  addType(world, { code: "PL", annualQuota: 12, carryForwardMax: 5 });
  credit(world, "emp", "type-PL", 2026, 12, "ACCRUAL", "ACCRUAL:emp:type-PL:2026-01");
});

async function applyDec(start = "2026-12-14", end = "2026-12-16", now = NOV_23) {
  return (await svc.applyLeave({ userId: "emp", leaveTypeCode: "PL", startDate: start, endDate: end, source: "WEB", actorId: "emp", now })).request;
}

describe("a December request approved after the rollover", () => {
  it("is approved against the closed year's balance; the carry stays at the cap when the unused part covers it", async () => {
    const req = await applyDec(); // 3 days pending
    await runLeaveAccrual(JAN_2); // 12 unused → 5 carried, 12 expire from 2026
    expect(balanceOf(world, "emp", "type-PL", 2027)).toBe(17);

    const decided = await svc.decideLeave({ actor: actor("mgr"), requestId: req.id, decision: "APPROVE", now: JAN_4 });
    expect(decided.status).toBe("APPROVED");
    // 12 − 3 = 9 unused would still have carried 5: nothing moves in 2027, 2026 is back at zero.
    expect(balanceOf(world, "emp", "type-PL", 2026)).toBe(0);
    expect(balanceOf(world, "emp", "type-PL", 2027)).toBe(17);
    expect(rows("ADJUSTMENT", 2027)).toHaveLength(0);
  });

  it("shrinks the carry when the closed year's balance was under the cap", async () => {
    credit(world, "emp", "type-PL", 2026, -8, "DEBIT");
    const req = await applyDec(); // 4 left, 3 pending
    await runLeaveAccrual(JAN_2); // 4 carried
    expect(balanceOf(world, "emp", "type-PL", 2027)).toBe(16);

    await svc.decideLeave({ actor: actor("mgr"), requestId: req.id, decision: "APPROVE", now: JAN_4 });
    expect(balanceOf(world, "emp", "type-PL", 2026)).toBe(0);
    expect(balanceOf(world, "emp", "type-PL", 2027)).toBe(13); // carry 4 → 1
    expect(rows("ADJUSTMENT", 2027)).toEqual([expect.objectContaining({ delta: -3, idempotencyKey: `SETTLE:DEBIT:${req.id}` })]);
  });

  it("is refused when the carried days are already spent in the new year", async () => {
    credit(world, "emp", "type-PL", 2026, -8, "DEBIT");
    const req = await applyDec();
    await runLeaveAccrual(JAN_2);
    credit(world, "emp", "type-PL", 2027, -15, "DEBIT"); // 16 − 15 = 1 left
    const before = structuredClone(world.leaveBalanceLedger);
    await expect(svc.decideLeave({ actor: actor("mgr"), requestId: req.id, decision: "APPROVE", now: JAN_4 })).rejects.toMatchObject({
      statusCode: 409,
      code: "LEAVE_INSUFFICIENT_BALANCE"
    });
    expect(world.leaveBalanceLedger).toEqual(before);
    expect(world.leaveRequest[0].status).toBe("PENDING");
  });
});

describe("an approved December leave cancelled after the rollover", () => {
  it("credits the closed year back and re-computes the carry under the cap", async () => {
    credit(world, "emp", "type-PL", 2026, -6, "DEBIT");
    const req = await applyDec();
    await svc.decideLeave({ actor: actor("mgr"), requestId: req.id, decision: "APPROVE", now: NOV_23 });
    await runLeaveAccrual(JAN_2); // 12 − 6 − 3 = 3 carried
    expect(balanceOf(world, "emp", "type-PL", 2027)).toBe(15);

    await svc.cancelLeave({ actor: actor("super"), requestId: req.id, now: JAN_4 });
    // 6 unused now → 5 carry (the cap), +2 into 2027; 2026 back at zero.
    expect(balanceOf(world, "emp", "type-PL", 2026)).toBe(0);
    expect(balanceOf(world, "emp", "type-PL", 2027)).toBe(17);
    expect(rows("ADJUSTMENT", 2027)).toEqual([expect.objectContaining({ delta: 2, idempotencyKey: `SETTLE:REVERSAL:${req.id}` })]);
  });
});

describe("a backdated debit on an allowNegative type", () => {
  beforeEach(() => {
    addType(world, { code: "NEG", annualQuota: 5, allowNegative: true, requiresApproval: false, carryForwardMax: 0 });
    credit(world, "emp", "type-NEG", 2026, 5, "ACCRUAL", "ACCRUAL:emp:type-NEG:2026-01");
    credit(world, "emp", "type-NEG", 2026, -3, "DEBIT");
  });
  const backdate = (start: string, end: string) =>
    svc.applyLeave({ userId: "emp", leaveTypeCode: "NEG", startDate: start, endDate: end, source: "WEB", actorId: "emp", now: JAN_4 });

  it("a debt created after the rollover carries in full", async () => {
    await runLeaveAccrual(JAN_2); // 2 unused, cap 0 → all expire; 2027 has its own 5
    expect(balanceOf(world, "emp", "type-NEG", 2027)).toBe(5);
    await backdate("2026-12-28", "2026-12-29"); // uses the 2 that expired: no change to 2027
    expect(balanceOf(world, "emp", "type-NEG", 2026)).toBe(0);
    expect(balanceOf(world, "emp", "type-NEG", 2027)).toBe(5);
    await backdate("2026-12-30", "2026-12-30"); // a 1-day debt in 2026 follows into 2027
    expect(balanceOf(world, "emp", "type-NEG", 2026)).toBe(0);
    expect(balanceOf(world, "emp", "type-NEG", 2027)).toBe(4);
  });

  it("a year closed at exactly zero has no settlement row; the next run settles the late debit", async () => {
    credit(world, "emp", "type-NEG", 2026, -2, "DEBIT"); // closing balance 0
    await runLeaveAccrual(JAN_2);
    await backdate("2026-12-30", "2026-12-30");
    expect(balanceOf(world, "emp", "type-NEG", 2026)).toBe(-1); // not settled yet
    await runLeaveAccrual(JAN_5);
    expect(balanceOf(world, "emp", "type-NEG", 2026)).toBe(0);
    expect(balanceOf(world, "emp", "type-NEG", 2027)).toBe(4);
  });
});

describe("the rollover itself", () => {
  it("posts the closing year's missing accrual before settling it (server down for December's run)", async () => {
    addType(world, { code: "ML", annualQuota: 12, accrual: "MONTHLY_PRORATA", carryForwardMax: 20 });
    for (let m = 1; m <= 11; m++) credit(world, "emp", "type-ML", 2026, 1, "ACCRUAL", `ACCRUAL:emp:type-ML:2026-${String(m).padStart(2, "0")}`);
    await runLeaveAccrual(JAN_2);
    expect(world.leaveBalanceLedger.some((l) => l.idempotencyKey === "ACCRUAL:emp:type-ML:2026-12")).toBe(true);
    expect(world.leaveBalanceLedger.find((l) => l.idempotencyKey === "CARRY:emp:type-ML:2027")).toMatchObject({ delta: 12 });
  });

  it("does not hand a type last year's quota when it had no activity last year", async () => {
    addType(world, { code: "NEW", annualQuota: 12, carryForwardMax: 12 });
    await runLeaveAccrual(JAN_2);
    expect(world.leaveBalanceLedger.filter((l) => l.leaveTypeId === "type-NEW" && l.leaveYear === 2026)).toHaveLength(0);
  });

  it("is idempotent after late movements, and heals a movement that bypassed the settlement", async () => {
    credit(world, "emp", "type-PL", 2026, -8, "DEBIT");
    const req = await applyDec();
    await runLeaveAccrual(JAN_2);
    await svc.decideLeave({ actor: actor("mgr"), requestId: req.id, decision: "APPROVE", now: JAN_4 });
    const settled = structuredClone(world.leaveBalanceLedger);
    expect(await runLeaveAccrual(JAN_5)).toEqual({ accrued: 0, rolledOver: 0 });
    expect(await runLeaveAccrual(JAN_5)).toEqual({ accrued: 0, rolledOver: 0 });
    expect(world.leaveBalanceLedger).toEqual(settled);

    // A row written into 2026 behind the service's back (e.g. racing the worker): the next run re-settles it once.
    credit(world, "emp", "type-PL", 2026, 1, "ADJUSTMENT");
    await runLeaveAccrual(JAN_5);
    expect(balanceOf(world, "emp", "type-PL", 2026)).toBe(0);
    expect(balanceOf(world, "emp", "type-PL", 2027)).toBe(14); // carry 1 → 2
    const healed = world.leaveBalanceLedger.length;
    await runLeaveAccrual(JAN_5);
    expect(world.leaveBalanceLedger).toHaveLength(healed);
  });
});
