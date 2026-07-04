import type { NextFunction, Request, Response } from "express";
import { prisma } from "../config/prisma.js";
import { verifyAccessToken } from "../utils/security.js";
import { AppError } from "./error.js";

export interface RequestUser {
  id: string;
  name: string;
  email: string;
  role: string;
  permissions: string[];
}

declare global {
  namespace Express {
    interface Request {
      user?: RequestUser;
      /** The access token's session id, when present (see utils/security.ts#AccessTokenPayload). */
      sessionId?: string;
    }
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) throw new AppError(401, "Authentication required");

  let payload: { sub?: unknown; sid?: unknown };
  try {
    payload = verifyAccessToken(token);
  } catch {
    throw new AppError(401, "Session expired");
  }

  // Validate sub is a UUID before sending to Prisma — otherwise a forged token
  // with `sub: "garbage"` triggers a Prisma error → uncaught 500 leak.
  if (typeof payload.sub !== "string" || !UUID_RE.test(payload.sub)) {
    throw new AppError(401, "Invalid session");
  }

  // Access tokens minted after the session-management hardening pass carry a `sid` claim,
  // so a single-device logout (which revokes that one Session row) takes effect immediately
  // instead of waiting up to ACCESS_TOKEN_TTL for the token to expire on its own. Tokens
  // issued before this change simply have no `sid` and skip this extra check.
  if (typeof payload.sid === "string") {
    const session = await prisma.session.findUnique({ where: { id: payload.sid }, select: { revokedAt: true } });
    if (!session || session.revokedAt) throw new AppError(401, "Session revoked");
    req.sessionId = payload.sid;
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    include: { role: { include: { permissions: { include: { permission: true } } } } }
  });
  if (!user || user.deletedAt || user.status !== "ACTIVE") throw new AppError(401, "Invalid session");
  req.user = {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role.name,
    permissions: user.role.permissions.map((p) => p.permission.key)
  };
  next();
}

export function requirePermission(permission: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user?.permissions.includes(permission)) throw new AppError(403, "Forbidden");
    next();
  };
}

export function requireRole(allowed: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user || !allowed.includes(req.user.role)) throw new AppError(403, "Forbidden");
    next();
  };
}

export const requireSuperAdmin = requireRole(["SUPER_ADMIN"]);
