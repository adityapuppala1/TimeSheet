/**
 * WHAT: tenant user authentication — password `login()`, `completeSsoLogin()` (the shared
 * find-or-create tail for every SSO provider), `establishSession()` (session row + JWT mint,
 * used by both), refresh-token rotation with reuse detection, password change/reset, and
 * profile shaping.
 * WHY: every login method in this app — password or any of Google/Microsoft/SAML/LDAP — ends
 * at the exact same `establishSession()` call, so there's one session/rotation/revocation model
 * for the whole app, not a parallel one per auth method. See docs/ARCHITECTURE.md §3.2/§7.2 for
 * the full picture of how the four SSO flavors normalize into `completeSsoLogin`'s input shape.
 * WHO calls this: `controllers/auth.controller.ts` (password + LDAP), `controllers/sso.controller.ts`
 * (Google/Microsoft/SAML).
 */
import { prisma } from "../config/prisma.js";
import { controlPrisma } from "../config/control-prisma.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { env } from "../config/env.js";
import { AppError } from "../middleware/error.js";
import { getEffectiveSeatLimit } from "./plan-limits.service.js";
import { isMaintenanceActive } from "./maintenance.service.js";
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

/**
 * Shared session-establishment tail — creates the Session row, mints the org-aware
 * access/refresh token pair, and stamps lastLoginAt. Every login path (password today; a
 * future SSO callback per Phase B4/B5) terminates here, so they all get the exact same
 * rotation/grace-window session model automatically rather than each having to replicate it.
 */
async function establishSession(
  user: { id: string },
  orgId: string,
  opts: { rememberMe?: boolean; userAgent?: string; ipAddress?: string }
) {
  // MAINTENANCE GATE, at the one place every login method funnels through — password, Google,
  // Microsoft, SAML and LDAP all terminate here, so none of them can become the forgotten side
  // door. Checked AFTER credentials verified (we need the role, and a wrong-password attempt
  // during maintenance should still say "wrong password"). SUPER_ADMIN passes — someone has to
  // be able to get in, do the maintenance, and switch it off. One light query per LOGIN, not
  // per request.
  const roleRow = await prisma.user.findUnique({
    where: { id: user.id },
    select: { firstLoginAt: true, role: { select: { name: true } } }
  });
  if (roleRow?.role.name !== "SUPER_ADMIN" && (await isMaintenanceActive())) {
    throw new AppError(503, "This workspace is undergoing scheduled maintenance. Please try again after the window ends.", {
      code: "MAINTENANCE"
    });
  }

  const days = opts.rememberMe ? 30 : env.REFRESH_TOKEN_TTL_DAYS;
  const refreshSecret = opaqueToken();
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const session = await prisma.session.create({
    data: { userId: user.id, refreshHash: await hashToken(refreshSecret), userAgent: opts.userAgent, ipAddress: opts.ipAddress, expiresAt }
  });
  // firstLoginAt is written exactly once, then never touched again — pre-existing accounts keep
  // null (unknown) rather than a backfilled guess. Same write as lastLoginAt, so no extra query.
  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date(), ...(roleRow?.firstLoginAt ? {} : { firstLoginAt: new Date() }) }
  });

  return {
    accessToken: signAccessToken(user.id, session.id, orgId),
    refreshToken: `${signRefreshToken(user.id, session.id, days, orgId)}.${refreshSecret}`,
    refreshTokenExpiresAt: expiresAt
  };
}

export async function login(email: string, password: string, rememberMe = false, userAgent?: string, ipAddress?: string) {
  checkAccountLockout(email);

  const { orgId } = requireTenantContext();
  const authMethod = await controlPrisma.orgAuthMethod.findUnique({ where: { organizationId: orgId } });
  if (authMethod && (authMethod.requireSsoOnly || !authMethod.passwordLoginEnabled)) {
    throw new AppError(403, "Password sign-in is disabled for this workspace — use your organization's SSO login instead.");
  }

  const user = await prisma.user.findUnique({ where: { email }, include: PROFILE_INCLUDE });
  if (!user || user.deletedAt || !(await verifyPassword(password, user.passwordHash))) {
    recordFailedLogin(email);
    throw new AppError(401, "Invalid email or password");
  }
  if (user.status !== "ACTIVE") throw new AppError(403, "Account is not active");
  clearFailedLogins(email);

  const session = await establishSession(user, orgId, { rememberMe, userAgent, ipAddress });

  return {
    ...session,
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

/* ================================== SSO ====================================== */

/**
 * Completes an SSO login (Google/Microsoft — see services/sso.service.ts for the OIDC token
 * exchange itself, which hands this function a verified email/name once it's done). Finds an
 * existing tenant User by email — so someone who already had a password account and later
 * enables SSO just starts using it against the same account — or creates a new one on first
 * SSO login, defaulting to the EMPLOYEE role (an admin can promote them afterward the same
 * way as any other user). The password hash on an SSO-created account is an unusable random
 * value, the same pattern already used for the email-intake system account in prisma/seed.ts
 * — nobody is meant to password-login to it; it exists purely to satisfy User's required
 * fields and give SSO users an ordinary account row everything else in the app can reference.
 */
export async function completeSsoLogin(
  orgId: string,
  identity: { email: string; name: string | null },
  userAgent?: string,
  ipAddress?: string
) {
  let user = await prisma.user.findUnique({ where: { email: identity.email }, include: PROFILE_INCLUDE });

  if (!user) {
    // Same seat-limit enforcement as user.controller.ts's manual creation path — an SSO-only
    // org shouldn't be able to grow past its plan's seat limit just because its users
    // self-provision on first login instead of an admin creating them by hand.
    const [seatLimit, activeSeats] = await Promise.all([
      getEffectiveSeatLimit(orgId),
      prisma.user.count({ where: { status: "ACTIVE", deletedAt: null } })
    ]);
    if (activeSeats >= seatLimit) {
      throw new AppError(402, `This workspace has reached its seat limit (${seatLimit} seats). Contact your workspace admin to request more seats.`);
    }

    const employeeRole = await prisma.role.findUniqueOrThrow({ where: { name: "EMPLOYEE" } });
    const created = await prisma.user.create({
      data: {
        name: identity.name || identity.email.split("@")[0],
        email: identity.email,
        passwordHash: await hashPassword(opaqueToken()),
        roleId: employeeRole.id,
        status: "ACTIVE",
        emailVerifiedAt: new Date()
      },
      include: PROFILE_INCLUDE
    });
    user = created;
  }

  if (user.deletedAt || user.status !== "ACTIVE") throw new AppError(403, "Account is not active");

  const session = await establishSession(user, orgId, { userAgent, ipAddress });

  return {
    ...session,
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

  let payload: { sub: string; sid: string; org?: string };
  try {
    payload = verifyRefreshToken(jwtPart);
  } catch (error) {
    const name = (error as Error).name;
    if (name === "TokenExpiredError") throw new AppError(401, "Refresh token expired");
    throw new AppError(401, "Invalid refresh token");
  }

  if (!payload?.sid || !payload?.sub) throw new AppError(401, "Invalid refresh token");

  // Same cross-tenant defense as middleware/auth.ts#requireAuth — a refresh token minted
  // under one org shouldn't be honored against another, even though the signing secret is
  // currently shared across all orgs. Tokens minted before this claim existed skip the check.
  const { orgId } = requireTenantContext();
  if (payload.org && payload.org !== orgId) throw new AppError(401, "Invalid refresh token");

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
    accessToken: signAccessToken(payload.sub, session.id, orgId),
    refreshToken: `${signRefreshToken(payload.sub, session.id, remainingDays, orgId)}.${newSecret}`,
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
