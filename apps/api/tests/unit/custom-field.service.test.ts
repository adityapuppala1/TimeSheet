/**
 * Pins `normaliseValue` — the single choke point every custom-field write goes through.
 *
 * WHY THIS IS WORTH TESTING: `CustomFieldValue.value` is a JSON column, so the database accepts
 * anything. The declared `CustomFieldType` is the ONLY thing that makes a NUMBER field numeric or
 * a SINGLE_SELECT field constrained to its options, and four separate write paths depend on it
 * (the ticket form, request-form intake, blueprint expansion, and the AI proposal applier). A
 * regression here doesn't throw — it quietly stores a string where a number belongs, and only
 * surfaces months later as a report that won't sum.
 */
import { describe, expect, it } from "vitest";
import { normaliseValue } from "../../src/services/custom-field.service.js";
import type { CustomFieldType } from "@timesheet/shared";

const field = (type: CustomFieldType, extra: Partial<{ isRequired: boolean; options: unknown }> = {}) => ({
  key: "f",
  label: "Field",
  type,
  isRequired: extra.isRequired ?? false,
  options: extra.options ?? null
});

describe("normaliseValue", () => {
  it("treats every flavour of empty as 'not answered', not as a value", () => {
    // The asymmetry that matters: "" and null must collapse to the same stored null, or reports
    // end up distinguishing two states users never meant to create.
    for (const empty of [null, undefined, "", []]) {
      expect(normaliseValue(field("TEXT"), empty)).toBeNull();
    }
    expect(normaliseValue(field("MULTI_SELECT", { options: ["a"] }), [])).toBeNull();
  });

  it("refuses empty on a required field", () => {
    expect(() => normaliseValue(field("TEXT", { isRequired: true }), "")).toThrow(/required/i);
    expect(() => normaliseValue(field("NUMBER", { isRequired: true }), null)).toThrow(/required/i);
  });

  it("coerces numbers, including thousands separators, and rejects non-numbers", () => {
    expect(normaliseValue(field("NUMBER"), "42")).toBe(42);
    expect(normaliseValue(field("NUMBER"), 42)).toBe(42);
    expect(normaliseValue(field("CURRENCY"), "1,250.50")).toBe(1250.5);
    expect(() => normaliseValue(field("NUMBER"), "not a number")).toThrow(/must be a number/i);
    // Infinity is finite-looking to a naive Number() check and would poison every aggregate it
    // reached, so it must be refused rather than stored.
    expect(() => normaliseValue(field("NUMBER"), "Infinity")).toThrow(/must be a number/i);
  });

  it("stores DATE as a calendar day, not an instant", () => {
    // A time-of-day on a DATE field makes the same value render as two different days either side
    // of a timezone boundary — which is the bug this slice() prevents.
    expect(normaliseValue(field("DATE"), "2026-03-15T22:30:00Z")).toBe("2026-03-15");
    expect(normaliseValue(field("DATE"), "2026-03-15")).toBe("2026-03-15");
    expect(() => normaliseValue(field("DATE"), "not a date")).toThrow(/valid date/i);
  });

  it("constrains selects to their declared options", () => {
    const single = field("SINGLE_SELECT", { options: ["Acme", "Globex"] });
    expect(normaliseValue(single, "Acme")).toBe("Acme");
    expect(() => normaliseValue(single, "Initech")).toThrow(/not an option/i);

    const multi = field("MULTI_SELECT", { options: ["a", "b", "c"] });
    expect(normaliseValue(multi, ["a", "c"])).toEqual(["a", "c"]);
    // A single value posted to a multi-select is a normal form submission, not an error.
    expect(normaliseValue(multi, "b")).toEqual(["b"]);
    // Duplicates are de-duped rather than rejected — the user's intent is unambiguous.
    expect(normaliseValue(multi, ["a", "a"])).toEqual(["a"]);
    expect(() => normaliseValue(multi, ["a", "z"])).toThrow(/not an option/i);
  });

  it("accepts only http(s) URLs", () => {
    expect(normaliseValue(field("URL"), "https://example.com/x")).toBe("https://example.com/x");
    // The security-relevant case: a stored `javascript:` URL becomes XSS the moment any surface
    // renders it as a link, and no legitimate custom field needs one.
    expect(() => normaliseValue(field("URL"), "javascript:alert(1)")).toThrow(/valid http/i);
    expect(() => normaliseValue(field("URL"), "data:text/html,<script>")).toThrow(/valid http/i);
    expect(() => normaliseValue(field("URL"), "not a url")).toThrow(/valid http/i);
  });

  it("reads the usual truthy spellings for a checkbox", () => {
    for (const truthy of [true, "true", 1, "1"]) {
      expect(normaliseValue(field("CHECKBOX"), truthy)).toBe(true);
    }
    for (const falsy of [false, "false", 0, "0", "no"]) {
      expect(normaliseValue(field("CHECKBOX"), falsy)).toBe(false);
    }
  });
});
