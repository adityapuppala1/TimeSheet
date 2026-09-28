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
 * WHY THE CONTROL PLANE AND NOT AN IN-MEMORY MAP, which is what this was for one commit. A map
 * works on exactly one process. On a deployment with several API replicas behind a round-robin
 * balancer the code is minted on one pod and redeemed on another — so the sign-in fails at random,
 * which is the worst kind of bug to field because retrying usually works. It also lost every
 * in-flight sign-in on a restart or a rolling deploy. The CONTROL plane specifically, because this
 * is cross-tenant by nature: written by a callback that has not resolved a tenant from its Host
 * header, read by a request that has, with no single tenant database both halves could agree on.
 *
 * WHY SINGLE-ORG DEPLOYMENTS NEVER SEE ANY OF THIS. `finishSsoLogin` only takes this path when the
 * workspace's base URL differs from the origin the callback arrived on, which cannot happen unless
 * `ROOT_DOMAIN` is set or the workspace has a custom domain. Every on-prem install keeps the exact
 * redirect it has today, and never writes a row here.
 */
import { createHmac, randomBytes } from "node:crypto";
import { controlPrisma } from "../config/control-prisma.js";
import { env } from "../config/env.js";
import { decryptSecret, encryptSecret } from "../utils/encryption.js";

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

/**
 * Keyed hash of the one-time code.
 *
 * Keyed with the app's own secret rather than a bare digest, for the same reason the workspace
 * directory hashes email addresses: this row is reachable by anything that can read the control
 * plane, and the key is what makes it useless without the application secret. The RAW code exists
 * only in the redirect URL and is never written anywhere.
 */
const hashCode = (code: string): string => createHmac("sha256", env.JWT_ACCESS_SECRET).update(code).digest("hex");

/**
 * Mints a one-time code for a completed sign-in. The code goes in the redirect; nothing else does.
 *
 * The payload is AES-encrypted at rest with `ENCRYPTION_KEY` — the same treatment tenant DSNs and
 * BYOK provider keys get. It holds a usable refresh token for up to a minute, so it gets the
 * protection of the credentials it sits beside rather than less.
 */
export async function issueHandoffCode(payload: HandoffPayload): Promise<string> {
  const code = randomBytes(32).toString("base64url");

  await controlPrisma.ssoHandoffCode.create({
    data: {
      codeHash: hashCode(code),
      organizationId: payload.orgId,
      encryptedPayload: encryptSecret(JSON.stringify(payload)),
      expiresAt: new Date(Date.now() + TTL_MS)
    }
  });

  // Opportunistic sweep: the table would otherwise accumulate a row per SSO sign-in forever.
  //
  // AWAITED RATHER THAN DETACHED, which is the opposite of the usual instinct. This runs on a
  // sign-in, not a page load, and it is one indexed DELETE over a table that holds at most a
  // minute of traffic — so the latency is irrelevant, and awaiting means no floating promise and a
  // deterministic state for anything that looks at the table afterwards. Swallowed, because a
  // failed sweep must not fail a sign-in that has already succeeded: the rows are expired and
  // unusable either way, and the next mint tries again.
  try {
    await controlPrisma.ssoHandoffCode.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  } catch {
    /* see above */
  }

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
 * Bound at mint time rather than trusted from the URL.
 *
 * THE ROW IS DELETED BEFORE THE ORGANIZATION IS CHECKED, deliberately. A code that survives a failed
 * redemption is a code somebody can keep trying, and the organization check is exactly the thing
 * worth retrying against — at every origin they can reach. The delete is also what makes this
 * single-use ACROSS REPLICAS: `deleteMany` reports how many rows it removed, so two pods racing to
 * redeem the same code produce exactly one winner and the loser sees "expired".
 */
export async function redeemHandoffCode(code: string, expectedOrgId: string): Promise<HandoffResult> {
  if (!code) return { ok: false, reason: "expired" };

  const row = await controlPrisma.ssoHandoffCode.findUnique({ where: { codeHash: hashCode(code) } });
  if (!row) return { ok: false, reason: "expired" };

  // ATOMIC CLAIM — the database decides the winner, not a read-then-write in application code.
  const claimed = await controlPrisma.ssoHandoffCode.deleteMany({ where: { id: row.id } });
  if (claimed.count === 0) return { ok: false, reason: "expired" };

  // Expiry is checked AFTER the claim, so an expired code is burned here rather than left for the
  // sweep — and an expired code and an unknown one report identically, which is what stops the
  // response telling an anonymous caller whether a code they hold was ever real.
  if (row.expiresAt.getTime() <= Date.now()) return { ok: false, reason: "expired" };
  if (row.organizationId !== expectedOrgId) return { ok: false, reason: "wrong-workspace" };

  const payload = JSON.parse(decryptSecret(row.encryptedPayload)) as HandoffPayload;
  return {
    ok: true,
    // `refreshTokenExpiresAt` survives JSON as a STRING, and the refresh cookie's `expires` needs a
    // real Date — handing the string through produced a session cookie that vanished with the
    // browser, i.e. "signed out every time I close the tab" for SSO users only.
    payload: { ...payload, refreshTokenExpiresAt: new Date(payload.refreshTokenExpiresAt) }
  };
}

/** Test-only reset, so one spec's leftovers cannot decide another spec's outcome. */
export async function __resetHandoffCodesForTests(): Promise<void> {
  await controlPrisma.ssoHandoffCode.deleteMany({});
}
