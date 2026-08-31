/**
 * RFC 6238 TOTP — the second factor for the platform-admin console — implemented here rather than
 * pulled from a package.
 *
 * WHY NO DEPENDENCY. The whole algorithm is one HMAC-SHA1, one dynamic truncation and a modulo:
 * about twenty-five lines on `node:crypto`, all of it below, all of it pinned by
 * tests/unit/totp.test.ts against the RFC's own published vectors. This repo already hand-rolls
 * every small primitive of exactly this size in this directory — `opaqueToken`, `hashToken`,
 * `verifyTokenHash`, `signPublicToken`, `generateTempPassword`, `constantTimeEqual` — and the
 * alternative is adding a transitive dependency to the authentication path of the most privileged
 * surface in the product. (`otplib` would have been the choice if this were larger; `speakeasy` is
 * unmaintained CJS and fights this package's `"type": "module"` + `.js`-extension imports.)
 *
 * WHY SHA-1, IN 2026. Not a judgement about SHA-1's collision resistance — HMAC-SHA1 is not
 * affected by that, and this is interoperability, not cryptography we get to choose. Google
 * Authenticator, Microsoft Authenticator, 1Password and Authy all implement the default profile:
 * SHA-1, 6 digits, 30-second step. An implementation that picked SHA-256 would be more fashionable
 * and would silently produce wrong codes in every authenticator an operator actually owns.
 *
 * WHAT THIS FILE DOES NOT DECIDE: whether a code is a replay. `verifyTotp` returns the time STEP it
 * matched so the caller can refuse a step it has already consumed — the record of what was consumed
 * belongs to the account row (`PlatformAdminUser.mfaLastUsedStep`), not to a stateless helper.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** The interoperable default profile. Changing any of these breaks every existing enrolment. */
export const TOTP_DIGITS = 6;
export const TOTP_STEP_SECONDS = 30;

/**
 * How many steps either side of "now" are accepted.
 *
 * One, not zero and not three. Zero refuses an operator whose phone clock is a few seconds off,
 * which is most phones; three widens the window a stolen code stays usable in to three and a half
 * minutes. One step each way tolerates ±30s of drift — the value RFC 6238 §5.2 itself suggests —
 * and the replay ratchet in the caller closes the rest.
 */
export const TOTP_WINDOW = 1;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, unpadded. Unpadded because that is what `otpauth://` URIs carry and what every
 *  authenticator's manual-entry field expects; `base32Decode` accepts padding anyway. */
export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

/** Tolerant on input — spaces and lowercase are how a human retypes a secret off a screen — and
 *  strict about the alphabet, so a typo fails loudly instead of decoding to a different secret. */
export function base32Decode(input: string): Buffer {
  // One pass over a character class rather than a trailing-`=+$` strip: same result on every real
  // input, and no anchored quantifier for a linter to flag as backtracking-prone.
  const cleaned = input.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error("Not a base32 secret");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** 20 random bytes — the SHA-1 block-matched length RFC 4226 §4 recommends, and what every
 *  authenticator expects to be handed. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** Which 30-second window a moment falls in. Exported because the replay ratchet stores one. */
export function totpStepAt(now: Date = new Date()): number {
  return Math.floor(now.getTime() / 1000 / TOTP_STEP_SECONDS);
}

/** The RFC 4226 HOTP body: HMAC the 8-byte big-endian counter, then dynamic-truncate. */
export function totpCodeForStep(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  // `writeBigUInt64BE`, not two 32-bit writes: the step is a BigInt-sized counter and the naive
  // 32-bit version quietly stops working in 2038.
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) | ((digest[offset + 1] & 0xff) << 16) | ((digest[offset + 2] & 0xff) << 8) | (digest[offset + 3] & 0xff);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

export interface TotpVerification {
  ok: boolean;
  /** The step the code matched, so the caller can refuse a step it has already consumed. -1 when
   *  nothing matched. */
  step: number;
}

/**
 * Verify a typed code against the secret, across the drift window.
 *
 * The comparison is constant-time per candidate. It matters less here than for a long-lived
 * secret — there are only a million codes and they expire in thirty seconds — but a timing
 * difference in a credential check is the kind of thing that gets copied into somewhere it does
 * matter, so it is done properly the once.
 */
export function verifyTotp(secret: string, code: string, opts: { now?: Date; window?: number } = {}): TotpVerification {
  const cleaned = code.replace(/\s/g, "");
  if (!/^\d+$/.test(cleaned) || cleaned.length !== TOTP_DIGITS) return { ok: false, step: -1 };

  const window = opts.window ?? TOTP_WINDOW;
  const current = totpStepAt(opts.now);
  const supplied = Buffer.from(cleaned, "utf8");

  // Every candidate is evaluated — no early return on a match — so the number of HMACs computed
  // does not tell an observer WHICH step matched.
  let matched = -1;
  for (let delta = -window; delta <= window; delta += 1) {
    const step = current + delta;
    if (step < 0) continue;
    const expected = Buffer.from(totpCodeForStep(secret, step), "utf8");
    if (expected.length === supplied.length && timingSafeEqual(expected, supplied)) matched = step;
  }
  return { ok: matched >= 0, step: matched };
}

/**
 * The `otpauth://` URI an authenticator scans. The label carries the issuer twice — as a path
 * prefix and as a parameter — which looks redundant and is not: older Google Authenticator builds
 * read only the prefix, everything modern reads the parameter, and an enrolment that shows up in
 * somebody's app as a bare email address with no product name beside it is an enrolment they
 * delete six months later without knowing what it was.
 */
export function totpAuthUri(secret: string, account: string, issuer = "TimeSphere Platform"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS)
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Ten codes, each 10 chars of Crockford-ish base32 shown in two groups of five. Generated here so
 *  the format is one decision in one place; hashed by the caller before anything is stored. */
export function generateRecoveryCodes(count = 10): string[] {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1 — these get read off a screen
  return Array.from({ length: count }, () => {
    const raw = Array.from(randomBytes(10), (byte) => alphabet[byte % alphabet.length]).join("");
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

/** Recovery codes are compared after the same normalisation they are displayed with, so a person
 *  who retypes one in lowercase or leaves out the dash still gets in. */
export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}
