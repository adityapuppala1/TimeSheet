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

const { assertAIFeatureEnabled, assertWithinBudget, classifyTicket, estimateCostUsd } = await import("../../src/services/ai.service.js");

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
