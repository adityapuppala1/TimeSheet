/**
 * 7.0.0 payroll export (services/payroll-export.service.ts): working days, holidays, present,
 * absent, leave by type (halves, working days only), paid vs unpaid, comp-off taken/earned, logged
 * hours, the closed-leave-year flag, the CSV (columns, formula guard, no reason) and the gate.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addType, addUser, emptyWorld, fakePrisma, type LeaveWorld } from "../helpers/leave-world.js";

let world: LeaveWorld = emptyWorld();
const entitlements: Record<string, boolean> = { leaveManagementEnabled: true, attendanceEnabled: true };
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

const svc = await import("../../src/services/payroll-export.service.js");

const d = (k: string) => new Date(`${k}T00:00:00.000Z`);
const NOW = new Date("2026-12-05T10:00:00Z"); // November 2026 is over

beforeEach(() => {
  world = emptyWorld();
  client = fakePrisma(world);
  world.settings.attendanceEnabled = true;
  Object.assign(entitlements, { leaveManagementEnabled: true, attendanceEnabled: true });
  addUser(world, { id: "emp", role: "EMPLOYEE", name: "=cmd|calc", employeeCode: "E1" });
  addType(world, { code: "PL", isPaid: true });
  addType(world, { code: "LOP", isPaid: false, allowNegative: true });
  addType(world, { code: "CO", isPaid: true });
  world.holidayCalendar.push({ id: "cal", isDefault: true });
  world.holiday.push({ id: "h", calendarId: "cal", date: d("2026-11-19"), name: "Founders", isOptional: false });
  // November 2026: 21 weekdays, one of them a holiday → 20 working days.
  world.attendanceRecord = [
    { userId: "emp", workDate: d("2026-11-02") },
    { userId: "emp", workDate: d("2026-11-03") },
    { userId: "emp", workDate: d("2026-11-21") } // a Saturday: not a working day, not "present"
  ];
  const leave = (id: string, code: string, s: string, e: string, startHalf = "FULL", endHalf = "FULL", status = "APPROVED") =>
    world.leaveRequest.push({ id, userId: "emp", leaveTypeId: `type-${code}`, startDate: d(s), endDate: d(e), startHalf, endHalf, status, reason: "Private reason", days: 1, leaveYear: 2026 });
  leave("a", "PL", "2026-11-04", "2026-11-05"); // 2 days
  leave("b", "LOP", "2026-11-06", "2026-11-06", "FIRST_HALF", "FIRST_HALF"); // 0.5
  leave("c", "CO", "2026-11-09", "2026-11-09"); // 1
  leave("d", "PL", "2026-11-18", "2026-11-20"); // 18, (19 holiday), 20 → 2
  leave("e", "PL", "2026-11-10", "2026-11-10", "FULL", "FULL", "PENDING"); // ignored
  leave("f", "PL", "2026-10-30", "2026-11-02"); // Oct 30 outside; Nov 2 inside → 1 (and Nov 2 is leave, not present)
  world.timesheet.push({ userId: "emp", workDate: d("2026-11-03"), totalHours: 8, status: "APPROVED", deletedAt: null });
  world.timesheet.push({ userId: "emp", workDate: d("2026-11-21"), totalHours: 6, status: "SUBMITTED", deletedAt: null });
  world.timesheet.push({ userId: "emp", workDate: d("2026-11-24"), totalHours: 5, status: "REJECTED", deletedAt: null });
  world.compOffRequest.push({ userId: "emp", workDate: d("2026-11-21"), days: 0.5, status: "APPROVED" });
});

// The fake client knows attendanceRecord only once the test adds it.
beforeEach(() => {
  const rows = (world as unknown as { attendanceRecord: Array<Record<string, unknown>> }).attendanceRecord;
  client.attendanceRecord = { findMany: async (args: { where: { userId: { in: string[] }; workDate: { gte: Date; lte: Date } } }) => rows.filter((r) => args.where.userId.in.includes(r.userId as string) && (r.workDate as Date) >= args.where.workDate.gte && (r.workDate as Date) <= args.where.workDate.lte) };
});

describe("monthRange", () => {
  it("knows month lengths and refuses junk", () => {
    expect(svc.monthRange("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(() => svc.monthRange("2026-13")).toThrow();
    expect(() => svc.monthRange("26-11")).toThrow();
  });
});

describe("the monthly report", () => {
  it("counts every column the way payroll reads them", async () => {
    const r = await svc.buildPayrollReport("2026-11", { now: NOW });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({
      workingDays: 20,
      holidays: 1,
      present: 1, // Nov 3 only (Nov 2 is full-day leave, Nov 21 a Saturday)
      leave: { PL: 5, LOP: 0.5, CO: 1 },
      paidLeave: 6,
      unpaidLeave: 0.5,
      compOffTaken: 1,
      compOffEarned: 0.5,
      loggedHours: 14
    });
    // 20 working days − 1 present − 6 full leave days = 13 unpunched days, but one of them (Nov 6) is a
    // half day of LOP: only the other, owed half is absent. 12 + 0.5 = 12.5.
    expect(r.rows[0].absent).toBe(12.5);
  });

  it("flags a month whose leave year has ended or been settled", async () => {
    expect((await svc.buildPayrollReport("2026-11", { now: NOW })).leaveYearClosed).toBe(false);
    expect((await svc.buildPayrollReport("2026-11", { now: new Date("2027-01-02T10:00:00Z") })).leaveYearClosed).toBe(true);
    world.leaveBalanceLedger.push({ userId: "emp", leaveTypeId: "type-PL", leaveYear: 2026, delta: -1, kind: "EXPIRY", idempotencyKey: "EXPIRY:emp:type-PL:2026" });
    expect((await svc.buildPayrollReport("2026-11", { now: NOW })).leaveYearClosed).toBe(true);
  });

  it("judges a closed leave year per person, not off one person's EXPIRY row", async () => {
    addUser(world, { id: "emp2", role: "EMPLOYEE", name: "Bea" });
    world.leaveBalanceLedger.push({ userId: "emp", leaveTypeId: "type-PL", leaveYear: 2026, delta: -1, kind: "EXPIRY", idempotencyKey: "EXPIRY:emp:type-PL:2026" });
    const r = await svc.buildPayrollReport("2026-11", { now: NOW });
    expect(r.rows.find((x) => x.userId === "emp")!.leaveYearClosed).toBe(true);
    expect(r.rows.find((x) => x.userId === "emp2")!.leaveYearClosed).toBe(false);
    // The banner only says "final" when it is final for everyone in the export.
    expect(r.leaveYearClosed).toBe(false);
    const csv = svc.payrollCsv(r).replace("\uFEFF", "").split("\r\n");
    const at = (name: string) => csv.find((l) => l.includes(name))!.split(",").at(-1);
    expect(at("Bea")).toBe("no");
    expect(at("cmd")).toBe("yes");
  });

  it("is refused while Attendance & Leave is off", async () => {
    world.settings.attendanceEnabled = false;
    world.settings.leaveEnabled = false;
    await expect(svc.buildPayrollReport("2026-11", { now: NOW })).rejects.toMatchObject({ statusCode: 403 });
  });

  it("the CSV has a column per type, neutralises formulas and never carries a reason", async () => {
    const csv = svc.payrollCsv(await svc.buildPayrollReport("2026-11", { now: NOW }));
    const [head, row] = csv.replace("﻿", "").split("\r\n");
    expect(head).toContain("Leave CO,Leave LOP (unpaid),Leave PL");
    expect(head).toContain("Unpaid leave (LOP)");
    expect(row).toContain("'=cmd");
    expect(csv).not.toContain("Private reason");
    expect(csv.startsWith("﻿")).toBe(true);
  });
});

describe("the sandwich rule in payroll", () => {
  const sandwichLeave = (id: string, s: string, e: string, days: number) =>
    world.leaveRequest.push({ id, userId: "emp", leaveTypeId: "type-SW", startDate: d(s), endDate: d(e), startHalf: "FULL", endHalf: "FULL", status: "APPROVED", days, leaveYear: 2026 });

  it("has no sandwich column while no type has the rule on", async () => {
    const r = await svc.buildPayrollReport("2026-11", { now: NOW });
    expect(r.sandwichRule).toBeUndefined();
    expect(r.rows[0].sandwichDays).toBeUndefined();
    expect(svc.payrollCsv(r)).not.toContain("Sandwich days");
  });

  it("counts what was debited: the stored days inside the month, enclosed days of a straddling request", async () => {
    addType(world, { code: "SW", isPaid: true, sandwichRule: true });
    sandwichLeave("s1", "2026-11-13", "2026-11-16", 4); // Fri–Mon: 2 working + Sat, Sun debited
    sandwichLeave("s2", "2026-11-27", "2026-12-01", 5); // Fri–Tue: Nov holds Fri, Sat, Sun, Mon
    const r = await svc.buildPayrollReport("2026-11", { now: NOW });
    expect(r.sandwichRule).toBe(true);
    expect(r.rows[0].leave.SW).toBe(8);
    expect(r.rows[0].sandwichDays).toBe(4);
    expect(r.rows[0].paidLeave).toBe(14);
    const csv = svc.payrollCsv(r);
    expect(csv).toContain("Sandwich days");
    // December gets the one remaining working day and no sandwich day.
    const dec = await svc.buildPayrollReport("2026-12", { now: new Date("2027-01-05T10:00:00Z") });
    expect(dec.rows[0].leave.SW).toBe(1);
    expect(dec.rows[0].sandwichDays).toBe(0);
  });

  it("a request stored without sandwich days (rule switched on later) is not inflated", async () => {
    addType(world, { code: "SW", isPaid: true, sandwichRule: true });
    sandwichLeave("s1", "2026-11-13", "2026-11-16", 2);
    const r = await svc.buildPayrollReport("2026-11", { now: NOW });
    expect(r.rows[0].leave.SW).toBe(2);
    expect(r.rows[0].sandwichDays).toBe(0);
  });
});
