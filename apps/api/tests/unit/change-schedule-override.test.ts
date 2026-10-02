/**
 * Going ahead in a window that collides costs a written reason.
 *
 * THE DEFECT: blackout periods and overlapping changes are reported, not refused — on purpose,
 * because two changes sometimes genuinely share a window. The code said an override "costs a
 * written reason and an audit row", and the Schedule tab has an "Override reason" field, but nothing
 * ever required it: a change could be scheduled, and started, straight into a company-wide freeze
 * with the field empty.
 *
 * What is pinned: moving a change to SCHEDULED or IMPLEMENTING while its window collides needs the
 * reason recorded (422 naming the collision otherwise); with no collision nothing is asked; and the
 * requester or implementer can record the reason after approval — it is the record of a scheduling
 * decision, not an edit to what was approved.
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
vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("../../src/services/change-mail.service.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/services/change-mail.service.js")>("../../src/services/change-mail.service.js");
  return { ...actual, sendChangeSubmittedMail: vi.fn(async () => undefined), sendChangeDecisionMail: vi.fn(async () => undefined) };
});

const { changeRouter } = await import("../../src/controllers/change.controller.js");

/** An approved change whose window falls inside the year-end freeze. */
function inTheFreeze(over: Record<string, unknown> = {}) {
  const world = createChangeWorld({ change: { state: "APPROVED", submittedAt: new Date(), approvedAt: new Date(), ...over } });
  world.client.blackoutPeriod.findMany.mockResolvedValue([
    { name: "Year-end freeze", startsAt: new Date("2026-10-30T00:00:00.000Z"), endsAt: new Date("2026-11-03T00:00:00.000Z") }
  ]);
  return world;
}

beforeEach(() => {
  vi.clearAllMocks();
  actor = ACTORS.requester;
});

describe("scheduling into a window that collides", () => {
  it("is refused until a reason is recorded, naming what it collides with", async () => {
    const world = inTheFreeze();
    const res = await request(buildChangeApp(changeRouter, world.client)).post(`/api/changes/${CHANGE_ID}/transition`).send({ to: "SCHEDULED" });

    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/Year-end freeze/);
    expect(res.body.message).toMatch(/override reason/i);
    expect(world.change.state).toBe("APPROVED");
  });

  it("goes ahead once the reason is recorded", async () => {
    const world = inTheFreeze({ conflictOverrideReason: "The certificate expires on 1 November; the freeze owner agreed.", conflictOverridden: true });
    const res = await request(buildChangeApp(changeRouter, world.client)).post(`/api/changes/${CHANGE_ID}/transition`).send({ to: "SCHEDULED" });

    expect(res.status).toBe(200);
    expect(world.change.state).toBe("SCHEDULED");
  });

  it("is refused for starting implementation straight from approval, too", async () => {
    const world = inTheFreeze();
    const res = await request(buildChangeApp(changeRouter, world.client)).post(`/api/changes/${CHANGE_ID}/transition`).send({ to: "IMPLEMENTING" });
    expect(res.status).toBe(422);
  });

  it("asks for nothing when the window is clear", async () => {
    const world = createChangeWorld({ change: { state: "APPROVED", submittedAt: new Date(), approvedAt: new Date() } });
    const res = await request(buildChangeApp(changeRouter, world.client)).post(`/api/changes/${CHANGE_ID}/transition`).send({ to: "SCHEDULED" });
    expect(res.status).toBe(200);
  });

  it("lets the requester record the reason after approval — it is not an edit to what was approved", async () => {
    const world = inTheFreeze();
    const res = await request(buildChangeApp(changeRouter, world.client))
      .patch(`/api/changes/${CHANGE_ID}`)
      .send({ conflictOverrideReason: "The certificate expires on 1 November." });

    expect(res.status).toBe(200);
    expect(world.change.conflictOverridden).toBe(true);
    expect(world.change.state).toBe("APPROVED");
  });
});
