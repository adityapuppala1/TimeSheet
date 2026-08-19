/**
 * Per-project open/closed ticket counts, driven through the real router.
 *
 * Three things are worth pinning. The GROUPING — RESOLVED and CLOSED both mean done, and a ticket
 * with no project belongs to no row — because the dashboard divides one of these numbers by their
 * sum, and a miscount there is a percentage that looks authoritative and is wrong. The SCOPE: the
 * route reports a project's totals, so what bounds it is `ticketProjectScope`, not the assignee
 * filter. And the BOUNDARY on `mine*`: "how much of somebody's work is finished" is exactly the
 * shape of question that must not become a way to profile a colleague.
 *
 * WHAT CHANGED AND WHY: this route used to answer ONLY for one assignee, which made the dashboard's
 * Open/Closed columns render an em dash for anybody who logs time against a project without holding
 * tickets in it — a super admin reviewing a team saw three dashes on every row. It now returns the
 * project totals with the caller's own share beside them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const actor = { id: "me-1", name: "Avery", email: "a@x.io", role: "EMPLOYEE", permissions: ["tickets:view"] as string[] };
const groupBy = vi.fn().mockResolvedValue([]);
const findManyAssignments = vi.fn().mockResolvedValue([{ projectId: "p-1" }, { projectId: "p-2" }]);
const findManyUsers = vi.fn().mockResolvedValue([]);

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
  prisma: {
    ticket: { groupBy: (...a: unknown[]) => groupBy(...a) },
    userProjectAssignment: { findMany: (...a: unknown[]) => findManyAssignments(...a) },
    user: { findMany: (...a: unknown[]) => findManyUsers(...a) }
  }
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

/** The route fires two groupBys concurrently: [0] is every visible ticket, [1] is the caller's own. */
const ALL = 0;
const MINE = 1;

/** Answers the "all" query with `all` and the "mine" query with `mine`, in call order. */
function respond(all: unknown[], mine: unknown[] = []) {
  groupBy.mockResolvedValueOnce(all).mockResolvedValueOnce(mine);
}

beforeEach(() => {
  vi.clearAllMocks();
  actor.role = "EMPLOYEE";
  actor.permissions = ["tickets:view"];
  groupBy.mockResolvedValue([]);
  findManyAssignments.mockResolvedValue([{ projectId: "p-1" }, { projectId: "p-2" }]);
  findManyUsers.mockResolvedValue([]);
});

describe("what counts as done", () => {
  it("folds RESOLVED and CLOSED together, and leaves everything else open", async () => {
    respond([
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
    expect(res.body).toEqual([{ projectId: "p-1", open: 7, closed: 9, mineOpen: 0, mineClosed: 0 }]);
  });

  it("reports the caller's own share alongside the project's total", async () => {
    respond(
      [
        { projectId: "p-1", status: "OPEN", _count: 10 },
        { projectId: "p-1", status: "CLOSED", _count: 4 }
      ],
      [
        { projectId: "p-1", status: "OPEN", _count: 2 },
        { projectId: "p-1", status: "RESOLVED", _count: 1 }
      ]
    );

    const res = await request(app()).get("/tickets/counts-by-project");

    expect(res.body).toEqual([{ projectId: "p-1", open: 10, closed: 4, mineOpen: 2, mineClosed: 1 }]);
  });

  it("keeps projects separate", async () => {
    respond([
      { projectId: "p-1", status: "OPEN", _count: 2 },
      { projectId: "p-2", status: "CLOSED", _count: 6 }
    ]);
    const res = await request(app()).get("/tickets/counts-by-project");
    expect(res.body).toEqual([
      { projectId: "p-1", open: 2, closed: 0, mineOpen: 0, mineClosed: 0 },
      { projectId: "p-2", open: 0, closed: 6, mineOpen: 0, mineClosed: 0 }
    ]);
  });

  it("emits a project the caller holds no tickets in, so the dashboard can show a real zero", async () => {
    // The bug this route was changed to fix: when only the caller's own tickets were counted, a
    // project they had logged time against but held no tickets in produced NO row at all — and the
    // dashboard renders a missing row as "—", which reads as "still loading" rather than "none".
    respond([{ projectId: "p-1", status: "OPEN", _count: 5 }], []);
    const res = await request(app()).get("/tickets/counts-by-project");
    expect(res.body).toEqual([{ projectId: "p-1", open: 5, closed: 0, mineOpen: 0, mineClosed: 0 }]);
  });

  it("drops a ticket that belongs to no project rather than inventing a row for it", async () => {
    respond([
      { projectId: null, status: "OPEN", _count: 4 },
      { projectId: "p-1", status: "OPEN", _count: 1 }
    ]);
    const res = await request(app()).get("/tickets/counts-by-project");
    expect(res.body).toEqual([{ projectId: "p-1", open: 1, closed: 0, mineOpen: 0, mineClosed: 0 }]);
  });

  it("returns an empty list rather than an error when there are no tickets", async () => {
    const res = await request(app()).get("/tickets/counts-by-project");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe("what bounds the totals", () => {
  it("restricts an unprivileged caller to the projects they are assigned to", async () => {
    // The totals are the whole project's, so this filter is the ONLY thing standing between the
    // caller and ticket counts for a project they cannot open.
    await request(app()).get("/tickets/counts-by-project");
    expect(groupBy.mock.calls[ALL][0].where).toMatchObject({ projectId: { in: ["p-1", "p-2"] }, deletedAt: null });
  });

  it("answers with an empty list, and never queries, when the caller is assigned to nothing", async () => {
    findManyAssignments.mockResolvedValue([]);
    const res = await request(app()).get("/tickets/counts-by-project");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(groupBy).not.toHaveBeenCalled();
  });

  it("applies no project filter for a privileged role", async () => {
    actor.role = "SUPER_ADMIN";
    await request(app()).get("/tickets/counts-by-project");
    expect(groupBy.mock.calls[ALL][0].where.projectId).toBeUndefined();
  });

  it("excludes deleted tickets from both halves, so a soft-deleted one cannot inflate either", async () => {
    await request(app()).get("/tickets/counts-by-project");
    expect(groupBy.mock.calls[ALL][0].where.deletedAt).toBeNull();
    expect(groupBy.mock.calls[MINE][0].where.deletedAt).toBeNull();
  });
});

describe("whose tickets the personal half counts", () => {
  it("defaults to the caller, and never counts anyone else by accident", async () => {
    await request(app()).get("/tickets/counts-by-project");
    expect(groupBy.mock.calls[MINE][0].where).toMatchObject({ assigneeId: "me-1", deletedAt: null });
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
    expect(groupBy.mock.calls[MINE][0].where).toMatchObject({ assigneeId: "someone-else" });
  });
});
