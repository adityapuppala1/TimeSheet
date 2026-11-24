import { describe, expect, it } from "vitest";
import { optionalChoice, optionalSummary } from "../../src/lib/holiday-opt-in";
import { parseOptionalCap } from "../../src/pages/settings/OptionalHolidayCapField";

const today = "2026-11-24";

describe("optionalChoice", () => {
  it("offers nothing for a public holiday", () => {
    expect(optionalChoice({ date: "2026-12-25", isOptional: false }, 2, 0, today)).toBeNull();
  });
  it("lets a person opt in under the cap and opt out of one taken", () => {
    expect(optionalChoice({ date: "2026-12-01", isOptional: true }, 2, 1, today)).toEqual({ action: "in", disabled: false, reason: null });
    expect(optionalChoice({ date: "2026-12-01", isOptional: true, optedIn: true }, 2, 2, today)).toEqual({ action: "out", disabled: false, reason: null });
  });
  it("disables opting in at the cap, with the reason", () => {
    const c = optionalChoice({ date: "2026-12-01", isOptional: true }, 2, 2, today);
    expect(c?.disabled).toBe(true);
    expect(c?.reason).toBe("You have taken all 2 optional holidays for 2026.");
  });
  it("disables a past day", () => {
    expect(optionalChoice({ date: "2026-11-01", isOptional: true, optedIn: true }, null, 1, today)?.reason).toBe("This day has passed.");
  });
  it("summarises the cap", () => {
    expect(optionalSummary(2, 1, "2026")).toContain("1 of 2 taken in 2026");
    expect(optionalSummary(null, 0, "2026")).toContain("no limit");
  });
});

describe("parseOptionalCap", () => {
  it("reads empty as no limit and rejects junk", () => {
    expect(parseOptionalCap("")).toBeNull();
    expect(parseOptionalCap(" 2 ")).toBe(2);
    expect(parseOptionalCap("0")).toBe(0);
    expect(parseOptionalCap("-1")).toBeUndefined();
    expect(parseOptionalCap("400")).toBeUndefined();
  });
});
