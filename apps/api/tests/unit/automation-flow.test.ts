/**
 * The Studio's routes, driven through the REAL router.
 *
 * `flow-authority.test.ts` pins the rules themselves; this pins that the routes cannot go round
 * them — which is the failure mode of a builder, not of an engine. Specifically:
 *
 *   - A flow is created OFF, whatever the request says.
 *   - Activation reads the validation first, and refuses on any error.
 *   - The authority recorded at activation is the one the server computed, since "what was this
 *     allowed to do when somebody switched it on" is what an incident review asks.
 *   - Simulation writes nothing and says out loud that it calls no model.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const actor = { id: "admin-1", name: "Avery", email: "a@x.io", role: "SUPER_ADMIN", permissions: ["tickets:view"] as string[] };

const flowCreate = vi.fn();
const flowFindMany = vi.fn().mockResolvedValue([]);
const flowFindFirst = vi.fn();
const flowUpdate = vi.fn().mockResolvedValue({});
const stepDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
const stepCreateMany = vi.fn().mockResolvedValue({ count: 0 });
const ticketFindMany = vi.fn().mockResolvedValue([]);
const userFindMany = vi.fn().mockResolvedValue([{ id: "u-1", name: "Avery", email: "a@x.io" }]);
const isPlanningCapabilityAllowed = vi.fn().mockResolvedValue(true);
const resolveAutonomy = vi.fn();
const auditFn = vi.fn().mockResolvedValue(undefined);

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

const tx = {
  automationFlow: { create: flowCreate, update: flowUpdate },
  automationStep: { deleteMany: stepDeleteMany, createMany: stepCreateMany }
};

vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    automationFlow: { create: flowCreate, findMany: flowFindMany, findFirst: flowFindFirst, update: flowUpdate },
    automationStep: { deleteMany: stepDeleteMany, createMany: stepCreateMany },
    ticket: { findMany: ticketFindMany },
    user: { findMany: userFindMany },
    label: { findMany: vi.fn().mockResolvedValue([{ id: "l-1", name: "Urgent", color: "#f00" }]) },
    project: { findMany: vi.fn().mockResolvedValue([{ id: "p-1", code: "ACME", name: "Acme" }]) },
    requestFormSubmission: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: (fn: (client: typeof tx) => unknown) => (typeof fn === "function" ? fn(tx) : Promise.resolve([]))
  }
}));
vi.mock("../../src/config/tenant-context.js", () => ({ requireTenantContext: () => ({ orgId: "org-1", orgSlug: "acme" }) }));
vi.mock("../../src/services/plan-limits.service.js", () => ({
  isPlanningCapabilityAllowed: (...a: unknown[]) => isPlanningCapabilityAllowed(...a)
}));
vi.mock("../../src/services/ai-autonomy.service.js", () => ({ resolveAutonomy: (...a: unknown[]) => resolveAutonomy(...a) }));
vi.mock("../../src/services/audit.service.js", () => ({ audit: (...a: unknown[]) => auditFn(...a) }));
vi.mock("../../src/services/ai.service.js", () => ({ getGlobalAISettings: vi.fn().mockResolvedValue({ aiEnabled: true }) }));

const { automationFlowRouter } = await import("../../src/controllers/automation-flow.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");

function app() {
  const a = express();
  a.use(express.json());
  a.use("/flows", automationFlowRouter);
  a.use(errorHandler);
  return a;
}

/** A stored flow, with steps as the DB would return them. */
const flowRow = (over: Record<string, unknown> = {}) => ({
  id: "f-1",
  name: "Triage inbound",
  description: null,
  emoji: "⚙️",
  trigger: "MANUAL",
  triggerConfig: {},
  enabled: false,
  agentProfileId: null,
  agentProfile: null,
  createdBy: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
  steps: [{ id: "s-1", flowId: "f-1", order: 1, kind: "CAPABILITY", capability: "triage", config: {}, createdAt: new Date() }],
  ...over
});

beforeEach(() => {
  vi.clearAllMocks();
  actor.role = "SUPER_ADMIN";
  isPlanningCapabilityAllowed.mockResolvedValue(true);
  flowFindMany.mockResolvedValue([]);
  flowFindFirst.mockResolvedValue(flowRow());
  flowCreate.mockResolvedValue({ id: "f-1" });
  flowUpdate.mockResolvedValue({});
  ticketFindMany.mockResolvedValue([]);
  resolveAutonomy.mockResolvedValue({
    capability: "triage",
    requestedLevel: "AUTO_APPLY",
    effectiveLevel: "AUTO_APPLY",
    maxLevel: "AUTO_APPLY",
    clampedReason: null,
    guardrails: {}
  });
});

describe("a flow is created switched off", () => {
  it("ignores any attempt to create one already enabled", async () => {
    // `.strict()` refuses the field outright rather than quietly dropping it, which is the stronger
    // guarantee: a client cannot believe it succeeded.
    const withEnabled = await request(app()).post("/flows").send({ name: "X", steps: [], enabled: true });
    expect(withEnabled.status).toBe(422);

    const ok = await request(app()).post("/flows").send({ name: "X", steps: [{ kind: "ACTION" }] });
    expect(ok.status).toBe(201);
    expect(flowCreate.mock.calls[0][0].data.enabled).toBe(false);
  });

  it("assigns step order from array position, so a reordered builder cannot create gaps", async () => {
    await request(app())
      .post("/flows")
      .send({ name: "X", steps: [{ kind: "BRANCH" }, { kind: "CAPABILITY", capability: "triage" }, { kind: "ACTION" }] });
    expect(stepCreateMany.mock.calls[0][0].data.map((s: any) => s.order)).toEqual([1, 2, 3]);
  });

  it("drops a capability id from a non-capability step rather than storing a lie", async () => {
    await request(app()).post("/flows").send({ name: "X", steps: [{ kind: "ACTION", capability: "triage" }] });
    expect(stepCreateMany.mock.calls[0][0].data[0].capability).toBeNull();
  });
});

describe("activation reads the validation first", () => {
  it("refuses a flow whose gate is last, quoting the reason", async () => {
    flowFindFirst.mockResolvedValue(
      flowRow({
        steps: [
          { id: "s1", order: 1, kind: "CAPABILITY", capability: "triage", config: {} },
          // Configured, so the only thing wrong with this flow is WHERE the gate is — an unconfigured
          // gate is its own error, and would have this test passing for the wrong reason.
          { id: "s2", order: 2, kind: "HUMAN_GATE", capability: null, config: { approverId: "u-1" } }
        ]
      })
    );
    const res = await request(app()).post("/flows/f-1/enabled").send({ enabled: true });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/nothing left for anyone to approve/i);
    expect(flowUpdate).not.toHaveBeenCalled();
  });

  it("refuses an EVENT flow with no event chosen", async () => {
    flowFindFirst.mockResolvedValue(flowRow({ trigger: "EVENT", triggerConfig: {} }));
    const res = await request(app()).post("/flows/f-1/enabled").send({ enabled: true });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/event to listen for/i);
  });

  it("activates a valid flow and records the authority it resolved to", async () => {
    const res = await request(app()).post("/flows/f-1/enabled").send({ enabled: true });
    expect(res.status).toBe(200);
    expect(flowUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { enabled: true } }));
    // The audit row carries the authority AS COMPUTED AT ACTIVATION, because policies move.
    const [, action, , , meta] = auditFn.mock.calls.at(-1)!;
    expect(action).toBe("flow.activated");
    expect(meta).toMatchObject({ authority: "AUTO_APPLY", proposalOnly: false });
  });

  it("always allows DEACTIVATION, even for a flow that would now fail validation", async () => {
    // Otherwise a flow that became invalid (a retired teammate, a deleted form) could not be switched
    // off — the same deadlock the roster's disable-escape avoids.
    flowFindFirst.mockResolvedValue(flowRow({ trigger: "EVENT", triggerConfig: {}, enabled: true }));
    const res = await request(app()).post("/flows/f-1/enabled").send({ enabled: false });
    expect(res.status).toBe(200);
    expect(flowUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { enabled: false } }));
  });
});

describe("the authority the API reports is the one the rules compute", () => {
  it("reports SUGGEST and proposalOnly when a step resolves low", async () => {
    resolveAutonomy.mockResolvedValue({
      capability: "triage",
      requestedLevel: "AUTO_APPLY",
      effectiveLevel: "SUGGEST",
      maxLevel: "AUTO_APPLY",
      clampedReason: "AI autonomy is off for this workspace.",
      guardrails: {}
    });
    const res = await request(app()).get("/flows/f-1");
    expect(res.body.authority.effectiveLevel).toBe("SUGGEST");
    expect(res.body.authority.proposalOnly).toBe(true);
  });

  it("resolves each capability rather than trusting the registry ceiling", async () => {
    await request(app()).get("/flows/f-1");
    expect(resolveAutonomy).toHaveBeenCalledWith("triage");
  });
});

describe("simulation is a replay, and says so", () => {
  it("writes nothing at all", async () => {
    ticketFindMany.mockResolvedValue([{ id: "t-1", key: "WEB-1", title: "Login broken" }]);
    flowFindFirst.mockResolvedValue(flowRow({ trigger: "EVENT", triggerConfig: { event: "ticket.assigned" } }));
    const res = await request(app()).get("/flows/f-1/simulate");
    expect(res.status).toBe(200);
    expect(flowUpdate).not.toHaveBeenCalled();
    expect(stepCreateMany).not.toHaveBeenCalled();
  });

  it("states that no model is called, so nobody reads it as an execution", async () => {
    const res = await request(app()).get("/flows/f-1/simulate");
    expect(res.body.disclaimer).toMatch(/no model is called/i);
    expect(res.body.disclaimer).toMatch(/nothing is written/i);
  });

  it("explains an empty replay instead of returning a blank list", async () => {
    ticketFindMany.mockResolvedValue([]);
    flowFindFirst.mockResolvedValue(flowRow({ trigger: "EVENT", triggerConfig: { event: "ticket.assigned" } }));
    const res = await request(app()).get("/flows/f-1/simulate");
    expect(res.body.sampleCount).toBe(0);
    expect(res.body.noSamplesReason).toMatch(/no tickets/i);
  });

  it("stops at a gate and marks everything after it as not reached", async () => {
    flowFindFirst.mockResolvedValue(
      flowRow({
        steps: [
          { id: "s1", order: 1, kind: "HUMAN_GATE", capability: null, config: {} },
          { id: "s2", order: 2, kind: "CAPABILITY", capability: "triage", config: {} }
        ]
      })
    );
    const res = await request(app()).get("/flows/f-1/simulate");
    const steps = res.body.samples[0].steps;
    expect(steps[0].outcome).toBe("waits-for-approval");
    expect(steps[1].outcome).toBe("not-reached");
  });

  it("says 'would propose' rather than 'would run' for a proposal-only flow", async () => {
    resolveAutonomy.mockResolvedValue({
      capability: "triage",
      requestedLevel: "SUGGEST",
      effectiveLevel: "SUGGEST",
      maxLevel: "AUTO_APPLY",
      clampedReason: null,
      guardrails: {}
    });
    const res = await request(app()).get("/flows/f-1/simulate");
    expect(res.body.samples[0].steps[0].outcome).toBe("would-propose");
  });
});

describe("the gates", () => {
  it("fails closed without the AI copilot entitlement", async () => {
    isPlanningCapabilityAllowed.mockResolvedValue(false);
    const res = await request(app()).get("/flows");
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/not included in this plan/i);
  });

  it("lets a non-admin READ, since automation touching your work is your business", async () => {
    actor.role = "EMPLOYEE";
    expect((await request(app()).get("/flows")).status).toBe(200);
  });

  it("refuses every write from a non-super-admin", async () => {
    actor.role = "MANAGER";
    expect((await request(app()).post("/flows").send({ name: "X", steps: [] })).status).toBe(403);
    expect((await request(app()).post("/flows/f-1/enabled").send({ enabled: true })).status).toBe(403);
    expect((await request(app()).delete("/flows/f-1")).status).toBe(403);
  });
});

/**
 * The catalogue is what every picker in the builder renders from, so its SHAPE is a contract: an
 * action that names a target the response has no list for is a dropdown with nothing in it.
 */
describe("the catalogue carries what the pickers need", () => {
  it("returns each action with the config key it fills and the list it draws from", async () => {
    const res = await request(app()).get("/flows/catalogue");
    expect(res.status).toBe(200);
    for (const action of res.body.actions) {
      expect(typeof action.target).toBe("string");
      expect(res.body[action.options]).toBeInstanceOf(Array);
    }
    for (const field of res.body.branchFields) {
      // Every branch field must offer SOME way to state a value, or the condition cannot be written.
      expect(Boolean(field.values || field.options || field.freeText)).toBe(true);
    }
  });

  it("never offers an agent identity as a person to notify or ask for approval", async () => {
    await request(app()).get("/flows/catalogue");
    expect(userFindMany.mock.calls[0][0].where).toMatchObject({ isAgent: false, status: "ACTIVE" });
  });
});
