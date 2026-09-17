/**
 * V12 9.2 — the run list's filters at the boundary, through the real router.
 *
 * The pure `buildAgentRunWhere` is tested next door; what only the router can answer is whether an
 * unknown status is REFUSED (rather than passed through to produce a reassuring empty list) and
 * whether what the pure function builds is what actually reaches the query.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const actor = { id: "sa-1", name: "Root", email: "r@x.io", role: "SUPER_ADMIN", permissions: [] as string[] };
const findMany = vi.fn().mockResolvedValue([]);

vi.mock("../../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/middleware/auth.js")>("../../src/middleware/auth.js");
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.user = { ...actor, permissions: [...actor.permissions] } as never;
      next();
    },
    // The real guard stays in place for every other route; only the token half is stubbed.
    requireSuperAdmin: (req: express.Request, _res: express.Response, next: express.NextFunction) => next()
  };
});

vi.mock("../../src/config/prisma.js", () => ({
  prisma: { agentRun: { findMany: (...a: unknown[]) => findMany(...a), findUnique: vi.fn() } }
}));

// `buildAgentRunWhere` and `AGENT_RUN_STATUSES` stay REAL — they are the thing under test.
vi.mock("../../src/services/agent-run.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/agent-run.service.js")>();
  return { ...actual, queueAgentRun: vi.fn(), requestAbort: vi.fn() };
});

const { agentRunRouter } = await import("../../src/controllers/agent-run.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");

function app() {
  const a = express();
  a.use(express.json());
  a.use("/agent-runs", agentRunRouter);
  a.use(errorHandler);
  return a;
}

describe("GET /api/agent-runs", () => {
  beforeEach(() => findMany.mockClear());

  it("asks for everything when nothing is filtered", async () => {
    await request(app()).get("/agent-runs").expect(200);
    expect((findMany.mock.calls[0][0] as any).where).toEqual({});
  });

  it("narrows by status", async () => {
    await request(app()).get("/agent-runs?status=FAILED").expect(200);
    expect((findMany.mock.calls[0][0] as any).where).toEqual({ status: "FAILED" });
  });

  it("refuses a status no run can hold, instead of answering with an empty list", async () => {
    // "SKIPPED" is real — for backups. Silently answering [] here would read as "nothing skipped".
    for (const bad of ["SKIPPED", "completed", "DONE", "'; DROP TABLE"]) {
      await request(app()).get(`/agent-runs?status=${encodeURIComponent(bad)}`).expect(422);
    }
    expect(findMany).not.toHaveBeenCalled();
  });

  it("turns sinceDays into a createdAt boundary, and refuses one outside its bound", async () => {
    await request(app()).get("/agent-runs?sinceDays=7").expect(200);
    const where = (findMany.mock.calls[0][0] as any).where;
    const cutoff = where.createdAt.gte as Date;
    const days = (Date.now() - cutoff.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);

    findMany.mockClear();
    await request(app()).get("/agent-runs?sinceDays=91").expect(422);
    await request(app()).get("/agent-runs?sinceDays=0").expect(422);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("combines the filters it is given, and still caps the page", async () => {
    await request(app()).get("/agent-runs?status=PARTIAL&sinceDays=1&capability=rebalance&limit=10").expect(200);
    const call = findMany.mock.calls[0][0] as any;
    expect(call.where).toMatchObject({ status: "PARTIAL", capability: "rebalance" });
    expect(call.where.createdAt.gte).toBeInstanceOf(Date);
    expect(call.take).toBe(10);
  });
});
