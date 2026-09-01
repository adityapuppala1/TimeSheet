/**
 * CAPACITY-AWARE DISPATCH, and the native provider kind it exists for.
 *
 * The product wants a llama.cpp server running on the operator's own hardware to be PRIMARY — the
 * first thing tried for the dozens of small decision-shaped calls this app makes constantly. It
 * cannot serve the four heavy generators inside the 90-second MODEL_CALL_TIMEOUT_MS, and the naive
 * version of "primary" therefore costs every one of those calls a full timeout before the cloud
 * provider behind it gets a turn. So a provider row may now DECLARE its limits, and
 * `getEnabledProviderConfigsForTask` drops the rows that cannot serve the call in hand before it
 * opens a socket.
 *
 * WHAT IS PINNED HERE, and why each one is a thing that breaks silently rather than loudly:
 *
 *  1. THE FILTER SKIPS, IT DOES NOT FAIL. A skipped provider is never attempted, so it never fails,
 *     so its circuit-breaker counter must not move. Get this wrong and "native is primary" slowly
 *     auto-demotes the native row for failures it was never given the chance to have.
 *  2. NULL MEANS NO LIMIT. Every row in every existing workspace declares nothing, so this whole
 *     feature has to be inert on upgrade. A test that only ever uses rows WITH limits would not
 *     notice the day null started meaning zero.
 *  3. FILTERING EVERYTHING OUT MEANS DO NOT FILTER. The single most important rule: a workspace
 *     with one provider and a conservative declared limit must not lose AI entirely, told "not
 *     configured" by an app showing a configured, enabled, working provider.
 *  4. THE ECONOMY SORT IS UNCHANGED. Pinned by re-asserting its existing behaviour through the new
 *     parameter, so a regression in the sort cannot hide behind "the capacity work touched this".
 *  5. LLAMA_CPP SPEAKS THE OpenAI PROTOCOL. The dispatch branch used to treat Anthropic as the
 *     `else`, which routes any new enum member to the wrong client — and the symptom is not a crash
 *     but a real HTTP call to the wrong API.
 *  6. THE EGRESS GATE IS SKIPPED FOR THE NATIVE KIND AND ONLY THAT KIND. Both conditions matter,
 *     so both directions are tested: a native row at the derived URL is exempt, an
 *     OPENAI_COMPATIBLE row at the SAME URL is not, and a native row at some OTHER URL is not.
 *
 * Everything drives the REAL exported functions rather than re-implementing the rules — the same
 * argument ai-cost-routing.test.ts makes: a test that recomputes the filter checks its own
 * arithmetic and passes just as happily against a service that never applies it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveProviderLabel } from "@timesheet/shared";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";

const { mockAnthropicCreate, mockOpenAICreate, FakeAPIError, FakeConnectionError } = vi.hoisted(() => {
  // Real classes, because `translateProviderError` does `error instanceof Anthropic.APIError` and
  // `callOpenAICompatible` does `error instanceof OpenAI.APIConnectionError` — under a mock that
  // omits them those are `undefined`, and `instanceof undefined` throws a TypeError unrelated to
  // whatever the test meant to assert. Same reasoning as ai-provider-failure-logging.test.ts.
  class FakeAPIError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  class FakeConnectionError extends FakeAPIError {}
  return { mockAnthropicCreate: vi.fn(), mockOpenAICreate: vi.fn(), FakeAPIError, FakeConnectionError };
});

vi.mock("@anthropic-ai/sdk", () => ({
  default: Object.assign(
    class FakeAnthropic {
      messages = { create: mockAnthropicCreate };
    },
    { APIError: FakeAPIError }
  )
}));

vi.mock("openai", () => ({
  default: Object.assign(
    class FakeOpenAI {
      chat = { completions: { create: mockOpenAICreate } };
    },
    { APIError: FakeAPIError, APIConnectionError: FakeConnectionError }
  )
}));

const { mockGetEffectiveAiBudgetCeiling } = vi.hoisted(() => ({ mockGetEffectiveAiBudgetCeiling: vi.fn() }));
vi.mock("../../src/services/plan-limits.service.js", () => ({
  getEffectiveAiBudgetCeiling: mockGetEffectiveAiBudgetCeiling
}));

// PARTIAL mock, keeping every other export real: this module also supplies the Zod-level
// `egressUrl`/`egressUrlProblem` used by controllers reachable from this import graph, and
// replacing the whole module would break them for reasons having nothing to do with these tests.
const { mockAssertEgress } = vi.hoisted(() => ({ mockAssertEgress: vi.fn() }));
vi.mock("../../src/utils/egress.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertPublicEgressTarget: mockAssertEgress
}));

const { classifyTicket, generateRequirementsDocument, getEnabledProviderConfigsForTask, callOpenAICompatible, estimatePromptTokens } =
  await import("../../src/services/ai.service.js");
const { nativeProviderBaseUrl } = await import("../../src/config/native-ai.js");

/** The declared capacity of a small local model: enough for a decision, not for a document. */
const NATIVE_ROW = {
  id: "native",
  provider: "LLAMA_CPP",
  label: null,
  baseUrl: nativeProviderBaseUrl(),
  apiKey: null,
  model: "qwen2.5-7b-instruct",
  enabled: true,
  priority: 0,
  maxConcurrent: 1,
  maxOutputTokens: 1500,
  contextWindow: 8192
};

/** The cloud row sitting behind it, declaring nothing at all — like every row that exists today. */
const CLOUD_ROW = {
  id: "cloud",
  provider: "ANTHROPIC",
  label: null,
  baseUrl: null,
  apiKey: null,
  model: "claude-haiku-4-5",
  enabled: true,
  priority: 1,
  maxConcurrent: 4,
  maxOutputTokens: null,
  contextWindow: null
};

function settings(overrides: Record<string, unknown> = {}) {
  return {
    id: "global",
    aiEnabled: true,
    autoTriageEnabled: true,
    requirementsStudioEnabled: true,
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

const TRIAGE_JSON = JSON.stringify({ type: "BUG", priority: "HIGH", moduleName: "NONE", confidence: 0.9, reasoning: "r" });

/** An OpenAI-compatible success envelope carrying `text`. */
function openAiAnswer(text: string) {
  return { choices: [{ message: { content: text } }], usage: { prompt_tokens: 100, completion_tokens: 20 } };
}

/** An Anthropic success envelope carrying `text`. */
function anthropicAnswer(text: string) {
  return { content: [{ type: "text", text }], usage: { input_tokens: 100, output_tokens: 20 } };
}

/** Every id the circuit breaker's bookkeeping touched, by either of its two write shapes. */
function breakerTouchedIds(client: ReturnType<typeof baseClient>): string[] {
  const fromUpdate = vi.mocked(client.aIProviderConfig.update).mock.calls.map((call) => (call[0] as { where: { id: string } }).where.id);
  const fromUpdateMany = vi
    .mocked(client.aIProviderConfig.updateMany)
    .mock.calls.map((call) => (call[0] as { where: { id: string } }).where.id);
  return [...fromUpdate, ...fromUpdateMany];
}

beforeEach(() => {
  mockAnthropicCreate.mockReset();
  mockOpenAICreate.mockReset();
  mockAssertEgress.mockReset().mockResolvedValue(undefined);
  mockGetEffectiveAiBudgetCeiling.mockReset().mockResolvedValue(100);
});

describe("the demand pre-filter", () => {
  it("skips a provider that has declared it cannot emit this many tokens, and keeps the next one", async () => {
    const client = baseClient([NATIVE_ROW, CLOUD_ROW]);

    const configs = await runInTenant(client, () =>
      getEnabledProviderConfigsForTask("judgment", { maxTokens: 8000, promptChars: 400 })
    );

    expect(configs.map((config) => config.id)).toEqual(["cloud"]);
  });

  it("keeps a provider whose declared ceiling covers the call — the filter is a ceiling, not a preference", async () => {
    const client = baseClient([NATIVE_ROW, CLOUD_ROW]);

    const configs = await runInTenant(client, () =>
      getEnabledProviderConfigsForTask("judgment", { maxTokens: 1024, promptChars: 400 })
    );

    expect(configs.map((config) => config.id)).toEqual(["native", "cloud"]);
  });

  it("counts the prompt AND the answer against the context window, not the prompt alone", async () => {
    const client = baseClient([NATIVE_ROW, CLOUD_ROW]);
    // 21,000 characters is ~7,000 tokens at the file's deliberately-pessimistic 3-chars-per-token
    // ratio. That alone fits inside the row's 8,192-token window; asked for 1,500 tokens of answer
    // as well, it does not. A filter that only looked at the prompt would keep this row.
    const promptChars = 21_000;
    expect(estimatePromptTokens(promptChars)).toBeLessThan(8192);

    const configs = await runInTenant(client, () => getEnabledProviderConfigsForTask("judgment", { maxTokens: 1500, promptChars }));

    expect(configs.map((config) => config.id)).toEqual(["cloud"]);
  });

  it("over-estimates rather than under-estimates prompt tokens, because truncation is worse than a second choice", () => {
    // Pins the DIRECTION of the approximation, not the constant. English prose is roughly 4
    // characters per token; anything at or below that errs toward skipping a provider that would
    // have coped, which costs a routing choice — the other direction costs a truncated answer that
    // still looks like an answer.
    expect(estimatePromptTokens(4000)).toBeGreaterThanOrEqual(1000);
  });

  it("treats NULL limits as no limit, so a workspace that has declared nothing routes exactly as before", async () => {
    const client = baseClient([CLOUD_ROW, { ...CLOUD_ROW, id: "cloud-2", priority: 2 }]);

    const configs = await runInTenant(client, () =>
      // Far past anything any provider serves — and still nothing is dropped, because nothing was
      // claimed. This is the case every existing installation is in.
      getEnabledProviderConfigsForTask("judgment", { maxTokens: 900_000, promptChars: 5_000_000 })
    );

    expect(configs.map((config) => config.id)).toEqual(["cloud", "cloud-2"]);
  });

  it("DOES NOT FILTER when filtering would remove every provider — an advisory filter must not become an outage", async () => {
    // The workspace with exactly one provider and a conservative declared limit. Filtering
    // correctly leaves nothing, and nothing means `callChat` reports "AI is not configured" to a
    // person looking at a configured, enabled, working provider. Letting the call through means it
    // either succeeds (the limit was conservative) or fails with the provider's own honest error.
    const client = baseClient([NATIVE_ROW]);

    const configs = await runInTenant(client, () =>
      getEnabledProviderConfigsForTask("judgment", { maxTokens: 8000, promptChars: 400 })
    );

    expect(configs.map((config) => config.id)).toEqual(["native"]);
  });

  it("falls back to the FULL list, not a partial one, when every provider is over its declared limit", async () => {
    const client = baseClient([NATIVE_ROW, { ...NATIVE_ROW, id: "native-2", priority: 1, maxOutputTokens: 2000 }]);

    const configs = await runInTenant(client, () =>
      getEnabledProviderConfigsForTask("judgment", { maxTokens: 8000, promptChars: 400 })
    );

    expect(configs.map((config) => config.id)).toEqual(["native", "native-2"]);
  });

  it("removes but never reorders — what survives is still the admin's own priority order", async () => {
    const client = baseClient([
      { ...CLOUD_ROW, id: "first", priority: 0 },
      { ...NATIVE_ROW, id: "middle", priority: 1 },
      { ...CLOUD_ROW, id: "last", priority: 2 }
    ]);

    const configs = await runInTenant(client, () =>
      getEnabledProviderConfigsForTask("judgment", { maxTokens: 8000, promptChars: 400 })
    );

    expect(configs.map((config) => config.id)).toEqual(["first", "last"]);
  });

  it("does nothing at all when no demand is supplied — the old two-argument-less call is unchanged", async () => {
    const client = baseClient([NATIVE_ROW, CLOUD_ROW]);

    const configs = await runInTenant(client, () => getEnabledProviderConfigsForTask("judgment"));

    expect(configs.map((config) => config.id)).toEqual(["native", "cloud"]);
  });
});

describe("the economy health/cost sort, unchanged by any of this", () => {
  // Deliberately the SAME fixture and the SAME expectations as ai-provider-reliability.test.ts's
  // economy case, re-asserted through the new `demand` parameter. The point is not to test the
  // sort twice; it is to prove the capacity work did not move it.
  const CONFIGS = [
    { id: "a", provider: "OPENAI_COMPATIBLE", label: null, baseUrl: "https://api.groq.com/openai/v1", apiKey: null, model: "m1" },
    { id: "b", provider: "OPENAI_COMPATIBLE", label: null, baseUrl: "https://openrouter.ai/api/v1", apiKey: null, model: "m2" },
    { id: "c", provider: "OPENAI_COMPATIBLE", label: null, baseUrl: "https://integrate.api.nvidia.com/v1", apiKey: null, model: "m3" }
  ];

  function healthAndCost(client: ReturnType<typeof baseClient>) {
    // Groq (a) and OpenRouter (b) healthy, Nvidia (c) down; Groq pricier than OpenRouter.
    vi.mocked(client.aIUsageLog.findMany).mockResolvedValue([
      { provider: "Groq", success: true },
      { provider: "OpenRouter", success: true },
      { provider: "Nvidia NIM", success: false }
    ] as never);
    vi.mocked(client.aIUsageLog.groupBy).mockResolvedValue([
      { provider: "Groq", _avg: { costUsdEstimate: 0.02 } },
      { provider: "OpenRouter", _avg: { costUsdEstimate: 0.005 } }
    ] as never);
  }

  it("still prefers the cheapest HEALTHY provider when a demand is supplied that filters nothing", async () => {
    const client = baseClient(CONFIGS);
    healthAndCost(client);

    const configs = await runInTenant(client, () => getEnabledProviderConfigsForTask("economy", { maxTokens: 512, promptChars: 900 }));

    expect(configs.map((config) => config.id)).toEqual(["b", "a", "c"]);
  });

  it("sorts the SURVIVORS — the filter chooses the candidates, the sort still chooses the order", async () => {
    const client = baseClient([...CONFIGS, { ...NATIVE_ROW, priority: 3 }]);
    healthAndCost(client);

    const configs = await runInTenant(client, () => getEnabledProviderConfigsForTask("economy", { maxTokens: 8000, promptChars: 900 }));

    // The native row is gone on capacity; the remaining three are in exactly the order the sort
    // put them in before it existed.
    expect(configs.map((config) => config.id)).toEqual(["b", "a", "c"]);
  });

  it("still returns judgment-tier lists in the admin's own order regardless of health or cost", async () => {
    const client = baseClient(CONFIGS);
    healthAndCost(client);

    const configs = await runInTenant(client, () => getEnabledProviderConfigsForTask("judgment", { maxTokens: 512, promptChars: 900 }));

    expect(configs.map((config) => config.id)).toEqual(["a", "b", "c"]);
  });
});

describe("the worked example: native primary for decisions, skipped for generation", () => {
  it("routes triage (1024 output tokens) to the native row, through the OpenAI-compatible client", async () => {
    const client = baseClient([NATIVE_ROW, CLOUD_ROW]);
    mockOpenAICreate.mockResolvedValueOnce(openAiAnswer(TRIAGE_JSON));

    await runInTenant(client, () => classifyTicket(TRIAGE_ARGS as never));

    expect(mockOpenAICreate).toHaveBeenCalledTimes(1);
    // Not merely "Anthropic wasn't the one that answered" — it was never called at all, which is
    // what proves the native row was FIRST rather than a fallback after a failure.
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
    expect(mockOpenAICreate.mock.calls[0][0].model).toBe("qwen2.5-7b-instruct");
  });

  it("skips the native row for a requirements document (8000 output tokens) and lets the cloud row answer", async () => {
    const client = baseClient([NATIVE_ROW, CLOUD_ROW]);
    mockAnthropicCreate.mockResolvedValueOnce(anthropicAnswer("{}"));

    await runInTenant(client, () =>
      generateRequirementsDocument({
        transcript: [{ question: "What are we building?", answer: "A timesheet app.", skipped: false, sectionTag: null }],
        docType: "PRD",
        userId: "u1"
      } as never)
    );

    expect(mockOpenAICreate).not.toHaveBeenCalled();
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
  });

  it("leaves the skipped row's failure counter alone — it was never asked, so it has not failed", async () => {
    const client = baseClient([NATIVE_ROW, CLOUD_ROW]);
    mockAnthropicCreate.mockResolvedValueOnce(anthropicAnswer("{}"));

    await runInTenant(client, () =>
      generateRequirementsDocument({
        transcript: [{ question: "What are we building?", answer: "A timesheet app.", skipped: false, sectionTag: null }],
        docType: "PRD",
        userId: "u1"
      } as never)
    );

    // The cloud row's success reset is expected and fine. The native row must appear nowhere: no
    // increment, no reset, no demotion. This is the difference between a skip and a failure, and
    // getting it wrong auto-demotes the primary for calls it was deliberately never given.
    expect(breakerTouchedIds(client)).not.toContain("native");
    expect(breakerTouchedIds(client)).toContain("cloud");
  });

  it("logs no failed attempt against the skipped row — a skip is not an outcome worth recording", async () => {
    const client = baseClient([NATIVE_ROW, CLOUD_ROW]);
    mockAnthropicCreate.mockResolvedValueOnce(anthropicAnswer("{}"));

    await runInTenant(client, () =>
      generateRequirementsDocument({
        transcript: [{ question: "What are we building?", answer: "A timesheet app.", skipped: false, sectionTag: null }],
        docType: "PRD",
        userId: "u1"
      } as never)
    );

    const logged = vi.mocked(client.aIUsageLog.create).mock.calls.map((call) => (call[0] as { data: Record<string, unknown> }).data);
    expect(logged.filter((row) => row.success === false)).toEqual([]);
  });
});

describe("LLAMA_CPP is an OpenAI-family kind, not the dispatch branch's `else`", () => {
  it("dispatches a native row to the OpenAI-compatible client and never to Anthropic", async () => {
    // A single-row list, so there is no fallback to mask a misroute: if the branch sends this to
    // Anthropic, the Anthropic mock is the one that gets called and the assertion below fails.
    const client = baseClient([NATIVE_ROW]);
    mockOpenAICreate.mockResolvedValueOnce(openAiAnswer(TRIAGE_JSON));

    await runInTenant(client, () => classifyTicket(TRIAGE_ARGS as never));

    expect(mockOpenAICreate).toHaveBeenCalledTimes(1);
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
  });

  it("still sends an ANTHROPIC row to the Anthropic client — the fix names kinds, it does not swap the default", async () => {
    const client = baseClient([CLOUD_ROW]);
    mockAnthropicCreate.mockResolvedValueOnce(anthropicAnswer(TRIAGE_JSON));

    await runInTenant(client, () => classifyTicket(TRIAGE_ARGS as never));

    expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
    expect(mockOpenAICreate).not.toHaveBeenCalled();
  });
});

describe("resolveProviderLabel names the native kind", () => {
  it("gives it a real name rather than a hostname or 'Custom endpoint'", () => {
    // THE LABEL IS THE JOIN KEY for `computeRecentStatusByLabel` and `computeRecentAvgCostByLabel`.
    // "Custom endpoint" would bucket the native provider together with every other unrecognised
    // one; the hostname (127.0.0.1) would change with the port and split its own history in two.
    expect(resolveProviderLabel("LLAMA_CPP", nativeProviderBaseUrl())).toBe("Native (llama.cpp)");
  });

  it("names it from the KIND, not the URL, so a runtime that moves port keeps its history", () => {
    expect(resolveProviderLabel("LLAMA_CPP", "http://127.0.0.1:9999/v1")).toBe("Native (llama.cpp)");
    expect(resolveProviderLabel("LLAMA_CPP", null)).toBe("Native (llama.cpp)");
  });

  it("leaves every other kind's label exactly as it was", () => {
    expect(resolveProviderLabel("ANTHROPIC", null)).toBe("Anthropic");
    expect(resolveProviderLabel("OPENAI_COMPATIBLE", "https://api.groq.com/openai/v1")).toBe("Groq");
    expect(resolveProviderLabel("OPENAI_COMPATIBLE", "https://something.unknown/v1")).toBe("something.unknown");
  });
});

describe("the egress gate, exempted for exactly one kind", () => {
  const params = { feature: "test", model: "m", maxTokens: 10, prompt: "hello" };

  it("is skipped for a LLAMA_CPP row at the derived native URL", async () => {
    mockOpenAICreate.mockResolvedValueOnce(openAiAnswer("ok"));

    await callOpenAICompatible({ baseUrl: nativeProviderBaseUrl(), provider: "LLAMA_CPP" }, "", params);

    expect(mockAssertEgress).not.toHaveBeenCalled();
  });

  it("is STILL ENFORCED for an OPENAI_COMPATIBLE row pointed at the very same URL", async () => {
    // The exemption is about who chose the URL, not what the URL is. An admin who types the native
    // address into an ordinary BYOK row has still typed a URL, and typing URLs is the capability
    // the SSRF gate exists to distrust — 169.254.169.254 is one keystroke away from this one.
    mockOpenAICreate.mockResolvedValueOnce(openAiAnswer("ok"));

    await callOpenAICompatible({ baseUrl: nativeProviderBaseUrl(), provider: "OPENAI_COMPATIBLE" }, "", params);

    expect(mockAssertEgress).toHaveBeenCalledWith(nativeProviderBaseUrl(), "The AI provider base URL");
  });

  it("is still enforced when no kind is supplied at all — the platform advisor's call shape", async () => {
    mockOpenAICreate.mockResolvedValueOnce(openAiAnswer("ok"));

    await callOpenAICompatible({ baseUrl: "https://api.groq.com/openai/v1" }, "k", params);

    expect(mockAssertEgress).toHaveBeenCalledTimes(1);
  });

  it("is still enforced for a LLAMA_CPP row whose stored URL is NOT the one the server derives", async () => {
    // Both halves are required. A row relabelled LLAMA_CPP by anything other than the write path
    // that derives its URL — a migration, a manual UPDATE, a future import — must not carry the
    // exemption with it, or the label itself becomes the exploit.
    mockOpenAICreate.mockResolvedValueOnce(openAiAnswer("ok"));

    await callOpenAICompatible({ baseUrl: "http://169.254.169.254/v1", provider: "LLAMA_CPP" }, "", params);

    expect(mockAssertEgress).toHaveBeenCalledWith("http://169.254.169.254/v1", "The AI provider base URL");
  });
});
