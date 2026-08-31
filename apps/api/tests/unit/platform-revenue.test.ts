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

const {
  REVENUE_BASIS,
  accountMrrMinor,
  billableSeats,
  buildSignupCohorts,
  computeChurn,
  computeListMrr,
  computeTrialConversion,
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
    expect(mrr.payingAccounts).toBe(1);
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
});

/* ------------------------------------------------------------------------------------------ */
/* Trial → paid                                                                                */
/* ------------------------------------------------------------------------------------------ */

const NOW = new Date("2026-08-31T00:00:00Z");
const at = (iso: string) => new Date(iso);

describe("computeTrialConversion", () => {
  const lifecycles = [
    // Converted through Stripe.
    { orgId: "s", trialStartedAt: at("2026-06-01T00:00:00Z"), trialEndsAt: at("2026-06-15T00:00:00Z"), status: "ACTIVE", subscribed: true, convertedAt: at("2026-06-11T00:00:00Z") },
    // Converted by hand: no Stripe anywhere in this deployment, still ACTIVE after the trial ended.
    { orgId: "h", trialStartedAt: at("2026-06-01T00:00:00Z"), trialEndsAt: at("2026-06-15T00:00:00Z"), status: "ACTIVE", subscribed: false, convertedAt: at("2026-06-21T00:00:00Z") },
    // Lapsed.
    { orgId: "l", trialStartedAt: at("2026-07-01T00:00:00Z"), trialEndsAt: at("2026-07-15T00:00:00Z"), status: "SUSPENDED", subscribed: false, convertedAt: null },
    // Still running.
    { orgId: "r", trialStartedAt: at("2026-08-25T00:00:00Z"), trialEndsAt: at("2026-09-08T00:00:00Z"), status: "ACTIVE", subscribed: false, convertedAt: null },
    // Never on a trial at all — a hand-provisioned workspace, and not part of this question.
    { orgId: "n", trialStartedAt: null, trialEndsAt: null, status: "ACTIVE", subscribed: false, convertedAt: null }
  ];

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
    const running = [{ orgId: "r", trialStartedAt: at("2026-08-25T00:00:00Z"), trialEndsAt: at("2026-09-08T00:00:00Z"), status: "ACTIVE", subscribed: false, convertedAt: null }];
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

  it("buckets by signup MONTH, in UTC, newest cohort first", () => {
    const table = buildSignupCohorts(orgs, observed, 3);
    expect(table.rows.map((row) => row.cohort)).toEqual(["2026-07", "2026-06"]);
    expect(table.rows.find((row) => row.cohort === "2026-06")!.signedUp).toBe(2);
    // Both June workspaces land in the same bucket regardless of the day of the month.
    expect(monthKey(at("2026-06-04T00:00:00Z"))).toBe("2026-06");
    expect(monthKey(at("2026-06-30T23:59:59Z"))).toBe("2026-06");
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
