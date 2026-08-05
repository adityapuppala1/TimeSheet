/**
 * JWT signing/verification for the platform-admin console — deliberately its own module rather
 * than extending utils/security.ts's tenant token functions. Distinct secret
 * (PLATFORM_ADMIN_JWT_SECRET), distinct issuer/audience, and no `org` claim at all (a platform
 * admin isn't scoped to any one tenant) — a tenant access token and a platform-admin token
 * must never be mutually valid, even by accident.
 */
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { JWT_ALGORITHM } from "./security.js";

const ISSUER = "timesphere-platform-admin";
const AUDIENCE = "timesphere-platform-admin";

export interface PlatformAdminAccessTokenPayload {
  sub: string;
  sid: string;
}

export function signPlatformAdminAccessToken(adminUserId: string, sessionId: string) {
  return jwt.sign({ sid: sessionId }, env.PLATFORM_ADMIN_JWT_SECRET, {
    subject: adminUserId,
    expiresIn: env.ACCESS_TOKEN_TTL as jwt.SignOptions["expiresIn"],
    algorithm: JWT_ALGORITHM,
    issuer: ISSUER,
    audience: AUDIENCE
  });
}

export function verifyPlatformAdminAccessToken(token: string): PlatformAdminAccessTokenPayload {
  return jwt.verify(token, env.PLATFORM_ADMIN_JWT_SECRET, {
    algorithms: [JWT_ALGORITHM],
    issuer: ISSUER,
    audience: AUDIENCE
  }) as PlatformAdminAccessTokenPayload;
}

export function signPlatformAdminRefreshToken(adminUserId: string, sessionId: string, days: number) {
  return jwt.sign({ sid: sessionId }, env.PLATFORM_ADMIN_JWT_SECRET, {
    subject: adminUserId,
    expiresIn: Math.max(60, Math.round(days * 24 * 60 * 60)),
    algorithm: JWT_ALGORITHM,
    issuer: ISSUER,
    audience: AUDIENCE
  });
}

export function verifyPlatformAdminRefreshToken(token: string): { sub: string; sid: string } {
  return jwt.verify(token, env.PLATFORM_ADMIN_JWT_SECRET, {
    algorithms: [JWT_ALGORITHM],
    issuer: ISSUER,
    audience: AUDIENCE
  }) as { sub: string; sid: string };
}
