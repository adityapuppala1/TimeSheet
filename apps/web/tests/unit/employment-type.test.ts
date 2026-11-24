/** 7.0.0 leave policies: a scope in words. */
import { describe, expect, it } from "vitest";
import { scopeSummary } from "../../src/lib/employment-type";

describe("scopeSummary", () => {
  it("reads empty as everyone, and names types and sites", () => {
    expect(scopeSummary([], [])).toBe("Everyone");
    expect(scopeSummary(["FULL_TIME", "CONTRACT"], undefined)).toBe("Full time, Contract");
    expect(scopeSummary([], ["a", "b"])).toBe("2 sites");
    expect(scopeSummary(["INTERN"], ["a"], (id) => (id === "a" ? "Bengaluru" : undefined))).toBe("Intern · Bengaluru");
  });
});
