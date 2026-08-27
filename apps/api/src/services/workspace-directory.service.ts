/**
 * WHAT: "which workspaces can this email address sign in to?", and the index that can answer it.
 *
 * WHY THIS IS NOT A SIMPLE QUERY. Every organisation's users live in a physically separate MySQL
 * database (see middleware/tenant.ts). There is no table anywhere that lists a person's
 * workspaces, and there cannot be one built from tenant data without opening every tenant database
 * on every lookup. So the control plane keeps its own index, written as people sign in.
 *
 * WHY THE INDEX IS HASHED. The control plane already holds the org registry, the plan matrix and
 * every tenant's database credentials. Adding a plaintext list of every user's email across every
 * customer would make one dump of it a customer list and a marketing list at the same time —
 * materially worse than what it already is. An HMAC keyed with the app's own secret answers the
 * only question this index is asked ("does the address someone just typed match this row?") and
 * answers nothing else: it cannot be enumerated, reversed, or exported as addresses.
 *
 * WHY THE LOOKUP IS VERIFY-FIRST. An endpoint that answers "which workspaces is bob@acme.com in?"
 * tells anyone who asks that bob@acme.com exists, and where he works. That is precisely the
 * disclosure `middleware/tenant.ts` already goes out of its way to prevent — it collapses
 * unknown / suspended / provisioning into one 404 so an anonymous caller cannot walk a wordlist and
 * learn which workspaces exist or which are in billing trouble. Building a bare lookup here would
 * hand that back one route over. So the flow is: submit an address, always get the same answer,
 * receive a code by email only if it matched, and see the workspace list only after returning it.
 *
 * The result is that discovery costs an attacker an inbox they do not control, which is the same
 * bar the password-reset flow already sets.
 */
import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { controlPrisma } from "../config/control-prisma.js";
import { env } from "../config/env.js";

/**
 * Keyed hash of an email address.
 *
 * Keyed, not plain SHA-256: an unkeyed hash of an email address is reversible in practice, because
 * the input space is small enough to enumerate — every address at every domain a company owns is a
 * few million guesses. The key makes the index useless to anyone who has the rows but not the
 * application secret.
 *
 * Normalised the same way `login` normalises, so the two cannot disagree about whether
 * `Bob@Acme.com` and `bob@acme.com` are the same person.
 */
export function directoryHash(email: string): string {
  return createHmac("sha256", env.JWT_ACCESS_SECRET).update(email.trim().toLowerCase()).digest("hex");
}

/**
 * Records that this address can sign in to this workspace.
 *
 * Called from the one place every login method funnels through (auth.service.ts#establishSession),
 * so password, Google, Microsoft, SAML and LDAP all populate it without five call sites to keep in
 * step — the same argument that file already makes for its maintenance and agent gates.
 *
 * Best-effort: a control-plane write must never fail a sign-in that has already succeeded. The
 * cost of losing one is that the person cannot find that workspace by email until their next
 * sign-in, which they are self-evidently able to do.
 */
export async function rememberWorkspaceMembership(orgId: string, email: string): Promise<void> {
  try {
    const emailHash = directoryHash(email);
    await controlPrisma.orgUserDirectory.upsert({
      where: { organizationId_emailHash: { organizationId: orgId, emailHash } },
      update: { lastSeenAt: new Date() },
      create: { organizationId: orgId, emailHash }
    });
  } catch {
    /* see above — never fails the login it is recording */
  }
}

/** Removes an address from the index — called when a user is deleted, so a departed employee's
 *  address stops naming their former employer's workspace to whoever now owns that mailbox. */
export async function forgetWorkspaceMembership(orgId: string, email: string): Promise<void> {
  try {
    await controlPrisma.orgUserDirectory.deleteMany({ where: { organizationId: orgId, emailHash: directoryHash(email) } });
  } catch {
    /* deliberately silent, same reasoning as above */
  }
}

export interface DiscoveredWorkspace {
  slug: string;
  name: string;
  /** Where to send them. A verified custom domain wins, because that is the address their IdP,
   *  their bookmarks and their IT department already use. */
  url: string;
}

/**
 * The workspaces an address belongs to, in the shape the finder renders.
 *
 * ONLY ACTIVE ORGS. A suspended or provisioning workspace is omitted rather than listed as
 * unavailable, for the same reason `resolveActiveOrgBySlug` refuses to distinguish them: "your
 * former employer is suspended" is competitive intelligence, and this endpoint is reachable by
 * anyone who controls a mailbox at that company — including someone who left it.
 */
export async function findWorkspacesForEmail(email: string): Promise<DiscoveredWorkspace[]> {
  const rows = await controlPrisma.orgUserDirectory.findMany({
    where: { emailHash: directoryHash(email), organization: { status: "ACTIVE" } },
    include: { organization: { include: { domains: { where: { verifiedAt: { not: null } }, take: 1 } } } },
    orderBy: { lastSeenAt: "desc" }
  });

  return rows.map((row) => {
    const custom = row.organization.domains[0]?.domain;
    return {
      slug: row.organization.slug,
      name: row.organization.name,
      url: custom ? `https://${custom}` : workspaceUrlForSlug(row.organization.slug)
    };
  });
}

/**
 * The public URL of a workspace on this deployment.
 *
 * Built from ROOT_DOMAIN when one is configured — a multi-org SaaS install. Without it this is a
 * single-org or on-prem deployment where every workspace is simply the app's own base URL, and
 * inventing a subdomain would produce a link that resolves to nothing.
 */
export function workspaceUrlForSlug(slug: string): string {
  if (!env.ROOT_DOMAIN) return env.APP_BASE_URL.replace(/\/$/, "");
  return `https://${slug}.${env.ROOT_DOMAIN}`;
}

/* ------------------------------------------------------------------ *
 * The verification codes
 * ------------------------------------------------------------------ */

interface PendingCode {
  codeHash: string;
  email: string;
  expiresAt: number;
  attempts: number;
}

/**
 * In-memory, deliberately.
 *
 * These live for ten minutes and are worthless afterwards, so a database table would be a schema,
 * a migration and a cleanup job in exchange for surviving a restart nobody would notice. The
 * failure mode of losing them — the person requests another code — is the same thing they would do
 * if the email were slow.
 *
 * The honest limitation: this does not survive a restart and does not span replicas, so a
 * multi-instance deployment behind a round-robin load balancer will sometimes hand a code to one
 * process and the verification to another. That is a real constraint on this being in memory, and
 * the fix when it matters is a shared store, not a bigger map.
 */
const pending = new Map<string, PendingCode>();
const CODE_TTL_MS = 10 * 60 * 1000;
/** Six digits is 1e6 codes; five guesses against a ten-minute window is a 1-in-200,000 chance. */
const MAX_ATTEMPTS = 5;

function sweep(now: number): void {
  for (const [key, value] of pending) if (value.expiresAt <= now) pending.delete(key);
}

/** Six digits, uniformly. `Math.random` is not used: this is an authentication factor. */
function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function issueVerificationCode(email: string): { token: string; code: string } {
  const now = Date.now();
  sweep(now);
  const token = randomBytes(24).toString("base64url");
  const code = generateCode();
  // The CODE is hashed at rest for the same reason a password is: this map is reachable from a heap
  // dump, and a plaintext code in it is a live credential for somebody's workspace list.
  pending.set(token, { codeHash: directoryHash(code + token), email, expiresAt: now + CODE_TTL_MS, attempts: 0 });
  return { token, code };
}

export type CodeCheck = { ok: true; email: string } | { ok: false; reason: "expired" | "wrong" | "exhausted" };

export function checkVerificationCode(token: string, code: string): CodeCheck {
  const now = Date.now();
  sweep(now);
  const entry = pending.get(token);
  if (!entry) return { ok: false, reason: "expired" };
  if (entry.attempts >= MAX_ATTEMPTS) {
    pending.delete(token);
    return { ok: false, reason: "exhausted" };
  }

  const expected = Buffer.from(entry.codeHash, "hex");
  const actual = Buffer.from(directoryHash(code + token), "hex");
  // Constant-time, so the number of correct leading digits is not readable from response timing.
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    entry.attempts += 1;
    return { ok: false, reason: "wrong" };
  }

  // Single-use: a code that still works after it has been redeemed is a code sitting in an inbox
  // that anyone who later reads that inbox can replay.
  pending.delete(token);
  return { ok: true, email: entry.email };
}

/** Test-only reset, so one spec's leftover codes cannot decide another spec's outcome. */
export function __resetVerificationCodesForTests(): void {
  pending.clear();
}
