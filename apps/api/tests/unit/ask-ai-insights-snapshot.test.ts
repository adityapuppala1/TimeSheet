/**
 * The workspace snapshot Ask AI answers from (`buildInsightsSnapshotText`), and the admin chat's
 * `sla_and_escalations` tool — they must state the same figures the Insights and Reports pages do.
 *
 *   - M6: the snapshot's "Open SLA breaches" read `slaBreachAt`, which only the TICKET_SLA_ENABLED
 *     sweep writes, so with the sweep off Ask AI said 0 while the Reports tile (now from `dueAt`)
 *     said otherwise. One definition: open and past `dueAt`.
 *   - M11: its workload line named AI agent identities as people.
 *   - H5: its cost line added every currency together and printed "$".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ counts: [] as any[], groupBys: [] as any[], timesheets: [] as any[] }));

vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    ticket: {
      count: vi.fn(async (args: any) => (state.counts.push(args), 0)),
      groupBy: vi.fn(async (args: any) => (state.groupBys.push(args), []))
    },
    escalation: { count: vi.fn(async () => 0) },
    user: { findMany: vi.fn(async () => []) },
    timesheet: { findMany: vi.fn(async () => state.timesheets) },
    globalTicketSettings: { findUnique: vi.fn(async () => ({ enableCostAnalytics: true, defaultCurrency: "EUR" })) }
  }
}));

const { buildInsightsSnapshotText } = await import("../../src/controllers/ai.controller.js");
const { AI_CHAT_ADMIN_TOOLS } = await import("../../src/services/ai-chat-admin-tools.js");

beforeEach(() => {
  state.counts = [];
  state.groupBys = [];
  state.timesheets = [];
});

const unrestricted = { unrestricted: true, projectIds: [] } as never;

describe("Ask AI's workspace snapshot", () => {
  it("counts SLA breaches from the due date, not from the sweep's stamp", async () => {
    await buildInsightsSnapshotText(unrestricted);
    expect(state.counts.some((a) => a.where.slaBreachAt)).toBe(false);
    expect(state.counts.find((a) => a.where.dueAt)?.where).toMatchObject({
      dueAt: { lt: expect.any(Date) },
      status: { notIn: ["RESOLVED", "CLOSED"] }
    });
  });

  it("names people, not AI agents, in the workload line", async () => {
    await buildInsightsSnapshotText(unrestricted);
    expect(state.groupBys[0].where.assignee).toEqual({ isAgent: false });
  });

  it("states cost per currency, never one dollar total", async () => {
    state.timesheets = [
      { totalHours: 8, billable: true, billedAmount: 8000, billedRate: 1000, billedCurrency: "INR", user: { hourlyRate: null }, ticket: { project: { billingCurrency: "INR" } } },
      { totalHours: 4, billable: true, billedAmount: 400, billedRate: 100, billedCurrency: "USD", user: { hourlyRate: null }, ticket: { project: { billingCurrency: "USD" } } }
    ];
    const text = await buildInsightsSnapshotText(unrestricted);
    expect(text).toContain("INR 8,000.00");
    expect(text).toContain("USD 400.00");
    expect(text).not.toContain("$");
  });
});

describe("the admin chat's sla_and_escalations tool", () => {
  it("uses the same breach rule", async () => {
    const tool = AI_CHAT_ADMIN_TOOLS.find((t) => t.name === "sla_and_escalations")!;
    await tool.run({}, {} as never);
    expect(state.counts.find((a) => a.where.dueAt)?.where).toMatchObject({
      dueAt: { lt: expect.any(Date) },
      status: { notIn: ["RESOLVED", "CLOSED"] }
    });
  });
});
