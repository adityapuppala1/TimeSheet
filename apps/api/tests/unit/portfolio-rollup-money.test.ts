/**
 * `GET /portfolios/rollup` — the Portfolio page's money and progress.
 *
 *   - H14: each plan item's project was found with `plan.raw.find` — O(tickets²) over every ticket.
 *   - H5: the page added budgets across currencies under the first row's symbol, and burn % counted
 *     burn from unbudgeted projects against budgeted projects' budgets.
 *   - M10: "logged hours" read APPROVED only; logged hours are submitted + approved everywhere else.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  plan: { items: [] as any[], raw: [] as any[] },
  budgets: new Map<string, any>(),
  loggedWhere: null as any
}));

const PROJECTS = [
  { id: "p1", code: "APL", name: "Apollo", color: null, status: "ACTIVE", portfolioId: "pf1", budgetAmount: 1000, budgetCurrency: "INR", budgetAlertPct: null, billingCurrency: "INR", plannedStartDate: null, plannedEndDate: null, portfolio: { id: "pf1", code: "CORE", name: "Core", color: null } },
  { id: "p2", code: "BET", name: "Beta", color: null, status: "ACTIVE", portfolioId: "pf1", budgetAmount: null, budgetCurrency: "INR", budgetAlertPct: null, billingCurrency: "INR", plannedStartDate: null, plannedEndDate: null, portfolio: { id: "pf1", code: "CORE", name: "Core", color: null } },
  { id: "p3", code: "GAM", name: "Gamma", color: null, status: "ACTIVE", portfolioId: "pf1", budgetAmount: 100, budgetCurrency: "USD", budgetAlertPct: null, billingCurrency: "USD", plannedStartDate: null, plannedEndDate: null, portfolio: { id: "pf1", code: "CORE", name: "Core", color: null } }
];

vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    project: { findMany: vi.fn(async () => PROJECTS) },
    ticket: { groupBy: vi.fn(async () => []) },
    timesheet: {
      groupBy: vi.fn(async (args: any) => {
        state.loggedWhere = args.where;
        return [{ projectId: "p1", _sum: { totalHours: 12 } }];
      })
    },
    portfolio: { findMany: vi.fn(async () => [{ id: "pf1", code: "CORE", name: "Core", color: null, status: "ACTIVE", owner: null }]) }
  }
}));
vi.mock("../../src/middleware/auth.js", () => ({
  requireAuth: (req: any, _res: unknown, next: () => void) => {
    req.user = { id: "u1", permissions: ["reports:view"] };
    next();
  },
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next()
}));
vi.mock("../../src/services/planning.service.js", () => ({ assertPlanningEnabled: vi.fn(async () => undefined) }));
vi.mock("../../src/services/ticket.service.js", () => ({ ticketProjectScope: vi.fn(async () => ({ unrestricted: true, projectIds: [] })) }));
vi.mock("../../src/services/plan-schedule.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/plan-schedule.service.js")>()),
  buildPlan: vi.fn(async () => state.plan)
}));
vi.mock("../../src/services/budget.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/budget.service.js")>()),
  computeProjectBudgets: vi.fn(async () => state.budgets)
}));

let request: typeof import("supertest").default;
let app: import("express").Express;

beforeAll(async () => {
  const express = (await import("express")).default;
  const { portfolioRouter } = await import("../../src/controllers/portfolio.controller.js");
  const { errorHandler } = await import("../../src/middleware/error.js");
  request = (await import("supertest")).default;
  app = express();
  app.use("/portfolios", portfolioRouter);
  app.use(errorHandler);
}, 60_000);

function money(projectId: string, budget: number | null, burn: number, currency: string) {
  return { projectId, budget, burn, currency, burnPct: budget ? Math.round((burn / budget) * 100) : null, forecastAtCompletion: null, overBudgetRisk: false, budgetAlertPct: null };
}

beforeEach(() => {
  const raw = [
    { id: "t1", projectId: "p1" },
    { id: "t2", projectId: "p3" }
  ];
  state.plan = {
    raw,
    items: [
      { id: "t1", estimatedHours: 2, effectiveProgressPct: 50, resolvedStart: new Date("2026-09-01"), resolvedEnd: new Date("2026-09-10"), slipDays: 0, isCritical: false, violations: [] },
      { id: "t2", estimatedHours: 2, effectiveProgressPct: 10, resolvedStart: new Date("2026-09-01"), resolvedEnd: new Date("2026-09-10"), slipDays: 0, isCritical: false, violations: [] }
    ]
  };
  state.budgets = new Map([
    ["p1", money("p1", 1000, 500, "INR")],
    ["p2", money("p2", null, 300, "INR")],
    ["p3", money("p3", 100, 80, "USD")]
  ]);
});

describe("GET /portfolios/rollup", () => {
  it("totals money per currency, over budgeted projects only", async () => {
    const res = await request(app).get("/portfolios/rollup").expect(200);
    expect(res.body.totals.money).toEqual([
      { currency: "INR", budget: 1000, burn: 500, burnPct: 50, budgetedProjects: 1, unbudgetedBurn: 300 },
      { currency: "USD", budget: 100, burn: 80, burnPct: 80, budgetedProjects: 1, unbudgetedBurn: 0 }
    ]);
  });

  it("gives a portfolio no single budget figure when its projects use two currencies", async () => {
    const res = await request(app).get("/portfolios/rollup").expect(200);
    const [pf] = res.body.portfolios;
    expect(pf.budget).toBeNull();
    expect(pf.burn).toBeNull();
    expect(pf.money.map((m: { currency: string }) => m.currency)).toEqual(["INR", "USD"]);
  });

  it("groups plan items by project from one map, never a search per item", async () => {
    const findSpy = vi.spyOn(state.plan.raw, "find");
    const res = await request(app).get("/portfolios/rollup").expect(200);
    expect(findSpy).not.toHaveBeenCalled();
    expect(res.body.projects.find((p: { id: string }) => p.id === "p1").itemCount).toBe(1);
    expect(res.body.projects.find((p: { id: string }) => p.id === "p1").progressPct).toBe(50);
  });

  it("reports a project's burn billed in another currency beside its burn, and in that currency's totals outside the ratio", async () => {
    state.budgets.set("p3", { ...money("p3", 100, 80, "USD"), otherCurrencyBurn: [{ currency: "INR", amount: 4000 }] });
    const res = await request(app).get("/portfolios/rollup").expect(200);
    const gamma = res.body.projects.find((p: { id: string }) => p.id === "p3");
    expect(gamma).toMatchObject({ burn: 80, burnPct: 80, otherCurrencyBurn: [{ currency: "INR", amount: 4000 }] });
    // INR burn % is still Apollo's ₹500 of ₹1,000; Gamma's rupees are INR burn no INR budget covers.
    expect(res.body.totals.money.find((m: { currency: string }) => m.currency === "INR")).toMatchObject({
      budget: 1000,
      burn: 500,
      burnPct: 50,
      unbudgetedBurn: 4300
    });
  });

  it("reports logged hours as submitted + approved", async () => {
    await request(app).get("/portfolios/rollup").expect(200);
    expect(state.loggedWhere.status).toEqual({ in: ["SUBMITTED", "APPROVED"] });
  });
});
