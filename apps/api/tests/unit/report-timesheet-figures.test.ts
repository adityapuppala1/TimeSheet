/**
 * The timesheet figures `/reports/admin-summary` and `/reports/daily-status` hand the dashboards.
 *
 * Driven through the real router over a stand-in client that records every query, because what is
 * pinned here is WHICH rows each figure counts:
 *  - "Pending approvals" on the reports and admin dashboards counted every SUBMITTED row in the
 *    workspace, while the Inbox counted everything but your own and the approvals queue showed yet
 *    another set. All three now use the queue's predicate: SUBMITTED, not yours, not your managers'.
 *  - `/daily-status` answered "today" with the SERVER's calendar day, so a New York user's evening
 *    was already tomorrow; it now asks the user's own zone, like the reminder worker and the brief.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const calls = vi.hoisted(() => [] as Array<{ model: string; method: string; args: any }>);
const viewer = vi.hoisted(() => ({ timezone: "Asia/Kolkata" as string | null }));
/** boss-1 reports to ceo-1: a manager with a manager of their own is not the viewer's to decide,
 *  while ceo-1, at the top with nobody above, is (timesheet-approval-root.test.ts). */
const people = vi.hoisted(() => [
  { id: "ceo-1", email: "ceo@x.io", managerId: null, status: "ACTIVE", deletedAt: null },
  { id: "boss-1", email: "boss@x.io", managerId: "ceo-1", status: "ACTIVE", deletedAt: null },
  { id: "viewer-1", email: "viewer@x.io", managerId: "boss-1", status: "ACTIVE", deletedAt: null }
]);

/** Every model, every method: records the call and answers with an empty result of the right shape. */
vi.mock("../../src/config/prisma.js", () => {
  const answer = (model: string, method: string, args: any) => {
    calls.push({ model, method, args });
    if (model === "user" && method === "findMany" && args?.select?.managerId) return people;
    if (model === "user" && method === "findUnique") return { timezone: viewer.timezone };
    if (method === "count") return 0;
    if (method === "aggregate") return { _sum: { totalHours: 0 }, _count: 0 };
    if (method === "findMany" || method === "groupBy") return [];
    return null;
  };
  const model = (name: string) => new Proxy({}, { get: (_t, method: string) => async (args: any) => answer(name, method, args) });
  // The admin summary's distinct-day counts are one raw COUNT(DISTINCT …) query — an empty workspace answers 0.
  const queryRaw = async () => [{ n: 0 }];
  return { prisma: new Proxy({}, { get: (_t, name: string) => (name === "$queryRaw" ? queryRaw : model(name)) }) };
});
vi.mock("../../src/middleware/auth.js", () => ({
  requireAuth: (req: any, _res: unknown, next: () => void) => {
    req.user = { id: "viewer-1", name: "Vi Viewer", email: "viewer@x.io", role: "MANAGER", permissions: ["reports:view", "timesheets:approve"] };
    next();
  },
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next()
}));
vi.mock("../../src/services/change.service.js", () => ({ isChangeManagementOn: vi.fn().mockResolvedValue(false) }));

const { reportRouter } = await import("../../src/controllers/report.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/reports", reportRouter);
  app.use(errorHandler);
  return app;
}

const timesheetCalls = (method: string) => calls.filter((c) => c.model === "timesheet" && c.method === method).map((c) => c.args);

beforeEach(() => {
  calls.length = 0;
  viewer.timezone = "Asia/Kolkata";
});
afterEach(() => {
  vi.useRealTimers();
});

describe("admin-summary — pending approvals", () => {
  it("counts what the approvals queue lists: SUBMITTED, not the viewer's own, not their managers'", async () => {
    const res = await request(buildApp()).get("/api/reports/admin-summary");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const pending = timesheetCalls("count").filter((args) => args?.where?.status === "SUBMITTED");
    // One figure: "Pending approvals" describes NOW, so it carries no one-way "vs yesterday" delta
    // (workspace analytics M4) — but it is still the approvals queue's own scoped count.
    expect(pending).toHaveLength(1);
    for (const args of pending) {
      expect([...args.where.userId.notIn].sort()).toEqual(["boss-1", "viewer-1"]);
    }
  });
});

describe("daily-status — today is the viewer's own day", () => {
  it("is 2 October for an IST viewer at 02:00 IST, and 1 October for a New York viewer at the same instant", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-01T20:30:00.000Z"), toFake: ["Date"] });
    const ist = await request(buildApp()).get("/api/reports/daily-status");
    expect(ist.body.date).toBe("2026-10-02");

    viewer.timezone = "America/New_York";
    const ny = await request(buildApp()).get("/api/reports/daily-status");
    expect(ny.body.date).toBe("2026-10-01");
    const aggregate = timesheetCalls("aggregate").at(-1);
    expect(aggregate.where.workDate).toEqual({ gte: new Date("2026-10-01T00:00:00.000Z"), lte: new Date("2026-10-01T00:00:00.000Z") });
  });
});

describe("daily-status — rejected hours do not stand", () => {
  it("leaves REJECTED entries out of the hours and the entry count", async () => {
    // A refused entry is meant to be re-logged; counting both made a rejected-then-relogged day read
    // double on the dashboard's hero card. History already excludes them.
    await request(buildApp()).get("/api/reports/daily-status");
    expect(timesheetCalls("aggregate").at(-1).where.status).toEqual({ not: "REJECTED" });
  });
});
