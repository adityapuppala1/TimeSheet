/**
 * The BUDGET_BURN custom-dashboard widget.
 *
 *   - H14: progress per project was found with `plan.raw.find` inside `plan.items.filter` inside a
 *     loop over projects — O(projects × tickets²) over every ticket including closed ones, on a tile
 *     that renders on every dashboard load. One id → project map, built once, makes it linear.
 *   - H5: budgets were added across currencies and labelled with the first row's currency, and burn
 *     from projects with NO budget went into the numerator while only budgeted projects made the
 *     denominator, so burn % was overstated.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  plan: { items: [] as any[], raw: [] as any[] },
  budgets: new Map<string, any>(),
  progressSeen: new Map<string, number>()
}));

vi.mock("../../src/config/prisma.js", () => ({ prisma: {} }));
vi.mock("../../src/services/plan-schedule.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/plan-schedule.service.js")>();
  return { ...actual, buildPlan: vi.fn(async () => state.plan) };
});
vi.mock("../../src/services/budget.service.js", async (importOriginal) => ({
  // The real roll-up helpers; only the database read is stubbed.
  ...(await importOriginal<typeof import("../../src/services/budget.service.js")>()),
  computeProjectBudgets: vi.fn(async (_ids: string[], progress: Map<string, number>) => {
    state.progressSeen = progress;
    return state.budgets;
  })
}));

const { resolveWidget } = await import("../../src/services/dashboard.service.js");

function budget(projectId: string, amount: number | null, burn: number, currency: string) {
  return { projectId, budget: amount, burn, currency };
}

beforeEach(() => {
  state.plan = { items: [], raw: [] };
  state.budgets = new Map();
});

const burnWidget = (projectIds: string[]) => resolveWidget({ type: "BUDGET_BURN", config: {}, projectIds, viewerId: "u1" } as never);

describe("BUDGET_BURN", () => {
  it("computes burn % over budgeted projects only", async () => {
    state.budgets = new Map([
      ["p1", budget("p1", 1000, 500, "INR")],
      // No budget: its 300 of burn has nothing to be a percentage of.
      ["p2", budget("p2", null, 300, "INR")]
    ]);
    const w: any = await burnWidget(["p1", "p2"]);
    expect(w.value).toBe(50);
    expect(w.unit).toBe("%");
    expect(w.hint).toContain("₹500");
    expect(w.hint).toContain("₹1,000");
    expect(w.hint).toMatch(/1 budgeted project/);
  });

  it("never adds budgets in different currencies — it reports each one", async () => {
    state.budgets = new Map([
      ["p1", budget("p1", 1000, 500, "INR")],
      ["p3", budget("p3", 100, 80, "USD")]
    ]);
    const w: any = await burnWidget(["p1", "p3"]);
    expect(w.value).toBeNull();
    expect(w.hint).toMatch(/INR 50%/);
    expect(w.hint).toMatch(/USD 80%/);
  });

  it("keeps burn billed in another currency out of the percentage and names it beside it", async () => {
    state.budgets = new Map([
      ["p1", { ...budget("p1", 1000, 500, "INR"), otherCurrencyBurn: [{ currency: "USD", amount: 40 }] }]
    ]);
    const w: any = await burnWidget(["p1"]);
    expect(w.value).toBe(50);
    expect(w.hint).toContain("₹500 of ₹1,000");
    expect(w.hint).toMatch(/\$40 billed in USD.*not counted/);
  });

  it("is unavailable, not 0%, when no project has a budget", async () => {
    state.budgets = new Map([["p2", budget("p2", null, 300, "INR")]]);
    const w: any = await burnWidget(["p2"]);
    expect(w.unavailable).toBe("No budgets set");
  });

  it("weights progress per project from one id → project map, never a search per item", async () => {
    const raw = [
      { id: "t1", projectId: "p1" },
      { id: "t2", projectId: "p1" },
      { id: "t3", projectId: "p2" }
    ];
    const findSpy = vi.spyOn(raw, "find");
    state.plan = {
      raw,
      items: [
        { id: "t1", estimatedHours: 3, effectiveProgressPct: 100 },
        { id: "t2", estimatedHours: 1, effectiveProgressPct: 0 },
        { id: "t3", estimatedHours: null, effectiveProgressPct: 50 }
      ]
    };
    state.budgets = new Map([["p1", budget("p1", 1000, 500, "INR")]]);
    await burnWidget(["p1", "p2"]);
    expect(state.progressSeen.get("p1")).toBe(75);
    expect(state.progressSeen.get("p2")).toBe(50);
    expect(findSpy).not.toHaveBeenCalled();
  });
});
