/**
 * WHAT: `requirePlatformAdmin` — the platform-admin equivalent of middleware/auth.ts#requireAuth.
 * WHY: the `/platform-admin` console (org lifecycle, plan tiers, cross-org analytics) must never
 * be reachable by a tenant user's credentials, even a compromised SUPER_ADMIN's — so this
 * verifies against a completely separate token secret, session table (`PlatformAdminSession`),
 * and user table (`PlatformAdminUser`, which doesn't exist in any tenant database at all).
 * HOW: same shape as tenant `requireAuth` (verify JWT, check session not revoked, load the
 * admin row) but every dependency is the control-plane's own — see
 * utils/platform-admin-security.ts for why the signing secret is deliberately distinct.
 * WHO calls this: every route in controllers/platform-admin.controller.ts.
 */
import type { NextFunction, Request, Response } from "express";
import { controlPrisma } from "../config/control-prisma.js";
import { verifyPlatformAdminAccessToken } from "../utils/platform-admin-security.js";
import { AppError } from "./error.js";

export interface PlatformAdminRequestUser {
  id: string;
  name: string;
  email: string;
}

declare global {
  namespace Express {
    interface Request {
      platformAdmin?: PlatformAdminRequestUser;
      platformAdminSessionId?: string;
    }
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Same shape as middleware/auth.ts#requireAuth, but against PlatformAdminUser/Session and a
 *  completely separate signing secret — see utils/platform-admin-security.ts's header comment. */
export async function requirePlatformAdmin(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) throw new AppError(401, "Authentication required");

  let payload: { sub?: unknown; sid?: unknown };
  try {
    payload = verifyPlatformAdminAccessToken(token);
  } catch {
    throw new AppError(401, "Session expired");
  }

  if (typeof payload.sub !== "string" || !UUID_RE.test(payload.sub)) throw new AppError(401, "Invalid session");
  if (typeof payload.sid !== "string" || !UUID_RE.test(payload.sid)) throw new AppError(401, "Invalid session");

  const session = await controlPrisma.platformAdminSession.findUnique({ where: { id: payload.sid }, select: { revokedAt: true } });
  if (!session || session.revokedAt) throw new AppError(401, "Session revoked");

  const admin = await controlPrisma.platformAdminUser.findUnique({ where: { id: payload.sub } });
  if (!admin || admin.status !== "ACTIVE") throw new AppError(401, "Invalid session");

  req.platformAdmin = { id: admin.id, name: admin.name, email: admin.email };
  req.platformAdminSessionId = payload.sid;
  next();
}
