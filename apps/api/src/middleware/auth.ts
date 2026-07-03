import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
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
    }
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) throw new AppError(401, "Authentication required");

  let payload: { sub?: unknown };
  try {
    payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as { sub?: unknown };
  } catch {
    throw new AppError(401, "Session expired");
  }

  // Validate sub is a UUID before sending to Prisma — otherwise a forged token
  // with `sub: "garbage"` triggers a Prisma error → uncaught 500 leak.
  if (typeof payload.sub !== "string" || !UUID_RE.test(payload.sub)) {
    throw new AppError(401, "Invalid session");
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
