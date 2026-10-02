/**
 * WHAT: the small, fixed vocabulary an SSO failure is reported in — `?sso_error=<code>` on the
 * workspace's login page — and the one function that turns a thrown error into it.
 *
 * WHY A CODE AND NOT THE MESSAGE. The SSO callback and ACS routes run on the API host, outside the
 * SPA, and used to hand every failure to the JSON error handler: a person who cancelled at Google,
 * hit the seat limit or arrived during maintenance was left looking at `{"message":...}` on a bare
 * API URL with no way back (audit M3, auth #18). They now redirect to their workspace's login page,
 * and the page says something useful. A CODE, because the URL is visible, bookmarkable and logged by
 * every proxy in between — it must carry nothing but which of ten things went wrong. The words live in
 * the SPA (apps/web/src/lib/sso-error.ts), keyed on the same strings.
 *
 * Mapping prefers the explicit `AppError.code` an SSO path set; status codes are the fallback for
 * errors raised by shared code (the seat limit, the maintenance gate, the agent-identity guard).
 */
import { AppError } from "../middleware/error.js";

export const SSO_ERROR_CODES = [
  "cancelled",
  "expired",
  "email_unverified",
  "inactive",
  "seat_limit",
  "maintenance",
  "not_provisioned",
  "not_allowed",
  "config",
  "failed"
] as const;

export type SsoErrorCode = (typeof SSO_ERROR_CODES)[number];

/** `AppError.code` values SSO paths throw, and the redirect code each becomes. */
const BY_APP_CODE: Record<string, SsoErrorCode> = {
  SSO_EXPIRED: "expired",
  SSO_EMAIL_UNVERIFIED: "email_unverified",
  SSO_INACTIVE: "inactive",
  SSO_SEAT_LIMIT: "seat_limit",
  MAINTENANCE: "maintenance",
  SSO_NOT_PROVISIONED: "not_provisioned",
  SSO_NOT_ALLOWED: "not_allowed",
  SSO_CONFIG: "config"
};

export function ssoErrorCodeFor(error: unknown): SsoErrorCode {
  if (!(error instanceof AppError)) return "failed";
  const byCode = error.code ? BY_APP_CODE[error.code] : undefined;
  if (byCode) return byCode;
  if (error.statusCode === 402) return "seat_limit";
  if (error.statusCode === 403) return "not_allowed";
  // "isn't configured for this workspace" — a provider switched off between the button and the click.
  if (error.statusCode === 404) return "config";
  return "failed";
}

/**
 * What an IdP's own `?error=` on the OIDC callback means here. `access_denied` is the person pressing
 * Cancel (or declining consent) — an answer, not a fault, and it used to surface as a 500 with the
 * full callback URL in the server log. Anything else the provider reports is a failure on its side.
 */
export function ssoErrorCodeForProviderError(providerError: string): SsoErrorCode {
  return providerError === "access_denied" ? "cancelled" : "failed";
}
