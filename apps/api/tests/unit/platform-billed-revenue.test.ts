/**
 * Billed revenue: the arithmetic, the population, and the sweep.
 *
 * WHY THIS FILE IS SEPARATE FROM `platform-revenue.test.ts`. That one pins the LIST-price
 * arithmetic — the numbers the console has always shown. This one pins the second number, which is
 * a different kind of risk: it is fetched from an outside system, it is normalised before it is
 * stored, and it is subtracted from the first. Each of those steps has its own way of being
 * silently wrong.
 *
 * THE FIVE MISTAKES THIS FILE EXISTS TO CATCH, every one of them plausible on the screen:
 *   1. COUNTING AN ANNUAL SUBSCRIPTION TWELVE TIMES. `interval: "year"` carries a whole year's
 *      money. Stored as MRR without dividing, one annual customer inflates the fleet's billed
 *      revenue by eleven months of itself — and looks completely normal doing it.
 *   2. FOLDING A FAILED RECONCILIATION IN AS ZERO. A workspace Stripe could not answer for, counted
 *      at £0 against a real list price, is reported as a 100% discount. A Stripe outage would read
 *      as the entire customer base going free.
 *   3. CONFUSING "NOT RECONCILED YET" WITH "NO GAP". Both would render as $0 if the code let them.
 *      They are opposite sentences.
 *   4. COMPARING UNLIKE POPULATIONS. The fleet's whole list MRR against only-subscribed billed
 *      revenue invents a discount out of every customer who never had a Stripe subscription. So
 *      does pairing an Enterprise workspace's absent list price with its real billed amount.
 *   5. LETTING ONE WORKSPACE ABORT THE SWEEP. Ninety-nine good figures lost to one expired card.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/* --------------------------------- the fake control plane -------------------------------- */

interface OrgRow {
  id: string;
  slug: string;
  name?: string;
  stripeSubscriptionId?: string | null;
  billedMrrMinor?: number | null;
  billedCurrency?: string | null;
  billedReconciledAt?: Date | null;
  billedReconcileError?: string | null;
  [key: string]: unknown;
}

let orgRows: OrgRow[] = [];
const updates: Array<{ id: string; data: Record<string, unknown> }> = [];

const control = {
  organization: {
    findMany: vi.fn(async () => orgRows.map((row) => ({ ...row }))),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      updates.push({ id: where.id, data });
      const row = orgRows.find((entry) => entry.id === where.id);
      if (row) Object.assign(row, data);
      return { ...row };
    })
  }
};
vi.mock("../../src/config/control-prisma.js", () => ({ controlPrisma: control }));

/* The Stripe client itself is never built here. `resolveStripeClient` is the seam, exactly as it is
   in production, so these tests exercise the same branch a deployment with no Stripe key takes. */
let subscriptions: Record<string, unknown> = {};
let retrieveFails: Record<string, string> = {};
let stripeConfigured = true;

const retrieve = vi.fn(async (id: string) => {
  if (retrieveFails[id]) throw new Error(retrieveFails[id]);
  const found = subscriptions[id];
  if (!found) throw new Error(`No such subscription: ${id}`);
  return found;
});

vi.mock("../../src/services/stripe-client.service.js", () => ({
  DEAD_SUBSCRIPTION_STATUSES: new Set(["canceled", "incomplete_expired"]),
  resolveStripeClient: vi.fn(async () => (stripeConfigured ? { stripe: { subscriptions: { retrieve } }, settings: {} } : null)),
  isStripeConfigured: vi.fn(async () => stripeConfigured),
  requireStripeClient: vi.fn()
}));

const { monthsInBillingPeriod, reconcileBilledRevenue, subscriptionMonthlyMinor } = await import("../../src/services/platform-billing-reconcile.service.js");
const { computeBilledReconciliation, computeListMrr } = await import("../../src/services/platform-revenue.service.js");

type Account = Parameters<typeof computeListMrr>[0][number];

/** The shipped prices: Starter free, Team $8/seat/month, Enterprise priced per contract. */
const PRICES = {
  STARTER: { perSeatMinor: 0, currency: "USD" },
  TEAM: { perSeatMinor: 800, currency: "USD" },
  ENTERPRISE: { perSeatMinor: null, currency: "USD" }
};

const account = (id: string, patch: Partial<Account> = {}): Account => ({
  orgId: id,
  slug: id,
  name: id.toUpperCase(),
  planTier: "TEAM",
  status: "ACTIVE",
  activeSeats: 10,
  agentSeats: 0,
  trialing: false,
  subscribed: true,
  ...patch
});

type BilledRow = Parameters<typeof computeBilledReconciliation>[0][number];

const billedRow = (id: string, patch: Partial<BilledRow> = {}): BilledRow => ({
  orgId: id,
  slug: id,
  name: id.toUpperCase(),
  billedMrrMinor: 8000,
  billedCurrency: "USD",
  billedReconciledAt: new Date("2026-08-31T03:50:00.000Z"),
  billedReconcileError: null,
  ...patch
});

/** The whole comparison, computed the way the service does — list half through the same function
 *  the page's MRR tile uses, so a fixture cannot accidentally test two different list prices. */
const reconcile = (billed: BilledRow[], accounts: Account[]) => computeBilledReconciliation(billed, accounts, PRICES, computeListMrr(accounts, PRICES));

beforeEach(() => {
  orgRows = [];
  updates.length = 0;
  subscriptions = {};
  retrieveFails = {};
  stripeConfigured = true;
  retrieve.mockClear();
});

/* ------------------------------------------------------------------------------------------ */
/* Normalising an interval — the mistake most likely to be silently wrong                       */
/* ------------------------------------------------------------------------------------------ */

describe("monthsInBillingPeriod", () => {
  it("treats a monthly price as one month", () => {
    expect(monthsInBillingPeriod({ interval: "month" })).toBe(1);
    expect(monthsInBillingPeriod({ interval: "month", interval_count: 1 })).toBe(1);
  });

  it("treats an ANNUAL price as twelve months — the whole point of the function", () => {
    expect(monthsInBillingPeriod({ interval: "year" })).toBe(12);
  });

  it("multiplies by interval_count, so quarterly is three months and biennial is twenty-four", () => {
    expect(monthsInBillingPeriod({ interval: "month", interval_count: 3 })).toBe(3);
    expect(monthsInBillingPeriod({ interval: "year", interval_count: 2 })).toBe(24);
  });

  it("refuses an interval it does not know rather than guessing 'probably monthly'", () => {
    // A guess here is silently wrong money, which is the one failure mode this whole file is about.
    expect(monthsInBillingPeriod({ interval: "fortnight" })).toBeNull();
    expect(monthsInBillingPeriod(null)).toBeNull();
    expect(monthsInBillingPeriod({ interval: "month", interval_count: 0 })).toBeNull();
  });
});

describe("subscriptionMonthlyMinor", () => {
  const sub = (items: Array<{ unit_amount: number | null; interval: string; interval_count?: number; quantity?: number; currency?: string }>) => ({
    id: "sub_1",
    status: "active",
    items: {
      data: items.map((item) => ({
        quantity: item.quantity ?? 1,
        price: {
          unit_amount: item.unit_amount,
          currency: item.currency ?? "usd",
          recurring: { interval: item.interval, interval_count: item.interval_count ?? 1 }
        }
      }))
    }
  });

  it("takes a MONTHLY subscription as it stands", () => {
    // $8/seat × 10 seats = $80.00 a month.
    expect(subscriptionMonthlyMinor(sub([{ unit_amount: 800, interval: "month", quantity: 10 }]))).toEqual({ amountMinor: 8000, currency: "USD" });
  });

  it("NORMALISES AN ANNUAL SUBSCRIPTION TO A MONTHLY FIGURE", () => {
    // $80/seat/YEAR × 10 seats = $800 a year = $66.67 a month. Reported at its full annual amount
    // this workspace would look like $800 of MRR — twelve times the truth, and entirely plausible.
    expect(subscriptionMonthlyMinor(sub([{ unit_amount: 8000, interval: "year", quantity: 10 }]))).toEqual({ amountMinor: 6667, currency: "USD" });
  });

  it("normalises quarterly, weekly and daily too, through the same divisor", () => {
    // $300 every 3 months → $100 a month.
    expect(subscriptionMonthlyMinor(sub([{ unit_amount: 30000, interval: "month", interval_count: 3 }])).amountMinor).toBe(10000);
    // $10 a week → roughly $43.45 a month on a 365-day year.
    expect(subscriptionMonthlyMinor(sub([{ unit_amount: 1000, interval: "week" }])).amountMinor).toBe(4345);
    // $1 a day → roughly $30.42 a month.
    expect(subscriptionMonthlyMinor(sub([{ unit_amount: 100, interval: "day" }])).amountMinor).toBe(3042);
  });

  it("sums several lines and rounds ONCE, so the error cannot accumulate", () => {
    // Two annual lines, each $1.00/year: exactly 8.333… cents a month apiece. Rounded per line that
    // is 8 + 8 = 16; rounded once it is 17, which is the honest answer.
    expect(subscriptionMonthlyMinor(sub([{ unit_amount: 100, interval: "year" }, { unit_amount: 100, interval: "year" }])).amountMinor).toBe(17);
  });

  it("treats a null quantity as one seat, never as zero", () => {
    // Zero would report a paying customer as free — a discount of 100% invented out of a default.
    const subscription = { id: "s", status: "active", items: { data: [{ quantity: null, price: { unit_amount: 800, currency: "usd", recurring: { interval: "month" } } }] } };
    expect(subscriptionMonthlyMinor(subscription).amountMinor).toBe(800);
  });

  it("refuses a tiered or metered price rather than pricing it at nothing", () => {
    expect(() => subscriptionMonthlyMinor(sub([{ unit_amount: null, interval: "month" }]))).toThrow(/no fixed unit amount/i);
  });

  it("refuses a subscription with no lines, and one that mixes currencies", () => {
    expect(() => subscriptionMonthlyMinor({ id: "s", status: "active", items: { data: [] } })).toThrow(/no line items/i);
    expect(() => subscriptionMonthlyMinor(sub([{ unit_amount: 800, interval: "month" }, { unit_amount: 700, interval: "month", currency: "eur" }]))).toThrow(/mixes currencies/i);
  });
});

/* ------------------------------------------------------------------------------------------ */
/* The comparison — which is really a question about POPULATION                                 */
/* ------------------------------------------------------------------------------------------ */

describe("computeBilledReconciliation", () => {
  it("reports the gap as list minus billed", () => {
    // Team at $8 × 10 seats = $80.00 list. Stripe bills $60.00. The gap is $20.00 of discounting.
    const result = reconcile([billedRow("a", { billedMrrMinor: 6000 })], [account("a")]);
    expect(result.comparableListMrrMinor).toBe(8000);
    expect(result.billedMrrMinor).toBe(6000);
    expect(result.discountMinor).toBe(2000);
    expect(result.discountPercent).toBe(25);
    expect(result.comparedAccounts).toBe(1);
  });

  it("shows a NEGATIVE gap rather than clamping it — billed above list is a real state", () => {
    // A legacy price, or an amount edited by hand in the Stripe dashboard. Clamping to zero would
    // hide the only evidence that the two disagree.
    const result = reconcile([billedRow("a", { billedMrrMinor: 9000 })], [account("a")]);
    expect(result.discountMinor).toBe(-1000);
    expect(result.discountPercent).toBe(-12.5);
  });

  it("distinguishes NOT RECONCILED YET from NO GAP", () => {
    const never = reconcile([billedRow("a", { billedMrrMinor: null, billedReconciledAt: null })], [account("a")]);
    // Null, not zero. The console renders "not reconciled yet"; a 0 would render as "everybody pays
    // list price", which is a claim nobody has earned.
    expect(never.billedMrrMinor).toBeNull();
    expect(never.discountMinor).toBeNull();
    expect(never.comparableListMrrMinor).toBeNull();
    expect(never.excluded.neverReconciled).toBe(1);
    expect(never.lastReconciledAt).toBeNull();
    expect(never.note).toMatch(/not a gap of zero/i);

    // The other sentence: reconciled, and the answer genuinely is that nobody is discounted.
    const noGap = reconcile([billedRow("a", { billedMrrMinor: 8000 })], [account("a")]);
    expect(noGap.billedMrrMinor).toBe(8000);
    expect(noGap.discountMinor).toBe(0);
    expect(noGap.lastReconciledAt).toBe("2026-08-31T03:50:00.000Z");
  });

  it("NAMES a failed reconciliation and excludes it, rather than folding it in as zero", () => {
    const result = reconcile(
      [billedRow("a", { billedMrrMinor: 6000 }), billedRow("b", { billedReconcileError: "Stripe timed out." })],
      [account("a"), account("b")]
    );
    // The good workspace alone. If `b` were counted at 0 against its $80 list, the gap would read
    // $100 of 60% discounting — an outage reported as a commercial fact.
    expect(result.comparedAccounts).toBe(1);
    expect(result.comparableListMrrMinor).toBe(8000);
    expect(result.billedMrrMinor).toBe(6000);
    expect(result.discountMinor).toBe(2000);
    expect(result.excluded.failed).toBe(1);
    expect(result.failures).toEqual([{ orgId: "b", slug: "b", name: "B", message: "Stripe timed out." }]);
    expect(result.note).toMatch(/named below rather than counted as zero/i);
  });

  it("contributes NOTHING for a workspace with no subscription — not a zero", () => {
    // `billed` only ever holds workspaces carrying a `stripeSubscriptionId`. The rest of the fleet
    // is in `accounts` and must not reach either side of the subtraction, or every hand-tiered
    // customer would be reported as billed nothing.
    const result = reconcile([billedRow("a", { billedMrrMinor: 8000 })], [account("a"), account("b"), account("c")]);
    expect(result.subscribedAccounts).toBe(1);
    expect(result.comparedAccounts).toBe(1);
    expect(result.comparableListMrrMinor).toBe(8000);
    expect(result.discountMinor).toBe(0);
    // The fleet total is carried for context and is three workspaces' worth — deliberately NOT the
    // number the gap is taken from.
    expect(result.listMrrMinor).toBe(24000);
  });

  it("excludes an unpriced tier, because there is nothing to discount from", () => {
    const result = reconcile([billedRow("ent", { billedMrrMinor: 50000 })], [account("ent", { planTier: "ENTERPRISE" })]);
    expect(result.excluded.unpriced).toBe(1);
    expect(result.comparedAccounts).toBe(0);
    // Not "100% discount" and not "$500 of extra revenue" — simply not comparable, and said so.
    expect(result.discountMinor).toBeNull();
    expect(result.note).toMatch(/no list price/i);
  });

  it("excludes a workspace that is not revenue-bearing right now", () => {
    // A trialling or suspended workspace has a list value of zero. Pairing that with a real billed
    // amount would report negative discounting out of nothing but lifecycle state.
    const result = reconcile(
      [billedRow("t", { billedMrrMinor: 8000 }), billedRow("s", { billedMrrMinor: 8000 })],
      [account("t", { trialing: true }), account("s", { status: "SUSPENDED" })]
    );
    expect(result.excluded.notRevenueBearing).toBe(2);
    expect(result.discountMinor).toBeNull();
  });

  it("excludes a subscribed workspace that has no usage snapshot yet", () => {
    const result = reconcile([billedRow("ghost", { billedMrrMinor: 8000 })], []);
    expect(result.excluded.notRevenueBearing).toBe(1);
    expect(result.billedMrrMinor).toBeNull();
  });

  it("flags mixed currencies instead of quietly subtracting euros from dollars", () => {
    const result = reconcile([billedRow("a", { billedMrrMinor: 6000, billedCurrency: "EUR" })], [account("a")]);
    expect(result.mixedCurrencies).toBe(true);
  });

  it("says plainly when there is nothing to reconcile at all", () => {
    const result = reconcile([], [account("a")]);
    expect(result.subscribedAccounts).toBe(0);
    expect(result.billedMrrMinor).toBeNull();
    expect(result.note).toMatch(/nothing to reconcile/i);
  });
});

/* ------------------------------------------------------------------------------------------ */
/* The sweep                                                                                    */
/* ------------------------------------------------------------------------------------------ */

describe("reconcileBilledRevenue", () => {
  it("does nothing, loudly enough to be readable, when Stripe is not configured", async () => {
    stripeConfigured = false;
    const result = await reconcileBilledRevenue();
    // `configured: false` and not "0 reconciled": most installations have no Stripe account, and
    // the worker stays silent for them rather than logging a nightly non-event.
    expect(result).toMatchObject({ configured: false, attempted: 0, reconciled: 0, failed: [] });
    expect(control.organization.findMany).not.toHaveBeenCalled();
  });

  it("stores an ANNUAL subscription as a monthly figure, end to end", async () => {
    orgRows = [{ id: "a", slug: "acme", stripeSubscriptionId: "sub_year" }];
    subscriptions.sub_year = {
      id: "sub_year",
      status: "active",
      items: { data: [{ quantity: 10, price: { unit_amount: 8000, currency: "usd", recurring: { interval: "year", interval_count: 1 } } }] }
    };

    const result = await reconcileBilledRevenue();
    expect(result).toMatchObject({ configured: true, attempted: 1, reconciled: 1, failed: [] });
    expect(updates[0].data).toMatchObject({ billedMrrMinor: 6667, billedCurrency: "USD", billedSubscriptionId: "sub_year", billedReconcileError: null });
  });

  it("keeps going when one workspace fails, and records WHY against that workspace only", async () => {
    orgRows = [
      { id: "a", slug: "acme", stripeSubscriptionId: "sub_ok" },
      { id: "b", slug: "beta", stripeSubscriptionId: "sub_bad" },
      { id: "c", slug: "gamma", stripeSubscriptionId: "sub_ok2" }
    ];
    subscriptions.sub_ok = { id: "sub_ok", status: "active", items: { data: [{ quantity: 1, price: { unit_amount: 800, currency: "usd", recurring: { interval: "month" } } }] } };
    subscriptions.sub_ok2 = { id: "sub_ok2", status: "active", items: { data: [{ quantity: 2, price: { unit_amount: 800, currency: "usd", recurring: { interval: "month" } } }] } };
    retrieveFails.sub_bad = "Stripe rate limit exceeded";

    const result = await reconcileBilledRevenue();
    // The other two still have their figures. That is the whole reason the try sits inside the loop.
    expect(result.reconciled).toBe(2);
    expect(result.failed).toEqual([{ orgId: "b", slug: "beta", message: "Stripe rate limit exceeded" }]);
    const failedUpdate = updates.find((entry) => entry.id === "b")!;
    expect(failedUpdate.data.billedReconcileError).toBe("Stripe rate limit exceeded");
    // The AMOUNT is untouched: a previously good figure stays readable with its own older
    // `billedReconciledAt`, rather than being wiped because tonight's attempt failed.
    expect(failedUpdate.data).not.toHaveProperty("billedMrrMinor");
    expect(failedUpdate.data).toHaveProperty("billedReconcileAttemptedAt");
  });

  it("refuses to record a CANCELLED subscription as zero", async () => {
    // Zero here would be read as a 100% discount on a workspace that is still on a paid tier. The
    // real problem is a stale `stripeSubscriptionId`, and naming it is what surfaces that.
    orgRows = [{ id: "a", slug: "acme", stripeSubscriptionId: "sub_dead" }];
    subscriptions.sub_dead = { id: "sub_dead", status: "canceled", items: { data: [] } };

    const result = await reconcileBilledRevenue();
    expect(result.reconciled).toBe(0);
    expect(result.failed[0].message).toMatch(/canceled/i);
    expect(updates[0].data).not.toHaveProperty("billedMrrMinor");
  });

  it("never asks Stripe about a workspace with no subscription", async () => {
    // The query filters them out; this pins that it stays that way, because a sweep that retrieved
    // `null` would spend an API call per hand-tiered customer to learn nothing.
    orgRows = [{ id: "a", slug: "acme", stripeSubscriptionId: "sub_ok" }];
    subscriptions.sub_ok = { id: "sub_ok", status: "active", items: { data: [{ quantity: 1, price: { unit_amount: 800, currency: "usd", recurring: { interval: "month" } } }] } };
    await reconcileBilledRevenue();
    expect(control.organization.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { stripeSubscriptionId: { not: null } } }));
    expect(retrieve).toHaveBeenCalledTimes(1);
  });
});
