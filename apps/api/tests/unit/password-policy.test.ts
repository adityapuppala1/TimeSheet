/**
 * The one password policy (audit #10), checked wherever a person chooses their own password:
 * change-password, the emailed reset link, and the welcome link (which IS a reset link).
 *
 * WHAT IT ENFORCES, and what it deliberately does not:
 *  - at least 8 characters — ASVS L1's floor, unchanged, so nobody's current habit breaks;
 *  - at most 72 BYTES of UTF-8 — bcrypt ignores everything past that, so a longer password was
 *    silently truncated (two different 81-character passwords sharing their first 72 bytes produced
 *    the same hash);
 *  - not one of the ~3000 most common passwords (ASVS 6.2.4);
 *  - not the email address's local part, or a password containing it.
 * No composition rules and no rotation — NIST 800-63B says both make passwords worse.
 */
import { describe, expect, it } from "vitest";

const { passwordPolicyProblem, PASSWORD_MAX_BYTES } = await import("../../src/utils/password-policy.js");
const { COMMON_PASSWORDS } = await import("../../src/utils/common-passwords.js");

const EMAIL = "ada.lovelace@example.com";

describe("the password policy", () => {
  it("accepts every password the seeds and the e2e suite set or choose", () => {
    // If one of these were refused, `npm run seed` or a spec would break on deploy — the reason the
    // list is checked here and not discovered by the integrator.
    for (const password of ["Admin@12345", "PlatformAdmin@12345", "Original@123", "MyOwnChoice@99", "GateLift@1234", "GateForm@1234", "GateLift@5678", "GateForm@5678"]) {
      expect(passwordPolicyProblem(password, { email: "e2e-drill-1759400000000@timesheet.local" }), password).toBeNull();
      expect(passwordPolicyProblem(password, { email: "superadmin@timesheet.local" }), password).toBeNull();
    }
  });

  it("keeps the 8-character minimum", () => {
    expect(passwordPolicyProblem("Abc!234", { email: EMAIL })).toMatch(/at least 8 characters/i);
    expect(passwordPolicyProblem("Abc!2345", { email: EMAIL })).toBeNull();
  });

  it("refuses more than 72 bytes of UTF-8, counting bytes rather than characters", () => {
    expect(PASSWORD_MAX_BYTES).toBe(72);
    expect(passwordPolicyProblem("x".repeat(72), { email: EMAIL })).toBeNull();
    expect(passwordPolicyProblem("x".repeat(73), { email: EMAIL })).toMatch(/72/);
    // 40 characters, but each "é" is two bytes in UTF-8 — 80 bytes, past what bcrypt reads.
    expect(passwordPolicyProblem("é".repeat(40), { email: EMAIL })).toMatch(/72/);
  });

  it("refuses the most common passwords, whatever their case", () => {
    expect(passwordPolicyProblem("password1", { email: EMAIL })).toMatch(/common/i);
    expect(passwordPolicyProblem("Password1", { email: EMAIL })).toMatch(/common/i);
    expect(passwordPolicyProblem("QWERTYUIOP", { email: EMAIL })).toMatch(/common/i);
  });

  it("refuses the email's local part, alone or inside a longer password", () => {
    expect(passwordPolicyProblem("ada.lovelace", { email: EMAIL })).toMatch(/email/i);
    expect(passwordPolicyProblem("Ada.Lovelace!2026", { email: EMAIL })).toMatch(/email/i);
  });

  it("does not let a two-letter local part veto half the dictionary", () => {
    expect(passwordPolicyProblem("joyful-river-77", { email: "jo@example.com" })).toBeNull();
  });

  it("bundles a real top-3000 list, every entry long enough to have passed the length rule", () => {
    expect(COMMON_PASSWORDS.length).toBeGreaterThanOrEqual(3000);
    expect(COMMON_PASSWORDS.every((entry) => entry.length >= 8 && entry === entry.toLowerCase())).toBe(true);
  });
});
