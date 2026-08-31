/**
 * Account health, held at arm's length.
 *
 * THE PROPERTY THIS FILE EXISTS FOR is the first `describe` below: a band is NEVER returned without
 * a named signal behind it. Everything else here is thresholds, and thresholds can be argued about;
 * that one cannot, because a score with no reason attached is a number an operator cannot act on,
 * and a number nobody acts on is a number nobody maintains. Within two months it is stale, then it
 * is wrong, then the screen carrying it is dead weight.
 *
 * `scoreAccountHealth` is pure, so every case here is a literal in and a literal out — no database,
 * no clock, no fixture setup. That is not a convenience; it is what makes a scoring rule auditable
 * at all. A rule nobody can interrogate is a rule that gets nudged to make one customer look better.
 */
import { describe, expect, it } from "vitest";
import { MIN_TREND_SNAPSHOTS, SEAT_PRESSURE, hasSeatCeiling, scoreAccountHealth, selectSeatOverage, type AccountHealthInput } from "../../src/services/platform-account-health.js";
import { UNLIMITED_SEATS } from "@timesheet/shared";

/** A workspace with nothing wrong with it. Every test below changes ONE thing. */
const HEALTHY: AccountHealthInput = {
  status: "ACTIVE",
  reachable: true,
  seatsUsed: 12,
  seatLimit: UNLIMITED_SEATS,
  aiSpendUsd: 10,
  aiBudgetCeilingUsd: 200,
  daysSinceLastActivity: 1,
  ticketsPerDayRecent: 4,
  ticketsPerDayPrior: 4,
  emailsSent: 200,
  emailsFailed: 1,
  backupFailures: 0,
  trialDaysRemaining: null,
  snapshots: 30
};

const score = (patch: Partial<AccountHealthInput> = {}) => scoreAccountHealth({ ...HEALTHY, ...patch });
const ids = (patch: Partial<AccountHealthInput> = {}) => score(patch).signals.map((signal) => signal.id);

describe("a band always arrives with its reason", () => {
  it("never returns an empty signal list, even for a workspace with nothing wrong", () => {
    const result = score();
    expect(result.band).toBe("HEALTHY");
    // THE INVARIANT. If this ever passes with `signals: []`, the whole feature has become the bare
    // score it was written not to be.
    expect(result.signals.length).toBeGreaterThan(0);
    expect(result.primarySignal).toBeDefined();
  });

  it("says what it CHECKED when nothing fired, rather than just 'ok'", () => {
    const result = score();
    expect(result.signals[0].id).toBe("steady");
    // "Nothing is wrong" and "we did not look" are different findings, and the difference has to be
    // legible without opening this file.
    expect(result.signals[0].detail).toMatch(/sign-ins are recent/i);
    expect(result.signals[0].detail).toMatch(/mail is delivering/i);
  });

  it("puts a NUMBER in every detail, because that is what makes a band actionable", () => {
    const result = score({ daysSinceLastActivity: 41 });
    expect(result.primarySignal.id).toBe("dormant");
    expect(result.primarySignal.detail).toContain("41");
    // The headline is ready to render: band, then the reason. Never a band alone.
    expect(result.headline).toBe("At risk — Nobody has signed in for 41 days.");
  });

  it("names the heaviest RISK as primary even when an expansion signal is also present", () => {
    // A workspace that is both dormant AND pressing its seat limit is a churn conversation, not an
    // upsell one. Sorting by weight alone would surface whichever happened to be declared first.
    const result = score({ daysSinceLastActivity: 41, seatLimit: 10, seatsUsed: 10 });
    expect(result.primarySignal.id).toBe("dormant");
    expect(result.signals.map((s) => s.id)).toContain("seats-full");
  });

  it("says why a short history produced no velocity signal, instead of staying silent about it", () => {
    const result = score({ snapshots: 2 });
    expect(result.signals[0].id).toBe("steady");
    expect(result.signals[0].detail).toMatch(/only 2 daily snapshots/i);
  });
});

describe("engagement", () => {
  it("calls a 30-day silence dormant and a 14-day one quiet", () => {
    expect(ids({ daysSinceLastActivity: 30 })).toContain("dormant");
    expect(ids({ daysSinceLastActivity: 20 })).toContain("quiet");
    expect(ids({ daysSinceLastActivity: 13 })).not.toContain("quiet");
  });

  it("treats 'never signed in' as its own finding, not as an infinitely old sign-in", () => {
    // A workspace provisioned and never adopted is a different conversation from one that went
    // quiet, and folding them together loses the only thing that would fix it.
    const result = score({ daysSinceLastActivity: null });
    expect(result.primarySignal.id).toBe("never-used");
    expect(result.band).toBe("AT_RISK");
  });

  it("refuses to read a velocity trend off too short a series", () => {
    const halved = { ticketsPerDayPrior: 10, ticketsPerDayRecent: 2 };
    expect(ids({ ...halved, snapshots: MIN_TREND_SNAPSHOTS - 1 })).not.toContain("velocity-down");
    expect(ids({ ...halved, snapshots: MIN_TREND_SNAPSHOTS })).toContain("velocity-down");
  });

  it("reads a doubling as expansion and a halving as risk", () => {
    expect(ids({ ticketsPerDayPrior: 2, ticketsPerDayRecent: 6 })).toContain("velocity-up");
    expect(ids({ ticketsPerDayPrior: 10, ticketsPerDayRecent: 2 })).toContain("velocity-down");
    // Noise is not a trend.
    expect(ids({ ticketsPerDayPrior: 10, ticketsPerDayRecent: 8 })).not.toContain("velocity-down");
  });

  it("does not divide by a zero prior rate", () => {
    const result = score({ ticketsPerDayPrior: 0, ticketsPerDayRecent: 5 });
    expect(result.signals.every((signal) => !signal.detail.includes("Infinity") && !signal.detail.includes("NaN"))).toBe(true);
    expect(Number.isFinite(result.score)).toBe(true);
  });
});

describe("commercial pressure is expansion, not illness", () => {
  it("marks a workspace near its seat ceiling as an expansion candidate without docking points", () => {
    const result = score({ seatLimit: 10, seatsUsed: 9 });
    expect(result.band).toBe("EXPANSION");
    expect(result.score).toBe(100);
    expect(result.primarySignal.id).toBe("seats-tight");
    expect(result.primarySignal.detail).toContain("9 of 10");
  });

  it("says plainly when a workspace cannot add anybody else", () => {
    const result = score({ seatLimit: 10, seatsUsed: 11 });
    expect(result.primarySignal.id).toBe("seats-full");
    expect(result.primarySignal.detail).toMatch(/cannot add anybody else/i);
  });

  it("does not apply seat pressure to an unlimited tier, where there is nothing to press against", () => {
    // TEAM and ENTERPRISE carry UNLIMITED_SEATS. A "0.001% of the ceiling" row would be arithmetic,
    // not information.
    expect(ids({ seatLimit: UNLIMITED_SEATS, seatsUsed: 4000 })).not.toContain("seats-tight");
    expect(hasSeatCeiling(UNLIMITED_SEATS)).toBe(false);
    expect(hasSeatCeiling(10)).toBe(true);
    expect(hasSeatCeiling(0)).toBe(false);
  });

  it("reads AI budget burn against the ceiling, and treats a zero ceiling as a real cap rather than a division", () => {
    expect(ids({ aiSpendUsd: 190, aiBudgetCeilingUsd: 200 })).toContain("ai-budget-tight");
    expect(ids({ aiSpendUsd: 220, aiBudgetCeilingUsd: 200 })).toContain("ai-budget-exhausted");
    // Starter's ceiling is 0, which is what makes AI unavailable there — not an unlimited budget.
    const starter = score({ aiSpendUsd: 0, aiBudgetCeilingUsd: 0 });
    expect(starter.signals.map((s) => s.id)).not.toContain("ai-budget-exhausted");
    expect(Number.isFinite(starter.score)).toBe(true);
  });
});

describe("delivery and lifecycle", () => {
  it("flags a failing mail relay only over a sample big enough to mean something", () => {
    expect(ids({ emailsSent: 3, emailsFailed: 3 })).not.toContain("mail-failing");
    expect(ids({ emailsSent: 80, emailsFailed: 20 })).toContain("mail-failing");
  });

  it("counts backup failures and says how many", () => {
    const result = score({ backupFailures: 3 });
    expect(result.signals.find((s) => s.id === "backups-failing")!.detail).toContain("3 managed backup runs have failed");
  });

  it("separates a trial that is ending from one that has lapsed", () => {
    expect(ids({ trialDaysRemaining: 4 })).toContain("trial-ending");
    expect(ids({ trialDaysRemaining: -12 })).toContain("trial-lapsed");
    expect(ids({ trialDaysRemaining: 40 })).not.toContain("trial-ending");
  });

  it("puts a suspended workspace at risk and says its usage figures are not signals", () => {
    const result = score({ status: "SUSPENDED" });
    expect(result.band).toBe("AT_RISK");
    expect(result.primarySignal.detail).toMatch(/Nobody there can sign in/);
  });

  it("says an unreachable workspace's figures are STALE rather than scoring them as real", () => {
    const result = score({ reachable: false });
    expect(result.signals.find((s) => s.id === "unreachable")!.detail).toMatch(/stale/i);
  });

  it("clamps the score to 0 rather than going negative when everything is wrong at once", () => {
    const result = score({ status: "SUSPENDED", reachable: false, daysSinceLastActivity: 90, emailsSent: 0, emailsFailed: 40, backupFailures: 5, trialDaysRemaining: -30 });
    expect(result.score).toBe(0);
    expect(result.band).toBe("AT_RISK");
    expect(result.signals.length).toBeGreaterThan(4);
  });
});

/* ------------------------------------------------------------------------------------------ */
/* Seat overage                                                                                */
/* ------------------------------------------------------------------------------------------ */

const seat = (slug: string, seatsUsed: number, seatLimit: number) => ({
  orgId: slug,
  slug,
  name: slug.toUpperCase(),
  planTier: "STARTER",
  status: "ACTIVE",
  seatsUsed,
  seatLimit
});

describe("selectSeatOverage", () => {
  const rows = [
    seat("at-90", 9, 10),
    seat("just-under", 8, 10),
    seat("over", 12, 10),
    seat("unlimited", 4000, UNLIMITED_SEATS),
    seat("no-ceiling", 3, 0)
  ];

  it("lists exactly the workspaces at or above the threshold, warmest first", () => {
    expect(selectSeatOverage(rows).map((row) => row.slug)).toEqual(["over", "at-90"]);
  });

  it("includes the boundary — 90% IS the threshold, not 'more than 90%'", () => {
    expect(selectSeatOverage([seat("exactly", 9, 10)])).toHaveLength(1);
    expect(SEAT_PRESSURE).toBe(0.9);
  });

  it("excludes unlimited tiers rather than showing them at 0%", () => {
    // The one list in the console that has to stay short enough to act on. A row for every TEAM
    // workspace at 0.4% utilisation is how that stops being true.
    expect(selectSeatOverage(rows).map((row) => row.slug)).not.toContain("unlimited");
    expect(selectSeatOverage(rows).map((row) => row.slug)).not.toContain("no-ceiling");
  });

  it("reports how many seats are left, negative when the workspace is already past its ceiling", () => {
    const over = selectSeatOverage(rows).find((row) => row.slug === "over")!;
    expect(over.seatsRemaining).toBe(-2);
    expect(over.utilisation).toBeCloseTo(1.2, 5);
  });

  it("honours a caller-supplied threshold", () => {
    expect(selectSeatOverage(rows, 0.75).map((row) => row.slug)).toEqual(["over", "at-90", "just-under"]);
  });

  it("uses the SAME threshold the health scorer marks seat pressure at", () => {
    // Two constants would drift, and the KPI tile would then disagree with the list it links to.
    const tight = scoreAccountHealth({ ...HEALTHY, seatLimit: 10, seatsUsed: Math.ceil(SEAT_PRESSURE * 10) });
    expect(tight.signals.map((s) => s.id)).toContain("seats-tight");
    expect(selectSeatOverage([seat("x", Math.ceil(SEAT_PRESSURE * 10), 10)])).toHaveLength(1);
  });
});
