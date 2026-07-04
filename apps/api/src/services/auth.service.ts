import { prisma } from "../config/prisma.js";
import { env } from "../config/env.js";
import { AppError } from "../middleware/error.js";
import {
  hashPassword,
  hashToken,
  opaqueToken,
  signAccessToken,
  signRefreshToken,
  verifyPassword,
  verifyRefreshToken,
  verifyTokenHash
} from "../utils/security.js";

const PROFILE_INCLUDE = {
  role: { include: { permissions: { include: { permission: true } } } },
  manager: { select: { id: true, name: true, email: true } }
} as const;

export type ProfilePayload = {
  id: string;
  name: string;
  email: string;
  role: string;
  permissions: string[];
  avatarUrl: string | null;
  bio: string | null;
  phoneNumber: string | null;
  timezone: string | null;
  managerId: string | null;
  manager: { id: string; name: string; email: string } | null;
};

export async function buildProfilePayload(userId: string): Promise<ProfilePayload> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: PROFILE_INCLUDE
  });
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role.name,
    permissions: user.role.permissions.map((p) => p.permission.key),
    avatarUrl: user.avatarUrl,
    bio: user.bio,
    phoneNumber: user.phoneNumber,
    timezone: user.timezone,
    managerId: user.managerId,
    manager: user.manager ?? null
  };
}

/* ============================== Login lockout ============================== */

/**
 * Per-account failed-login counter, layered on top of the existing per-IP rate limiter
 * (app.ts's authLimiter). The IP limiter alone doesn't stop credential stuffing against one
 * specific known account from a botnet of different IPs; this does. In-memory by design —
 * same tradeoff as express-rate-limit's default store, acceptable at this app's scale (a
 * restart clears lockouts, which just means "worst case, an attacker gets a few more tries").
 */
const FAILED_LOGIN_LIMIT = 5;
const LOCKOUT_MS = 5 * 60 * 1000;
const failedLogins = new Map<string, { count: number; lockedUntil: number | null }>();

function checkAccountLockout(email: string) {
  const entry = failedLogins.get(email.toLowerCase());
  if (entry?.lockedUntil && entry.lockedUntil > Date.now()) {
    const minutesLeft = Math.ceil((entry.lockedUntil - Date.now()) / 60_000);
    throw new AppError(429, `Too many failed attempts. Try again in ${minutesLeft} minute${minutesLeft === 1 ? "" : "s"}.`);
  }
}

function recordFailedLogin(email: string) {
  const key = email.toLowerCase();
  const entry = failedLogins.get(key) ?? { count: 0, lockedUntil: null };
  entry.count += 1;
  if (entry.count >= FAILED_LOGIN_LIMIT) {
    entry.lockedUntil = Date.now() + LOCKOUT_MS;
    entry.count = 0;
  }
  failedLogins.set(key, entry);
}

function clearFailedLogins(email: string) {
  failedLogins.delete(email.toLowerCase());
}

/* ================================== Login =================================== */

export async function login(email: string, password: string, rememberMe = false, userAgent?: string, ipAddress?: string) {
  checkAccountLockout(email);

  const user = await prisma.user.findUnique({ where: { email }, include: PROFILE_INCLUDE });
  if (!user || user.deletedAt || !(await verifyPassword(password, user.passwordHash))) {
    recordFailedLogin(email);
    throw new AppError(401, "Invalid email or password");
  }
  if (user.status !== "ACTIVE") throw new AppError(403, "Account is not active");
  clearFailedLogins(email);

  const days = rememberMe ? 30 : env.REFRESH_TOKEN_TTL_DAYS;
  const refreshSecret = opaqueToken();
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const session = await prisma.session.create({
    data: { userId: user.id, refreshHash: await hashToken(refreshSecret), userAgent, ipAddress, expiresAt }
  });
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  return {
    accessToken: signAccessToken(user.id, session.id),
    refreshToken: `${signRefreshToken(user.id, session.id, days)}.${refreshSecret}`,
    refreshTokenExpiresAt: expiresAt,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role.name,
      permissions: user.role.permissions.map((p) => p.permission.key),
      avatarUrl: user.avatarUrl,
      bio: user.bio,
      phoneNumber: user.phoneNumber,
      timezone: user.timezone,
      managerId: user.managerId,
      manager: user.manager ?? null
    } satisfies ProfilePayload
  };
}

/* ============================ Refresh (rotating) ============================= */

/**
 * Rotates the refresh token on every use and detects reuse of an already-rotated secret —
 * the standard "refresh token rotation" defense: a stolen refresh token is only usable once
 * before the legitimate client's next refresh invalidates it, and if the *stolen* copy gets
 * used after that, the mismatch here is treated as a theft signal and the whole session is
 * revoked (forcing a fresh login) rather than just rejecting the one request.
 *
 * GRACE_PERIOD_MS exists because "any mismatch = theft" is too strict for real usage: the same
 * session cookie is shared across every tab of one browser, so two tabs racing a 401 at the
 * same moment both legitimately try to refresh with the same (about-to-be-stale) secret — one
 * wins the rotation, and without a grace window the other tab's presentation of the
 * now-previous secret would look identical to an attacker replaying a stolen token, and get
 * the whole session revoked out from under an innocent user. Allowing the immediately-prior
 * secret to keep working for a short window closes that false positive while still catching
 * real replay (a secret reused well after it was last rotated).
 *
 * The session's own `expiresAt` (set once at login, "remember me" 30d vs default 14d) is
 * never extended by rotation — that bounds how long a session can live in total regardless
 * of how often it's refreshed, rather than sliding forward forever on activity.
 */
const REFRESH_GRACE_PERIOD_MS = 30_000;

export async function refresh(refreshToken: unknown) {
  if (typeof refreshToken !== "string" || refreshToken.length === 0) {
    throw new AppError(401, "Missing refresh token");
  }

  // The refresh token is `<JWT>.<opaque-secret>` — and the JWT itself contains
  // two dots (header.payload.signature). Split on the LAST dot to peel off the
  // opaque secret without slicing the JWT in half.
  const lastDot = refreshToken.lastIndexOf(".");
  if (lastDot < 0) throw new AppError(401, "Malformed refresh token");
  const jwtPart = refreshToken.slice(0, lastDot);
  const secret = refreshToken.slice(lastDot + 1);
  if (!jwtPart || !secret) throw new AppError(401, "Malformed refresh token");

  let payload: { sub: string; sid: string };
  try {
    payload = verifyRefreshToken(jwtPart);
  } catch (error) {
    const name = (error as Error).name;
    if (name === "TokenExpiredError") throw new AppError(401, "Refresh token expired");
    throw new AppError(401, "Invalid refresh token");
  }

  if (!payload?.sid || !payload?.sub) throw new AppError(401, "Invalid refresh token");

  const session = await prisma.session.findUnique({ where: { id: payload.sid } });
  if (!session || session.revokedAt || session.expiresAt < new Date()) {
    throw new AppError(401, "Refresh token expired");
  }

  const matchesCurrent = await verifyTokenHash(secret, session.refreshHash);
  if (!matchesCurrent) {
    const withinGracePeriod =
      session.previousRefreshHash &&
      session.refreshRotatedAt &&
      Date.now() - session.refreshRotatedAt.getTime() < REFRESH_GRACE_PERIOD_MS;
    const matchesPrevious = withinGracePeriod && (await verifyTokenHash(secret, session.previousRefreshHash!));

    if (!matchesPrevious) {
      // Doesn't match the current secret, and either there's no grace window or it doesn't
      // match the previous one either — this isn't a benign race, it's a stale/stolen secret
      // being replayed. Kill the session so the legitimate owner is forced to log in again.
      await prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
      throw new AppError(401, "Invalid refresh token");
    }
  }

  const newSecret = opaqueToken();
  await prisma.session.update({
    where: { id: session.id },
    data: matchesCurrent
      ? // First rotation off this secret: anchor a new grace window to it.
        { previousRefreshHash: session.refreshHash, refreshHash: await hashToken(newSecret), refreshRotatedAt: new Date() }
      : // A grace-period replay of the already-rotated-away secret (a second tab, a retried
        // request, or — in this codebase's Playwright suite — a frozen storageState snapshot
        // reused by several independent test contexts). Hand back a fresh secret so the
        // caller keeps working, but deliberately leave previousRefreshHash/refreshRotatedAt
        // untouched: the grace window stays anchored to the FIRST rotation rather than
        // sliding forward on every replay, so it can't be kept alive indefinitely.
        { refreshHash: await hashToken(newSecret) }
  });

  const remainingDays = Math.max(1 / 24, (session.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000));

  return {
    accessToken: signAccessToken(payload.sub, session.id),
    refreshToken: `${signRefreshToken(payload.sub, session.id, remainingDays)}.${newSecret}`,
    refreshTokenExpiresAt: session.expiresAt
  };
}

/* ============================== Password change ============================== */

export async function changePassword(userId: string, currentPassword: string, nextPassword: string, currentSessionId?: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!(await verifyPassword(currentPassword, user.passwordHash))) throw new AppError(422, "Current password is incorrect");
  await prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(nextPassword) } });
  // Revoke every other session — a password change is exactly the moment to assume any
  // other active session might belong to someone who shouldn't have access anymore.
  await prisma.session.updateMany({
    where: { userId, revokedAt: null, ...(currentSessionId ? { id: { not: currentSessionId } } : {}) },
    data: { revokedAt: new Date() }
  });
}

/* ============================== Password reset ============================== */

const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

/** Always succeeds from the caller's point of view (no user enumeration) — only actually creates a token + sends mail if the email matches a real, active account. */
export async function requestPasswordReset(email: string): Promise<{ resetUrl: string; user: { id: string; name: string; email: string } } | null> {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || user.deletedAt || user.status !== "ACTIVE") return null;

  const rawToken = opaqueToken();
  await prisma.passwordResetToken.create({
    data: { userId: user.id, tokenHash: await hashToken(rawToken), expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS) }
  });

  const resetUrl = `${env.APP_BASE_URL.replace(/\/$/, "")}/reset-password?token=${encodeURIComponent(rawToken)}`;
  return { resetUrl, user: { id: user.id, name: user.name, email: user.email } };
}

export async function resetPassword(rawToken: string, nextPassword: string): Promise<void> {
  if (!rawToken) throw new AppError(422, "Reset token is required");

  // tokenHash is bcrypt (per-row salt), so it can't be looked up by an equality query — pull
  // the bounded set of not-yet-used, not-yet-expired candidates and compare in application code.
  const candidates = await prisma.passwordResetToken.findMany({
    where: { usedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
    take: 500
  });

  let match: (typeof candidates)[number] | null = null;
  for (const candidate of candidates) {
    if (await verifyTokenHash(rawToken, candidate.tokenHash)) {
      match = candidate;
      break;
    }
  }
  if (!match) throw new AppError(422, "This reset link is invalid or has expired.");

  await prisma.$transaction([
    prisma.passwordResetToken.update({ where: { id: match.id }, data: { usedAt: new Date() } }),
    prisma.user.update({ where: { id: match.userId }, data: { passwordHash: await hashPassword(nextPassword) } }),
    prisma.session.updateMany({ where: { userId: match.userId, revokedAt: null }, data: { revokedAt: new Date() } })
  ]);
}
