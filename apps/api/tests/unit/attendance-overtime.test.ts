/**
 * 7.0.0 overtime (services/attendance-overtime.service.ts, leave-calc.ts#overtimeForWeek) against the
 * in-memory tenant (tests/helpers/leave-world.ts).
 *
 * Covered: the thresholds (daily, weekly, the larger-of rule), a night shift crossing midnight, the
 * gate (off by default, approval off refuses claims), the claim rules, IDOR on decide and cancel,
 * the double-approve race (exactly one wins), delegation, payroll basis, and analytics suppression.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addUser, emptyWorld, fakePrisma, type LeaveWorld } from "../helpers/leave-world.js";

let world: LeaveWorld = emptyWorld();
const entitlements: Record<string, boolean> = { attendanceEnabled: true };
let shiftRows: Array<Record<string, unknown>> = [];

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
vi.mock("../../src/services/audit.service.js", () => ({ audit: async () => undefined }));
vi.mock("../../src/services/notify.service.js", () => ({ dispatchNotification: async () => undefined }));

const svc = await import("../../src/services/attendance-overtime.service.js");
const calc = await import("../../src/services/leave-calc.js");
const payroll = await import("../../src/services/payroll-export.service.js");

// Monday 2026-11-23, 10:00 UTC. The week before starts Monday 2026-11-16.
const NOW = new Date("2026-11-23T10:00:00Z");
const WEEK = "2026-11-16";
const actor = (id: string) => ({ id, role: world.users.find((u) => u.id === id)!.role.name });
const log = (userId: string, date: string, hours: number, status = "APPROVED") =>
  world.timesheet.push({ id: `ts-${world.timesheet.length}`, userId, workDate: new Date(`${date}T00:00:00Z`), totalHours: hours, status, deletedAt: null });

beforeEach(() => {
  world = emptyWorld();
  client = fakePrisma(world);
  shiftRows = [];
  client.attendanceShiftAssignment = { findMany: async () => shiftRows };
  client.attendanceRecord = { findMany: async () => [] };
  client.attendanceSource = { findMany: async () => [] };
  client.holidayCalendar = { ...(client.holidayCalendar as object), findMany: async () => [] };
  Object.assign(world.settings, { attendanceEnabled: true, overtimeEnabled: true, overtimeDailyThresholdHours: 0, overtimeWeeklyThresholdHours: 0, overtimeRequireApproval: true });
  entitlements.attendanceEnabled = true;
  addUser(world, { id: "super", role: "SUPER_ADMIN" });
  addUser(world, { id: "mgr", role: "MANAGER" });
  addUser(world, { id: "other-mgr", role: "MANAGER" });
  addUser(world, { id: "emp", role: "EMPLOYEE", managerId: "mgr" });
});

describe("pure arithmetic", () => {
  const day = (date: string, worked: number, expected = 8) => ({ date, worked, expected });
  it("daily excess over the threshold, weekly excess over its own, and the larger of the two", () => {
    const days = [day("2026-11-16", 10), day("2026-11-17", 6), day("2026-11-18", 8)];
    expect(calc.overtimeForWeek(WEEK, days, { dailyThresholdHours: 0, weeklyThresholdHours: 0 })).toMatchObject({ dailyOvertime: 2, weeklyOvertime: 0, overtimeHours: 2 });
    expect(calc.overtimeForWeek(WEEK, days, { dailyThresholdHours: 1, weeklyThresholdHours: 0 }).overtimeHours).toBe(1);
    const steady = [day("2026-11-16", 8.5), day("2026-11-17", 8.5), day("2026-11-18", 8.5), day("2026-11-19", 8.5)];
    expect(calc.overtimeForWeek(WEEK, steady, { dailyThresholdHours: 1, weeklyThresholdHours: 0 })).toMatchObject({ dailyOvertime: 0, weeklyOvertime: 2, overtimeHours: 2 });
    expect(calc.overtimeForWeek(WEEK, steady, { dailyThresholdHours: 1, weeklyThresholdHours: 3 }).overtimeHours).toBe(0);
  });
  it("weekStartOf is the ISO Monday", () => {
    expect(calc.weekStartOf("2026-11-22")).toBe("2026-11-16");
    expect(calc.weekStartOf("2026-11-16")).toBe("2026-11-16");
  });
  it("a claim needs a finished week, a Monday, inside the window", () => {
    expect(svc.claimWeekProblem("2026-11-17", "2026-11-23")).toMatch(/Monday/);
    expect(svc.claimWeekProblem("2026-11-23", "2026-11-25")).toMatch(/over/);
    expect(svc.claimWeekProblem(WEEK, "2026-11-23")).toBeNull();
    expect(svc.claimWeekProblem("2026-09-07", "2026-11-23")).toMatch(/60 days/);
  });
});

describe("computation", () => {
  it("workspace day: 40h/5 days = 8h expected; a weekend's hours are all overtime", async () => {
    log("emp", "2026-11-16", 10);
    log("emp", "2026-11-21", 3);
    log("emp", "2026-11-17", 5, "REJECTED");
    const week = (await svc.computeOvertime(["emp"], WEEK, WEEK, { dailyThresholdHours: 0, weeklyThresholdHours: 0 })).get("emp")![0];
    expect(week.days.find((d) => d.date === "2026-11-16")).toMatchObject({ worked: 10, expected: 8, overtime: 2 });
    expect(week.days.find((d) => d.date === "2026-11-21")).toMatchObject({ worked: 3, expected: 0, overtime: 3 });
    expect(week.dailyOvertime).toBe(5);
  });
  it("a night shift crossing midnight is one day on its start date, measured against the shift", async () => {
    // 22:00 → 06:30 with a 30-minute break = 8h, Monday to Friday.
    shiftRows = [
      { userId: "emp", managerId: null, effectiveFrom: new Date("2026-01-01T00:00:00Z"), effectiveTo: null, shift: { id: "night", name: "Night", startMinute: 1320, endMinute: 390, breakMinutes: 30, workingDays: [1, 2, 3, 4, 5] } }
    ];
    log("emp", "2026-11-20", 9.5); // Friday night into Saturday morning: filed on Friday
    log("emp", "2026-11-22", 2); // Sunday: not a shift day
    const week = (await svc.computeOvertime(["emp"], WEEK, WEEK, { dailyThresholdHours: 0, weeklyThresholdHours: 0 })).get("emp")![0];
    expect(week.days.find((d) => d.date === "2026-11-20")).toMatchObject({ expected: 8, overtime: 1.5 });
    expect(week.days.find((d) => d.date === "2026-11-21")).toMatchObject({ expected: 0, worked: 0 });
    expect(week.days.find((d) => d.date === "2026-11-22")).toMatchObject({ expected: 0, overtime: 2 });
    expect(week.expectedHours).toBe(40);
  });
});

describe("gate", () => {
  it("refuses while overtime is off (the default) and claims while approval is off", async () => {
    world.settings.overtimeEnabled = false;
    await expect(svc.getMyOvertime("emp", { from: WEEK, to: WEEK })).rejects.toMatchObject({ statusCode: 403 });
    expect(await svc.overtimeHoursForPeriod(["emp"], "2026-11-01", "2026-11-30")).toBeNull();
    world.settings.overtimeEnabled = true;
    world.settings.overtimeRequireApproval = false;
    await expect(svc.requestOvertimeClaim({ userId: "emp", weekStart: WEEK, now: NOW })).rejects.toMatchObject({ statusCode: 403 });
    await expect(svc.listOvertimeInbox(actor("mgr"), NOW)).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("claims", () => {
  beforeEach(() => log("emp", "2026-11-16", 11));

  it("computes the hours server-side, one open claim per week, nothing to claim is refused", async () => {
    const c = await svc.requestOvertimeClaim({ userId: "emp", weekStart: WEEK, now: NOW });
    expect(c).toMatchObject({ hours: 3, status: "PENDING", approverId: "mgr" });
    await expect(svc.requestOvertimeClaim({ userId: "emp", weekStart: WEEK, now: NOW })).rejects.toMatchObject({ statusCode: 409 });
    await expect(svc.requestOvertimeClaim({ userId: "emp", weekStart: "2026-11-09", now: NOW })).rejects.toMatchObject({ statusCode: 422 });
  });

  it("IDOR: an unknown id and someone else's claim get the same 403; only the owner cancels", async () => {
    const c = await svc.requestOvertimeClaim({ userId: "emp", weekStart: WEEK, now: NOW });
    await expect(svc.decideOvertimeClaim({ actor: actor("other-mgr"), requestId: c.id, decision: "APPROVE", now: NOW })).rejects.toMatchObject({ statusCode: 403 });
    await expect(svc.decideOvertimeClaim({ actor: actor("other-mgr"), requestId: "nope", decision: "APPROVE", now: NOW })).rejects.toMatchObject({ statusCode: 403 });
    await expect(svc.decideOvertimeClaim({ actor: actor("emp"), requestId: c.id, decision: "APPROVE", now: NOW })).rejects.toMatchObject({ statusCode: 403 });
    await expect(svc.cancelOvertimeClaim("mgr", c.id)).rejects.toMatchObject({ statusCode: 404 });
    expect((await svc.listOvertimeInbox(actor("other-mgr"), NOW)).total).toBe(0);
    expect((await svc.listOvertimeInbox(actor("mgr"), NOW)).total).toBe(1);
  });

  it("the approval race: two approvals at once, exactly one wins", async () => {
    const c = await svc.requestOvertimeClaim({ userId: "emp", weekStart: WEEK, now: NOW });
    const results = await Promise.allSettled([
      svc.decideOvertimeClaim({ actor: actor("mgr"), requestId: c.id, decision: "APPROVE", now: NOW }),
      svc.decideOvertimeClaim({ actor: actor("super"), requestId: c.id, decision: "APPROVE", now: NOW })
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ statusCode: 409 });
    expect(world.overtimeClaim.filter((r) => r.status === "APPROVED")).toHaveLength(1);
  });

  it("a delegate decides on the approver's behalf", async () => {
    world.approvalDelegation.push({ id: "d1", delegatorId: "mgr", delegateId: "other-mgr", startDate: new Date("2026-11-01T00:00:00Z"), endDate: new Date("2026-11-30T00:00:00Z"), revokedAt: null });
    const c = await svc.requestOvertimeClaim({ userId: "emp", weekStart: WEEK, now: NOW });
    const d = await svc.decideOvertimeClaim({ actor: actor("other-mgr"), requestId: c.id, decision: "APPROVE", now: NOW });
    expect(d).toMatchObject({ status: "APPROVED", onBehalfOfId: "mgr" });
  });

  it("payroll counts approved hours with approval on, computed hours with it off", async () => {
    const c = await svc.requestOvertimeClaim({ userId: "emp", weekStart: WEEK, now: NOW });
    expect((await svc.overtimeHoursForPeriod(["emp"], "2026-11-01", "2026-11-30"))!.hours.get("emp") ?? 0).toBe(0);
    await svc.decideOvertimeClaim({ actor: actor("mgr"), requestId: c.id, decision: "APPROVE", now: NOW });
    expect(await svc.overtimeHoursForPeriod(["emp"], "2026-11-01", "2026-11-30")).toMatchObject({ basis: "APPROVED" });
    expect((await svc.overtimeHoursForPeriod(["emp"], "2026-11-01", "2026-11-30"))!.hours.get("emp")).toBe(3);
    world.settings.overtimeRequireApproval = false;
    const computed = await svc.overtimeHoursForPeriod(["emp"], "2026-11-01", "2026-11-30");
    expect(computed!.basis).toBe("COMPUTED");
    expect(computed!.hours.get("emp")).toBe(3);
  });
});

describe("payroll CSV and analytics", () => {
  it("adds the column only while overtime is on", () => {
    const base = { month: "2026-11", from: "2026-11-01", to: "2026-11-30", leaveYear: 2026, leaveYearClosed: false, leaveTypes: [] };
    const row = { userId: "emp", name: "emp", email: "e@x.io", employeeCode: null, workingDays: 20, holidays: 0, present: 0, absent: 0, leave: {}, paidLeave: 0, unpaidLeave: 0, compOffTaken: 0, compOffEarned: 0, loggedHours: 0 };
    expect(payroll.payrollCsv({ ...base, rows: [row] })).not.toMatch(/Overtime/);
    expect(payroll.payrollCsv({ ...base, overtime: { basis: "APPROVED" }, rows: [{ ...row, overtimeHours: 3 }] })).toMatch(/Overtime hours \(approved\)/);
  });
  it("group figures are suppressed below the minimum group size; nothing while off", async () => {
    world.settings.overtimeRequireApproval = false;
    log("emp", "2026-11-16", 11);
    expect(await svc.overtimeAnalytics("me", ["emp"], { from: "2026-11-01", to: "2026-11-30" }, 5)).toMatchObject({ hours: 3 });
    expect(await svc.overtimeAnalytics("team", ["emp", "mgr"], { from: "2026-11-01", to: "2026-11-30" }, 5)).toMatchObject({ suppressed: true, totalHours: null });
    expect(await svc.overtimeAnalytics("org", ["emp", "mgr", "super"], { from: "2026-11-01", to: "2026-11-30" }, 3)).toMatchObject({ suppressed: false, totalHours: 3, peopleWithOvertime: 1 });
    world.settings.overtimeEnabled = false;
    expect(await svc.overtimeAnalytics("org", ["emp"], { from: "2026-11-01", to: "2026-11-30" }, 3)).toBeUndefined();
  });
});
