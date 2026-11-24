/**
 * 7.0.0 comp-off (services/comp-off.service.ts) against the in-memory tenant (tests/helpers/leave-world.ts),
 * which enforces the ledger's unique idempotency key and serialises / rolls back transactions.
 *
 * Covered: the gate (leave AND compOffEnabled), eligibility by the day resolver (weekend, holiday,
 * working day refused), the hour thresholds, duplicates, decision rights (manager / IDOR 403 / self),
 * the ledger credit and its idempotency, the double-approve race, the webhook payload, expiry
 * (keyed, never below zero), and that turning it off changes nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addType, addUser, balanceOf, credit, emptyWorld, fakePrisma, type LeaveWorld } from "../helpers/leave-world.js";

let world: LeaveWorld = emptyWorld();
const entitlements: Record<string, boolean> = { leaveManagementEnabled: true };
const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
const notifications: Array<{ userId: string; category: string; title: string }> = [];
const audits: Array<{ action: string; meta: Record<string, unknown> }> = [];

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
  audit: async (_a: string | undefined, action: string, _e: string, _id?: string, meta?: Record<string, unknown>) => {
    audits.push({ action, meta: meta ?? {} });
  }
}));
vi.mock("../../src/services/domain-events.js", () => ({
  emitDomainEvent: (event: string, payload: Record<string, unknown>) => events.push({ event, payload })
}));
vi.mock("../../src/services/notify.service.js", () => ({
  dispatchNotification: async (args: { userId: string; category: string; title: string }) => {
    notifications.push({ userId: args.userId, category: args.category, title: args.title });
  }
}));

const svc = await import("../../src/services/comp-off.service.js");

// Monday 2026-11-23. Saturday 2026-11-21 and Sunday 2026-11-22 are the weekend before.
const NOW = new Date("2026-11-23T10:00:00Z");
const SAT = "2026-11-21";
const actor = (id: string) => ({ id, role: world.users.find((u) => u.id === id)!.role.name, name: id });

function log(userId: string, date: string, hours: number, status = "SUBMITTED") {
  world.timesheet.push({ id: `ts-${world.timesheet.length}`, userId, workDate: new Date(`${date}T00:00:00.000Z`), totalHours: hours, status, deletedAt: null });
}

beforeEach(() => {
  world = emptyWorld();
  client = fakePrisma(world);
  events.length = 0;
  notifications.length = 0;
  audits.length = 0;
  entitlements.leaveManagementEnabled = true;
  addUser(world, { id: "super", role: "SUPER_ADMIN" });
  addUser(world, { id: "mgr", role: "MANAGER" });
  addUser(world, { id: "other-mgr", role: "MANAGER" });
  addUser(world, { id: "emp", role: "EMPLOYEE", managerId: "mgr" });
  addType(world, { code: "CO", annualQuota: 0 });
});

describe("compOffDaysFor (pure)", () => {
  it("maps hours to 0, a half or a full day", () => {
    expect(svc.compOffDaysFor(3.9, 4, 8)).toBe(0);
    expect(svc.compOffDaysFor(4, 4, 8)).toBe(0.5);
    expect(svc.compOffDaysFor(7.99, 4, 8)).toBe(0.5);
    expect(svc.compOffDaysFor(8, 4, 8)).toBe(1);
  });
});

describe("gate", () => {
  it("is refused while comp-off is off, and while leave is off, and without the plan", async () => {
    log("emp", SAT, 8);
    world.settings.compOffEnabled = false;
    await expect(svc.requestCompOff({ userId: "emp", workDate: SAT, now: NOW })).rejects.toMatchObject({ statusCode: 403 });
    world.settings.compOffEnabled = true;
    world.settings.leaveEnabled = false;
    await expect(svc.requestCompOff({ userId: "emp", workDate: SAT, now: NOW })).rejects.toMatchObject({ statusCode: 403 });
    world.settings.leaveEnabled = true;
    entitlements.leaveManagementEnabled = false;
    await expect(svc.requestCompOff({ userId: "emp", workDate: SAT, now: NOW })).rejects.toMatchObject({ statusCode: 403 });
    expect(world.compOffRequest).toHaveLength(0);
    expect(await svc.isCompOffOn()).toBe(false);
  });
});

describe("eligibility (per the day resolver)", () => {
  it("a weekend with 8h is a full day, with 5h a half day, with 3h nothing", async () => {
    log("emp", SAT, 5);
    log("emp", SAT, 3);
    expect(await svc.compOffEligibility("emp", SAT, NOW)).toMatchObject({ eligible: true, dayKind: "WEEKEND", hoursLogged: 8, days: 1 });
    log("emp", "2026-11-22", 5);
    expect(await svc.compOffEligibility("emp", "2026-11-22", NOW)).toMatchObject({ eligible: true, days: 0.5 });
    log("emp", "2026-11-15", 3);
    expect((await svc.compOffEligibility("emp", "2026-11-15", NOW)).eligible).toBe(false);
  });

  it("rejected and deleted timesheet hours do not count", async () => {
    log("emp", SAT, 8, "REJECTED");
    world.timesheet.push({ id: "gone", userId: "emp", workDate: new Date(`${SAT}T00:00:00.000Z`), totalHours: 8, status: "SUBMITTED", deletedAt: new Date() });
    expect(await svc.compOffEligibility("emp", SAT, NOW)).toMatchObject({ eligible: false, hoursLogged: 0 });
  });

  it("a holiday in the person's calendar counts; a normal working day does not", async () => {
    world.holidayCalendar.push({ id: "cal", isDefault: true });
    world.holiday.push({ id: "h1", calendarId: "cal", date: new Date("2026-11-19T00:00:00.000Z"), name: "Founders day", isOptional: false });
    log("emp", "2026-11-19", 9);
    log("emp", "2026-11-18", 9);
    expect(await svc.compOffEligibility("emp", "2026-11-19", NOW)).toMatchObject({ eligible: true, dayKind: "HOLIDAY", holidayName: "Founders day" });
    expect(await svc.compOffEligibility("emp", "2026-11-18", NOW)).toMatchObject({ eligible: false, dayKind: null });
  });

  it("the thresholds are configurable", async () => {
    world.settings.compOffHalfDayHours = 2;
    world.settings.compOffFullDayHours = 6;
    log("emp", SAT, 6);
    expect((await svc.compOffEligibility("emp", SAT, NOW)).days).toBe(1);
  });

  it("a future day and a request for an ineligible day are refused (422, nothing written)", async () => {
    expect((await svc.compOffEligibility("emp", "2026-11-28", NOW)).eligible).toBe(false);
    await expect(svc.requestCompOff({ userId: "emp", workDate: "2026-11-18", now: NOW })).rejects.toMatchObject({ statusCode: 422, code: "COMPOFF_NOT_ELIGIBLE" });
    expect(world.compOffRequest).toHaveLength(0);
  });
});

describe("request and decide", () => {
  beforeEach(() => log("emp", SAT, 8));

  it("one open request per day; days come from the server", async () => {
    const r = await svc.requestCompOff({ userId: "emp", workDate: SAT, reason: "release", now: NOW });
    expect(r).toMatchObject({ status: "PENDING", days: 1, approverId: "mgr", dayKind: "WEEKEND" });
    await expect(svc.requestCompOff({ userId: "emp", workDate: SAT, now: NOW })).rejects.toMatchObject({ statusCode: 409, code: "COMPOFF_DUPLICATE" });
    expect(events.map((e) => e.event)).toEqual(["compoff.requested"]);
    expect(notifications).toEqual([expect.objectContaining({ userId: "mgr", category: "leave.requested" })]);
  });

  it("the manager approves: the CO type is credited once, keyed, in the approval date's leave year", async () => {
    const r = await svc.requestCompOff({ userId: "emp", workDate: SAT, now: NOW });
    const done = await svc.decideCompOff({ actor: actor("mgr"), requestId: r.id, decision: "APPROVE", now: NOW });
    expect(done.status).toBe("APPROVED");
    expect(balanceOf(world, "emp", "type-CO", 2026)).toBe(1);
    expect(world.leaveBalanceLedger.filter((l) => l.idempotencyKey === `COMPOFF:${r.id}`)).toHaveLength(1);
    const hook = events.find((e) => e.event === "compoff.approved")!;
    expect(hook.payload).toMatchObject({ workDate: SAT, days: 1, leaveType: "CO" });
    expect(JSON.stringify(hook.payload)).not.toContain("reason");
    expect(notifications.at(-1)).toMatchObject({ userId: "emp", category: "leave.decided" });
  });

  it("two racing approvals credit exactly once", async () => {
    const r = await svc.requestCompOff({ userId: "emp", workDate: SAT, now: NOW });
    const results = await Promise.allSettled([
      svc.decideCompOff({ actor: actor("mgr"), requestId: r.id, decision: "APPROVE", now: NOW }),
      svc.decideCompOff({ actor: actor("mgr"), requestId: r.id, decision: "APPROVE", now: NOW }),
      svc.decideCompOff({ actor: actor("super"), requestId: r.id, decision: "APPROVE", now: NOW })
    ]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(balanceOf(world, "emp", "type-CO", 2026)).toBe(1);
  });

  it("the idempotency key alone stops a second credit (the status guard bypassed)", async () => {
    const r = await svc.requestCompOff({ userId: "emp", workDate: SAT, now: NOW });
    await svc.decideCompOff({ actor: actor("mgr"), requestId: r.id, decision: "APPROVE", now: NOW });
    world.compOffRequest[0].status = "PENDING";
    await expect(svc.decideCompOff({ actor: actor("mgr"), requestId: r.id, decision: "APPROVE", now: NOW })).rejects.toMatchObject({ code: "P2002" });
    expect(balanceOf(world, "emp", "type-CO", 2026)).toBe(1);
    // ...and the failed transaction rolled its status change back.
    expect(world.compOffRequest[0].status).toBe("PENDING");
  });

  it("someone else's manager and an unknown id get the same 403; nobody decides their own", async () => {
    const r = await svc.requestCompOff({ userId: "emp", workDate: SAT, now: NOW });
    await expect(svc.decideCompOff({ actor: actor("other-mgr"), requestId: r.id, decision: "APPROVE", now: NOW })).rejects.toMatchObject({ statusCode: 403 });
    await expect(svc.decideCompOff({ actor: actor("other-mgr"), requestId: "nope", decision: "APPROVE", now: NOW })).rejects.toMatchObject({ statusCode: 403 });
    await expect(svc.decideCompOff({ actor: actor("emp"), requestId: r.id, decision: "APPROVE", now: NOW })).rejects.toMatchObject({ statusCode: 403 });
    expect(world.leaveBalanceLedger).toHaveLength(0);
  });

  it("the inbox lists it for the manager only, and a rejection credits nothing", async () => {
    const r = await svc.requestCompOff({ userId: "emp", workDate: SAT, now: NOW });
    expect((await svc.listCompOffInbox(actor("mgr"), NOW)).total).toBe(1);
    expect((await svc.listCompOffInbox(actor("other-mgr"), NOW)).total).toBe(0);
    await svc.decideCompOff({ actor: actor("mgr"), requestId: r.id, decision: "REJECT", note: "not agreed", now: NOW });
    expect(world.leaveBalanceLedger).toHaveLength(0);
    // A rejected day can be asked for again.
    await expect(svc.requestCompOff({ userId: "emp", workDate: SAT, now: NOW })).resolves.toMatchObject({ status: "PENDING" });
  });

  it("the requester can cancel only while pending", async () => {
    const r = await svc.requestCompOff({ userId: "emp", workDate: SAT, now: NOW });
    await expect(svc.cancelCompOff("mgr", r.id, NOW)).rejects.toMatchObject({ statusCode: 404 });
    expect((await svc.cancelCompOff("emp", r.id, NOW)).status).toBe("CANCELLED");
    await expect(svc.cancelCompOff("emp", r.id, NOW)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("approval refuses when the configured type does not exist", async () => {
    world.settings.compOffLeaveTypeCode = "NOPE";
    const r = await svc.requestCompOff({ userId: "emp", workDate: SAT, now: NOW });
    await expect(svc.decideCompOff({ actor: actor("mgr"), requestId: r.id, decision: "APPROVE", now: NOW })).rejects.toMatchObject({ code: "COMPOFF_TYPE_MISSING" });
    expect(world.compOffRequest[0].status).toBe("PENDING");
  });
});

describe("expiry", () => {
  beforeEach(() => log("emp", SAT, 8));

  it("expires an unspent credit once, keyed, and never below zero", async () => {
    world.settings.compOffExpiryDays = 30;
    const r = await svc.requestCompOff({ userId: "emp", workDate: SAT, now: NOW });
    const done = await svc.decideCompOff({ actor: actor("mgr"), requestId: r.id, decision: "APPROVE", now: NOW });
    expect(done.expiresOn).toBe("2026-12-23");
    expect(await svc.expireCompOffCredits(new Date("2026-12-22T12:00:00Z"))).toBe(0);
    const later = new Date("2026-12-24T12:00:00Z");
    expect(await svc.expireCompOffCredits(later)).toBe(1);
    expect(await svc.expireCompOffCredits(later)).toBe(0);
    expect(balanceOf(world, "emp", "type-CO", 2026)).toBe(0);
  });

  it("a credit already spent is not clawed back", async () => {
    world.settings.compOffExpiryDays = 1;
    const r = await svc.requestCompOff({ userId: "emp", workDate: SAT, now: NOW });
    await svc.decideCompOff({ actor: actor("mgr"), requestId: r.id, decision: "APPROVE", now: NOW });
    world.leaveBalanceLedger.push({ id: "spent", userId: "emp", leaveTypeId: "type-CO", leaveYear: 2026, delta: -1, kind: "DEBIT", idempotencyKey: "DEBIT:x" });
    await svc.expireCompOffCredits(new Date("2026-12-01T12:00:00Z"));
    expect(balanceOf(world, "emp", "type-CO", 2026)).toBe(0);
    expect(world.compOffRequest[0].expiredAt).toBeInstanceOf(Date);
  });

  it("no expiry configured: nothing expires", async () => {
    const r = await svc.requestCompOff({ userId: "emp", workDate: SAT, now: NOW });
    await svc.decideCompOff({ actor: actor("mgr"), requestId: r.id, decision: "APPROVE", now: NOW });
    expect(await svc.expireCompOffCredits(new Date("2030-01-01T12:00:00Z"))).toBe(0);
    expect(balanceOf(world, "emp", "type-CO", 2026)).toBe(1);
  });
});

describe("a credit across the leave-year rollover", () => {
  // 2026-12-27 is a Sunday. 2026 is closed (EXPIRY row) before the approval on 2027-01-10.
  const LATE = "2026-12-27";
  const settle2026 = () => credit(world, "emp", "type-CO", 2026, 0, "EXPIRY", "EXPIRY:emp:type-CO:2026");

  it("work in December approved after the rollover credits the approval date's year and expires there", async () => {
    world.settings.compOffExpiryDays = 30;
    log("emp", LATE, 8);
    const r = await svc.requestCompOff({ userId: "emp", workDate: LATE, now: new Date("2026-12-28T10:00:00Z") });
    settle2026();
    const approvedAt = new Date("2027-01-10T10:00:00Z");
    const done = await svc.decideCompOff({ actor: actor("mgr"), requestId: r.id, decision: "APPROVE", now: approvedAt });
    expect(done.leaveYear).toBe(2027);
    expect(balanceOf(world, "emp", "type-CO", 2027)).toBe(1);
    expect(balanceOf(world, "emp", "type-CO", 2026)).toBe(0);
    expect(world.leaveBalanceLedger.filter((l) => l.idempotencyKey === `COMPOFF:${r.id}`)).toHaveLength(1);
    expect(await svc.expireCompOffCredits(new Date("2027-02-10T12:00:00Z"))).toBe(1);
    expect(balanceOf(world, "emp", "type-CO", 2027)).toBe(0);
  });

  it("a credit carried into the next year by the rollover is expired from the year it now sits in", async () => {
    world.settings.compOffExpiryDays = 60;
    world.leaveType[0].carryForwardMax = 10;
    log("emp", SAT, 8);
    const r = await svc.requestCompOff({ userId: "emp", workDate: SAT, now: NOW });
    await svc.decideCompOff({ actor: actor("mgr"), requestId: r.id, decision: "APPROVE", now: NOW });
    // The rollover closes 2026 and carries the 1 day into 2027.
    credit(world, "emp", "type-CO", 2026, -1, "EXPIRY", "EXPIRY:emp:type-CO:2026");
    credit(world, "emp", "type-CO", 2027, 1, "CARRY_FORWARD", "CARRY:emp:type-CO:2027");
    expect(await svc.expireCompOffCredits(new Date("2027-01-25T12:00:00Z"))).toBe(1);
    expect(balanceOf(world, "emp", "type-CO", 2027)).toBe(0);
    expect(balanceOf(world, "emp", "type-CO", 2026)).toBe(0);
  });
});
