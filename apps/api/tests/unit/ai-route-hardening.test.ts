/**
 * Two properties of `/api/ai` that the router — not the AI service — is solely responsible for.
 *
 * 1. WHO A PROJECT ID MAY NAME. `tickets:write` is held tenant-wide, so it answers "may you create
 *    tickets at all", not "in which projects". `POST /tickets/:id/summarize` and `POST /ask` in the
 *    same router already run the caller's project scope; `suggest-triage` and `duplicates` took a
 *    `projectId` from the body and used it, so an employee could spend the workspace's AI budget on
 *    a project they cannot open and, via `duplicates`, get its ticket keys and titles back.
 *
 * 2. WHAT THE THROTTLE COUNTS. Buckets were keyed on `req.ip`, which is neither the thing that
 *    spends money (a user) nor a thing a user has one of. One NAT'd office shared a single 20/min
 *    allowance; one person with a phone and a laptop had two.
 *
 * These drive the REAL router through supertest for the reason ai-proposal-scope.test.ts states: a
 * test that re-implements the predicate passes just as happily against the version without it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const actor = { id: "emp-1", name: "Emp", email: "e@x.io", role: "EMPLOYEE", permissions: [] as string[] };
const scope = vi.fn();
const classifyTicket = vi.fn().mockResolvedValue({ type: "BUG", priority: "LOW", moduleId: null, confidence: 0.5, reasoning: "x" });
const findDuplicateTickets = vi.fn().mockResolvedValue([]);
const projectFindFirst = vi.fn();
const ticketFindMany = vi.fn().mockResolvedValue([]);
const ticketTypeFindMany = vi.fn().mockResolvedValue([{ name: "BUG" }]);

vi.mock("../../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/middleware/auth.js")>("../../src/middleware/auth.js");
  return {
    ...actual,
    // Only the token half is stubbed; `requirePermission` stays real so a test cannot pass by
    // bypassing authorization altogether.
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.user = { ...actor, permissions: [...actor.permissions] } as never;
      next();
    }
  };
});

vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    project: { findFirst: projectFindFirst },
    ticket: { findMany: ticketFindMany, count: vi.fn(), groupBy: vi.fn() },
    ticketType: { findMany: ticketTypeFindMany },
    globalTicketSettings: { findUnique: vi.fn() },
    timesheet: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
    aIInteraction: { findUnique: vi.fn() }
  }
}));

vi.mock("../../src/services/ticket.service.js", async () => {
  const { AppError } = await import("../../src/middleware/error.js");
  return {
    ticketProjectScope: (...args: unknown[]) => scope(...args),
    // The real predicate, over the same mocked scope — see ai-proposal-scope.test.ts.
    assertTicketVisible: async (req: unknown, projectId: string) => {
      const resolved = await scope(req);
      if (!resolved.unrestricted && !resolved.projectIds.includes(projectId)) throw new AppError(403, "Forbidden");
    }
  };
});

vi.mock("../../src/services/ai.service.js", () => ({
  answerWorkspaceQuestion: vi.fn(),
  // A VALUE, not a stub: `ai.controller.ts` builds its `z.enum` from this at module scope, so a
  // `vi.fn()` here would make every refine request 422 inside the test — the same three-copies
  // failure the real code was just fixed for, reproduced in the mock. Kept in step with the real
  // list by refine-fields.test.ts, which asserts against the actual export.
  REFINE_FIELD_KEYS: ["ticket_title", "ticket_description", "ticket_comment", "timesheet_description", "timesheet_notes"],
  classifyTicket,
  findDuplicateTickets,
  getTextRefineAvailability: vi.fn().mockResolvedValue({ available: true, reason: "ok", message: "" }),
  improveText: vi.fn(),
  refineText: vi.fn().mockResolvedValue({ refined: "ok", refinedHtml: null, format: "plain", original: "ok" }),
  summarizeComments: vi.fn()
}));
vi.mock("../../src/services/ai-dataset.service.js", () => ({
  addDatasetItemFromInteraction: vi.fn(),
  createDataset: vi.fn(),
  deleteDatasetItem: vi.fn(),
  getDataset: vi.fn(),
  listDatasets: vi.fn(),
  listPromotableInteractions: vi.fn()
}));
vi.mock("../../src/services/ai-prompt.service.js", () => ({
  activatePromptVersion: vi.fn(),
  getPromptTemplate: vi.fn(),
  listPromptTemplates: vi.fn(),
  previewPrompt: vi.fn(),
  savePromptVersion: vi.fn()
}));
vi.mock("../../src/services/ai-eval.service.js", () => ({
  enqueueEvalRun: vi.fn(),
  getEvalRun: vi.fn(),
  isReplayable: vi.fn(),
  listEvalRuns: vi.fn()
}));
vi.mock("../../src/services/ai-quality.service.js", () => ({ setInteractionFeedback: vi.fn() }));
vi.mock("../../src/services/billing-rate.service.js", () => ({ computeTimesheetCost: vi.fn() }));
vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));

const { aiRouter } = await import("../../src/controllers/ai.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");
const { permissions } = await import("@timesheet/shared");

function app() {
  const a = express();
  a.use(express.json());
  a.use("/ai", aiRouter);
  a.use(errorHandler);
  return a;
}

const MINE = "22222222-2222-4222-8222-222222222222";
const THEIRS = "33333333-3333-4333-8333-333333333333";

describe("/api/ai project-id routes are bounded by the caller's project scope", () => {
  beforeEach(() => {
    scope.mockReset().mockResolvedValue({ unrestricted: false, projectIds: [MINE] });
    projectFindFirst.mockReset().mockResolvedValue({ id: MINE, name: "Web", modules: [] });
    classifyTicket.mockClear();
    findDuplicateTickets.mockClear();
    ticketFindMany.mockClear();
    actor.permissions = [permissions.TICKETS_WRITE];
  });

  it("refuses suggest-triage for a project the caller cannot see, before spending a model call", async () => {
    await request(app())
      .post("/ai/tickets/suggest-triage")
      .send({ projectId: THEIRS, title: "Login is broken" })
      .expect(403);
    expect(classifyTicket).not.toHaveBeenCalled();
  });

  it("refuses duplicate detection for a project the caller cannot see, before reading its tickets", async () => {
    await request(app())
      .post("/ai/tickets/duplicates")
      .send({ projectId: THEIRS, title: "Login is broken" })
      .expect(403);
    expect(ticketFindMany).not.toHaveBeenCalled();
    expect(findDuplicateTickets).not.toHaveBeenCalled();
  });

  it("still works for a project the caller can see", async () => {
    await request(app())
      .post("/ai/tickets/suggest-triage")
      .send({ projectId: MINE, title: "Login is broken" })
      .expect(200);
    expect(classifyTicket).toHaveBeenCalledOnce();
  });

  it("does not constrain a privileged role", async () => {
    scope.mockResolvedValue({ unrestricted: true, projectIds: [] });
    projectFindFirst.mockResolvedValue({ id: THEIRS, name: "Other", modules: [] });
    await request(app())
      .post("/ai/tickets/suggest-triage")
      .send({ projectId: THEIRS, title: "Login is broken" })
      .expect(200);
  });
});

describe("the AI throttle counts per user, not per address", () => {
  beforeEach(() => {
    scope.mockReset().mockResolvedValue({ unrestricted: true, projectIds: [] });
    actor.permissions = [permissions.TICKETS_WRITE];
  });

  it("does not spend one caller's allowance on another caller from the same IP", async () => {
    // supertest talks to a loopback socket, so every request below shares one address — which is
    // precisely the shape (an office behind one NAT) the per-IP bucket got wrong.
    const server = app();

    actor.id = "user-a";
    let sawLimit = false;
    for (let i = 0; i < 25; i += 1) {
      const res = await request(server).post("/ai/text/refine").send({ text: "hello", field: "ticket_title" });
      if (res.status === 429) {
        sawLimit = true;
        break;
      }
    }
    expect(sawLimit).toBe(true); // the limit still exists — this is not a test that removed it

    // A different person, same address, has their own allowance.
    actor.id = "user-b";
    await request(server).post("/ai/text/refine").send({ text: "hello", field: "ticket_title" }).expect(200);

    actor.id = "emp-1";
  });
});
