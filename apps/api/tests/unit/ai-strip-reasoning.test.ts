/**
 * `stripReasoning` — the guard that keeps a reasoning model's private working out of the answer.
 *
 * It sits on `callChat`'s success return, which is the single place every text-returning AI feature
 * funnels through, so a regression here shows up in the status report, Ask AI, refine and the
 * digests at once. The cases below are the four real shapes plus the two ways this can go wrong:
 * blanking an answer that was only reasoning, and eating an answer that merely MENTIONS the tag.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";

const { mockAnthropicCreate, FakeAPIError } = vi.hoisted(() => {
  // `translateProviderError` does `error instanceof Anthropic.APIError`, which throws outright if
  // the mocked SDK has no such class — see ai-provider-failure-logging.test.ts for the full note.
  class FakeAPIError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return { mockAnthropicCreate: vi.fn(), FakeAPIError };
});
vi.mock("@anthropic-ai/sdk", () => ({
  default: Object.assign(
    class FakeAnthropic {
      messages = { create: mockAnthropicCreate };
    },
    { APIError: FakeAPIError }
  )
}));

vi.mock("../../src/services/plan-limits.service.js", () => ({
  getEffectiveAiBudgetCeiling: vi.fn().mockResolvedValue(100)
}));

const { generateStatusReport, stripReasoning } = await import("../../src/services/ai.service.js");

describe("stripReasoning", () => {
  it("removes a balanced block and keeps the answer", () => {
    expect(stripReasoning("<think>First I should check the totals.</think>Hours are up 12%.")).toBe("Hours are up 12%.");
  });

  it("removes every block when a model narrates more than once", () => {
    // Non-greedy matching matters here: a greedy pattern merges the two blocks into one match and
    // swallows "One." — the real answer sitting between them.
    expect(stripReasoning("<think>a</think>One. <think>b</think>Two.")).toBe("One. Two.");
  });

  it("handles `thinking` and `reasoning` as well as `think`, and ignores tag attributes", () => {
    expect(stripReasoning("<thinking>hmm</thinking>Done.")).toBe("Done.");
    expect(stripReasoning("<reasoning>hmm</reasoning>Done.")).toBe("Done.");
    expect(stripReasoning('<think duration="2s">hmm</think>Done.')).toBe("Done.");
  });

  it("drops the tail of an UNCLOSED tag — the token-ceiling case", () => {
    // A model that runs out of tokens mid-thought never emits the closing tag. Matching only
    // balanced pairs would leave the whole thing visible, which is the worst-looking failure.
    expect(stripReasoning("Hours are up 12%.\n<think>Now let me double-check the")).toBe("Hours are up 12%.");
  });

  it("does NOT eat an answer that merely mentions the tag further down", () => {
    // Why the unclosed rule is bounded to the first 200 characters: reasoning always comes first,
    // so an answer explaining `<think>` two paragraphs in is an answer, not a stray thought.
    const answer = `${"Some prose. ".repeat(30)}\nModels emit <think> to narrate their working.`;
    expect(stripReasoning(answer)).toBe(answer);
  });

  it("keeps the original when stripping would leave nothing at all", () => {
    // A blank panel tells the reader nothing; the caller's own empty-answer handling stays in charge.
    const onlyReasoning = "<think>I am not sure how to answer this.</think>";
    expect(stripReasoning(onlyReasoning)).toBe(onlyReasoning);
  });

  it("leaves ordinary answers untouched", () => {
    expect(stripReasoning("Three tickets are open.")).toBe("Three tickets are open.");
    expect(stripReasoning("Compare <thinker> and <thought> tags.")).toBe("Compare <thinker> and <thought> tags.");
    expect(stripReasoning("")).toBe("");
  });
});

/**
 * The half a unit test of the helper cannot reach: that it is actually ON `callChat`'s success
 * return, rather than defined and never called. This drives a real text feature end to end with the
 * provider SDK stubbed to answer the way `qwen3.6-27b` answered in the dev database — a `<think>`
 * block first, the report after. `generateStatusReport` is the vehicle only because it is the
 * simplest text feature to call; the strip is shared by every one of them.
 */
describe("callChat strips reasoning before any caller sees the text", () => {
  function client() {
    const c = createFakeTenantClient();
    vi.mocked(c.globalAISettings.upsert).mockResolvedValue({
      id: "global",
      aiEnabled: true,
      statusReportEnabled: true,
      model: "claude-haiku-4-5",
      provider: "ANTHROPIC",
      confidenceThreshold: 0.6,
      monthlyBudgetUsd: null,
      baseUrl: null,
      apiKey: null
    } as never);
    vi.mocked(c.aIUsageLog.aggregate).mockResolvedValue({ _sum: { costUsdEstimate: 0 } } as never);
    vi.mocked(c.aIProviderConfig.findMany).mockResolvedValue([] as never);
    return c;
  }

  const ARGS = {
    projectName: "Apollo",
    periodLabel: "last 7 days",
    ticketsCreated: 4,
    ticketsResolved: 3,
    openCount: 11,
    overdueCount: 1,
    hoursLogged: 32,
    notableTickets: [{ key: "HICS-TS-3", title: "Login button does nothing", status: "OPEN" }]
  };

  const answerWith = (text: string) =>
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text }],
      usage: { input_tokens: 10, output_tokens: 20 }
    } as never);

  beforeEach(() => {
    mockAnthropicCreate.mockReset();
  });

  it("returns the report without the reasoning that preceded it", async () => {
    answerWith(
      "<think>\nThe user wants a stakeholder update. I should lead with the resolved count.\n</think>\nApollo closed 3 of 4 new tickets last week."
    );

    const { report } = await runInTenant(client(), () => generateStatusReport(ARGS));

    expect(report).toBe("Apollo closed 3 of 4 new tickets last week.");
    expect(report).not.toContain("<think");
  });

  it("recovers the report when the model never closed the tag", async () => {
    answerWith("Apollo closed 3 of 4 new tickets last week.\n<think>Now let me double-check the hours");

    const { report } = await runInTenant(client(), () => generateStatusReport(ARGS));

    expect(report).toBe("Apollo closed 3 of 4 new tickets last week.");
  });

  it("passes an ordinary answer through byte for byte", async () => {
    answerWith("Apollo closed 3 of 4 new tickets last week.");

    const { report } = await runInTenant(client(), () => generateStatusReport(ARGS));

    expect(report).toBe("Apollo closed 3 of 4 new tickets last week.");
  });
});
