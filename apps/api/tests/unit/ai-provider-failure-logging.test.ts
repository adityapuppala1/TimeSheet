/**
 * `callChat`'s priority-fallback dispatcher (V9, provider-priority) now logs every failed
 * ATTEMPT against a provider, not only the final outcome — the missing half of "which provider
 * actually gets the job done" (AIUsageLog previously only ever recorded successes). Three
 * behaviours worth pinning, none exercised by ai-cost-routing.test.ts or ai-usage-breakdown.test.ts:
 *
 *  1. A single-config workspace that fails still gets a `success: false` row — the failure ledger
 *     isn't something that only starts existing once a fallback is configured.
 *  2. A fallback that succeeds logs BOTH: a failure row for the provider that was tried and
 *     rejected, and a normal success row (written by the capability function itself, exactly as
 *     before) for the one that actually answered.
 *  3. A non-availability error (not translated to a 502 — a real bug, not "try the next provider")
 *     still gets logged as a failure, but does NOT trigger a second attempt even when a second
 *     config is configured and available.
 *
 * Doesn't need a real SDK error instance to prove any of this: the failure-logging call happens
 * unconditionally on ANY caught error, before the fallthrough-vs-stop decision is even made, so a
 * plain rejected `Error` (never translated into an AppError at all) is enough to exercise it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";

const { mockAnthropicCreate, FakeAPIError } = vi.hoisted(() => {
  // A minimal stand-in for the real SDK's `APIError` — needs to exist as a real class so
  // `translateProviderError`'s `error instanceof Anthropic.APIError` check has something to check
  // against. Without this, `Anthropic.APIError` is `undefined` under the mock below and that
  // `instanceof` throws "right-hand side is not callable" the instant ANY rejection reaches it —
  // not a test failure, a crash unrelated to whatever the test meant to assert.
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

const { mockGetEffectiveAiBudgetCeiling } = vi.hoisted(() => ({ mockGetEffectiveAiBudgetCeiling: vi.fn() }));
vi.mock("../../src/services/plan-limits.service.js", () => ({
  getEffectiveAiBudgetCeiling: mockGetEffectiveAiBudgetCeiling
}));

const { classifyTicket } = await import("../../src/services/ai.service.js");

function settings(overrides: Record<string, unknown> = {}) {
  return {
    id: "global",
    aiEnabled: true,
    autoTriageEnabled: true,
    model: "claude-haiku-4-5",
    provider: "ANTHROPIC",
    confidenceThreshold: 0.6,
    monthlyBudgetUsd: null,
    baseUrl: null,
    apiKey: null,
    ...overrides
  };
}

function baseClient(configs: unknown[] = []) {
  const client = createFakeTenantClient();
  vi.mocked(client.globalAISettings.upsert).mockResolvedValue(settings() as never);
  vi.mocked(client.aIUsageLog.aggregate).mockResolvedValue({ _sum: { costUsdEstimate: 0 } } as never);
  vi.mocked(client.aIProviderConfig.findMany).mockResolvedValue(configs as never);
  return client;
}

const TRIAGE_ARGS = {
  title: "Login button does nothing",
  description: "Clicking sign in on Safari does nothing at all.",
  project: { id: "p1", name: "Web", modules: [] },
  typeNames: ["BUG", "TASK"],
  userId: "u1"
};

/** Every `data:` payload passed to a `aIUsageLog.create` call. */
function loggedRows(client: ReturnType<typeof baseClient>) {
  return vi.mocked(client.aIUsageLog.create).mock.calls.map((call) => (call[0] as { data: Record<string, unknown> }).data);
}

beforeEach(() => {
  mockAnthropicCreate.mockReset();
  mockGetEffectiveAiBudgetCeiling.mockReset().mockResolvedValue(100);
});

describe("callChat logs every failed attempt, not just the final outcome", () => {
  it("logs success: false with the reason when the only configured provider fails", async () => {
    const client = baseClient([]); // empty -> synthesized implicit ANTHROPIC default
    mockAnthropicCreate.mockRejectedValueOnce(new Error("socket hang up"));

    await expect(runInTenant(client, () => classifyTicket(TRIAGE_ARGS as never))).rejects.toThrow();

    const rows = loggedRows(client);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ feature: "triage", success: false, errorReason: "socket hang up", inputTokens: 0, outputTokens: 0 });
  });

  it("logs a failure row for the rejected provider AND a normal success row for the fallback that answered", async () => {
    const client = baseClient([
      { id: "a", provider: "ANTHROPIC", label: null, baseUrl: null, apiKey: null, model: "claude-opus-4-8", enabled: true, priority: 0 },
      { id: "b", provider: "ANTHROPIC", label: "Backup key", baseUrl: null, apiKey: null, model: "claude-3-5-haiku-legacy", enabled: true, priority: 1 }
    ]);
    // `triage` is a MECHANICAL feature (see economyModelFor) — it always requests the economy
    // model, "claude-haiku-4-5", regardless of the primary config's own `.model` field ("claude-
    // opus-4-8" here is deliberately never the one actually asked for, matching how the PRIMARY
    // slot honors the caller's requested model, not its own config row — see callChat's header).
    //
    // First attempt rejects the way a real Anthropic SDK 401 would — translateProviderError
    // recognizes FakeAPIError the same way it recognizes the real SDK's APIError, so this
    // exercises the actual AppError(502, ...) path.
    mockAnthropicCreate.mockRejectedValueOnce(new FakeAPIError(401, "401 Invalid API Key"));
    mockAnthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify({ type: "BUG", priority: "HIGH", moduleName: "NONE", confidence: 0.9, reasoning: "r" }) }],
      usage: { input_tokens: 100, output_tokens: 20 }
    });

    await runInTenant(client, () => classifyTicket(TRIAGE_ARGS as never));

    const rows = loggedRows(client);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ success: false, model: "claude-haiku-4-5" });
    // The fallback config's OWN model, not what the caller originally asked the primary for — a
    // fallback wasn't chosen for its catalogue to happen to include that name.
    expect(rows[1]).toMatchObject({ success: true, model: "claude-3-5-haiku-legacy", provider: "Anthropic" });
  });

  it("does not attempt a second configured provider when the first error isn't an availability failure", async () => {
    const client = baseClient([
      { id: "a", provider: "ANTHROPIC", label: null, baseUrl: null, apiKey: null, model: "claude-opus-4-8", enabled: true, priority: 0 },
      { id: "b", provider: "ANTHROPIC", label: null, baseUrl: null, apiKey: null, model: "claude-3-5-haiku-legacy", enabled: true, priority: 1 }
    ]);
    // A plain Error, never translated into an AppError at all — not the "try the next provider"
    // signal, so the second config must never be touched.
    mockAnthropicCreate.mockRejectedValueOnce(new TypeError("Cannot read properties of undefined"));

    await expect(runInTenant(client, () => classifyTicket(TRIAGE_ARGS as never))).rejects.toThrow();

    expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
    const rows = loggedRows(client);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ success: false, model: "claude-haiku-4-5" });
  });
});
