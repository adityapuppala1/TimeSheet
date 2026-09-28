/**
 * Handing a completed SSO sign-in from the callback hostname to the workspace's own hostname.
 *
 * WHY THIS EXISTS. Google and Microsoft require the OAuth `redirect_uri` to be ONE exact string,
 * registered in advance — so every workspace's sign-in comes back to a single callback host, built
 * from `APP_BASE_URL`. Tenant resolution copes with that fine: `finishSsoLogin` recovers the
 * organization from the signed `state`, not from the `Host` header. What did NOT cope was the
 * session. The refresh cookie was set on the callback host and the browser was then redirected to
 * the first entry in `WEB_ORIGIN` — so a person who started at `acme.example.com` ended up on a
 * different origin, holding a cookie that origin cannot read. The symptom is a sign-in that appears
 * to succeed and lands on a login page.
 *
 * So: complete the login where the callback arrived, put the result behind a one-time code, and send
 * the browser to the WORKSPACE's own address to redeem it. The cookie is then written by a request
 * whose `Host` is the workspace, which is the only place it is any use.
 *
 * WHY A CODE IN A URL, WHICH IS A THING TO BE CAREFUL WITH. It is the same shape OAuth itself uses
 * one hop earlier, and for the same reason: a redirect is the only channel between two origins that
 * needs no shared storage. The care is in the parameters — sixty seconds, single use, hashed at
 * rest, and bound to the organization it was minted for, so the window in which a leaked URL is
 * worth anything is about as small as it can be made. The SPA also strips it from the address bar
 * on arrival, so it does not linger in history.
 *
 * WHY SINGLE-ORG DEPLOYMENTS NEVER SEE ANY OF THIS. `finishSsoLogin` only takes this path when the
 * workspace's base URL differs from the origin the callback arrived on, which cannot happen unless
 * `ROOT_DOMAIN` is set or the workspace has a custom domain. Every on-prem install keeps the exact
 * redirect it has today.
 *
 * THE HONEST LIMITATION, same as the workspace-finder codes next door: this map is in memory, so it
 * does not survive a restart and does not span replicas. A multi-instance deployment behind a
 * round-robin balancer will occasionally mint on one process and redeem on another, and the person
 * sees the sign-in fail and retries. The fix when that matters is a shared store, not a bigger map.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";

/** Sixty seconds. This is a redirect the browser follows immediately; anything longer is only a
 *  longer window for a leaked URL to be worth something. */
const TTL_MS = 60_000;

/** What the workspace's own origin needs in order to establish the session there. */
export interface HandoffPayload {
  orgId: string;
  accessToken: string;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  user: unknown;
}

interface Pending extends HandoffPayload {
  codeHash: string;
  expiresAt: number;
}

const pending = new Map<string, Pending>();

/** Keyed, not a bare digest: this hashes a live credential, and the key is what makes the map
 *  useless to anything that reads it without the application secret. Same argument as the
 *  workspace-finder codes. */
const hash = (code: string): string => createHmac("sha256", env.JWT_ACCESS_SECRET).update(code).digest("hex");

function sweep(now: number): void {
  for (const [key, value] of pending) if (value.expiresAt <= now) pending.delete(key);
}

/** Mints a one-time code for a completed sign-in. The code goes in the redirect; nothing else does. */
export function issueHandoffCode(payload: HandoffPayload): string {
  const now = Date.now();
  sweep(now);
  const code = randomBytes(32).toString("base64url");
  // Keyed by the HASH, so the raw code exists only in the redirect URL and never at rest.
  pending.set(hash(code), { ...payload, codeHash: hash(code), expiresAt: now + TTL_MS });
  return code;
}

export type HandoffResult = { ok: true; payload: HandoffPayload } | { ok: false; reason: "expired" | "wrong-workspace" };

/**
 * Redeems a code, once.
 *
 * `expectedOrgId` IS A SECURITY CHECK, not bookkeeping. The redeeming request arrives at whatever
 * hostname the browser was sent to, and that hostname is what `resolveTenant` turned into a
 * workspace. Without this, a code minted for one organization could be redeemed at another's origin
 * — which would write that organization's refresh cookie onto a hostname belonging to someone else.
 * Bound here rather than trusted from the URL.
 */
export function redeemHandoffCode(code: string, expectedOrgId: string): HandoffResult {
  const now = Date.now();
  sweep(now);
  if (!code) return { ok: false, reason: "expired" };

  const key = hash(code);
  const entry = pending.get(key);
  if (!entry) return { ok: false, reason: "expired" };

  // Constant-time even though the map lookup above already matched: the comparison is cheap and the
  // habit is what keeps a future refactor from introducing a timing signal here.
  const expected = Buffer.from(entry.codeHash, "hex");
  const actual = Buffer.from(key, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return { ok: false, reason: "expired" };

  // Burned whatever the outcome. A code that survives a failed redemption is a code somebody can
  // keep trying, and the org check below is exactly the thing worth retrying against.
  pending.delete(key);
  if (entry.orgId !== expectedOrgId) return { ok: false, reason: "wrong-workspace" };

  return {
    ok: true,
    payload: {
      orgId: entry.orgId,
      accessToken: entry.accessToken,
      refreshToken: entry.refreshToken,
      refreshTokenExpiresAt: entry.refreshTokenExpiresAt,
      user: entry.user
    }
  };
}

/** Test-only reset, so one spec's leftovers cannot decide another spec's outcome. */
export function __resetHandoffCodesForTests(): void {
  pending.clear();
}

/**
 * Test-only view of what is actually stored.
 *
 * Exists because the alternative was a test that could not see the thing it claimed to check: an
 * earlier version asserted "the raw code is not held anywhere" by serialising unrelated module
 * state, and storing the raw code on purpose left all nine tests green. A property about internal
 * representation needs a window onto that representation, or it is decoration.
 */
export function __handoffKeysForTests(): string[] {
  return [...pending.keys()];
}
