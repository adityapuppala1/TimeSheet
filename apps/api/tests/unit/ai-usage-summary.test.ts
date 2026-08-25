/**
 * `AIUsageLog` gained a `provider`/`durationMs` column (see the 20260825130000 migration) so the
 * monthly usage panel can answer "which provider has consumed how much against the model" instead
 * of two independent flat lists that can't be cross-referenced. Two things are invisible without a
 * test: `logAIUsage` resolving the CURRENT provider from `GlobalAISettings` at write time rather
 * than storing the raw `OPENAI_COMPATIBLE` enum nobody can read, and `getMonthlyAIUsageSummary`
 * mapping a pre-migration row's `provider: null` to "Unknown" instead of guessing — a silent wrong
 * guess would misattribute historical spend the first time a workspace ever switches providers.
 */
import { describe, expect, it, vi } from "vitest";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";

const { getMonthlyAIUsageSummary, logAIUsage } = await import("../../src/services/ai.service.js");

function settings(overrides: Record<string, unknown> = {}) {
  return {
    id: "global",
    aiEnabled: true,
    aiCaptureEnabled: false,
    model: "claude-haiku-4-5",
    provider: "ANTHROPIC",
    baseUrl: null,
    apiKey: null,
    ...overrides
  };
}

function baseClient(overrides: Record<string, unknown> = {}) {
  const client = createFakeTenantClient();
  vi.mocked(client.globalAISettings.upsert).mockResolvedValue(settings(overrides) as never);
  return client;
}

describe("logAIUsage resolves the provider that actually served the call", () => {
  it("writes Anthropic's friendly label and the measured duration", async () => {
    const client = baseClient({ provider: "ANTHROPIC" });

    await runInTenant(client, () =>
      logAIUsage({ feature: "triage", model: "claude-haiku-4-5", inputTokens: 10, outputTokens: 5, latencyMs: 842 })
    );

    expect(client.aIUsageLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ provider: "Anthropic", durationMs: 842 }) })
    );
  });

  it("resolves an OPENAI_COMPATIBLE baseUrl to its preset's label, not the raw enum", async () => {
    const client = baseClient({ provider: "OPENAI_COMPATIBLE", baseUrl: "https://api.mistral.ai/v1" });

    await runInTenant(client, () =>
      logAIUsage({ feature: "triage", model: "mistral-large-latest", inputTokens: 10, outputTokens: 5 })
    );

    expect(client.aIUsageLog.create).toHaveBeenCalledWith(
      // No latencyMs passed — durationMs must be null, not 0 ("not measured" vs "instant").
      expect.objectContaining({ data: expect.objectContaining({ provider: "Mistral", durationMs: null }) })
    );
  });

  it("falls back to the bare hostname for a custom endpoint matching no known preset", async () => {
    const client = baseClient({ provider: "OPENAI_COMPATIBLE", baseUrl: "https://models.example.internal/v1" });

    await runInTenant(client, () => logAIUsage({ feature: "triage", model: "house-model", inputTokens: 10, outputTokens: 5 }));

    expect(client.aIUsageLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ provider: "models.example.internal" }) })
    );
  });
});

/** Shapes one `groupBy` row the way Prisma actually returns it: dimension fields spread beside
 *  `_sum`/`_count`, not nested under them. */
function groupByRow(
  extra: Record<string, unknown>,
  sum: { costUsdEstimate?: number; inputTokens?: number; outputTokens?: number },
  count: number
) {
  return { ...extra, _sum: { costUsdEstimate: sum.costUsdEstimate ?? 0, inputTokens: sum.inputTokens ?? 0, outputTokens: sum.outputTokens ?? 0 }, _count: count };
}

describe("getMonthlyAIUsageSummary's provider breakdown", () => {
  it("maps byProvider and the provider×model cross-tab, labeling pre-migration rows Unknown", async () => {
    const client = baseClient();
    // Promise.all evaluates the array in order: aggregate(total), groupBy(feature), groupBy(model),
    // groupBy(provider), groupBy(providerModel), aggregate(agentDriven), agentRun.groupBy(byFlow).
    vi.mocked(client.aIUsageLog.aggregate)
      .mockResolvedValueOnce({ _sum: { costUsdEstimate: 10, inputTokens: 100, outputTokens: 50 }, _count: 3 } as never)
      .mockResolvedValueOnce({ _sum: { costUsdEstimate: 0, inputTokens: 0, outputTokens: 0 }, _count: 0 } as never);
    vi.mocked(client.aIUsageLog.groupBy)
      .mockResolvedValueOnce([groupByRow({ feature: "triage" }, { costUsdEstimate: 10, inputTokens: 100, outputTokens: 50 }, 3)] as never)
      .mockResolvedValueOnce([groupByRow({ model: "claude-haiku-4-5" }, { costUsdEstimate: 10, inputTokens: 100, outputTokens: 50 }, 3)] as never)
      .mockResolvedValueOnce([
        groupByRow({ provider: "Anthropic" }, { costUsdEstimate: 7, inputTokens: 70, outputTokens: 30 }, 2),
        // A row from before the provider column existed — must read "Unknown", never a guess.
        groupByRow({ provider: null }, { costUsdEstimate: 3, inputTokens: 30, outputTokens: 20 }, 1)
      ] as never)
      .mockResolvedValueOnce([
        groupByRow({ provider: "Anthropic", model: "claude-haiku-4-5" }, { costUsdEstimate: 7, inputTokens: 70, outputTokens: 30 }, 2),
        groupByRow({ provider: null, model: "claude-haiku-4-5" }, { costUsdEstimate: 3, inputTokens: 30, outputTokens: 20 }, 1)
      ] as never);
    vi.mocked(client.agentRun.groupBy).mockResolvedValue([] as never);

    const summary = await runInTenant(client, () => getMonthlyAIUsageSummary());

    expect(summary.byProvider).toEqual([
      { provider: "Anthropic", costUsd: 7, inputTokens: 70, outputTokens: 30, calls: 2 },
      { provider: "Unknown", costUsd: 3, inputTokens: 30, outputTokens: 20, calls: 1 }
    ]);
    expect(summary.byProviderModel).toEqual([
      { provider: "Anthropic", model: "claude-haiku-4-5", costUsd: 7, inputTokens: 70, outputTokens: 30, calls: 2 },
      { provider: "Unknown", model: "claude-haiku-4-5", costUsd: 3, inputTokens: 30, outputTokens: 20, calls: 1 }
    ]);
  });
});
