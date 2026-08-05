/**
 * WHAT: password hashing (bcrypt) and access/refresh JWT sign/verify helpers for **tenant**
 * auth — the platform-admin equivalent lives separately in utils/platform-admin-security.ts,
 * deliberately never sharing a secret or a function with this file.
 * WHY: every login method (password, Google/Microsoft/SAML/LDAP SSO) ends at the same
 * `establishSession()` in services/auth.service.ts, which needs one consistent way to mint
 * tokens — this file is that one way.
 * HOW: `AccessTokenPayload` carries `sid` (session id, so a single-device logout takes effect
 * immediately rather than waiting for token expiry) and `org` (cross-checked by
 * middleware/auth.ts against the tenant the request resolved to) — both optional, for backward
 * compatibility with tokens minted before those claims existed. Algorithm is pinned to HS256 on
 * both sign and verify, never inferred from the token itself (defends against the classic
 * "alg: none" JWT vulnerability class).
 * WHO calls this: `services/auth.service.ts` (mint), `middleware/auth.ts` (verify).
 */
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
  /** Organization id (control-plane Organization.id) this session belongs to — lets requireAuth
   *  cross-check a token against the tenant the current request actually resolved to, so a
   *  token minted under one org can't be replayed against another even though every org
   *  currently shares the same JWT_ACCESS_SECRET. Optional for backward compatibility with
   *  tokens issued before Phase B3 (the multi-tenancy work) added this claim. */
  org?: string;
}

export function signAccessToken(userId: string, sessionId: string, orgId?: string) {
  return jwt.sign({ sid: sessionId, org: orgId }, env.JWT_ACCESS_SECRET, {
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
export function signRefreshToken(userId: string, sessionId: string, days: number = env.REFRESH_TOKEN_TTL_DAYS, orgId?: string) {
  return jwt.sign({ sid: sessionId, org: orgId }, env.JWT_REFRESH_SECRET, {
    subject: userId,
    expiresIn: Math.max(60, Math.round(days * 24 * 60 * 60)),
    algorithm: JWT_ALGORITHM,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE
  });
}

export function verifyRefreshToken(token: string): { sub: string; sid: string; org?: string } {
  return jwt.verify(token, env.JWT_REFRESH_SECRET, {
    algorithms: [JWT_ALGORITHM],
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE
  }) as { sub: string; sid: string; org?: string };
}
