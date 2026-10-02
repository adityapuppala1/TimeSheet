/**
 * The revenue arithmetic, on fixed fixtures.
 *
 * WHY THESE FUNCTIONS ARE PURE AND TESTED WITHOUT A DATABASE: every number here is one an operator
 * will quote to somebody. An MRR that is 12% wrong looks exactly like an MRR that is right, and no
 * amount of clicking around the console would reveal it — the only thing that can is a fixture whose
 * answer was worked out by hand. The database readers in the same service are thin by design so
 * that this is where the risk lives and this is where it is checked.
 *
 * THE FOUR MISTAKES THIS FILE EXISTS TO CATCH, each one silent in production:
 *   1. billing agent identities as seats — every roster-using customer's bill quietly inflated;
 *   2. summing an UNSET price as zero — a deployment's largest customers reported as worth nothing;
 *   3. dividing by an empty denominator — 0%, NaN or Infinity rendered as a confident figure;
 *   4. reporting churn off a one-day history — "0% churn" on the day the feature shipped.
 */
import { describe, expect, it, vi } from "vitest";

// The service imports the control client for its readers. The pure functions below never touch it,
// and the empty mock proves that: if one of them grew a query, this file would fail immediately.
vi.mock("../../src/config/control-prisma.js", () => ({ controlPrisma: {} }));
// The platform's zone, as config/env.ts defaults it: cohort months are India's.
vi.mock("../../src/config/env.js", () => ({ env: { TZ: "Asia/Kolkata" } }));

const {
  REVENUE_BASIS,
  accountMrrMinor,
  billableSeats,
  buildSignupCohorts,
  computeChurn,
  computeListMrr,
  computeTrialConversion,
  isFreeAccount,
  isPayingCustomer,
  isRevenueBearing,
  monthKey,
  ticketVelocity
} = await import("../../src/services/platform-revenue.service.js");

type Account = Parameters<typeof computeListMrr>[0][number];

/** The shipped prices: Starter free, Team $8/seat, Enterprise priced per contract. */
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

/* ------------------------------------------------------------------------------------------ */
/* MRR / ARR / ARPA                                                                            */
/* ------------------------------------------------------------------------------------------ */

describe("computeListMrr", () => {
  it("prices seats × tier, and states that it is list price", () => {
    // 10 seats × $8 + 4 seats × $8 = $112.00 = 11,200 minor units. Worked by hand.
    const mrr = computeListMrr([account("a"), account("b", { activeSeats: 4 })], PRICES);
    expect(mrr.mrrMinor).toBe(11_200);
    expect(mrr.arrMinor).toBe(134_400);
    expect(mrr.basis).toBe(REVENUE_BASIS);
    expect(REVENUE_BASIS).toBe("list-price");
  });

  it("NEVER bills an agent identity", () => {
    // THE ONE. An agent's identity is a real User row so assignment and audit keep working; it is
    // not a person, nobody signs in as it, and pricing it turns the roster into a per-agent upsell
    // by accident. 10 humans + 5 agents is still $80, not $120.
    const mrr = computeListMrr([account("a", { activeSeats: 10, agentSeats: 5 })], PRICES);
    expect(mrr.mrrMinor).toBe(8_000);
    expect(billableSeats({ activeSeats: 10, agentSeats: 5 })).toBe(10);
    expect(mrr.billableSeats).toBe(10);
  });

  it("EXCLUDES a tier with no list price rather than summing it as zero", () => {
    const mrr = computeListMrr([account("team"), account("ent", { planTier: "ENTERPRISE", activeSeats: 400 })], PRICES);
    // The Enterprise workspace contributes nothing AND is counted as an exclusion, so the console
    // can print "excludes 1 workspace" beside the total instead of quietly under-reporting.
    expect(mrr.mrrMinor).toBe(8_000);
    expect(mrr.unpricedAccounts).toBe(1);
    expect(mrr.unpricedSeats).toBe(400);
    expect(mrr.byTier.find((tier) => tier.tier === "ENTERPRISE")!.mrrMinor).toBeNull();
    expect(accountMrrMinor(account("ent", { planTier: "ENTERPRISE" }), PRICES)).toBeNull();
  });

  it("separates FREE from UNPRICED, because they are opposite facts", () => {
    const mrr = computeListMrr([account("free", { planTier: "STARTER", activeSeats: 5 }), account("ent", { planTier: "ENTERPRISE" }), account("paid")], PRICES);
    expect(mrr.freeAccounts).toBe(1);
    expect(mrr.unpricedAccounts).toBe(1);
    // Two paying LOGOS: the Team customer and the Enterprise contract. Free is never one of them.
    expect(mrr.payingAccounts).toBe(2);
    // Starter contributes a real, deliberate 0 to the total.
    expect(mrr.byTier.find((tier) => tier.tier === "STARTER")!.mrrMinor).toBe(0);
  });

  it("computes ARPA over PAYING accounts only, and returns null when there are none", () => {
    const paid = computeListMrr([account("a", { activeSeats: 10 }), account("b", { activeSeats: 5 })], PRICES);
    // $120 over two paying accounts.
    expect(paid.arpaMinor).toBe(6_000);

    const freeOnly = computeListMrr([account("f", { planTier: "STARTER" })], PRICES);
    // Not 0 — "our customers pay nothing" and "we have no paying customers" are different claims,
    // and a 0 here would be a division by zero rendered as a fact.
    expect(freeOnly.arpaMinor).toBeNull();
    expect(computeListMrr([], PRICES).arpaMinor).toBeNull();
  });

  it("counts a live trial as pipeline, not as revenue", () => {
    const mrr = computeListMrr([account("t", { trialing: true }), account("p")], PRICES);
    expect(mrr.mrrMinor).toBe(8_000);
    expect(mrr.trialingAccounts).toBe(1);
    expect(isRevenueBearing(account("t", { trialing: true }))).toBe(false);
  });

  it("counts nothing from a workspace that is not ACTIVE", () => {
    for (const status of ["GRACE", "SUSPENDED", "ARCHIVED", "PROVISIONING"]) {
      expect(computeListMrr([account("x", { status })], PRICES).mrrMinor).toBe(0);
    }
  });

  it("flags mixed currencies rather than silently adding unlike amounts", () => {
    expect(computeListMrr([account("a")], PRICES).mixedCurrencies).toBe(false);
    expect(computeListMrr([account("a")], { ...PRICES, STARTER: { perSeatMinor: 700, currency: "EUR" } }).mixedCurrencies).toBe(true);
  });

  it("treats a tier the price table has never heard of as unpriced, not as free", () => {
    const mrr = computeListMrr([account("x", { planTier: "PLATINUM" })], PRICES);
    expect(mrr.mrrMinor).toBe(0);
    expect(mrr.unpricedAccounts).toBe(1);
  });

  it("counts an Enterprise contract as a paying logo but keeps it out of ARPA's denominator", () => {
    // Paying logos: the Team workspace AND the Enterprise one — its list MRR is unknown, not zero.
    // ARPA divides the PRICED MRR by the priced paying accounts only, or it would be diluted by a
    // customer whose revenue it never added.
    const mrr = computeListMrr([account("team", { activeSeats: 10 }), account("ent", { planTier: "ENTERPRISE", activeSeats: 400 })], PRICES);
    expect(mrr.payingAccounts).toBe(2);
    expect(mrr.arpaMinor).toBe(8_000);
  });

  it("states how many workspaces were measured from a carried-forward reading", () => {
    const mrr = computeListMrr([account("a"), account("b", { unmeasured: true })], PRICES);
    expect(mrr.unmeasuredAccounts).toBe(1);
    // The carried-forward seats still price: an outage is not a downgrade.
    expect(mrr.mrrMinor).toBe(16_000);
  });
});

describe("isPayingCustomer and isFreeAccount — the two populations, defined once", () => {
  it("is a paying customer only when ACTIVE, past the trial, on a paid tier, with list MRR above zero", () => {
    expect(isPayingCustomer(account("p"), PRICES)).toBe(true);
    expect(isPayingCustomer(account("t", { trialing: true }), PRICES)).toBe(false);
    expect(isPayingCustomer(account("g", { status: "GRACE" }), PRICES)).toBe(false);
    expect(isPayingCustomer(account("f", { planTier: "STARTER" }), PRICES)).toBe(false);
    // A Team workspace with nobody left in it bills nothing.
    expect(isPayingCustomer(account("empty", { activeSeats: 0 }), PRICES)).toBe(false);
    // Priced per contract: MRR is unknown, which is not zero.
    expect(isPayingCustomer(account("ent", { planTier: "ENTERPRISE" }), PRICES)).toBe(true);
    // Never measured at all: the seat count is unknown, so whether it pays cannot be said.
    expect(isPayingCustomer(account("blind", { seatsKnown: false, activeSeats: 0 }), PRICES)).toBe(false);
  });

  it("is a free account when ACTIVE, past the trial and on a tier priced at zero", () => {
    expect(isFreeAccount(account("f", { planTier: "STARTER" }), PRICES)).toBe(true);
    expect(isFreeAccount(account("p"), PRICES)).toBe(false);
    expect(isFreeAccount(account("t", { planTier: "STARTER", trialing: true }), PRICES)).toBe(false);
  });
});

/* ------------------------------------------------------------------------------------------ */
/* Churn / NRR                                                                                 */
/* ------------------------------------------------------------------------------------------ */

describe("computeChurn", () => {
  const start = [account("keep", { activeSeats: 10 }), account("grow", { activeSeats: 10 }), account("shrink", { activeSeats: 10 }), account("leave", { activeSeats: 10 })];

  it("measures a hand-built window exactly", () => {
    const end = [
      account("keep", { activeSeats: 10 }), //   $80 →  $80
      account("grow", { activeSeats: 20 }), //   $80 → $160  (+$80 expansion)
      account("shrink", { activeSeats: 5 }), //  $80 →  $40  (−$40 contraction)
      account("leave", { status: "SUSPENDED" }), // gone
      account("new", { activeSeats: 10 }) //      arrived inside the window
    ];
    const churn = computeChurn(start, end, PRICES, 30);

    expect(churn.startAccounts).toBe(4);
    expect(churn.startMrrMinor).toBe(32_000); // 4 × $80
    expect(churn.churnedAccounts).toBe(1);
    expect(churn.churnedMrrMinor).toBe(8_000);
    expect(churn.expansionMinor).toBe(8_000);
    expect(churn.contractionMinor).toBe(4_000);
    // The start cohort is worth $80 + $160 + $40 = $280 at the end.
    expect(churn.retainedMrrMinor).toBe(28_000);
    expect(churn.logoChurnPercent).toBe(25);
    // (churned $80 + contraction $40) / $320
    expect(churn.revenueChurnPercent).toBe(37.5);
    expect(churn.netRevenueRetentionPercent).toBe(87.5);
    // GRR strips the expansion: ($320 − $80 − $40) / $320
    expect(churn.grossRevenueRetentionPercent).toBe(62.5);
    // A workspace that arrived inside the window is `new` and never joins the churn denominator —
    // otherwise a good month of signups flatters the rate.
    expect(churn.newAccounts).toBe(1);
  });

  it("can report NRR above 100% while gross retention is below it", () => {
    // The case one number alone hides: growing on existing customers while losing others.
    const churn = computeChurn(
      [account("big", { activeSeats: 10 }), account("small", { activeSeats: 10 })],
      [account("big", { activeSeats: 30 })],
      PRICES,
      30
    );
    expect(churn.netRevenueRetentionPercent).toBe(150);
    expect(churn.grossRevenueRetentionPercent).toBe(50);
  });

  it("returns null, not 0%, when the window has no span — the day-one case", () => {
    const churn = computeChurn(start, start, PRICES, 0);
    expect(churn.logoChurnPercent).toBeNull();
    expect(churn.revenueChurnPercent).toBeNull();
    expect(churn.netRevenueRetentionPercent).toBeNull();
    expect(churn.grossRevenueRetentionPercent).toBeNull();
    // "0% churn" on the first day of a feature is a claim; "not enough history" is the truth.
  });

  it("returns null rather than dividing by an empty starting cohort", () => {
    const churn = computeChurn([], [account("new")], PRICES, 30);
    expect(churn.logoChurnPercent).toBeNull();
    expect(churn.netRevenueRetentionPercent).toBeNull();
    expect(churn.newAccounts).toBe(1);
    for (const value of Object.values(churn)) {
      expect(Number.isNaN(value as number)).toBe(false);
    }
  });

  it("counts a workspace that fell out of ACTIVE as churned, not as merely changed", () => {
    const churn = computeChurn([account("x")], [account("x", { status: "GRACE" })], PRICES, 30);
    expect(churn.churnedAccounts).toBe(1);
    expect(churn.logoChurnPercent).toBe(100);
  });

  it("books a paying customer who cancels to free Starter as logo churn, not as contraction", () => {
    // `customer.subscription.deleted` moves the workspace to STARTER and leaves it ACTIVE. Stripe and
    // ChartMogul both call a downgrade to free a churned customer; booking it as contraction hid
    // every cancellation inside "shrinkage" and left the logo churn rate at 0%.
    const churn = computeChurn([account("x"), account("y")], [account("x", { planTier: "STARTER", subscribed: false }), account("y")], PRICES, 30);
    expect(churn.churnedAccounts).toBe(1);
    expect(churn.churnedMrrMinor).toBe(8_000);
    expect(churn.contractionMinor).toBe(0);
    expect(churn.logoChurnPercent).toBe(50);
  });

  it("keeps free Starter workspaces out of the churn denominator", () => {
    // Two free workspaces and one paying one: the churn rate is about the ONE customer.
    const start = [account("paid"), account("free1", { planTier: "STARTER" }), account("free2", { planTier: "STARTER" })];
    const end = [account("free1", { planTier: "STARTER" }), account("free2", { planTier: "STARTER" })];
    const churn = computeChurn(start, end, PRICES, 30);
    expect(churn.startAccounts).toBe(1);
    expect(churn.logoChurnPercent).toBe(100);
    expect(churn.endAccounts).toBe(0);
  });

  it("calls a free workspace that starts paying a new customer", () => {
    const churn = computeChurn([account("x", { planTier: "STARTER" })], [account("x")], PRICES, 30);
    expect(churn.newAccounts).toBe(1);
    expect(churn.startAccounts).toBe(0);
  });

  it("reads an unmeasured end as the carried-forward seats, flagged — never as contraction", () => {
    const churn = computeChurn([account("x", { activeSeats: 10 })], [account("x", { activeSeats: 10, unmeasured: true })], PRICES, 30);
    expect(churn.contractionMinor).toBe(0);
    expect(churn.netRevenueRetentionPercent).toBe(100);
    expect(churn.unmeasuredAccounts).toBe(1);
  });

  it("keeps a customer who moves UP to unpriced Enterprise as a retained logo, out of the revenue ratios", () => {
    // Two $400 Team customers; one signs an Enterprise contract. Its Team MRR is not lost — its new
    // MRR is unknown — so it leaves both sides of NRR/GRR rather than booking $400 of contraction.
    const start = [account("up", { activeSeats: 50 }), account("stay", { activeSeats: 50 })];
    const end = [account("up", { planTier: "ENTERPRISE", activeSeats: 60 }), account("stay", { activeSeats: 50 })];
    const churn = computeChurn(start, end, PRICES, 30);
    expect(churn.startAccounts).toBe(2);
    expect(churn.churnedAccounts).toBe(0);
    expect(churn.logoChurnPercent).toBe(0);
    expect(churn.startMrrMinor).toBe(40_000);
    expect(churn.retainedMrrMinor).toBe(40_000);
    expect(churn.contractionMinor).toBe(0);
    expect(churn.expansionMinor).toBe(0);
    expect(churn.netRevenueRetentionPercent).toBe(100);
    expect(churn.grossRevenueRetentionPercent).toBe(100);
  });

  it("does not book an Enterprise customer who moves to a priced tier as expansion out of nothing", () => {
    const start = [account("down", { planTier: "ENTERPRISE", activeSeats: 50 }), account("stay", { activeSeats: 50 })];
    const end = [account("down", { activeSeats: 50 }), account("stay", { activeSeats: 50 })];
    const churn = computeChurn(start, end, PRICES, 30);
    expect(churn.startAccounts).toBe(2);
    expect(churn.churnedAccounts).toBe(0);
    expect(churn.newAccounts).toBe(0);
    expect(churn.startMrrMinor).toBe(40_000);
    expect(churn.retainedMrrMinor).toBe(40_000);
    expect(churn.expansionMinor).toBe(0);
    expect(churn.netRevenueRetentionPercent).toBe(100);
  });

  it("still counts an Enterprise customer who stops paying as a churned logo", () => {
    const churn = computeChurn([account("ent", { planTier: "ENTERPRISE" }), account("t")], [account("ent", { planTier: "ENTERPRISE", status: "SUSPENDED" }), account("t")], PRICES, 30);
    expect(churn.churnedAccounts).toBe(1);
    expect(churn.logoChurnPercent).toBe(50);
    // Its revenue was never on either side, so the revenue ratios describe the priced customer alone.
    expect(churn.churnedMrrMinor).toBe(0);
    expect(churn.netRevenueRetentionPercent).toBe(100);
  });
});

/* ------------------------------------------------------------------------------------------ */
/* Trial → paid                                                                                */
/* ------------------------------------------------------------------------------------------ */

const NOW = new Date("2026-08-31T00:00:00Z");
const at = (iso: string) => new Date(iso);

describe("computeTrialConversion", () => {
  type Lifecycle = Parameters<typeof computeTrialConversion>[0][number];
  const trial = (orgId: string, startedIso: string, patch: Partial<Lifecycle> = {}): Lifecycle => {
    const started = at(startedIso);
    return { orgId, trialStartedAt: started, trialEndsAt: new Date(started.getTime() + 14 * 86_400_000), trialTier: "TEAM", planTier: "STARTER", stripeSubscriptionId: null, convertedAt: null, ...patch };
  };
  const lifecycles: Lifecycle[] = [
    // Converted through Stripe: the checkout cleared the trial fields and attached a subscription.
    trial("s", "2026-06-01T00:00:00Z", { trialEndsAt: null, trialTier: null, planTier: "TEAM", stripeSubscriptionId: "sub_1", convertedAt: at("2026-06-11T00:00:00Z") }),
    // Converted by hand in the console: clock and trial tier cleared, a paid plan, NO Stripe at all.
    trial("h", "2026-06-01T00:00:00Z", { trialEndsAt: null, trialTier: null, planTier: "TEAM", convertedAt: at("2026-06-21T00:00:00Z") }),
    // Lapsed: the clock ran out on Starter with the trial tier still set.
    trial("l", "2026-07-01T00:00:00Z"),
    // Still running.
    trial("r", "2026-08-25T00:00:00Z"),
    // Never on a trial at all — a hand-provisioned workspace, and not part of this question.
    { orgId: "n", trialStartedAt: null, trialEndsAt: null, trialTier: null, planTier: "TEAM", stripeSubscriptionId: null, convertedAt: null }
  ];

  it("classifies a hand-converted trial — clock and trial tier cleared, no Stripe — as converted, with its date", () => {
    const result = computeTrialConversion([trial("h", "2026-06-01T00:00:00Z", { trialEndsAt: null, trialTier: null, planTier: "TEAM", convertedAt: at("2026-06-08T00:00:00Z") })], NOW);
    expect(result.converted).toBe(1);
    expect(result.lapsed).toBe(0);
    expect(result.medianDaysToConvert).toBe(7);
  });

  it("does not call a trial converted because its workspace is still ACTIVE", () => {
    // The old rule: "ACTIVE after the trial ended" was a customer. A trial whose lapse has not been
    // processed yet is ACTIVE on Starter with its trial tier set — it has paid for nothing.
    const result = computeTrialConversion([trial("x", "2026-07-01T00:00:00Z")], NOW);
    expect(result.converted).toBe(0);
    expect(result.lapsed).toBe(1);
  });

  it("measures the headline over trials that STARTED inside the selected window", () => {
    // A 30-day window ending 31 Aug holds only the trial started on 25 Aug.
    const windowed = computeTrialConversion(lifecycles, NOW, 30);
    expect(windowed.trialsStarted).toBe(1);
    expect(windowed.stillTrialing).toBe(1);
    expect(windowed.windowDays).toBe(30);
  });

  it("cohorts trials by the month they STARTED, in India's calendar", () => {
    // 20:00 UTC on 30 June is 01:30 IST on 1 July.
    const result = computeTrialConversion([...lifecycles, trial("j", "2026-06-30T20:00:00Z", { trialEndsAt: null, trialTier: null, planTier: "TEAM", convertedAt: at("2026-07-05T00:00:00Z") })], NOW);
    expect(result.byCohort.map((row) => row.cohort)).toEqual(["2026-08", "2026-07", "2026-06"]);
    expect(result.byCohort.find((row) => row.cohort === "2026-06")).toMatchObject({ trialsStarted: 2, converted: 2, lapsed: 0, conversionPercent: 100, medianDaysToConvert: 15 });
    expect(result.byCohort.find((row) => row.cohort === "2026-07")).toMatchObject({ trialsStarted: 2, converted: 1, lapsed: 1, conversionPercent: 50 });
    expect(result.byCohort.find((row) => row.cohort === "2026-08")).toMatchObject({ trialsStarted: 1, stillTrialing: 1, conversionPercent: null });
  });

  it("states how many conversions have no recorded date instead of guessing one", () => {
    const undated = computeTrialConversion([trial("old", "2026-05-01T00:00:00Z", { trialEndsAt: null, trialTier: null, stripeSubscriptionId: "sub_9", planTier: "TEAM" })], NOW);
    expect(undated.converted).toBe(1);
    expect(undated.convertedUndated).toBe(1);
    expect(undated.medianDaysToConvert).toBeNull();
  });

  it("counts both routes to becoming a customer", () => {
    const result = computeTrialConversion(lifecycles, NOW);
    expect(result.trialsStarted).toBe(4);
    expect(result.converted).toBe(2);
    expect(result.lapsed).toBe(1);
    expect(result.stillTrialing).toBe(1);
  });

  it("measures conversion over DECIDED trials, so a running trial is not counted as a failure", () => {
    // 2 of 3 decided, not 2 of 4 — otherwise the rate swings on nothing but the calendar.
    expect(computeTrialConversion(lifecycles, NOW).conversionPercent).toBeCloseTo(66.7, 1);
  });

  it("uses a MEDIAN for time-to-convert, and skips conversions with no recorded date", () => {
    // 10 and 20 days → median 15.
    expect(computeTrialConversion(lifecycles, NOW).medianDaysToConvert).toBe(15);
    const undated = lifecycles.map((row) => ({ ...row, convertedAt: null }));
    expect(computeTrialConversion(undated, NOW).medianDaysToConvert).toBeNull();
  });

  it("returns null rather than 0% when nothing has been decided yet", () => {
    const running = [trial("r", "2026-08-25T00:00:00Z")];
    expect(computeTrialConversion(running, NOW).conversionPercent).toBeNull();
    expect(computeTrialConversion([], NOW).conversionPercent).toBeNull();
  });
});

/* ------------------------------------------------------------------------------------------ */
/* Cohorts                                                                                     */
/* ------------------------------------------------------------------------------------------ */

describe("buildSignupCohorts", () => {
  const orgs = [
    { orgId: "a", createdAt: at("2026-06-04T00:00:00Z"), activeMonths: new Set(["2026-06", "2026-07", "2026-08"]) },
    { orgId: "b", createdAt: at("2026-06-28T00:00:00Z"), activeMonths: new Set(["2026-06", "2026-07"]) },
    { orgId: "c", createdAt: at("2026-07-10T00:00:00Z"), activeMonths: new Set(["2026-07", "2026-08"]) }
  ];
  const observed = { from: "2026-06", to: "2026-08" };

  it("buckets by signup MONTH, newest cohort first", () => {
    const table = buildSignupCohorts(orgs, observed, 3);
    expect(table.rows.map((row) => row.cohort)).toEqual(["2026-07", "2026-06"]);
    expect(table.rows.find((row) => row.cohort === "2026-06")!.signedUp).toBe(2);
    // A snapshot `day` is a date-only value, so its month is read straight off it.
    expect(monthKey(at("2026-06-04T00:00:00Z"))).toBe("2026-06");
    expect(monthKey(at("2026-06-30T00:00:00Z"))).toBe("2026-06");
  });

  it("puts a workspace in the month it signed up in India, not UTC's", () => {
    // 20:00 UTC on 30 June is 01:30 IST on 1 July: a July customer, not a June one.
    const table = buildSignupCohorts([{ orgId: "late", createdAt: at("2026-06-30T20:00:00Z"), activeMonths: new Set(["2026-07"]) }], observed, 1);
    expect(table.rows.map((row) => row.cohort)).toEqual(["2026-07"]);
  });

  it("computes survival per offset month", () => {
    const june = buildSignupCohorts(orgs, observed, 3).rows.find((row) => row.cohort === "2026-06")!;
    expect(june.cells[0]).toMatchObject({ retained: 2, percent: 100 }); // both alive in June
    expect(june.cells[1]).toMatchObject({ retained: 2, percent: 100 }); // both alive in July
    expect(june.cells[2]).toMatchObject({ retained: 1, percent: 50 }); //  one alive in August
  });

  it("leaves a month with no snapshot NULL, never 0%", () => {
    // THE ONE THAT MATTERS on day one. Snapshots start the night this ships and cannot be
    // backfilled, so the months before are genuinely unknown. A 0% would draw a catastrophic churn
    // event that never happened, on the screen most likely to be shown to a decision-maker.
    const table = buildSignupCohorts(orgs, observed, 4);
    const june = table.rows.find((row) => row.cohort === "2026-06")!;
    expect(june.cells[3]).toMatchObject({ retained: null, percent: null }); // 2026-09, in the future
    // And an entirely unobserved series leaves every cell blank rather than reporting total loss.
    const blind = buildSignupCohorts(orgs, { from: null, to: null }, 2);
    expect(blind.rows.every((row) => row.cells.every((cell) => cell.percent === null))).toBe(true);
  });

  it("carries the observed range so the blanks can explain themselves", () => {
    const table = buildSignupCohorts(orgs, observed, 3);
    expect(table.observedFrom).toBe("2026-06");
    expect(table.observedTo).toBe("2026-08");
  });

  it("rolls the year over correctly when a cohort's window crosses December", () => {
    const dec = [{ orgId: "d", createdAt: at("2026-12-10T00:00:00Z"), activeMonths: new Set(["2027-01"]) }];
    const row = buildSignupCohorts(dec, { from: "2026-12", to: "2027-02" }, 2).rows[0];
    expect(row.cells[1]).toMatchObject({ retained: 1, percent: 100 }); // 2027-01
    expect(row.cells[0]).toMatchObject({ retained: 0, percent: 0 }); //  2026-12, observed and empty
  });

  it("renders no cohort at all rather than an empty grid when there are no workspaces", () => {
    expect(buildSignupCohorts([], observed, 3).rows).toEqual([]);
  });
});

/* ------------------------------------------------------------------------------------------ */
/* Ticket velocity                                                                             */
/* ------------------------------------------------------------------------------------------ */

describe("ticketVelocity", () => {
  const series = (totals: number[]) => totals.map((ticketsTotal, i) => ({ day: new Date(Date.UTC(2026, 7, i + 1)), ticketsTotal }));

  it("refuses to compare halves of too short a series", () => {
    expect(ticketVelocity(series([1, 2, 3]))).toEqual({ recent: null, prior: null });
  });

  it("reads the delta of a cumulative total as creation per day", () => {
    // 0..8 across 9 days: 4 created in each half, over 4 days each.
    const result = ticketVelocity(series([0, 1, 2, 3, 4, 5, 6, 7, 8]));
    expect(result.prior).toBeCloseTo(1, 5);
    expect(result.recent).toBeCloseTo(1, 5);
  });

  it("clamps a negative delta to zero rather than reporting negative creation", () => {
    // A restore from backup, or deletions. "−3 tickets created" is not a thing.
    const result = ticketVelocity(series([0, 10, 20, 30, 40, 5, 5, 5, 5]));
    expect(result.recent).toBe(0);
  });
});
