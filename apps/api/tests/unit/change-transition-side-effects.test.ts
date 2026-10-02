/**
 * A change moves the same way whoever moves it.
 *
 * THE DEFECT: the side effects of a transition lived inside the transition ROUTE. The Workflow
 * Studio's "Move a change" action re-entered the gates but not the side effects, so a flow that
 * moved a change to AWAITING_APPROVAL left it there with no approval round, no submission time and
 * no email. Nobody was asked to decide it; the manager's decision was refused because no row named
 * them, and a super admin's decision crashed with a 500 reading `pending[0].id`. The only way out
 * was Cancel.
 *
 * What is pinned here:
 *   - a workflow move into AWAITING_APPROVAL opens a round and asks the approver, like the route;
 *   - a decision on a change with no open round is a 409 that says what to do, never a 500;
 *   - the change's ticket carries `closedAt` when the change settles and loses it when it is live
 *     again, so the ticket half never claims a change is closed while it is being approved.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { ACTORS, CHANGE_ID, TICKET_ID, buildChangeApp, createChangeWorld, inTenant } from "../helpers/change-world.js";

let actor: Record<string, unknown> = ACTORS.requester;

vi.mock("../../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/middleware/auth.js")>("../../src/middleware/auth.js");
  return {
    ...actual,
    requireAuth: (req: any, _res: unknown, next: () => void) => {
      req.user = actor;
      next();
    }
  };
});
vi.mock("../../src/services/plan-limits.service.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/services/plan-limits.service.js")>("../../src/services/plan-limits.service.js");
  return { ...actual, isPlanningCapabilityAllowed: vi.fn(async () => true) };
});
vi.mock("../../src/services/ticket.service.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/services/ticket.service.js")>("../../src/services/ticket.service.js");
  return { ...actual, assertTicketVisible: vi.fn(async () => undefined) };
});
const audit = vi.fn(async () => undefined);
vi.mock("../../src/services/audit.service.js", () => ({ audit: (...a: unknown[]) => audit(...(a as [])) }));
const emitDomainEvent = vi.fn();
vi.mock("../../src/services/domain-events.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/services/domain-events.js")>("../../src/services/domain-events.js");
  return { ...actual, emitDomainEvent: (...a: unknown[]) => emitDomainEvent(...a) };
});
const sendChangeSubmittedMail = vi.fn(async () => undefined);
const sendChangeDecisionMail = vi.fn(async () => undefined);
vi.mock("../../src/services/change-mail.service.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/services/change-mail.service.js")>("../../src/services/change-mail.service.js");
  return {
    ...actual,
    sendChangeSubmittedMail: (...a: unknown[]) => sendChangeSubmittedMail(...(a as [])),
    sendChangeDecisionMail: (...a: unknown[]) => sendChangeDecisionMail(...(a as []))
  };
});
vi.mock("../../src/services/notify.service.js", () => ({ dispatchNotification: vi.fn(async () => undefined) }));
const getFlow = vi.fn();
vi.mock("../../src/services/automation-flow.service.js", () => ({ getFlow: (...a: unknown[]) => getFlow(...a) }));

const { changeRouter } = await import("../../src/controllers/change.controller.js");
const { startFlowRun } = await import("../../src/services/automation-dispatch.service.js");

/** A decorated flow with one "Move a change" step, as `getFlow` returns it. */
function moveFlow(toState: string, proposalOnly = false) {
  return {
    id: "flow-1",
    name: "Submit when ready",
    emoji: "X",
    enabled: true,
    activatable: true,
    agentProfile: null,
    createdBy: { id: "requester-1", name: "Riya Requester", email: "riya@acme.io" },
    steps: [{ id: "s-1", order: 1, kind: "ACTION", capability: null, title: null, summary: null, config: { action: "change_transition", toState } }],
    authority: { effectiveLevel: "AUTO_APPLY", limitedBy: null, taintedFrom: null, proposalOnly, gatedBeforeWrites: false, steps: [] },
    issues: []
  };
}

/** The flow-run bookkeeping the dispatcher writes around a step. Not under test — just present. */
function withFlowRunTables(client: Record<string, any>) {
  client.automationFlowRun = {
    findUnique: vi.fn(async () => null),
    create: vi.fn(async () => ({ id: "run-1" })),
    update: vi.fn(async () => ({})),
    count: vi.fn(async () => 1)
  };
  client.automationFlowRunStep = { create: vi.fn(async () => ({})), deleteMany: vi.fn(async () => ({ count: 0 })) };
  client.agentProfile = { findUnique: vi.fn(async () => null) };
  return client;
}

const subject = { type: "ticket" as const, id: TICKET_ID, label: "HICS-20261002-0001 — Rotate the TLS certificate", projectId: "project-1" };

beforeEach(() => {
  vi.clearAllMocks();
  actor = ACTORS.requester;
});

describe("a workflow that submits a change", () => {
  it("opens an approval round and asks the requester's manager, exactly as pressing Submit does", async () => {
    const world = createChangeWorld();
    withFlowRunTables(world.client);
    getFlow.mockResolvedValue(moveFlow("AWAITING_APPROVAL"));

    await inTenant(world.client, () =>
      startFlowRun({ flowId: "flow-1", trigger: "event:ticket.commented", subject, triggerKey: `flow:flow-1:ticket:${TICKET_ID}` })
    );

    expect(world.change.state).toBe("AWAITING_APPROVAL");
    // The round: one pending row naming the manager. Without it nobody can decide the change.
    expect(world.approvals).toEqual([expect.objectContaining({ round: 1, approverId: "manager-1", status: "PENDING" })]);
    expect(world.change.submittedAt).toBeInstanceOf(Date);
    expect(world.ticket.status).toBe("IN_REVIEW");
    // And the approver hears about it, by the same mail the route sends.
    expect(sendChangeSubmittedMail).toHaveBeenCalledWith(expect.objectContaining({ id: CHANGE_ID }), expect.anything(), ["manager-1"]);
  });

  it("leaves a change the workflow submitted decidable by its approver", async () => {
    const world = createChangeWorld();
    withFlowRunTables(world.client);
    getFlow.mockResolvedValue(moveFlow("AWAITING_APPROVAL"));
    await inTenant(world.client, () =>
      startFlowRun({ flowId: "flow-1", trigger: "event:ticket.commented", subject, triggerKey: `flow:flow-1:ticket:${TICKET_ID}` })
    );

    actor = ACTORS.manager;
    const decided = await request(buildChangeApp(changeRouter, world.client)).post(`/api/changes/${CHANGE_ID}/decision`).send({ decision: "APPROVED" });

    expect(decided.status).toBe(200);
    expect(world.change.state).toBe("APPROVED");
  });
});

describe("deciding a change that has no open approval round", () => {
  it("answers 409 with a way out, rather than crashing on the missing row", async () => {
    // The state a pre-fix workflow left behind: AWAITING_APPROVAL with no rows at all.
    const world = createChangeWorld({ change: { state: "AWAITING_APPROVAL", submittedAt: new Date() } });
    actor = ACTORS.superAdmin;

    const decided = await request(buildChangeApp(changeRouter, world.client)).post(`/api/changes/${CHANGE_ID}/decision`).send({ decision: "APPROVED" });

    expect(decided.status).toBe(409);
    expect(decided.body.message).toMatch(/no open approval round/i);
    expect(world.change.state).toBe("AWAITING_APPROVAL");
  });
});

describe("the change's ticket follows the change", () => {
  it("is stamped closed when the change is cancelled, and live again when it is reopened as a draft", async () => {
    const world = createChangeWorld();
    const app = buildChangeApp(changeRouter, world.client);

    const cancelled = await request(app).post(`/api/changes/${CHANGE_ID}/transition`).send({ to: "CANCELLED" });
    expect(cancelled.status).toBe(200);
    expect(world.ticket.status).toBe("CLOSED");
    expect(world.ticket.closedAt).toBeInstanceOf(Date);

    const reopened = await request(app).post(`/api/changes/${CHANGE_ID}/transition`).send({ to: "DRAFT" });
    expect(reopened.status).toBe(200);
    expect(world.ticket.status).toBe("OPEN");
    // A live ticket that still says it closed is what the closed digest and every "done" report read.
    expect(world.ticket.closedAt).toBeNull();
    expect(world.ticket.resolvedAt).toBeNull();
  });

  it("clears a stale closedAt when an approval puts the ticket back in progress", async () => {
    // The audited case: the ticket was closed from the Tickets page while the change waited, then
    // the manager approved it. IN_PROGRESS with closedAt still set is a ticket that is both.
    const world = createChangeWorld({ change: { state: "AWAITING_APPROVAL", submittedAt: new Date() }, approvals: [{}] });
    world.ticket.status = "CLOSED";
    world.ticket.closedAt = new Date("2026-10-01T12:00:00.000Z");
    world.ticket.resolvedAt = new Date("2026-10-01T11:00:00.000Z");
    actor = ACTORS.manager;

    const decided = await request(buildChangeApp(changeRouter, world.client)).post(`/api/changes/${CHANGE_ID}/decision`).send({ decision: "APPROVED" });

    expect(decided.status).toBe(200);
    expect(world.ticket.status).toBe("IN_PROGRESS");
    expect(world.ticket.closedAt).toBeNull();
    expect(world.ticket.resolvedAt).toBeNull();
  });
});
