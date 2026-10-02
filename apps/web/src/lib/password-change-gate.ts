/**
 * WHAT: the SPA half of the mustChangePassword gate (security audit #11) — whether the signed-in
 * session is held at the forced change-password screen, and the checks that screen runs before it
 * submits.
 *
 * THE SERVER DECIDES. `passwordChangeRequired` arrives on `/auth/login` and `/auth/me`, true only for
 * a PASSWORD session whose password an admin set; requireAuth refuses everything else with 403
 * PASSWORD_CHANGE_REQUIRED while it holds. This module only reads that answer — a gate the browser
 * decided for itself would be one anyone could open with devtools.
 *
 * Read defensively rather than typed on `AuthUser`, because that type lives in packages/shared and
 * does not carry the field yet. Only an explicit `true` holds someone: an API that does not send the
 * field (SSO, or a build from before the gate) must never lock anybody out.
 */
export function isPasswordChangeRequired(user: unknown): boolean {
  return (user as { passwordChangeRequired?: unknown } | undefined)?.passwordChangeRequired === true;
}

/** The gate's refusal, recognised by its code — a bare 403 is an ordinary permission error. */
export function isPasswordChangeRequiredError(error: unknown): boolean {
  const err = error as { response?: { status?: number; data?: { code?: string } } } | undefined;
  return err?.response?.status === 403 && err.response.data?.code === "PASSWORD_CHANGE_REQUIRED";
}

/**
 * What is wrong with the new password before it is sent, or null. The server's policy (common
 * passwords, the 72-byte limit, the email address) is the authority and answers with its own message;
 * this only saves a round trip for the three mistakes a form can see.
 */
export function newPasswordProblem(current: string, next: string, confirm: string): string | null {
  if (next.length < 8) return "Use at least 8 characters.";
  if (next !== confirm) return "The two new passwords don't match.";
  if (next === current) return "That's the password you already have — choose a new one.";
  return null;
}
