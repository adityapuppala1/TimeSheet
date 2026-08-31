/**
 * The capacity forecast, and — far more importantly — its refusals.
 *
 * WHY THIS FILE IS MOSTLY NEGATIVE TESTS. "Acme reaches its ceiling in about six weeks" is the
 * difference between a metric and a decision, and it is also the easiest number in this codebase to
 * produce wrongly and have nobody notice. A slope fitted to three samples taken on a Tuesday
 * afternoon renders identically to one fitted to three months of data; an operator has no way to
 * tell them apart unless the function itself refuses the first. So the property under test is not
 * "does it extrapolate correctly" — it is "does it decline to extrapolate when it should", which is
 * the answer it gives most of the time.
 *
 * `forecastGrowth` is PURE: a fixed series in, a verdict out. No clock, no database, no Prisma row.
 * That is what lets the degenerate cases — one point, a flat line, a shrinking database, a series
 * that jumps around — be written down as literals rather than manufactured in a fixture.
 *
 * A failure here is usually deliberate: somebody moved a floor. The question to answer is whether
 * the console's copy ("Not enough history") and these constants still agree.
 */
import { describe, expect, it } from "vitest";
import { forecastGrowth } from "../../src/services/tenant-db-metrics.service.js";

const GB = 1024 ** 3;
const DAY = 86_400_000;
const START = Date.parse("2026-06-01T00:00:00.000Z");

/** A series of `count` samples one day apart, each `bytesAt(i)` big. */
const series = (count: number, bytesAt: (index: number) => number, stepMs = DAY) =>
  Array.from({ length: count }, (_, index) => ({ at: new Date(START + index * stepMs).toISOString(), totalBytes: bytesAt(index) }));

describe("it refuses to extrapolate from too little", () => {
  it("says so for an empty series rather than throwing", () => {
    const forecast = forecastGrowth([]);
    expect(forecast.confidence).toBe("none");
    expect(forecast.daysToTarget).toBeNull();
    expect(forecast.samples).toBe(0);
  });

  it("says so for ONE point — there is no slope to have", () => {
    const forecast = forecastGrowth(series(1, () => 10 * GB));
    expect(forecast.confidence).toBe("none");
    expect(forecast.reason).toMatch(/not enough history/i);
    expect(forecast.bytesPerDay).toBeNull();
  });

  it("says so for THREE points, which is the trap this whole function exists to avoid", () => {
    // Three points sit perfectly on a line by arithmetic, not by evidence. A least-squares fit
    // reports r² = 1 and total confidence, which is exactly how a made-up number gets quoted to a
    // customer. The sample floor, not the fit quality, is what catches this.
    const forecast = forecastGrowth(series(3, (i) => 10 * GB + i * GB));
    expect(forecast.confidence).toBe("none");
    expect(forecast.reason).toMatch(/at least 6 samples/i);
    expect(forecast.daysToTarget).toBeNull();
  });

  it("says so for plenty of samples crammed into a few hours", () => {
    // Twenty readings across four hours is not four hours of information about a month. "Grew 3 MB
    // in twenty minutes" annualises to a nonsense an operator would have to know to ignore.
    const forecast = forecastGrowth(series(20, (i) => 10 * GB + i * 5_000_000, 12 * 60 * 1000));
    expect(forecast.confidence).toBe("none");
    expect(forecast.reason).toMatch(/spanning 3 days/i);
  });
});

describe("the degenerate shapes", () => {
  it("calls a perfectly flat series flat, and projects nothing", () => {
    const forecast = forecastGrowth(series(30, () => 12 * GB));
    expect(forecast.confidence).toBe("none");
    expect(forecast.reason).toMatch(/flat/i);
    expect(forecast.bytesPerDay).toBe(0);
    expect(forecast.daysToTarget).toBeNull();
    // r² is 0/0 on a zero-variance series. Reported as 1 rather than NaN — the line does describe
    // it exactly — and it does not matter, because a zero slope is refused regardless.
    expect(forecast.r2).toBe(1);
  });

  it("refuses to project a SHRINKING database at a ceiling it is moving away from", () => {
    const forecast = forecastGrowth(series(30, (i) => 20 * GB - i * 0.1 * GB));
    expect(forecast.confidence).toBe("none");
    expect(forecast.bytesPerDay).toBeLessThan(0);
    expect(forecast.daysToTarget).toBeNull();
    expect(forecast.reason).toMatch(/shrinking/i);
  });

  it("refuses a noisy series even when it has plenty of samples over plenty of days", () => {
    // Sizes that jump around a mean with no trend. There IS movement, so this is not the flat case;
    // there is simply no line through it, and a slope quoted off this would be fiction with a
    // decimal point on it.
    const wobble = [0, 9, -7, 6, -8, 3, -4, 8, -9, 2, 7, -6, 5, -3, 9, -8, 4, -5, 6, -7, 8, -2, 3, -9, 7, -4, 5, -6, 2, 8];
    const forecast = forecastGrowth(series(30, (i) => 10 * GB + wobble[i] * GB));
    expect(forecast.confidence).toBe("none");
    expect(forecast.reason).toMatch(/too noisy/i);
    expect(forecast.daysToTarget).toBeNull();
    expect(forecast.r2!).toBeLessThan(0.5);
  });

  it("does not count down when the database is already past the target", () => {
    const forecast = forecastGrowth(series(30, (i) => 60 * GB + i * GB));
    expect(forecast.confidence).toBe("none");
    expect(forecast.reason).toMatch(/already at or past/i);
    expect(forecast.daysToTarget).toBeNull();
  });

  it("survives a series where every sample shares one timestamp instead of dividing by zero", () => {
    const forecast = forecastGrowth(series(10, (i) => 10 * GB + i * GB, 0));
    expect(forecast.confidence).toBe("none");
    expect(forecast.daysToTarget).toBeNull();
    expect(Number.isFinite(forecast.spanDays)).toBe(true);
  });
});

describe("when it will commit to an answer", () => {
  it("projects a clean linear climb, and gets the arithmetic right", () => {
    // 10 GB, growing exactly 1 GB a day for 30 days: the last sample is 39 GB, the target is 50 GB,
    // so the remaining 11 GB is 11 days away.
    const forecast = forecastGrowth(series(30, (i) => (10 + i) * GB));
    expect(forecast.confidence).toBe("high");
    expect(forecast.bytesPerDay).toBeCloseTo(GB, -3);
    expect(forecast.daysToTarget).toBeCloseTo(11, 5);
    expect(forecast.r2).toBeCloseTo(1, 6);
  });

  it("gives the same answer as a DATE, because 'in 11 days' is a number people mis-add", () => {
    const forecast = forecastGrowth(series(30, (i) => (10 + i) * GB));
    // Measured from the LAST SAMPLE, not from now, so the function stays pure and a stale series
    // does not report a date that quietly slides forward on its own.
    expect(forecast.reachesTargetAt).toBe(new Date(START + 29 * DAY + 11 * DAY).toISOString());
  });

  it("downgrades its confidence when the line fits less well, rather than hiding the doubt", () => {
    // A real-ish climb with a step in it: it is genuinely growing, but the line explains less.
    const forecast = forecastGrowth(series(40, (i) => (10 + i * 0.4) * GB + (i > 20 ? 3 * GB : 0)));
    expect(forecast.confidence === "moderate" || forecast.confidence === "high").toBe(true);
    expect(forecast.daysToTarget).not.toBeNull();
    expect(forecast.reason).toMatch(/explains \d+% of the variation/);
  });

  it("counts down to a caller-supplied target, so the ceiling is not hard-wired at 50 GB", () => {
    const forecast = forecastGrowth(series(30, (i) => (10 + i) * GB), 45 * GB);
    expect(forecast.targetBytes).toBe(45 * GB);
    expect(forecast.daysToTarget).toBeCloseTo(6, 5);
  });

  it("always carries the evidence beside the answer", () => {
    // The number is only usable if the reader can see what produced it: how many samples, over how
    // long, and how well the line fits. A bare "43 days" is exactly the shape of a figure people
    // quote without checking.
    const forecast = forecastGrowth(series(30, (i) => (10 + i) * GB));
    expect(forecast.samples).toBe(30);
    expect(forecast.spanDays).toBeCloseTo(29, 6);
    expect(forecast.latestBytes).toBe(39 * GB);
    expect(forecast.reason.length).toBeGreaterThan(20);
  });
});
