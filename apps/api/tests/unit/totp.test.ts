/**
 * The hand-rolled TOTP in utils/totp.ts, pinned against RFC 6238's own published test vectors.
 *
 * WHY THE RFC's VECTORS AND NOT A ROUND TRIP. A round trip ("generate a code, verify it") passes
 * for any self-consistent implementation, including a wrong one — and a wrong one here means every
 * operator's authenticator app produces codes this server rejects, which is discovered at the worst
 * possible moment by the person who can least afford to be locked out. Appendix B's vectors are the
 * only assertion that says "this agrees with Google Authenticator".
 *
 * The vectors are published as 8-digit codes; the interoperable profile every authenticator
 * actually implements is 6, which is the last six digits of the same truncation. Both are stated
 * below so the arithmetic is checkable by eye.
 */
import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateTotpSecret,
  normalizeRecoveryCode,
  totpAuthUri,
  totpCodeForStep,
  totpStepAt,
  TOTP_STEP_SECONDS,
  verifyTotp
} from "../../src/utils/totp.js";

/** RFC 6238 Appendix B's SHA-1 seed: the ASCII string "12345678901234567890", base32-encoded. */
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

/** [unix seconds, the RFC's 8-digit code]. The 6-digit code is its last six characters. */
const VECTORS: [number, string][] = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"]
];

describe("RFC 6238 vectors", () => {
  it("produces the published code at every published instant", () => {
    for (const [seconds, eightDigits] of VECTORS) {
      const step = Math.floor(seconds / TOTP_STEP_SECONDS);
      expect(totpCodeForStep(RFC_SECRET, step)).toBe(eightDigits.slice(-6));
    }
  });

  it("verifies a code at the instant the RFC says it is valid", () => {
    for (const [seconds, eightDigits] of VECTORS) {
      const result = verifyTotp(RFC_SECRET, eightDigits.slice(-6), { now: new Date(seconds * 1000) });
      expect(result.ok).toBe(true);
      expect(result.step).toBe(Math.floor(seconds / TOTP_STEP_SECONDS));
    }
  });
});

describe("base32", () => {
  it("encodes the RFC's seed to the RFC's secret", () => {
    expect(base32Encode(Buffer.from("12345678901234567890", "utf8"))).toBe(RFC_SECRET);
  });

  it("round-trips arbitrary bytes", () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255, 128, 64]);
    expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
  });

  it("accepts what a human retypes — lowercase, spaces, padding", () => {
    const spaced = "gezd gnbv gy3t qojq gezd gnbv gy3t qojq==";
    expect(base32Decode(spaced).toString("utf8")).toBe("12345678901234567890");
  });

  it("refuses a character that is not in the alphabet, rather than decoding to something else", () => {
    // `1` and `0` are deliberately absent from RFC 4648's base32 — a typo must fail loudly, not
    // silently decode to a different secret and produce codes that never match.
    expect(() => base32Decode("GEZD1NBV")).toThrow(/base32/i);
  });
});

describe("the drift window and the shape of a code", () => {
  const now = new Date(1_700_000_000_000);
  const step = totpStepAt(now);

  it("accepts one step either side, and nothing further", () => {
    expect(verifyTotp(RFC_SECRET, totpCodeForStep(RFC_SECRET, step - 1), { now }).ok).toBe(true);
    expect(verifyTotp(RFC_SECRET, totpCodeForStep(RFC_SECRET, step + 1), { now }).ok).toBe(true);
    expect(verifyTotp(RFC_SECRET, totpCodeForStep(RFC_SECRET, step - 2), { now }).ok).toBe(false);
    expect(verifyTotp(RFC_SECRET, totpCodeForStep(RFC_SECRET, step + 2), { now }).ok).toBe(false);
  });

  it("reports WHICH step matched, which is what makes a replay detectable at all", () => {
    expect(verifyTotp(RFC_SECRET, totpCodeForStep(RFC_SECRET, step - 1), { now }).step).toBe(step - 1);
  });

  it("refuses anything that is not six digits without doing any crypto", () => {
    for (const bad of ["", "12345", "1234567", "abcdef", "12 34 5", "١٢٣٤٥٦"]) {
      expect(verifyTotp(RFC_SECRET, bad, { now })).toEqual({ ok: false, step: -1 });
    }
  });

  it("ignores whitespace inside a code, because authenticators display it grouped", () => {
    const code = totpCodeForStep(RFC_SECRET, step);
    expect(verifyTotp(RFC_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, { now }).ok).toBe(true);
  });
});

describe("secrets, URIs and recovery codes", () => {
  it("mints a 20-byte (32-character) base32 secret", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret)).toHaveLength(20);
  });

  it("builds an otpauth URI carrying the issuer twice — path prefix and parameter", () => {
    const uri = totpAuthUri("GEZDGNBVGY3TQOJQ", "ops@timesphere.app");
    expect(uri).toMatch(/^otpauth:\/\/totp\/TimeSphere%20Platform%3Aops%40timesphere\.app\?/);
    expect(uri).toContain("issuer=TimeSphere+Platform");
    expect(uri).toContain("algorithm=SHA1");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });

  it("mints ten distinct recovery codes with no visually ambiguous characters", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) {
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
      // I/O/0/1 are read off a screen and retyped; none of them appear.
      expect(code).not.toMatch(/[IO01]/);
    }
  });

  it("normalises a recovery code the way a person retypes one", () => {
    expect(normalizeRecoveryCode("abcde-fghjk")).toBe("ABCDEFGHJK");
    expect(normalizeRecoveryCode("ABCDE FGHJK")).toBe("ABCDEFGHJK");
    expect(normalizeRecoveryCode("ABCDEFGHJK")).toBe("ABCDEFGHJK");
  });
});
