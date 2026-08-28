/**
 * Auth for the platform-admin console — structurally mirrors services/auth.service.ts's
 * login/refresh (same rotation-with-grace-period model, see that file's header comments for
 * the full rationale) but against controlPrisma.platformAdminUser/platformAdminSession
 * instead of a tenant's prisma.user/session. Deliberately NOT unified into one generic
 * "auth service" — platform admins have no tenant, no roles/permissions, and live entirely
 * outside tenant-context.ts, so sharing code here would mean threading "is this a tenant user
 * or a platform admin" through every line of the tenant auth path for no real benefit.
 */
import { controlPrisma } from "../config/control-prisma.js";
import { env } from "../config/env.js";
import { AppError } from "../middleware/error.js";
import { hashPassword, hashToken, opaqueToken, verifyPassword, verifyTokenHash } from "../utils/security.js";
import {
  signPlatformAdminAccessToken,
  signPlatformAdminRefreshToken,
  verifyPlatformAdminRefreshToken
} from "../utils/platform-admin-security.js";

const REFRESH_GRACE_PERIOD_MS = 30_000;

async function establishSession(adminUserId: string, opts: { userAgent?: string; ipAddress?: string }) {
  const days = env.REFRESH_TOKEN_TTL_DAYS;
  const refreshSecret = opaqueToken();
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const session = await controlPrisma.platformAdminSession.create({
    data: { adminUserId, refreshHash: await hashToken(refreshSecret), userAgent: opts.userAgent, ipAddress: opts.ipAddress, expiresAt }
  });
  return {
    accessToken: signPlatformAdminAccessToken(adminUserId, session.id),
    refreshToken: `${signPlatformAdminRefreshToken(adminUserId, session.id, days)}.${refreshSecret}`,
    refreshTokenExpiresAt: expiresAt
  };
}

/**
 * The password prisma/control/seed.ts gives the bootstrap platform admin. It is in the repository,
 * so it is in every fork, every CI log and this README — knowing it here removes no secrecy that
 * was ever there. It exists so the console can tell an operator "you are still on the seeded
 * password" without a schema change: the check is one bcrypt compare at sign-in, not a column.
 */
// eslint-disable-next-line sonarjs/no-hardcoded-passwords -- the public bootstrap value, detected, never granted
export const SEEDED_PLATFORM_ADMIN_PASSWORD = "PlatformAdmin@12345";

/** True when this hash still verifies the seeded bootstrap password. Cheap (one compare) and
 *  only ever evaluated for an already-authenticated admin, so it leaks nothing to a caller. */
export async function usesSeededPassword(passwordHash: string): Promise<boolean> {
  return verifyPassword(SEEDED_PLATFORM_ADMIN_PASSWORD, passwordHash);
}

export async function platformAdminLogin(email: string, password: string, userAgent?: string, ipAddress?: string) {
  const admin = await controlPrisma.platformAdminUser.findUnique({ where: { email } });
  if (!admin || admin.status !== "ACTIVE" || !(await verifyPassword(password, admin.passwordHash))) {
    throw new AppError(401, "Invalid email or password");
  }

  const session = await establishSession(admin.id, { userAgent, ipAddress });
  await controlPrisma.platformAdminUser.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } });

  return {
    ...session,
    admin: { id: admin.id, name: admin.name, email: admin.email, usingSeededPassword: await usesSeededPassword(admin.passwordHash) }
  };
}

/**
 * A platform admin choosing their own password. Mirrors auth.service.ts#changePassword: the
 * current password is re-verified even though the caller is already authenticated (a walked-away
 * console must not be enough to lock its owner out), and every OTHER session is revoked so a
 * rotation done because a credential leaked actually ends the leak. The session doing the
 * changing survives — signing the operator out of the very console they are hardening would
 * read as a failure.
 */
export async function changePlatformAdminPassword(adminId: string, currentSessionId: string, currentPassword: string, nextPassword: string) {
  const admin = await controlPrisma.platformAdminUser.findUnique({ where: { id: adminId } });
  if (!admin || admin.status !== "ACTIVE") throw new AppError(401, "Invalid session");
  if (!(await verifyPassword(currentPassword, admin.passwordHash))) throw new AppError(400, "Current password is incorrect");
  // Seeded check first: an operator still ON the seeded password who types it again would otherwise
  // be told "same as current", which is true but not the reason that matters.
  if (nextPassword === SEEDED_PLATFORM_ADMIN_PASSWORD) throw new AppError(400, "That is the seeded bootstrap password — choose your own");
  if (currentPassword === nextPassword) throw new AppError(400, "Choose a password you have not used here before");

  await controlPrisma.platformAdminUser.update({ where: { id: adminId }, data: { passwordHash: await hashPassword(nextPassword) } });
  const revoked = await controlPrisma.platformAdminSession.updateMany({
    where: { adminUserId: adminId, revokedAt: null, id: { not: currentSessionId } },
    data: { revokedAt: new Date() }
  });
  return { otherSessionsRevoked: revoked.count };
}

export async function platformAdminRefresh(refreshToken: unknown) {
  if (typeof refreshToken !== "string" || refreshToken.length === 0) {
    throw new AppError(401, "Missing refresh token");
  }

  const lastDot = refreshToken.lastIndexOf(".");
  if (lastDot < 0) throw new AppError(401, "Malformed refresh token");
  const jwtPart = refreshToken.slice(0, lastDot);
  const secret = refreshToken.slice(lastDot + 1);
  if (!jwtPart || !secret) throw new AppError(401, "Malformed refresh token");

  let payload: { sub: string; sid: string };
  try {
    payload = verifyPlatformAdminRefreshToken(jwtPart);
  } catch (error) {
    const name = (error as Error).name;
    if (name === "TokenExpiredError") throw new AppError(401, "Refresh token expired");
    throw new AppError(401, "Invalid refresh token");
  }
  if (!payload?.sid || !payload?.sub) throw new AppError(401, "Invalid refresh token");

  const session = await controlPrisma.platformAdminSession.findUnique({ where: { id: payload.sid } });
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
      await controlPrisma.platformAdminSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
      throw new AppError(401, "Invalid refresh token");
    }
  }

  const newSecret = opaqueToken();
  await controlPrisma.platformAdminSession.update({
    where: { id: session.id },
    data: matchesCurrent
      ? { previousRefreshHash: session.refreshHash, refreshHash: await hashToken(newSecret), refreshRotatedAt: new Date() }
      : { refreshHash: await hashToken(newSecret) }
  });

  const remainingDays = Math.max(1 / 24, (session.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000));

  return {
    accessToken: signPlatformAdminAccessToken(payload.sub, session.id),
    refreshToken: `${signPlatformAdminRefreshToken(payload.sub, session.id, remainingDays)}.${newSecret}`,
    refreshTokenExpiresAt: session.expiresAt
  };
}
