/**
 * The model-driven loop, held to the envelope's promises.
 *
 * The envelope's header stated three rules before any loop existed; these tests pin the loop to
 * them now that it does. The bounds that were "recorded now, enforced by the loop" are enforced:
 * the step ceiling and the cost ceiling both land on PARTIAL (work already done is real), an
 * unparseable decision is FAILED (an agent whose decisions cannot be parsed has no decisions), a
 * disallowed tool is refused AS DATA and the run continues, and reading stranger-authored content
 * taints the run through the one door tool calls are allowed to use.
 *
 * Test-by-breaking: each of these fails against the pre-loop code trivially (the capability
 * FAILED with "no runner"); the ceiling tests were additionally verified by inverting the
 * PARTIAL/FAILED status in the loop and watching them catch it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";
import type { PrismaClient } from "@prisma/client";

vi.mock("../../src/services/ai.service.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  planAgentStep: vi.fn(),
  getGlobalAISettings: vi.fn().mockResolvedValue({ aiCaptureEnabled: true, aiCaptureContentEnabled: true })
}));
vi.mock("../../src/services/principal.service.js", () => ({
  loadRequestUser: vi.fn().mockResolvedValue({ id: "u1", name: "Ana", role: "SUPER_ADMIN", permissions: [] })
}));
vi.mock("../../src/services/mcp-tools.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  invokeMcpTool: vi.fn()
}));

const { planAgentStep } = await import("../../src/services/ai.service.js");
const { invokeMcpTool } = await import("../../src/services/mcp-tools.js");
const { executeAgentRun } = await import("../../src/services/agent-run.service.js");

let client: PrismaClient;
let aborted: boolean;

function baseRun(over: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    capability: "status_report",
    trigger: "manual",
    triggerKey: "k",
    onBehalfOfId: "u1",
    level: "SUGGEST",
    taintedAt: null,
    status: "QUEUED",
    abortRequestedAt: null,
    stepCount: 0,
    maxSteps: 3,
    costUsd: null,
    maxCostUsd: null,
    scopeProjectId: null,
    goal: "Write a status report",
    proposalId: null,
    ...over
  };
}

/** The status the run finished in — the last agentRun.update call that set one. */
function finalStatus(): string | undefined {
  const calls = vi.mocked(client.agentRun.update).mock.calls as Array<[{ data?: { status?: string } }]>;
  return calls.map((c) => c[0]?.data?.status).filter(Boolean).pop();
}

function stepKinds(): string[] {
  return (vi.mocked(client.agentRunStep.create).mock.calls as Array<[{ data: { kind: string } }]>).map((c) => c[0].data.kind);
}

beforeEach(() => {
  client = createFakeTenantClient();
  aborted = false;

  vi.mocked(client.agentRun.findUnique).mockImplementation((async (args: { select?: Record<string, boolean> }) => {
    if (args?.select?.abortRequestedAt && Object.keys(args.select).length === 1) {
      return { abortRequestedAt: aborted ? new Date() : null };
    }
    if (args?.select?.taintedAt && Object.keys(args.select).length === 1) return { taintedAt: null };
    return baseRun();
  }) as never);
  vi.mocked(client.agentRun.update).mockImplementation((async (args: { data?: Record<string, unknown> }) => ({
    ...baseRun(),
    ...(args?.data ?? {})
  })) as never);
  vi.mocked(client.agentRunStep.create).mockResolvedValue({} as never);
  vi.mocked(client.auditLog.create).mockResolvedValue({} as never);
  vi.mocked(planAgentStep).mockReset();
  vi.mocked(invokeMcpTool).mockReset();
});

describe("finishing", () => {
  it("a finish decision completes the run and records the summary", async () => {
    vi.mocked(planAgentStep).mockResolvedValue({
      decision: { action: "finish", summary: "Everything is on track." },
      costUsd: 0.01,
      raw: "{}"
    });

    await runInTenant(client, () => executeAgentRun("run-1"));

    expect(finalStatus()).toBe("COMPLETED");
    expect(stepKinds()).toContain("finish");
  });

  it("an unparseable decision is FAILED — an agent whose decisions cannot be parsed has none", async () => {
    vi.mocked(planAgentStep).mockResolvedValue({ decision: null, costUsd: 0.01, raw: "sorry, as an AI…" });

    await runInTenant(client, () => executeAgentRun("run-1"));

    expect(finalStatus()).toBe("FAILED");
  });
});

describe("the bounds", () => {
  it("the step ceiling lands on PARTIAL, not FAILED — work already done is real", async () => {
    vi.mocked(planAgentStep).mockResolvedValue({
      decision: { action: "tool", tool: "get_ticket", args: {} },
      costUsd: 0.01,
      raw: "{}"
    });
    vi.mocked(invokeMcpTool).mockResolvedValue({ ok: true } as never);

    await runInTenant(client, () => executeAgentRun("run-1"));

    expect(finalStatus()).toBe("PARTIAL");
    // maxSteps of 3 means exactly 3 decisions were bought, never a 4th.
    expect(vi.mocked(planAgentStep)).toHaveBeenCalledTimes(3);
  });

  it("the cost ceiling lands on PARTIAL before the next model call is paid for", async () => {
    vi.mocked(client.agentRun.findUnique).mockImplementation((async (args: { select?: Record<string, boolean> }) => {
      if (args?.select?.abortRequestedAt && Object.keys(args.select).length === 1) return { abortRequestedAt: null };
      if (args?.select?.taintedAt && Object.keys(args.select).length === 1) return { taintedAt: null };
      return baseRun({ maxCostUsd: "0.05" });
    }) as never);
    vi.mocked(planAgentStep).mockResolvedValue({
      decision: { action: "tool", tool: "get_ticket", args: {} },
      costUsd: 0.06,
      raw: "{}"
    });
    vi.mocked(invokeMcpTool).mockResolvedValue({ ok: true } as never);

    await runInTenant(client, () => executeAgentRun("run-1"));

    expect(finalStatus()).toBe("PARTIAL");
    // The first step blew the ceiling, so exactly one decision was paid for.
    expect(vi.mocked(planAgentStep)).toHaveBeenCalledTimes(1);
  });

  it("an abort between steps lands on ABORTED without another model call", async () => {
    vi.mocked(planAgentStep).mockImplementation(async () => {
      aborted = true; // the person clicks stop while step 1 is in flight
      return { decision: { action: "tool", tool: "get_ticket", args: {} }, costUsd: 0.01, raw: "{}" };
    });
    vi.mocked(invokeMcpTool).mockResolvedValue({ ok: true } as never);

    await runInTenant(client, () => executeAgentRun("run-1"));

    expect(finalStatus()).toBe("ABORTED");
    expect(vi.mocked(planAgentStep)).toHaveBeenCalledTimes(1);
  });
});

describe("the allowlist", () => {
  it("a tool outside the capability's allowlist is refused as data, never invoked", async () => {
    vi.mocked(planAgentStep)
      .mockResolvedValueOnce({ decision: { action: "tool", tool: "create_ticket", args: {} }, costUsd: 0.01, raw: "{}" })
      .mockResolvedValueOnce({ decision: { action: "finish", summary: "ok" }, costUsd: 0.01, raw: "{}" });

    await runInTenant(client, () => executeAgentRun("run-1"));

    // The refusal is a recorded step and the run recovers — one bad pick is a wasted step, and
    // the step ceiling already prices wasted steps.
    expect(stepKinds()).toContain("refusal");
    expect(finalStatus()).toBe("COMPLETED");
    expect(vi.mocked(invokeMcpTool)).not.toHaveBeenCalled();
    // The refusal was fed back to the model as data, so it could correct itself.
    const secondCall = vi.mocked(planAgentStep).mock.calls[1][0];
    expect(JSON.stringify(secondCall.transcript)).toContain("not in this capability's allowlist");
  });

  it("reading stranger-authored content taints the run through the tool door", async () => {
    // search_tickets is untrustedContent: true in the real registry — the loop calls it through
    // callToolForRun, which is the only place the taint bit is set.
    vi.mocked(planAgentStep)
      .mockResolvedValueOnce({ decision: { action: "tool", tool: "search_tickets", args: { query: "x" } }, costUsd: 0.01, raw: "{}" })
      .mockResolvedValueOnce({ decision: { action: "finish", summary: "ok" }, costUsd: 0.01, raw: "{}" });
    vi.mocked(invokeMcpTool).mockResolvedValue({ tickets: [] } as never);

    await runInTenant(client, () => executeAgentRun("run-1"));

    const taintWrites = (vi.mocked(client.agentRun.update).mock.calls as Array<[{ data?: { taintedAt?: unknown } }]>).filter(
      (c) => c[0]?.data?.taintedAt instanceof Date
    );
    expect(taintWrites.length).toBe(1);
  });
});
