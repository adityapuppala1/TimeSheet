/**
 * How a recorded SSO connection test reads on the Single sign-on card (audit L6).
 *
 * A Microsoft test cannot verify the client ID or secret — Azure answers before it looks at them — so
 * it was stored as PASS and shown as "Last test passed" with a tick, for a check that never happened.
 * The API now stores it as UNVERIFIED; rows written before that still say PASS, and a Microsoft PASS
 * can only ever have meant the same thing, so it reads as unverified too.
 */
import { describe, expect, it } from "vitest";
import { SSO_TEST_OUTCOME_LABEL, ssoTestOutcome } from "../../src/lib/sso-test-status";

describe("ssoTestOutcome", () => {
  it("shows a Microsoft result as 'configuration looks valid', never as passed", () => {
    expect(ssoTestOutcome("microsoft", "UNVERIFIED")).toBe("unverified");
    expect(SSO_TEST_OUTCOME_LABEL.unverified).toBe("Configuration looks valid — credentials are verified on first sign-in");
  });

  it("reads a Microsoft PASS stored before this change the same way", () => {
    expect(ssoTestOutcome("microsoft", "PASS")).toBe("unverified");
  });

  it("keeps a real pass a pass for the providers whose test does prove the credentials", () => {
    expect(ssoTestOutcome("google", "PASS")).toBe("passed");
    expect(ssoTestOutcome("ldap", "PASS")).toBe("passed");
    expect(ssoTestOutcome("saml", "PASS")).toBe("passed");
  });

  it("reports a failure as a failure, whoever the provider", () => {
    expect(ssoTestOutcome("microsoft", "FAIL")).toBe("failed");
    expect(ssoTestOutcome("google", "FAIL")).toBe("failed");
  });

  it("has nothing to show when no test has run", () => {
    expect(ssoTestOutcome("google", null)).toBeNull();
  });
});
