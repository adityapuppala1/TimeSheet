/**
 * 7.0.0 regularisation (services/attendance-regularization.service.ts) against the in-memory tenant
 * (tests/helpers/leave-world.ts), which serialises and rolls back transactions.
 *
 * Covered: the gate (attendance AND regularizationEnabled), days back, the monthly cap (including two
 * requests racing for the last slot), the punch-pair rules, IDOR on decide and cancel, delegation,
 * the double-approve race (exactly one ingest), the write through ingestPunch as REGULARIZATION, and
 * that the reason reaches only the requester and the people who may decide.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addUser, emptyWorld, fakePrisma, type LeaveWorld } from "../helpers/leave-world.js";

let world: LeaveWorld = emptyWorld();
const entitlements: Record<string, boolean> = { attendanceEnabled: true };
const notifications: Array<{ userId: string; title: string; body: string }> = [];
const audits: Array<{ action: string; meta: Record<string, unknown> }> = [];
const ingests: Array<Record<string, unknown>> = [];
const records: Array<Record<string, any>> = [];

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
vi.mock("../../src/services/notify.service.js", () => ({
  dispatchNotification: async (args: { userId: string; title: string; body: string }) => {
    notifications.push({ userId: args.userId, title: args.title, body: args.body });
  }
}));
// The ingest itself (REGULARIZATION outranks everything, keeps the old punch) is pinned in
// attendance-ingest.test.ts; here it is the single write the approval makes.
vi.mock("../../src/services/attendance-ingest.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/attendance-ingest.service.js")>()),
  ingestPunch: async (input: Record<string, unknown>) => {
    await new Promise((r) => setTimeout(r, 5));
    const dup = ingests.some((i) => i.externalRef === input.externalRef);
    ingests.push(input);
    return { eventId: `ev-${ingests.length}`, status: dup ? "DUPLICATE" : "ACCEPTED", reason: null, recordId: "rec-1", created: false };
  }
}));

const svc = await import("../../src/services/attendance-regularization.service.js");

// Monday 2026-11-23, 10:00 UTC. Everyone is in UTC.
const NOW = new Date("2026-11-23T10:00:00Z");
const FRI = "2026-11-20";
const body = (over: Partial<{ workDate: string; punchInAt: string; punchOutAt: string | null; reason: string }> = {}) => ({
  userId: "emp",
  workDate: FRI,
  punchInAt: `${over.workDate ?? FRI}T09:00:00Z`,
  punchOutAt: `${over.workDate ?? FRI}T17:30:00Z`,
  reason: "Badge reader was down at the front door",
  now: NOW,
  ...over
});
const actor = (id: string) => ({ id, role: world.users.find((u) => u.id === id)!.role.name });

beforeEach(() => {
  world = emptyWorld();
  client = fakePrisma(world);
  records.length = 0;
  client.attendanceRecord = {
    findUnique: async (args: { where: { userId_workDate: { userId: string; workDate: Date } } }) =>
      records.find((r) => r.userId === args.where.userId_workDate.userId && +r.workDate === +args.where.userId_workDate.workDate) ?? null
  };
  Object.assign(world.settings, { attendanceEnabled: true, regularizationEnabled: true, regularizationMaxDaysBack: 7, regularizationMonthlyCap: 3 });
  entitlements.attendanceEnabled = true;
  notifications.length = 0;
  audits.length = 0;
  ingests.length = 0;
  addUser(world, { id: "super", role: "SUPER_ADMIN" });
  addUser(world, { id: "mgr", role: "MANAGER" });
  addUser(world, { id: "other-mgr", role: "MANAGER" });
  addUser(world, { id: "peer", role: "EMPLOYEE", managerId: "mgr" });
  addUser(world, { id: "emp", role: "EMPLOYEE", managerId: "mgr" });
});

describe("pure rules", () => {
  it("days back: past days only, within the window", () => {
    expect(svc.daysBackProblem("2026-11-23", "2026-11-23", 7)).toMatch(/past days/);
    expect(svc.daysBackProblem("2026-11-24", "2026-11-23", 7)).toMatch(/past days/);
    expect(svc.daysBackProblem("2026-11-16", "2026-11-23", 7)).toBeNull();
    expect(svc.daysBackProblem("2026-11-15", "2026-11-23", 7)).toMatch(/7 day/);
  });
  it("punch pair: out after in, at most 24h, not in the future", () => {
    const at = (s: string) => new Date(s);
    expect(svc.punchPairProblem(at("2026-11-20T09:00:00Z"), at("2026-11-20T09:00:00Z"), true, NOW)).toMatch(/after/);
    expect(svc.punchPairProblem(at("2026-11-20T09:00:00Z"), at("2026-11-21T09:01:00Z"), true, NOW)).toMatch(/24 hours/);
    expect(svc.punchPairProblem(at("2026-11-23T09:00:00Z"), at("2026-11-23T12:00:00Z"), true, NOW)).toMatch(/hasn't happened/);
    expect(svc.punchPairProblem(at("2026-11-20T09:00:00Z"), null, true, NOW)).toMatch(/timezone/);
    expect(svc.punchPairProblem(at("2026-11-20T09:00:00Z"), null, false, NOW)).toBeNull();
  });
  it("month bounds roll over December", () => {
    expect(svc.monthBounds("2026-12-31").lt.toISOString().slice(0, 10)).toBe("2027-01-01");
    expect(svc.monthBounds("2026-02-03").gte.toISOString().slice(0, 10)).toBe("2026-02-01");
  });
});

describe("gate", () => {
  it("refuses everything while corrections are off (the default) or attendance is off", async () => {
    world.settings.regularizationEnabled = false;
    await expect(svc.requestRegularization(body())).rejects.toMatchObject({ statusCode: 403 });
    await expect(svc.listRegularizationInbox(actor("mgr"))).rejects.toMatchObject({ statusCode: 403 });
    expect(await svc.isRegularizationOn()).toBe(false);
    world.settings.regularizationEnabled = true;
    entitlements.attendanceEnabled = false;
    await expect(svc.requestRegularization(body())).rejects.toMatchObject({ statusCode: 403 });
    expect(world.attendanceRegularizationRequest).toHaveLength(0);
  });
});

describe("requesting", () => {
  it("records the request with the punch it replaces and notifies the manager without the reason", async () => {
    records.push({ userId: "emp", workDate: new Date(`${FRI}T00:00:00Z`), punchInAt: new Date(`${FRI}T11:00:00Z`), punchOutAt: null });
    const r = await svc.requestRegularization(body());
    expect(r).toMatchObject({ status: "PENDING", approverId: "mgr", originalPunchInAt: `${FRI}T11:00:00.000Z`, reason: expect.stringContaining("Badge") });
    expect(notifications.map((n) => n.userId)).toEqual(["mgr"]);
    expect(JSON.stringify(notifications)).not.toContain("Badge");
    expect(JSON.stringify(audits)).not.toContain("Badge");
  });

  it("refuses today, the future, and days beyond the window", async () => {
    await expect(svc.requestRegularization(body({ workDate: "2026-11-23" }))).rejects.toMatchObject({ statusCode: 422 });
    await expect(svc.requestRegularization(body({ workDate: "2026-11-15" }))).rejects.toMatchObject({ statusCode: 422 });
    world.settings.regularizationMaxDaysBack = 10;
    await expect(svc.requestRegularization(body({ workDate: "2026-11-16" }))).resolves.toMatchObject({ status: "PENDING" });
  });

  it("refuses a punch-in that falls on another day, and an un-zoned time", async () => {
    await expect(svc.requestRegularization(body({ punchInAt: "2026-11-19T09:00:00Z" }))).rejects.toMatchObject({ statusCode: 422 });
    await expect(svc.requestRegularization(body({ punchInAt: "2026-11-20T09:00" }))).rejects.toMatchObject({ statusCode: 422 });
  });

  it("one pending request per day", async () => {
    await svc.requestRegularization(body());
    await expect(svc.requestRegularization(body())).rejects.toMatchObject({ statusCode: 409 });
  });

  it("enforces the monthly cap on pending + approved, counted by the corrected day's month", async () => {
    world.settings.regularizationMaxDaysBack = 30;
    for (const d of ["2026-11-17", "2026-11-18", "2026-11-19"]) await svc.requestRegularization(body({ workDate: d }));
    await expect(svc.requestRegularization(body({ workDate: FRI }))).rejects.toMatchObject({ statusCode: 422, message: expect.stringMatching(/up to 3/) });
    // A cancelled one frees its slot; a day in October counts against October.
    await svc.cancelRegularization("emp", world.attendanceRegularizationRequest[0].id, NOW);
    await expect(svc.requestRegularization(body({ workDate: FRI }))).resolves.toMatchObject({ status: "PENDING" });
    await expect(svc.requestRegularization(body({ workDate: "2026-10-30" }))).resolves.toMatchObject({ status: "PENDING" });
  });

  it("two requests racing for the last slot: exactly one gets it", async () => {
    world.settings.regularizationMonthlyCap = 1;
    const results = await Promise.allSettled([svc.requestRegularization(body({ workDate: "2026-11-19" })), svc.requestRegularization(body({ workDate: FRI }))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(world.attendanceRegularizationRequest).toHaveLength(1);
  });
});

describe("deciding", () => {
  it("the manager approves: one write through ingestPunch as REGULARIZATION, keyed by the request", async () => {
    const r = await svc.requestRegularization(body());
    const decided = await svc.decideRegularization({ actor: actor("mgr"), requestId: r.id, decision: "APPROVE", now: NOW });
    expect(decided.status).toBe("APPROVED");
    expect(ingests).toHaveLength(1);
    expect(ingests[0]).toMatchObject({ kind: "REGULARIZATION", userId: "emp", externalRef: `REG:${r.id}` });
    expect(world.attendanceRegularizationRequest[0].eventId).toBe("ev-1");
    expect(notifications.at(-1)).toMatchObject({ userId: "emp", title: expect.stringMatching(/approved/) });
  });

  it("IDOR: another manager, a peer and the requester get the same 403 as an unknown id", async () => {
    const r = await svc.requestRegularization(body());
    for (const who of ["other-mgr", "peer", "emp"]) {
      await expect(svc.decideRegularization({ actor: actor(who), requestId: r.id, decision: "APPROVE", now: NOW })).rejects.toMatchObject({ statusCode: 403 });
    }
    await expect(svc.decideRegularization({ actor: actor("mgr"), requestId: "nope", decision: "APPROVE", now: NOW })).rejects.toMatchObject({ statusCode: 403 });
    expect(ingests).toHaveLength(0);
    // Cancel is the requester's alone: someone else's id is "not found".
    await expect(svc.cancelRegularization("peer", r.id, NOW)).rejects.toMatchObject({ statusCode: 404 });
    expect(world.attendanceRegularizationRequest[0].status).toBe("PENDING");
  });

  it("race: two approvals at once write the day exactly once", async () => {
    const r = await svc.requestRegularization(body());
    world.approvalDelegation.push({ id: "d1", delegatorId: "mgr", delegateId: "other-mgr", startDate: new Date("2026-11-01T00:00:00Z"), endDate: new Date("2026-11-30T00:00:00Z"), revokedAt: null });
    const results = await Promise.allSettled([
      svc.decideRegularization({ actor: actor("mgr"), requestId: r.id, decision: "APPROVE", now: NOW }),
      svc.decideRegularization({ actor: actor("other-mgr"), requestId: r.id, decision: "APPROVE", now: NOW })
    ]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(results.find((x) => x.status === "rejected")).toMatchObject({ reason: { statusCode: 409 } });
    expect(ingests).toHaveLength(1);
  });

  it("an active delegate decides on the manager's behalf", async () => {
    world.approvalDelegation.push({ id: "d1", delegatorId: "mgr", delegateId: "other-mgr", startDate: new Date("2026-11-01T00:00:00Z"), endDate: new Date("2026-11-30T00:00:00Z"), revokedAt: null });
    const r = await svc.requestRegularization(body());
    expect((await svc.listRegularizationInbox(actor("other-mgr"), NOW)).total).toBe(1);
    const d = await svc.decideRegularization({ actor: actor("other-mgr"), requestId: r.id, decision: "REJECT", note: "Please talk to me", now: NOW });
    expect(d).toMatchObject({ status: "REJECTED", onBehalfOfId: "mgr" });
    expect(ingests).toHaveLength(0);
  });

  it("a rejection needs a note", () => {
    expect(svc.regularizationDecisionBody.safeParse({ decision: "REJECT" }).success).toBe(false);
  });
});

describe("the reason is for the requester and the deciders only", () => {
  it("the manager's inbox has it; another manager's and a peer's inbox do not contain the request at all", async () => {
    await svc.requestRegularization(body());
    const mine = await svc.listRegularizationInbox(actor("mgr"), NOW);
    expect(mine.items[0].reason).toMatch(/Badge/);
    for (const who of ["other-mgr", "peer"]) {
      const theirs = await svc.listRegularizationInbox(actor(who), NOW);
      expect(theirs.total).toBe(0);
      expect(JSON.stringify(theirs)).not.toContain("Badge");
    }
    // A super admin may override, but it is not waiting on them, so it is not listed either.
    expect((await svc.listRegularizationInbox(actor("super"), NOW)).total).toBe(0);
  });

  it("publicRegularization drops the reason and the decision note for any other view", async () => {
    await svc.requestRegularization(body());
    const row = { ...world.attendanceRegularizationRequest[0], decisionNote: "private note" };
    const shown = svc.publicRegularization(row as never, { withReason: false });
    expect(shown.reason).toBeNull();
    expect(shown.decisionNote).toBeNull();
  });

  it("the 403 for a non-approver never echoes the reason", async () => {
    const r = await svc.requestRegularization(body());
    const err = await svc.decideRegularization({ actor: actor("peer"), requestId: r.id, decision: "APPROVE", now: NOW }).catch((e) => e);
    expect(String(err.message)).not.toContain("Badge");
  });
});
