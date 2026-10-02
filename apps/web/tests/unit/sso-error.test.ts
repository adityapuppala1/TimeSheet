/**
 * What the login page says when an SSO attempt comes back with `?sso_error=<code>`.
 *
 * The API redirects every SSO failure here (apps/api/src/utils/sso-error-code.ts) instead of
 * showing raw JSON on its own host. The code is a fixed vocabulary; these tests pin that every code
 * the API can send has words, that the words for the codes a person can act on name the action, and
 * that anything else in the URL — which is attacker-editable — is never echoed onto the page.
 */
import { describe, expect, it } from "vitest";
import { SSO_ERROR_MESSAGES, ssoErrorMessage } from "../../src/lib/sso-error";

/** Mirrors SSO_ERROR_CODES in apps/api/src/utils/sso-error-code.ts. */
const API_CODES = ["cancelled", "expired", "email_unverified", "inactive", "seat_limit", "maintenance", "not_provisioned", "not_allowed", "config", "failed"];

describe("ssoErrorMessage", () => {
  it("has a message for every code the API can send", () => {
    for (const code of API_CODES) expect(ssoErrorMessage(code), code).toBeTruthy();
    expect(Object.keys(SSO_ERROR_MESSAGES).sort()).toEqual([...API_CODES].sort());
  });

  it("tells somebody with no account to ask their admin for an invite", () => {
    expect(ssoErrorMessage("not_provisioned")).toMatch(/ask your (workspace )?admin.*invit/i);
  });

  it("says a cancelled sign-in is not an error to worry about", () => {
    expect(ssoErrorMessage("cancelled")).toMatch(/cancel/i);
  });

  it("says nothing when there is no code", () => {
    expect(ssoErrorMessage(null)).toBeNull();
    expect(ssoErrorMessage("")).toBeNull();
  });

  it("never echoes an unknown value from the URL onto the page", () => {
    const injected = "<img src=x onerror=alert(1)>";
    const message = ssoErrorMessage(injected);
    expect(message).toBe(SSO_ERROR_MESSAGES.failed);
    expect(message).not.toContain("img");
  });

  it("does not treat inherited object keys as codes", () => {
    expect(ssoErrorMessage("constructor")).toBe(SSO_ERROR_MESSAGES.failed);
    expect(ssoErrorMessage("__proto__")).toBe(SSO_ERROR_MESSAGES.failed);
  });
});
