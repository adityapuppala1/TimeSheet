/**
 * `GET /ai-proposals` is gated on `tickets:view`, which every non-viewer role holds TENANT-WIDE —
 * so the permission is not a boundary. Until this was scoped, an employee listing proposals saw
 * every project's pending plan changes, including the model's reasoning text, for projects they
 * cannot open at all. The pentest's privilege sweep found it as a 200 where a 403 was expected.
 *
 * These drive the REAL router through supertest and assert the `where` that reached Prisma, for
 * the same reason ticket-project-scope.test.ts does: a test that re-implements the route's
 * predicate and checks its own arithmetic passes just as happily against the unscoped version.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const actor = { id: "emp-1", name: "Emp", email: "e@x.io", role: "EMPLOYEE", permissions: [] as string[] };
const findMany = vi.fn().mockResolvedValue([]);
const scope = vi.fn();
const proposalFindUnique = vi.fn();
const proposalUpdate = vi.fn();
const changeFindMany = vi.fn().mockResolvedValue([]);
const changeUpdate = vi.fn();
const transaction = vi.fn().mockResolvedValue([]);
const applyProposal = vi.fn().mockResolvedValue({ applied: 0, skipped: 0, failed: [], status: "REJECTED" });

vi.mock("../../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/middleware/auth.js")>("../../src/middleware/auth.js");
  return {
    ...actual,
    // Only the token half is stubbed; `requirePermission` stays the real implementation, so the
    // test cannot accidentally pass by bypassing authorization entirely.
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.user = { ...actor, permissions: [...actor.permissions] } as never;
      next();
    }
  };
});
vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    aiProposal: { findMany, findUnique: proposalFindUnique, update: proposalUpdate },
    aiProposalChange: { findMany: changeFindMany, update: changeUpdate },
    $transaction: transaction
  }
}));
vi.mock("../../src/services/planning.service.js", () => ({ assertPlanningEnabled: vi.fn().mockResolvedValue(undefined) }));
// The REAL `assertTicketVisible`, running against the same mocked `ticketProjectScope` the list
// route uses — a stub that always resolves would make every scoping assertion below vacuous.
vi.mock("../../src/services/ticket.service.js", async () => {
  const { AppError } = await import("../../src/middleware/error.js");
  return {
    ticketProjectScope: (...args: unknown[]) => scope(...args),
    assertTicketVisible: async (req: { user?: { id: string } }, projectId: string) => {
      const resolved = await scope(req);
      if (!resolved.unrestricted && !resolved.projectIds.includes(projectId)) throw new AppError(403, "Forbidden");
    }
  };
});
vi.mock("../../src/services/ai-proposal.service.js", () => ({ applyProposal, createProposal: vi.fn() }));
vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));

const { aiProposalRouter } = await import("../../src/controllers/ai-proposal.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");
const { permissions } = await import("@timesheet/shared");

function app() {
  const a = express();
  a.use(express.json());
  a.use("/ai-proposals", aiProposalRouter);
  a.use(errorHandler);
  return a;
}

/** The `where` object the route actually handed Prisma. */
function whereSentToPrisma() {
  expect(findMany).toHaveBeenCalledTimes(1);
  return findMany.mock.calls[0][0].where as Record<string, unknown>;
}

describe("GET /ai-proposals project scoping", () => {
  beforeEach(() => {
    findMany.mockClear();
    scope.mockReset();
    actor.permissions = [permissions.TICKETS_VIEW];
  });

  it("scopes an ordinary user to their own projects", async () => {
    scope.mockResolvedValue({ unrestricted: false, projectIds: ["p-a", "p-b"] });
    await request(app()).get("/ai-proposals").expect(200);
    const where = whereSentToPrisma();
    // The pre-fix route sent no OR at all — this is the assertion that fails against it.
    expect(where.OR).toBeDefined();
    expect(where.OR).toContainEqual({ scopeProjectId: { in: ["p-a", "p-b"] } });
  });

  it("keeps a user's own workspace-wide proposals visible", async () => {
    // scopeProjectId is nullable: such proposals are workspace-wide rather than unowned, so
    // dropping them outright would mean requesting a plan and then being unable to find it.
    scope.mockResolvedValue({ unrestricted: false, projectIds: [] });
    await request(app()).get("/ai-proposals").expect(200);
    expect(whereSentToPrisma().OR).toContainEqual({ requestedById: "emp-1" });
  });

  it("does not constrain a privileged role", async () => {
    scope.mockResolvedValue({ unrestricted: true, projectIds: [] });
    await request(app()).get("/ai-proposals").expect(200);
    expect(whereSentToPrisma().OR).toBeUndefined();
  });

  it("applies the scope alongside a status filter rather than instead of it", async () => {
    // A filter that replaced the visibility predicate would look correct in the UI and re-open
    // the leak for anyone who clicked a tab.
    scope.mockResolvedValue({ unrestricted: false, projectIds: ["p-a"] });
    await request(app()).get("/ai-proposals?status=PENDING_REVIEW").expect(200);
    const where = whereSentToPrisma();
    expect(where.OR).toContainEqual({ scopeProjectId: { in: ["p-a"] } });
    expect(where.status).toBe("PENDING_REVIEW");
  });

  it("still refuses a caller without tickets:view", async () => {
    actor.permissions = [];
    await request(app()).get("/ai-proposals").expect(403);
    expect(findMany).not.toHaveBeenCalled();
  });
});

/**
 * The review routes are the HUMAN STEP in "the AI proposes, a person applies" — the property the
 * whole proposal envelope exists to provide. They were gated on `plan:write` alone, which every
 * lead and manager holds tenant-wide, so the person doing the reviewing did not have to be someone
 * who could open the project the tickets would land in. Given a proposal id, a lead on an
 * unrelated project could apply an AI-authored change set to a plan they cannot see.
 *
 * The list route above already draws exactly this distinction; these three simply never did.
 */
describe("AI proposal review routes are bounded by the same project scope as the list", () => {
  const OTHER_PROJECT = { id: "prop-1", scopeProjectId: "p-other", requestedById: "someone-else" };

  beforeEach(() => {
    scope.mockReset().mockResolvedValue({ unrestricted: false, projectIds: ["p-mine"] });
    proposalFindUnique.mockReset().mockResolvedValue(OTHER_PROJECT);
    proposalUpdate.mockReset().mockResolvedValue({ id: "prop-1" });
    changeFindMany.mockReset().mockResolvedValue([]);
    changeUpdate.mockReset();
    transaction.mockReset().mockResolvedValue([]);
    applyProposal.mockClear();
    actor.permissions = [permissions.PLAN_WRITE];
  });

  const ID = "11111111-1111-4111-8111-111111111111";

  it("refuses to APPLY a proposal scoped to a project the caller cannot see", async () => {
    await request(app()).post(`/ai-proposals/${ID}/apply`).send({}).expect(403);
    expect(applyProposal).not.toHaveBeenCalled();
  });

  it("refuses to REJECT a proposal scoped to a project the caller cannot see", async () => {
    await request(app()).post(`/ai-proposals/${ID}/reject`).send({}).expect(403);
    expect(proposalUpdate).not.toHaveBeenCalled();
  });

  it("refuses to record DECISIONS on a proposal scoped to a project the caller cannot see", async () => {
    await request(app())
      .patch(`/ai-proposals/${ID}/decisions`)
      .send({ decisions: { "change-1": true } })
      .expect(403);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("lets the requester act on their own workspace-wide proposal (no project scope)", async () => {
    proposalFindUnique.mockResolvedValue({ id: "prop-1", scopeProjectId: null, requestedById: actor.id });
    await request(app()).post(`/ai-proposals/${ID}/apply`).send({}).expect(200);
    expect(applyProposal).toHaveBeenCalledOnce();
  });

  it("refuses somebody else's workspace-wide proposal", async () => {
    proposalFindUnique.mockResolvedValue({ id: "prop-1", scopeProjectId: null, requestedById: "someone-else" });
    await request(app()).post(`/ai-proposals/${ID}/apply`).send({}).expect(403);
    expect(applyProposal).not.toHaveBeenCalled();
  });

  it("allows the whole flow once the proposal is in a project the caller can see", async () => {
    proposalFindUnique.mockResolvedValue({ id: "prop-1", scopeProjectId: "p-mine", requestedById: "someone-else" });
    await request(app()).post(`/ai-proposals/${ID}/apply`).send({}).expect(200);
    expect(applyProposal).toHaveBeenCalledWith(expect.objectContaining({ proposalId: "prop-1", actorId: actor.id }));
  });

  /**
   * The change ids arrive in the BODY. Before this, the `:id` in the URL was decorative and the
   * route updated whatever rows the body named — so a decision map could pre-accept rows on a
   * different proposal entirely, including one the authorization above had just refused.
   */
  it("ignores decision rows that belong to a different proposal than the one in the URL", async () => {
    proposalFindUnique.mockResolvedValue({ id: "prop-1", scopeProjectId: "p-mine", requestedById: actor.id });
    changeFindMany.mockResolvedValue([{ id: "mine-1" }]);

    const res = await request(app())
      .patch(`/ai-proposals/${ID}/decisions`)
      .send({ decisions: { "mine-1": true, "someone-elses-row": true } })
      .expect(200);

    expect(res.body).toEqual({ updated: 1 });
    expect(changeFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ proposalId: "prop-1" }) })
    );
  });
});
