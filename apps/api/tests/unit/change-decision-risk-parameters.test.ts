/**
 * The approval re-check holds a change to the risk questions it was submitted against.
 *
 * THE DEFECT: the decision re-checks the submission requirements (so a change stripped after
 * submission cannot be approved), but read the risk parameters active NOW. A super admin adding a
 * parameter — or switching an old one back on — made every change already waiting for approval
 * unapprovable: "Risk assessment (1 of 3 unanswered) … Reject it", for a question that did not exist
 * when the requester submitted, and which they cannot answer without withdrawing.
 *
 * The re-check now uses the active parameters that have not changed since the round opened
 * (`updatedAt` ≤ the round's `createdAt`, which also means created before it). A newly added or
 * re-activated parameter is asked of the next submission, not of a round already in flight.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { ACTORS, CHANGE_ID, buildChangeApp, createChangeWorld } from "../helpers/change-world.js";

vi.mock("../../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/middleware/auth.js")>("../../src/middleware/auth.js");
  return {
    ...actual,
    requireAuth: (req: any, _res: unknown, next: () => void) => {
      req.user = ACTORS.manager;
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
vi.mock("../../src/services/change-mail.service.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/services/change-mail.service.js")>("../../src/services/change-mail.service.js");
  return { ...actual, sendChangeSubmittedMail: vi.fn(async () => undefined), sendChangeDecisionMail: vi.fn(async () => undefined) };
});

const { changeRouter } = await import("../../src/controllers/change.controller.js");

/** The round in the test world opened at this moment (see change-world's approval default). */
const ROUND_OPENED = new Date("2026-10-01T09:00:00.000Z");
const BEFORE = new Date("2026-09-01T09:00:00.000Z");
const AFTER = new Date("2026-10-02T09:00:00.000Z");

type Param = { key: string; weight: number; isActive: boolean; createdAt: Date; updatedAt: Date };

/** A risk-parameter table that answers `where` the way the database would. */
function withParameters(world: ReturnType<typeof createChangeWorld>, rows: Param[]) {
  world.client.changeRiskParameter.findMany.mockImplementation(async (args: any = {}) => {
    const where = args.where ?? {};
    return rows.filter(
      (p) =>
        (where.isActive === undefined || p.isActive === where.isActive) &&
        (!where.updatedAt?.lte || p.updatedAt.getTime() <= where.updatedAt.lte.getTime())
    );
  });
}

const old = (key: string): Param => ({ key, weight: 10, isActive: true, createdAt: BEFORE, updatedAt: BEFORE });

const waiting = (riskInputs: Record<string, string> = { impact: "HIGH", data: "HIGH" }) =>
  createChangeWorld({
    change: { state: "AWAITING_APPROVAL", submittedAt: ROUND_OPENED, riskInputs },
    approvals: [{ round: 1, status: "PENDING", approverId: "manager-1", createdAt: ROUND_OPENED }]
  });

const decide = (world: ReturnType<typeof createChangeWorld>) =>
  request(buildChangeApp(changeRouter, world.client)).post(`/api/changes/${CHANGE_ID}/decision`).send({ decision: "APPROVED" });

beforeEach(() => vi.clearAllMocks());

describe("the approval re-check's risk questions", () => {
  it("do not include a parameter added after the round opened", async () => {
    const world = waiting();
    withParameters(world, [old("impact"), old("data"), { key: "vendorRisk", weight: 10, isActive: true, createdAt: AFTER, updatedAt: AFTER }]);

    const res = await decide(world);

    expect(res.status).toBe(200);
    expect(world.change.state).toBe("APPROVED");
  });

  it("do not include an old parameter switched back on after the round opened", async () => {
    const world = waiting();
    withParameters(world, [old("impact"), old("data"), { key: "vendorRisk", weight: 10, isActive: true, createdAt: BEFORE, updatedAt: AFTER }]);

    const res = await decide(world);

    expect(res.status).toBe(200);
  });

  it("still include every question the change was submitted against, so a stripped answer still blocks", async () => {
    const world = waiting({ impact: "HIGH" });
    withParameters(world, [old("impact"), old("data")]);

    const res = await decide(world);

    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/risk assessment/i);
    expect(world.change.state).toBe("AWAITING_APPROVAL");
  });
});
