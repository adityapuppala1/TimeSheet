/**
 * 7.0.0 leave policies per employment type / site (leave-calc.ts#inPolicyScope, leave.service.ts,
 * the accrual worker, attendance-team.service.ts#loadHolidays / effectiveCalendarId) against the
 * in-memory tenant.
 *
 * Covered: the pure scope rule, an out-of-scope apply and preview refused, types and balances
 * filtered, accrual skipping out-of-scope people, and calendar precedence (own > scoped > default).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addType, addUser, credit, emptyWorld, fakePrisma, type LeaveWorld } from "../helpers/leave-world.js";

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
const { runLeaveAccrual } = await import("../../src/workers/leave-accrual.worker.js");
const team = await import("../../src/services/attendance-team.service.js");

const NOW = new Date("2026-11-23T05:00:00Z");

beforeEach(() => {
  world = emptyWorld();
  client = fakePrisma(world);
  entitlements.leaveManagementEnabled = true;
  addUser(world, { id: "mgr", role: "MANAGER" });
  addUser(world, { id: "ft", managerId: "mgr", employmentType: "FULL_TIME", siteId: "site-blr" });
  addUser(world, { id: "con", managerId: "mgr", employmentType: "CONTRACT", siteId: "site-nyc" });
  addUser(world, { id: "unset", managerId: "mgr" });
  addType(world, { code: "PL", annualQuota: 12, scopeEmploymentTypes: ["FULL_TIME"] });
  addType(world, { code: "CL", annualQuota: 6 });
  addType(world, { code: "BL", annualQuota: 2, scopeSiteIds: ["site-blr"] });
});

describe("pure scope rule", () => {
  it("empty is everyone; each restricted axis must match; an unset value is out", () => {
    expect(calc.inPolicyScope({}, {})).toBe(true);
    expect(calc.inPolicyScope({ scopeEmploymentTypes: [] , scopeSiteIds: null }, { employmentType: "INTERN" })).toBe(true);
    expect(calc.inPolicyScope({ scopeEmploymentTypes: ["FULL_TIME"] }, { employmentType: "FULL_TIME" })).toBe(true);
    expect(calc.inPolicyScope({ scopeEmploymentTypes: ["FULL_TIME"] }, { employmentType: "CONTRACT" })).toBe(false);
    expect(calc.inPolicyScope({ scopeEmploymentTypes: ["FULL_TIME"] }, {})).toBe(false);
    expect(calc.inPolicyScope({ scopeEmploymentTypes: ["FULL_TIME"], scopeSiteIds: ["a"] }, { employmentType: "FULL_TIME", siteId: "b" })).toBe(false);
  });
  it("a site-scoped calendar beats a type-scoped one", () => {
    const cals = [
      { id: "type", name: "A", scopeEmploymentTypes: ["FULL_TIME"] },
      { id: "site", name: "B", scopeSiteIds: ["s"] },
      { id: "plain", name: "C" }
    ];
    expect(calc.pickScopedCalendar(cals, { employmentType: "FULL_TIME", siteId: "s" })?.id).toBe("site");
    expect(calc.pickScopedCalendar(cals, { employmentType: "FULL_TIME" })?.id).toBe("type");
    expect(calc.pickScopedCalendar(cals, {})).toBeNull();
  });
});

describe("leave service", () => {
  it("a person only sees the types in their scope, and only those have a balance", async () => {
    expect((await leave.listLeaveTypes(false, "ft")).map((t) => t.code).sort()).toEqual(["BL", "CL", "PL"]);
    expect((await leave.listLeaveTypes(false, "con")).map((t) => t.code)).toEqual(["CL"]);
    expect((await leave.listLeaveTypes(false)).length).toBe(3);
    expect((await leave.getBalances("unset", { now: NOW })).balances.map((b) => b.leaveType.code)).toEqual(["CL"]);
  });

  it("an out-of-scope apply and preview are refused; in scope goes through", async () => {
    credit(world, "con", "type-PL", 2026, 12);
    await expect(
      leave.applyLeave({ userId: "con", leaveTypeCode: "PL", startDate: "2026-11-25", endDate: "2026-11-25", source: "WEB", actorId: "con", now: NOW })
    ).rejects.toMatchObject({ statusCode: 422, code: "LEAVE_TYPE_OUT_OF_SCOPE" });
    await expect(leave.previewLeave("con", { typeId: "type-PL", start: "2026-11-25", end: "2026-11-25" }, NOW)).rejects.toMatchObject({ statusCode: 422 });
    expect(world.leaveRequest).toHaveLength(0);
    credit(world, "ft", "type-PL", 2026, 12);
    const ok = await leave.applyLeave({ userId: "ft", leaveTypeCode: "PL", startDate: "2026-11-25", endDate: "2026-11-25", source: "WEB", actorId: "ft", now: NOW });
    expect(ok.request.days).toBe(1);
  });
});

describe("accrual", () => {
  it("skips people outside a type's scope", async () => {
    await runLeaveAccrual(NOW);
    const accrued = (user: string, code: string) => world.leaveBalanceLedger.filter((l) => l.userId === user && l.leaveTypeId === `type-${code}`).length;
    expect(accrued("ft", "PL")).toBe(1);
    expect(accrued("ft", "BL")).toBe(1);
    expect(accrued("con", "PL")).toBe(0);
    expect(accrued("con", "BL")).toBe(0);
    expect(accrued("unset", "PL")).toBe(0);
    expect(accrued("con", "CL")).toBe(1);
  });
});

describe("holiday calendar precedence", () => {
  beforeEach(() => {
    world.holidayCalendar.push(
      { id: "cal-default", name: "Default", isDefault: true, scopeEmploymentTypes: null, scopeSiteIds: null },
      { id: "cal-blr", name: "Bengaluru", isDefault: false, scopeEmploymentTypes: null, scopeSiteIds: ["site-blr"] },
      { id: "cal-own", name: "Own", isDefault: false, scopeEmploymentTypes: null, scopeSiteIds: null }
    );
    const day = (calendarId: string, name: string) => ({ id: `h-${calendarId}`, calendarId, date: new Date("2026-11-26T00:00:00Z"), name, isOptional: false });
    world.holiday.push(day("cal-default", "Default day"), day("cal-blr", "Bengaluru day"), day("cal-own", "Own day"));
  });

  it("own calendar, then a site-scoped one, then the default", async () => {
    addUser(world, { id: "blr-own", siteId: "site-blr", holidayCalendarId: "cal-own" });
    const people = world.users.map((u) => ({ id: u.id as string, cal: (u.holidayCalendarId ?? null) as string | null }));
    const holidayOf = await team.loadHolidays(people.map((p) => p.cal), "2026-11-26", "2026-11-26");
    expect(holidayOf(null, "2026-11-26", "ft")?.name).toBe("Bengaluru day");
    expect(holidayOf(null, "2026-11-26", "con")?.name).toBe("Default day");
    expect(holidayOf("cal-own", "2026-11-26", "blr-own")?.name).toBe("Own day");
    expect(await team.effectiveCalendarId(null, "ft")).toBe("cal-blr");
    expect(await team.effectiveCalendarId(null, "con")).toBe("cal-default");
    expect(await team.effectiveCalendarId("cal-own", "blr-own")).toBe("cal-own");
  });

  it("with no scoped calendar the default applies exactly as before", async () => {
    world.holidayCalendar.splice(1, 1);
    const holidayOf = await team.loadHolidays([null], "2026-11-26", "2026-11-26");
    expect(holidayOf(null, "2026-11-26", "ft")?.name).toBe("Default day");
  });
});
