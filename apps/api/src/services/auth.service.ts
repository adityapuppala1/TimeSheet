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
import { resolveHeldRoles, type RoleName } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { controlPrisma } from "../config/control-prisma.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { env } from "../config/env.js";
import { AppError } from "../middleware/error.js";
import { audit } from "./audit.service.js";
import { getEffectiveSeatLimit } from "./plan-limits.service.js";
import { countActiveSeats } from "./seat-count.service.js";
import { rememberWorkspaceMembership } from "./workspace-directory.service.js";
import { isMaintenanceActive } from "./maintenance.service.js";
import {
  DUMMY_PASSWORD_HASH,
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
  manager: { select: { id: true, name: true, email: true } },
  userRoles: { select: { role: { select: { name: true } } } }
} as const;

export type ProfilePayload = {
  id: string;
  name: string;
  email: string;
  role: string;
  heldRoles: RoleName[];
  mustChangePassword: boolean;
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
    heldRoles: resolveHeldRoles(user.role.name as RoleName, user.userRoles.map((ur) => ur.role.name as RoleName)),
    // Drives the web's "choose your own password" prompt after an admin created or reset the
    // account. A prompt, never a gate — see the schema comment on User.mustChangePassword.
    mustChangePassword: user.mustChangePassword,
    permissions: user.role.permissions.map((p) => p.permission.key),
    avatarUrl: user.avatarUrl,
    bio: user.bio,
    phoneNumber: user.phoneNumber,
    timezone: user.timezone,
    managerId: user.managerId,
    manager: user.manager ?? null
  };
}

/**
 * Self-service — switching among roles you already hold, never granting a new one (granting is
 * SUPER_ADMIN-only, from User Management: see user.controller.ts). `User.roleId` is the currently
 * ACTIVE role everywhere it's read (every permission check in the app), so this is a one-column
 * write — no JWT re-issue needed, the access token carries no role claims at all.
 */
export async function switchActiveRole(userId: string, targetRole: RoleName) {
  const held = await prisma.userRole.findFirst({
    where: { userId, role: { name: targetRole } },
    select: { roleId: true }
  });
  if (!held) throw new AppError(403, "You don't hold that role.");

  const before = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { role: { select: { name: true } } } });
  await prisma.user.update({ where: { id: userId }, data: { roleId: held.roleId } });
  await audit(userId, "user.role_switched", "User", userId, { from: before.role.name, to: targetRole });

  return buildProfilePayload(userId);
}

/* ============================== Login lockout ============================== */

/**
 * Per-account failed-login counter, layered on top of the existing per-IP rate limiter
 * (app.ts's authLimiter). The IP limiter alone doesn't stop credential stuffing against one
 * specific known account from a botnet of different IPs; this does. In-memory by design —
 * same tradeoff as express-rate-limit's default store, acceptable at this app's scale (a
 * restart clears lockouts, which just means "worst case, an attacker gets a few more tries").
 *
 * The key is (orgId, email), NOT email alone. One Node process serves every tenant database, so
 * an email-only key makes this map a cross-tenant weapon: `recordFailedLogin` fires even when no
 * such user exists in the org being hit, so five unauthenticated POSTs at ANY org's login route
 * would lock that address out of EVERY org. orgId comes from the resolved tenant context, never
 * from the request body — the caller can pick which tenant it talks to via the host/slug the
 * tenant middleware already validated, but it can't forge a key for a tenant it isn't addressing.
 *
 * ENTRIES EXPIRE, and that is a memory property before it is a policy one: every key here is
 * (tenant, ATTACKER-SUPPLIED EMAIL), written on the unauthenticated login path — "no such user"
 * records a failure too, deliberately, so the map cannot be probed for which addresses exist.
 * Without expiry the map is an append-only log of every address ever typed at a login form, and
 * it grows for the life of the process. `FAILURE_WINDOW_MS` doubles as the counter's decay
 * window: four failures a fortnight ago should not combine with one today into a lockout.
 *
 * NO HARD ENTRY CAP, on purpose. A cap needs an eviction rule, and every eviction rule hands an
 * attacker the same primitive: flood the map with fresh keys until the victim's ARMED lockout is
 * the one evicted, and the lockout is gone. The bound is instead the TTL multiplied by what the
 * rate limiters allow through (app.ts: 20/min/IP on /api/auth/login, 900/min/IP overall) — tens
 * of thousands of small entries in the worst case, which costs single-digit megabytes and no
 * security.
 */
const FAILED_LOGIN_LIMIT = 5;
const LOCKOUT_MS = 5 * 60 * 1000;
/** Longer than LOCKOUT_MS so an entry always outlives the lock it may be holding. */
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const failedLogins = new Map<string, { count: number; lockedUntil: number | null; expiresAt: number }>();

/** A NUL separator can't occur in an orgId or an email, so no (org, email) pair can collide. */
const lockoutKey = (orgId: string, email: string) => `${orgId}\u0000${email.toLowerCase()}`;

/** Swept on write, not on a timer: a per-entry `setTimeout` would mean one live timer per email
 *  an attacker types, which is the same unbounded growth wearing a different hat. Every entry is
 *  (re)inserted with the same constant TTL, so insertion order IS expiry order and the first key
 *  that is still live ends the scan. */
function purgeExpiredLockouts(now: number) {
  for (const [key, entry] of failedLogins) {
    if (entry.expiresAt > now) break;
    failedLogins.delete(key);
  }
}

function checkAccountLockout(orgId: string, email: string) {
  const entry = failedLogins.get(lockoutKey(orgId, email));
  if (entry?.lockedUntil && entry.lockedUntil > Date.now()) {
    const minutesLeft = Math.ceil((entry.lockedUntil - Date.now()) / 60_000);
    throw new AppError(429, `Too many failed attempts. Try again in ${minutesLeft} minute${minutesLeft === 1 ? "" : "s"}.`);
  }
}

function recordFailedLogin(orgId: string, email: string) {
  const now = Date.now();
  purgeExpiredLockouts(now);

  const key = lockoutKey(orgId, email);
  const existing = failedLogins.get(key);
  // Only a live entry carries its count forward; one past its window starts counting again.
  const entry = existing && existing.expiresAt > now ? existing : { count: 0, lockedUntil: null, expiresAt: 0 };
  entry.count += 1;
  if (entry.count >= FAILED_LOGIN_LIMIT) {
    entry.lockedUntil = now + LOCKOUT_MS;
    entry.count = 0;
  }
  entry.expiresAt = now + FAILURE_WINDOW_MS;

  // Delete-then-set so a refreshed key moves to the back of the insertion order and
  // purgeExpiredLockouts' early `break` stays correct.
  failedLogins.delete(key);
  failedLogins.set(key, entry);
}

function clearFailedLogins(orgId: string, email: string) {
  failedLogins.delete(lockoutKey(orgId, email));
}

/** Test-only: the map is module state that survives across tests in one Vitest file. */
export function __resetLoginLockoutsForTests() {
  failedLogins.clear();
}

/** Test-only: the sweep leaves no trace in any response, so pin it on the size directly. */
export function __loginLockoutEntryCountForTests() {
  return failedLogins.size;
}

/* ================================== Login =================================== */

/**
 * Shared session-establishment tail — creates the Session row, mints the org-aware
 * access/refresh token pair, and stamps lastLoginAt. Every login path (password today; a
 * future SSO callback per Phase B4/B5) terminates here, so they all get the exact same
 * rotation/grace-window session model automatically rather than each having to replicate it.
 */
/**
 * How many live sessions one person may hold at once.
 *
 * THE SAFETY NET, not the mechanism. `deviceId` is what stops the list growing in normal use —
 * one browser, one row. This bounds everything it cannot cover: clients with no cookie jar (curl,
 * the MCP server, a mobile app), rows created before `deviceId` existed, and anyone who really
 * does sign in from a dozen machines. Without it the table has no ceiling at all, which is how a
 * single user reached 7,486 live sessions.
 *
 * Ten is deliberately generous — a laptop, a desktop, a phone, a tablet and a few browsers each
 * still fit — and it is a TARGET rather than a hard ceiling: `enforceSessionCap` only ever evicts
 * sessions that have gone IDLE, so someone genuinely using twelve keeps all twelve until some go
 * quiet. A cap willing to revoke an in-use session is worse than the problem it solves.
 */
export const MAX_ACTIVE_SESSIONS_PER_USER = 10;

/**
 * AN ACTIVE SESSION IS NEVER EVICTED, whatever the count.
 *
 * The cap alone was too blunt, and the e2e suite proved it by failing: a workload that signs in
 * many times in a short window pushed working sessions past the cap and revoked them, which
 * surfaced as a 401 on a token that had been minted minutes earlier. That is not a test artifact —
 * it is the same shape as a script or an integration polling `/auth/login` and quietly signing a
 * person out of the browser they are sitting in front of. A cap that can do that is worse than the
 * problem it solves.
 *
 * So idleness, not merely rank, is the eviction condition. Fifteen minutes matches
 * `maintenance.service.ts`'s ONLINE_WINDOW_MS, which is already this codebase's definition of
 * "using the app right now" — one idea, one number.
 *
 * The cap is therefore a TARGET, not a hard ceiling: someone genuinely holding twelve active
 * sessions keeps all twelve, and they are swept as they go quiet. That is the honest behaviour —
 * "you have too many devices" is only ever a reason to drop the ones nobody is using.
 */
const SESSION_IDLE_BEFORE_EVICTION_MS = 15 * 60 * 1000;

async function enforceSessionCap(userId: string, keepId: string): Promise<number> {
  const live = await prisma.session.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true, lastSeenAt: true, createdAt: true }
  });
  if (live.length <= MAX_ACTIVE_SESSIONS_PER_USER) return 0;

  /** Creation counts as activity: a row written seconds ago has been used — to sign in. Sorting
   *  on this rather than on `lastSeenAt` alone also removes NULL-ordering from the question. */
  const activeAt = (session: { lastSeenAt: Date | null; createdAt: Date }) =>
    (session.lastSeenAt ?? session.createdAt).getTime();
  const idleBefore = Date.now() - SESSION_IDLE_BEFORE_EVICTION_MS;

  const doomed = live
    // `keepId` is the session this very login issued. It is pinned rather than trusted to sort
    // safely: without it a brand-new row could be evicted at the instant it was created.
    .filter((session) => session.id !== keepId)
    .sort((a, b) => activeAt(b) - activeAt(a))
    .slice(MAX_ACTIVE_SESSIONS_PER_USER - 1)
    .filter((session) => activeAt(session) < idleBefore)
    .map((session) => session.id);
  if (doomed.length === 0) return 0;

  await prisma.session.updateMany({ where: { id: { in: doomed } }, data: { revokedAt: new Date() } });
  return doomed.length;
}

async function establishSession(
  user: { id: string },
  orgId: string,
  opts: { rememberMe?: boolean; userAgent?: string; ipAddress?: string; deviceId?: string }
) {
  // MAINTENANCE GATE, at the one place every login method funnels through — password, Google,
  // Microsoft, SAML and LDAP all terminate here, so none of them can become the forgotten side
  // door. Checked AFTER credentials verified (we need the role, and a wrong-password attempt
  // during maintenance should still say "wrong password"). SUPER_ADMIN passes — someone has to
  // be able to get in, do the maintenance, and switch it off. One light query per LOGIN, not
  // per request.
  const roleRow = await prisma.user.findUnique({
    where: { id: user.id },
    select: { firstLoginAt: true, isAgent: true, email: true, role: { select: { name: true } } }
  });

  /**
   * AGENT IDENTITIES CAN NEVER AUTHENTICATE (decision 2, docs/AGENTIC_WORK_MANAGEMENT.md §7).
   *
   * Enforced HERE for the same reason the maintenance gate above is: this function is the single
   * point every login method funnels through — password, Google, Microsoft, SAML and LDAP — so a
   * guard placed here cannot be bypassed by the next auth path somebody adds. Checking it in
   * `login()` alone would leave SSO open, which is exactly the class of bug the comment above this
   * one was written about.
   *
   * An agent's `User` row exists so that assignment, workload, audit and attestation work
   * unchanged; it is not a person, its password hash is unusable random bytes, and there is no
   * flow in which signing in as one is correct. 403 rather than 401 because the credential is not
   * the problem and retrying will never help.
   */
  if (roleRow?.isAgent) {
    throw new AppError(403, "This is an automation identity and cannot be signed in to.");
  }

  if (roleRow?.role.name !== "SUPER_ADMIN" && (await isMaintenanceActive())) {
    throw new AppError(503, "This workspace is undergoing scheduled maintenance. Please try again after the window ends.", {
      code: "MAINTENANCE"
    });
  }

  const days = opts.rememberMe ? 30 : env.REFRESH_TOKEN_TTL_DAYS;
  const refreshSecret = opaqueToken();
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const refreshHash = await hashToken(refreshSecret);

  /**
   * ONE BROWSER, ONE ROW.
   *
   * Signing in again from a device that already has a live session REPLACES that session rather
   * than adding a second one — new secret, new expiry, same row. This is the whole fix: without
   * it every sign-in INSERTed, and since nothing ever reaped them, one person on one machine
   * accumulated one "active device" per sign-in.
   *
   * MATCHED ON USER AGENT TOO, not on `deviceId` alone. The cookie is not an authenticator and is
   * never treated as one — pairing it with the browser string means a copied or stale cookie
   * cannot silently take over a different browser's row, and the failure mode when they disagree
   * is the harmless old behaviour (a new row) rather than a hijacked one.
   *
   * The grace-window fields are cleared: this is a fresh credential, not a rotation, so the
   * previous secret must stop working immediately.
   */
  const reusable = opts.deviceId
    ? await prisma.session.findFirst({
        where: {
          userId: user.id,
          deviceId: opts.deviceId,
          revokedAt: null,
          expiresAt: { gt: new Date() },
          userAgent: opts.userAgent ?? null
        },
        orderBy: { createdAt: "desc" },
        select: { id: true }
      })
    : null;

  const session = reusable
    ? await prisma.session.update({
        where: { id: reusable.id },
        data: {
          refreshHash,
          previousRefreshHash: null,
          refreshRotatedAt: null,
          ipAddress: opts.ipAddress,
          expiresAt,
          lastSeenAt: new Date()
        }
      })
    : await prisma.session.create({
        data: {
          userId: user.id,
          refreshHash,
          userAgent: opts.userAgent,
          ipAddress: opts.ipAddress,
          deviceId: opts.deviceId,
          expiresAt,
          // Signing in IS activity. Without this a brand-new row reads as "never used" to every
          // idle-based sweep and to the Profile page's "Last used" column alike.
          lastSeenAt: new Date()
        }
      });

  // The ceiling for everything `deviceId` cannot cover — cookie-less clients, rows predating the
  // column, and genuinely many devices. Best-effort: a failure here must never turn a successful
  // sign-in into an error, since the session itself is already valid.
  await enforceSessionCap(user.id, session.id).catch((error) =>
    console.warn(`[auth] session cap sweep failed for ${user.id}: ${(error as Error).message}`)
  );
  // firstLoginAt is written exactly once, then never touched again — pre-existing accounts keep
  // null (unknown) rather than a backfilled guess. Same write as lastLoginAt, so no extra query.
  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date(), ...(roleRow?.firstLoginAt ? {} : { firstLoginAt: new Date() }) }
  });

  // WORKSPACE DISCOVERY INDEX, written HERE for the same reason the maintenance and agent gates
  // above are: this is the one function password, Google, Microsoft, SAML and LDAP all funnel
  // through, so five login paths populate it without five call sites to keep in step. Any other
  // placement would be one auth method away from a person's workspace being unfindable.
  if (roleRow?.email) await rememberWorkspaceMembership(orgId, roleRow.email);

  return {
    accessToken: signAccessToken(user.id, session.id, orgId),
    refreshToken: `${signRefreshToken(user.id, session.id, days, orgId)}.${refreshSecret}`,
    refreshTokenExpiresAt: expiresAt
  };
}

export async function login(
  email: string,
  password: string,
  rememberMe = false,
  userAgent?: string,
  ipAddress?: string,
  /** See utils/device-cookie.ts — groups a browser's sessions into one row. Never an authenticator. */
  deviceId?: string
) {
  const { orgId } = requireTenantContext();
  checkAccountLockout(orgId, email);

  const authMethod = await controlPrisma.orgAuthMethod.findUnique({ where: { organizationId: orgId } });
  if (authMethod && (authMethod.requireSsoOnly || !authMethod.passwordLoginEnabled)) {
    throw new AppError(403, "Password sign-in is disabled for this workspace — use your organization's SSO login instead.");
  }

  const user = await prisma.user.findUnique({ where: { email }, include: PROFILE_INCLUDE });
  // Always run one bcrypt round, even when the account doesn't exist. Comparing the supplied
  // password against a constant sentinel hash equalizes the response time with the wrong-password
  // path, so the "Invalid email or password" reply — already identical in body and status — is
  // also identical in timing. Skipping the compare for a missing user (the `||` short-circuit
  // this replaces) turned that reply into a timing oracle: ~6ms unknown vs ~200ms real account.
  const passwordOk = await verifyPassword(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
  if (!user || user.deletedAt || !passwordOk) {
    recordFailedLogin(orgId, email);
    throw new AppError(401, "Invalid email or password");
  }
  if (user.status !== "ACTIVE") throw new AppError(403, "Account is not active");
  clearFailedLogins(orgId, email);

  const session = await establishSession(user, orgId, { rememberMe, userAgent, ipAddress, deviceId });

  return {
    ...session,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role.name,
      heldRoles: resolveHeldRoles(user.role.name as RoleName, user.userRoles.map((ur) => ur.role.name as RoleName)),
      mustChangePassword: user.mustChangePassword,
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
  ipAddress?: string,
  /** See utils/device-cookie.ts. Threaded here too so SSO users are not the one login path that
   *  keeps accumulating a session row per sign-in. */
  deviceId?: string
) {
  let user = await prisma.user.findUnique({ where: { email: identity.email }, include: PROFILE_INCLUDE });

  if (!user) {
    // Same seat-limit enforcement as user.controller.ts's manual creation path — an SSO-only
    // org shouldn't be able to grow past its plan's seat limit just because its users
    // self-provision on first login instead of an admin creating them by hand.
    const [seatLimit, activeSeats] = await Promise.all([
      getEffectiveSeatLimit(orgId),
      countActiveSeats()
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

  const session = await establishSession(user, orgId, { userAgent, ipAddress, deviceId });

  return {
    ...session,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role.name,
      heldRoles: resolveHeldRoles(user.role.name as RoleName, user.userRoles.map((ur) => ur.role.name as RoleName)),
      mustChangePassword: user.mustChangePassword,
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

  // The session row alone isn't enough: deactivating or soft-deleting an account doesn't
  // necessarily revoke its sessions (SCIM's DELETE /Users/:id only flips status), so without
  // this a disabled account would keep rotating itself a fresh token pair indefinitely.
  // requireAuth already refuses the resulting access token, but a session that outlives the
  // account it belongs to shouldn't stay alive at all — revoke it here rather than just
  // rejecting this one request.
  const owner = await prisma.user.findUnique({ where: { id: payload.sub }, select: { status: true, deletedAt: true } });
  if (!owner || owner.deletedAt || owner.status !== "ACTIVE") {
    await prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
    throw new AppError(401, "Invalid refresh token");
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
  // THE POINT OF THE WHOLE FLOW: a new password identical to the current one is not a password
  // change. It mattered most on the first sign-in, where `mustChangePassword` is set precisely
  // because an ADMIN knows the current password — re-entering it cleared the flag and left the
  // account exactly as exposed as before, while the UI reported success.
  //
  // Compared against the STORED HASH, not against the `currentPassword` string: they are the same
  // check here only because the current password was just verified, but a caller reaching this
  // with a stale/absent `currentPassword` (a future admin-side reset path) would still be caught.
  // The cost is one extra bcrypt compare on a route nobody calls in a loop.
  if (await verifyPassword(nextPassword, user.passwordHash)) {
    throw new AppError(422, "Your new password must be different from your current one.");
  }
  // Choosing their own password clears the "admin knows this password" prompt flag.
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(nextPassword), mustChangePassword: false }
  });
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

  // Same rule as `changePassword`: re-setting the password you already have is not a reset. Most
  // reset links are sent precisely because someone else set (or may know) the current password,
  // so accepting it back would end the flow having changed nothing. Checked AFTER the token is
  // matched but BEFORE it is burned, so a rejected attempt leaves the link usable for a real one.
  const resetting = await prisma.user.findUnique({ where: { id: match.userId }, select: { passwordHash: true } });
  if (resetting && (await verifyPassword(nextPassword, resetting.passwordHash))) {
    throw new AppError(422, "Your new password must be different from your current one.");
  }

  await prisma.$transaction([
    prisma.passwordResetToken.update({ where: { id: match.id }, data: { usedAt: new Date() } }),
    // A password chosen through the emailed link is the person's own — the change-prompt flag
    // (set by admin creation/reset) has served its purpose.
    prisma.user.update({
      where: { id: match.userId },
      data: { passwordHash: await hashPassword(nextPassword), mustChangePassword: false }
    }),
    prisma.session.updateMany({ where: { userId: match.userId, revokedAt: null }, data: { revokedAt: new Date() } })
  ]);
}
