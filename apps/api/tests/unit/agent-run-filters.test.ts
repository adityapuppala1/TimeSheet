/**
 * V12 9.2 — the run list's filters.
 *
 * THE FAILURE THIS GUARDS: `AgentRun.status` is a VARCHAR, so an un-validated `?status=` would
 * accept anything and answer with an empty list — and an empty list of failures reads exactly like
 * "nothing failed". The set is closed, and a value outside it is refused rather than answered.
 */
import { describe, expect, it } from "vitest";
import { AGENT_RUN_STATUSES, buildAgentRunWhere } from "../../src/services/agent-run.service.js";

describe("AGENT_RUN_STATUSES", () => {
  it("is exactly what finish() and the runner can write — no more, no less", () => {
    expect([...AGENT_RUN_STATUSES].sort()).toEqual(
      ["ABORTED", "BLOCKED", "COMPLETED", "FAILED", "PARTIAL", "QUEUED", "RUNNING"].sort()
    );
    // SKIPPED belongs to the backup service. Offering it here would be a filter that can only ever
    // answer "none", which is the failure this list exists to prevent.
    expect(AGENT_RUN_STATUSES).not.toContain("SKIPPED");
  });
});

describe("buildAgentRunWhere", () => {
  it("is empty for no filters — everything, never nothing", () => {
    expect(buildAgentRunWhere({})).toEqual({});
  });

  it("carries each filter only when it was given", () => {
    expect(buildAgentRunWhere({ capability: "rebalance" })).toEqual({ capability: "rebalance" });
    expect(buildAgentRunWhere({ status: "FAILED" })).toEqual({ status: "FAILED" });
    expect(buildAgentRunWhere({ flowId: "f1" })).toEqual({ flowId: "f1" });
  });

  it("turns a day count into a boundary on createdAt, from the clock it is given", () => {
    const now = new Date("2026-09-17T12:00:00.000Z");
    const where = buildAgentRunWhere({ sinceDays: 7 }, now) as { createdAt: { gte: Date } };
    expect(where.createdAt.gte.toISOString()).toBe("2026-09-10T12:00:00.000Z");
  });

  it("ignores a zero or negative window rather than excluding every row", () => {
    expect(buildAgentRunWhere({ sinceDays: 0 })).toEqual({});
    expect(buildAgentRunWhere({ sinceDays: -5 })).toEqual({});
  });

  it("combines filters", () => {
    const now = new Date("2026-09-17T00:00:00.000Z");
    expect(buildAgentRunWhere({ capability: "rebalance", status: "PARTIAL", sinceDays: 1 }, now)).toEqual({
      capability: "rebalance",
      status: "PARTIAL",
      createdAt: { gte: new Date("2026-09-16T00:00:00.000Z") }
    });
  });
});
