/**
 * The server-side phone/timezone validators behind PATCH /auth/profile. Per-country phone
 * validity is the entire point — a regex can't know that an Indian mobile has 10 national
 * digits while a Singapore number has 8 — so the cases deliberately span countries.
 */
import { describe, expect, it } from "vitest";
import { isValidTimezone, normalizePhoneNumber } from "../../src/utils/phone.js";

describe("normalizePhoneNumber", () => {
  it("accepts valid international numbers and normalizes them to E.164", () => {
    const cases: Array<[string, string]> = [
      ["+91 98765 43210", "+919876543210"], // India, 10 national digits
      ["+65 8123 4567", "+6581234567"], // Singapore, 8 digits
      ["+1 (212) 555-0175", "+12125550175"], // US, NANP
      ["+44 20 7946 0958", "+442079460958"] // UK London
    ];
    for (const [input, e164] of cases) {
      const result = normalizePhoneNumber(input);
      expect(result, input).toEqual({ ok: true, e164 });
    }
  });

  it("rejects numbers that are invalid FOR THEIR OWN country", () => {
    for (const bad of ["+91 12345", "+65 123", "+1 555 0123"]) {
      expect(normalizePhoneNumber(bad).ok, bad).toBe(false);
    }
  });

  it("rejects text, and numbers without a country code — international form is the contract", () => {
    for (const bad of ["hello", "9876543210", "0044 20 7946 0958", "call me maybe"]) {
      const result = normalizePhoneNumber(bad);
      expect(result.ok, bad).toBe(false);
    }
  });
});

describe("isValidTimezone", () => {
  it("accepts real IANA zones INCLUDING aliases, and rejects lookalikes", () => {
    // Kolkata and Calcutta are the same zone under two names, and which one is "canonical"
    // differs per ICU build — a validator must accept both, because browsers report either.
    expect(isValidTimezone("Asia/Kolkata")).toBe(true);
    expect(isValidTimezone("Asia/Calcutta")).toBe(true);
    expect(isValidTimezone("America/New_York")).toBe(true);
    expect(isValidTimezone("Asia/Kolkataa")).toBe(false);
    expect(isValidTimezone("gibberish")).toBe(false);
  });
});
