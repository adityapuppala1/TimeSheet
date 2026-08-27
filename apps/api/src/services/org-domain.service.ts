/**
 * Custom domains — putting a workspace on `time.acme.com` instead of `acme.timesphere.app`.
 *
 * THE TABLE AND THE RESOLUTION ALREADY SHIPPED (3.6.0): `middleware/tenant.ts` consults a VERIFIED
 * `OrgDomain` ahead of the subdomain rule, so a verified row routes traffic today. What was missing
 * was any way to create one, prove it, or take it away — which made the feature real for exactly
 * nobody. This is that half.
 *
 * WHY DNS AND NOT A FILE UPLOAD OR AN EMAIL CLICK. The question being answered is "does this person
 * control this domain". A file at `/.well-known/…` proves control of one web server that happens to
 * answer for the hostname today; an email to `admin@` proves control of a mailbox. Only a DNS
 * record proves control of the domain itself, which is the thing being claimed — and it is the
 * mechanism every certificate authority and every SaaS with this feature settled on for that reason.
 *
 * AN UNVERIFIED ROW IS INERT, which is what makes this safe to expose at all. `resolveCustomDomainSlug`
 * only reads rows with `verifiedAt` set, so creating a row that claims someone else's domain routes
 * nothing and grants nothing. The row is a claim; the TXT record is the proof.
 */
import dns from "node:dns/promises";
import { randomBytes } from "node:crypto";
import { controlPrisma } from "../config/control-prisma.js";
import { AppError } from "../middleware/error.js";

/** The subdomain the proof is published at. Prefixed with an underscore by convention — RFC 8552
 *  reserves that shape for records consumed by software rather than by people, which keeps it out
 *  of the way of anything the customer actually hosts. */
export const VERIFY_PREFIX = "_timesphere-verify";

/**
 * Hostnames this deployment must never hand to a customer.
 *
 * A verified `OrgDomain` resolves AHEAD of the subdomain rule, so a row for the deployment's own
 * root or for any `*.ROOT_DOMAIN` name would let one workspace intercept traffic meant for another
 * — or for the workspace finder. The DNS check would fail for a domain they do not control, but
 * "an attacker cannot finish the flow" is a weaker guarantee than "the flow cannot be started", and
 * the operator's own domain is exactly the case where the two differ (they DO control it).
 */
function reservedProblem(domain: string, rootDomain: string | undefined): string | null {
  if (!rootDomain) return null;
  const root = rootDomain.toLowerCase();
  if (domain === root || domain === `www.${root}`) return "That is this deployment's own domain.";
  if (domain.endsWith(`.${root}`)) return `Workspaces on ${root} already have an address — a custom domain is for a hostname you own.`;
  return null;
}

/** Normalises what someone pasted into a bare hostname: strips a scheme, a path, a port, a trailing
 *  dot and surrounding space, all of which people include and none of which DNS wants. */
export function normaliseDomain(raw: string): string {
  let value = raw.trim().toLowerCase();
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  value = value.split("/")[0].split("?")[0];
  value = value.split(":")[0];
  return value.replace(/\.$/, "");
}

const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function domainProblem(domain: string, rootDomain: string | undefined): string | null {
  if (!HOSTNAME_RE.test(domain)) return "That doesn't look like a hostname — use something like time.yourcompany.com.";
  return reservedProblem(domain, rootDomain);
}

export interface DomainRow {
  id: string;
  domain: string;
  verified: boolean;
  verifiedAt: Date | null;
  lastCheckedAt: Date | null;
  lastCheckError: string | null;
  /** What the customer publishes, spelled out so the console can show it verbatim. */
  recordName: string;
  recordValue: string;
}

function toRow(row: {
  id: string;
  domain: string;
  verificationToken: string;
  verifiedAt: Date | null;
  lastCheckedAt: Date | null;
  lastCheckError: string | null;
}): DomainRow {
  return {
    id: row.id,
    domain: row.domain,
    verified: row.verifiedAt !== null,
    verifiedAt: row.verifiedAt,
    lastCheckedAt: row.lastCheckedAt,
    lastCheckError: row.lastCheckError,
    recordName: `${VERIFY_PREFIX}.${row.domain}`,
    recordValue: row.verificationToken
  };
}

export async function listDomains(orgId: string): Promise<DomainRow[]> {
  const rows = await controlPrisma.orgDomain.findMany({ where: { organizationId: orgId }, orderBy: { createdAt: "asc" } });
  return rows.map(toRow);
}

export async function addDomain(orgId: string, raw: string, rootDomain: string | undefined): Promise<DomainRow> {
  const domain = normaliseDomain(raw);
  const problem = domainProblem(domain, rootDomain);
  if (problem) throw new AppError(422, problem);

  // GLOBALLY unique, not per-org: two workspaces cannot both claim a hostname, because only one of
  // them could ever receive its traffic. Reported as a conflict rather than silently reassigned.
  const existing = await controlPrisma.orgDomain.findUnique({ where: { domain }, select: { organizationId: true } });
  if (existing) {
    throw new AppError(409, existing.organizationId === orgId ? "That domain is already on this workspace." : "That domain is already claimed by another workspace.");
  }

  const row = await controlPrisma.orgDomain.create({
    data: { organizationId: orgId, domain, verificationToken: `timesphere-verify=${randomBytes(16).toString("hex")}` }
  });
  return toRow(row);
}

/**
 * Looks for the TXT record and marks the domain verified if it is there.
 *
 * WHY IT RE-CHECKS A DOMAIN THAT IS ALREADY VERIFIED: it does not. Verification is a one-way latch
 * on purpose. DNS is not always reachable — a resolver hiccup, a registrar migration, a customer
 * tidying records they no longer recognise — and un-verifying on a failed lookup would take a live
 * workspace off its own domain because of a transient. Removing a domain is a deliberate act, and
 * this route is not it.
 */
export async function verifyDomain(orgId: string, domainId: string): Promise<DomainRow> {
  const row = await controlPrisma.orgDomain.findFirst({ where: { id: domainId, organizationId: orgId } });
  if (!row) throw new AppError(404, "Domain not found on this workspace.");
  if (row.verifiedAt) return toRow(row);

  const recordName = `${VERIFY_PREFIX}.${row.domain}`;
  let found: string[] = [];
  let error: string | null = null;
  try {
    // resolveTxt returns chunks per record; a long value can be split across strings, so each
    // record's chunks are joined before comparison. Missing that is the classic reason a correctly
    // published record "doesn't verify".
    const records = await dns.resolveTxt(recordName);
    found = records.map((chunks) => chunks.join(""));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    error =
      code === "ENOTFOUND" || code === "ENODATA"
        ? `No TXT record found at ${recordName}. DNS changes can take a few minutes to propagate.`
        : `Couldn't read DNS for ${recordName}: ${(err as Error).message}`;
  }

  const matched = found.includes(row.verificationToken);
  if (!matched && !error) {
    error = found.length
      ? `A TXT record exists at ${recordName} but its value doesn't match. Replace it with the exact value shown.`
      : `No TXT record found at ${recordName}.`;
  }

  const updated = await controlPrisma.orgDomain.update({
    where: { id: row.id },
    data: { lastCheckedAt: new Date(), lastCheckError: matched ? null : error, ...(matched ? { verifiedAt: new Date() } : {}) }
  });
  return toRow(updated);
}

export async function removeDomain(orgId: string, domainId: string): Promise<void> {
  const deleted = await controlPrisma.orgDomain.deleteMany({ where: { id: domainId, organizationId: orgId } });
  if (deleted.count === 0) throw new AppError(404, "Domain not found on this workspace.");
}
