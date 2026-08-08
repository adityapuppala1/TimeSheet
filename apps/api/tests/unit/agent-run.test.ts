/**
 * The agent run envelope.
 *
 * The loop is the easy part. What this file pins is everything the loop would be allowed to do
 * while nobody is watching:
 *
 *   - one logical trigger produces one run, even when the trigger fires twice;
 *   - a run acts as a named person, and is refused if that person is gone;
 *   - the level is frozen when the run is queued, so editing the policy underneath a running agent
 *     cannot widen what it may do;
 *   - once a tool carrying stranger-authored text returns, the run cannot write again;
 *   - a run can only reach the tools its capability declares;
 *   - a run left behind by a restart lands in a terminal state instead of being retried forever.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";
import type { PrismaClient } from "@prisma/client";

const resolveAutonomyMock = vi.fn();
vi.mock("../../src/services/ai-autonomy.service.js", () => ({
  resolveAutonomy: resolveAutonomyMock,
  assertLevelAtLeast: vi.fn().mockResolvedValue({})
}));

const loadRequestUserMock = vi.fn();
vi.mock("../../src/services/principal.service.js", () => ({
  loadRequestUser: loadRequestUserMock,
  AGENT_SYSTEM_EMAIL: "ai-agent@system.local"
}));

const invokeMcpToolMock = vi.fn().mockResolvedValue({ ok: true });
vi.mock("../../src/services/mcp-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/mcp-tools.js")>()),
  invokeMcpTool: invokeMcpToolMock
}));

const rebalanceMock = vi.fn().mockResolvedValue({ proposalId: "prop-1", reason: null, heldForReview: null, moves: 2 });
vi.mock("../../src/services/ai-rebalance.service.js", () => ({ proposeAssignmentRebalance: rebalanceMock }));

const { queueAgentRun, executeAgentRun, requestAbort, callToolForRun, reapOrphanedRuns } = await import(
  "../../src/services/agent-run.service.js"
);

let client: PrismaClient;
const ACTOR = { id: "u1", name: "Ana", email: "ana@x.io", role: "MANAGER", permissions: ["plan:write"] };

const QUEUE = {
  capability: "assignment_rebalance",
  trigger: "cron",
  triggerKey: "cron:assignment_rebalance:proj-1:2026-08-09",
  onBehalfOfId: "u1",
  scopeProjectId: "proj-1"
};

beforeEach(() => {
  client = createFakeTenantClient();
  resolveAutonomyMock.mockReset().mockResolvedValue({
    effectiveLevel: "AUTO_APPLY",
    guardrails: { maxCostUsdPerRun: null, maxChangesPerRun: null, maxRunsPerDay: null, undoWindowHours: null, scopeProjectIds: null }
  });
  loadRequestUserMock.mockReset().mockResolvedValue(ACTOR);
  invokeMcpToolMock.mockClear().mockResolvedValue({ ok: true });
  rebalanceMock.mockClear().mockResolvedValue({ proposalId: "prop-1", reason: null, heldForReview: null, moves: 2 });
  vi.mocked(client.agentRun.findUnique).mockResolvedValue(null as never);
  vi.mocked(client.agentRun.create).mockResolvedValue({ id: "run-1" } as never);
  vi.mocked(client.agentRun.update).mockResolvedValue({ id: "run-1", capability: "assignment_rebalance", status: "COMPLETED", onBehalfOfId: "u1", proposalId: "prop-1" } as never);
  vi.mocked(client.agentRunStep.create).mockResolvedValue({} as never);
  vi.mocked(client.auditLog.create).mockResolvedValue({} as never);
  vi.mocked(client.globalAISettings.upsert).mockResolvedValue({ aiCaptureEnabled: false, aiCaptureContentEnabled: false } as never);
});

describe("one trigger, one run", () => {
  it("returns the existing run instead of queueing a second", async () => {
    vi.mocked(client.agentRun.findUnique).mockResolvedValue({ id: "run-existing" } as never);

    const result = await runInTenant(client, () => queueAgentRun(QUEUE));

    expect(result).toEqual({ runId: "run-existing", created: false });
    expect(client.agentRun.create).not.toHaveBeenCalled();
  });

  it("falls back to the winner when it loses the race on the unique key", async () => {
    // Two ticks arriving together: the database decides, and the loser is answered from the
    // winner rather than being told it failed. "Already queued" is success for a caller.
    vi.mocked(client.agentRun.findUnique)
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce({ id: "run-winner" } as never);
    vi.mocked(client.agentRun.create).mockRejectedValueOnce(new Error("unique constraint"));

    expect(await runInTenant(client, () => queueAgentRun(QUEUE))).toEqual({ runId: "run-winner", created: false });
  });

  it("refuses to queue past the daily ceiling an administrator set", async () => {
    // This limit was accepted by the settings API, stored, shown in the catalogue — and enforced
    // nowhere. A configurable limit that silently does nothing is worse than no limit, because
    // somebody is relying on it.
    resolveAutonomyMock.mockResolvedValue({
      effectiveLevel: "AUTO_APPLY",
      guardrails: { maxRunsPerDay: 3, maxCostUsdPerRun: null, maxChangesPerRun: null, undoWindowHours: null, scopeProjectIds: null }
    });
    vi.mocked(client.agentRun.count).mockResolvedValue(3 as never);

    await expect(runInTenant(client, () => queueAgentRun(QUEUE))).rejects.toMatchObject({ statusCode: 429 });
    expect(client.agentRun.create).not.toHaveBeenCalled();
  });

  it("queues while still under the ceiling", async () => {
    resolveAutonomyMock.mockResolvedValue({
      effectiveLevel: "AUTO_APPLY",
      guardrails: { maxRunsPerDay: 3, maxCostUsdPerRun: null, maxChangesPerRun: null, undoWindowHours: null, scopeProjectIds: null }
    });
    vi.mocked(client.agentRun.count).mockResolvedValue(2 as never);

    await runInTenant(client, () => queueAgentRun(QUEUE));
    expect(client.agentRun.create).toHaveBeenCalled();
  });

  it("does not spend the day's allowance re-queueing something that already exists", async () => {
    // Counted after the triggerKey check: asking twice for the same logical run is one run, and
    // charging the second ask against the ceiling would make a retry eat the quota.
    resolveAutonomyMock.mockResolvedValue({
      effectiveLevel: "AUTO_APPLY",
      guardrails: { maxRunsPerDay: 1, maxCostUsdPerRun: null, maxChangesPerRun: null, undoWindowHours: null, scopeProjectIds: null }
    });
    vi.mocked(client.agentRun.findUnique).mockResolvedValue({ id: "run-existing" } as never);

    const result = await runInTenant(client, () => queueAgentRun(QUEUE));
    expect(result).toEqual({ runId: "run-existing", created: false });
    expect(client.agentRun.count).not.toHaveBeenCalled();
  });

  it("freezes the level at queue time, so policy edits cannot escalate a run in flight", async () => {
    await runInTenant(client, () => queueAgentRun(QUEUE));
    expect(client.agentRun.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ level: "AUTO_APPLY" }) })
    );
  });
});

describe("a run acts as a person", () => {
  it("refuses to queue for somebody who is not an active account", async () => {
    loadRequestUserMock.mockResolvedValue(null);
    await expect(runInTenant(client, () => queueAgentRun(QUEUE))).rejects.toMatchObject({ statusCode: 422 });
  });

  it("fails a queued run whose person has since been deactivated", async () => {
    // Checked again at execution, not just at queue time — somebody can be offboarded between the
    // two, and that must stop the run rather than let it act as a departed employee.
    vi.mocked(client.agentRun.findUnique).mockResolvedValue({
      id: "run-1", status: "QUEUED", capability: "assignment_rebalance", onBehalfOfId: "u1", scopeProjectId: "proj-1"
    } as never);
    loadRequestUserMock.mockResolvedValue(null);

    await runInTenant(client, () => executeAgentRun("run-1"));

    expect(client.agentRun.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) })
    );
    expect(rebalanceMock).not.toHaveBeenCalled();
  });

  it("refuses an unknown capability rather than queueing something nothing can run", async () => {
    await expect(runInTenant(client, () => queueAgentRun({ ...QUEUE, capability: "nope" }))).rejects.toMatchObject({
      statusCode: 404
    });
  });
});

describe("the taint clamp", () => {
  const ctx = { user: ACTOR, req: { user: ACTOR }, caller: { kind: "AGENT_RUN" as const, id: "run-1" } };

  it("marks the run once a tool carrying outside text returns", async () => {
    // search_tickets is flagged untrustedContent — a ticket can be an email a stranger sent.
    vi.mocked(client.agentRun.findUnique).mockResolvedValue({ taintedAt: null } as never);

    await runInTenant(client, () => callToolForRun("run-1", ctx, "assignment_rebalance", "AUTO_APPLY", "search_tickets", {}, 0));

    expect(client.agentRun.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "run-1" }, data: { taintedAt: expect.any(Date) } })
    );
  });

  it("stops a tainted run from writing, whatever its level says", async () => {
    vi.mocked(client.agentRun.findUnique).mockResolvedValue({ taintedAt: new Date() } as never);

    await runInTenant(client, () => callToolForRun("run-1", ctx, "assignment_rebalance", "AUTO_APPLY", "whoami", {}, 1));

    // The enablement handed to the dispatcher is where the clamp lands.
    const enablement = invokeMcpToolMock.mock.calls[0][3];
    expect(enablement.allowWrites).toBe(false);
  });

  it("leaves an untainted AUTO_APPLY run able to write", async () => {
    vi.mocked(client.agentRun.findUnique).mockResolvedValue({ taintedAt: null } as never);

    await runInTenant(client, () => callToolForRun("run-1", ctx, "assignment_rebalance", "AUTO_APPLY", "whoami", {}, 0));
    expect(invokeMcpToolMock.mock.calls[0][3].allowWrites).toBe(true);
  });

  it("never lets a SUGGEST run write", async () => {
    vi.mocked(client.agentRun.findUnique).mockResolvedValue({ taintedAt: null } as never);

    await runInTenant(client, () => callToolForRun("run-1", ctx, "assignment_rebalance", "SUGGEST", "whoami", {}, 0));
    expect(invokeMcpToolMock.mock.calls[0][3].allowWrites).toBe(false);
  });

  it("only offers the tools its capability declares", async () => {
    // assignment_rebalance declares none, so every tool is off — the run cannot wander.
    vi.mocked(client.agentRun.findUnique).mockResolvedValue({ taintedAt: null } as never);

    await runInTenant(client, () => callToolForRun("run-1", ctx, "assignment_rebalance", "AUTO_APPLY", "whoami", {}, 0));

    const overrides = invokeMcpToolMock.mock.calls[0][3].toolOverrides;
    expect(Object.values(overrides).every((v) => v === false)).toBe(true);
  });

  it("does not read GlobalMcpSettings — that switch is for external clients", async () => {
    vi.mocked(client.agentRun.findUnique).mockResolvedValue({ taintedAt: null } as never);
    await runInTenant(client, () => callToolForRun("run-1", ctx, "assignment_rebalance", "AUTO_APPLY", "whoami", {}, 0));
    // Turning off the MCP server so Claude Desktop cannot connect must not stop internal agents.
    expect(client.globalMcpSettings?.upsert).toBeUndefined();
    expect(invokeMcpToolMock.mock.calls[0][3].enabled).toBe(true);
  });
});

describe("stopping and restarting", () => {
  it("does not start work on a run that was asked to stop", async () => {
    vi.mocked(client.agentRun.findUnique)
      .mockResolvedValueOnce({ id: "run-1", status: "QUEUED", capability: "assignment_rebalance", onBehalfOfId: "u1", scopeProjectId: "proj-1" } as never)
      .mockResolvedValueOnce({ abortRequestedAt: new Date() } as never);

    await runInTenant(client, () => executeAgentRun("run-1"));

    expect(rebalanceMock).not.toHaveBeenCalled();
    expect(client.agentRun.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "ABORTED" }) })
    );
  });

  it("refuses to abort a run that has already finished", async () => {
    vi.mocked(client.agentRun.findUnique).mockResolvedValue({ id: "run-1", status: "COMPLETED" } as never);
    await expect(runInTenant(client, () => requestAbort("run-1", "u1"))).rejects.toMatchObject({ statusCode: 409 });
  });

  it("marks a run orphaned by a restart FAILED, so it is not retried forever", async () => {
    vi.mocked(client.agentRun.updateMany).mockResolvedValue({ count: 2 } as never);
    expect(await runInTenant(client, () => reapOrphanedRuns(30))).toBe(2);
    expect(client.agentRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: "RUNNING" }) })
    );
  });
});

describe("executing the work", () => {
  beforeEach(() => {
    vi.mocked(client.agentRun.findUnique)
      .mockResolvedValueOnce({ id: "run-1", status: "QUEUED", capability: "assignment_rebalance", onBehalfOfId: "u1", scopeProjectId: "proj-1" } as never)
      .mockResolvedValue({ abortRequestedAt: null } as never);
  });

  it("runs the capability and records what it produced", async () => {
    await runInTenant(client, () => executeAgentRun("run-1"));

    expect(rebalanceMock).toHaveBeenCalledWith(expect.objectContaining({ projectId: "proj-1", requestedById: "u1" }));
    expect(client.agentRunStep.create).toHaveBeenCalled();
    expect(client.agentRun.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "COMPLETED" }) })
    );
  });

  it("audits the finish as an AGENT acting for the person", async () => {
    await runInTenant(client, () => executeAgentRun("run-1"));

    expect(client.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "agent_run.finished",
          actorId: "u1",
          actorType: "AGENT",
          actorLabel: "agent:assignment_rebalance",
          agentRunId: "run-1"
        })
      })
    );
  });

  it("lands BLOCKED when a guardrail held the proposal back", async () => {
    // BLOCKED was unreachable: `reason` carried both "nothing to do" and "held for review", so the
    // runner could not tell a completed run from a blocked one and every run reported COMPLETED.
    // The state existed, was documented, and emitted its own event — and could never happen.
    rebalanceMock.mockResolvedValue({
      proposalId: "prop-1",
      reason: null,
      heldForReview: "5 changes is more than the 2 this capability may apply unattended.",
      moves: 5
    });

    await runInTenant(client, () => executeAgentRun("run-1"));

    expect(client.agentRun.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "BLOCKED" }) })
    );
  });

  it("still COMPLETES when it correctly decided there was nothing to do", async () => {
    // Having nothing to rebalance is a successful run, not a blocked one.
    rebalanceMock.mockResolvedValue({
      proposalId: null,
      reason: "Nobody on this project is over capacity in that window.",
      heldForReview: null,
      moves: 0
    });

    await runInTenant(client, () => executeAgentRun("run-1"));

    expect(client.agentRun.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "COMPLETED" }) })
    );
  });

  it("does not write step content while AI capture is off", async () => {
    // An agent trace is prompt content by another name; a second store outside the retention
    // sweep would be the same compliance regression the face capture denylist prevents.
    await runInTenant(client, () => executeAgentRun("run-1"));

    const step = vi.mocked(client.agentRunStep.create).mock.calls[0][0] as never as { data: Record<string, unknown> };
    expect(step.data.resultText).toBeNull();
  });
});
