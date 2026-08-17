/**
 * The ledger's honesty rules.
 *
 * This is the number a customer quotes back at a renewal, so the failures worth guarding are the
 * FLATTERING ones — every mistake available here makes the product look better than it is:
 *
 *   - Inventing a displacement where no baseline exists.
 *   - Using a mean instead of a median, so one long day makes every later saving look heroic.
 *   - Summing NULL as zero, which silently reports "measured everything" over partial data.
 *   - Double-counting a retried finish.
 *   - Recording a human's own run as agent work.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const runFindUnique = vi.fn();
const entryFindUnique = vi.fn();
const entryCreate = vi.fn();
const entryFindMany = vi.fn().mockResolvedValue([]);
const timesheetFindMany = vi.fn().mockResolvedValue([]);

vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    agentRun: { findUnique: runFindUnique },
    agentWorkEntry: { findUnique: entryFindUnique, create: entryCreate, findMany: entryFindMany },
    timesheet: { findMany: timesheetFindMany }
  }
}));

const { recordAgentWork, summariseLedger } = await import("../../src/services/agent-ledger.service.js");

const run = (over: Record<string, unknown> = {}) => ({
  id: "run-1",
  capability: "triage",
  status: "COMPLETED",
  onBehalfOfId: "agent-1",
  scopeProjectId: "proj-1",
  costUsd: 0.0042,
  startedAt: new Date("2026-08-17T10:00:00Z"),
  finishedAt: new Date("2026-08-17T10:00:45Z"),
  createdAt: new Date("2026-08-17T09:59:00Z"),
  onBehalfOf: { isAgent: true },
  ...over
});

const hours = (...values: number[]) => values.map((h) => ({ totalHours: h }));

beforeEach(() => {
  vi.clearAllMocks();
  runFindUnique.mockResolvedValue(run());
  entryFindUnique.mockResolvedValue(null);
  entryCreate.mockResolvedValue({ id: "e-1" });
  entryFindMany.mockResolvedValue([]);
  timesheetFindMany.mockResolvedValue([]);
});

describe("what lands on the ledger", () => {
  it("records duration from the run's own clock and cost from the run", async () => {
    await recordAgentWork("run-1");
    const data = entryCreate.mock.calls[0][0].data;
    expect(data.durationSeconds).toBe(45);
    expect(data.costUsd).toBe(0.0042);
    expect(data.agentUserId).toBe("agent-1");
    expect(data.projectId).toBe("proj-1");
  });

  it("ignores a HUMAN's run — that is their own work, not the roster's", async () => {
    runFindUnique.mockResolvedValue(run({ onBehalfOf: { isAgent: false } }));
    await recordAgentWork("run-1");
    expect(entryCreate).not.toHaveBeenCalled();
  });

  it("records a FAILED or ABORTED run, because it still cost money", async () => {
    for (const status of ["FAILED", "ABORTED", "PARTIAL", "BLOCKED"]) {
      vi.clearAllMocks();
      entryFindUnique.mockResolvedValue(null);
      runFindUnique.mockResolvedValue(run({ status }));
      await recordAgentWork("run-1");
      expect(entryCreate, status).toHaveBeenCalled();
    }
  });

  it("skips work that never started", async () => {
    for (const status of ["QUEUED", "RUNNING"]) {
      vi.clearAllMocks();
      runFindUnique.mockResolvedValue(run({ status }));
      await recordAgentWork("run-1");
      expect(entryCreate, status).not.toHaveBeenCalled();
    }
  });

  it("cannot double-count a retried finish", async () => {
    entryFindUnique.mockResolvedValue({ id: "already" });
    await recordAgentWork("run-1");
    expect(entryCreate).not.toHaveBeenCalled();
  });

  it("is never billable on creation", async () => {
    await recordAgentWork("run-1");
    expect(entryCreate.mock.calls[0][0].data.billable).toBe(false);
  });
});

describe("displacement is measured or absent, never guessed", () => {
  it("is NULL when the workspace has too few comparable entries to have a median", async () => {
    // Four rows is an anecdote. This figure sits next to a currency amount.
    timesheetFindMany.mockResolvedValue(hours(1, 2, 3, 4));
    await recordAgentWork("run-1");
    const data = entryCreate.mock.calls[0][0].data;
    expect(data.displacedMinutes).toBeNull();
    expect(data.displacedBasis).toBeNull();
  });

  it("is NULL for a capability with no human equivalent people log time against", async () => {
    timesheetFindMany.mockResolvedValue(hours(1, 1, 1, 1, 1, 1));
    runFindUnique.mockResolvedValue(run({ capability: "weekly_digest" }));
    await recordAgentWork("run-1");
    expect(entryCreate.mock.calls[0][0].data.displacedMinutes).toBeNull();
    // And it does not even ask, since there is no activity to compare against.
    expect(timesheetFindMany).not.toHaveBeenCalled();
  });

  it("uses a MEDIAN, so one long day cannot inflate every later saving", async () => {
    // Mean would be 118 minutes; median is 60. The flattering answer is the wrong one.
    timesheetFindMany.mockResolvedValue(hours(1, 1, 1, 1, 6));
    await recordAgentWork("run-1");
    expect(entryCreate.mock.calls[0][0].data.displacedMinutes).toBe(60);
  });

  it("stores the basis beside the figure, so it can be checked rather than trusted", async () => {
    timesheetFindMany.mockResolvedValue(hours(1, 1, 1, 1, 1));
    await recordAgentWork("run-1");
    expect(entryCreate.mock.calls[0][0].data.displacedBasis).toMatch(/median of 5 approved "Support" entries/);
  });

  it("reads only APPROVED hours, the same ledger every other measured figure uses", async () => {
    timesheetFindMany.mockResolvedValue(hours(1, 1, 1, 1, 1));
    await recordAgentWork("run-1");
    expect(timesheetFindMany.mock.calls[0][0].where).toMatchObject({ status: "APPROVED", deletedAt: null });
  });
});

describe("the summary never treats unknown as zero", () => {
  it("reports measurable and unmeasurable entries separately", async () => {
    entryFindMany.mockResolvedValue([
      { capability: "triage", costUsd: 0.01, durationSeconds: 60, displacedMinutes: 30, billable: false },
      { capability: "triage", costUsd: 0.02, durationSeconds: 120, displacedMinutes: null, billable: false },
      { capability: "weekly_digest", costUsd: 0.03, durationSeconds: 30, displacedMinutes: null, billable: false }
    ]);
    const s = await summariseLedger();
    expect(s.entries).toBe(3);
    expect(s.measuredEntries).toBe(1);
    // Two entries have no baseline. Rolling them in as zero would report "measured everything".
    expect(s.unmeasurableEntries).toBe(2);
    expect(s.displacedHours).toBe(0.5);
  });

  it("totals cost and duration across every entry", async () => {
    entryFindMany.mockResolvedValue([
      { capability: "triage", costUsd: 0.5, durationSeconds: 1800, displacedMinutes: null, billable: false },
      { capability: "triage", costUsd: 0.25, durationSeconds: 1800, displacedMinutes: null, billable: false }
    ]);
    const s = await summariseLedger();
    expect(s.totalCostUsd).toBe(0.75);
    expect(s.totalDurationHours).toBe(1);
  });

  it("reports zero billable while the never-by-default decision stands", async () => {
    entryFindMany.mockResolvedValue([
      { capability: "triage", costUsd: 1.5, durationSeconds: 60, displacedMinutes: null, billable: false }
    ]);
    const s = await summariseLedger();
    expect(s.billableCostUsd).toBe(0);
    expect(s.totalCostUsd).toBe(1.5);
  });

  it("groups by capability, busiest first", async () => {
    entryFindMany.mockResolvedValue([
      { capability: "triage", costUsd: 0.1, durationSeconds: 10, displacedMinutes: 5, billable: false },
      { capability: "triage", costUsd: 0.1, durationSeconds: 10, displacedMinutes: 5, billable: false },
      { capability: "status_report", costUsd: 0.4, durationSeconds: 10, displacedMinutes: null, billable: false }
    ]);
    const s = await summariseLedger();
    expect(s.byCapability[0]).toMatchObject({ capability: "triage", entries: 2, displacedMinutes: 10 });
    expect(s.byCapability[1]).toMatchObject({ capability: "status_report", entries: 1, displacedMinutes: null });
  });
});
