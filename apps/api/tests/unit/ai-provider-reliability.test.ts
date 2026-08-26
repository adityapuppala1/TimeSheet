/**
 * The three reliability features layered onto the ranked provider list this session:
 * `computeRecentStatusByLabel` (the passive "is it working right now" badge),
 * `recordProviderAttemptOutcome` (the opt-in circuit breaker `callChat` drives per attempt), and
 * `getEnabledProviderConfigsForTask` (economy-tier tasks preferring the cheapest HEALTHY
 * provider, judgment tasks left untouched). Each is tested at the service layer, not through a
 * real model call — the same `createFakeTenantClient`/`runInTenant` pattern
 * `ai-provider-config.test.ts` already uses for `getSuggestedProviderOrder`.
 */
import { describe, expect, it, vi } from "vitest";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";

const { computeRecentStatusByLabel, recordProviderAttemptOutcome } = await import("../../src/services/ai-provider-config.service.js");
const { getEnabledProviderConfigsForTask } = await import("../../src/services/ai.service.js");

function outcomeRow(provider: string, success: boolean) {
  return { provider, success };
}

describe("computeRecentStatusByLabel", () => {
  it("reports healthy at 80% success and above", async () => {
    const client = createFakeTenantClient();
    // 4 of 5 succeed = 80% — exactly the healthy threshold.
    vi.mocked(client.aIUsageLog.findMany).mockResolvedValue([
      outcomeRow("Groq", true),
      outcomeRow("Groq", true),
      outcomeRow("Groq", true),
      outcomeRow("Groq", true),
      outcomeRow("Groq", false)
    ] as never);

    const status = await runInTenant(client, () => computeRecentStatusByLabel());
    expect(status.get("Groq")).toBe("healthy");
  });

  it("reports degraded between 0% and 80% success", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.aIUsageLog.findMany).mockResolvedValue([
      outcomeRow("OpenRouter", true),
      outcomeRow("OpenRouter", false),
      outcomeRow("OpenRouter", false)
    ] as never);

    const status = await runInTenant(client, () => computeRecentStatusByLabel());
    expect(status.get("OpenRouter")).toBe("degraded");
  });

  it("reports down at exactly 0% success with at least one attempt", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.aIUsageLog.findMany).mockResolvedValue([outcomeRow("Nvidia NIM", false), outcomeRow("Nvidia NIM", false)] as never);

    const status = await runInTenant(client, () => computeRecentStatusByLabel());
    expect(status.get("Nvidia NIM")).toBe("down");
  });

  it("has no entry (unknown) for a provider with zero attempts in the window", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.aIUsageLog.findMany).mockResolvedValue([outcomeRow("Groq", true)] as never);

    const status = await runInTenant(client, () => computeRecentStatusByLabel());
    expect(status.has("Anthropic")).toBe(false);
  });
});

describe("recordProviderAttemptOutcome", () => {
  it("is a no-op for the synthesized default (configId null) — nothing real to track", async () => {
    const client = createFakeTenantClient();
    await runInTenant(client, () => recordProviderAttemptOutcome(null, false));
    expect(client.aIProviderConfig.update).not.toHaveBeenCalled();
    expect(client.aIProviderConfig.updateMany).not.toHaveBeenCalled();
  });

  it("resets the counter on success", async () => {
    const client = createFakeTenantClient();
    await runInTenant(client, () => recordProviderAttemptOutcome("cfg-1", true));
    expect(client.aIProviderConfig.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: "cfg-1" }), data: { consecutiveFailures: 0 } })
    );
  });

  it("increments on failure but does not demote below the threshold", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.aIProviderConfig.update).mockResolvedValue({ consecutiveFailures: 2 } as never);

    await runInTenant(client, () => recordProviderAttemptOutcome("cfg-1", false));

    expect(client.aIProviderConfig.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "cfg-1" }, data: { consecutiveFailures: { increment: 1 } } })
    );
    expect(client.$transaction).not.toHaveBeenCalled();
  });

  it("does not demote at the threshold when aiAutoFailoverEnabled is off", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.aIProviderConfig.update).mockResolvedValue({ consecutiveFailures: 3 } as never);
    vi.mocked(client.globalAISettings.findUnique).mockResolvedValue({ aiAutoFailoverEnabled: false } as never);

    await runInTenant(client, () => recordProviderAttemptOutcome("cfg-1", false));

    expect(client.$transaction).not.toHaveBeenCalled();
  });

  it("demotes to the back of the ENABLED order at 3 consecutive failures when enabled, and audits it as SYSTEM", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.aIProviderConfig.update).mockResolvedValue({ consecutiveFailures: 3 } as never);
    vi.mocked(client.globalAISettings.findUnique).mockResolvedValue({ aiAutoFailoverEnabled: true } as never);
    // Three enabled rows; the failing one (cfg-1) currently sits first.
    vi.mocked(client.aIProviderConfig.findMany).mockResolvedValue([{ id: "cfg-1" }, { id: "cfg-2" }, { id: "cfg-3" }] as never);
    vi.mocked(client.auditLog.create).mockResolvedValue({} as never);

    await runInTenant(client, () => recordProviderAttemptOutcome("cfg-1", false));

    expect(client.$transaction).toHaveBeenCalled();
    const auditCall = vi.mocked(client.auditLog.create).mock.calls[0][0] as any;
    expect(auditCall.data.action).toBe("settings.ai_provider_auto_demoted");
    expect(auditCall.data.actorType).toBe("SYSTEM");
    expect(auditCall.data.actorId).toBeUndefined();
  });

  it("does not attempt to demote a row that is already last among enabled providers", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.aIProviderConfig.update).mockResolvedValue({ consecutiveFailures: 3 } as never);
    vi.mocked(client.globalAISettings.findUnique).mockResolvedValue({ aiAutoFailoverEnabled: true } as never);
    vi.mocked(client.aIProviderConfig.findMany).mockResolvedValue([{ id: "cfg-2" }, { id: "cfg-1" }] as never);

    await runInTenant(client, () => recordProviderAttemptOutcome("cfg-1", false));

    expect(client.$transaction).not.toHaveBeenCalled();
  });
});

describe("getEnabledProviderConfigsForTask", () => {
  const CONFIGS = [
    { id: "a", provider: "OPENAI_COMPATIBLE", label: null, baseUrl: "https://api.groq.com/openai/v1", apiKey: null, model: "m1" },
    { id: "b", provider: "OPENAI_COMPATIBLE", label: null, baseUrl: "https://openrouter.ai/api/v1", apiKey: null, model: "m2" },
    { id: "c", provider: "OPENAI_COMPATIBLE", label: null, baseUrl: "https://integrate.api.nvidia.com/v1", apiKey: null, model: "m3" }
  ];

  it("judgment tier returns the admin's own order untouched, regardless of status or cost", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.aIProviderConfig.findMany).mockResolvedValue(CONFIGS as never);
    // Even with clear cost/health signal favoring a different order, judgment must ignore it.
    vi.mocked(client.aIUsageLog.findMany).mockResolvedValue([outcomeRow("Nvidia NIM", true)] as never);

    const result = await runInTenant(client, () => getEnabledProviderConfigsForTask("judgment"));
    expect(result.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("economy tier prefers the cheapest HEALTHY provider, keeping degraded/down providers after all healthy ones", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.aIProviderConfig.findMany).mockResolvedValue(CONFIGS as never);
    // Groq (a) and OpenRouter (b) are healthy; Nvidia (c) is down. Groq is pricier than OpenRouter.
    vi.mocked(client.aIUsageLog.findMany).mockResolvedValue([
      outcomeRow("Groq", true),
      outcomeRow("OpenRouter", true),
      outcomeRow("Nvidia NIM", false)
    ] as never);
    vi.mocked(client.aIUsageLog.groupBy).mockResolvedValue([
      { provider: "Groq", _avg: { costUsdEstimate: 0.02 } },
      { provider: "OpenRouter", _avg: { costUsdEstimate: 0.005 } }
    ] as never);

    const result = await runInTenant(client, () => getEnabledProviderConfigsForTask("economy"));
    // OpenRouter (cheaper, healthy) first, then Groq (healthy but pricier), Nvidia (down) last.
    expect(result.map((c) => c.id)).toEqual(["b", "a", "c"]);
  });

  it("returns the list unchanged when there is only one enabled provider — nothing to re-sort", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.aIProviderConfig.findMany).mockResolvedValue([CONFIGS[0]] as never);

    const result = await runInTenant(client, () => getEnabledProviderConfigsForTask("economy"));
    expect(result.map((c) => c.id)).toEqual(["a"]);
    // No status/cost lookups needed for a single-provider list.
    expect(client.aIUsageLog.findMany).not.toHaveBeenCalled();
  });
});
