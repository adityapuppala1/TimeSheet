/**
 * Small decisions the platform console makes that have to agree with the server, kept as plain
 * functions so they can be tested without rendering a page.
 *
 * NONE OF THIS IS THE AUTHORIZATION. The API decides; these only decide what the console shows
 * while it waits to be told.
 */

/** An account-level gate: something the operator must put right about their OWN account before the
 *  console admits them anywhere else. The server enforces it (middleware/platform-admin-auth.ts). */
export type ConsoleAccountGate = "rotation" | "mfa" | null;

/** The 403 `code` the API answers a gated request with, as the gate it means. (A switch rather than
 *  a lookup object: sonarjs reads a `PASSWORD_…` key with a string value as a hard-coded password.) */
function gateForCode(code: string): ConsoleAccountGate {
  switch (code) {
    case "PASSWORD_ROTATION_REQUIRED":
      return "rotation";
    case "MFA_ENROLMENT_REQUIRED":
      return "mfa";
    default:
      return null;
  }
}

interface AccountFlags {
  mustChangePassword?: boolean;
  mfaEnrolmentRequired?: boolean;
  mfaEnabled?: boolean;
}

/**
 * Which gate the signed-in operator is behind, from what `/auth/me` and sign-in report. The
 * password comes first, exactly as on the server: a factor enrolled on top of a password somebody
 * else issued is bound to whoever saw that password.
 */
export function consoleAccountGate(admin: AccountFlags | undefined): ConsoleAccountGate {
  if (admin?.mustChangePassword) return "rotation";
  if (admin?.mfaEnrolmentRequired) return "mfa";
  return null;
}

/**
 * The gate a failed request was refused by, or null. Lets the console react to a gate the store did
 * not know about yet — a password flag set by somebody else while this tab was open — by re-reading
 * the account instead of showing a raw 403 on every card.
 */
export function accountGateFromError(error: unknown): ConsoleAccountGate {
  const response = (error as { response?: { status?: number; data?: { code?: unknown } } } | null)?.response;
  if (response?.status !== 403) return null;
  const code = response.data?.code;
  return typeof code === "string" ? gateForCode(code) : null;
}

/**
 * Whether a console write came back QUEUED (HTTP 202, the two-person rule) rather than done. The
 * queue's answer carries `pending: true` and a request id; a completed result never does. Pages
 * that used to read every 2xx as "done" told an operator a restore or a deletion had happened when
 * it was only waiting for a second owner.
 */
export function isQueuedForApproval(result: unknown): result is { pending: true; requestId: string; message: string } {
  return typeof result === "object" && result !== null && (result as { pending?: unknown }).pending === true && typeof (result as { requestId?: unknown }).requestId === "string";
}

/**
 * The temporary password an approval just issued, if it issued one — creating an operator, or
 * reactivating one. The server returns it to the APPROVER once and keeps only a hash; the approvals
 * page used to show a toast and throw it away, which left every new operator account unusable.
 */
export function issuedCredentialOf(approval: { action: string; result: unknown }): { email: string; name?: string; temporaryPassword: string } | null {
  const result = approval.result as { email?: unknown; name?: unknown; temporaryPassword?: unknown } | null;
  if (!result || typeof result.temporaryPassword !== "string" || typeof result.email !== "string") return null;
  return { email: result.email, ...(typeof result.name === "string" ? { name: result.name } : {}), temporaryPassword: result.temporaryPassword };
}

/**
 * How many workspaces are really in the retention programme: ones that had a trial and have NOT
 * converted. `plan.converted` is the server's isConverted (retention.service.ts); counting
 * `inProgramme` alone included paying customers who merely started as trials. Same rule as the
 * Overview's "In retention" figure, which the server computes.
 */
export function countInRetention(queue: ReadonlyArray<{ plan: { inProgramme: boolean; converted: boolean } }>): number {
  return queue.filter((row) => row.plan.inProgramme && !row.plan.converted).length;
}

/**
 * Whether the console-wide "set up two-factor" banner applies: an operator with no factor whom the
 * deployment does NOT force to enrol (a role it does not cover, or PLATFORM_ADMIN_REQUIRE_MFA off).
 * Quiet behind a gate, because the gate's own screen is already saying it.
 */
export function shouldNagForMfa(admin: AccountFlags | undefined): boolean {
  if (!admin || admin.mfaEnabled) return false;
  return consoleAccountGate(admin) === null;
}
