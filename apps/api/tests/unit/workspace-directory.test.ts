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
 *  - Since 2026-10-01: codes live in the control plane, so they work across API replicas, and each is
 *    bound to the flow that minted it, so a discovery code cannot complete a signup.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The code store, faked at the table. It implements exactly the four calls the service makes, with
 * the same WHERE semantics — in particular the conditional `updateMany` that spends an attempt, which
 * is what keeps the five-guess cap honest when guesses land on different replicas.
 */
type Row = { tokenHash: string; codeHash: string; email: string; purpose: string; attempts: number; expiresAt: Date };
const rows = new Map<string, Row>();
const emailVerificationCode = {
  create: vi.fn(async ({ data }: { data: Omit<Row, "attempts"> }) => {
    rows.set(data.tokenHash, { ...data, attempts: 0 });
    return rows.get(data.tokenHash);
  }),
  findUnique: vi.fn(async ({ where }: { where: { tokenHash: string } }) => {
    const row = rows.get(where.tokenHash);
    return row ? { ...row } : null;
  }),
  updateMany: vi.fn(
    async ({ where }: { where: { tokenHash: string; purpose?: string; attempts?: { lt: number }; expiresAt: { gt: Date } } }) => {
      const row = rows.get(where.tokenHash);
      if (!row || (where.purpose !== undefined && row.purpose !== where.purpose) || (where.attempts !== undefined && row.attempts >= where.attempts.lt) || row.expiresAt <= where.expiresAt.gt) {
        return { count: 0 };
      }
      row.attempts += 1;
      return { count: 1 };
    }
  ),
  deleteMany: vi.fn(async ({ where }: { where: { tokenHash?: string; expiresAt?: { lt: Date } } }) => {
    let count = 0;
    for (const [key, row] of rows) {
      const byToken = where.tokenHash !== undefined && key === where.tokenHash;
      const byExpiry = where.tokenHash === undefined && where.expiresAt !== undefined && row.expiresAt < where.expiresAt.lt;
      if (byToken || byExpiry) {
        rows.delete(key);
        count += 1;
      }
    }
    return { count };
  }),
  // The per-address hourly cap (countRecentVerificationCodes) — email, purpose and an expiry floor.
  count: vi.fn(async ({ where }: { where: { email: string; purpose: string; expiresAt: { gt: Date } } }) =>
    [...rows.values()].filter((row) => row.email === where.email && row.purpose === where.purpose && row.expiresAt > where.expiresAt.gt).length
  )
};
vi.mock("../../src/config/control-prisma.js", () => ({ controlPrisma: { emailVerificationCode } }));

const {
  checkVerificationCode,
  countRecentVerificationCodes,
  directoryHash,
  issueSignupContinuation,
  issueVerificationCode,
  peekSignupContinuation,
  redeemSignupContinuation
} = await import("../../src/services/workspace-directory.service.js");

beforeEach(() => {
  rows.clear();
  vi.useRealTimers();
});

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
  it("accepts the right code once, and never again", async () => {
    const { token, code } = await issueVerificationCode("bob@acme.com", "discover");
    expect(await checkVerificationCode(token, code, "discover")).toEqual({ ok: true, email: "bob@acme.com" });
    // Second use: the code is in an inbox, and an inbox can be read later by someone else.
    expect(await checkVerificationCode(token, code, "discover")).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses a wrong code without consuming the token", async () => {
    const { token, code } = await issueVerificationCode("bob@acme.com", "discover");
    expect(await checkVerificationCode(token, "000000", "discover")).toEqual({ ok: false, reason: "wrong" });
    // A typo must not cost the person their code.
    expect(await checkVerificationCode(token, code, "discover")).toEqual({ ok: true, email: "bob@acme.com" });
  });

  it("caps guessing at five attempts and then destroys the token", async () => {
    const { token, code } = await issueVerificationCode("bob@acme.com", "discover");
    for (let i = 0; i < 5; i++) {
      expect(await checkVerificationCode(token, "000000", "discover")).toEqual({ ok: false, reason: "wrong" });
    }
    expect(await checkVerificationCode(token, "000000", "discover")).toEqual({ ok: false, reason: "exhausted" });
    // Destroyed, so even the CORRECT code no longer works — an attacker who exhausts a token must
    // not be able to keep the real recipient's code alive for a later attempt.
    expect(await checkVerificationCode(token, code, "discover")).toEqual({ ok: false, reason: "expired" });
  });

  it("holds the cap when guesses arrive concurrently, as they would across replicas", async () => {
    // The attempt is spent in the same conditional UPDATE that checks the cap, so ten simultaneous
    // guesses cannot all see "fewer than five" and all be compared.
    const { token } = await issueVerificationCode("bob@acme.com", "discover");
    const results = await Promise.all(Array.from({ length: 10 }, () => checkVerificationCode(token, "000000", "discover")));
    expect(results.filter((r) => !r.ok && r.reason === "wrong")).toHaveLength(5);
  });

  it("reports an unknown token the same way as an expired one", async () => {
    // These have to be indistinguishable: "that token never existed" would tell a caller whether
    // the address they submitted matched a workspace, which is what the 202 exists to hide.
    expect(await checkVerificationCode("never-issued", "123456", "discover")).toEqual({ ok: false, reason: "expired" });
  });

  it("expires after ten minutes", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-01T09:00:00Z") });
    const { token, code } = await issueVerificationCode("bob@acme.com", "signup");
    vi.setSystemTime(new Date("2026-10-01T09:10:01Z"));
    expect(await checkVerificationCode(token, code, "signup")).toEqual({ ok: false, reason: "expired" });
  });

  it("issues a distinct token and a six-digit code each time", async () => {
    const a = await issueVerificationCode("bob@acme.com", "discover");
    const b = await issueVerificationCode("bob@acme.com", "discover");
    expect(a.token).not.toBe(b.token);
    expect(a.code).toMatch(/^\d{6}$/);
    expect(b.code).toMatch(/^\d{6}$/);
  });

  it("keeps two concurrent requests for the same address independent", async () => {
    // A person who clicks "resend" has two live codes. Redeeming one must not invalidate the other,
    // or the older email in their inbox becomes a trap.
    const a = await issueVerificationCode("bob@acme.com", "discover");
    const b = await issueVerificationCode("bob@acme.com", "discover");
    expect((await checkVerificationCode(a.token, a.code, "discover")).ok).toBe(true);
    expect((await checkVerificationCode(b.token, b.code, "discover")).ok).toBe(true);
  });

  it("never lets a code cross flows — a discovery code cannot complete a signup", async () => {
    // Discovery emails a real code to any address that is a member somewhere, personal Gmail
    // included; signup refuses personal addresses when it issues its own. Accepting the first in the
    // second would skip that refusal. It must read as expired, not as "wrong purpose".
    const { token, code } = await issueVerificationCode("someone@gmail.com", "discover");
    expect(await checkVerificationCode(token, code, "signup")).toEqual({ ok: false, reason: "expired" });
    // ...and the refused cross-flow attempt did not spend the code's own flow.
    expect(await checkVerificationCode(token, code, "discover")).toEqual({ ok: true, email: "someone@gmail.com" });
  });

  it("works when the code is minted by one process and checked by another", async () => {
    // The reason the store moved out of memory. Nothing per-process survives between issue and check
    // here except the table — exactly the situation behind a round-robin load balancer.
    const { token, code } = await issueVerificationCode("bob@acme.com", "signup");
    vi.resetModules();
    const other = await import("../../src/services/workspace-directory.service.js");
    expect(await other.checkVerificationCode(token, code, "signup")).toEqual({ ok: true, email: "bob@acme.com" });
  });

  it("stores neither the token nor the code in the clear", async () => {
    const { token, code } = await issueVerificationCode("bob@acme.com", "signup");
    const [row] = [...rows.values()];
    expect(row.tokenHash).not.toContain(token);
    expect(row.codeHash).not.toContain(code);
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sweeps expired rows when it issues, so discovery misses cannot pile up", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-01T09:00:00Z") });
    await issueVerificationCode("old@acme.com", "discover");
    // Expired at 09:10 but still COUNTED for an hour after that — the per-address hourly cap on the
    // finder (audit #5) reads these rows, and a row swept at expiry would cap nothing past ten
    // minutes. An expired row redeems nothing either way.
    vi.setSystemTime(new Date("2026-10-01T09:30:00Z"));
    await issueVerificationCode("mid@acme.com", "discover");
    expect([...rows.values()].map((r) => r.email)).toEqual(["old@acme.com", "mid@acme.com"]);
    vi.setSystemTime(new Date("2026-10-01T10:15:00Z"));
    await issueVerificationCode("new@acme.com", "discover");
    expect([...rows.values()].map((r) => r.email)).toEqual(["mid@acme.com", "new@acme.com"]);
  });
});

describe("the per-address hourly count behind the finder's cap (audit #5)", () => {
  it("counts this address's codes for this flow from the last hour, expired ones included", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-01T08:00:00Z") });
    await issueVerificationCode("bob@acme.com", "discover"); // more than an hour ago by the end
    vi.setSystemTime(new Date("2026-10-01T09:05:00Z"));
    await issueVerificationCode("bob@acme.com", "discover"); // expired, still inside the hour
    vi.setSystemTime(new Date("2026-10-01T09:40:00Z"));
    await issueVerificationCode("bob@acme.com", "discover");
    await issueVerificationCode("bob@acme.com", "signup"); // a different flow
    await issueVerificationCode("eve@acme.com", "discover"); // a different address
    expect(await countRecentVerificationCodes("bob@acme.com", "discover")).toBe(2);
  });
});

describe("signup continuations — a verified address carried through the form", () => {
  it("can be peeked any number of times, so a taken workspace address does not burn it", async () => {
    const value = await issueSignupContinuation("priya@northwind.co.uk");
    expect(await peekSignupContinuation(value)).toEqual({ ok: true, email: "priya@northwind.co.uk" });
    expect(await peekSignupContinuation(value)).toEqual({ ok: true, email: "priya@northwind.co.uk" });
  });

  it("redeems exactly once", async () => {
    const value = await issueSignupContinuation("priya@northwind.co.uk");
    expect(await redeemSignupContinuation(value)).toBe(true);
    expect(await redeemSignupContinuation(value)).toBe(false);
    expect(await peekSignupContinuation(value)).toEqual({ ok: false });
  });

  it("refuses a wrong secret without consuming the real one", async () => {
    const value = await issueSignupContinuation("priya@northwind.co.uk");
    const [token] = value.split(".");
    expect(await peekSignupContinuation(`${token}.not-the-secret`)).toEqual({ ok: false });
    expect(await redeemSignupContinuation(`${token}.not-the-secret`)).toBe(false);
    expect(await redeemSignupContinuation(value)).toBe(true);
  });

  it("is not a code: a SIGNUP code's token and code do not pass as a continuation", async () => {
    const { token, code } = await issueVerificationCode("priya@northwind.co.uk", "signup");
    expect(await peekSignupContinuation(`${token}.${code}`)).toEqual({ ok: false });
  });

  it.each(["", "abc", "a.b.c", ".", "x."])("treats the malformed value %j as nothing", async (value) => {
    expect(await peekSignupContinuation(value)).toEqual({ ok: false });
    expect(await redeemSignupContinuation(value)).toBe(false);
  });

  it("lasts thirty minutes — long enough to fill the form, not long enough to keep", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-01T09:00:00Z") });
    const value = await issueSignupContinuation("priya@northwind.co.uk");
    vi.setSystemTime(new Date("2026-10-01T09:29:00Z"));
    expect((await peekSignupContinuation(value)).ok).toBe(true);
    vi.setSystemTime(new Date("2026-10-01T09:31:00Z"));
    expect((await peekSignupContinuation(value)).ok).toBe(false);
    expect(await redeemSignupContinuation(value)).toBe(false);
  });
});
