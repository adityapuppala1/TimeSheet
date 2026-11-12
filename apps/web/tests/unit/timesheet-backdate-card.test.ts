/**
 * The back-date setting's two decisions that can quietly go wrong, pinned as pure functions.
 *
 * `parseBackdateDays` is what stops an admin saving a value the server would 400 on — and, more
 * importantly, what keeps "" and "abc" from becoming 0. Zero is a REAL window ("today only"), so a
 * parser that coerced a blank box to 0 would turn a half-typed field into a strict policy.
 *
 * `backdateSummary` feeds the board tile. null is "no limit" and must read as the opposite of 0
 * ("today only") — the two are the most different settings the control has and share a falsy value
 * in JavaScript, which is exactly how a tile ends up reading "Any past date" for a strict workspace.
 */
import { describe, expect, it } from "vitest";

import { backdateSummary, parseBackdateDays } from "../../src/pages/settings/TimesheetBackdateCard";

describe("parseBackdateDays", () => {
  it("accepts whole numbers from 0 to 365", () => {
    expect(parseBackdateDays("0")).toBe(0);
    expect(parseBackdateDays("7")).toBe(7);
    expect(parseBackdateDays("30")).toBe(30);
    expect(parseBackdateDays("365")).toBe(365);
  });

  it("never turns a blank or half-typed box into 0", () => {
    expect(parseBackdateDays("")).toBeNull();
    expect(parseBackdateDays("   ")).toBeNull();
    expect(parseBackdateDays("-")).toBeNull();
    expect(parseBackdateDays("abc")).toBeNull();
  });

  it("refuses fractions, negatives and anything past a year", () => {
    expect(parseBackdateDays("2.5")).toBeNull();
    expect(parseBackdateDays("-3")).toBeNull();
    expect(parseBackdateDays("366")).toBeNull();
    expect(parseBackdateDays("1000")).toBeNull();
  });
});

describe("backdateSummary", () => {
  it("reads null as no limit, and 0 as today only — never the same thing", () => {
    expect(backdateSummary(null)).toEqual({ limited: false, value: "Any past date" });
    expect(backdateSummary(0)).toEqual({ limited: true, value: "Today only" });
  });

  it("states the window for a number of days, singular and plural", () => {
    expect(backdateSummary(1)).toEqual({ limited: true, value: "1 day back" });
    expect(backdateSummary(7)).toEqual({ limited: true, value: "7 days back" });
  });

  it("says nothing until the setting has loaded", () => {
    expect(backdateSummary(undefined).value).toBe("");
  });
});
