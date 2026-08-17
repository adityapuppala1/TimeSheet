/**
 * WHAT: the long-lived, opaque "which browser is this?" cookie that lets one device hold one
 * session row instead of accumulating one per sign-in.
 *
 * THE PROBLEM IT SOLVES: `establishSession` used to INSERT a `Session` on every login, and
 * nothing ever collapsed or reaped them. Measured on the development workspace: 7,486 live
 * sessions for a single user, 6,952 of them carrying the identical Chrome-on-Windows user-agent
 * string — one person, one machine, thousands of "active devices". The Profile page's session
 * list and the admin's who's-online panel both read that table, so the feature whose entire job
 * is "spot the session that shouldn't be there" was drowned by its own noise.
 *
 * ── WHAT THIS IS NOT ─────────────────────────────────────────────────────────────────────────
 *
 * IT IS NOT AN AUTHENTICATOR, and nothing may ever treat it as one. It carries no claim about
 * who the holder is; it only says "requests carrying this value probably came from the same
 * browser". Every session is matched on (userId, deviceId) AND the user-agent string, and the
 * match only ever happens AFTER credentials have been verified — so forging, copying or clearing
 * this cookie buys an attacker nothing they did not already have. The worst a bad value can do
 * is fail to match, which falls back to the old behaviour: a new row.
 *
 * That is also why it is not signed or HMAC'd. A signature would imply the value is trusted for
 * something, and it is not; the honest design is an opaque random string with no authority.
 *
 * ── THE COOKIE ATTRIBUTES ────────────────────────────────────────────────────────────────────
 *
 * `httpOnly` — page JS has no reason to read it, and keeping it out of reach means an XSS payload
 * cannot use it to fingerprint the browser or to correlate the user's sessions.
 * `path=/api/auth` — the only routes that read it are login (`/api/auth/login`, `/login/ldap`)
 * and the SSO callbacks (`/api/auth/sso/*`), all of which sit under this prefix. Scoping it here
 * keeps it off every other request rather than riding along on all of them.
 * `sameSite=lax` — matches the refresh cookie, and is required for the SSO callback, which
 * arrives as a top-level cross-site redirect from the identity provider.
 * 400 days — the browser ceiling for cookie lifetime (Chrome and Safari both clamp to it), so
 * asking for more would be a value that silently isn't honoured.
 */
import type { Request, Response } from "express";
import { env } from "../config/env.js";
import { opaqueToken } from "./security.js";

const DEVICE_COOKIE = "deviceId";

/** The browser ceiling. Anything larger is silently clamped, so this is the honest maximum. */
const DEVICE_COOKIE_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;

/** Matches `Session.deviceId`'s column width. A value longer than the column would be truncated
 *  on write and then never match on read — a silent, permanent "always a new row". */
const MAX_DEVICE_ID_LENGTH = 64;

/**
 * The device id for this request, or a freshly minted one.
 *
 * Returns `{ deviceId, isNew }` so the caller knows whether to set the cookie — re-setting it on
 * every login would push the 400-day expiry forward each time, which is fine, but skipping the
 * write when nothing changed keeps the response smaller and the intent clearer.
 *
 * A malformed or oversized value is DISCARDED rather than trusted or truncated: truncating would
 * silently merge two devices whose ids share a prefix, and this is client-supplied input whose
 * only job is to match an opaque string we generated.
 */
export function resolveDeviceId(req: Request): { deviceId: string; isNew: boolean } {
  const raw = (req.cookies?.[DEVICE_COOKIE] as string | undefined)?.trim();
  const usable = raw && raw.length <= MAX_DEVICE_ID_LENGTH && /^[A-Za-z0-9_-]+$/.test(raw);
  return usable ? { deviceId: raw, isNew: false } : { deviceId: opaqueToken().slice(0, MAX_DEVICE_ID_LENGTH), isNew: true };
}

/** Writes the cookie. Safe to call unconditionally; callers usually skip it when `isNew` is
 *  false, purely to avoid a redundant `Set-Cookie` header. */
export function setDeviceCookie(res: Response, deviceId: string): void {
  res.cookie(DEVICE_COOKIE, deviceId, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/auth",
    maxAge: DEVICE_COOKIE_MAX_AGE_MS
  });
}

/**
 * One call for the whole pattern: read (or mint) the id, and set the cookie when it is new.
 *
 * Every login path needs exactly this, and having each of them re-derive it is how one of them
 * eventually forgets — which would look like "sessions still multiply, but only for SSO users".
 */
export function attachDeviceId(req: Request, res: Response): string {
  const { deviceId, isNew } = resolveDeviceId(req);
  if (isNew) setDeviceCookie(res, deviceId);
  return deviceId;
}
