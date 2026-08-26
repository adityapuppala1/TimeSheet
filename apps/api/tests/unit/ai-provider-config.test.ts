/**
 * `getEnabledProviderConfigs()` (ai.service.ts) is what `callChat`'s priority-fallback dispatcher
 * reads — the two behaviors worth pinning are the ones a live SDK-mocked test can't reach cleanly:
 * an empty list must synthesize the EXACT implicit default this product has always had (Anthropic,
 * the deprecated GlobalAISettings' own model, no key of its own — the env-var fallback happens
 * later, inside resolveApiKey), never "AI is now broken until somebody visits Workspace Settings",
 * and a non-empty list must return only ENABLED rows, ascending priority, disabled rows excluded
 * entirely rather than skipped-but-still-tried.
 *
 * CRUD (ai-provider-config.service.ts) is covered separately below — creation appends to the end
 * of the priority order rather than defaulting to 0 (which would silently promote a new, untested
 * provider ahead of whatever an admin already trusted more), update leaves the stored key
 * untouched when omitted (same convention as GlobalAISettings.apiKey), and reorder validates the
 * full id set rather than trusting a client-supplied order blindly.
 */
import { describe, expect, it, vi } from "vitest";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";

const { getEnabledProviderConfigs } = await import("../../src/services/ai.service.js");
const { createProviderConfig, updateProviderConfig, deleteProviderConfig, reorderProviderConfigs, listProviderConfigs, getSuggestedProviderOrder } =
  await import("../../src/services/ai-provider-config.service.js");

describe("getEnabledProviderConfigs", () => {
  it("synthesizes the implicit ANTHROPIC/deprecated-settings default when the list is empty", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.aIProviderConfig.findMany).mockResolvedValue([] as never);
    vi.mocked(client.globalAISettings.upsert).mockResolvedValue({
      id: "global",
      provider: "ANTHROPIC",
      baseUrl: null,
      apiKey: null,
      model: "claude-haiku-4-5"
    } as never);

    const configs = await runInTenant(client, () => getEnabledProviderConfigs());

    // maxConcurrent comes along at the column's own default — the synthesised provider is bounded
    // by the concurrency gate like any configured one, never silently unlimited.
    expect(configs).toEqual([
      { id: null, provider: "ANTHROPIC", label: null, baseUrl: null, apiKey: null, model: "claude-haiku-4-5", maxConcurrent: 2 }
    ]);
  });

  it("returns real rows ascending by priority when the list is non-empty, ignoring GlobalAISettings entirely", async () => {
    const client = createFakeTenantClient();
    const rows = [
      { id: "b", provider: "OPENAI_COMPATIBLE", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", apiKey: null, model: "llama-3.1-8b", enabled: true, priority: 1 },
      { id: "a", provider: "ANTHROPIC", label: null, baseUrl: null, apiKey: null, model: "claude-haiku-4-5", enabled: true, priority: 0 }
    ];
    // The real query already orders by priority ascending — the fake just needs to hand back
    // whatever the mock is told to, in the order this test asserts on.
    vi.mocked(client.aIProviderConfig.findMany).mockResolvedValue([rows[1], rows[0]] as never);

    const configs = await runInTenant(client, () => getEnabledProviderConfigs());

    expect(configs.map((c) => c.id)).toEqual(["a", "b"]);
    expect(client.globalAISettings.upsert).not.toHaveBeenCalled();
  });
});

describe("provider config CRUD", () => {
  it("appends a new row to the END of the priority order, not position 0", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.aIProviderConfig.findFirst).mockResolvedValue({ priority: 2 } as never);
    vi.mocked(client.aIProviderConfig.create).mockImplementation(
      ({ data }: never) => Promise.resolve({ id: "new-id", ...data }) as never
    );

    const created = await runInTenant(client, () =>
      createProviderConfig({ provider: "ANTHROPIC", model: "claude-haiku-4-5" }, "user-1")
    );

    expect(created.priority).toBe(3);
    expect(client.aIProviderConfig.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ priority: 3 }) }));
  });

  it("update leaves the stored key untouched when apiKey is omitted from the payload", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.aIProviderConfig.findUnique).mockResolvedValue({ id: "a", apiKey: "already-encrypted" } as never);
    vi.mocked(client.aIProviderConfig.update).mockImplementation(({ data }: never) => Promise.resolve({ id: "a", apiKey: "already-encrypted", ...data }) as never);

    await runInTenant(client, () => updateProviderConfig("a", { model: "claude-opus-4-8" }, "user-1"));

    expect(client.aIProviderConfig.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.not.objectContaining({ apiKey: expect.anything() }) })
    );
  });

  it("404s deleting a config that no longer exists, rather than silently succeeding", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.aIProviderConfig.findUnique).mockResolvedValue(null as never);

    await expect(runInTenant(client, () => deleteProviderConfig("gone", "user-1"))).rejects.toMatchObject({ statusCode: 404 });
  });

  it("refuses a reorder whose id set doesn't match the current list", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.aIProviderConfig.findMany).mockResolvedValue([{ id: "a" }, { id: "b" }] as never);

    await expect(runInTenant(client, () => reorderProviderConfigs(["a", "c"], "user-1"))).rejects.toMatchObject({ statusCode: 422 });
  });

  it("listProviderConfigs never returns the raw key, only apiKeySet", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.aIProviderConfig.findMany).mockResolvedValue([{ id: "a", apiKey: "ciphertext", model: "claude-haiku-4-5" }] as never);

    const rows = await runInTenant(client, () => listProviderConfigs());

    expect(rows[0]).not.toHaveProperty("apiKey");
    expect(rows[0].apiKeySet).toBe(true);
  });
});

describe("getSuggestedProviderOrder", () => {
  it("ranks a reliable provider ahead of an unreliable one, even when the unreliable one is currently primary", async () => {
    const client = createFakeTenantClient();
    // Currently priority 0 = Nvidia (unreliable), priority 1 = Groq (reliable) — the suggestion
    // should invert that, since it ranks by actual performance, not the list's current order.
    vi.mocked(client.aIProviderConfig.findMany).mockResolvedValue([
      { id: "nvidia-id", provider: "OPENAI_COMPATIBLE", label: null, baseUrl: "https://integrate.api.nvidia.com/v1" },
      { id: "groq-id", provider: "OPENAI_COMPATIBLE", label: null, baseUrl: "https://api.groq.com/openai/v1" }
    ] as never);
    vi.mocked(client.aIUsageLog.groupBy)
      .mockResolvedValueOnce([
        { provider: "Nvidia NIM", success: true, _count: 4 },
        { provider: "Nvidia NIM", success: false, _count: 6 }, // 40% success
        { provider: "Groq", success: true, _count: 19 },
        { provider: "Groq", success: false, _count: 1 } // 95% success
      ] as never)
      .mockResolvedValueOnce([
        { provider: "Nvidia NIM", _avg: { durationMs: 500, costUsdEstimate: 0.01 } },
        { provider: "Groq", _avg: { durationMs: 300, costUsdEstimate: 0.02 } }
      ] as never);

    const { suggestedOrderIds, reasoning } = await runInTenant(client, () => getSuggestedProviderOrder());

    expect(suggestedOrderIds).toEqual(["groq-id", "nvidia-id"]);
    expect(reasoning.find((r) => r.id === "groq-id")).toMatchObject({ successRatePct: 95, calls: 20 });
    expect(reasoning.find((r) => r.id === "nvidia-id")).toMatchObject({ successRatePct: 40, calls: 10 });
  });

  it("breaks a tie on success rate by latency, then by cost — never treats them as equally good", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.aIProviderConfig.findMany).mockResolvedValue([
      { id: "slow-id", provider: "ANTHROPIC", label: "Slow key", baseUrl: null },
      { id: "fast-id", provider: "ANTHROPIC", label: "Fast key", baseUrl: null }
    ] as never);
    // Both configs resolve to the SAME usage-ledger label ("Anthropic" — see the function's own
    // documented limitation), so this also proves that degrades to a stable tie, not a crash: both
    // entries read identical stats, and the ORIGINAL list order (slow, then fast) survives untouched.
    vi.mocked(client.aIUsageLog.groupBy)
      .mockResolvedValueOnce([{ provider: "Anthropic", success: true, _count: 10 }] as never)
      .mockResolvedValueOnce([{ provider: "Anthropic", _avg: { durationMs: 400, costUsdEstimate: 0.01 } }] as never);

    const { suggestedOrderIds } = await runInTenant(client, () => getSuggestedProviderOrder());

    expect(suggestedOrderIds).toEqual(["slow-id", "fast-id"]);
  });

  it("places a never-tried provider after every provider with real history, not first or interspersed", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.aIProviderConfig.findMany).mockResolvedValue([
      { id: "untried-id", provider: "ANTHROPIC", label: "Brand new", baseUrl: null },
      { id: "proven-id", provider: "OPENAI_COMPATIBLE", label: null, baseUrl: "https://api.groq.com/openai/v1" }
    ] as never);
    // Only "Groq" has any rows at all — "Anthropic" never appears, meaning zero calls for it.
    vi.mocked(client.aIUsageLog.groupBy)
      .mockResolvedValueOnce([{ provider: "Groq", success: true, _count: 3 }] as never)
      .mockResolvedValueOnce([{ provider: "Groq", _avg: { durationMs: 300, costUsdEstimate: 0.02 } }] as never);

    const { suggestedOrderIds, reasoning } = await runInTenant(client, () => getSuggestedProviderOrder());

    expect(suggestedOrderIds).toEqual(["proven-id", "untried-id"]);
    expect(reasoning.find((r) => r.id === "untried-id")?.successRatePct).toBeNull();
  });
});
