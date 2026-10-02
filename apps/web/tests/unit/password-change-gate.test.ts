/**
 * The SPA half of the mustChangePassword gate (security audit #11).
 *
 * The API decides — `passwordChangeRequired` on `/auth/login` and `/auth/me` is true only for a
 * PASSWORD session whose password an admin set — and AppLayout renders the forced change-password
 * screen from it. Pinned here: only an explicit `true` holds someone at the screen (an older API that
 * does not send the field must never lock anybody out), and the API's refusal is recognisable by its
 * code, so callers can stay quiet about it.
 */
import { describe, expect, it } from "vitest";
import { isPasswordChangeRequired, isPasswordChangeRequiredError, newPasswordProblem } from "../../src/lib/password-change-gate";

describe("isPasswordChangeRequired", () => {
  it("holds only on an explicit true from the server", () => {
    expect(isPasswordChangeRequired({ passwordChangeRequired: true })).toBe(true);
    expect(isPasswordChangeRequired({ passwordChangeRequired: false })).toBe(false);
    // The SSO case, and an API from before the gate: the flag alone is only the banner's business.
    expect(isPasswordChangeRequired({ mustChangePassword: true })).toBe(false);
    expect(isPasswordChangeRequired(undefined)).toBe(false);
  });
});

describe("isPasswordChangeRequiredError", () => {
  it("recognises the gate's 403 by its code, not by its status alone", () => {
    expect(isPasswordChangeRequiredError({ response: { status: 403, data: { code: "PASSWORD_CHANGE_REQUIRED" } } })).toBe(true);
    expect(isPasswordChangeRequiredError({ response: { status: 403, data: { message: "Forbidden" } } })).toBe(false);
    expect(isPasswordChangeRequiredError(new Error("Network Error"))).toBe(false);
  });
});

describe("newPasswordProblem", () => {
  it("asks for 8 characters, a matching confirmation, and something other than the current password", () => {
    expect(newPasswordProblem("Original@123", "short", "short")).toMatch(/8 characters/);
    expect(newPasswordProblem("Original@123", "my-own-choice-1", "my-own-choice-2")).toMatch(/match/i);
    expect(newPasswordProblem("Original@123", "Original@123", "Original@123")).toMatch(/already have/i);
    expect(newPasswordProblem("Original@123", "my-own-choice-1", "my-own-choice-1")).toBeNull();
  });
});
