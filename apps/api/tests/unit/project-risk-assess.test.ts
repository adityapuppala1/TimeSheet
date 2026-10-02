/**
 * `assessProject` — the database shell around the pure risk rule (project-risk.service.ts), which
 * feeds the nightly snapshot, the Portfolio's risk column and the AI narrator.
 *
 *   - Budget: it scored the forecast built from burn summed across every billed currency and
 *     labelled with the budget's. A project budgeted in USD and billed in INR read as tens of times
 *     over budget. Burn and the forecast now come from the budget's currency alone, and the facts
 *     the narrator reads say which currency that is and what was billed in others.
 *   - SLA breaches: it counted tickets with `slaBreachAt` set, which only the TICKET_SLA_ENABLED sweep
 *     writes, so wherever the sweep is off the signal was always 0 while every other page counted
 *     breaches from `dueAt`. It uses the shared rule now (workspace-metrics.ts#openBreachedWhere).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ ticketCounts: [] as any[] }));
const NOW = new Date("2026-10-02T06:00:00.000Z");

vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    project: {
      findFirstOrThrow: vi.fn(async () => ({ id: "p1", code: "APL", name: "Apollo", plannedEndDate: null })),
      // Budgeted in dollars, billed in rupees.
      findMany: vi.fn(async () => [{ id: "p1", budgetAmount: 1000, budgetCurrency: "USD", billingCurrency: "INR", budgetAlertPct: null }])
    },
    timesheet: {
      groupBy: vi.fn(async (args: any) =>
        args.by.includes("billedCurrency")
          ? [
              { projectId: "p1", billedCurrency: "USD", _sum: { billedAmount: 50, totalHours: 2 } },
              { projectId: "p1", billedCurrency: "INR", _sum: { billedAmount: 50_000, totalHours: 10 } }
            ]
          : []
      )
    },
    globalTicketSettings: { findUnique: vi.fn(async () => ({ defaultCurrency: "INR" })) },
    agentWorkEntry: { groupBy: vi.fn(async () => []) },
    ticketLink: { findMany: vi.fn(async () => []) },
    ticket: {
      groupBy: vi.fn(async () => []),
      count: vi.fn(async (args: any) => {
        state.ticketCounts.push(args);
        // Two open tickets are past their due date; the sweep has stamped none of them.
        return args.where.slaBreachAt ? 0 : 2;
      })
    }
  }
}));
vi.mock("../../src/services/plan-schedule.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/plan-schedule.service.js")>()),
  readWorkingDays: vi.fn(async () => [1, 2, 3, 4, 5]),
  buildPlan: vi.fn(async () => ({
    // 10% done, so the forecast is burn ÷ 10%.
    items: [{ id: "t1", estimatedHours: 10, effectiveProgressPct: 10, slipDays: 0, statusCategory: "IN_PROGRESS" }],
    raw: [{ id: "t1", projectId: "p1" }],
    end: null,
    violations: []
  }))
}));
vi.mock("../../src/services/workload.service.js", () => ({ loadWorkload: vi.fn(async () => ({ rows: [] })) }));

const { assessProject } = await import("../../src/services/project-risk.service.js");

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterAll(() => vi.useRealTimers());

describe("assessProject", () => {
  it("scores the budget from burn in the budget's currency alone and says what was billed in others", async () => {
    const result = await assessProject("p1");
    const budget = result.signals.find((s) => s.key === "budgetOverrun")!;
    // $50 at 10% progress forecasts $500 against $1,000: no overrun. Adding the ₹50,000 forecast
    // $500,500 and scored the full 20 points.
    expect(budget.points).toBe(0);
    expect(result.facts).toMatchObject({ burn: 50, forecast: 500, budgetCurrency: "USD", otherCurrencyBurn: "INR 50000" });
  });
});
