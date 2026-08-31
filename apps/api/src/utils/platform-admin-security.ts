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

/**
 * The half-authenticated token handed out between "your password was right" and "your second
 * factor was right".
 *
 * ITS OWN AUDIENCE, for the same reason the whole module has its own secret: a token minted for a
 * different purpose must never be replayable here. This one proves exactly one thing — that
 * somebody got this account's password right, moments ago — and `verifyPlatformAdminAccessToken`
 * pins `audience: AUDIENCE`, so presenting it as a Bearer token against any console route fails
 * verification rather than being trusted at reduced privilege.
 *
 * FIVE MINUTES, not the 15 an access token gets. It is a step in a sign-in somebody is stood in
 * front of, not a session; anything longer is a stolen password that stays half-usable while its
 * owner walks away from the screen.
 */
const MFA_AUDIENCE = "timesphere-platform-admin-mfa";
export const MFA_CHALLENGE_TTL_SECONDS = 300;

export function signPlatformAdminMfaChallenge(adminUserId: string) {
  return jwt.sign({ pur: "mfa" }, env.PLATFORM_ADMIN_JWT_SECRET, {
    subject: adminUserId,
    expiresIn: MFA_CHALLENGE_TTL_SECONDS,
    algorithm: JWT_ALGORITHM,
    issuer: ISSUER,
    audience: MFA_AUDIENCE
  });
}

export function verifyPlatformAdminMfaChallenge(token: string): { sub: string } {
  return jwt.verify(token, env.PLATFORM_ADMIN_JWT_SECRET, {
    algorithms: [JWT_ALGORITHM],
    issuer: ISSUER,
    audience: MFA_AUDIENCE
  }) as { sub: string };
}
