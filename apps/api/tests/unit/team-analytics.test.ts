/**
 * The Team page's figures (`/team/*`), against the shared definitions.
 *
 *   - M14: `/team/reports` loaded every timesheet each report had ever logged, then counted in Node.
 *     It now aggregates in the database over a stated window.
 *   - M4: the SLA summary's "vs yesterday" baselines were subsets of the current value (a delta that
 *     can only go up), "breached" was every entry that had ever breached (from the sweep's stamp),
 *     and "approved this week" counted entries over a rolling 168 hours.
 *   - M1 / M10: the hours trend used UTC's month and counted draft and rejected hours as logged.
 *   - M11: the org chart drew AI agent identities as people.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const MANAGER = "mgr";
const state = vi.hoisted(() => ({ calls: [] as Array<{ op: string; args: any }>, deadlines: [] as any[] }));
const log = (op: string, result: (args: any) => unknown) =>
  vi.fn(async (args: any) => {
    state.calls.push({ op, args });
    return result(args);
  });

vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    user: {
      findMany: log("user.findMany", () => [
        { id: "asha", name: "Asha", email: "asha@x.test", status: "ACTIVE", avatarUrl: null, bio: null, role: { name: "EMPLOYEE" }, managerId: MANAGER, designation: null }
      ]),
      findFirst: log("user.findFirst", () => ({ id: "asha", name: "Asha" }))
    },
    timesheet: {
      findMany: log("timesheet.findMany", () => state.deadlines),
      groupBy: log("timesheet.groupBy", () => []),
      count: log("timesheet.count", () => 0),
      aggregate: log("timesheet.aggregate", () => ({ _sum: { totalHours: 7.5 } }))
    },
    escalation: { count: log("escalation.count", () => 2) }
  }
}));
vi.mock("../../src/middleware/auth.js", () => ({
  requireAuth: (req: any, _res: unknown, next: () => void) => {
    req.user = { id: MANAGER, role: "MANAGER", permissions: ["timesheets:approve"] };
    next();
  },
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next()
}));

let request: typeof import("supertest").default;
let app: import("express").Express;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // 01:00 IST on Thursday 1 October 2026 — still 30 September in UTC.
  vi.setSystemTime(new Date("2026-09-30T19:30:00.000Z"));
  const express = (await import("express")).default;
  const { teamRouter } = await import("../../src/controllers/team.controller.js");
  const { errorHandler } = await import("../../src/middleware/error.js");
  request = (await import("supertest")).default;
  app = express();
  app.use("/team", teamRouter);
  app.use(errorHandler);
}, 60_000);
afterAll(() => vi.useRealTimers());
beforeEach(() => {
  state.calls = [];
  state.deadlines = [];
});
const calls = (op: string) => state.calls.filter((c) => c.op === op);

describe("GET /team/reports", () => {
  it("aggregates in the database over a stated window instead of loading every timesheet ever", async () => {
    const res = await request(app).get("/team/reports").expect(200);
    const roster = calls("user.findMany")[0];
    expect(roster.args.select.timesheets).toBeUndefined();
    const grouped = calls("timesheet.groupBy");
    expect(grouped.length).toBeGreaterThan(0);
    expect(grouped.some((c) => c.args.where.workDate?.gte instanceof Date)).toBe(true);
    expect(res.body[0].stats.windowDays).toBe(90);
  });
});

describe("GET /team/sla-summary", () => {
  it("drops the one-way 'vs yesterday' baselines from point-in-time figures", async () => {
    const res = await request(app).get("/team/sla-summary").expect(200);
    expect(res.body).not.toHaveProperty("submittedYesterday");
    expect(res.body).not.toHaveProperty("openEscalationsYesterday");
  });

  it("reports approved HOURS this week against the same weekdays last week", async () => {
    const res = await request(app).get("/team/sla-summary").expect(200);
    expect(res.body.approvedThisWeek).toBe(7.5);
    const sums = calls("timesheet.aggregate").map((c) => c.args.where.workDate);
    // Monday 28 Sep (IST) to today, and Monday 21 to Thursday 24.
    expect(sums).toEqual(
      expect.arrayContaining([
        { gte: new Date("2026-09-28T00:00:00.000Z"), lte: new Date("2026-10-01T00:00:00.000Z") },
        { gte: new Date("2026-09-21T00:00:00.000Z"), lte: new Date("2026-09-24T00:00:00.000Z") }
      ])
    );
  });

  it("counts today's approval-SLA breaches from the deadline, not from the sweep's stamp", async () => {
    state.deadlines = [
      { approvalDeadline: new Date("2026-09-30T19:00:00.000Z"), reviewedAt: null },
      { approvalDeadline: new Date("2026-09-30T19:00:00.000Z"), reviewedAt: new Date("2026-09-30T18:00:00.000Z") }
    ];
    const res = await request(app).get("/team/sla-summary").expect(200);
    expect(res.body.breached).toBe(1);
    expect(calls("timesheet.count").some((c) => c.args.where.slaBreachAt)).toBe(false);
  });
});

describe("GET /team/reports/:userId/hours-trend", () => {
  it("is this IST month, over logged hours only", async () => {
    const res = await request(app).get("/team/reports/asha/hours-trend").expect(200);
    expect(res.body.currentMonth.monthStart).toBe("2026-10-01");
    const [daily] = calls("timesheet.groupBy");
    expect(daily.args.where.status).toEqual({ in: ["SUBMITTED", "APPROVED"] });
  });
});

describe("GET /team/org-chart", () => {
  it("draws people, not AI agent identities", async () => {
    await request(app).get("/team/org-chart").expect(200);
    expect(calls("user.findMany")[0].args.where.isAgent).toBe(false);
  });
});

describe("who is on the team (M11)", () => {
  it("lists people only — an AI agent owned by the manager is not a direct report", async () => {
    await request(app).get("/team/reports").expect(200);
    expect(calls("user.findMany")[0].args.where).toMatchObject({ managerId: MANAGER, isAgent: false });
    state.calls = [];
    await request(app).get("/team/sla-summary").expect(200);
    expect(calls("user.findMany")[0].args.where).toMatchObject({ managerId: MANAGER, isAgent: false });
  });
});
