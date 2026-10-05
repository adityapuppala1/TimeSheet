/**
 * Two-factor sign-in (TOTP) for workspace users — setup, confirmation, recovery codes, and the
 * second step of a password sign-in.
 *
 * Built on utils/totp.ts, the same primitives the platform console's two-factor uses. The sign-in
 * challenge is a short-lived signed token (5 minutes) that names the user, the workspace and the
 * "remember me" choice — it proves the PASSWORD step passed and nothing more; no session exists
 * until the code is checked. SSO sign-ins are the identity provider's business and never reach here.
 */
import jwt from "jsonwebtoken";
import { controlPrisma } from "../config/control-prisma.js";
import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { AppError } from "../middleware/error.js";
import { decryptSecret, encryptSecret } from "../utils/encryption.js";
import { hashToken, verifyTokenHash } from "../utils/security.js";
import { generateRecoveryCodes, generateTotpSecret, normalizeRecoveryCode, totpAuthUri, verifyTotp } from "../utils/totp.js";
import { audit } from "./audit.service.js";

const CHALLENGE_PURPOSE = "mfa_login";
const CHALLENGE_TTL = "5m";
const ISSUER = "TimeSphere";

export interface MfaChallenge {
  sub: string;
  org: string;
  rememberMe: boolean;
}

export function signMfaChallenge(challenge: MfaChallenge): string {
  return jwt.sign({ ...challenge, purpose: CHALLENGE_PURPOSE }, env.JWT_ACCESS_SECRET, { expiresIn: CHALLENGE_TTL });
}

export function readMfaChallenge(token: string): MfaChallenge {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as Partial<MfaChallenge> & { purpose?: string };
    if (payload.purpose !== CHALLENGE_PURPOSE || !payload.sub || !payload.org) throw new Error("wrong purpose");
    return { sub: payload.sub, org: payload.org, rememberMe: Boolean(payload.rememberMe) };
  } catch {
    throw new AppError(401, "That sign-in has expired. Enter your email and password again.", { code: "MFA_CHALLENGE_EXPIRED" });
  }
}

/** Is two-factor required for this workspace's password sign-ins? */
export async function workspaceRequiresMfa(orgId: string): Promise<boolean> {
  const row = await controlPrisma.orgAuthMethod.findUnique({ where: { organizationId: orgId }, select: { requireMfa: true } });
  return row?.requireMfa ?? false;
}

/** The same answer, cached for 30 seconds — requireAuth asks it on every request, and a policy
 *  change reaching everyone within half a minute is ample. `forgetMfaPolicy` drops it on change. */
const policyCache = new Map<string, { value: boolean; at: number }>();
const POLICY_TTL_MS = 30_000;
export async function workspaceRequiresMfaCached(orgId: string): Promise<boolean> {
  const hit = policyCache.get(orgId);
  if (hit && Date.now() - hit.at < POLICY_TTL_MS) return hit.value;
  const value = await workspaceRequiresMfa(orgId);
  policyCache.set(orgId, { value, at: Date.now() });
  return value;
}
export function forgetMfaPolicy(orgId: string): void {
  policyCache.delete(orgId);
}

/** Step 1 of setup: a fresh secret, kept PENDING until a code from it is confirmed. */
export async function startMfaSetup(userId: string, workspaceLabel: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, mfaEnabled: true } });
  if (!user) throw new AppError(404, "Account not found");
  if (user.mfaEnabled) throw new AppError(409, "Two-factor sign-in is already on. Turn it off first to set up a new device.");
  const secret = generateTotpSecret();
  await prisma.user.update({ where: { id: userId }, data: { mfaPendingSecret: encryptSecret(secret) } });
  return { secret, otpauthUrl: totpAuthUri(secret, user.email, `${ISSUER} (${workspaceLabel})`) };
}

async function replaceRecoveryCodes(userId: string): Promise<string[]> {
  const codes = generateRecoveryCodes(10);
  const hashes = await Promise.all(codes.map((c) => hashToken(normalizeRecoveryCode(c))));
  await prisma.$transaction([
    prisma.userRecoveryCode.deleteMany({ where: { userId } }),
    prisma.userRecoveryCode.createMany({ data: hashes.map((codeHash) => ({ userId, codeHash })) })
  ]);
  return codes;
}

/** Step 2: the first code from the authenticator turns it on and returns recovery codes ONCE. */
export async function confirmMfaSetup(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { mfaPendingSecret: true, mfaEnabled: true } });
  if (!user?.mfaPendingSecret) throw new AppError(409, "Start setup again — there is no pending authenticator to confirm.");
  const secret = decryptSecret(user.mfaPendingSecret);
  const check = verifyTotp(secret, code);
  if (!check.ok) throw new AppError(400, "That code doesn't match. Check the time on your phone and try the next code.", { code: "MFA_CODE_INVALID" });
  await prisma.user.update({
    where: { id: userId },
    data: { mfaEnabled: true, mfaSecret: user.mfaPendingSecret, mfaPendingSecret: null, mfaEnabledAt: new Date(), mfaLastStep: check.step }
  });
  const recoveryCodes = await replaceRecoveryCodes(userId);
  await audit(userId, "auth.mfa_enabled", "User", userId, {});
  return { recoveryCodes };
}

/**
 * Checks a sign-in code: a 6-digit TOTP (never the same 30-second step twice) or an unused recovery
 * code (spent on use). Returns how it was satisfied, for the audit row.
 */
export async function verifyMfaCode(userId: string, code: string): Promise<"totp" | "recovery"> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { mfaEnabled: true, mfaSecret: true, mfaLastStep: true } });
  if (!user?.mfaEnabled || !user.mfaSecret) throw new AppError(409, "Two-factor sign-in isn't on for this account.");

  const digits = code.replace(/\s/g, "");
  if (/^\d{6}$/.test(digits)) {
    const check = verifyTotp(decryptSecret(user.mfaSecret), digits);
    if (check.ok && (user.mfaLastStep === null || check.step > user.mfaLastStep)) {
      // Conditional on the step still being newer: two requests with one code — only one wins.
      const claimed = await prisma.user.updateMany({
        where: { id: userId, OR: [{ mfaLastStep: null }, { mfaLastStep: { lt: check.step } }] },
        data: { mfaLastStep: check.step }
      });
      if (claimed.count === 1) return "totp";
    }
    throw new AppError(401, "That code isn't right, or it was already used. Wait for the next one.", { code: "MFA_CODE_INVALID" });
  }

  const normalized = normalizeRecoveryCode(code);
  const unused = await prisma.userRecoveryCode.findMany({ where: { userId, usedAt: null }, select: { id: true, codeHash: true } });
  for (const row of unused) {
    if (await verifyTokenHash(normalized, row.codeHash)) {
      const spent = await prisma.userRecoveryCode.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
      if (spent.count === 1) return "recovery";
    }
  }
  throw new AppError(401, "That recovery code isn't right, or it was already used.", { code: "MFA_CODE_INVALID" });
}

/** Turns two-factor off — refused while the workspace requires it, and only with a working code. */
export async function disableMfa(userId: string, orgId: string, code: string): Promise<void> {
  if (await workspaceRequiresMfa(orgId)) {
    throw new AppError(409, "This workspace requires two-factor sign-in, so it can't be turned off. Set up a new device instead.");
  }
  await verifyMfaCode(userId, code);
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { mfaEnabled: false, mfaSecret: null, mfaPendingSecret: null, mfaEnabledAt: null, mfaLastStep: null } }),
    prisma.userRecoveryCode.deleteMany({ where: { userId } })
  ]);
  await audit(userId, "auth.mfa_disabled", "User", userId, {});
}

/** New recovery codes (the old ones stop working) — needs a current code. */
export async function regenerateRecoveryCodes(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
  await verifyMfaCode(userId, code);
  const recoveryCodes = await replaceRecoveryCodes(userId);
  await audit(userId, "auth.mfa_recovery_regenerated", "User", userId, {});
  return { recoveryCodes };
}

export async function mfaStatus(userId: string, orgId: string) {
  const [user, unused, required] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { mfaEnabled: true, mfaEnabledAt: true } }),
    prisma.userRecoveryCode.count({ where: { userId, usedAt: null } }),
    workspaceRequiresMfa(orgId)
  ]);
  return { enabled: user?.mfaEnabled ?? false, enabledAt: user?.mfaEnabledAt ?? null, recoveryCodesLeft: unused, requiredByWorkspace: required };
}
