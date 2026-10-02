/**
 * `GET /reports/ticket-insights`, `/reports/ticket-summary` and `/reports/leaderboard` — the route
 * half of the ticket analytics: which rows they read, and that the shared definitions reach the page.
 *
 *   - M14: the insights route loaded the ENTIRE status-change audit log and every assigned ticket
 *     ever, then filtered assignees × tickets; the leaderboard loaded every resolved ticket of all
 *     time. Each read is now bounded to the window the figure covers.
 *   - M11: AI agent identities were ranked and charted as people.
 *   - M6: "Ticket SLA breaches" read `slaBreachAt`, which only the optional sweep writes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  calls: [] as Array<{ model: string; op: string; args: any }>,
  audits: [] as any[],
  tickets: [] as any[],
  comments: [] as any[]
}));

function record(model: string, op: string, result: (args: any) => unknown) {
  return vi.fn(async (args: any) => {
    state.calls.push({ model, op, args });
    return result(args);
  });
}

vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    ticket: {
      findMany: record("ticket", "findMany", (args) => (args?.where?.reporterId === undefined && args?.select?.reporterId ? state.tickets : [])),
      groupBy: record("ticket", "groupBy", () => []),
      count: record("ticket", "count", () => 0)
    },
    auditLog: { findMany: record("auditLog", "findMany", () => state.audits) },
    ticketComment: { findMany: record("ticketComment", "findMany", () => state.comments) },
    projectModule: { findMany: record("projectModule", "findMany", () => []) },
    timesheet: { findMany: record("timesheet", "findMany", () => []), groupBy: record("timesheet", "groupBy", () => []) },
    user: { findMany: record("user", "findMany", () => []) },
    globalTicketSettings: { findUnique: vi.fn(async () => ({ id: "global", enableLeaderboard: true, enableCostAnalytics: false })) }
  }
}));
vi.mock("../../src/middleware/auth.js", () => ({
  requireAuth: (req: any, _res: unknown, next: () => void) => {
    req.user = { id: "u1", permissions: ["reports:view"] };
    next();
  },
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next()
}));

let request: typeof import("supertest").default;
let app: import("express").Express;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // Thursday 1 October 2026, 10:00 IST.
  vi.setSystemTime(new Date("2026-10-01T04:30:00.000Z"));
  const express = (await import("express")).default;
  const { reportRouter } = await import("../../src/controllers/report.controller.js");
  const { errorHandler } = await import("../../src/middleware/error.js");
  request = (await import("supertest")).default;
  app = express();
  app.use("/reports", reportRouter);
  app.use(errorHandler);
}, 60_000);
afterAll(() => vi.useRealTimers());

beforeEach(() => {
  state.calls = [];
  state.audits = [];
  state.tickets = [];
  state.comments = [];
});

const callsTo = (model: string, op: string) => state.calls.filter((c) => c.model === model && c.op === op);

describe("GET /reports/ticket-insights", () => {
  it("reads the status-change log for the window only, not all of it", async () => {
    await request(app).get("/reports/ticket-insights").expect(200);
    const [audit] = callsTo("auditLog", "findMany");
    expect(audit.args.where.createdAt?.gte).toBeInstanceOf(Date);
  });

  it("never lets the reopen rate pass 100%", async () => {
    const at = (iso: string) => new Date(iso);
    state.audits = [
      { entityId: "a", metadata: { to: "RESOLVED" }, createdAt: at("2026-09-20T00:00:00Z") },
      { entityId: "b", metadata: { to: "REOPENED" }, createdAt: at("2026-09-21T00:00:00Z") },
      { entityId: "c", metadata: { to: "REOPENED" }, createdAt: at("2026-09-22T00:00:00Z") }
    ];
    const res = await request(app).get("/reports/ticket-insights").expect(200);
    expect(res.body.reopenRate.pct).toBe(0);
  });

  it("charts only people in the workload heatmap, and only tickets open during its weeks", async () => {
    await request(app).get("/reports/ticket-insights").expect(200);
    const assigned = callsTo("ticket", "findMany").find((c) => c.args.where?.assigneeId);
    expect(assigned?.args.where.assignee).toEqual({ isAgent: false });
    expect(assigned?.args.where.createdAt?.lt).toBeInstanceOf(Date);
    expect(assigned?.args.where.OR).toEqual([{ resolvedAt: null }, { resolvedAt: { gte: expect.any(Date) } }]);
  });

  it("reports the median first response with its sample size and the unanswered count", async () => {
    const created = new Date("2026-09-28T00:00:00.000Z");
    state.tickets = [{ id: "t1", reporterId: "rep", createdAt: created }, { id: "t2", reporterId: "rep", createdAt: created }];
    state.comments = [
      { ticketId: "t1", authorId: "rep", createdAt: new Date(created.getTime() + 3_600_000), author: { email: "rep@acme.test", isAgent: false } },
      { ticketId: "t1", authorId: "eng", createdAt: new Date(created.getTime() + 4 * 3_600_000), author: { email: "eng@acme.test", isAgent: false } }
    ];
    const res = await request(app).get("/reports/ticket-insights").expect(200);
    expect(res.body.firstResponseHours).toMatchObject({ medianHours: 4, sampleSize: 1, unanswered: 1 });
  });
});

describe("GET /reports/ticket-summary", () => {
  it("counts SLA breaches from the due date, not from the sweep's stamp", async () => {
    await request(app).get("/reports/ticket-summary").expect(200);
    const breachCount = callsTo("ticket", "count").find((c) => c.args.where?.dueAt);
    expect(breachCount?.args.where).toMatchObject({ dueAt: { lt: expect.any(Date) }, status: { notIn: ["RESOLVED", "CLOSED"] } });
    expect(callsTo("ticket", "count").some((c) => c.args.where?.slaBreachAt)).toBe(false);
  });

  it("leaves AI agents out of the per-assignee breakdown", async () => {
    await request(app).get("/reports/ticket-summary").expect(200);
    const byAssignee = callsTo("ticket", "groupBy").find((c) => c.args.by?.[0] === "assigneeId");
    expect(byAssignee?.args.where.assignee).toEqual({ isAgent: false });
  });
});

describe("GET /reports/leaderboard", () => {
  it("ranks a window of resolutions, not every ticket ever resolved, and only people", async () => {
    await request(app).get("/reports/leaderboard").expect(200);
    const [resolved] = callsTo("ticket", "findMany");
    expect(resolved.args.where.resolvedAt?.gte).toBeInstanceOf(Date);
    expect(resolved.args.where.assignee).toEqual({ isAgent: false });
  });
});
