/**
 * WHAT: the single-use link somebody approved to join a workspace sets their first password with
 * (signup Phase 1, docs/SIGNUP_AND_DOMAINS_PLAN.md §5.3).
 *
 * WHY IT RIDES THE PASSWORD-RESET MACHINERY. Same `PasswordResetToken` table, same bcrypt hashing,
 * same `/reset-password` page and `resetPassword` consumer (auth.service.ts) — a second "set your
 * password" flow would be a second thing to get right about token storage and single use. What
 * differs is only the lifetime (a reset link lives 30 minutes; "your request was approved" can sit in
 * an inbox over a weekend) and `welcome=1`, which the page uses to say "set" rather than "reset".
 *
 * Its own module rather than a function in auth.service.ts, which imports most of the auth stack:
 * the join-request service and its tests need this one function, not that.
 */
import { prisma } from "../config/prisma.js";
import { hashToken, opaqueToken } from "../utils/security.js";
import { tenantBaseUrl } from "./workspace-directory.service.js";

export async function issueSetPasswordLink(userId: string, ttlMs: number): Promise<string> {
  const rawToken = opaqueToken();
  await prisma.passwordResetToken.create({
    data: { userId, tokenHash: await hashToken(rawToken), expiresAt: new Date(Date.now() + ttlMs) }
  });
  // tenantBaseUrl, never the request's Host: an emailed link built from a request header is
  // host-header injection (see workspace-directory.service.ts#tenantBaseUrl).
  return `${tenantBaseUrl()}/reset-password?token=${encodeURIComponent(rawToken)}&welcome=1`;
}
