/**
 * `computeTrend` — the arithmetic behind every "vs …" badge. The case that mattered: a zero baseline.
 * Anything over zero used to read "+100%", which is not a measurement (any figure over nothing is an
 * infinite increase) and looked like a real doubling. It now reads "new".
 */
import { describe, expect, it } from "vitest";
import { computeTrend, trendText } from "../../src/lib/trend";

describe("computeTrend", () => {
  it("calls growth from a zero baseline new, not +100%", () => {
    const trend = computeTrend(5, 0, true)!;
    expect(trend.isNew).toBe(true);
    expect(trendText(trend)).toBe("new");
  });

  it("has nothing to say when both sides are zero", () => {
    expect(computeTrend(0, 0, true)).toBeNull();
  });

  it("still reports a real percentage change", () => {
    const trend = computeTrend(15, 10, true)!;
    expect(trend).toMatchObject({ pct: 50, direction: "up", good: true });
    expect(trend.isNew).toBeFalsy();
    expect(trendText(trend)).toBe("+50%");
    expect(trendText(computeTrend(10, 10, true)!)).toBe("flat");
    expect(trendText(computeTrend(5, 10, true)!)).toBe("-50%");
  });
});
