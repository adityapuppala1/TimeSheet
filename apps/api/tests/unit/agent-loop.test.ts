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

describe("ending with an answer", () => {
  /** Overrides the run row (e.g. maxSteps) while keeping the select-shape dispatch intact. */
  function mockRun(over: Record<string, unknown>) {
    vi.mocked(client.agentRun.findUnique).mockImplementation((async (args: { select?: Record<string, boolean> }) => {
      if (args?.select?.abortRequestedAt && Object.keys(args.select).length === 1) return { abortRequestedAt: null };
      if (args?.select?.taintedAt && Object.keys(args.select).length === 1) return { taintedAt: null };
      return baseRun(over);
    }) as never);
  }

  it("reserves the last step for the answer — a run that never says what it found wasted every step", async () => {
    // Both live pilot runs spent their whole budget on tool calls and hit the ceiling silent.
    vi.mocked(planAgentStep)
      .mockResolvedValueOnce({ decision: { action: "tool", tool: "get_ticket", args: { key: "A-1" } }, costUsd: 0.01, raw: "{}" })
      .mockResolvedValueOnce({ decision: { action: "tool", tool: "get_ticket", args: { key: "A-2" } }, costUsd: 0.01, raw: "{}" })
      .mockResolvedValueOnce({ decision: { action: "finish", summary: "Here is what I found." }, costUsd: 0.01, raw: "{}" });
    vi.mocked(invokeMcpTool).mockResolvedValueOnce({ a: 1 } as never).mockResolvedValueOnce({ a: 2 } as never);

    await runInTenant(client, () => executeAgentRun("run-1"));

    expect(finalStatus()).toBe("COMPLETED");
    // The first two decisions were free choices; the third — the last allowed step — was not.
    expect(vi.mocked(planAgentStep).mock.calls[0][0].mustFinish).toBeFalsy();
    expect(vi.mocked(planAgentStep).mock.calls[1][0].mustFinish).toBeFalsy();
    expect(vi.mocked(planAgentStep).mock.calls[2][0].mustFinish).toBe(true);
  });

  it("identical answers to different questions count as circling: steer once, then demand the answer", async () => {
    // The live gap the args-repeat guard correctly could not close — six differently-argued
    // searches, one identical empty answer. Result identity is what circling actually is.
    mockRun({ maxSteps: 8 });
    vi.mocked(planAgentStep).mockImplementation(async (input: { mustFinish?: boolean; transcript: unknown[] }) => {
      if (input.mustFinish) return { decision: { action: "finish", summary: "Nothing moved this week." }, costUsd: 0.01, raw: "{}" };
      const n = vi.mocked(planAgentStep).mock.calls.length;
      return { decision: { action: "tool", tool: "search_tickets", args: { query: `angle-${n}` } }, costUsd: 0.01, raw: "{}" };
    });
    vi.mocked(invokeMcpTool).mockResolvedValue({ count: 0, tickets: [] } as never);

    await runInTenant(client, () => executeAgentRun("run-1"));

    expect(finalStatus()).toBe("COMPLETED");
    // Four searches ran (1 new + 3 identical), then the envelope demanded the answer — with four
    // steps still unspent. Circling forfeits the tool budget; it does not get to exhaust it.
    expect(vi.mocked(invokeMcpTool)).toHaveBeenCalledTimes(4);
    const finalCall = vi.mocked(planAgentStep).mock.calls.at(-1)![0];
    expect(finalCall.mustFinish).toBe(true);
    // The steering note reached the model before the demand did.
    expect(JSON.stringify(finalCall.transcript)).toContain("nothing you had not already seen");
  });

  it("a run asked for its answer that reaches for a tool anyway lands PARTIAL, and the tool never runs", async () => {
    mockRun({ maxSteps: 1 }); // the only step IS the last step
    vi.mocked(planAgentStep).mockResolvedValue({
      decision: { action: "tool", tool: "get_ticket", args: {} },
      costUsd: 0.01,
      raw: "{}"
    });

    await runInTenant(client, () => executeAgentRun("run-1"));

    expect(finalStatus()).toBe("PARTIAL");
    expect(vi.mocked(invokeMcpTool)).not.toHaveBeenCalled();
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

  it("refuses a call it already made, with the answer it already got", async () => {
    // The first live run of this loop spent NINE of twelve steps re-issuing identical
    // search_tickets calls that returned nothing. The prompt already asked it not to; an
    // instruction is not a bound, so the envelope enforces it.
    vi.mocked(planAgentStep)
      .mockResolvedValueOnce({ decision: { action: "tool", tool: "get_ticket", args: { key: "WEB-1" } }, costUsd: 0.01, raw: "{}" })
      .mockResolvedValueOnce({ decision: { action: "tool", tool: "get_ticket", args: { key: "WEB-1" } }, costUsd: 0.01, raw: "{}" })
      .mockResolvedValueOnce({ decision: { action: "finish", summary: "ok" }, costUsd: 0.01, raw: "{}" });
    vi.mocked(invokeMcpTool).mockResolvedValue({ count: 0 } as never);

    await runInTenant(client, () => executeAgentRun("run-1"));

    // The tool ran once, not twice — the repeat cost no invocation and no fresh read.
    expect(vi.mocked(invokeMcpTool)).toHaveBeenCalledTimes(1);
    expect(stepKinds()).toContain("refusal");
    // And the refusal carries the earlier ANSWER, so the model can act on it rather than guess.
    const third = vi.mocked(planAgentStep).mock.calls[2][0];
    expect(JSON.stringify(third.transcript)).toContain("already called get_ticket");
  });

  it("treats argument key order as the same call — otherwise the check is trivially defeated", async () => {
    vi.mocked(planAgentStep)
      .mockResolvedValueOnce({ decision: { action: "tool", tool: "get_ticket", args: { a: 1, b: 2 } }, costUsd: 0.01, raw: "{}" })
      .mockResolvedValueOnce({ decision: { action: "tool", tool: "get_ticket", args: { b: 2, a: 1 } }, costUsd: 0.01, raw: "{}" })
      .mockResolvedValueOnce({ decision: { action: "finish", summary: "ok" }, costUsd: 0.01, raw: "{}" });
    vi.mocked(invokeMcpTool).mockResolvedValue({ ok: true } as never);

    await runInTenant(client, () => executeAgentRun("run-1"));

    expect(vi.mocked(invokeMcpTool)).toHaveBeenCalledTimes(1);
  });

  it("still lets the same tool run with different arguments", async () => {
    vi.mocked(planAgentStep)
      .mockResolvedValueOnce({ decision: { action: "tool", tool: "get_ticket", args: { key: "WEB-1" } }, costUsd: 0.01, raw: "{}" })
      .mockResolvedValueOnce({ decision: { action: "tool", tool: "get_ticket", args: { key: "WEB-2" } }, costUsd: 0.01, raw: "{}" })
      .mockResolvedValueOnce({ decision: { action: "finish", summary: "ok" }, costUsd: 0.01, raw: "{}" });
    vi.mocked(invokeMcpTool).mockResolvedValue({ ok: true } as never);

    await runInTenant(client, () => executeAgentRun("run-1"));

    expect(vi.mocked(invokeMcpTool)).toHaveBeenCalledTimes(2);
    expect(finalStatus()).toBe("COMPLETED");
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
