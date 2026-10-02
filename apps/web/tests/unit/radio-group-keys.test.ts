/**
 * Arrow-key movement for a radio group (WAI-ARIA APG radio group pattern) — what the login page's
 * Password/Directory switcher uses now that it is a real radio group rather than tabs without tab
 * panels (security audit #19, WCAG 4.1.2).
 *
 * Pinned: arrows move AND wrap, Home/End jump to the ends, and every other key is left alone so it
 * keeps its normal meaning (Tab still leaves the group; Space still activates).
 */
import { describe, expect, it } from "vitest";
import { radioIndexForKey } from "../../src/lib/radio-group-keys";

describe("radioIndexForKey", () => {
  it("moves forward with Right and Down, wrapping at the end", () => {
    expect(radioIndexForKey("ArrowRight", 0, 2)).toBe(1);
    expect(radioIndexForKey("ArrowDown", 1, 2)).toBe(0);
  });

  it("moves back with Left and Up, wrapping at the start", () => {
    expect(radioIndexForKey("ArrowLeft", 1, 2)).toBe(0);
    expect(radioIndexForKey("ArrowUp", 0, 3)).toBe(2);
  });

  it("jumps to the ends with Home and End", () => {
    expect(radioIndexForKey("Home", 2, 3)).toBe(0);
    expect(radioIndexForKey("End", 0, 3)).toBe(2);
  });

  it("ignores every other key", () => {
    for (const key of ["Tab", " ", "Enter", "a"]) expect(radioIndexForKey(key, 0, 2)).toBeNull();
  });
});
