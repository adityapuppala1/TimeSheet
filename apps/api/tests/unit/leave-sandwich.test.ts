/**
 * 7.0.0 sandwich rule (leave-calc.ts#sandwichedDays / countLeaveDays, leave.service.ts) — pure edges
 * plus the service path: the preview, the debit, the reversal on cancel, and a late-settled year all
 * use the same stored number.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addType, addUser, balanceOf, credit, emptyWorld, fakePrisma, type LeaveWorld } from "../helpers/leave-world.js";

let world: LeaveWorld = emptyWorld();
let client: Record<string, unknown> = fakePrisma(world);
const entitlements: Record<string, boolean> = { leaveManagementEnabled: true };

vi.mock("../../src/config/prisma.js", () => ({ prisma: new Proxy({}, { get: (_t, key: string) => client[key] }) }));
vi.mock("../../src/config/tenant-context.js", () => ({ requireTenantContext: () => ({ orgId: "org-1", orgSlug: "acme" }) }));
vi.mock("../../src/services/plan-limits.service.js", () => ({ isPlanningCapabilityAllowed: async (_o: string, cap: string) => Boolean(entitlements[cap]) }));
vi.mock("../../src/services/planning.service.js", () => ({ getPlanningSettings: async () => ({ workingDays: [1, 2, 3, 4, 5], defaultWeeklyCapacityHours: 40 }) }));
vi.mock("../../src/services/audit.service.js", () => ({ audit: async () => undefined }));
vi.mock("../../src/services/notify.service.js", () => ({ dispatchNotification: async () => undefined }));
vi.mock("../../src/services/domain-events.js", () => ({ emitDomainEvent: () => undefined }));

const calc = await import("../../src/services/leave-calc.js");
const leave = await import("../../src/services/leave.service.js");

const WEEKDAYS = [1, 2, 3, 4, 5];
const HOLIDAY = "2026-12-02"; // a Wednesday
const rules = (sandwich: boolean) => ({ workingDays: WEEKDAYS, isHoliday: (d: string) => d === HOLIDAY, sandwich });
const span = (startDate: string, endDate: string, startHalf: "FULL" | "SECOND_HALF" = "FULL", endHalf: "FULL" | "FIRST_HALF" = "FULL") => ({ startDate, endDate, startHalf, endHalf });

describe("pure", () => {
  it("off: a Friday-to-Monday request costs 2 days; on: the enclosed weekend makes it 4", () => {
    expect(calc.countLeaveDays(span("2026-11-27", "2026-11-30"), rules(false))).toBe(2);
    expect(calc.countLeaveDays(span("2026-11-27", "2026-11-30"), rules(true))).toBe(4);
    expect(calc.sandwichedDays(span("2026-11-27", "2026-11-30"), rules(true))).toEqual(["2026-11-28", "2026-11-29"]);
  });
  it("an enclosed holiday counts; one at the edge never does", () => {
    expect(calc.countLeaveDays(span("2026-12-01", "2026-12-03"), rules(true))).toBe(3);
    expect(calc.countLeaveDays(span("2026-12-02", "2026-12-03"), rules(true))).toBe(1);
  });
  it("weekends at the start or end are not enclosed", () => {
    expect(calc.countLeaveDays(span("2026-11-28", "2026-11-30"), rules(true))).toBe(1);
    expect(calc.countLeaveDays(span("2026-11-27", "2026-11-29"), rules(true))).toBe(1);
  });
  it("half days at the edges: the halves count 0.5 and still enclose the gap", () => {
    expect(calc.countLeaveDays(span("2026-11-27", "2026-11-30", "SECOND_HALF", "FIRST_HALF"), rules(false))).toBe(1);
    expect(calc.countLeaveDays(span("2026-11-27", "2026-11-30", "SECOND_HALF", "FIRST_HALF"), rules(true))).toBe(3);
  });
  it("a sandwiched day is not listed as excluded", () => {
    const ex = calc.excludedDays(span("2026-11-27", "2026-11-30"), { ...rules(true), holidayName: () => null });
    expect(ex).toEqual([]);
    expect(calc.excludedDays(span("2026-11-27", "2026-11-30"), { ...rules(false), holidayName: () => null }).map((e) => e.date)).toEqual(["2026-11-28", "2026-11-29"]);
  });
});

describe("service", () => {
  const NOW = new Date("2026-11-23T05:00:00Z");
  beforeEach(() => {
    world = emptyWorld();
    client = fakePrisma(world);
    addUser(world, { id: "mgr", role: "MANAGER" });
    addUser(world, { id: "emp", managerId: "mgr" });
    addType(world, { code: "SW", sandwichRule: true, requiresApproval: false });
    addType(world, { code: "PL", requiresApproval: false });
    credit(world, "emp", "type-SW", 2026, 10);
    credit(world, "emp", "type-PL", 2026, 10);
  });

  it("the preview, the debit and the reversal all use the sandwiched count", async () => {
    const preview = await leave.previewLeave("emp", { typeId: "type-SW", start: "2026-11-27", end: "2026-11-30" }, NOW);
    expect(preview).toMatchObject({ days: 4, sandwiched: ["2026-11-28", "2026-11-29"], excluded: [] });
    const { request } = await leave.applyLeave({ userId: "emp", leaveTypeCode: "SW", startDate: "2026-11-27", endDate: "2026-11-30", source: "WEB", actorId: "emp", now: NOW });
    expect(request.days).toBe(4);
    expect(balanceOf(world, "emp", "type-SW", 2026)).toBe(6);
    await leave.cancelLeave({ actor: { id: "emp", role: "EMPLOYEE" }, requestId: request.id, now: NOW });
    expect(balanceOf(world, "emp", "type-SW", 2026)).toBe(10);
  });

  it("a type without the rule is unchanged", async () => {
    const { request } = await leave.applyLeave({ userId: "emp", leaveTypeCode: "PL", startDate: "2026-11-27", endDate: "2026-11-30", source: "WEB", actorId: "emp", now: NOW });
    expect(request.days).toBe(2);
    expect((await leave.previewLeave("emp", { typeId: "type-PL", start: "2026-12-04", end: "2026-12-07" }, NOW)).sandwiched).toEqual([]);
  });

  it("an insufficient balance counts the sandwiched days", async () => {
    // No quota (no unposted accrual to top it up): exactly 3 days, against a 4-day sandwiched request.
    world.leaveBalanceLedger.length = 0;
    world.leaveType.find((t) => t.code === "SW")!.annualQuota = 0;
    credit(world, "emp", "type-SW", 2026, 3, "ADJUSTMENT");
    await expect(
      leave.applyLeave({ userId: "emp", leaveTypeCode: "SW", startDate: "2026-11-27", endDate: "2026-11-30", source: "WEB", actorId: "emp", now: NOW })
    ).rejects.toMatchObject({ code: "LEAVE_INSUFFICIENT_BALANCE" });
  });
});
