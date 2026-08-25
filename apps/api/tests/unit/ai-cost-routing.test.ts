/**
 * Two cost behaviours that are invisible when they break — the app keeps working, it just costs
 * more — so they need tests rather than comments.
 *
 *  1. MECHANICAL FEATURES RUN ON THE ECONOMY MODEL. `GlobalAISettings.model` is one workspace-wide
 *     choice that every call site read directly, so raising it for Ask AI silently re-priced the
 *     highest-volume features in the product. A regression here shows up as a bill, not a bug.
 *
 *  2. THE FACE REVIEW SUMMARY SENDS A SUMMARY, NOT THE WHOLE LOG. That call was ~2.1k input tokens
 *     because it shipped 60 attempt rows of which ~50 were identical passes. The risk in fixing it
 *     is the opposite of cost: collapsing a row that MATTERED. The tests below pin the signals the
 *     prompt asks about — flagged passes especially, since a virtual-camera flag on a PASS is
 *     exactly the thing an aggregate would hide.
 *
 * These drive the REAL exported functions and assert what reached the Anthropic SDK, for the same
 * reason ai-proposal-scope.test.ts does: a test that re-implements the routing rule and checks its
 * own arithmetic passes just as happily against the unrouted version.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";

const { mockAnthropicCreate } = vi.hoisted(() => ({ mockAnthropicCreate: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class FakeAnthropic {
    messages = { create: mockAnthropicCreate };
  }
}));

const { mockGetEffectiveAiBudgetCeiling } = vi.hoisted(() => ({ mockGetEffectiveAiBudgetCeiling: vi.fn() }));
vi.mock("../../src/services/plan-limits.service.js", () => ({
  getEffectiveAiBudgetCeiling: mockGetEffectiveAiBudgetCeiling
}));

const { classifyTicket, summarizeFaceReviewAttempt } = await import("../../src/services/ai.service.js");

function settings(overrides: Record<string, unknown> = {}) {
  return {
    id: "global",
    aiEnabled: true,
    autoTriageEnabled: true,
    faceReviewSummaryEnabled: true,
    model: "claude-opus-4-8",
    provider: "ANTHROPIC",
    confidenceThreshold: 0.6,
    monthlyBudgetUsd: null,
    baseUrl: null,
    apiKey: null,
    ...overrides
  };
}

/** The model name that actually reached the SDK. */
function modelSent(): string {
  return mockAnthropicCreate.mock.calls[0]?.[0]?.model;
}
function promptSent(): string {
  const content = mockAnthropicCreate.mock.calls[0]?.[0]?.messages?.[0]?.content;
  return typeof content === "string" ? content : JSON.stringify(content);
}

function baseClient(overrides: Record<string, unknown> = {}) {
  const client = createFakeTenantClient();
  vi.mocked(client.globalAISettings.upsert).mockResolvedValue(settings(overrides) as never);
  vi.mocked(client.aIUsageLog.aggregate).mockResolvedValue({ _sum: { costUsdEstimate: 0 } } as never);
  return client;
}

function triageResponse() {
  return {
    content: [{ type: "text", text: JSON.stringify({ type: "BUG", priority: "HIGH", moduleName: "NONE", confidence: 0.9, reasoning: "r" }) }],
    usage: { input_tokens: 100, output_tokens: 20 }
  };
}

const TRIAGE_ARGS = {
  title: "Login button does nothing",
  description: "Clicking sign in on Safari does nothing at all.",
  project: { id: "p1", name: "Web", modules: [] },
  typeNames: ["BUG", "TASK"],
  userId: "u1"
};

beforeEach(() => {
  mockAnthropicCreate.mockReset();
  mockGetEffectiveAiBudgetCeiling.mockReset().mockResolvedValue(100);
});

describe("mechanical features are routed to the economy model", () => {
  it("downgrades triage when the workspace has chosen an expensive model", async () => {
    const client = baseClient({ model: "claude-opus-4-8" });
    mockAnthropicCreate.mockResolvedValue(triageResponse());

    await runInTenant(client, () => classifyTicket(TRIAGE_ARGS as never));

    expect(modelSent()).toBe("claude-haiku-4-5");
  });

  it("records the model that actually ran, so the cost estimate and the budget stay true", async () => {
    // The usage row feeds estimateCostUsd, which feeds the monthly cap. Logging the workspace's
    // model while calling a cheaper one would overstate spend and trip the budget early — the
    // failure mode is a 402 nobody can explain.
    const client = baseClient({ model: "claude-opus-4-8" });
    mockAnthropicCreate.mockResolvedValue(triageResponse());

    await runInTenant(client, () => classifyTicket(TRIAGE_ARGS as never));

    expect(client.aIUsageLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ feature: "triage", model: "claude-haiku-4-5", provider: "Anthropic" }) })
    );
  });

  it("never UPGRADES — a workspace already on the economy model is left alone", async () => {
    const client = baseClient({ model: "claude-haiku-4-5" });
    mockAnthropicCreate.mockResolvedValue(triageResponse());

    await runInTenant(client, () => classifyTicket(TRIAGE_ARGS as never));

    expect(modelSent()).toBe("claude-haiku-4-5");
  });

  it("leaves a model it has no price for exactly as configured", async () => {
    // An unrecognised name is a deployment pinning something on purpose. Second-guessing it would
    // silently swap a model somebody chose deliberately.
    const client = baseClient({ model: "some-pinned-internal-model" });
    mockAnthropicCreate.mockResolvedValue(triageResponse());

    await runInTenant(client, () => classifyTicket(TRIAGE_ARGS as never));

    expect(modelSent()).toBe("some-pinned-internal-model");
  });
});

describe("judgement features keep the workspace's chosen model", () => {
  /** A flagged attempt plus a history the summariser will fold. */
  function faceClient(history: unknown[], model = "claude-opus-4-8") {
    const client = baseClient({ model });
    vi.mocked(client.faceVerificationAttempt.findUnique).mockResolvedValue({
      id: "a1",
      userId: "u1",
      createdAt: new Date("2026-08-01T09:00:00Z"),
      context: "CLOCK_IN",
      outcome: "NO_MATCH",
      similarity: 0.71,
      deviceLabel: "FaceTime HD",
      virtualCameraSuspected: false,
      unfamiliarNetwork: false,
      user: { id: "u1", name: "Dana", role: { name: "EMPLOYEE" }, createdAt: new Date("2025-01-01T00:00:00Z") }
    } as never);
    vi.mocked(client.faceVerificationAttempt.findMany).mockResolvedValue(history as never);
    vi.mocked(client.timesheet.findMany).mockResolvedValue([] as never);
    return client;
  }

  function summaryResponse() {
    return {
      content: [{ type: "text", text: JSON.stringify({ summary: "s", risk: "LOW", recommendation: "r" }) }],
      usage: { input_tokens: 400, output_tokens: 60 }
    };
  }

  /** `n` unremarkable passes — the rows the trim is allowed to collapse. */
  function routinePasses(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      id: `p${i}`,
      outcome: "PASSED",
      similarity: 0.9 + (i % 9) / 1000,
      createdAt: new Date(Date.UTC(2026, 6, 10, 9, i % 50)),
      context: "CLOCK_IN",
      deviceLabel: "FaceTime HD",
      virtualCameraSuspected: false,
      unfamiliarNetwork: false
    }));
  }

  it("does NOT downgrade the face review summary — it is an assessment, not a label", async () => {
    const client = faceClient(routinePasses(5));
    mockAnthropicCreate.mockResolvedValue(summaryResponse());

    await runInTenant(client, () => summarizeFaceReviewAttempt({ attemptId: "a1" }));

    expect(modelSent()).toBe("claude-opus-4-8");
  });

  it("keeps a PASS that carries a virtual-camera flag verbatim, never folded into the count", async () => {
    // This is the signal the prompt asks about by name — "virtual-camera or new-network signals
    // coinciding with passes". An aggregate would erase precisely the attempt worth reviewing.
    const flagged = {
      id: "flagged",
      outcome: "PASSED",
      similarity: 0.94,
      createdAt: new Date("2026-07-15T02:14:00Z"),
      context: "CLOCK_IN",
      deviceLabel: "OBS Virtual Camera",
      virtualCameraSuspected: true,
      unfamiliarNetwork: false
    };
    const client = faceClient([...routinePasses(45), flagged]);
    mockAnthropicCreate.mockResolvedValue(summaryResponse());

    await runInTenant(client, () => summarizeFaceReviewAttempt({ attemptId: "a1" }));

    const prompt = promptSent();
    expect(prompt).toContain("2026-07-15T02:14:00.000Z");
    expect(prompt).toContain("virtual-camera?");
  });

  it("keeps an unfamiliar-network pass too", async () => {
    const flagged = {
      id: "net",
      outcome: "PASSED",
      similarity: 0.93,
      createdAt: new Date("2026-07-16T03:00:00Z"),
      context: "CLOCK_IN",
      deviceLabel: "FaceTime HD",
      virtualCameraSuspected: false,
      unfamiliarNetwork: true
    };
    const client = faceClient([...routinePasses(45), flagged]);
    mockAnthropicCreate.mockResolvedValue(summaryResponse());

    await runInTenant(client, () => summarizeFaceReviewAttempt({ attemptId: "a1" }));

    // Asserted on the TIMESTAMP, not on the string "new-network": the prompt's own instructions
    // contain the phrase "virtual-camera or new-network signals", so a substring check for the
    // flag name passes even when the row was collapsed. It did — this test was vacuous until the
    // assertion moved to something only the data can produce.
    const prompt = promptSent();
    expect(prompt).toContain("2026-07-16T03:00:00.000Z");
    expect(prompt).toMatch(/2026-07-16T03:00:00\.000Z.*new-network/);
  });

  it("keeps every non-pass outcome verbatim", async () => {
    const failure = {
      id: "f1",
      outcome: "SPOOF_SUSPECTED",
      similarity: 0.42,
      createdAt: new Date("2026-07-20T23:40:00Z"),
      context: "CLOCK_OUT",
      deviceLabel: "FaceTime HD",
      virtualCameraSuspected: false,
      unfamiliarNetwork: false
    };
    const client = faceClient([...routinePasses(50), failure]);
    mockAnthropicCreate.mockResolvedValue(summaryResponse());

    await runInTenant(client, () => summarizeFaceReviewAttempt({ attemptId: "a1" }));

    const prompt = promptSent();
    expect(prompt).toContain("SPOOF_SUSPECTED");
    expect(prompt).toContain("2026-07-20T23:40:00.000Z");
  });

  it("collapses routine passes into a counted line instead of 50 near-identical rows", async () => {
    const client = faceClient(routinePasses(50));
    mockAnthropicCreate.mockResolvedValue(summaryResponse());

    await runInTenant(client, () => summarizeFaceReviewAttempt({ attemptId: "a1" }));

    const prompt = promptSent();
    // 3 lowest-scoring passes are deliberately kept (the lookalike signal), so 47 collapse.
    expect(prompt).toContain("47 further routine passes not listed individually");
    // The total is still stated, so "not shown" can never read as "did not happen".
    expect(prompt).toContain('"PASSED":50');
    // The whole point: the per-attempt lines are a handful, not fifty.
    expect(prompt.split("\n").filter((l) => l.startsWith("- ")).length).toBeLessThanOrEqual(16);
  });

  it("still names the devices seen across the WHOLE window, including collapsed rows", async () => {
    const client = faceClient([
      ...routinePasses(40),
      { id: "d2", outcome: "PASSED", similarity: 0.97, createdAt: new Date("2026-07-11T09:00:00Z"), context: "CLOCK_IN", deviceLabel: "Rare Device", virtualCameraSuspected: false, unfamiliarNetwork: false }
    ]);
    mockAnthropicCreate.mockResolvedValue(summaryResponse());

    await runInTenant(client, () => summarizeFaceReviewAttempt({ attemptId: "a1" }));

    expect(promptSent()).toContain("Rare Device");
  });

  it("says so when even the notable list had to be cut", async () => {
    // 20 failures exceeds the 16-line cap. The model must be told it is reading a sample, or it
    // will reason about "the 16 failures" when there were twenty.
    const failures = Array.from({ length: 20 }, (_, i) => ({
      id: `x${i}`,
      outcome: "NO_MATCH",
      similarity: 0.5,
      createdAt: new Date(Date.UTC(2026, 6, 12, 1, i)),
      context: "CLOCK_IN",
      deviceLabel: "FaceTime HD",
      virtualCameraSuspected: false,
      unfamiliarNetwork: false
    }));
    const client = faceClient(failures);
    mockAnthropicCreate.mockResolvedValue(summaryResponse());

    await runInTenant(client, () => summarizeFaceReviewAttempt({ attemptId: "a1" }));

    expect(promptSent()).toContain("further NOTABLE attempts omitted");
  });
});
