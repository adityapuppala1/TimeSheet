/**
 * `getAIUsageBreakdown` is the new range-scoped, provider×model function behind the redesigned
 * usage table (see ai-usage-summary.test.ts for its sibling, `getMonthlyAIUsageSummary`, which
 * this deliberately does NOT touch or replace — that one still feeds the AI Overview widget).
 * Two things need pinning: the average-latency computation must skip unmeasured calls rather than
 * treating a NULL `durationMs` as zero (which would understate every provider that has a mix of
 * measured and unmeasured calls), and the feature-filter dropdown's own option list must not
 * collapse to one entry the moment a feature is actually selected.
 */
import { describe, expect, it, vi } from "vitest";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";

const { getAIUsageBreakdown } = await import("../../src/services/ai.service.js");

function groupByRow(extra: Record<string, unknown>, sum: Record<string, number>, avg: Record<string, number | null>, count: Record<string, number>) {
  return { ...extra, _sum: sum, _avg: avg, _count: count };
}

describe("getAIUsageBreakdown", () => {
  it("computes a NULL-safe average latency and reports how many calls it was actually measured on", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.aIUsageLog.aggregate)
      .mockResolvedValueOnce({ _sum: { costUsdEstimate: 5, inputTokens: 50, outputTokens: 25 }, _count: 3 } as never)
      .mockResolvedValueOnce({ _sum: { costUsdEstimate: 0, inputTokens: 0, outputTokens: 0 }, _count: 0 } as never);
    vi.mocked(client.aIUsageLog.groupBy)
      .mockResolvedValueOnce([
        // 2 of the 3 calls in this group had a measured duration (400ms, 600ms -> avg 500), the
        // third was never timed. SQL AVG() already excludes NULLs from numerator AND denominator,
        // so this must read 500, never (400+600+0)/3 = 333.
        groupByRow(
          { provider: "Anthropic", model: "claude-haiku-4-5" },
          { costUsdEstimate: 5, inputTokens: 50, outputTokens: 25 },
          { durationMs: 500 },
          { _all: 3, durationMs: 2 }
        )
      ] as never)
      // All 3 attempts in this group succeeded — the success/failure split groupBy.
      .mockResolvedValueOnce([{ provider: "Anthropic", model: "claude-haiku-4-5", success: true, _count: 3 }] as never)
      .mockResolvedValueOnce([{ feature: "triage", _count: 2 }, { feature: "ask_ai", _count: 1 }] as never);
    vi.mocked(client.agentRun.groupBy).mockResolvedValue([] as never);

    const breakdown = await runInTenant(client, () =>
      getAIUsageBreakdown({ from: new Date("2026-08-01"), to: new Date("2026-08-26") })
    );

    expect(breakdown.rows).toEqual([
      {
        provider: "Anthropic",
        model: "claude-haiku-4-5",
        calls: 3,
        successCount: 3,
        failureCount: 0,
        successRatePct: 100,
        inputTokens: 50,
        outputTokens: 25,
        totalTokens: 75,
        avgLatencyMs: 500,
        latencyMeasuredCalls: 2,
        costUsd: 5,
        costSharePct: 100
      }
    ]);
    expect(breakdown.overallSuccessRatePct).toBe(100);
    expect(breakdown.totalFailures).toBe(0);
  });

  it("keeps every feature in the filter's option list even when one is already selected", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.aIUsageLog.aggregate)
      .mockResolvedValueOnce({ _sum: { costUsdEstimate: 1, inputTokens: 10, outputTokens: 5 }, _count: 1 } as never)
      .mockResolvedValueOnce({ _sum: { costUsdEstimate: 0, inputTokens: 0, outputTokens: 0 }, _count: 0 } as never);
    vi.mocked(client.aIUsageLog.groupBy)
      .mockResolvedValueOnce([
        groupByRow({ provider: "Anthropic", model: "claude-haiku-4-5" }, { costUsdEstimate: 1, inputTokens: 10, outputTokens: 5 }, { durationMs: null }, { _all: 1, durationMs: 0 })
      ] as never)
      .mockResolvedValueOnce([{ provider: "Anthropic", model: "claude-haiku-4-5", success: true, _count: 1 }] as never)
      // The feature groupBy is scoped to the RANGE only, never the feature filter — this must
      // still list both features even though the call below filters to just "triage".
      .mockResolvedValueOnce([{ feature: "triage", _count: 1 }, { feature: "ask_ai", _count: 4 }] as never);
    vi.mocked(client.agentRun.groupBy).mockResolvedValue([] as never);

    const breakdown = await runInTenant(client, () =>
      getAIUsageBreakdown({ from: new Date("2026-08-01"), to: new Date("2026-08-26"), feature: "triage" })
    );

    expect(breakdown.features).toEqual([
      { feature: "ask_ai", calls: 4 },
      { feature: "triage", calls: 1 }
    ]);
    // The row itself still shows null/0 for a call that was never timed at all.
    expect(breakdown.rows[0].avgLatencyMs).toBeNull();
    expect(breakdown.rows[0].latencyMeasuredCalls).toBe(0);
  });

  it("splits a mixed group into successCount/failureCount and computes the right success rate", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.aIUsageLog.aggregate)
      .mockResolvedValueOnce({ _sum: { costUsdEstimate: 4, inputTokens: 400, outputTokens: 100 }, _count: 10 } as never)
      .mockResolvedValueOnce({ _sum: { costUsdEstimate: 0, inputTokens: 0, outputTokens: 0 }, _count: 0 } as never);
    vi.mocked(client.aIUsageLog.groupBy)
      .mockResolvedValueOnce([
        groupByRow({ provider: "Mistral", model: "mistral-large-latest" }, { costUsdEstimate: 4, inputTokens: 400, outputTokens: 100 }, { durationMs: 900 }, { _all: 10, durationMs: 7 })
      ] as never)
      // 7 of the 10 attempts succeeded, 3 were rejected (a bad key, say) — the failures cost/consumed
      // nothing, which is exactly why summing across BOTH buckets for cost/tokens above is safe: a
      // failure row's 0s never change the total, only the count needs the split.
      .mockResolvedValueOnce([
        { provider: "Mistral", model: "mistral-large-latest", success: true, _count: 7 },
        { provider: "Mistral", model: "mistral-large-latest", success: false, _count: 3 }
      ] as never)
      .mockResolvedValueOnce([{ feature: "triage", _count: 10 }] as never);
    vi.mocked(client.agentRun.groupBy).mockResolvedValue([] as never);

    const breakdown = await runInTenant(client, () => getAIUsageBreakdown({ from: new Date("2026-08-01"), to: new Date("2026-08-26") }));

    expect(breakdown.rows[0]).toMatchObject({ calls: 10, successCount: 7, failureCount: 3, successRatePct: 70 });
    expect(breakdown.overallSuccessRatePct).toBe(70);
    expect(breakdown.totalFailures).toBe(3);
  });
});
