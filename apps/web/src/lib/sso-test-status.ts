/**
 * How a recorded SSO connection test reads on the Single sign-on card.
 *
 * THREE OUTCOMES, NOT TWO. A Microsoft test can reach the tenant but can never verify the client ID or
 * secret (Azure answers a probe before it looks at them), and it used to be stored as PASS and shown as
 * "Last test passed" with a tick — a green light for a check that did not happen (audit L6). The API
 * now records it as UNVERIFIED. A Microsoft row stored as PASS before that change means exactly the
 * same thing, so it reads as unverified too.
 */
export type SsoTestOutcome = "passed" | "unverified" | "failed";

export const SSO_TEST_OUTCOME_LABEL: Record<SsoTestOutcome, string> = {
  passed: "Last test passed",
  unverified: "Configuration looks valid — credentials are verified on first sign-in",
  failed: "Last test failed"
};

export function ssoTestOutcome(provider: "google" | "microsoft" | "saml" | "ldap", status: string | null | undefined): SsoTestOutcome | null {
  if (!status) return null;
  if (status === "FAIL") return "failed";
  return status === "UNVERIFIED" || provider === "microsoft" ? "unverified" : "passed";
}
