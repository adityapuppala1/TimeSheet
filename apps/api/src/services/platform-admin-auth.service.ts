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
import { hashToken, opaqueToken, verifyPassword, verifyTokenHash } from "../utils/security.js";
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

export async function platformAdminLogin(email: string, password: string, userAgent?: string, ipAddress?: string) {
  const admin = await controlPrisma.platformAdminUser.findUnique({ where: { email } });
  if (!admin || admin.status !== "ACTIVE" || !(await verifyPassword(password, admin.passwordHash))) {
    throw new AppError(401, "Invalid email or password");
  }

  const session = await establishSession(admin.id, { userAgent, ipAddress });
  await controlPrisma.platformAdminUser.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } });

  return { ...session, admin: { id: admin.id, name: admin.name, email: admin.email } };
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
