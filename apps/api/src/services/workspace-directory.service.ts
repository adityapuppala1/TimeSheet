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
import { requireTenantContext } from "../config/tenant-context.js";

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

/**
 * The base URL for a link that will be sent to a person in the CURRENTLY ACTIVE tenant.
 *
 * WHY THIS EXISTS — A BUG THAT WAS MEASURED, NOT IMAGINED. Every emailed link in the application
 * was built from the single global `APP_BASE_URL`, and every token those links carry lives in ONE
 * tenant's database. In multi-org mode those two facts contradict each other. Reproduced on a
 * running server: a password reset requested at `Host: acme.example.test` wrote its
 * `PasswordResetToken` row to `acme_corp` (0 → 1 rows) while `timesheet_portal` stayed at 4 — and
 * the emailed link pointed at `APP_BASE_URL`, whose hostname resolves to the DEFAULT workspace. The
 * recipient would open the link, `resetPassword` would search the default org's database for a token
 * that only exists in Acme's, and the person would be told "This reset link is invalid or has
 * expired." Every single time, for every tenant that is not the default one.
 *
 * WHY IT IS BUILT FROM CONFIGURATION AND NEVER FROM `req.headers.host`, which looks like the more
 * accurate answer and is a vulnerability. Putting a request-supplied hostname into a
 * password-reset email is textbook host-header injection: an attacker POSTs `/forgot-password`
 * with `Host: evil.example`, and the victim receives a genuine reset token addressed to the
 * attacker's server. `resolveTenant` is NOT a sufficient guard against this — with `ROOT_DOMAIN`
 * unset, any two-label hostname falls through to `DEFAULT_ORG_SLUG` and resolves perfectly well, so
 * `Host: evil.example` would reach a handler. The org slug, by contrast, comes from the control
 * plane. Do not "improve" this to read the request.
 *
 * WHAT IT COSTS. A tenant on a verified custom domain gets links on `<slug>.<ROOT_DOMAIN>` rather
 * than their own domain. Both addresses resolve to the same workspace (custom domains are checked
 * first, and the wildcard that multi-org mode already requires covers the other), so the link
 * works — it is just not their branded hostname. Preferring the custom domain would mean a control
 * plane lookup on every emailed link; that is the trade, and it is recorded here rather than
 * rediscovered.
 *
 * In single-org mode — `ROOT_DOMAIN` unset, which is every on-prem install — this returns exactly
 * what the call sites returned before, byte for byte. There is no behaviour change to inherit.
 */
export function tenantBaseUrl(): string {
  let slug: string | undefined;
  try {
    slug = requireTenantContext().orgSlug;
  } catch {
    /**
     * NO TENANT CONTEXT IS A VALID ANSWER HERE, which is why this catches rather than propagates.
     * `requireTenantContext` throws because a `prisma` access outside a context is always a bug — a
     * missing middleware or an unwrapped worker tick. A LINK BASE outside a context is a different
     * question with a legitimate answer: the caller is control-plane (platform-admin mail, sales
     * leads, the console's own alerts), those messages are about the deployment rather than about
     * any workspace, and the deployment's own address is correct for them.
     *
     * AND IT READS THROUGH `requireTenantContext` RATHER THAN `tenantContext.getStore()`, which was
     * the first version and broke seven test files. Twelve unit suites replace this module with a
     * one-line `vi.mock` factory exporting only `requireTenantContext` — see the same constraint
     * documented at length in `config/with-org-tenant.ts`. Reaching for a second export meant every
     * one of those factories had to grow a copy of the store, and so would every future one. Going
     * through the function they already stub costs nothing and keeps the hazard from recurring.
     */
  }
  return slug ? workspaceUrlForSlug(slug) : env.APP_BASE_URL.replace(/\/$/, "");
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
