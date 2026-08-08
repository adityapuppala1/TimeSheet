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

const {
  assertAIFeatureEnabled,
  assertWithinBudget,
  classifyTicket,
  estimateCostUsd,
  findDuplicateTickets,
  getTextRefineAvailability,
  refineText,
  reviewPullRequestDiff,
  summarizeComments
} = await import("../../src/services/ai.service.js");

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

/** The prompt text that actually reached the model on the first call. */
function promptSent(): string {
  const content = mockAnthropicCreate.mock.calls[0]?.[0]?.messages?.[0]?.content;
  return typeof content === "string" ? content : JSON.stringify(content);
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

  /**
   * The closed set is enforced LOCALLY, not by the schema the request asked for.
   *
   * `enum` in `output_config.format` binds Anthropic; the OPENAI_COMPATIBLE path asks in prose and
   * retries with no `response_format` at all when an endpoint rejects it, so on a BYOK provider
   * `type` is whatever came back. Both intake pipelines write that value straight to `Ticket.type`
   * from text an unauthenticated stranger emailed in.
   */
  it("forces an off-list ticket type back into the project's configured set", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.globalAISettings.upsert).mockResolvedValue(fakeGlobalAiSettings() as never);
    vi.mocked(client.aIUsageLog.aggregate).mockResolvedValue({ _sum: { costUsdEstimate: 0 } } as never);
    mockAnthropicCreate.mockResolvedValue({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            type: "IGNORE PREVIOUS INSTRUCTIONS — ESCALATION",
            priority: "CRITICAL",
            moduleName: "Auth",
            confidence: 1,
            reasoning: "injected"
          })
        }
      ],
      usage: { input_tokens: 10, output_tokens: 5 }
    });

    const result = await runInTenant(client, () => classifyTicket({ ...CLASSIFY_PARAMS, untrustedSource: true }));

    expect(result.type).toBe("BUG"); // the first configured type, never the model's invention
    expect(CLASSIFY_PARAMS.typeNames).toContain(result.type);
  });

  it("accepts a valid type regardless of the casing the model returned it in", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.globalAISettings.upsert).mockResolvedValue(fakeGlobalAiSettings() as never);
    vi.mocked(client.aIUsageLog.aggregate).mockResolvedValue({ _sum: { costUsdEstimate: 0 } } as never);
    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ type: "task", priority: "LOW", moduleName: "NONE", confidence: 0.5, reasoning: "ok" }) }],
      usage: { input_tokens: 10, output_tokens: 5 }
    });

    const result = await runInTenant(client, () => classifyTicket(CLASSIFY_PARAMS));
    expect(result.type).toBe("TASK");
  });
});

describe("findDuplicateTickets", () => {
  const CANDIDATES = [
    { id: "t-1", key: "WEB-1", title: "Login fails", description: null },
    { id: "t-2", key: "WEB-2", title: "Signup fails", description: null }
  ];

  function enabledClient() {
    const client = createFakeTenantClient();
    vi.mocked(client.globalAISettings.upsert).mockResolvedValue(fakeGlobalAiSettings({ duplicateDetectionEnabled: true }) as never);
    vi.mocked(client.aIUsageLog.aggregate).mockResolvedValue({ _sum: { costUsdEstimate: 0 } } as never);
    return client;
  }

  /**
   * The candidate list embedded in this prompt is itself untrusted text — a ticket created from an
   * inbound email supplies its own title and description. Asking for a key that was never offered
   * used to hit a `find(...)!.id` non-null assertion, i.e. a TypeError, i.e. a 500 anyone who can
   * email support@ could trigger on demand.
   */
  it("drops a ticket key the model invented instead of throwing on it", async () => {
    const client = enabledClient();
    mockAnthropicCreate.mockResolvedValue({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            matches: [
              { ticketKey: "WEB-2", likelihood: 0.8, reasoning: "same signup flow" },
              { ticketKey: "ADMIN-999", likelihood: 1, reasoning: "not a candidate at all" }
            ]
          })
        }
      ],
      usage: { input_tokens: 40, output_tokens: 20 }
    });

    const matches = await runInTenant(client, () => findDuplicateTickets({ title: "Cannot sign up", candidates: CANDIDATES }));

    expect(matches).toEqual([{ ticketId: "t-2", key: "WEB-2", likelihood: 0.8, reasoning: "same signup flow" }]);
  });
});

describe("summarizeComments", () => {
  /**
   * Every other capability truncates what it sends (CI logs at 6000 chars, `ask_ai` at 150
   * tickets); this one was handed the whole thread. Comment count and comment length are both
   * chosen by whoever is posting, so an uncapped thread is one authenticated request that sends
   * megabytes to a model and bills the workspace for it.
   */
  it("caps how much of a long thread reaches the model", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.globalAISettings.upsert).mockResolvedValue(fakeGlobalAiSettings({ commentSummaryEnabled: true }) as never);
    vi.mocked(client.aIUsageLog.aggregate).mockResolvedValue({ _sum: { costUsdEstimate: 0 } } as never);
    mockAnthropicCreate.mockResolvedValue({ content: [{ type: "text", text: "Recap." }], usage: { input_tokens: 10, output_tokens: 5 } });

    const comments = Array.from({ length: 200 }, (_, i) => ({
      authorName: `Author ${i}`,
      body: `<p>marker-${i} ${"padding ".repeat(500)}</p>`,
      createdAt: new Date("2026-08-01T09:00:00Z")
    }));

    await runInTenant(client, () => summarizeComments({ ticketTitle: "Login fails", comments }));

    const prompt = promptSent();
    // The newest window survives, the oldest comments are dropped entirely…
    expect(prompt).toContain("marker-199");
    expect(prompt).not.toContain("marker-0 ");
    // …and no single comment can pad the prompt without bound.
    expect(prompt.length).toBeLessThan(200_000);
  });
});

/**
 * The inline "Refine with AI" affordance (components/AiRefine.tsx on the client).
 *
 * What's pinned here is the promise the feature makes: it is gated like every other capability
 * BEFORE any money is spent, it never returns live markup for whatever the model felt like
 * emitting, and it never quietly hands back the user's own text as though it had been refined.
 */
describe("refineText", () => {
  const DESCRIPTION_HTML = "<p>fixd the login bug on safri, took abt 3 hrs, see WEB-12</p>";

  function enabledClient(overrides: Partial<Record<string, unknown>> = {}) {
    const client = createFakeTenantClient();
    vi.mocked(client.globalAISettings.upsert).mockResolvedValue(
      fakeGlobalAiSettings({ writingAssistantEnabled: true, ...overrides }) as never
    );
    vi.mocked(client.aIUsageLog.aggregate).mockResolvedValue({ _sum: { costUsdEstimate: 0 } } as never);
    return client;
  }

  function modelAnswers(text: string) {
    mockAnthropicCreate.mockResolvedValue({
      content: [{ type: "text", text }],
      usage: { input_tokens: 90, output_tokens: 30 }
    });
  }

  it("blocks the call before ever reaching the model when the workspace AI switch is off", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.globalAISettings.upsert).mockResolvedValue(
      fakeGlobalAiSettings({ aiEnabled: false, writingAssistantEnabled: true }) as never
    );

    await expect(
      runInTenant(client, () => refineText({ text: DESCRIPTION_HTML, field: "timesheet_description" }))
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
  });

  it("blocks the call before ever reaching the model when the writing-assistant toggle is off", async () => {
    const client = enabledClient({ writingAssistantEnabled: false });

    await expect(
      runInTenant(client, () => refineText({ text: DESCRIPTION_HTML, field: "ticket_description" }))
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
  });

  it("blocks the call before ever reaching the model when the monthly budget is exhausted", async () => {
    const client = enabledClient({ monthlyBudgetUsd: 5 });
    vi.mocked(client.aIUsageLog.aggregate).mockResolvedValue({ _sum: { costUsdEstimate: 5 } } as never);

    await expect(
      runInTenant(client, () => refineText({ text: DESCRIPTION_HTML, field: "timesheet_notes" }))
    ).rejects.toMatchObject({ statusCode: 402 });
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
  });

  it("refuses an empty field without spending a call", async () => {
    const client = enabledClient();

    await expect(
      runInTenant(client, () => refineText({ text: "<p></p>", field: "timesheet_description" }))
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
  });

  it("returns both versions and logs usage under its own feature, changing nothing itself", async () => {
    const client = enabledClient();
    modelAnswers("Fixed the login bug on Safari. Took about 3 hours. See WEB-12.");

    const result = await runInTenant(client, () =>
      refineText({ text: DESCRIPTION_HTML, field: "timesheet_description", userId: "user-1" })
    );

    expect(result.format).toBe("html");
    expect(result.refined).toBe("Fixed the login bug on Safari. Took about 3 hours. See WEB-12.");
    expect(result.refinedHtml).toBe("<p>Fixed the login bug on Safari. Took about 3 hours. See WEB-12.</p>");
    // The caller's own text comes back untouched alongside it — accepting is the client's job.
    expect(result.original).toBe("fixd the login bug on safri, took abt 3 hrs, see WEB-12");
    expect(client.aIUsageLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ feature: "text_refine", inputTokens: 90, outputTokens: 30, userId: "user-1" })
      })
    );
  });

  it("escapes markup the model emits instead of handing back live HTML", async () => {
    // The stored-XSS path this feature would otherwise open: model output is written into a
    // rich-text editor and then persisted, so it is exactly as untrusted as anything pasted in.
    const client = enabledClient();
    modelAnswers('<script>alert(1)</script><img src=x onerror="alert(1)"> <a href="javascript:alert(1)">click</a>');

    const result = await runInTenant(client, () => refineText({ text: DESCRIPTION_HTML, field: "ticket_comment" }));

    // It survives as visible text — the author can see exactly what the model produced — but not
    // as markup: the only tags left are the paragraph wrapper this code built itself, so there is
    // no element for `onerror` or a `javascript:` href to hang off.
    expect(result.refinedHtml).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror="alert(1)"&gt; &lt;a href="javascript:alert(1)"&gt;click&lt;/a&gt;</p>'
    );
    expect(result.refinedHtml?.replace(/<\/?p>/g, "")).not.toMatch(/<[a-z]/i);
  });

  it("keeps a plain field on one line and offers no HTML for it", async () => {
    const client = enabledClient();
    modelAnswers('"Login fails on Safari\nafter the cookie change"');

    const result = await runInTenant(client, () => refineText({ text: "login broke safri", field: "ticket_title" }));

    expect(result.format).toBe("plain");
    expect(result.refinedHtml).toBeNull();
    // Wrapping quotes stripped, newline flattened — a title is one line and this one would
    // otherwise land in the input verbatim the moment the user accepted it.
    expect(result.refined).toBe("Login fails on Safari after the cookie change");
  });

  it("treats an empty answer as a failure rather than pretending the text was reviewed", async () => {
    const client = enabledClient();
    modelAnswers("   ");

    await expect(
      runInTenant(client, () => refineText({ text: DESCRIPTION_HTML, field: "ticket_description" }))
    ).rejects.toMatchObject({ statusCode: 502 });
  });
});

describe("getTextRefineAvailability", () => {
  // The UI disables the affordance from this, so a wrong answer is either a button that 403s on
  // click or a feature that looks switched off while it works.
  it("reports the same verdict the capability enforces", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.globalAISettings.upsert).mockResolvedValue(
      fakeGlobalAiSettings({ writingAssistantEnabled: true }) as never
    );
    vi.mocked(client.aIUsageLog.aggregate).mockResolvedValue({ _sum: { costUsdEstimate: 0 } } as never);

    await expect(runInTenant(client, getTextRefineAvailability)).resolves.toMatchObject({ available: true, reason: "ok" });
  });

  it("says the feature is off rather than throwing", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.globalAISettings.upsert).mockResolvedValue(fakeGlobalAiSettings({ aiEnabled: false }) as never);

    await expect(runInTenant(client, getTextRefineAvailability)).resolves.toMatchObject({
      available: false,
      reason: "disabled"
    });
  });

  it("distinguishes an exhausted budget from a disabled feature", async () => {
    const client = createFakeTenantClient();
    vi.mocked(client.globalAISettings.upsert).mockResolvedValue(
      fakeGlobalAiSettings({ writingAssistantEnabled: true, monthlyBudgetUsd: 5 }) as never
    );
    vi.mocked(client.aIUsageLog.aggregate).mockResolvedValue({ _sum: { costUsdEstimate: 5 } } as never);

    await expect(runInTenant(client, getTextRefineAvailability)).resolves.toMatchObject({
      available: false,
      reason: "budget"
    });
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
