/**
 * WHAT: password hashing (bcrypt), access/refresh JWT sign/verify helpers for **tenant**
 * auth, and the one constant-time string comparison every shared-secret check in this app uses
 * — the platform-admin equivalent lives separately in utils/platform-admin-security.ts,
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
import { createHash, randomInt, timingSafeEqual } from "node:crypto";

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { nanoid } from "nanoid";
import { env } from "../config/env.js";

export const hashPassword = (password: string) => bcrypt.hash(password, 12);
export const verifyPassword = (password: string, hash: string) => bcrypt.compare(password, hash);
export const opaqueToken = () => nanoid(48);

/**
 * A constant bcrypt digest (cost 12, a throwaway sentinel) that `login` compares against when the
 * email is unknown — so a non-existent account costs the same one bcrypt round (~200ms) as a
 * wrong password on a real one. Without it, `verifyPassword` is short-circuited away entirely for
 * a missing user, and the reply returns in a few ms versus ~200ms for a real account: a timing
 * oracle that discloses which emails are registered, one guess at a time, straight through the
 * deliberately-identical "Invalid email or password". A precomputed literal (not a boot-time
 * `hashSync`) so importing this module — which every request path and most tests do — costs
 * nothing. The exact hash is irrelevant; only that comparing to it does a full cost-12 round.
 */
// Reviewed: this is a bcrypt DIGEST of an arbitrary, unrecorded value, not a credential — nobody's
// password hashes to it, and nothing is compromised by it being public. Its only job is to make
// bcrypt do the same amount of work it would for a real account.
// eslint-disable-next-line sonarjs/no-hardcoded-passwords -- timing-safety sentinel, not a secret
export const DUMMY_PASSWORD_HASH = "$2b$12$bCeTa7tNbMS12WtSV0Kb/.szOuSeRd4V6SHhkUr6yxEx3QgLjRQtG";

/**
 * A one-time password for admin resets: 12 chars from an unambiguous alphabet (no 0/O/1/l/I)
 * plus a fixed "!7a" tail so it clears any complexity rule without the generator needing to
 * know one. Replaces the old fixed "Admin@12345" default, which is publicly documented in this
 * repo — a default anyone who has read the README can type is not a password. `randomInt` is
 * the CSPRNG (and rejection-samples, so the alphabet is drawn uniformly).
 */
// Reviewed: a character SET the generator below draws from via a CSPRNG, not a password itself.
// eslint-disable-next-line sonarjs/no-hardcoded-passwords -- alphabet, not a credential
const TEMP_PASSWORD_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const generateTempPassword = () =>
  `${Array.from({ length: 12 }, () => TEMP_PASSWORD_ALPHABET[randomInt(TEMP_PASSWORD_ALPHABET.length)]).join("")}!7a`;
export const hashToken = (token: string) => bcrypt.hash(token, 10);
export const verifyTokenHash = (token: string, hash: string) => bcrypt.compare(token, hash);

/**
 * Constant-time equality for two secrets of possibly different lengths — compare SHA-256
 * digests, never the raw bytes.
 *
 * WHY NOT `a.length === b.length && timingSafeEqual(a, b)`: `timingSafeEqual` throws on a length
 * mismatch, so callers reach for a length pre-check — and that pre-check IS a side channel. It
 * answers "is my guess the right LENGTH?" in one request, which for a variable-length shared
 * secret (a SCIM/ingestion bearer token, a Google Chat verification token) hands an attacker the
 * search space for free. Hashing first makes both sides a fixed 32 bytes, so the comparison
 * always runs to completion and reveals nothing but the answer.
 *
 * Originally `safeEqual` in services/git-webhook-providers.ts; lives here so every shared-secret
 * comparison in the app is the same one implementation rather than a per-file re-derivation.
 */
export const constantTimeEqual = (a: string, b: string): boolean =>
  timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

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
