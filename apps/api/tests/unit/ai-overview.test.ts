/**
 * The map's two pieces of judgement: which single next step it names, and whether the ledger's trend
 * tells the truth about the days it has no data for.
 *
 * Both are here because both fail quietly. A next-step that names the wrong thing sends an
 * administrator to the wrong screen; a zero-filled day that is actually an UNMEASURED day makes a chart
 * claim a displacement of nothing, which is the opposite of "we cannot tell".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const entryFindMany = vi.fn().mockResolvedValue([]);

vi.mock("../../src/config/prisma.js", () => ({
  prisma: { agentWorkEntry: { findMany: (...a: unknown[]) => entryFindMany(...a) } }
}));

const { pickNextStep } = await import("../../src/services/ai-overview.service.js");
const { getLedgerHistory } = await import("../../src/services/agent-ledger-history.service.js");

const base = { settings: { aiEnabled: true }, profiles: [{ enabled: true }], flows: [{ enabled: true }], waiting: 0, pending: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  entryFindMany.mockResolvedValue([]);
});

describe("the one next step, ordered by what blocks what", () => {
  it("says nothing when everything is running and no queue has built up", () => {
    expect(pickNextStep(base)).toBeNull();
  });

  it("puts the master switch first, whatever else is unfinished", () => {
    expect(pickNextStep({ ...base, settings: { aiEnabled: false }, profiles: [], flows: [], waiting: 3 })).toMatch(/switched off/i);
  });

  it("puts a run waiting for a person above anything merely unfinished", () => {
    // A gate nobody clears is work that has stopped, whereas an empty roster is work not yet started.
    expect(pickNextStep({ ...base, waiting: 2, profiles: [], flows: [] })).toMatch(/waiting for somebody to approve/i);
  });

  it("names the roster before the workflows, because a flow cannot use a teammate that is not there", () => {
    expect(pickNextStep({ ...base, profiles: [], flows: [] })).toMatch(/No AI teammates/i);
    expect(pickNextStep({ ...base, profiles: [{ enabled: false }], flows: [] })).toMatch(/switched off, so no workflow/i);
  });

  it("mentions a review queue only once it is big enough to be a problem", () => {
    expect(pickNextStep({ ...base, pending: 4 })).toBeNull();
    expect(pickNextStep({ ...base, pending: 40 })).toMatch(/waiting for review/i);
  });
});

describe("the ledger trend never reports an unmeasured day as zero", () => {
  it("zero-fills every day in the window so the spacing means one thing", async () => {
    const history = await getLedgerHistory(14);
    expect(history.daily).toHaveLength(14);
    expect(history.daily.every((d) => d.entries === 0 && d.costUsd === 0)).toBe(true);
    // No data at all is no MEASURED days — not fourteen days of zero displacement.
    expect(history.measuredDays).toBe(0);
  });

  it("counts a day with cost but no displacement as unmeasured", async () => {
    const today = new Date();
    entryFindMany.mockResolvedValue([
      { agentRunId: "r1", capability: "triage", costUsd: "0.5000", durationSeconds: 12, displacedMinutes: null, displacedBasis: null, occurredAt: today },
      { agentRunId: "r2", capability: "triage", costUsd: "0.2500", durationSeconds: 8, displacedMinutes: 30, displacedBasis: "median of 6 approved entries", occurredAt: today }
    ]);

    const history = await getLedgerHistory(7);
    const day = history.daily.at(-1)!;
    expect(day.entries).toBe(2);
    expect(day.costUsd).toBeCloseTo(0.75, 4);
    expect(day.displacedMinutes).toBe(30);
    // One of the two entries had no measurement, and the DAY counts as measured because one did —
    // which is why the entry list also reports each row's own basis.
    expect(history.measuredDays).toBe(1);
    expect(history.entries.filter((e) => e.displacedMinutes === null)).toHaveLength(1);
  });
});
