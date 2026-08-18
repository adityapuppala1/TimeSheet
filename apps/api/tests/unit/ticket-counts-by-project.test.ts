/**
 * Per-project open/closed ticket counts, driven through the real router.
 *
 * Two things are worth pinning. The GROUPING — RESOLVED and CLOSED both mean done, and a ticket with
 * no project belongs to no row — because the dashboard divides one of these numbers by their sum, and
 * a miscount there is a percentage that looks authoritative and is wrong. And the BOUNDARY: this
 * route answers "how much of somebody's work is finished", which is exactly the shape of question
 * that must not become a way to profile a colleague.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const actor = { id: "me-1", name: "Avery", email: "a@x.io", role: "EMPLOYEE", permissions: ["tickets:view"] as string[] };
const groupBy = vi.fn().mockResolvedValue([]);

vi.mock("../../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/middleware/auth.js")>("../../src/middleware/auth.js");
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.user = { ...actor, permissions: [...actor.permissions] } as never;
      next();
    }
  };
});
vi.mock("../../src/config/prisma.js", () => ({
  prisma: { ticket: { groupBy: (...a: unknown[]) => groupBy(...a) } }
}));
vi.mock("../../src/config/tenant-context.js", () => ({ requireTenantContext: () => ({ orgId: "org-1", orgSlug: "acme" }) }));
vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));

const { ticketRouter } = await import("../../src/controllers/ticket.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");

function app() {
  const a = express();
  a.use(express.json());
  a.use("/tickets", ticketRouter);
  a.use(errorHandler);
  return a;
}

beforeEach(() => {
  vi.clearAllMocks();
  actor.role = "EMPLOYEE";
  actor.permissions = ["tickets:view"];
  groupBy.mockResolvedValue([]);
});

describe("what counts as done", () => {
  it("folds RESOLVED and CLOSED together, and leaves everything else open", async () => {
    groupBy.mockResolvedValue([
      { projectId: "p-1", status: "OPEN", _count: 3 },
      { projectId: "p-1", status: "IN_PROGRESS", _count: 2 },
      { projectId: "p-1", status: "IN_REVIEW", _count: 1 },
      { projectId: "p-1", status: "REOPENED", _count: 1 },
      { projectId: "p-1", status: "RESOLVED", _count: 4 },
      { projectId: "p-1", status: "CLOSED", _count: 5 }
    ]);

    const res = await request(app()).get("/tickets/counts-by-project");

    expect(res.status).toBe(200);
    // 3+2+1+1 open, 4+5 closed — the percentage the dashboard renders depends on both halves being
    // counted the same way, from the same query.
    expect(res.body).toEqual([{ projectId: "p-1", open: 7, closed: 9 }]);
  });

  it("keeps projects separate", async () => {
    groupBy.mockResolvedValue([
      { projectId: "p-1", status: "OPEN", _count: 2 },
      { projectId: "p-2", status: "CLOSED", _count: 6 }
    ]);
    const res = await request(app()).get("/tickets/counts-by-project");
    expect(res.body).toEqual([
      { projectId: "p-1", open: 2, closed: 0 },
      { projectId: "p-2", open: 0, closed: 6 }
    ]);
  });

  it("drops a ticket that belongs to no project rather than inventing a row for it", async () => {
    groupBy.mockResolvedValue([
      { projectId: null, status: "OPEN", _count: 4 },
      { projectId: "p-1", status: "OPEN", _count: 1 }
    ]);
    const res = await request(app()).get("/tickets/counts-by-project");
    expect(res.body).toEqual([{ projectId: "p-1", open: 1, closed: 0 }]);
  });

  it("returns an empty list rather than an error when somebody has no tickets", async () => {
    const res = await request(app()).get("/tickets/counts-by-project");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe("whose tickets it will count", () => {
  it("defaults to the caller, and never counts anyone else by accident", async () => {
    await request(app()).get("/tickets/counts-by-project");
    expect(groupBy.mock.calls[0][0].where).toMatchObject({ assigneeId: "me-1", deletedAt: null });
  });

  it("refuses another person's counts without the permission that already grants a cross-user view", async () => {
    // "How much of their work is finished" is a question about a colleague. The route must not be a
    // way around the rule the ticket list already applies.
    const res = await request(app()).get("/tickets/counts-by-project?assigneeId=someone-else");
    expect(res.status).toBe(403);
    expect(groupBy).not.toHaveBeenCalled();
  });

  it("allows it for somebody who may already see everyone's tickets", async () => {
    actor.permissions = ["tickets:view", "reports:view"];
    const res = await request(app()).get("/tickets/counts-by-project?assigneeId=someone-else");
    expect(res.status).toBe(200);
    expect(groupBy.mock.calls[0][0].where).toMatchObject({ assigneeId: "someone-else" });
  });

  it("excludes deleted tickets, so a soft-deleted one cannot inflate either half", async () => {
    await request(app()).get("/tickets/counts-by-project");
    expect(groupBy.mock.calls[0][0].where.deletedAt).toBeNull();
  });
});
