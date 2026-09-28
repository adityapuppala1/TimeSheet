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
 * The properties pinned here are the ones that make a credential in a URL acceptable: it is
 * single-use, it expires in a minute, it is hashed at rest, and it is BOUND to the organization it
 * was minted for. Each of those looks like a limitation until you know what it is for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __handoffKeysForTests,
  __resetHandoffCodesForTests,
  issueHandoffCode,
  redeemHandoffCode
} from "../../src/services/sso-handoff.service.js";

const payload = (orgId = "org-acme") => ({
  orgId,
  accessToken: "access-token-for-" + orgId,
  refreshToken: "refresh-token-for-" + orgId,
  refreshTokenExpiresAt: new Date("2030-01-01T00:00:00Z"),
  user: { id: "user-1", name: "Sam" }
});

beforeEach(() => __resetHandoffCodesForTests());
afterEach(() => vi.useRealTimers());

describe("redeeming a handoff code", () => {
  it("returns the session exactly once", () => {
    const code = issueHandoffCode(payload());
    const first = redeemHandoffCode(code, "org-acme");
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.payload.refreshToken).toBe("refresh-token-for-org-acme");

    // A code that still works after redemption is a live credential sitting in browser history.
    expect(redeemHandoffCode(code, "org-acme").ok).toBe(false);
  });

  it("refuses a code minted for a DIFFERENT workspace", () => {
    /**
     * THE SECURITY PROPERTY OF THIS FILE. The redeeming request arrives at whatever hostname the
     * browser was sent to, and that hostname is what the tenant middleware turned into an
     * organization. Without this binding, a code minted for Acme could be redeemed at Globex's
     * origin — writing Acme's refresh cookie onto a hostname belonging to someone else.
     */
    const code = issueHandoffCode(payload("org-acme"));
    const result = redeemHandoffCode(code, "org-globex");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("wrong-workspace");
  });

  it("burns a code even when the workspace check fails", () => {
    // Otherwise the org check is the one thing worth retrying against, and the code survives to be
    // retried at every origin an attacker can reach.
    const code = issueHandoffCode(payload("org-acme"));
    expect(redeemHandoffCode(code, "org-globex").ok).toBe(false);
    expect(redeemHandoffCode(code, "org-acme").ok).toBe(false);
  });

  it("expires after a minute", () => {
    vi.useFakeTimers();
    const code = issueHandoffCode(payload());
    vi.advanceTimersByTime(59_000);
    // Still inside the window: a redirect the browser follows immediately has no reason to take
    // longer, and this half of the assertion is what stops the TTL being quietly cut to nothing.
    const early = redeemHandoffCode(code, "org-acme");
    expect(early.ok).toBe(true);

    const next = issueHandoffCode(payload());
    vi.advanceTimersByTime(61_000);
    expect(redeemHandoffCode(next, "org-acme").ok).toBe(false);
  });

  it("refuses a code that was never issued, and an empty one", () => {
    expect(redeemHandoffCode("not-a-real-code", "org-acme").ok).toBe(false);
    expect(redeemHandoffCode("", "org-acme").ok).toBe(false);
  });

  it("reports an unknown code and an expired one identically", () => {
    // Distinguishing them tells an anonymous caller whether a code they hold is real.
    vi.useFakeTimers();
    const code = issueHandoffCode(payload());
    vi.advanceTimersByTime(61_000);
    const expired = redeemHandoffCode(code, "org-acme");
    const unknown = redeemHandoffCode("never-issued", "org-acme");
    expect(expired).toEqual(unknown);
  });

  it("gives every sign-in its own unguessable code", () => {
    const codes = new Set(Array.from({ length: 50 }, () => issueHandoffCode(payload())));
    expect(codes.size).toBe(50);
    // 32 random bytes, base64url: long enough that there is nothing to guess at any rate.
    for (const code of codes) expect(code.length).toBeGreaterThanOrEqual(40);
  });

  it("keeps two workspaces' sessions apart", () => {
    const acme = issueHandoffCode(payload("org-acme"));
    const globex = issueHandoffCode(payload("org-globex"));
    const a = redeemHandoffCode(acme, "org-acme");
    const g = redeemHandoffCode(globex, "org-globex");
    expect(a.ok && a.payload.refreshToken).toBe("refresh-token-for-org-acme");
    expect(g.ok && g.payload.refreshToken).toBe("refresh-token-for-org-globex");
  });

  it("stores the code hashed, never in the clear", () => {
    /**
     * Hashed at rest for the same reason a password is: this map is reachable from a heap dump, and
     * a plaintext entry in it is a live session for somebody's workspace.
     *
     * Asserted against the REAL keys, because the first version of this test serialised unrelated
     * module state and passed happily when the service was changed to store the raw code — which is
     * the exact defect it was written to catch. Falsified after the rewrite: storing the raw code
     * turns this red.
     */
    const code = issueHandoffCode(payload());
    const keys = __handoffKeysForTests();
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toBe(code);
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
    // ...and the hash is still the thing that finds it.
    expect(redeemHandoffCode(code, "org-acme").ok).toBe(true);
  });
});
