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
  })
};
vi.mock("../../src/config/control-prisma.js", () => ({ controlPrisma: { emailVerificationCode } }));

const { checkVerificationCode, directoryHash, issueVerificationCode } = await import("../../src/services/workspace-directory.service.js");

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
    vi.setSystemTime(new Date("2026-10-01T09:30:00Z"));
    await issueVerificationCode("new@acme.com", "discover");
    expect([...rows.values()].map((r) => r.email)).toEqual(["new@acme.com"]);
  });
});
