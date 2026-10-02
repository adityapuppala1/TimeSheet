/**
 * Project burn, per currency (budget.service.ts#computeProjectBudgets).
 *
 * Burn is the sum of `Timesheet.billedAmount`, each frozen at approval in the currency the entry was
 * billed in (`billedCurrency`). It was summed across every billed currency and then labelled with
 * the BUDGET's currency — so a project budgeted in USD but billed in INR (budgetCurrency is a free
 * field in the project dialog), or a project whose billing currency changed mid-life, showed rupees
 * as dollars. burn %, the forecast, the alert and over-budget risk were all wrong by the exchange
 * rate, and so were the Portfolio roll-up, the BUDGET_BURN widget and the risk score that read them.
 *
 * The rule now: burn, burn %, the forecast and the risk flags come from burn in the budget's own
 * currency only. Burn in any other currency is reported beside it, never added in.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Project = { id: string; budgetAmount: number | null; budgetCurrency: string | null; billingCurrency: string | null; budgetAlertPct: number | null };
type Entry = { projectId: string; status: string; billable: boolean; deletedAt: Date | null; billedAmount: number | null; billedCurrency: string | null; totalHours: number };

const state = vi.hoisted(() => ({ projects: [] as Project[], entries: [] as Entry[] }));

function matches(e: Entry, where: Record<string, any>): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === "projectId") {
      if (!cond.in.includes(e.projectId)) return false;
    } else if (key === "status" || key === "billable" || key === "deletedAt" || key === "billedAmount") {
      if ((e as Record<string, unknown>)[key] !== cond) return false;
    } else {
      throw new Error(`the fake timesheet table does not understand \`${key}\``);
    }
  }
  return true;
}

vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    project: { findMany: vi.fn(async () => state.projects) },
    timesheet: {
      groupBy: vi.fn(async (args: any) => {
        const groups = new Map<string, any>();
        for (const e of state.entries.filter((x) => matches(x, args.where))) {
          const key = args.by.map((k: string) => String((e as Record<string, unknown>)[k])).join("|");
          const g = groups.get(key) ?? {
            ...Object.fromEntries(args.by.map((k: string) => [k, (e as Record<string, unknown>)[k]])),
            _sum: { billedAmount: null as number | null, totalHours: 0 }
          };
          g._sum.totalHours += e.totalHours;
          if (e.billedAmount != null) g._sum.billedAmount = (g._sum.billedAmount ?? 0) + e.billedAmount;
          groups.set(key, g);
        }
        return [...groups.values()];
      })
    },
    globalTicketSettings: { findUnique: vi.fn(async () => ({ defaultCurrency: "INR" })) },
    agentWorkEntry: { groupBy: vi.fn(async () => []) }
  }
}));

const { burnTotalsByCurrency, computeProjectBudgets } = await import("../../src/services/budget.service.js");

function entry(over: Partial<Entry>): Entry {
  return { projectId: "p1", status: "APPROVED", billable: true, deletedAt: null, billedAmount: null, billedCurrency: null, totalHours: 1, ...over };
}

beforeEach(() => {
  // Budgeted in dollars, billed mostly in rupees.
  state.projects = [{ id: "p1", budgetAmount: 1000, budgetCurrency: "USD", billingCurrency: "INR", budgetAlertPct: 80 }];
  state.entries = [
    entry({ billedAmount: 50, billedCurrency: "USD", totalHours: 2 }),
    entry({ billedAmount: 50_000, billedCurrency: "INR", totalHours: 10 })
  ];
});

const budgetOf = async (progressPct = 10) => (await computeProjectBudgets(["p1"], new Map([["p1", progressPct]]))).get("p1")!;

describe("burn against a budget", () => {
  it("counts only burn in the budget's currency, and reports other currencies beside it", async () => {
    const b = await budgetOf();
    expect(b.currency).toBe("USD");
    expect(b.burn).toBe(50);
    expect(b.otherCurrencyBurn).toEqual([{ currency: "INR", amount: 50_000 }]);
    // Hours are hours in any currency.
    expect(b.billableHours).toBe(12);
  });

  it("takes burn %, the forecast, the alert and over-budget risk from that currency alone", async () => {
    const b = await budgetOf(10);
    // $50 of $1,000. Adding the ₹50,000 would read 5005% and a forecast of $500,500.
    expect(b.burnPct).toBe(5);
    expect(b.forecastAtCompletion).toBe(500);
    expect(b.overBudgetRisk).toBe(false);
    expect(b.alerting).toBe(false);
  });

  it("prices an amount with no frozen currency in the project's billing currency", async () => {
    state.projects = [{ id: "p1", budgetAmount: 1000, budgetCurrency: null, billingCurrency: "USD", budgetAlertPct: null }];
    state.entries = [entry({ billedAmount: 100, billedCurrency: null }), entry({ billedAmount: 20, billedCurrency: "USD" })];
    const b = await budgetOf();
    expect(b.currency).toBe("USD");
    expect(b.burn).toBe(120);
    expect(b.otherCurrencyBurn).toEqual([]);
  });
});

describe("totals per currency", () => {
  it("puts burn billed in another currency outside every ratio, under its own currency", () => {
    const totals = burnTotalsByCurrency([
      { budget: 1000, burn: 50, currency: "USD", otherCurrencyBurn: [{ currency: "INR", amount: 50_000 }] },
      { budget: 10_000, burn: 5_000, currency: "INR", otherCurrencyBurn: [] }
    ]);
    expect(totals.find((t) => t.currency === "USD")).toMatchObject({ budget: 1000, burn: 50, burnPct: 5, unbudgetedBurn: 0 });
    // The INR budget's ratio is its own projects' INR burn only; the USD project's rupees are
    // reported as INR burn that no INR budget covers.
    expect(totals.find((t) => t.currency === "INR")).toMatchObject({ budget: 10_000, burn: 5_000, burnPct: 50, unbudgetedBurn: 50_000 });
  });
});
