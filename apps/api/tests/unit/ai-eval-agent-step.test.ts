/**
 * The agent loop joins the measurement harness.
 *
 * Three live pilot runs each taught something the unit tests could not — args-repetition,
 * result-repetition, silent ceilings. This wiring is what turns those anecdotes into numbers: an
 * agent step is captured with its complete decision input, promotable into a golden dataset, and
 * replayable by the eval runner, so the next change to the loop's instructions has a score to
 * beat rather than a story to tell.
 *
 * The drift test is the one that earns its keep: capture (planAgentStep's params) and replay
 * (the replayer's schema) are written in two different files, and nothing but this test notices
 * when an added field makes yesterday's captured steps silently un-replayable.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/services/ai.service.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  planAgentStep: vi.fn().mockResolvedValue({
    decision: { action: "tool", tool: "get_ticket", args: { key: "WEB-1" } },
    costUsd: 0.01,
    raw: "{}"
  })
}));

const { planAgentStep } = await import("../../src/services/ai.service.js");
const { isReplayable, replayerFor } = await import("../../src/services/ai-eval.service.js");
const { defaultExpectedKind } = await import("../../src/services/ai-dataset.service.js");

/** The EXACT shape planAgentStep captures — if capture changes, this literal must change with it,
 *  and the schema round-trip below is what forces the replayer to keep up. */
const CAPTURED_PARAMS = {
  capability: "status_report",
  goal: "Summarise what moved this week",
  tools: [
    { name: "list_projects", description: "List the projects you can see." },
    { name: "get_ticket", description: "Fetch one ticket by key." }
  ],
  transcript: [{ tool: "list_projects", args: {}, result: '{"count":2}' }],
  stepsRemaining: 11,
  mustFinish: false
};

describe("registration", () => {
  it("agent_step is replayable and scores field-by-field by default", () => {
    expect(isReplayable("agent_step")).toBe(true);
    // The eval question is "did it pick the right action" — a JSON decision compared loosely as
    // prose would pass on vibes.
    expect(defaultExpectedKind("agent_step")).toBe("EXACT_FIELDS");
  });
});

describe("capture and replay agree on the shape", () => {
  it("the replayer's schema accepts exactly what planAgentStep captures", () => {
    const replayer = replayerFor("agent_step")!;
    const parsed = replayer.schema.safeParse(CAPTURED_PARAMS);
    expect(parsed.success).toBe(true);
  });

  it("an item captured before content capture was on cannot sneak through", () => {
    const replayer = replayerFor("agent_step")!;
    // A bare {goal} — the pre-harness capture shape — must be refused, not replayed against a
    // half-empty input and scored as if it meant something.
    expect(replayer.schema.safeParse({ goal: "x" }).success).toBe(false);
  });
});

describe("replay", () => {
  it("re-resolves the feature toggle from the registry but replays the tools as captured", async () => {
    const replayer = replayerFor("agent_step")!;
    const output = await replayer.invoke(replayer.schema.parse(CAPTURED_PARAMS));

    expect(JSON.parse(output)).toMatchObject({ action: "tool", tool: "get_ticket" });
    const call = vi.mocked(planAgentStep).mock.calls[0][0];
    // The toggle comes from today's registry — replay still respects the workspace's switches…
    expect(call.featureToggle).toBe("statusReportEnabled");
    // …but the tool list is the one the model actually saw when it decided, not today's.
    expect(call.tools).toEqual(CAPTURED_PARAMS.tools);
    expect(call.mustFinish).toBe(false);
  });

  it("refuses a capability that is not model-driven in this build, by name", async () => {
    const replayer = replayerFor("agent_step")!;
    await expect(
      replayer.invoke(replayer.schema.parse({ ...CAPTURED_PARAMS, capability: "assignment_rebalance" }))
    ).rejects.toThrow(/not a model-driven capability/);
  });
});
