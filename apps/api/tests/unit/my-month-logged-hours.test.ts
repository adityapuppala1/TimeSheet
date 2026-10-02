/**
 * `GET /dashboards/my-month` — the home page's personal rollup, and the server half of the "your
 * logged hours" cards.
 *
 * Pinned here:
 *   - it is the CALLER's rows only, whatever role they hold;
 *   - "logged" is SUBMITTED + APPROVED, so the approved share is approved ÷ logged — a draft
 *     sitting in the denominator made every half-finished week look like an approvals backlog;
 *   - with no range it answers for the current month in the PLATFORM's zone (IST), not UTC's — on
 *     the 1st before 05:30 IST, UTC still says it is last month.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const ME = "user-me";

const state = vi.hoisted(() => ({
  entries: [] as Array<Record<string, unknown>>,
  timesheetWhere: [] as Array<Record<string, any>>
}));

vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    timesheet: {
      findMany: vi.fn(async (args: any) => {
        state.timesheetWhere.push(args.where);
        return state.entries.filter((e) => e.userId === args.where.userId);
      })
    },
    userProjectAssignment: { findMany: vi.fn(async () => []) },
    project: { findMany: vi.fn(async () => [{ id: "p1", code: "APL", name: "Apollo" }]) },
    ticket: { groupBy: vi.fn(async () => []) },
    changeRequest: { findMany: vi.fn(async () => []) }
  }
}));

vi.mock("../../src/middleware/auth.js", () => ({
  requireAuth: (req: any, _res: unknown, next: () => void) => {
    // A manager: reports:view is exactly the permission that used to widen the home page's list.
    req.user = { id: ME, name: "Manager Me", permissions: ["reports:view"] };
    next();
  },
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next()
}));

vi.mock("../../src/services/change.service.js", () => ({ isChangeManagementOn: vi.fn(async () => false) }));

function entry(status: string, hours: number, userId = ME) {
  return { userId, projectId: "p1", totalHours: hours, status, workDate: new Date("2026-09-29T00:00:00.000Z") };
}

let request: typeof import("supertest").default;
let app: import("express").Express;

beforeAll(async () => {
  const express = (await import("express")).default;
  const { dashboardRouter } = await import("../../src/controllers/dashboard.controller.js");
  const { errorHandler } = await import("../../src/middleware/error.js");
  request = (await import("supertest")).default;
  app = express();
  app.use("/dashboards", dashboardRouter);
  app.use(errorHandler);
}, 60_000);

beforeEach(() => {
  state.entries = [];
  state.timesheetWhere = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /dashboards/my-month", () => {
  it("counts approved ÷ logged, where logged is submitted + approved — drafts and rejected stay out", async () => {
    state.entries = [entry("APPROVED", 4), entry("SUBMITTED", 2), entry("DRAFT", 3), entry("REJECTED", 1), entry("APPROVED", 9, "someone-else")];

    const res = await request(app).get("/dashboards/my-month?from=2026-09-28&to=2026-10-04").expect(200);

    expect(state.timesheetWhere[0].userId).toBe(ME);
    expect(res.body.totals.loggedHours).toBe(6);
    expect(res.body.totals.approvedHours).toBe(4);
    expect(res.body.totals.draftHours).toBe(3);
    expect(res.body.totals.rejectedHours).toBe(1);
    expect(res.body.completion.timesheetPct).toBe(67);
    // The per-project hours are logged hours too, so the row's approved share means the same thing.
    expect(res.body.projects[0]).toMatchObject({ id: "p1", monthHours: 6, approvedHours: 4 });
  });

  it("is a dash, not 0%, when nothing has been logged — only drafts", async () => {
    state.entries = [entry("DRAFT", 5)];
    const res = await request(app).get("/dashboards/my-month?from=2026-09-28&to=2026-10-04").expect(200);
    expect(res.body.completion.timesheetPct).toBeNull();
  });

  it("defaults to the current month in IST, even in the hours UTC is still in the previous one", async () => {
    // 1 Oct 2026, 02:00 IST = 30 Sep, 20:30 UTC.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T20:30:00.000Z"));

    const res = await request(app).get("/dashboards/my-month").expect(200);

    expect(state.timesheetWhere[0].workDate).toEqual({
      gte: new Date("2026-10-01T00:00:00.000Z"),
      lt: new Date("2026-11-01T00:00:00.000Z")
    });
    expect(res.body.month).toEqual({ from: "2026-10-01T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z" });
  });
});
