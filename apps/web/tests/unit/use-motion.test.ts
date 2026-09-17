import { describe, expect, it } from "vitest";
import {
  countUpFrame,
  COUNT_UP_DURATION_MS,
  staggerStyle,
  STAGGER_MAX_STEPS,
  STAGGER_STEP_MS
} from "../../src/lib/use-motion";

describe("countUpFrame", () => {
  it("starts at the old value and LANDS on the target, never on an interpolation", () => {
    expect(countUpFrame(100, 200, 0)).toBe(100);
    expect(countUpFrame(100, 200, COUNT_UP_DURATION_MS)).toBe(200);
    // The failure this guards: a slow machine skipping the last frame and settling one short.
    expect(countUpFrame(100, 200, COUNT_UP_DURATION_MS + 5_000)).toBe(200);
  });

  it("decelerates — more than half the distance is covered in the first half of the time", () => {
    const half = countUpFrame(0, 1000, COUNT_UP_DURATION_MS / 2);
    expect(half).toBeGreaterThan(500);
    expect(half).toBeLessThan(1000);
  });

  it("counts down as happily as up, and returns whole numbers", () => {
    const mid = countUpFrame(200, 100, COUNT_UP_DURATION_MS / 3);
    expect(mid).toBeLessThan(200);
    expect(mid).toBeGreaterThan(100);
    expect(Number.isInteger(mid)).toBe(true);
  });

  it("is safe with a zero duration and with negative time", () => {
    expect(countUpFrame(5, 9, 10, 0)).toBe(9);
    expect(countUpFrame(5, 9, -20)).toBe(5);
  });
});

describe("staggerStyle", () => {
  it("steps by the fixed interval for the first items", () => {
    expect(staggerStyle(0)["--stagger-delay"]).toBe("0ms");
    expect(staggerStyle(3)["--stagger-delay"]).toBe(`${3 * STAGGER_STEP_MS}ms`);
  });

  it("caps, so the sixtieth card on a board is not two seconds late", () => {
    const capped = `${STAGGER_MAX_STEPS * STAGGER_STEP_MS}ms`;
    expect(staggerStyle(STAGGER_MAX_STEPS)["--stagger-delay"]).toBe(capped);
    expect(staggerStyle(60)["--stagger-delay"]).toBe(capped);
    expect(staggerStyle(6000)["--stagger-delay"]).toBe(capped);
    // And the cap is short enough to still feel like one movement.
    expect(STAGGER_MAX_STEPS * STAGGER_STEP_MS).toBeLessThanOrEqual(400);
  });

  it("treats a negative index as the first item rather than a negative delay", () => {
    expect(staggerStyle(-5)["--stagger-delay"]).toBe("0ms");
  });
});
