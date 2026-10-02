/**
 * What an approver decides on cannot move underneath them.
 *
 * THE DEFECT: the plan froze only at APPROVED, and a change manager was exempt in every state. So:
 *   - a requester could submit a HIGH-risk change with a backout plan, then — while it sat in
 *     AWAITING_APPROVAL — delete the plan and answer every risk question LOW, and the manager's
 *     approval was recorded against a change that no longer met what approval requires, because the
 *     decision never re-checked it;
 *   - an ADMIN could raise a change, have their manager approve it, then rewrite the plan or move
 *     the window into a blackout with no re-approval at all.
 *
 * The rules pinned here (the integrator's decision):
 *   - From AWAITING_APPROVAL on, the MATERIAL fields — plans, risk inputs, schedule, type — are
 *     locked for everyone. Editing them means withdrawing the change to draft, which settles the
 *     pending round as WITHDRAWN so it stays on the record.
 *   - A change manager's material edit to an APPROVED or SCHEDULED change sends it back to
 *     AWAITING_APPROVAL with a new round: a material change after approval needs re-authorising.
 *   - Wording and people (title, description, implementer) stay editable throughout.
 *   - The decision re-checks the submission requirements before it writes APPROVED.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { ACTORS, CHANGE_ID, buildChangeApp, createChangeWorld } from "../helpers/change-world.js";

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
const sendChangeSubmittedMail = vi.fn(async () => undefined);
vi.mock("../../src/services/change-mail.service.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/services/change-mail.service.js")>("../../src/services/change-mail.service.js");
  return {
    ...actual,
    sendChangeSubmittedMail: (...a: unknown[]) => sendChangeSubmittedMail(...(a as [])),
    sendChangeDecisionMail: vi.fn(async () => undefined)
  };
});

const { changeRouter } = await import("../../src/controllers/change.controller.js");

const awaiting = () =>
  createChangeWorld({ change: { state: "AWAITING_APPROVAL", submittedAt: new Date() }, approvals: [{ round: 1, status: "PENDING", approverId: "manager-1" }] });

const approved = (over: Record<string, unknown> = {}) =>
  createChangeWorld({
    change: { state: "APPROVED", submittedAt: new Date(Date.now() - 86400000), approvedAt: new Date(), ...over },
    approvals: [{ round: 1, status: "APPROVED", approverId: "manager-1", decidedAt: new Date() }]
  });

beforeEach(() => {
  vi.clearAllMocks();
  actor = ACTORS.requester;
});

describe("while a change waits for approval", () => {
  it("refuses the requester stripping the backout plan", async () => {
    const world = awaiting();
    const res = await request(buildChangeApp(changeRouter, world.client)).patch(`/api/changes/${CHANGE_ID}`).send({ backoutPlan: null });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/withdraw/i);
    expect(world.change.backoutPlan).toBe("<p>Restore the old one</p>");
  });

  it("refuses the requester lowering the risk answers", async () => {
    const world = awaiting();
    const res = await request(buildChangeApp(changeRouter, world.client))
      .patch(`/api/changes/${CHANGE_ID}`)
      .send({ riskInputs: { impact: "LOW", data: "LOW" } });

    expect(res.status).toBe(409);
    expect(world.change.riskLevel).toBe("HIGH");
  });

  it("refuses a change manager too, on a change they raised themselves", async () => {
    const world = awaiting();
    world.ticket.reporterId = "admin-1";
    actor = ACTORS.admin;

    const res = await request(buildChangeApp(changeRouter, world.client))
      .patch(`/api/changes/${CHANGE_ID}`)
      .send({ plannedStart: "2026-12-24T10:00:00.000Z" });

    expect(res.status).toBe(409);
  });

  it("still lets the wording and the implementer be edited", async () => {
    const world = awaiting();
    const res = await request(buildChangeApp(changeRouter, world.client))
      .patch(`/api/changes/${CHANGE_ID}`)
      .send({ title: "Rotate the TLS certificate on the edge", implementerId: "33333333-3333-4333-8333-333333333333" });

    expect(res.status).toBe(200);
    expect(world.ticket.title).toBe("Rotate the TLS certificate on the edge");
  });

  it("does not count re-saving a field with the value it already has as an edit", async () => {
    // The form saves on blur, and a select can fire with its own value. That is not a change to the
    // plan, and refusing it would put an error toast on somebody who changed nothing.
    const world = awaiting();
    const res = await request(buildChangeApp(changeRouter, world.client))
      .patch(`/api/changes/${CHANGE_ID}`)
      .send({ backoutPlan: "<p>Restore the old one</p>", plannedStart: "2026-11-01T10:00:00.000Z", riskInputs: { data: "HIGH", impact: "HIGH" } });

    expect(res.status).toBe(200);
  });

  it("can be withdrawn to draft, which records the pending round as withdrawn and unlocks the plan", async () => {
    const world = awaiting();
    const app = buildChangeApp(changeRouter, world.client);

    const withdrawn = await request(app).post(`/api/changes/${CHANGE_ID}/transition`).send({ to: "DRAFT" });

    expect(withdrawn.status).toBe(200);
    expect(world.change.state).toBe("DRAFT");
    expect(world.approvals).toEqual([expect.objectContaining({ round: 1, status: "WITHDRAWN" })]);
    expect((await request(app).patch(`/api/changes/${CHANGE_ID}`).send({ backoutPlan: "<p>A better way back</p>" })).status).toBe(200);
  });

  it("settles the pending round as cancelled when the change itself is cancelled", async () => {
    const world = awaiting();
    await request(buildChangeApp(changeRouter, world.client)).post(`/api/changes/${CHANGE_ID}/transition`).send({ to: "CANCELLED" });
    expect(world.approvals).toEqual([expect.objectContaining({ round: 1, status: "CANCELLED" })]);
  });

  it("tells the page which fields are locked and that withdrawing is a move it can offer", async () => {
    const world = awaiting();
    const res = await request(buildChangeApp(changeRouter, world.client)).get(`/api/changes/${CHANGE_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.lockedFields).toEqual(expect.arrayContaining(["backoutPlan", "riskInputs", "plannedStart", "changeKind"]));
    expect(res.body.lockedFields).not.toContain("title");
    expect(res.body.allowedTransitions).toEqual(expect.arrayContaining(["DRAFT", "CANCELLED"]));
    expect(res.body.editReopensApproval).toBe(false);
  });
});

describe("the decision", () => {
  it("re-checks what approval requires before recording an approval", async () => {
    // A change that reached AWAITING_APPROVAL complete and was then stripped by the old, unlocked
    // edit path — the rows that already exist in the wild.
    const world = createChangeWorld({ change: { state: "AWAITING_APPROVAL", submittedAt: new Date(), backoutPlan: null }, approvals: [{}] });
    actor = ACTORS.manager;

    const res = await request(buildChangeApp(changeRouter, world.client)).post(`/api/changes/${CHANGE_ID}/decision`).send({ decision: "APPROVED" });

    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/backout plan/i);
    expect(world.change.state).toBe("AWAITING_APPROVAL");
  });

  it("still lets the approver reject it", async () => {
    const world = createChangeWorld({ change: { state: "AWAITING_APPROVAL", submittedAt: new Date(), backoutPlan: null }, approvals: [{}] });
    actor = ACTORS.manager;

    const res = await request(buildChangeApp(changeRouter, world.client)).post(`/api/changes/${CHANGE_ID}/decision`).send({ decision: "REJECTED" });

    expect(res.status).toBe(200);
    expect(world.change.state).toBe("REJECTED");
  });

  it("records what was approved — risk, window and a fingerprint of the plans — on the audit row", async () => {
    const world = awaiting();
    actor = ACTORS.manager;

    await request(buildChangeApp(changeRouter, world.client)).post(`/api/changes/${CHANGE_ID}/decision`).send({ decision: "APPROVED" });

    const call = (audit.mock.calls as unknown[][]).find((c) => c[1] === "change.approved");
    expect(call?.[4]).toMatchObject({
      approved: {
        riskScore: 100,
        riskLevel: "HIGH",
        plannedStart: "2026-11-01T10:00:00.000Z",
        plannedEnd: "2026-11-01T11:00:00.000Z",
        plansSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
      }
    });
  });
});

describe("after approval", () => {
  it("sends a change manager's material edit back for approval, as a new round", async () => {
    const world = approved();
    actor = ACTORS.admin;

    const res = await request(buildChangeApp(changeRouter, world.client))
      .patch(`/api/changes/${CHANGE_ID}`)
      .send({ plannedStart: "2026-12-24T10:00:00.000Z", plannedEnd: "2026-12-24T11:00:00.000Z" });

    expect(res.status).toBe(200);
    expect(world.change.state).toBe("AWAITING_APPROVAL");
    expect(world.change.approvedAt).toBeNull();
    expect(world.ticket.status).toBe("IN_REVIEW");
    // Round 1's approval stays on the record; round 2 asks again.
    expect(world.approvals.map((a) => [a.round, a.status])).toEqual([
      [1, "APPROVED"],
      [2, "PENDING"]
    ]);
    expect(sendChangeSubmittedMail).toHaveBeenCalledWith(expect.objectContaining({ id: CHANGE_ID }), expect.anything(), ["manager-1"]);
  });

  it("leaves it approved when a change manager only rewords it", async () => {
    const world = approved();
    actor = ACTORS.admin;

    const res = await request(buildChangeApp(changeRouter, world.client)).patch(`/api/changes/${CHANGE_ID}`).send({ title: "Rotate the edge certificate" });

    expect(res.status).toBe(200);
    expect(world.change.state).toBe("APPROVED");
    expect(world.approvals).toHaveLength(1);
  });

  it("refuses a material edit that would leave the change unable to be approved again", async () => {
    // Re-approval re-enters the submission gate. A HIGH-risk change with its backout plan deleted
    // could not be submitted, so it cannot be sent back for approval either.
    const world = approved();
    actor = ACTORS.admin;

    const res = await request(buildChangeApp(changeRouter, world.client)).patch(`/api/changes/${CHANGE_ID}`).send({ backoutPlan: null });

    expect(res.status).toBe(422);
    expect(world.change.state).toBe("APPROVED");
  });

  it("refuses the requester's material edit, as before", async () => {
    const world = approved();
    const res = await request(buildChangeApp(changeRouter, world.client)).patch(`/api/changes/${CHANGE_ID}`).send({ implementationPlan: "<p>Something else</p>" });
    expect(res.status).toBe(409);
  });

  it("tells a change manager's page that editing the plan will reopen approval", async () => {
    const world = approved();
    actor = ACTORS.admin;
    const res = await request(buildChangeApp(changeRouter, world.client)).get(`/api/changes/${CHANGE_ID}`);
    expect(res.body.editReopensApproval).toBe(true);
    expect(res.body.lockedFields).toEqual([]);
  });

  it("refuses even a change manager once implementation has started", async () => {
    const world = approved({ state: "IMPLEMENTING", actualStart: new Date() });
    actor = ACTORS.admin;

    const res = await request(buildChangeApp(changeRouter, world.client)).patch(`/api/changes/${CHANGE_ID}`).send({ implementationPlan: "<p>Something else</p>" });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/new change/i);
  });
});

describe("the drafting assistant", () => {
  it("will not draft into a change that is waiting for approval", async () => {
    const world = awaiting();
    const res = await request(buildChangeApp(changeRouter, world.client)).post(`/api/changes/${CHANGE_ID}/draft-assist`).send({});
    expect(res.status).toBe(409);
  });
});
