/**
 * WHAT: the per-request Origin rule (config/origins.ts#isOriginAllowedForHost) bound to this
 * deployment's configuration — used by the CORS middleware in app.ts, and again by the two routes
 * that answer with a credential read from a cookie: `/auth/refresh` and `/auth/sso/handoff`.
 *
 * WHY THE ROUTES CHECK IT TOO (security audit #13). Both hand back an access token on the strength
 * of the refresh cookie (or a one-time code), so "a page on another workspace may not call them" is
 * the property that matters most there. The CORS middleware already refuses such a request before
 * any route runs; checking again here means the property survives somebody re-ordering or narrowing
 * that middleware. A request with no Origin header is not cross-origin and passes, as it always has.
 */
import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";
import { isVerifiedCustomDomain } from "../config/custom-domain-origins.js";
import { isOriginAllowedForHost } from "../config/origins.js";
import { AppError } from "./error.js";

/** `WEB_ORIGIN` may be a comma-separated list (e.g. `http://localhost:5173,http://192.168.1.10:5173`). */
export function webOriginAllowList(): string[] {
  return env.WEB_ORIGIN.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function requestOriginAllowed(origin: string | undefined, hostHeader: string | undefined): boolean {
  return isOriginAllowedForHost(origin, hostHeader, webOriginAllowList(), env.NODE_ENV !== "production", env.ROOT_DOMAIN, isVerifiedCustomDomain);
}

export function requireAllowedOrigin(req: Request, _res: Response, next: NextFunction): void {
  if (!requestOriginAllowed(req.headers.origin, req.headers.host)) {
    throw new AppError(403, "This sign-in request came from a page this workspace does not trust.");
  }
  next();
}
