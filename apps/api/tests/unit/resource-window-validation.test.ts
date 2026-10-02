/**
 * The workload board's date window. A malformed `from`/`to` used to reach `toDay`, become an Invalid
 * Date, and throw a RangeError deep in the bucket builder — a 500 for what is a bad request. These
 * query strings get bookmarked and hand-edited, so the answer must be a 422 that names the fault.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    user: { findMany: vi.fn(async () => []) },
    resourceBooking: { findMany: vi.fn(async () => []) },
    timesheet: { findMany: vi.fn(async () => []) },
    ticket: { findMany: vi.fn(async () => []) },
    agentWorkEntry: { findMany: vi.fn(async () => []) }
  }
}));
vi.mock("../../src/middleware/auth.js", () => ({
  requireAuth: (req: any, _res: unknown, next: () => void) => {
    req.user = { id: "u1", permissions: ["resources:manage"] };
    next();
  },
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next()
}));
vi.mock("../../src/services/planning.service.js", () => ({
  assertPlanningCapability: vi.fn(async () => undefined),
  assertPlanningEnabled: vi.fn(async () => undefined),
  getPlanningSettings: vi.fn(async () => ({ workingDays: [1, 2, 3, 4, 5], defaultWeeklyCapacityHours: 40 }))
}));

let request: typeof import("supertest").default;
let app: import("express").Express;

beforeAll(async () => {
  const express = (await import("express")).default;
  const { resourceRouter } = await import("../../src/controllers/resource.controller.js");
  const { errorHandler } = await import("../../src/middleware/error.js");
  request = (await import("supertest")).default;
  app = express();
  app.use("/resources", resourceRouter);
  app.use(errorHandler);
}, 60_000);

describe("GET /resources/workload, /conflicts and /bookings with a malformed window", () => {
  for (const path of ["/resources/workload", "/resources/conflicts", "/resources/bookings"]) {
    it(`${path} answers 422, not 500, for an unreadable date`, async () => {
      const res = await request(app).get(`${path}?from=garbage&to=2026-10-31`);
      expect(res.status).toBe(422);
      expect(JSON.stringify(res.body)).toMatch(/YYYY-MM-DD/);
    });
  }

  it("still answers a well-formed window", async () => {
    const res = await request(app).get("/resources/workload?from=2026-10-01&to=2026-10-31").expect(200);
    expect(res.body.from).toBe("2026-10-01");
  });
});
