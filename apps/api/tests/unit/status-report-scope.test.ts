/**
 * `generateStatusReport` now covers one project OR the whole portfolio, and the entire difference
 * is in what it hands the prompt. These pin that seam, because getting it wrong is silent: the
 * model would still answer, just about the wrong scope or without the per-project detail.
 *
 * The single-project path is asserted to be UNCHANGED in shape. That matters more than the new
 * path — this is an existing feature people already use, and a report that quietly started saying
 * "all 6 active projects" would be wrong in a way nobody would think to check.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";

const { mockAnthropicCreate, FakeAPIError } = vi.hoisted(() => {
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
vi.mock("../../src/services/plan-limits.service.js", () => ({
  getEffectiveAiBudgetCeiling: vi.fn().mockResolvedValue(100)
}));

const { generateStatusReport } = await import("../../src/services/ai.service.js");

function client() {
  const c = createFakeTenantClient();
  vi.mocked(c.globalAISettings.upsert).mockResolvedValue({
    id: "global",
    aiEnabled: true,
    statusReportEnabled: true,
    model: "claude-haiku-4-5",
    provider: "ANTHROPIC",
    confidenceThreshold: 0.6,
    monthlyBudgetUsd: null,
    baseUrl: null,
    apiKey: null
  } as never);
  vi.mocked(c.aIUsageLog.aggregate).mockResolvedValue({ _sum: { costUsdEstimate: 0 } } as never);
  vi.mocked(c.aIProviderConfig.findMany).mockResolvedValue([] as never);
  return c;
}

const BASE = {
  projectName: "Apollo",
  periodLabel: "the past week",
  ticketsCreated: 4,
  ticketsResolved: 3,
  openCount: 11,
  overdueCount: 1,
  hoursLogged: 32,
  notableTickets: [{ key: "HICS-TS-3", title: "Login button does nothing", status: "OPEN" }]
};

/** What the model was actually sent, and with what ceiling. */
function lastCall() {
  const call = mockAnthropicCreate.mock.calls.at(-1)?.[0] as { messages: Array<{ content: string }>; max_tokens: number };
  return { prompt: call.messages.map((m) => m.content).join("\n"), maxTokens: call.max_tokens };
}

beforeEach(() => {
  mockAnthropicCreate.mockReset().mockResolvedValue({
    content: [{ type: "text", text: "## Summary\n\nAll good." }],
    usage: { input_tokens: 10, output_tokens: 20 }
  } as never);
});

describe("generateStatusReport scope", () => {
  it("names the single project and asks for no by-project section", async () => {
    await runInTenant(client(), () => generateStatusReport(BASE));

    const { prompt, maxTokens } = lastCall();
    expect(prompt).toContain('the project "Apollo"');
    expect(prompt).not.toContain("Per-project figures");
    // The template's by-project step is conditional on that block being present, so its absence is
    // what keeps a single-project report shaped as it always was.
    expect(maxTokens).toBe(1200);
  });

  it("passes the portfolio scope and the per-project figures when they are given", async () => {
    await runInTenant(client(), () =>
      generateStatusReport({
        ...BASE,
        scopeLabel: "all 3 active projects in this workspace",
        projectBreakdown: "- Apollo — 4 created\n- Borealis — 2 created\n- Cygnus — 0 created"
      })
    );

    const { prompt, maxTokens } = lastCall();
    expect(prompt).toContain("all 3 active projects in this workspace");
    expect(prompt).toContain("Per-project figures");
    expect(prompt).toContain("- Borealis — 2 created");
    // 500 could not hold a summary, three sections and a table; a report that stops mid-table is
    // worse than one that was never asked for.
    expect(maxTokens).toBe(2400);
  });

  it("still fills {{projectName}} for a workspace whose custom prompt predates the portfolio mode", async () => {
    // `renderTemplate` renders an unknown placeholder as empty string, so dropping this value would
    // silently strip the subject out of every customised status report.
    await runInTenant(client(), () => generateStatusReport({ ...BASE, scopeLabel: "the whole portfolio" }));
    expect(mockAnthropicCreate).toHaveBeenCalled();

    const { prompt } = lastCall();
    expect(prompt).toContain("the whole portfolio");
  });

  it("asks for markdown structure rather than the plain prose the old template demanded", async () => {
    await runInTenant(client(), () => generateStatusReport(BASE));

    const { prompt } = lastCall();
    expect(prompt).toContain("## Highlights");
    expect(prompt).toContain("## By the numbers");
    expect(prompt).not.toContain("no headings/bullets");
  });
});
