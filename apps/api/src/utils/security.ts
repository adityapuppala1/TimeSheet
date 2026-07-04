import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { nanoid } from "nanoid";
import { env } from "../config/env.js";

export const hashPassword = (password: string) => bcrypt.hash(password, 12);
export const verifyPassword = (password: string, hash: string) => bcrypt.compare(password, hash);
export const opaqueToken = () => nanoid(48);
export const hashToken = (token: string) => bcrypt.hash(token, 10);
export const verifyTokenHash = (token: string, hash: string) => bcrypt.compare(token, hash);

/** Fixed issuer/audience pair so a token minted for a different purpose (or a different
 *  deployment sharing the same secret by mistake) can't be replayed here. */
const JWT_ISSUER = "timesphere-api";
const JWT_AUDIENCE = "timesphere-app";
/** Pinned explicitly on both sign and verify — never let the algorithm be inferred from the
 *  token itself (the classic "alg: none" / algorithm-confusion class of JWT vulnerabilities). */
export const JWT_ALGORITHM = "HS256" as const;

export interface AccessTokenPayload {
  sub: string;
  /** Session id — lets requireAuth check this specific session hasn't been revoked (e.g. by a
   *  single-device logout), not just that the user account overall is still active. Optional
   *  only for backward compatibility with access tokens issued before this claim existed. */
  sid?: string;
}

export function signAccessToken(userId: string, sessionId: string) {
  return jwt.sign({ sid: sessionId }, env.JWT_ACCESS_SECRET, {
    subject: userId,
    expiresIn: env.ACCESS_TOKEN_TTL as jwt.SignOptions["expiresIn"],
    algorithm: JWT_ALGORITHM,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, env.JWT_ACCESS_SECRET, {
    algorithms: [JWT_ALGORITHM],
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE
  }) as AccessTokenPayload;
}

/** `days` may be fractional (e.g. remaining time on an existing session after a rotation) — jsonwebtoken accepts seconds as a plain number. */
export function signRefreshToken(userId: string, sessionId: string, days: number = env.REFRESH_TOKEN_TTL_DAYS) {
  return jwt.sign({ sid: sessionId }, env.JWT_REFRESH_SECRET, {
    subject: userId,
    expiresIn: Math.max(60, Math.round(days * 24 * 60 * 60)),
    algorithm: JWT_ALGORITHM,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE
  });
}

export function verifyRefreshToken(token: string): { sub: string; sid: string } {
  return jwt.verify(token, env.JWT_REFRESH_SECRET, {
    algorithms: [JWT_ALGORITHM],
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE
  }) as { sub: string; sid: string };
}
