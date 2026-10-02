/**
 * WHAT: minting and finding the single-use links that set a password — the emailed reset link
 * (auth.service.ts#requestPasswordReset) and the "you were approved, choose a password" welcome link
 * (set-password-link.service.ts). Both are rows in `PasswordResetToken`, redeemed by the one
 * `/reset-password` route.
 *
 * WHY A SELECTOR AND A VERIFIER (security audit #3). The token used to be stored as bcrypt with a
 * per-row salt, which cannot be found by equality — so redemption loaded up to 500 live tokens from
 * EVERY user and bcrypt-compared the submitted one against each. One wrong guess cost about 24 s of
 * CPU once 500 were live, and a genuine link older than the newest 500 could never match, so
 * flooding forgot-password silently broke every real reset in the workspace.
 *
 * A link is now `<selector>.<verifier>`:
 *  - the SELECTOR is an indexed, unique column — finding the row is one read, whatever the table
 *    holds;
 *  - the VERIFIER is 48 characters of nanoid (~286 bits). A slow hash exists to protect guessable
 *    secrets like passwords; against a value nobody can enumerate, SHA-256 is the right tool, and
 *    it is compared in constant time.
 *
 * LEGACY LINKS. Rows minted before this format have no selector and a bcrypt `tokenHash`. They keep
 * working until they expire (72 hours at most, for a welcome link), found by the old scan restricted
 * to NULL-selector rows. Nothing adds to that pool any more, so it drains to empty by itself — and a
 * submitted value only reaches it when it has the exact legacy shape.
 */
import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import { prisma } from "../config/prisma.js";
import { constantTimeEqual, verifyTokenHash } from "../utils/security.js";

/** 16 nanoid characters is ~96 bits: unique without a retry loop, and not a secret anyway. */
const SELECTOR_LENGTH = 16;
const VERIFIER_LENGTH = 48;
const NEW_FORMAT = /^([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{48})$/;
/** Exactly what `opaqueToken()` produced for the old links — nothing else may reach the scan. */
const LEGACY_FORMAT = /^[A-Za-z0-9_-]{48}$/;
/** The old bound, kept for the draining legacy pool only. */
const LEGACY_SCAN_LIMIT = 500;

const hashVerifier = (verifier: string) => createHash("sha256").update(verifier).digest("hex");

export interface ResetTokenRow {
  id: string;
  userId: string;
  expiresAt: Date;
  usedAt: Date | null;
}

/** Creates the row and returns the raw `<selector>.<verifier>` for the emailed link. */
export async function issueResetToken(userId: string, ttlMs: number): Promise<string> {
  const selector = nanoid(SELECTOR_LENGTH);
  const verifier = nanoid(VERIFIER_LENGTH);
  await prisma.passwordResetToken.create({
    data: { userId, selector, tokenHash: hashVerifier(verifier), expiresAt: new Date(Date.now() + ttlMs) }
  });
  return `${selector}.${verifier}`;
}

/**
 * The live (unused, unexpired) row a submitted token names, or null.
 *
 * A new-format token costs one indexed read and one SHA-256 — never a bcrypt round. A value in
 * neither format costs nothing at all.
 */
export async function findLiveResetToken(rawToken: string): Promise<ResetTokenRow | null> {
  const now = new Date();
  const parts = NEW_FORMAT.exec(rawToken);
  if (parts) {
    const [, selector, verifier] = parts;
    const row = await prisma.passwordResetToken.findUnique({ where: { selector } });
    if (!row || row.usedAt || row.expiresAt <= now) return null;
    return constantTimeEqual(hashVerifier(verifier), row.tokenHash) ? row : null;
  }

  if (!LEGACY_FORMAT.test(rawToken)) return null;
  const candidates = await prisma.passwordResetToken.findMany({
    where: { selector: null, usedAt: null, expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
    take: LEGACY_SCAN_LIMIT
  });
  for (const candidate of candidates) {
    if (await verifyTokenHash(rawToken, candidate.tokenHash)) return candidate;
  }
  return null;
}

/**
 * Voids every outstanding link for one person. Called when the password changes by any route the
 * person drives — a link sent before the change must not still work after it.
 */
export async function voidOutstandingResetTokens(userId: string, client: Pick<typeof prisma, "passwordResetToken"> = prisma) {
  return client.passwordResetToken.updateMany({ where: { userId, usedAt: null }, data: { usedAt: new Date() } });
}
