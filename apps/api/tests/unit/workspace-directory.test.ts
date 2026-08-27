/**
 * The workspace-discovery primitives, tested where they decide something.
 *
 * The properties pinned here are the ones that are easy to break by "improving" the code, because
 * each of them looks like a limitation until you know what it is for:
 *
 *  - The index stores a KEYED hash. An unkeyed SHA-256 of an email address is reversible in
 *    practice — the input space is small enough to enumerate — and this index sits in the control
 *    plane beside every tenant's database credentials.
 *  - A verification code is SINGLE-USE and CAPPED. A code that still works after redemption is a
 *    credential sitting in an inbox; an uncapped one is six digits against unlimited guesses.
 *  - A wrong code and an expired token report the same way to the caller, because the difference
 *    would tell an attacker whether the address they typed matched anything.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetVerificationCodesForTests,
  checkVerificationCode,
  directoryHash,
  issueVerificationCode
} from "../../src/services/workspace-directory.service.js";

beforeEach(() => __resetVerificationCodesForTests());

describe("directoryHash", () => {
  it("normalises case and surrounding space, so one person is one row", () => {
    expect(directoryHash("  Bob@Acme.com ")).toBe(directoryHash("bob@acme.com"));
  });

  it("separates different addresses", () => {
    expect(directoryHash("bob@acme.com")).not.toBe(directoryHash("bob@globex.com"));
  });

  it("is not a bare SHA-256 of the address", async () => {
    // The point of the key. If this ever equals the unkeyed digest, the index has become a
    // rainbow-table lookup over every customer's user list.
    const { createHash } = await import("node:crypto");
    const unkeyed = createHash("sha256").update("bob@acme.com").digest("hex");
    expect(directoryHash("bob@acme.com")).not.toBe(unkeyed);
  });
});

describe("verification codes", () => {
  it("accepts the right code once, and never again", () => {
    const { token, code } = issueVerificationCode("bob@acme.com");
    expect(checkVerificationCode(token, code)).toEqual({ ok: true, email: "bob@acme.com" });
    // Second use: the code is in an inbox, and an inbox can be read later by someone else.
    expect(checkVerificationCode(token, code)).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses a wrong code without consuming the token", () => {
    const { token, code } = issueVerificationCode("bob@acme.com");
    expect(checkVerificationCode(token, "000000")).toEqual({ ok: false, reason: "wrong" });
    // A typo must not cost the person their code.
    expect(checkVerificationCode(token, code)).toEqual({ ok: true, email: "bob@acme.com" });
  });

  it("caps guessing at five attempts and then destroys the token", () => {
    const { token, code } = issueVerificationCode("bob@acme.com");
    for (let i = 0; i < 5; i++) expect(checkVerificationCode(token, "000000")).toEqual({ ok: false, reason: "wrong" });
    expect(checkVerificationCode(token, "000000")).toEqual({ ok: false, reason: "exhausted" });
    // Destroyed, so even the CORRECT code no longer works — an attacker who exhausts a token must
    // not be able to keep the real recipient's code alive for a later attempt.
    expect(checkVerificationCode(token, code)).toEqual({ ok: false, reason: "expired" });
  });

  it("reports an unknown token the same way as an expired one", () => {
    // These have to be indistinguishable: "that token never existed" would tell a caller whether
    // the address they submitted matched a workspace, which is what the 202 exists to hide.
    expect(checkVerificationCode("never-issued", "123456")).toEqual({ ok: false, reason: "expired" });
  });

  it("issues a distinct token and a six-digit code each time", () => {
    const a = issueVerificationCode("bob@acme.com");
    const b = issueVerificationCode("bob@acme.com");
    expect(a.token).not.toBe(b.token);
    expect(a.code).toMatch(/^\d{6}$/);
    expect(b.code).toMatch(/^\d{6}$/);
  });

  it("keeps two concurrent requests for the same address independent", () => {
    // A person who clicks "resend" has two live codes. Redeeming one must not invalidate the other,
    // or the older email in their inbox becomes a trap.
    const a = issueVerificationCode("bob@acme.com");
    const b = issueVerificationCode("bob@acme.com");
    expect(checkVerificationCode(a.token, a.code).ok).toBe(true);
    expect(checkVerificationCode(b.token, b.code).ok).toBe(true);
  });
});
