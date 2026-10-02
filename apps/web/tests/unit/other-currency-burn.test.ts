/**
 * A project's burn is in its budget's currency only. What was billed in any other currency comes
 * back beside it (`otherCurrencyBurn`) and is printed beside it — each amount in its own currency,
 * never converted and never added to the burn.
 */
import { describe, expect, it } from "vitest";

import { otherCurrencyBurnText } from "../../src/lib/other-currency-burn";

describe("otherCurrencyBurnText", () => {
  it("lists each other currency in its own symbol, never one total", () => {
    expect(
      otherCurrencyBurnText([
        { currency: "INR", amount: 50000 },
        { currency: "EUR", amount: 120 }
      ])
    ).toBe("₹50,000 + €120");
  });

  it("says nothing when everything was billed in the budget's currency, or the server is older", () => {
    expect(otherCurrencyBurnText([])).toBeNull();
    expect(otherCurrencyBurnText(undefined)).toBeNull();
  });
});
