/**
 * Small decisions the platform console makes that have to agree with the server, kept as plain
 * functions so they can be tested without rendering a page.
 *
 * NONE OF THIS IS THE AUTHORIZATION. The API decides; these only decide what the console shows
 * while it waits to be told.
 */

/** An account-level gate: something the operator must put right about their OWN account before the
 *  console admits them anywhere else. The server enforces it (middleware/platform-admin-auth.ts). */
export type ConsoleAccountGate = "password" | null;

/** The 403 `code` the API answers a gated request with, mapped to the gate it means. */
const GATE_CODES: Record<string, Exclude<ConsoleAccountGate, null>> = {
  PASSWORD_ROTATION_REQUIRED: "password"
};

/** Which gate the signed-in operator is behind, from what `/auth/me` and sign-in report. */
export function consoleAccountGate(admin: { mustChangePassword?: boolean } | undefined): ConsoleAccountGate {
  if (admin?.mustChangePassword) return "password";
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
  return typeof code === "string" ? (GATE_CODES[code] ?? null) : null;
}
