/**
 * Tests for AI interaction capture — the foundation of the quality loop.
 *
 * The privacy rules here are the highest-consequence part: capture stores real user content
 * (ticket descriptions, timesheet notes, PR diffs), and the face-verification features carry a
 * documented promise that their prompts contain metadata only and never leave the server. A
 * regression in either rule is a compliance problem, not a cosmetic bug, so both are pinned.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";

vi.mock("../../src/services/plan-limits.service.js", () => ({
  getEffectiveAiBudgetCeiling: vi.fn().mockResolvedValue(100)
}));

const { logAIUsage } = await import("../../src/services/ai.service.js");

function settings(overrides: Record<string, unknown> = {}) {
  return {
    id: "global",
    aiEnabled: true,
    provider: "ANTHROPIC",
    model: "claude-sonnet-5",
    aiCaptureEnabled: false,
    aiCaptureContentEnabled: false,
    aiCaptureRetentionDays: 30,
    monthlyBudgetUsd: null,
    apiKey: null,
    baseUrl: null,
    ...overrides
  };
}

let client: ReturnType<typeof createFakeTenantClient>;
beforeEach(() => {
  client = createFakeTenantClient();
  vi.mocked(client.aIUsageLog.create).mockResolvedValue({} as never);
  vi.mocked(client.aIInteraction.create).mockResolvedValue({} as never);
});

const CALL = {
  feature: "triage",
  model: "claude-sonnet-5",
  inputTokens: 100,
  outputTokens: 20,
  prompt: "Ticket description written by a real person",
  output: '{"type":"BUG"}',
  params: { title: "Login broken" },
  parseOk: true,
  latencyMs: 42
};

function captured() {
  return vi.mocked(client.aIInteraction.create).mock.calls[0]?.[0]?.data as Record<string, unknown> | undefined;
}

describe("AI interaction capture", () => {
  it("captures nothing at all while the toggle is off", async () => {
    vi.mocked(client.globalAISettings.upsert).mockResolvedValue(settings() as never);
    await runInTenant(client, () => logAIUsage(CALL));

    expect(client.aIInteraction.create).not.toHaveBeenCalled();
    // …but usage/cost logging is unaffected — that has always been unconditional.
    expect(client.aIUsageLog.create).toHaveBeenCalledOnce();
  });

  it("captures metadata but NO user content when only the metadata toggle is on", async () => {
    vi.mocked(client.globalAISettings.upsert).mockResolvedValue(settings({ aiCaptureEnabled: true }) as never);
    await runInTenant(client, () => logAIUsage(CALL));

    const row = captured();
    expect(row?.feature).toBe("triage");
    expect(row?.parseOk).toBe(true);
    expect(row?.latencyMs).toBe(42);
    // The hash is still recorded — it identifies that a prompt changed without retaining what
    // anybody actually wrote.
    expect(row?.promptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(row?.promptText).toBeNull();
    expect(row?.outputText).toBeNull();
    expect(row?.paramsJson).toBeUndefined();
  });

  it("captures content only when the second, separate toggle is also on", async () => {
    vi.mocked(client.globalAISettings.upsert).mockResolvedValue(
      settings({ aiCaptureEnabled: true, aiCaptureContentEnabled: true }) as never
    );
    await runInTenant(client, () => logAIUsage(CALL));

    const row = captured();
    expect(row?.promptText).toBe(CALL.prompt);
    expect(row?.outputText).toBe(CALL.output);
    expect(row?.paramsJson).toEqual({ title: "Login broken" });
  });

  it("NEVER stores content for the face features, even with content capture fully enabled", async () => {
    // These prompts are documented as metadata-only and governed by the face-retention regime.
    // A text store of them would be a compliance regression, so the denylist is hardcoded rather
    // than admin-configurable.
    vi.mocked(client.globalAISettings.upsert).mockResolvedValue(
      settings({ aiCaptureEnabled: true, aiCaptureContentEnabled: true }) as never
    );

    for (const feature of ["face_review_summary", "face_policy_copilot"]) {
      vi.mocked(client.aIInteraction.create).mockClear();
      await runInTenant(client, () => logAIUsage({ ...CALL, feature }));
      const row = captured();
      expect(row?.feature).toBe(feature);
      // Still captured for metrics…
      expect(row?.promptHash).toMatch(/^[a-f0-9]{64}$/);
      // …but the content fields stay empty.
      expect(row?.promptText).toBeNull();
      expect(row?.outputText).toBeNull();
      expect(row?.paramsJson).toBeUndefined();
    }
  });

  it("truncates oversized content instead of writing enormous rows", async () => {
    // `ask_ai` embeds up to 150 tickets; uncapped this would be ~30KB per question.
    vi.mocked(client.globalAISettings.upsert).mockResolvedValue(
      settings({ aiCaptureEnabled: true, aiCaptureContentEnabled: true }) as never
    );
    await runInTenant(client, () => logAIUsage({ ...CALL, prompt: "x".repeat(20_000) }));

    const row = captured();
    expect((row?.promptText as string).length).toBe(8_000);
    expect(row?.promptTruncated).toBe(true);
    expect(row?.outputTruncated).toBe(false);
  });

  it("never fails the AI call when capture itself blows up", async () => {
    // By the time capture runs the model call has already succeeded and already cost money —
    // losing observability is acceptable, losing the result is not.
    vi.mocked(client.globalAISettings.upsert).mockResolvedValue(settings({ aiCaptureEnabled: true }) as never);
    vi.mocked(client.aIInteraction.create).mockRejectedValue(new Error("table is on fire"));

    await expect(runInTenant(client, () => logAIUsage(CALL))).resolves.toBeUndefined();
    expect(client.aIUsageLog.create).toHaveBeenCalledOnce();
  });
});
