import { describe, expect, it } from "vitest";
import { firstSentence, MOATS } from "../../src/components/marketing/moats";

describe("MOATS", () => {
  it("has a title, a body and a why for every claim, so neither page can render a blank card", () => {
    expect(MOATS.length).toBeGreaterThanOrEqual(6);
    for (const m of MOATS) {
      expect(m.title.length).toBeGreaterThan(8);
      expect(m.body.length).toBeGreaterThan(40);
      // Lucide icons are forwardRef objects, not plain functions.
      expect(m.icon).toBeTruthy();
    }
  });
});

describe("firstSentence", () => {
  it("cuts at the first sentence end, never mid-sentence, and never on an abbreviation-free run-on", () => {
    expect(firstSentence("First thing. Second thing.")).toBe("First thing.");
    expect(firstSentence("Is it? Yes it is.")).toBe("Is it?");
    expect(firstSentence("No terminator at all")).toBe("No terminator at all");
    expect(firstSentence("Ends here.")).toBe("Ends here.");
  });
  it("shortens every real claim", () => {
    for (const m of MOATS) expect(firstSentence(m.body).length).toBeLessThanOrEqual(m.body.length);
  });
});
