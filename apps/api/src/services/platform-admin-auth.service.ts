/**
 * Auth for the platform-admin console — structurally mirrors services/auth.service.ts's
 * login/refresh (same rotation-with-grace-period model, see that file's header comments for
 * the full rationale) but against controlPrisma.platformAdminUser/platformAdminSession
 * instead of a tenant's prisma.user/session. Deliberately NOT unified into one generic
 * "auth service" — platform admins have no tenant, no roles/permissions, and live entirely
 * outside tenant-context.ts, so sharing code here would mean threading "is this a tenant user
 * or a platform admin" through every line of the tenant auth path for no real benefit.
 */
import type { PlatformRole } from "@timesheet/shared";
import { controlPrisma } from "../config/control-prisma.js";
import { env } from "../config/env.js";
import { AppError } from "../middleware/error.js";
import { DUMMY_PASSWORD_HASH, hashPassword, hashToken, opaqueToken, verifyPassword, verifyTokenHash } from "../utils/security.js";
import { decryptSecret, encryptSecret } from "../utils/encryption.js";
import {
  MFA_CHALLENGE_TTL_SECONDS,
  signPlatformAdminAccessToken,
  signPlatformAdminMfaChallenge,
  signPlatformAdminRefreshToken,
  verifyPlatformAdminMfaChallenge,
  verifyPlatformAdminRefreshToken
} from "../utils/platform-admin-security.js";
import { generateRecoveryCodes, generateTotpSecret, normalizeRecoveryCode, totpAuthUri, verifyTotp } from "../utils/totp.js";

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

/** What `/auth/me`, a completed login and a completed challenge all report. `role` is included so
 *  the console can hide what this operator cannot use; it is NEVER the thing that authorises them
 *  — see middleware/platform-admin-auth.ts for why the server re-reads it every request. */
export interface PlatformAdminIdentity {
  id: string;
  name: string;
  email: string;
  role: PlatformRole;
  mfaEnabled: boolean;
  usingSeededPassword: boolean;
}

type AdminRow = { id: string; name: string; email: string; role: string; mfaEnabled: boolean; passwordHash: string };

async function identityOf(admin: AdminRow): Promise<PlatformAdminIdentity> {
  return {
    id: admin.id,
    name: admin.name,
    email: admin.email,
    role: admin.role as PlatformRole,
    mfaEnabled: admin.mfaEnabled,
    usingSeededPassword: await usesSeededPassword(admin.passwordHash)
  };
}

async function completeLogin(admin: AdminRow, userAgent?: string, ipAddress?: string) {
  const session = await establishSession(admin.id, { userAgent, ipAddress });
  await controlPrisma.platformAdminUser.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } });
  return { mfaRequired: false as const, ...session, admin: await identityOf(admin) };
}

/**
 * Sign-in, in two acts when a second factor is enrolled.
 *
 * WHERE THE CHALLENGE SITS, AND WHY IT MATTERS. It is between the password check and
 * `establishSession`, and it must stay there. A `PlatformAdminSession` row IS the refresh
 * credential — the cookie is `<jwt>.<opaque secret>` and `platformAdminRefresh` mints access
 * tokens from it without asking anything else. Creating one before the second factor is proved
 * would mean a stolen password plus one `POST /auth/refresh` is a full console session, and the
 * factor would be a dialog rather than a control. So nothing is written until the code checks out;
 * the interim credential is a signed challenge with its own audience, which
 * `verifyPlatformAdminAccessToken` will not accept.
 *
 * WHY THE UNKNOWN-ACCOUNT PATH STILL RUNS BCRYPT. Same oracle
 * tests/unit/auth-login-enumeration.test.ts pins on the tenant side: comparing against a constant
 * sentinel hash makes exactly one bcrypt round happen either way, so a missing address and a wrong
 * password cost the same. And the challenge itself is an oracle of the same shape if it can be
 * provoked without the password — which is why it is only ever reached AFTER the compare passes.
 * A wrong password produces the identical 401 whether the account is enrolled, unenrolled,
 * deactivated, or absent.
 */
export async function platformAdminLogin(email: string, password: string, userAgent?: string, ipAddress?: string) {
  const admin = await controlPrisma.platformAdminUser.findUnique({ where: { email } });
  const usable = admin && admin.status === "ACTIVE" ? admin : null;
  const passwordOk = await verifyPassword(password, usable?.passwordHash ?? DUMMY_PASSWORD_HASH);
  if (!usable || !passwordOk) throw new AppError(401, "Invalid email or password");

  if (usable.mfaEnabled && usable.mfaSecret) {
    return {
      mfaRequired: true as const,
      challengeToken: signPlatformAdminMfaChallenge(usable.id),
      expiresInSeconds: MFA_CHALLENGE_TTL_SECONDS
    };
  }

  return completeLogin(usable, userAgent, ipAddress);
}

/**
 * Act two: the code. Consumes the challenge token, then either a TOTP code or a recovery code, and
 * only then does a session exist.
 *
 * THE REPLAY RATCHET. A TOTP code is valid for its whole 30-second step plus the drift window, so
 * a code seen once — over a shoulder, in a screen share, in a proxy log — is usable again for up
 * to a minute and a half. `mfaLastUsedStep` records the step that was consumed and any step at or
 * below it is refused, which turns "valid for 90 seconds" into "valid once". The ratchet is stored
 * on the account, not in memory, so it survives a restart and holds across every instance.
 */
export async function platformAdminVerifyMfa(
  challengeToken: unknown,
  code: unknown,
  opts: { userAgent?: string; ipAddress?: string; recovery?: boolean } = {}
) {
  if (typeof challengeToken !== "string" || !challengeToken) throw new AppError(401, "Start the sign-in again");
  if (typeof code !== "string" || !code.trim()) throw new AppError(401, "That code is not right");

  let sub: string;
  try {
    sub = verifyPlatformAdminMfaChallenge(challengeToken).sub;
  } catch {
    // Expired and forged are one message on purpose: the difference tells a guesser whether they
    // are holding a real challenge, and the remedy — sign in again — is identical either way.
    throw new AppError(401, "Start the sign-in again");
  }

  const admin = await controlPrisma.platformAdminUser.findUnique({ where: { id: sub } });
  if (!admin || admin.status !== "ACTIVE" || !admin.mfaEnabled || !admin.mfaSecret) throw new AppError(401, "Start the sign-in again");

  if (opts.recovery) {
    await consumeRecoveryCode(admin.id, code);
    return { ...(await completeLogin(admin, opts.userAgent, opts.ipAddress)), usedRecoveryCode: true };
  }

  const result = verifyTotp(decryptSecret(admin.mfaSecret), code);
  if (!result.ok) throw new AppError(401, "That code is not right");
  if (admin.mfaLastUsedStep !== null && BigInt(result.step) <= admin.mfaLastUsedStep) {
    throw new AppError(401, "That code has already been used — wait for the next one.");
  }
  await controlPrisma.platformAdminUser.update({ where: { id: admin.id }, data: { mfaLastUsedStep: BigInt(result.step) } });

  return { ...(await completeLogin(admin, opts.userAgent, opts.ipAddress)), usedRecoveryCode: false };
}

/**
 * Spend one recovery code, or refuse.
 *
 * The claim is checked against every UNUSED row (bcrypt, one compare each — ten codes is ~100ms,
 * paid only on a path a person is waiting on anyway), and the row is then consumed with an UPDATE
 * whose WHERE still says `usedAt: null`. That last detail is the whole point: two sign-ins racing
 * with the same code both find the row, and exactly one of them updates it. A read-modify-write
 * would let both through.
 */
async function consumeRecoveryCode(adminId: string, supplied: string) {
  const normalized = normalizeRecoveryCode(supplied);
  const rows = await controlPrisma.platformAdminRecoveryCode.findMany({ where: { adminUserId: adminId, usedAt: null } });
  for (const row of rows) {
    if (!(await verifyTokenHash(normalized, row.codeHash))) continue;
    const claimed = await controlPrisma.platformAdminRecoveryCode.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
    if (claimed.count === 1) return;
    break;
  }
  throw new AppError(401, "That recovery code is not usable.");
}

/**
 * Enrolment, step one: mint a secret and show it. Nothing is switched on here.
 *
 * THE SECRET IS STORED BUT `mfaEnabled` STAYS FALSE until `confirmPlatformAdminMfa` sees a code
 * generated from it. Enrolling somebody into a factor they have not proved they can produce is how
 * a console locks out its own owner — the QR code scanned into the wrong app, the clock that is
 * four minutes out — and the account that owns the platform is the worst possible one to lock.
 */
export async function beginPlatformAdminMfa(adminId: string) {
  const admin = await controlPrisma.platformAdminUser.findUnique({ where: { id: adminId } });
  if (!admin) throw new AppError(401, "Invalid session");
  if (admin.mfaEnabled) throw new AppError(409, "Two-factor authentication is already on for this account.");

  const secret = generateTotpSecret();
  await controlPrisma.platformAdminUser.update({ where: { id: adminId }, data: { mfaSecret: encryptSecret(secret) } });
  return { secret, otpauthUri: totpAuthUri(secret, admin.email) };
}

/**
 * Enrolment, step two: prove it, then it is on — and ten recovery codes come back exactly once.
 *
 * Any codes from a previous enrolment are deleted rather than kept. A recovery code is a bypass of
 * the factor; leaving last year's set alive beside this year's secret means the factor is only as
 * strong as the oldest printout of it.
 */
export async function confirmPlatformAdminMfa(adminId: string, code: string) {
  const admin = await controlPrisma.platformAdminUser.findUnique({ where: { id: adminId } });
  if (!admin?.mfaSecret) throw new AppError(409, "Start the two-factor setup first.");
  if (admin.mfaEnabled) throw new AppError(409, "Two-factor authentication is already on for this account.");

  const result = verifyTotp(decryptSecret(admin.mfaSecret), code);
  if (!result.ok) throw new AppError(400, "That code is not right — check your authenticator's clock and try the next one.");

  const codes = generateRecoveryCodes();
  await controlPrisma.platformAdminRecoveryCode.deleteMany({ where: { adminUserId: adminId } });
  await controlPrisma.platformAdminRecoveryCode.createMany({
    data: await Promise.all(codes.map(async (value) => ({ adminUserId: adminId, codeHash: await hashToken(normalizeRecoveryCode(value)) })))
  });
  await controlPrisma.platformAdminUser.update({
    where: { id: adminId },
    data: { mfaEnabled: true, mfaEnrolledAt: new Date(), mfaLastUsedStep: BigInt(result.step) }
  });

  /** Shown once. Only hashes are kept, so a lost list means re-enrolling, not recovering. */
  return { recoveryCodes: codes };
}

/**
 * Turning the factor off re-asks for the password, exactly like changing it does: a walked-away
 * console must not be enough to strip an account's second factor. Every recovery code goes with
 * it, because a code that outlives the enrolment it belonged to is a permanent bypass nobody
 * remembers granting.
 */
export async function disablePlatformAdminMfa(adminId: string, currentPassword: string) {
  const admin = await controlPrisma.platformAdminUser.findUnique({ where: { id: adminId } });
  if (!admin || admin.status !== "ACTIVE") throw new AppError(401, "Invalid session");
  if (!(await verifyPassword(currentPassword, admin.passwordHash))) throw new AppError(400, "Current password is incorrect");
  if (!admin.mfaEnabled) throw new AppError(409, "Two-factor authentication is not on for this account.");

  await controlPrisma.platformAdminRecoveryCode.deleteMany({ where: { adminUserId: adminId } });
  await controlPrisma.platformAdminUser.update({
    where: { id: adminId },
    data: { mfaEnabled: false, mfaSecret: null, mfaEnrolledAt: null, mfaLastUsedStep: null }
  });
  return { mfaEnabled: false };
}

/** How many single-use codes this account has left — the number that decides whether the console
 *  nags somebody to regenerate them. */
export async function countPlatformAdminRecoveryCodes(adminId: string) {
  return controlPrisma.platformAdminRecoveryCode.count({ where: { adminUserId: adminId, usedAt: null } });
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
