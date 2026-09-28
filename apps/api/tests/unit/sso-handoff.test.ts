/**
 * Handing a completed SSO sign-in from the callback hostname to the workspace's own hostname.
 *
 * WHY THE HOP EXISTS. Google and Microsoft require one exact registered `redirect_uri`, so every
 * workspace's sign-in returns to a single callback host. Tenant resolution coped with that — the
 * organization rides in the signed `state` — but the SESSION did not: the refresh cookie was written
 * for the callback host and the browser was redirected to `WEB_ORIGIN[0]`, so somebody who started
 * at `acme.example.com` landed on a different origin holding a cookie it cannot read. A sign-in that
 * succeeds and shows a login page.
 *
 * The properties pinned here are the ones that make a credential in a URL acceptable: single use
 * (and single use ACROSS REPLICAS, which is why the row is claimed by a delete rather than a read),
 * sixty seconds, hashed at rest, encrypted at rest, and BOUND to the organization it was minted for.
 * Each looks like a limitation until you know what it is for.
 *
 * THE CONTROL PLANE IS FAKED, not reached. A unit test must not touch a database — vitest points
 * DATABASE_URL at an unreachable host on purpose — so the fake below implements only the four calls
 * this service makes, and implements them the way MySQL would: `deleteMany` reports a count, which
 * is the whole mechanism that makes redemption atomic between two pods.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
  id: string;
  codeHash: string;
  organizationId: string;
  encryptedPayload: string;
  expiresAt: Date;
}

/** Stands in for the `SsoHandoffCode` table. Exposed so assertions can look at what was STORED. */
const table = new Map<string, Row>();
let nextId = 0;

vi.mock("../../src/config/control-prisma.js", () => ({
  controlPrisma: {
    ssoHandoffCode: {
      create: async ({ data }: { data: Omit<Row, "id"> }) => {
        const row = { id: `row-${++nextId}`, ...data };
        table.set(row.id, row);
        return row;
      },
      findUnique: async ({ where }: { where: { codeHash: string } }) =>
        [...table.values()].find((r) => r.codeHash === where.codeHash) ?? null,
      deleteMany: async ({ where }: { where: { id?: string; expiresAt?: { lt: Date } } }) => {
        const doomed = [...table.values()].filter((r) =>
          where.id !== undefined ? r.id === where.id : where.expiresAt ? r.expiresAt < where.expiresAt.lt : true
        );
        for (const row of doomed) table.delete(row.id);
        return { count: doomed.length };
      }
    }
  }
}));

const { issueHandoffCode, redeemHandoffCode } = await import("../../src/services/sso-handoff.service.js");

const payload = (orgId = "org-acme") => ({
  orgId,
  accessToken: "access-token-for-" + orgId,
  refreshToken: "refresh-token-for-" + orgId,
  refreshTokenExpiresAt: new Date("2030-01-01T00:00:00Z"),
  user: { id: "user-1", name: "Sam" }
});

beforeEach(() => {
  table.clear();
  nextId = 0;
});

describe("redeeming a handoff code", () => {
  it("returns the session exactly once", async () => {
    const code = await issueHandoffCode(payload());
    const first = await redeemHandoffCode(code, "org-acme");
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.payload.refreshToken).toBe("refresh-token-for-org-acme");

    // A code that still works after redemption is a live credential sitting in browser history.
    expect((await redeemHandoffCode(code, "org-acme")).ok).toBe(false);
  });

  it("gives the cookie a real Date, not the string JSON turned it into", async () => {
    /**
     * A ONE-LINE BUG WITH A CONFUSING SYMPTOM. The payload round-trips through JSON, which turns
     * `refreshTokenExpiresAt` into a string. Handed to `res.cookie({ expires })` a string produces a
     * SESSION cookie — so SSO users, and only SSO users, would be signed out every time they closed
     * the browser, with nothing anywhere saying why.
     */
    const code = await issueHandoffCode(payload());
    const result = await redeemHandoffCode(code, "org-acme");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.refreshTokenExpiresAt).toBeInstanceOf(Date);
      expect(result.payload.refreshTokenExpiresAt.toISOString()).toBe("2030-01-01T00:00:00.000Z");
    }
  });

  it("refuses a code minted for a DIFFERENT workspace", async () => {
    /**
     * THE SECURITY PROPERTY OF THIS FILE. The redeeming request arrives at whatever hostname the
     * browser was sent to, and that hostname is what the tenant middleware turned into an
     * organization. Without this binding, a code minted for Acme could be redeemed at Globex's
     * origin — writing Acme's refresh cookie onto a hostname belonging to someone else.
     */
    const code = await issueHandoffCode(payload("org-acme"));
    const result = await redeemHandoffCode(code, "org-globex");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("wrong-workspace");
  });

  it("burns a code even when the workspace check fails", async () => {
    // Otherwise the org check is the one thing worth retrying against, and the code survives to be
    // retried at every origin an attacker can reach.
    const code = await issueHandoffCode(payload("org-acme"));
    expect((await redeemHandoffCode(code, "org-globex")).ok).toBe(false);
    expect((await redeemHandoffCode(code, "org-acme")).ok).toBe(false);
    expect(table.size).toBe(0);
  });

  it("is single-use even when two replicas redeem it at the same instant", async () => {
    /**
     * THE REASON THIS LIVES IN A DATABASE AND NOT A MAP. Several API pods behind a round-robin
     * balancer can receive the same redemption; the row is claimed with a DELETE whose reported
     * count decides the winner, so exactly one caller gets the session and the other is told the
     * code expired. A read-then-write in application code would let both through.
     */
    const code = await issueHandoffCode(payload());
    const [a, b] = await Promise.all([redeemHandoffCode(code, "org-acme"), redeemHandoffCode(code, "org-acme")]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });

  it("expires after a minute", async () => {
    vi.useFakeTimers();
    try {
      const early = await issueHandoffCode(payload());
      vi.advanceTimersByTime(59_000);
      // Still inside the window — this half is what stops the TTL being quietly cut to nothing.
      expect((await redeemHandoffCode(early, "org-acme")).ok).toBe(true);

      const late = await issueHandoffCode(payload());
      vi.advanceTimersByTime(61_000);
      expect((await redeemHandoffCode(late, "org-acme")).ok).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a code that was never issued, and an empty one", async () => {
    expect((await redeemHandoffCode("not-a-real-code", "org-acme")).ok).toBe(false);
    expect((await redeemHandoffCode("", "org-acme")).ok).toBe(false);
  });

  it("reports an unknown code and an expired one identically", async () => {
    // Distinguishing them tells an anonymous caller whether a code they hold is real.
    vi.useFakeTimers();
    try {
      const code = await issueHandoffCode(payload());
      vi.advanceTimersByTime(61_000);
      expect(await redeemHandoffCode(code, "org-acme")).toEqual(await redeemHandoffCode("never-issued", "org-acme"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives every sign-in its own unguessable code", async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 40; i += 1) codes.add(await issueHandoffCode(payload()));
    expect(codes.size).toBe(40);
    // 32 random bytes, base64url: nothing to guess at any rate worth limiting.
    for (const code of codes) expect(code.length).toBeGreaterThanOrEqual(40);
  });

  it("keeps two workspaces' sessions apart", async () => {
    const acme = await issueHandoffCode(payload("org-acme"));
    const globex = await issueHandoffCode(payload("org-globex"));
    const a = await redeemHandoffCode(acme, "org-acme");
    const g = await redeemHandoffCode(globex, "org-globex");
    expect(a.ok && a.payload.refreshToken).toBe("refresh-token-for-org-acme");
    expect(g.ok && g.payload.refreshToken).toBe("refresh-token-for-org-globex");
  });

  it("stores the code hashed and the session encrypted, never either in the clear", async () => {
    /**
     * This row is reachable by anything that can read the control plane, and it holds a usable
     * refresh token for up to a minute — so it gets the same treatment as the tenant DSNs and BYOK
     * provider keys it sits beside, not less.
     *
     * Asserted against what was actually WRITTEN. An earlier version of this test serialised
     * unrelated module state and passed happily when the service was changed to store the raw code,
     * which is the exact defect it was written to catch.
     */
    const code = await issueHandoffCode(payload());
    const [row] = [...table.values()];
    expect(row.codeHash).not.toBe(code);
    expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.encryptedPayload).not.toContain("refresh-token-for-org-acme");
    // ...and the hash is still what finds it, so the protection is not merely decorative.
    expect((await redeemHandoffCode(code, "org-acme")).ok).toBe(true);
  });

  it("sweeps expired rows when a new code is minted", async () => {
    // The table would otherwise accumulate a row per SSO sign-in forever.
    vi.useFakeTimers();
    try {
      await issueHandoffCode(payload());
      expect(table.size).toBe(1);
      vi.advanceTimersByTime(61_000);
      await issueHandoffCode(payload());
      // The sweep is awaited inside issueHandoffCode, so the table is settled by the time this
      // returns — no microtask draining, and no chance of the assertion racing the cleanup.
      expect(table.size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
