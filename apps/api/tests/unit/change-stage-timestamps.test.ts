/**
 * Re-entering a lifecycle stage starts that stage's clock again.
 *
 * THE DEFECT: every stage timestamp was written `existing.X ?? now` and never cleared, so the FIRST
 * pass through a stage was the only one that counted:
 *   - after VALIDATION → IMPLEMENTING (rework), the implementation clock read MET while the rework
 *     was running, and validation read as started — and soon BREACHED — for work not yet handed over;
 *   - after a rejection and a resubmission, the approval clock ran from round 1's submission, so
 *     round 2 could read MET or BREACHED before anybody had looked at it, and `avgApprovalHours`
 *     counted the whole rework as approval time.
 *
 * What is pinned: a backward move clears the stages downstream of where the change lands,
 * `submittedAt` belongs to the current approval round, and the average approval time is measured
 * per round, from the round's own opening to its decision.
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
  return { ...actual, assertTicketVisible: vi.fn(async () => undefined), ticketProjectScope: vi.fn(async () => ({ unrestricted: true, projectIds: [] })) };
});
vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("../../src/services/change-mail.service.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/services/change-mail.service.js")>("../../src/services/change-mail.service.js");
  return { ...actual, sendChangeSubmittedMail: vi.fn(async () => undefined), sendChangeDecisionMail: vi.fn(async () => undefined) };
});

const { changeRouter } = await import("../../src/controllers/change.controller.js");
const { judgeChangeSlas } = await import("../../src/services/change.service.js");

const DAY = 24 * 3600 * 1000;
const SLA = { APPROVAL: { hours: 48, warnAtPct: 80 }, IMPLEMENTATION: { hours: 4, warnAtPct: 80 }, VALIDATION: { hours: 24, warnAtPct: 80 } };

beforeEach(() => {
  vi.clearAllMocks();
  actor = ACTORS.requester;
});

describe("sending a change back for rework", () => {
  it("re-opens implementation: its clock runs again and validation has not started", async () => {
    const started = new Date(Date.now() - 2 * 3600 * 1000);
    const handedOver = new Date(Date.now() - 3600 * 1000);
    const world = createChangeWorld({
      change: { state: "VALIDATION", submittedAt: new Date(Date.now() - 3 * DAY), approvedAt: new Date(Date.now() - 2 * DAY), actualStart: started, actualEnd: handedOver }
    });

    const moved = await request(buildChangeApp(changeRouter, world.client)).post(`/api/changes/${CHANGE_ID}/transition`).send({ to: "IMPLEMENTING" });

    expect(moved.status).toBe(200);
    // The START stays: the work began then. The END is what the rework undid.
    expect(world.change.actualStart).toEqual(started);
    expect(world.change.actualEnd).toBeNull();
    const clocks = judgeChangeSlas(world.change as never, SLA, new Date());
    expect(clocks.IMPLEMENTATION.state).not.toBe("MET");
    expect(clocks.VALIDATION.state).toBe("NOT_STARTED");
  });

  it("stamps the hand-over afresh when the rework is finished", async () => {
    const world = createChangeWorld({
      change: { state: "IMPLEMENTING", actualStart: new Date(Date.now() - 2 * DAY), actualEnd: null }
    });
    const before = Date.now();

    await request(buildChangeApp(changeRouter, world.client)).post(`/api/changes/${CHANGE_ID}/transition`).send({ to: "VALIDATION" });

    expect((world.change.actualEnd as Date).getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe("resubmitting after a rejection", () => {
  it("starts round 2's approval clock at round 2's submission, not round 1's", async () => {
    const firstSubmission = new Date(Date.now() - 10 * DAY);
    const world = createChangeWorld({
      change: { state: "REJECTED", submittedAt: firstSubmission },
      approvals: [{ round: 1, status: "REJECTED", decidedAt: new Date(Date.now() - 9 * DAY), createdAt: firstSubmission }]
    });
    const app = buildChangeApp(changeRouter, world.client);

    expect((await request(app).post(`/api/changes/${CHANGE_ID}/transition`).send({ to: "DRAFT" })).status).toBe(200);
    // Back in draft, nothing is being approved — a running approval clock on a draft is the bug.
    expect(world.change.submittedAt).toBeNull();

    const before = Date.now();
    expect((await request(app).post(`/api/changes/${CHANGE_ID}/transition`).send({ to: "AWAITING_APPROVAL" })).status).toBe(200);

    expect((world.change.submittedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect(judgeChangeSlas(world.change as never, SLA, new Date()).APPROVAL.state).toBe("ON_TRACK");
    // Round 1 stays on the record as it was decided.
    expect(world.approvals.map((a) => [a.round, a.status])).toEqual([
      [1, "REJECTED"],
      [2, "PENDING"]
    ]);
  });

  it("clears every later stage when a cancelled change is reopened as a draft", async () => {
    const world = createChangeWorld({
      change: {
        state: "CANCELLED",
        submittedAt: new Date(Date.now() - 5 * DAY),
        approvedAt: new Date(Date.now() - 4 * DAY),
        actualStart: new Date(Date.now() - 3 * DAY),
        actualEnd: null
      }
    });

    await request(buildChangeApp(changeRouter, world.client)).post(`/api/changes/${CHANGE_ID}/transition`).send({ to: "DRAFT" });

    expect(world.change).toMatchObject({ state: "DRAFT", submittedAt: null, approvedAt: null, actualStart: null, actualEnd: null });
  });
});

describe("the average approval time on the dashboard", () => {
  it("is measured per round — the rework between rounds is not approval time", async () => {
    // Round 1 opened day 0 and was rejected on day 1. Round 2 opened day 9 and was approved on day
    // 10. The change row still says submitted day 0, approved day 10 — 240 hours, of which 24 were
    // anybody deciding anything.
    const day0 = new Date("2026-09-01T00:00:00.000Z");
    const at = (days: number) => new Date(day0.getTime() + days * DAY);
    const changeRow = { state: "APPROVED", submittedAt: day0, approvedAt: at(10), actualStart: null, actualEnd: null, closedAt: null };
    const client = {
      changeRequest: {
        groupBy: vi.fn(async () => []),
        findMany: vi.fn(async (args: any) => (args.where?.submittedAt ? [changeRow] : []))
      },
      changeApproval: {
        count: vi.fn(async () => 0),
        findMany: vi.fn(async (args: any) =>
          [
            { status: "REJECTED", createdAt: day0, decidedAt: at(1) },
            { status: "APPROVED", createdAt: at(9), decidedAt: at(10) }
          ].filter((r) => !args.where?.status || r.status === args.where.status)
        )
      },
      changeSlaConfig: { findMany: vi.fn(async () => []) },
      globalChangeSettings: { upsert: vi.fn(async () => ({ id: "global", enableChangeManagement: true })) }
    };

    const metrics = await request(buildChangeApp(changeRouter, client)).get("/api/changes/metrics");

    expect(metrics.status).toBe(200);
    expect(metrics.body.avgApprovalHours).toBe(24);
  });
});
