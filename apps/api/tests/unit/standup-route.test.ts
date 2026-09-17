/**
 * V12 9.1 — what the stand-up ROUTE is solely responsible for, driven through the real router:
 *
 * 1. THE WINDOW IS A CLOSED SET. `sinceHours` is a number off the wire; anything but the three the
 *    card offers is refused before a query runs, so nobody turns the card into "summarise my
 *    entire history" by editing a request.
 * 2. AN EMPTY WINDOW NEVER REACHES THE MODEL. An idle day must cost nothing — the 402-shaped
 *    budget conversation is the whole reason the check is in front of the call, not behind it.
 * 3. THE FACTS ARE THE CALLER'S OWN. The gatherer is handed `req.user.id` and nothing from the
 *    body, so there is no id to swap for somebody else's week.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const actor = { id: "emp-1", name: "Dev Patel", email: "e@x.io", role: "EMPLOYEE", permissions: [] as string[] };
const generateStandup = vi.fn().mockResolvedValue({ standup: "Yesterday I moved WEB-12." });
const gatherStandupFacts = vi.fn();

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
    project: { findFirst: vi.fn() },
    ticket: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn(), groupBy: vi.fn() },
    ticketType: { findMany: vi.fn().mockResolvedValue([]) },
    globalTicketSettings: { findUnique: vi.fn() },
    timesheet: { findMany: vi.fn().mockResolvedValue([]) },
    ticketComment: { findMany: vi.fn().mockResolvedValue([]) },
    user: { findMany: vi.fn() },
    aIInteraction: { findUnique: vi.fn() }
  }
}));

// Only the two model-facing functions are stubbed; the pure helpers (`isStandupWindow`,
// `standupIsEmpty`, `formatStandupFacts`, `standupPeriodLabel`) stay REAL, so a test cannot pass by
// re-implementing the rules it is meant to defend.
vi.mock("../../src/services/standup.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/standup.service.js")>();
  return { ...actual, gatherStandupFacts: (...args: unknown[]) => gatherStandupFacts(...args) };
});
vi.mock("../../src/services/ai.service.js", () => ({
  answerWorkspaceQuestion: vi.fn(),
  REFINE_FIELD_KEYS: ["ticket_title", "ticket_description", "ticket_comment", "timesheet_description", "timesheet_notes"],
  classifyTicket: vi.fn(),
  findDuplicateTickets: vi.fn(),
  generateStandup: (...args: unknown[]) => generateStandup(...args),
  getStandupAvailability: vi.fn().mockResolvedValue({ available: true, reason: "ok", message: "" }),
  getTextRefineAvailability: vi.fn().mockResolvedValue({ available: true, reason: "ok", message: "" }),
  improveText: vi.fn(),
  refineText: vi.fn(),
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

function app() {
  const a = express();
  a.use(express.json());
  a.use("/ai", aiRouter);
  a.use(errorHandler);
  return a;
}

const BUSY = {
  movedTickets: [{ key: "WEB-12", title: "Checkout returns 500", status: "IN_PROGRESS" }],
  commentsWritten: [],
  hoursLogged: 3,
  timesheetTickets: ["WEB-12"],
  openAssignedComments: []
};
const IDLE = { movedTickets: [], commentsWritten: [], hoursLogged: 0, timesheetTickets: [], openAssignedComments: [] };

describe("POST /api/ai/standup", () => {
  beforeEach(() => {
    generateStandup.mockClear();
    gatherStandupFacts.mockReset().mockResolvedValue(BUSY);
  });

  it("writes a stand-up from the caller's own facts, for the period asked for", async () => {
    const res = await request(app()).post("/ai/standup").send({ sinceHours: 72 }).expect(200);
    expect(res.body).toEqual({ standup: "Yesterday I moved WEB-12.", empty: false, periodLabel: "the last 3 days" });

    // The gatherer is handed the SIGNED-IN id and the validated window — never anything else.
    expect(gatherStandupFacts).toHaveBeenCalledWith("emp-1", 72);
    const passed = generateStandup.mock.calls[0][0];
    expect(passed.personName).toBe("Dev Patel");
    expect(passed.userId).toBe("emp-1");
    expect(passed.facts).toContain("- [WEB-12] Checkout returns 500 (now in progress)");
  });

  it("refuses a window the card does not offer, before touching the database", async () => {
    for (const bad of [1, 25, 720, 0, -24]) {
      const res = await request(app()).post("/ai/standup").send({ sinceHours: bad }).expect(422);
      expect(res.body.message).toMatch(/24 hours, 3 days or 7 days/);
    }
    expect(gatherStandupFacts).not.toHaveBeenCalled();
    expect(generateStandup).not.toHaveBeenCalled();
  });

  it("answers an empty window itself, without spending a model call", async () => {
    gatherStandupFacts.mockResolvedValue(IDLE);
    const res = await request(app()).post("/ai/standup").send({ sinceHours: 24 }).expect(200);
    expect(res.body).toEqual({ standup: "", empty: true, periodLabel: "the last 24 hours" });
    expect(generateStandup).not.toHaveBeenCalled();
  });

  it("surfaces an empty model answer as a failure rather than a blank card", async () => {
    // The provider really did this in a live run: a 200 with no text. Silently leaving the card in
    // its "press Write it" state made a spent call look like a button that had not been pressed.
    const { AppError } = await import("../../src/middleware/error.js");
    generateStandup.mockRejectedValueOnce(new AppError(502, "The AI returned an empty stand-up. Try again."));
    const res = await request(app()).post("/ai/standup").send({ sinceHours: 24 }).expect(502);
    expect(res.body.message).toMatch(/empty stand-up/);
  });

  it("takes no user id from the body — a swapped id changes nothing about whose week is read", async () => {
    await request(app()).post("/ai/standup").send({ sinceHours: 24, userId: "someone-else" }).expect(200);
    expect(gatherStandupFacts).toHaveBeenCalledWith("emp-1", 24);
  });
});
