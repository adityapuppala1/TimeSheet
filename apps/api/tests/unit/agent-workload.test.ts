/**
 * The agent series on the workload board, and the one bug that made it necessary.
 *
 * An AI teammate is an ACTIVE user row. Before this, the board's people query said only "active and
 * not deleted", so every teammate appeared as a colleague with the workspace's default capacity and
 * nothing booked — a permanently idle person nobody hired. That is pinned here because it is invisible
 * in a workspace with no agents and obvious in one with six.
 *
 * The rest pins the honesty rule the ledger already follows: an unmeasured displacement is null, never
 * zero, because "we cannot tell" and "it displaced nothing" are opposite claims.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const userFindMany = vi.fn().mockResolvedValue([]);
const entryFindMany = vi.fn().mockResolvedValue([]);

vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    user: { findMany: (...a: unknown[]) => userFindMany(...a) },
    agentWorkEntry: { findMany: (...a: unknown[]) => entryFindMany(...a) },
    resourceBooking: { findMany: vi.fn().mockResolvedValue([]) },
    timesheet: { findMany: vi.fn().mockResolvedValue([]) },
    ticket: { findMany: vi.fn().mockResolvedValue([]) }
  }
}));
vi.mock("../../src/services/planning.service.js", () => ({
  getPlanningSettings: vi.fn().mockResolvedValue({ workingDays: [1, 2, 3, 4, 5], defaultWeeklyCapacityHours: 40 })
}));

const { buildBuckets, loadAgentWorkload, loadWorkload } = await import("../../src/services/workload.service.js");

// UTC on purpose: `toDay` normalises by slicing the ISO string, so a LOCAL-midnight Date west or
// east of UTC lands on the previous day and the week columns shift. The controller feeds this
// `toDay(req.query.from)` on a plain "YYYY-MM-DD", which has no such ambiguity.
const from = new Date("2026-08-03T00:00:00.000Z");
const to = new Date("2026-08-16T23:59:59.000Z");
const buckets = buildBuckets(from, to, "week");
const cellAt = (row: { cells: Array<{ bucketStart: string }> }, day: string) => row.cells.find((c) => c.bucketStart === day)!;

beforeEach(() => {
  vi.clearAllMocks();
  userFindMany.mockResolvedValue([]);
  entryFindMany.mockResolvedValue([]);
});

describe("an AI teammate is not a colleague with nothing to do", () => {
  it("excludes agent identities from the people the board reports on", async () => {
    await loadWorkload({ from, to });
    expect(userFindMany.mock.calls[0][0].where).toMatchObject({ status: "ACTIVE", deletedAt: null, isAgent: false });
  });
});

describe("the agent series", () => {
  it("is empty rather than a row of zeroes when no teammate worked", async () => {
    expect(await loadAgentWorkload({ from, to, buckets })).toEqual([]);
  });

  it("buckets cost and wall clock, and keeps an unmeasured displacement null", async () => {
    entryFindMany.mockResolvedValue([
      { agentUserId: "a-1", occurredAt: new Date("2026-08-04T10:00:00.000Z"), durationSeconds: 1800, costUsd: "0.4000", displacedMinutes: 25 },
      { agentUserId: "a-1", occurredAt: new Date("2026-08-05T10:00:00.000Z"), durationSeconds: 900, costUsd: "0.1000", displacedMinutes: null },
      { agentUserId: "a-1", occurredAt: new Date("2026-08-11T10:00:00.000Z"), durationSeconds: 3600, costUsd: "0.2500", displacedMinutes: null }
    ]);
    userFindMany.mockResolvedValue([{ id: "a-1", name: "Triage bot", avatarUrl: null }]);

    const [row] = await loadAgentWorkload({ from, to, buckets });

    expect(row.agent.name).toBe("Triage bot");
    expect(row.cells).toHaveLength(buckets.length);
    // Week of the 3rd: two runs, 45 minutes of wall clock, one of them measured.
    expect(cellAt(row, "2026-08-03")).toMatchObject({ runs: 2, workedHours: 0.75, displacedMinutes: 25 });
    // Week of the 10th: one run, and NOTHING measurable — null, not 0.
    expect(cellAt(row, "2026-08-10")).toMatchObject({ runs: 1, workedHours: 1 });
    expect(cellAt(row, "2026-08-10").displacedMinutes).toBeNull();
    expect(row.totals).toMatchObject({ runs: 3, measuredRuns: 1, displacedMinutes: 25 });
    expect(row.totals.costUsd).toBeCloseTo(0.75, 4);
  });

  it("ignores an entry whose agent identity has since been deleted rather than inventing a row", async () => {
    entryFindMany.mockResolvedValue([
      { agentUserId: "gone", occurredAt: new Date("2026-08-04T10:00:00.000Z"), durationSeconds: 60, costUsd: "0.0100", displacedMinutes: null }
    ]);
    userFindMany.mockResolvedValue([]);
    expect(await loadAgentWorkload({ from, to, buckets })).toEqual([]);
  });
});

describe("the agent series' window", () => {
  it("includes the whole of the last day, measured on the platform's (IST) calendar", async () => {
    // The controller hands this `toDay("2026-08-16")` — UTC midnight. `occurredAt <= to` dropped every
    // run on the 16th after 00:00 UTC, and started the window at 05:30 IST on the 3rd.
    await loadAgentWorkload({ from: new Date("2026-08-03T00:00:00.000Z"), to: new Date("2026-08-16T00:00:00.000Z"), buckets });
    expect(entryFindMany.mock.calls[0][0].where.occurredAt).toEqual({
      gte: new Date("2026-08-02T18:30:00.000Z"),
      lt: new Date("2026-08-16T18:30:00.000Z")
    });
  });

  it("buckets a run by its IST day, so 01:00 IST on Monday is Monday's week", async () => {
    entryFindMany.mockResolvedValue([
      // 19:30 UTC on Sunday the 9th is 01:00 IST on Monday the 10th.
      { agentUserId: "a-1", occurredAt: new Date("2026-08-09T19:30:00.000Z"), durationSeconds: 3600, costUsd: "0.1000", displacedMinutes: null }
    ]);
    userFindMany.mockResolvedValue([{ id: "a-1", name: "Triage bot", avatarUrl: null }]);
    const [row] = await loadAgentWorkload({ from, to, buckets });
    expect(cellAt(row, "2026-08-10").runs).toBe(1);
    expect(cellAt(row, "2026-08-03").runs).toBe(0);
  });
});

describe("what the board calls logged (M10)", () => {
  it("is submitted + approved hours — the definition every other page uses", async () => {
    const { prisma } = await import("../../src/config/prisma.js");
    userFindMany.mockResolvedValue([{ id: "u1", name: "Ana", email: "a@x.test", avatarUrl: null, weeklyCapacityHours: null, plannedUtilizationPct: null }]);
    await loadWorkload({ from, to });
    const logged = vi.mocked(prisma.timesheet.findMany).mock.calls.at(-1)![0] as any;
    expect(logged.where.status).toEqual({ in: ["SUBMITTED", "APPROVED"] });
  });
});
