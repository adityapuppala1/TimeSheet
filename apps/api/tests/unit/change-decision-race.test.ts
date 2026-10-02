/**
 * A decision lands only on the round it read.
 *
 * THE DEFECT: the decision read the change (AWAITING_APPROVAL) and its pending approval row, then
 * wrote both by id with no condition. A withdraw to draft that committed between that read and those
 * writes was overwritten: the change the requester had taken back to rework came out APPROVED, and
 * its WITHDRAWN row was rewritten as the approval — so whatever the requester then changed in draft
 * stood approved without anybody having seen it.
 *
 * Both writes are now conditional (the row still PENDING, the change still AWAITING_APPROVAL), and a
 * decision that finds either moved is refused with a 409 instead of landing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { ACTORS, CHANGE_ID, buildChangeApp, createChangeWorld } from "../helpers/change-world.js";

let actor: Record<string, unknown> = ACTORS.manager;

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
vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn(async () => undefined) }));
const sendChangeDecisionMail = vi.fn(async () => undefined);
vi.mock("../../src/services/change-mail.service.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/services/change-mail.service.js")>("../../src/services/change-mail.service.js");
  return { ...actual, sendChangeSubmittedMail: vi.fn(async () => undefined), sendChangeDecisionMail: (...a: unknown[]) => sendChangeDecisionMail(...(a as [])) };
});

const { changeRouter } = await import("../../src/controllers/change.controller.js");

const awaiting = () =>
  createChangeWorld({ change: { state: "AWAITING_APPROVAL", submittedAt: new Date() }, approvals: [{ round: 1, status: "PENDING", approverId: "manager-1" }] });

/** Lets something else commit right after the decision has read the pending round — the window the
 *  race lives in. */
function afterPendingRead(world: ReturnType<typeof awaiting>, meanwhile: () => void) {
  const read = world.client.changeApproval.findMany.getMockImplementation()!;
  world.client.changeApproval.findMany.mockImplementationOnce(async (args: unknown) => {
    const rows = (await read(args)).map((r: Record<string, unknown>) => ({ ...r }));
    meanwhile();
    return rows;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  actor = ACTORS.manager;
});

describe("a decision racing another write", () => {
  it("loses to a withdraw that committed after it read the round: 409, and the change stays withdrawn", async () => {
    const world = awaiting();
    afterPendingRead(world, () => {
      // The requester's withdraw to draft, committed in between.
      world.change.state = "DRAFT";
      world.ticket.status = "OPEN";
      for (const a of world.approvals) a.status = "WITHDRAWN";
    });

    const res = await request(buildChangeApp(changeRouter, world.client)).post(`/api/changes/${CHANGE_ID}/decision`).send({ decision: "APPROVED" });

    expect(res.status).toBe(409);
    expect(world.change.state).toBe("DRAFT");
    expect(world.approvals.map((a) => a.status)).toEqual(["WITHDRAWN"]);
    expect(sendChangeDecisionMail).not.toHaveBeenCalled();
  });

  it("loses to another approver's decision on the same round: 409, and the first decision stands", async () => {
    const world = createChangeWorld({
      change: { state: "AWAITING_APPROVAL", submittedAt: new Date() },
      approvals: [
        { round: 1, status: "PENDING", approverId: "manager-1" },
        { round: 1, status: "PENDING", approverId: "sa-1", reason: "SUPER_ADMIN" }
      ]
    });
    afterPendingRead(world, () => {
      // The super admin rejected it first; the manager's row was superseded.
      world.change.state = "REJECTED";
      world.approvals[0].status = "CANCELLED";
      world.approvals[1].status = "REJECTED";
    });

    const res = await request(buildChangeApp(changeRouter, world.client)).post(`/api/changes/${CHANGE_ID}/decision`).send({ decision: "APPROVED" });

    expect(res.status).toBe(409);
    expect(world.change.state).toBe("REJECTED");
    expect(world.approvals.map((a) => a.status)).toEqual(["CANCELLED", "REJECTED"]);
  });

  it("still records an uncontested decision", async () => {
    const world = awaiting();
    const res = await request(buildChangeApp(changeRouter, world.client)).post(`/api/changes/${CHANGE_ID}/decision`).send({ decision: "APPROVED" });

    expect(res.status).toBe(200);
    expect(res.body.state).toBe("APPROVED");
    expect(world.change.state).toBe("APPROVED");
    expect(world.approvals.map((a) => a.status)).toEqual(["APPROVED"]);
  });
});
