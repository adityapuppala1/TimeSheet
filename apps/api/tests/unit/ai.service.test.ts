import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../src/middleware/error.js";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";

// `callChat` (ai.service.ts's own mockable seam per its header comment) is a module-private
// function, not exported — so the actual seam for an external test file is one level lower: the
// two SDKs it constructs directly. Every one of the 13 capability functions only ever reaches an
// LLM through `callAnthropic`/`callOpenAICompatible`, both of which construct `new Anthropic(...)`/
// `new OpenAI(...)` — mocking the SDK's default-exported class here is transparent to all of them.
const { mockAnthropicCreate } = vi.hoisted(() => ({ mockAnthropicCreate: vi.fn() }));
// Arrow functions can never be constructors, so `new Anthropic(...)` needs a real class here,
// not `vi.fn().mockImplementation(() => ...)`.
vi.mock("@anthropic-ai/sdk", () => ({
  default: class FakeAnthropic {
    messages = { create: mockAnthropicCreate };
  }
}));

// preflight() clamps the org's own budget against its plan-tier ceiling via this control-plane
// lookup — mocking it here avoids needing a real control-plane database for AI unit tests.
const { mockGetEffectiveAiBudgetCeiling } = vi.hoisted(() => ({ mockGetEffectiveAiBudgetCeiling: vi.fn() }));
vi.mock("../../src/services/plan-limits.service.js", () => ({
  getEffectiveAiBudgetCeiling: mockGetEffectiveAiBudgetCeiling
}));

const { assertAIFeatureEnabled, assertWithinBudget, classifyTicket, estimateCostUsd, reviewPullRequestDiff } = await import(
  "../../src/services/ai.service.js"
);

function fakeGlobalAiSettings(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "global",
    aiEnabled: true,
    autoTriageEnabled: true,
    duplicateDetectionEnabled: false,
    writingAssistantEnabled: false,
    commentSummaryEnabled: false,
    workspaceSearchEnabled: false,
    emailIngestionEnabled: false,
    chatIngestionEnabled: false,
    weeklyDigestEnabled: false,
    ciFailureTriageEnabled: false,
    aiPrReviewSummaryEnabled: false,
    findingTriageEnabled: false,
    securityWeeklyDigestEnabled: false,
    statusReportEnabled: false,
    facePolicyCopilotEnabled: false,
    bugPatternDigestEnabled: false,
    assigneeSuggestionAiEnabled: false,
    staleTicketNudgeEnabled: false,
    aiPrInlineReviewEnabled: false,
    model: "claude-sonnet-5",
    confidenceThreshold: 0.6,
    monthlyBudgetUsd: null,
    provider: "ANTHROPIC",
    baseUrl: null,
    apiKey: null,
    ...overrides
  };
}

beforeEach(() => {
  mockAnthropicCreate.mockReset();
  mockGetEffectiveAiBudgetCeiling.mockReset().mockResolvedValue(100);
});

describe("estimateCostUsd", () => {
  it("uses the known per-model pricing table for a recognized model", () => {
    expect(estimateCostUsd("claude-sonnet-5", 1_000_000, 1_000_000)).toBe(2 + 10);
  });

  it("falls back to DEFAULT_PRICING for an unrecognized model", () => {
    expect(estimateCostUsd("some-unknown-model", 1_000_000, 1_000_000)).toBe(3 + 15);
  });
});

describe("assertAIFeatureEnabled", () => {
  it("throws 403 when the workspace-wide AI switch is off", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.globalAISettings.upsert).mockResolvedValue(fakeGlobalAiSettings({ aiEnabled: false }) as never);

    await expect(runInTenant(client, () => assertAIFeatureEnabled("autoTriageEnabled"))).rejects.toMatchObject({
      statusCode: 403
    } satisfies Partial<AppError>);
  });

  it("throws 403 when AI is on workspace-wide but this specific feature's toggle is off", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.globalAISettings.upsert).mockResolvedValue(
      fakeGlobalAiSettings({ aiEnabled: true, autoTriageEnabled: false }) as never
    );

    await expect(runInTenant(client, () => assertAIFeatureEnabled("autoTriageEnabled"))).rejects.toMatchObject({ statusCode: 403 });
  });

  it("returns the settings row when both the master switch and the feature toggle are on", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.globalAISettings.upsert).mockResolvedValue(fakeGlobalAiSettings() as never);

    await expect(runInTenant(client, () => assertAIFeatureEnabled("autoTriageEnabled"))).resolves.toMatchObject({ aiEnabled: true });
  });
});

describe("assertWithinBudget", () => {
  it("is a no-op when no budget is configured (null)", async () => {
    const client = createFakeTenantClient();
    await expect(runInTenant(client, () => assertWithinBudget(null))).resolves.toBeUndefined();
    expect(client.aIUsageLog.aggregate).not.toHaveBeenCalled();
  });

  it("throws 402 once this month's spend has reached the budget", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.aIUsageLog.aggregate).mockResolvedValue({ _sum: { costUsdEstimate: 10 } } as never);

    await expect(runInTenant(client, () => assertWithinBudget(10))).rejects.toMatchObject({ statusCode: 402 });
  });

  it("does not throw when spend is under the budget", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.aIUsageLog.aggregate).mockResolvedValue({ _sum: { costUsdEstimate: 1 } } as never);

    await expect(runInTenant(client, () => assertWithinBudget(10))).resolves.toBeUndefined();
  });
});

const CLASSIFY_PARAMS = {
  title: "Login button does nothing",
  description: "<p>Clicking sign in has no effect on Safari.</p>",
  project: { id: "proj-1", name: "Web App", modules: [{ id: "mod-1", name: "Auth" }] },
  typeNames: ["BUG", "TASK"]
};

describe("classifyTicket", () => {
  it("blocks the call before ever reaching the model when the feature toggle is off", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.globalAISettings.upsert).mockResolvedValue(
      fakeGlobalAiSettings({ autoTriageEnabled: false }) as never
    );

    await expect(runInTenant(client, () => classifyTicket(CLASSIFY_PARAMS))).rejects.toMatchObject({ statusCode: 403 });
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
  });

  it("blocks the call before ever reaching the model when the monthly budget is exhausted", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.globalAISettings.upsert).mockResolvedValue(fakeGlobalAiSettings({ monthlyBudgetUsd: 5 }) as never);
    vi.mocked(client.aIUsageLog.aggregate).mockResolvedValue({ _sum: { costUsdEstimate: 5 } } as never);

    await expect(runInTenant(client, () => classifyTicket(CLASSIFY_PARAMS))).rejects.toMatchObject({ statusCode: 402 });
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
  });

  it("classifies a ticket end-to-end and logs AI usage, when allowed", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.globalAISettings.upsert).mockResolvedValue(fakeGlobalAiSettings() as never);
    vi.mocked(client.aIUsageLog.aggregate).mockResolvedValue({ _sum: { costUsdEstimate: 0 } } as never);
    mockAnthropicCreate.mockResolvedValue({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            type: "BUG",
            priority: "HIGH",
            moduleName: "Auth",
            confidence: 0.92,
            reasoning: "Sign-in click handler appears unresponsive on Safari."
          })
        }
      ],
      usage: { input_tokens: 120, output_tokens: 40 }
    });

    const result = await runInTenant(client, () => classifyTicket(CLASSIFY_PARAMS));

    expect(result).toEqual({
      type: "BUG",
      priority: "HIGH",
      moduleId: "mod-1",
      confidence: 0.92,
      reasoning: "Sign-in click handler appears unresponsive on Safari."
    });
    expect(client.aIUsageLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ feature: "triage", inputTokens: 120, outputTokens: 40 })
      })
    );
  });

  it("throws a 502 when the model's response doesn't parse against the expected schema", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.globalAISettings.upsert).mockResolvedValue(fakeGlobalAiSettings() as never);
    vi.mocked(client.aIUsageLog.aggregate).mockResolvedValue({ _sum: { costUsdEstimate: 0 } } as never);
    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: "text", text: "not json at all" }],
      usage: { input_tokens: 10, output_tokens: 5 }
    });

    await expect(runInTenant(client, () => classifyTicket(CLASSIFY_PARAMS))).rejects.toMatchObject({ statusCode: 502 });
  });
});

describe("reviewPullRequestDiff", () => {
  // A realistic unified diff: one context line, one removed line (no new-file line number), two
  // added lines, one trailing context line. Hand-traced expected valid new-file lines: 1 (the
  // leading context line), 2 and 3 (the two added lines), 4 (the trailing context line) — the
  // removed line consumes no new-file line number at all.
  const SAMPLE_PATCH = "@@ -1,3 +1,4 @@\n line1\n-old line\n+new line\n+another new line\n line4";

  it("skips the AI call entirely (returns null) when there are no files with patches", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.globalAISettings.upsert).mockResolvedValue(fakeGlobalAiSettings({ aiPrInlineReviewEnabled: true }) as never);
    vi.mocked(client.aIUsageLog.aggregate).mockResolvedValue({ _sum: { costUsdEstimate: 0 } } as never);

    const result = await runInTenant(client, () =>
      reviewPullRequestDiff({ title: "No-op PR", filesChanged: [{ path: "README.md" }] })
    );

    expect(result).toBeNull();
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
  });

  it("skips the AI call entirely (returns null) when the diff is too large to review meaningfully", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.globalAISettings.upsert).mockResolvedValue(fakeGlobalAiSettings({ aiPrInlineReviewEnabled: true }) as never);
    vi.mocked(client.aIUsageLog.aggregate).mockResolvedValue({ _sum: { costUsdEstimate: 0 } } as never);

    // 16 files with patches exceeds INLINE_REVIEW_MAX_FILES (15).
    const filesChanged = Array.from({ length: 16 }, (_, i) => ({ path: `src/file-${i}.ts`, patch: SAMPLE_PATCH }));

    const result = await runInTenant(client, () => reviewPullRequestDiff({ title: "Huge PR", filesChanged }));

    expect(result).toBeNull();
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
  });

  it("drops a comment whose line was never part of the diff, keeping only genuinely valid ones", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.globalAISettings.upsert).mockResolvedValue(fakeGlobalAiSettings({ aiPrInlineReviewEnabled: true }) as never);
    vi.mocked(client.aIUsageLog.aggregate).mockResolvedValue({ _sum: { costUsdEstimate: 0 } } as never);
    mockAnthropicCreate.mockResolvedValue({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            comments: [
              { path: "src/foo.ts", line: 2, body: "Genuine concern about the added line." },
              { path: "src/foo.ts", line: 99, body: "Hallucinated — line 99 is nowhere in this diff." },
              { path: "src/never-touched.ts", line: 1, body: "Hallucinated — this file was never in filesChanged at all." }
            ]
          })
        }
      ],
      usage: { input_tokens: 200, output_tokens: 60 }
    });

    const result = await runInTenant(client, () =>
      reviewPullRequestDiff({ title: "Fix the thing", filesChanged: [{ path: "src/foo.ts", patch: SAMPLE_PATCH }] })
    );

    expect(result).toEqual({ comments: [{ path: "src/foo.ts", line: 2, body: "Genuine concern about the added line." }] });
  });

  it("blocks the call before ever reaching the model when the feature toggle is off", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.globalAISettings.upsert).mockResolvedValue(fakeGlobalAiSettings({ aiPrInlineReviewEnabled: false }) as never);

    await expect(
      runInTenant(client, () => reviewPullRequestDiff({ title: "Fix the thing", filesChanged: [{ path: "src/foo.ts", patch: SAMPLE_PATCH }] }))
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
  });
});
