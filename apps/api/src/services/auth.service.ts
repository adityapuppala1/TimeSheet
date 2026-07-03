import jwt from "jsonwebtoken";
import { prisma } from "../config/prisma.js";
import { env } from "../config/env.js";
import { AppError } from "../middleware/error.js";
import { hashPassword, hashToken, opaqueToken, signAccessToken, signRefreshToken, verifyPassword } from "../utils/security.js";

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

export async function login(email: string, password: string, rememberMe = false, userAgent?: string, ipAddress?: string) {
  const user = await prisma.user.findUnique({
    where: { email },
    include: PROFILE_INCLUDE
  });
  if (!user || user.deletedAt || !(await verifyPassword(password, user.passwordHash))) {
    throw new AppError(401, "Invalid email or password");
  }
  if (user.status !== "ACTIVE") throw new AppError(403, "Account is not active");

  const refreshSecret = opaqueToken();
  const days = rememberMe ? 30 : env.REFRESH_TOKEN_TTL_DAYS;
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      refreshHash: await hashToken(refreshSecret),
      userAgent,
      ipAddress,
      expiresAt
    }
  });
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  return {
    accessToken: signAccessToken(user.id),
    refreshToken: `${signRefreshToken(user.id, session.id, days)}.${refreshSecret}`,
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
    payload = jwt.verify(jwtPart, env.JWT_REFRESH_SECRET) as { sub: string; sid: string };
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

  const bcrypt = await import("bcryptjs");
  if (!(await bcrypt.compare(secret, session.refreshHash))) {
    throw new AppError(401, "Invalid refresh token");
  }
  return { accessToken: signAccessToken(payload.sub) };
}

export async function changePassword(userId: string, currentPassword: string, nextPassword: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!(await verifyPassword(currentPassword, user.passwordHash))) throw new AppError(422, "Current password is incorrect");
  await prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(nextPassword) } });
}
