/**
 * The words for `?sso_error=<code>` on the login page.
 *
 * Every SSO failure — a cancelled Google prompt, an expired link, the seat limit, maintenance, an
 * account that does not exist yet — used to end as raw JSON on the API's own host. The API now
 * redirects to this workspace's login page with one of a fixed set of codes
 * (apps/api/src/utils/sso-error-code.ts), and this file is where they become a sentence a person can
 * act on. The two lists must stay in step; tests/unit/sso-error.test.ts mirrors the API's.
 *
 * NEVER ECHO THE PARAMETER. It comes off the URL, so anyone can put anything in it and send the link
 * to someone. An unknown value reads as the generic message, and the lookup is an own-property check
 * so `?sso_error=constructor` is not a code either.
 */
export const SSO_ERROR_MESSAGES = {
  cancelled: "Sign-in was cancelled at your identity provider. You can try again whenever you're ready.",
  expired: "That sign-in took too long or the link was already used. Please start again.",
  email_unverified:
    "Your identity provider hasn't verified the email address on your account, so it can't be used here. Verify it with your provider, or ask your workspace admin for help.",
  inactive: "Your account in this workspace isn't active. Ask your workspace admin to reactivate it.",
  seat_limit: "This workspace has used all of its seats, so a new account can't be created. Ask your workspace admin to free up or add a seat.",
  maintenance: "This workspace is undergoing scheduled maintenance. Please try again after the window ends.",
  not_provisioned: "You don't have an account in this workspace yet. Ask your workspace admin to send you an invite.",
  not_allowed: "This account isn't allowed to sign in to this workspace. Ask your workspace admin if you think that's wrong.",
  config: "Single sign-on isn't set up correctly for this workspace. Let your workspace admin know so they can check the settings.",
  failed: "Single sign-on didn't work this time. Please try again — if it keeps happening, let your workspace admin know."
} as const;

export type SsoErrorCode = keyof typeof SSO_ERROR_MESSAGES;

export function ssoErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return Object.hasOwn(SSO_ERROR_MESSAGES, code) ? SSO_ERROR_MESSAGES[code as SsoErrorCode] : SSO_ERROR_MESSAGES.failed;
}
