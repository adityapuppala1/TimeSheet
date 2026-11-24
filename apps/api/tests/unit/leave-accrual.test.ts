/**
 * V17 Phase B — the accrual / rollover worker (workers/leave-accrual.worker.ts). The ledger rows it
 * writes are keyed and the keys are unique, so running it any number of times converges on the same
 * ledger. The in-memory world enforces those keys the way MySQL does.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addType, addUser, balanceOf, credit, emptyWorld, fakePrisma, type LeaveWorld } from "../helpers/leave-world.js";

let world: LeaveWorld = emptyWorld();
let client: Record<string, unknown> = fakePrisma(world);
const entitlements: Record<string, boolean> = { leaveManagementEnabled: true };

vi.mock("../../src/config/prisma.js", () => ({ prisma: new Proxy({}, { get: (_t, key: string) => client[key] }) }));
vi.mock("../../src/config/tenant-context.js", () => ({ requireTenantContext: () => ({ orgId: "org-1", orgSlug: "acme" }) }));
vi.mock("../../src/services/plan-limits.service.js", () => ({
  isPlanningCapabilityAllowed: async (_o: string, cap: string) => Boolean(entitlements[cap])
}));
vi.mock("../../src/services/planning.service.js", () => ({ getPlanningSettings: async () => ({ workingDays: [1, 2, 3, 4, 5], defaultWeeklyCapacityHours: 40 }) }));

const { runLeaveAccrual } = await import("../../src/workers/leave-accrual.worker.js");

beforeEach(() => {
  world = emptyWorld();
  client = fakePrisma(world);
  entitlements.leaveManagementEnabled = true;
  addUser(world, { id: "a", createdAt: new Date("2020-01-01T00:00:00Z") });
  addUser(world, { id: "joiner", createdAt: new Date("2026-07-15T00:00:00Z") });
  addUser(world, { id: "gone", status: "INACTIVE" });
  addUser(world, { id: "bot", isAgent: true });
  addType(world, { code: "PL", annualQuota: 12, accrual: "MONTHLY_PRORATA", carryForwardMax: 5 });
  addType(world, { code: "CL", annualQuota: 6, accrual: "YEARLY_UPFRONT" });
  addType(world, { code: "OFF", annualQuota: 6, enabled: false });
});

const NOV_23 = new Date("2026-11-23T05:00:00Z");

describe("accrual", () => {
  it("posts every slot due this leave year, for active people, enabled types only", async () => {
    const r = await runLeaveAccrual(NOV_23);
    expect(balanceOf(world, "a", "type-PL", 2026)).toBe(11);
    expect(balanceOf(world, "a", "type-CL", 2026)).toBe(6);
    expect(balanceOf(world, "a", "type-OFF", 2026)).toBe(0);
    expect(world.leaveBalanceLedger.some((l) => l.userId === "gone" || l.userId === "bot")).toBe(false);
    expect(r.accrued).toBe(world.leaveBalanceLedger.length);
  });

  it("a joiner accrues from their joining month", async () => {
    await runLeaveAccrual(NOV_23);
    expect(balanceOf(world, "joiner", "type-PL", 2026)).toBe(5); // Jul..Nov
    expect(balanceOf(world, "joiner", "type-CL", 2026)).toBe(3); // 6 × 6/12
  });

  it("is idempotent: a second (and third) run writes nothing", async () => {
    await runLeaveAccrual(NOV_23);
    const after = world.leaveBalanceLedger.length;
    expect(await runLeaveAccrual(NOV_23)).toEqual({ accrued: 0, rolledOver: 0 });
    await runLeaveAccrual(new Date("2026-11-24T05:00:00Z"));
    expect(world.leaveBalanceLedger.length).toBe(after);
    expect(balanceOf(world, "a", "type-PL", 2026)).toBe(11);
  });

  it("the next month adds exactly one slot", async () => {
    await runLeaveAccrual(NOV_23);
    const r = await runLeaveAccrual(new Date("2026-12-01T05:00:00Z"));
    expect(r.accrued).toBe(2); // a + joiner, PL only
    expect(balanceOf(world, "a", "type-PL", 2026)).toBe(12);
  });

  it("does nothing with leave off (toggle or plan)", async () => {
    world.settings.leaveEnabled = false;
    expect(await runLeaveAccrual(NOV_23)).toEqual({ accrued: 0, rolledOver: 0 });
    world.settings.leaveEnabled = true;
    entitlements.leaveManagementEnabled = false;
    expect(await runLeaveAccrual(NOV_23)).toEqual({ accrued: 0, rolledOver: 0 });
    expect(world.leaveBalanceLedger).toEqual([]);
  });
});

describe("year-end rollover", () => {
  const JAN_2 = new Date("2027-01-02T05:00:00Z");

  it("carries up to the cap, expires the rest, closes the old year at zero — once", async () => {
    credit(world, "a", "type-PL", 2026, 12);
    credit(world, "a", "type-PL", 2026, -4, "DEBIT");
    credit(world, "a", "type-CL", 2026, 2);
    await runLeaveAccrual(JAN_2);
    expect(balanceOf(world, "a", "type-PL", 2026)).toBe(0);
    expect(balanceOf(world, "a", "type-CL", 2026)).toBe(0);
    // PL: 8 unused, 5 carry + January's 1 accrual. CL: carryForwardMax 0 → nothing carries, 6 new.
    expect(balanceOf(world, "a", "type-PL", 2027)).toBe(6);
    expect(balanceOf(world, "a", "type-CL", 2027)).toBe(6);
    const before = world.leaveBalanceLedger.length;
    expect((await runLeaveAccrual(JAN_2)).rolledOver).toBe(0);
    expect(world.leaveBalanceLedger.length).toBe(before);
  });

  it("a debt carries in full", async () => {
    world.leaveType.find((t) => t.code === "CL")!.allowNegative = true;
    // The year's 6 (posted, as the worker would have in January) and 8 used: 2 in debt.
    credit(world, "a", "type-CL", 2026, 6, "ACCRUAL", "ACCRUAL:a:type-CL:2026-01");
    credit(world, "a", "type-CL", 2026, -8, "DEBIT");
    await runLeaveAccrual(JAN_2);
    expect(balanceOf(world, "a", "type-CL", 2026)).toBe(0);
    expect(balanceOf(world, "a", "type-CL", 2027)).toBe(4); // −2 carried + 6 upfront
  });

  it("honours an April leave year", async () => {
    world.settings.leaveYearStartMonth = 4;
    credit(world, "a", "type-PL", 2026, 9); // leave year 2026 = Apr 2026 – Mar 2027
    await runLeaveAccrual(new Date("2027-03-31T05:00:00Z"));
    expect(world.leaveBalanceLedger.some((l) => l.kind === "EXPIRY")).toBe(false);
    await runLeaveAccrual(new Date("2027-04-01T05:00:00Z"));
    // a: 9 credited + 12 accrued Apr–Mar = 21 unused → 5 carried. (The joiner carries their own.)
    expect(world.leaveBalanceLedger.filter((l) => l.kind === "CARRY_FORWARD" && l.userId === "a" && l.leaveTypeId === "type-PL")).toEqual([
      expect.objectContaining({ leaveYear: 2027, delta: 5 })
    ]);
  });
});
