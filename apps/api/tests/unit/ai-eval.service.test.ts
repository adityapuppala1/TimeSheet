/**
 * Tests for the eval runner.
 *
 * The scoring rules are pinned because they define what "better" means for every prompt decision
 * made from here on — a scorer that quietly rewards the wrong thing would send prompt tuning in
 * the wrong direction while the dashboard says everything improved.
 *
 * The budget refusals are pinned because they're the only thing standing between "run an eval" and
 * an unbounded bill.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";

const { MAX_ITEMS_PER_RUN, enqueueEvalRun, isReplayable, scoreContains, scoreExactFields } = await import(
  "../../src/services/ai-eval.service.js"
);

let client: ReturnType<typeof createFakeTenantClient>;

beforeEach(() => {
  client = createFakeTenantClient();
});

describe("scoreExactFields", () => {
  it("scores the fraction of fields that matched, not just pass/fail", () => {
    // "3 of 4 right" and "nothing right" are very different regressions, and a boolean hides which.
    const score = scoreExactFields(
      '{"type":"BUG","priority":"HIGH","moduleId":"m1","summary":"login"}',
      '{"type":"BUG","priority":"LOW","moduleId":"m1","summary":"login"}'
    );
    expect(score.score).toBe(0.75);
    expect(score.passed).toBe(false);
    expect(score.detail).toContain("priority");
  });

  it("ignores the model's self-reported confidence and reasoning", () => {
    // Confidence is unverifiable — scoring it would reward being confidently wrong exactly as much
    // as being right. Reasoning is prose that legitimately varies between identical answers.
    const score = scoreExactFields(
      '{"priority":"HIGH","confidence":0.9,"reasoning":"because of X"}',
      '{"priority":"HIGH","confidence":0.1,"reasoning":"totally different words"}'
    );
    expect(score.score).toBe(1);
    expect(score.passed).toBe(true);
  });

  it("recovers JSON wrapped in prose or code fences", () => {
    // Models do this often enough that giving up would report a scoring failure for a correct answer.
    const score = scoreExactFields('{"priority":"HIGH"}', 'Sure! Here you go:\n```json\n{"priority":"HIGH"}\n```');
    expect(score.passed).toBe(true);
  });

  it("scores zero when the answer isn't JSON at all", () => {
    const score = scoreExactFields('{"priority":"HIGH"}', "I couldn't determine a priority.");
    expect(score.score).toBe(0);
    expect(score.detail).toContain("wasn't valid JSON");
  });

  it("blames the expected value, not the model, when the ground truth is malformed", () => {
    // Otherwise a typo in a golden example looks like a model regression forever.
    const score = scoreExactFields("not json", '{"priority":"HIGH"}');
    expect(score.detail).toContain("expected answer isn't valid JSON");
  });
});

describe("scoreContains", () => {
  it("is case- and whitespace-insensitive", () => {
    expect(scoreContains("  Blocked On Review  ", "The ticket is blocked on review right now.").passed).toBe(true);
  });

  it("fails when the expected text is absent", () => {
    expect(scoreContains("blocked on review", "Everything is going fine.").passed).toBe(false);
  });
});

describe("isReplayable", () => {
  it("covers the capabilities whose params are captured", () => {
    for (const feature of ["triage", "chat_triage", "comment_summary", "ask_ai", "status_report"]) {
      expect(isReplayable(feature)).toBe(true);
    }
  });

  it("excludes the face capabilities, which never capture content at all", () => {
    expect(isReplayable("face_review_summary")).toBe(false);
    expect(isReplayable("face_policy_copilot")).toBe(false);
  });
});

describe("enqueueEvalRun", () => {
  const enqueue = () => runInTenant(client, () => enqueueEvalRun({ datasetId: "ds-1", userId: "user-1" }));

  function setup(over: { items?: number; feature?: string; budget?: number | null; spent?: number; inFlight?: boolean } = {}) {
    vi.mocked(client.aIDataset.findUnique).mockResolvedValue({
      id: "ds-1",
      feature: over.feature ?? "triage",
      _count: { items: over.items ?? 10 }
    } as never);
    vi.mocked(client.aIEvalRun.findFirst).mockResolvedValue((over.inFlight ? { id: "run-0", status: "RUNNING" } : null) as never);
    vi.mocked(client.globalAISettings.upsert).mockResolvedValue({
      id: "global",
      aiEnabled: true,
      model: "claude-haiku-4-5",
      monthlyBudgetUsd: over.budget === undefined ? null : over.budget
    } as never);
    vi.mocked(client.aIUsageLog.aggregate)
      // First call estimates cost per call from history; second sums this month's spend.
      .mockResolvedValueOnce({ _avg: { inputTokens: 1000, outputTokens: 200 } } as never)
      .mockResolvedValueOnce({ _sum: { costUsdEstimate: over.spent ?? 0 } } as never);
    vi.mocked(client.aIEvalRun.create).mockImplementation((async (args: any) => ({ id: "run-1", ...args.data })) as never);
  }

  it("records the estimate and the model on the queued run", async () => {
    setup();
    const run: any = await enqueue();

    // The model is copied at enqueue because settings can change mid-run, and a score is
    // meaningless without knowing what produced it.
    expect(run.model).toBe("claude-haiku-4-5");
    expect(run.itemCount).toBe(10);
    expect(run.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("refuses before spending anything when the estimate exceeds the remaining budget", async () => {
    // Being told up front beats discovering it after 60 paid calls.
    setup({ items: 100, budget: 1, spent: 0.999 });
    await expect(enqueue()).rejects.toMatchObject({ statusCode: 422 });
    expect(client.aIEvalRun.create).not.toHaveBeenCalled();
  });

  it("allows a run that fits inside what's left", async () => {
    setup({ items: 5, budget: 100, spent: 1 });
    await expect(enqueue()).resolves.toBeTruthy();
  });

  it("refuses a second concurrent run", async () => {
    // Two runs would race the same budget gate, and the loser would stop halfway for reasons that
    // look arbitrary to whoever started it.
    setup({ inFlight: true });
    await expect(enqueue()).rejects.toMatchObject({ statusCode: 409 });
  });

  it("refuses an empty dataset", async () => {
    setup({ items: 0 });
    await expect(enqueue()).rejects.toMatchObject({ statusCode: 422 });
  });

  it("refuses a capability with no replayer", async () => {
    setup({ feature: "face_review_summary" });
    await expect(enqueue()).rejects.toMatchObject({ statusCode: 422 });
  });

  it("caps the run at MAX_ITEMS_PER_RUN however big the dataset is", async () => {
    setup({ items: 5000, budget: null });
    const run: any = await enqueue();
    expect(run.itemCount).toBe(MAX_ITEMS_PER_RUN);
  });
});
