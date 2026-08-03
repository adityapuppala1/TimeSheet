/**
 * Pins the risk scoring rule.
 *
 * WHY THIS MATTERS MORE THAN A TYPICAL TEST: a project going red is a number somebody will be
 * asked to defend in a meeting. If the score is not reproducible, or a weight quietly changes,
 * the answer to "what would have to change for this to go green?" stops being answerable. These
 * tests are the record of what the score MEANS, not just that it runs.
 *
 * A failure here is not necessarily a bug — it may mean someone deliberately changed what the
 * product considers risky. The question to answer is whether that change was intended and whether
 * the docs and any customer-facing claims agree.
 */
import { describe, expect, it } from "vitest";
import { assessRisk, bandFor, RISK_WEIGHTS, type RiskInputs } from "../../src/services/project-risk.service.js";

const clean = (over: Partial<RiskInputs> = {}): RiskInputs => ({
  projectId: "p1",
  worstSlipDays: 0,
  slippedItemCount: 0,
  overrunsPlannedEnd: false,
  plannedEndOverrunDays: 0,
  budget: 100_000,
  burn: 20_000,
  forecastAtCompletion: 90_000,
  blockedCount: 0,
  openCount: 20,
  violationCount: 0,
  overAllocatedPeople: 0,
  teamSize: 5,
  slaBreachCount: 0,
  reopenedCount: 0,
  resolvedCount: 40,
  progressPct: 40,
  ...over
});

const signal = (result: ReturnType<typeof assessRisk>, key: string) => result.signals.find((s) => s.key === key)!;

describe("risk weights", () => {
  it("sum to 100, so the score reads as a percentage of everything that could be wrong", () => {
    expect(Object.values(RISK_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("rank schedule slip highest — it is the earliest honest warning", () => {
    expect(RISK_WEIGHTS.scheduleSlip).toBeGreaterThan(RISK_WEIGHTS.budgetOverrun);
    expect(RISK_WEIGHTS.budgetOverrun).toBeGreaterThan(RISK_WEIGHTS.reopenRate);
  });
});

describe("bands", () => {
  it("are thresholds on the score, stated once", () => {
    expect(bandFor(0)).toBe("GREEN");
    expect(bandFor(24)).toBe("GREEN");
    expect(bandFor(25)).toBe("AMBER");
    expect(bandFor(54)).toBe("AMBER");
    expect(bandFor(55)).toBe("RED");
    expect(bandFor(100)).toBe("RED");
  });
});

describe("a healthy project", () => {
  it("scores zero and reports no concerns", () => {
    const result = assessRisk(clean());
    expect(result.riskScore).toBe(0);
    expect(result.band).toBe("GREEN");
    expect(result.topConcerns).toHaveLength(0);
    // Every signal is still present, with zero points — "why is this green?" is as answerable as
    // "why is this red?".
    expect(result.signals).toHaveLength(6);
  });
});

describe("schedule slip", () => {
  it("scales with the worst slip, capped at its weight", () => {
    const mild = assessRisk(clean({ worstSlipDays: 3, slippedItemCount: 1 }));
    const bad = assessRisk(clean({ worstSlipDays: 15, slippedItemCount: 8 }));
    const absurd = assessRisk(clean({ worstSlipDays: 400, slippedItemCount: 50 }));

    expect(signal(mild, "scheduleSlip").points).toBeGreaterThan(0);
    expect(signal(bad, "scheduleSlip").points).toBe(RISK_WEIGHTS.scheduleSlip);
    // No single signal may exceed its weight, however extreme the input — otherwise one bad
    // number drowns out the other five.
    expect(signal(absurd, "scheduleSlip").points).toBe(RISK_WEIGHTS.scheduleSlip);
  });

  it("counts running past the planned end date even with no baseline slip", () => {
    // A project whose items were never baselined can still be visibly late against the date it
    // was sold on, and that has to register.
    const result = assessRisk(clean({ overrunsPlannedEnd: true, plannedEndOverrunDays: 10 }));
    expect(signal(result, "scheduleSlip").points).toBeGreaterThan(0);
    expect(signal(result, "scheduleSlip").note).toMatch(/past the planned end date/i);
  });
});

describe("budget", () => {
  it("measures the FORECAST against the budget, not the spend so far", () => {
    // Spend lags work, so "only 20% spent" at 20% progress says nothing. Under-budget forecast
    // must score zero however much has been spent.
    const onTrack = assessRisk(clean({ burn: 80_000, forecastAtCompletion: 95_000 }));
    expect(signal(onTrack, "budgetOverrun").points).toBe(0);

    const over = assessRisk(clean({ forecastAtCompletion: 150_000 }));
    expect(signal(over, "budgetOverrun").points).toBe(RISK_WEIGHTS.budgetOverrun); // 50% over = worst case
    expect(signal(over, "budgetOverrun").note).toMatch(/50% over budget/i);
  });

  it("scores nothing when there is no budget or no usable forecast", () => {
    // A project with no budget is not risk-free, but it is not BUDGET-risky, and inventing a
    // number here would make every unbudgeted project look bad.
    expect(signal(assessRisk(clean({ budget: null })), "budgetOverrun").points).toBe(0);
    expect(signal(assessRisk(clean({ forecastAtCompletion: null })), "budgetOverrun").points).toBe(0);
  });
});

describe("blocked work", () => {
  it("is measured as a SHARE of open work, not an absolute count", () => {
    // Three blocked out of five is a stalled project; three out of two hundred is a normal
    // Tuesday. An absolute threshold would call the second one a crisis.
    const small = assessRisk(clean({ openCount: 5, blockedCount: 3 }));
    const large = assessRisk(clean({ openCount: 200, blockedCount: 3 }));
    expect(signal(small, "blockedWork").points).toBeGreaterThan(signal(large, "blockedWork").points);
  });

  it("weighs a self-contradicting plan more heavily than one that is merely waiting", () => {
    const waiting = assessRisk(clean({ openCount: 20, blockedCount: 4 }));
    const contradictory = assessRisk(clean({ openCount: 20, blockedCount: 4, violationCount: 2 }));
    expect(signal(contradictory, "blockedWork").points).toBeGreaterThan(signal(waiting, "blockedWork").points);
    expect(signal(contradictory, "blockedWork").note).toMatch(/contradict a dependency/i);
  });
});

describe("over-allocation", () => {
  it("is a share of the team, so a big team is not penalised for one busy person", () => {
    const smallTeam = assessRisk(clean({ teamSize: 2, overAllocatedPeople: 1 }));
    const bigTeam = assessRisk(clean({ teamSize: 40, overAllocatedPeople: 1 }));
    expect(signal(smallTeam, "overAllocation").points).toBeGreaterThan(signal(bigTeam, "overAllocation").points);
  });

  it("does not divide by zero on a project with nobody assigned", () => {
    const result = assessRisk(clean({ teamSize: 0, overAllocatedPeople: 0 }));
    expect(Number.isFinite(result.riskScore)).toBe(true);
    expect(signal(result, "overAllocation").points).toBe(0);
  });
});

describe("reopen rate", () => {
  it("treats a small amount of rework as normal", () => {
    // 5% coming back is ordinary; nagging about it would train people to ignore the score.
    const normal = assessRisk(clean({ resolvedCount: 100, reopenedCount: 5 }));
    expect(signal(normal, "reopenRate").points).toBeLessThanOrEqual(2);
  });

  it("maxes out at a quarter of finished work coming back", () => {
    const bad = assessRisk(clean({ resolvedCount: 100, reopenedCount: 25 }));
    expect(signal(bad, "reopenRate").points).toBe(RISK_WEIGHTS.reopenRate);
  });

  it("does not divide by zero before anything has been resolved", () => {
    const result = assessRisk(clean({ resolvedCount: 0, reopenedCount: 0 }));
    expect(signal(result, "reopenRate").points).toBe(0);
    expect(Number.isFinite(result.riskScore)).toBe(true);
  });
});

describe("the overall score", () => {
  it("never exceeds 100, even when everything is wrong at once", () => {
    const disaster = assessRisk({
      projectId: "p1",
      worstSlipDays: 60,
      slippedItemCount: 30,
      overrunsPlannedEnd: true,
      plannedEndOverrunDays: 40,
      budget: 100_000,
      burn: 200_000,
      forecastAtCompletion: 400_000,
      blockedCount: 30,
      openCount: 30,
      violationCount: 10,
      overAllocatedPeople: 8,
      teamSize: 8,
      slaBreachCount: 30,
      reopenedCount: 50,
      resolvedCount: 50,
      progressPct: 20
    });
    expect(disaster.riskScore).toBe(100);
    expect(disaster.band).toBe("RED");
  });

  it("orders concerns worst-first, so the note reads as what to fix in order", () => {
    const result = assessRisk(clean({
      worstSlipDays: 15,          // maxes the biggest weight
      slippedItemCount: 5,
      resolvedCount: 100,
      reopenedCount: 25           // maxes the smallest weight
    }));
    expect(result.topConcerns[0]).toMatch(/slipped/i);
    expect(result.topConcerns[result.topConcerns.length - 1]).toMatch(/reopened/i);
  });

  it("carries the measured facts, so a narrator has numbers and never has to invent any", () => {
    const result = assessRisk(clean({ worstSlipDays: 4, slippedItemCount: 2, blockedCount: 3 }));
    expect(result.facts.worstSlipDays).toBe(4);
    expect(result.facts.blockedItems).toBe(3);
    expect(result.facts.progressPct).toBe(40);
    // Every signal keeps its own detail too, so "why is this red?" survives the data moving on.
    expect(signal(result, "blockedWork").detail.blocked).toBe(3);
  });

  it("is deterministic — the same inputs always produce the same score", () => {
    const inputs = clean({ worstSlipDays: 7, blockedCount: 4, overAllocatedPeople: 2 });
    const a = assessRisk(inputs);
    const b = assessRisk(inputs);
    expect(a.riskScore).toBe(b.riskScore);
    expect(a.signals.map((s) => s.points)).toEqual(b.signals.map((s) => s.points));
  });
});
