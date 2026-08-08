/**
 * Tests for the AI quality metrics.
 *
 * These matter more than usual because the whole point of this surface is to be HONEST about what
 * it can and can't measure. A quality dashboard that quietly overstates confidence is worse than
 * no dashboard — someone will make a decision on it. So the suppression rules (small samples,
 * unmeasurable features, legacy data kept separate) are pinned as hard assertions, not left to
 * whoever edits this next.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";

const { getAIQualitySummary } = await import("../../src/services/ai-quality.service.js");

let client: ReturnType<typeof createFakeTenantClient>;

/** `parseOk: null` marks a free-text feature (nothing to parse); "up"/"down" is a human rating. */
type Row = { feature: string; parseOk: boolean | null; feedback: string | null; latencyMs: number | null };

function withRows(rows: Row[], legacy = { up: 0, down: 0 }) {
  vi.mocked(client.globalAISettings.upsert).mockResolvedValue({
    id: "global",
    aiCaptureEnabled: true,
    aiCaptureContentEnabled: false
  } as never);
  vi.mocked(client.aIInteraction.findMany).mockResolvedValue(rows as never);
  vi.mocked(client.ticket.count).mockResolvedValueOnce(legacy.up as never).mockResolvedValueOnce(legacy.down as never);
}

const row = (over: Partial<Row> = {}): Row => ({ feature: "triage", parseOk: true, feedback: null, latencyMs: 100, ...over });

beforeEach(() => {
  client = createFakeTenantClient();
  // The summary now also reports what people did with AI-authored change rows. Defaulted to none
  // here so these tests stay about the per-call numbers they were written for — the decision
  // counting has its own file.
  vi.mocked(client.aiProposalChange.findMany).mockResolvedValue([] as never);
});

describe("getAIQualitySummary", () => {
  it("computes parse-failure rate over parseable calls only", async () => {
    withRows([
      row({ parseOk: true }),
      row({ parseOk: true }),
      row({ parseOk: false }),
      row({ parseOk: false }),
      // A free-text call has no schema — it must not dilute the rate in either direction.
      row({ feature: "writing_assistant", parseOk: null })
    ]);
    const summary = await runInTenant(client, () => getAIQualitySummary(30));

    expect(summary.overallParseFailureRate).toBe(0.5);
    const triage = summary.features.find((f) => f.feature === "triage")!;
    expect(triage.parseableInteractions).toBe(4);
    expect(triage.parseFailureRate).toBe(0.5);
  });

  it("reports parseFailureRate as null for features that have nothing to parse", async () => {
    withRows([row({ feature: "writing_assistant", parseOk: null }), row({ feature: "writing_assistant", parseOk: null })]);
    const summary = await runInTenant(client, () => getAIQualitySummary(30));

    // Null, not 0 — "no failures" and "not measurable" are different claims, and rendering the
    // second as the first would imply a clean bill of health nobody verified.
    expect(summary.features[0].parseFailureRate).toBeNull();
  });

  it("suppresses thumbs-up rate below 10 ratings but still reports coverage", async () => {
    // 3 ratings out of 100 calls. A "67% positive" headline here would be actively misleading.
    const rows = [
      ...Array.from({ length: 97 }, () => row()),
      row({ feedback: "up" }),
      row({ feedback: "up" }),
      row({ feedback: "down" })
    ];
    withRows(rows);
    const summary = await runInTenant(client, () => getAIQualitySummary(30));
    const triage = summary.features[0];

    expect(triage.rated).toBe(3);
    expect(triage.thumbsUpRate).toBeNull();
    expect(triage.coverage).toBe(0.03);
  });

  it("reports thumbs-up rate once there are enough ratings to mean something", async () => {
    const rows = [...Array.from({ length: 8 }, () => row({ feedback: "up" })), ...Array.from({ length: 2 }, () => row({ feedback: "down" }))];
    withRows(rows);
    const summary = await runInTenant(client, () => getAIQualitySummary(30));

    expect(summary.features[0].rated).toBe(10);
    expect(summary.features[0].thumbsUpRate).toBe(0.8);
    expect(summary.features[0].coverage).toBe(1);
  });

  it("sorts worst parse rate first — the screen exists to surface what's broken", async () => {
    withRows([
      row({ feature: "good", parseOk: true }),
      row({ feature: "good", parseOk: true }),
      row({ feature: "bad", parseOk: false }),
      row({ feature: "bad", parseOk: false })
    ]);
    const summary = await runInTenant(client, () => getAIQualitySummary(30));

    expect(summary.features[0].feature).toBe("bad");
  });

  it("keeps legacy per-ticket thumbs in their own bucket", async () => {
    // Ticket.aiFeedback is one flag per TICKET; everything else here is per CALL. Adding them
    // together would produce a number with no meaning.
    withRows([row({ feedback: "up" })], { up: 7, down: 3 });
    const summary = await runInTenant(client, () => getAIQualitySummary(30));

    expect(summary.legacyTicketFeedback).toEqual({ up: 7, down: 3 });
    expect(summary.features[0].thumbsUp).toBe(1);
  });

  it("handles an empty window without dividing by zero", async () => {
    withRows([]);
    const summary = await runInTenant(client, () => getAIQualitySummary(30));

    expect(summary.totalInteractions).toBe(0);
    expect(summary.overallParseFailureRate).toBeNull();
    expect(summary.features).toEqual([]);
  });

  it("averages latency only over calls that recorded one", async () => {
    withRows([row({ latencyMs: 100 }), row({ latencyMs: 300 }), row({ latencyMs: null })]);
    const summary = await runInTenant(client, () => getAIQualitySummary(30));

    expect(summary.features[0].avgLatencyMs).toBe(200);
  });
});
