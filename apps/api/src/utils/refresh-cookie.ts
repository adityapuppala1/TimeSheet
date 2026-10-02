/**
 * WHAT: the tenant refresh cookie's name and attributes, and the two ways it is cleared.
 *
 * WHY ITS OWN MODULE: the cookie is written by auth.controller.ts (login, LDAP, refresh, the SSO
 * handoff) and cleared both there and by a middleware app.ts mounts BEFORE tenant resolution — see
 * `clearRefreshCookieUpFront`. A clear only works when its name and path match the cookie that was
 * set, so the definition lives in one place both can import.
 *
 * WHY httpOnly AND THIS PATH: see auth.controller.ts's header — the refresh token is invisible to page
 * JavaScript, and the browser only attaches it to `/api/auth/*`.
 */
import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";

export const REFRESH_COOKIE = "refreshToken";
const REFRESH_COOKIE_PATH = "/api/auth";

/**
 * `persistent: false` is an unticked "Remember me" (security audit #14): the cookie gets NO Expires,
 * which makes it a browser-session cookie — closing the browser ends it, whatever the server-side
 * session's own expiry says. The default keeps the expiring cookie every SSO, LDAP and pre-existing
 * session has always had.
 */
export function refreshCookieOptions(expiresAt?: Date, persistent = true) {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: REFRESH_COOKIE_PATH,
    expires: persistent ? expiresAt : undefined
  };
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
}

/**
 * Mounted on `POST /api/auth/logout` AHEAD of tenant resolution (app.ts), so the Set-Cookie that
 * deletes the refresh cookie is already on the response if resolution then refuses the request — a
 * suspended or unknown workspace answers an error, and that error still carries the clear.
 *
 * Signing out must ALWAYS remove the credential from the browser (security audit #9). The route
 * itself clears it again, which is harmless: it is the same header.
 */
export function clearRefreshCookieUpFront(_req: Request, res: Response, next: NextFunction): void {
  clearRefreshCookie(res);
  next();
}
