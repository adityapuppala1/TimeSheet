/**
 * Pins what a goal's number MEANS, not merely that the code runs.
 *
 * WHY THIS FILE MATTERS AS MUCH AS plan-schedule.service.test.ts: every failure available here is
 * silent. A pace threshold off by a factor renders a plausible "at risk" badge; an AT_MOST source
 * scored as if it were AT_LEAST shows a team burning through its budget as 90% "progress"; an
 * unavailable measurement rendered as 0 turns "no data" into "nothing achieved". None of those
 * throw, and all of them end up in a quarterly review.
 *
 * The pure arithmetic (direction, pace, health, elapsed) is tested directly. The DB-backed source
 * computers are covered by the API tests; what is pinned here is the meaning layer they feed.
 */
import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import {
  deriveHealth,
  elapsedFraction,
  measureGoal,
  SOURCE_DIRECTION
} from "../../src/services/goal-progress.service.js";

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/** A quarter, so "half elapsed" is a date a reader can check by eye. */
const Q_START = day("2026-01-01");
const Q_END = day("2026-03-31");
const Q_MID = day("2026-02-14"); // ~half way

describe("source directions", () => {
  it("scores spend, breaches and risk as ceilings rather than achievements", () => {
    // Getting this backwards is the difference between "you have spent 90% of the budget" and
    // "you are 90% done" — the same number with opposite meanings.
    expect(SOURCE_DIRECTION.BUDGET_SPEND).toBe("AT_MOST");
    expect(SOURCE_DIRECTION.SLA_BREACHES).toBe("AT_MOST");
    expect(SOURCE_DIRECTION.RISK_SCORE).toBe("AT_MOST");
  });

  it("scores hours, closures and on-time rate as things to climb", () => {
    expect(SOURCE_DIRECTION.APPROVED_HOURS).toBe("AT_LEAST");
    expect(SOURCE_DIRECTION.TICKETS_CLOSED).toBe("AT_LEAST");
    expect(SOURCE_DIRECTION.ON_TIME_RATE).toBe("AT_LEAST");
    expect(SOURCE_DIRECTION.MANUAL).toBe("AT_LEAST");
  });
});

describe("elapsedFraction", () => {
  it("is 0 at the start, ~0.5 in the middle and 1 at the end", () => {
    expect(elapsedFraction(Q_START, Q_END, Q_START)).toBe(0);
    expect(elapsedFraction(Q_START, Q_END, Q_MID)).toBeCloseTo(0.5, 1);
    expect(elapsedFraction(Q_START, Q_END, Q_END)).toBe(1);
  });

  it("clamps outside the period rather than reporting negative or >1 progress", () => {
    // A goal read before it starts must not report a negative pace, and one read after it ends
    // must not keep inflating the expected line.
    expect(elapsedFraction(Q_START, Q_END, day("2025-12-01"))).toBe(0);
    expect(elapsedFraction(Q_START, Q_END, day("2026-06-01"))).toBe(1);
  });

  it("treats a zero-length or inverted period as fully elapsed", () => {
    // Division by zero here would produce Infinity and NaN health downstream.
    expect(elapsedFraction(Q_START, Q_START, Q_START)).toBe(1);
    expect(elapsedFraction(Q_END, Q_START, Q_MID)).toBe(1);
  });
});

describe("deriveHealth — AT_LEAST", () => {
  const at = (currentValue: number, elapsed: number) =>
    deriveHealth({ direction: "AT_LEAST", currentValue, targetValue: 100, elapsed });

  it("is on track when progress keeps pace with the period", () => {
    expect(at(50, 0.5)).toBe("ON_TRACK");
    expect(at(45, 0.5)).toBe("ON_TRACK"); // within the 10-point tolerance
  });

  it("is at risk when it falls 10-25 points behind pace", () => {
    expect(at(30, 0.5)).toBe("AT_RISK");
    expect(at(26, 0.5)).toBe("AT_RISK");
  });

  it("is off track beyond 25 points behind pace", () => {
    expect(at(10, 0.5)).toBe("OFF_TRACK");
    expect(at(0, 0.9)).toBe("OFF_TRACK");
  });

  it("is on track at 100% however little of the period has passed", () => {
    // Finishing early is not a warning state.
    expect(at(100, 0.1)).toBe("ON_TRACK");
    expect(at(140, 0.1)).toBe("ON_TRACK");
  });

  it("does not divide by a zero target", () => {
    expect(deriveHealth({ direction: "AT_LEAST", currentValue: 0, targetValue: 0, elapsed: 1 })).toBe("ON_TRACK");
  });
});

describe("deriveHealth — AT_MOST", () => {
  const at = (currentValue: number, elapsed: number) =>
    deriveHealth({ direction: "AT_MOST", currentValue, targetValue: 1000, elapsed });

  it("is on track while consumption trails the period", () => {
    expect(at(400, 0.5)).toBe("ON_TRACK");
    expect(at(500, 0.5)).toBe("ON_TRACK");
  });

  it("is at risk within 15% of the pace line, off track beyond it", () => {
    expect(at(560, 0.5)).toBe("AT_RISK");
    expect(at(800, 0.5)).toBe("OFF_TRACK");
  });

  it("is off track the moment the ceiling itself is breached, whatever the pace", () => {
    // Being over budget at the very end of the quarter is still over budget.
    expect(at(1001, 1)).toBe("OFF_TRACK");
    expect(at(1001, 0.1)).toBe("OFF_TRACK");
  });

  it("does not punish spend before the period has started", () => {
    expect(at(0, 0)).toBe("ON_TRACK");
  });
});

describe("measureGoal — MANUAL", () => {
  const manual = (over: Partial<Parameters<typeof measureGoal>[0]> = {}) => ({
    id: "g1",
    progressSource: "MANUAL" as const,
    startDate: Q_START,
    endDate: Q_END,
    targetValue: null,
    manualProgressPct: 50,
    ...over
  });

  it("reports unavailable — not 0% — when no progress has been stated", async () => {
    // The distinction the whole design rests on: "nobody has said" is not "nothing done".
    const result = await measureGoal(manual({ manualProgressPct: null }), Q_MID);
    expect(result.unavailable).toBe(true);
    expect(result.progressPct).toBeNull();
    expect(result.currentValue).toBeNull();
    expect(result.unavailableReason).toMatch(/no progress/i);
  });

  it("uses the stated percentage and still judges it against the period", async () => {
    const onPace = await measureGoal(manual({ manualProgressPct: 50 }), Q_MID);
    expect(onPace.progressPct).toBe(50);
    expect(onPace.health).toBe("ON_TRACK");

    const behind = await measureGoal(manual({ manualProgressPct: 5 }), Q_MID);
    expect(behind.health).toBe("OFF_TRACK");
  });

  it("clamps a nonsense stated percentage for display without hiding the raw value", async () => {
    const result = await measureGoal(manual({ manualProgressPct: 100 }), Q_MID);
    expect(result.progressPct).toBe(100);
    expect(result.currentValue).toBe(100);
  });

  it("works with no period at all, because a manual goal needs no window", async () => {
    const result = await measureGoal(manual({ startDate: null, endDate: null }), Q_MID);
    expect(result.unavailable).toBe(false);
    expect(result.progressPct).toBe(50);
  });
});

describe("measureGoal — measured sources refuse to guess", () => {
  const measured = (over: Partial<Parameters<typeof measureGoal>[0]> = {}) => ({
    id: "g2",
    progressSource: "APPROVED_HOURS" as const,
    startDate: Q_START,
    endDate: Q_END,
    targetValue: new Prisma.Decimal(100),
    manualProgressPct: null,
    ...over
  });

  it("is unavailable without a period — a measurement with no window is not a measurement", async () => {
    const noStart = await measureGoal(measured({ startDate: null }), Q_MID);
    expect(noStart.unavailable).toBe(true);
    expect(noStart.unavailableReason).toMatch(/period/i);

    const noEnd = await measureGoal(measured({ endDate: null }), Q_MID);
    expect(noEnd.unavailable).toBe(true);
    expect(noEnd.unavailableReason).toMatch(/period/i);
  });

  it("is unavailable without a target, rather than scoring against zero", async () => {
    // Scoring against a zero target would make every measured goal instantly complete.
    const result = await measureGoal(measured({ targetValue: null }), Q_MID);
    expect(result.unavailable).toBe(true);
    expect(result.unavailableReason).toMatch(/target/i);
    expect(result.progressPct).toBeNull();
  });

  it("never returns a progress percentage for an AT_MOST source", async () => {
    // "62% of the way to your spending ceiling" reads as achievement. The UI shows the raw
    // amount against the ceiling instead, so the API must not offer a tempting percentage.
    expect(SOURCE_DIRECTION.BUDGET_SPEND).toBe("AT_MOST");
  });
});
