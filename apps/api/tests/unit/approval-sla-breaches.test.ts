/**
 * The approval-SLA breach count (services/approval-sla-breaches.service.ts), which the home page,
 * the Team page and the Practice Update all poll. It used to read every deadline row in the window
 * and filter in Node; it is one COUNT(*) now. The SQL is evaluated over a table here
 * (tests/helpers/approval-sla-sql.ts), which refuses a query that does not state the rule.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateApprovalSlaQuery, type SlaRow } from "../helpers/approval-sla-sql.js";

const state = vi.hoisted(() => ({ rows: [] as SlaRow[], queries: 0 }));

vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    $queryRaw: vi.fn(async (query: any) => {
      state.queries += 1;
      return evaluateApprovalSlaQuery(query, state.rows);
    })
  }
}));

const { countApprovalSlaBreaches, countApprovalSlaBreachesBy } = await import("../../src/services/approval-sla-breaches.service.js");

const NOW = new Date("2026-10-02T10:00:00.000Z");
const at = (iso: string) => new Date(iso);
const WINDOW = { gte: at("2026-10-01T00:00:00.000Z"), lt: at("2026-10-03T00:00:00.000Z") };

beforeEach(() => {
  state.queries = 0;
  state.rows = [
    // Unreviewed, deadline passed: breached.
    { userId: "asha", projectId: "p1", approvalDeadline: at("2026-10-01T09:00:00.000Z"), reviewedAt: null },
    // Reviewed after the deadline: breached.
    { userId: "ben", projectId: "p2", approvalDeadline: at("2026-10-01T09:00:00.000Z"), reviewedAt: at("2026-10-01T12:00:00.000Z") },
    // Reviewed in time: not breached.
    { userId: "ben", projectId: "p2", approvalDeadline: at("2026-10-02T09:00:00.000Z"), reviewedAt: at("2026-10-02T08:00:00.000Z") },
    // Deadline later today, still waiting: not breached YET — the window stops at now.
    { userId: "asha", projectId: "p1", approvalDeadline: at("2026-10-02T15:00:00.000Z"), reviewedAt: null },
    // Deleted: never counted.
    { userId: "asha", projectId: "p1", approvalDeadline: at("2026-10-01T09:00:00.000Z"), reviewedAt: null, deletedAt: at("2026-10-01T10:00:00.000Z") }
  ];
});

describe("countApprovalSlaBreaches", () => {
  it("counts (reviewedAt ?? now) > deadline for deadlines in the window, up to now", async () => {
    expect(await countApprovalSlaBreaches(WINDOW, NOW)).toBe(2);
  });

  it("scopes to the people asked about, and treats an empty list as nobody without querying", async () => {
    expect(await countApprovalSlaBreaches(WINDOW, NOW, { userIds: ["asha"] })).toBe(1);
    state.queries = 0;
    expect(await countApprovalSlaBreaches(WINDOW, NOW, { userIds: [] })).toBe(0);
    expect(state.queries).toBe(0);
  });

  it("is zero for a window that has not started, without querying", async () => {
    expect(await countApprovalSlaBreaches({ gte: at("2026-10-05T00:00:00.000Z") }, NOW)).toBe(0);
    expect(state.queries).toBe(0);
  });
});

describe("countApprovalSlaBreachesBy", () => {
  it("counts per project, leaving out projects with none", async () => {
    const byProject = await countApprovalSlaBreachesBy("projectId", WINDOW, NOW, { projectIds: ["p1", "p2", "p3"] });
    expect([...byProject.entries()].sort()).toEqual([
      ["p1", 1],
      ["p2", 1]
    ]);
  });
});
