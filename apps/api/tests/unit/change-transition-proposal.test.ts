/**
 * A workflow that may only PROPOSE moving a change records a proposal that can actually be applied.
 *
 * THE DEFECT: in a proposal-only flow, "Move a change" recorded `{targetType: "TICKET", before:
 * {state}, after: {state}}`. A ticket has no `state` column, so applying it always failed its
 * staleness check (`"state" has changed since this was suggested`), and even past that the ticket
 * allowlist would have dropped the field. Every such proposal was dead on arrival.
 *
 * What is pinned: the proposal targets the CHANGE; applying it runs the same move the change page
 * makes — the gates, the approval round, the email — as the person applying it, who must be allowed
 * to make that move by hand; a change that has moved since is refused, as every stale proposal is;
 * and a lifecycle move is not something undo can put back.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHANGE_ID, TICKET_ID, createChangeWorld, inTenant } from "../helpers/change-world.js";

vi.mock("../../src/services/plan-limits.service.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/services/plan-limits.service.js")>("../../src/services/plan-limits.service.js");
  return { ...actual, isPlanningCapabilityAllowed: vi.fn(async () => true) };
});
vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn(async () => undefined) }));
const sendChangeSubmittedMail = vi.fn(async () => undefined);
vi.mock("../../src/services/change-mail.service.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/services/change-mail.service.js")>("../../src/services/change-mail.service.js");
  return { ...actual, sendChangeSubmittedMail: (...a: unknown[]) => sendChangeSubmittedMail(...(a as [])), sendChangeDecisionMail: vi.fn(async () => undefined) };
});
vi.mock("../../src/services/notify.service.js", () => ({ dispatchNotification: vi.fn(async () => undefined) }));
const getFlow = vi.fn();
vi.mock("../../src/services/automation-flow.service.js", () => ({ getFlow: (...a: unknown[]) => getFlow(...a) }));

const { startFlowRun } = await import("../../src/services/automation-dispatch.service.js");
const { applyProposal, undoProposal } = await import("../../src/services/ai-proposal.service.js");

/** The world, plus the flow-run bookkeeping and a small proposal store the real createProposal and
 *  applyProposal write to and read from. */
function worldWithProposals(seed: Parameters<typeof createChangeWorld>[0] = {}) {
  const world = createChangeWorld(seed);
  const proposals: any[] = [];
  Object.assign(world.client, {
    automationFlowRun: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: "run-1" })),
      update: vi.fn(async () => ({})),
      count: vi.fn(async () => 1)
    },
    automationFlowRunStep: { create: vi.fn(async () => ({})), deleteMany: vi.fn(async () => ({ count: 0 })) },
    agentProfile: { findUnique: vi.fn(async () => null) },
    aiProposal: {
      create: vi.fn(async (args: any) => {
        const row = {
          id: `prop-${proposals.length + 1}`,
          ...args.data,
          changes: args.data.changes.create.map((c: any, i: number) => ({ id: `row-${i + 1}`, accepted: null, appliedAt: null, undoneAt: null, ...c }))
        };
        proposals.push(row);
        return row;
      }),
      findUnique: vi.fn(async (args: any) => proposals.find((p) => p.id === args.where.id) ?? null),
      update: vi.fn(async (args: any) => Object.assign(proposals.find((p) => p.id === args.where.id), args.data))
    },
    aiProposalChange: {
      update: vi.fn(async (args: any) => {
        const row = proposals.flatMap((p) => p.changes).find((c: any) => c.id === args.where.id);
        return Object.assign(row, args.data);
      })
    }
  });
  return { ...world, proposals };
}

const proposeOnlyFlow = (toState: string) => ({
  id: "flow-1",
  name: "Submit when ready",
  emoji: "X",
  enabled: true,
  activatable: true,
  agentProfile: null,
  createdBy: { id: "requester-1", name: "Riya Requester", email: "riya@acme.io" },
  steps: [{ id: "s-1", order: 1, kind: "ACTION", capability: null, title: null, summary: null, config: { action: "change_transition", toState } }],
  authority: { effectiveLevel: "SUGGEST", limitedBy: null, taintedFrom: null, proposalOnly: true, gatedBeforeWrites: false, steps: [] },
  issues: []
});

const subject = { type: "ticket" as const, id: TICKET_ID, label: "HICS-20261002-0001 — Rotate the TLS certificate", projectId: "project-1" };

async function propose(world: ReturnType<typeof worldWithProposals>, toState = "AWAITING_APPROVAL") {
  getFlow.mockResolvedValue(proposeOnlyFlow(toState));
  await inTenant(world.client, () => startFlowRun({ flowId: "flow-1", trigger: "event:ticket.commented", subject, triggerKey: `flow:flow-1:ticket:${TICKET_ID}` }));
  return world.proposals[0];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a proposal-only flow that moves a change", () => {
  it("records the move against the CHANGE, from the state it was computed against, and moves nothing yet", async () => {
    const world = worldWithProposals();
    const proposal = await propose(world);

    expect(proposal.changes).toEqual([
      expect.objectContaining({ targetType: "CHANGE", targetId: CHANGE_ID, op: "UPDATE", before: { state: "DRAFT" }, after: { state: "AWAITING_APPROVAL" } })
    ]);
    expect(world.change.state).toBe("DRAFT");
  });

  it("makes the real move when the requester accepts it — round, timestamps, email", async () => {
    const world = worldWithProposals();
    const proposal = await propose(world);

    const result = await inTenant(world.client, () => applyProposal({ proposalId: proposal.id, decisions: { "row-1": true }, actorId: "requester-1" }));

    expect(result).toMatchObject({ applied: 1, failed: [] });
    expect(world.change.state).toBe("AWAITING_APPROVAL");
    expect(world.change.submittedAt).toBeInstanceOf(Date);
    expect(world.approvals).toEqual([expect.objectContaining({ round: 1, approverId: "manager-1", status: "PENDING" })]);
    expect(sendChangeSubmittedMail).toHaveBeenCalledWith(expect.objectContaining({ id: CHANGE_ID }), expect.anything(), ["manager-1"]);
  });

  it("is refused, with the reason on the row, when the change has moved since", async () => {
    const world = worldWithProposals();
    const proposal = await propose(world);
    world.change.state = "CANCELLED";

    const result = await inTenant(world.client, () => applyProposal({ proposalId: proposal.id, decisions: { "row-1": true }, actorId: "requester-1" }));

    expect(result.applied).toBe(0);
    expect(result.failed[0].reason).toMatch(/"state" has changed/);
    expect(world.change.state).toBe("CANCELLED");
  });

  it("re-runs the gates at apply time — a change that stopped being ready is not submitted", async () => {
    const world = worldWithProposals();
    const proposal = await propose(world);
    world.change.backoutPlan = null;

    const result = await inTenant(world.client, () => applyProposal({ proposalId: proposal.id, decisions: { "row-1": true }, actorId: "requester-1" }));

    expect(result.applied).toBe(0);
    expect(result.failed[0].reason).toMatch(/backout plan/i);
    expect(world.approvals).toEqual([]);
  });

  it("is refused for somebody who could not make that move by hand", async () => {
    // The manager can see the proposal (it is in their report's project), but they are neither the
    // requester, the implementer nor a change manager — the transition route would refuse them.
    const world = worldWithProposals();
    const proposal = await propose(world);

    const result = await inTenant(world.client, () => applyProposal({ proposalId: proposal.id, decisions: { "row-1": true }, actorId: "manager-1" }));

    expect(result.applied).toBe(0);
    expect(result.failed[0].reason).toMatch(/requester, its implementer, or a change manager/i);
    expect(world.change.state).toBe("DRAFT");
  });

  it("cannot be undone by writing the old state back", async () => {
    // Putting `state` back would walk the change past every gate in reverse. A move is undone by
    // making the opposite move, from the change's page.
    const world = worldWithProposals();
    const proposal = await propose(world);
    await inTenant(world.client, () => applyProposal({ proposalId: proposal.id, decisions: { "row-1": true }, actorId: "requester-1" }));

    const undone = await inTenant(world.client, () => undoProposal({ proposalId: proposal.id, actorId: "requester-1" }));

    expect(undone.undone).toBe(0);
    expect(undone.refused[0].reason).toMatch(/move it back from the change/i);
    expect(world.change.state).toBe("AWAITING_APPROVAL");
  });
});
