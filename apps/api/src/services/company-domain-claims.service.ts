/**
 * WHAT: which workspace holds which company's email domain (signup Phase 1,
 * docs/SIGNUP_AND_DOMAINS_PLAN.md §5.4) — the lookup signup asks before it decides between "create a
 * workspace" and "ask to join the one your company has", and the operator actions that change it.
 *
 * WHY A CLAIM IS A ROW WITH A UNIQUE KEY, NOT A QUERY OVER `Organization.ownerEmail`. Two people from
 * a brand-new company finishing signup in the same second would both find "no workspace yet" and
 * both create one. The unique index on `OrgEmailDomain.domain` makes the database the arbiter: one
 * INSERT wins, the other fails, and `claimDomainInTransaction` turns that failure into a
 * `DomainAlreadyClaimedError` the signup route answers with "your company just got a workspace".
 *
 * WHAT IS NEVER A CLAIM: a personal-mail or throwaway provider (gmail.com is nobody's company), and a
 * domain held by an ARCHIVED workspace — deletion releases claims, and a leftover is read as free.
 *
 * NOT TO BE CONFUSED WITH `OrgDomain` / org-domain.service.ts — those are custom HOSTNAMES
 * (`time.acme.com` instead of `acme.timesphere.app`), DNS-verified, a different question entirely.
 */
import type { OrgStatus, Prisma } from "../generated/control-client/index.js";
import { controlPrisma } from "../config/control-prisma.js";
import { AppError } from "../middleware/error.js";
import { companyDomainOf } from "../utils/company-domain.js";
import { isDisposableAddress, isFreeMailAddress } from "../utils/free-mail-domains.js";
import { platformAudit } from "./platform-audit.service.js";

export type ClaimSource = "SIGNUP" | "BACKFILL" | "ADMIN";

/** The signup race was lost: somebody else's workspace claimed this domain first. */
export class DomainAlreadyClaimedError extends Error {
  constructor(public readonly domain: string) {
    super(`The domain ${domain} is already claimed by another workspace.`);
    this.name = "DomainAlreadyClaimedError";
  }
}

export interface ClaimLookup {
  domain: string;
  organization: { id: string; name: string; slug: string; status: OrgStatus };
}

/** A domain no workspace may hold: a personal or throwaway provider. */
function isPersonalDomain(domain: string): boolean {
  const probe = `x@${domain}`;
  return isFreeMailAddress(probe) || isDisposableAddress(probe);
}

/**
 * The workspace this address's company already has, or null. ARCHIVED counts as none: its database
 * is gone, and the company must be able to start again. Every other status is returned as it is —
 * the caller decides what GRACE or SUSPENDED means (decision 8: unavailable, not a new workspace).
 */
export async function findClaimForEmail(email: string): Promise<ClaimLookup | null> {
  const domain = companyDomainOf(email);
  if (!domain) return null;
  const claim = await controlPrisma.orgEmailDomain.findUnique({
    where: { domain },
    include: { organization: { select: { id: true, name: true, slug: true, status: true } } }
  });
  if (!claim?.organization || claim.organization.status === "ARCHIVED") return null;
  return { domain, organization: claim.organization };
}

/**
 * Claims `domain` for `organizationId` inside the caller's transaction — signup creates the
 * workspace row and its claim together, so a lost race leaves neither behind.
 */
export async function claimDomainInTransaction(
  tx: Pick<Prisma.TransactionClient, "orgEmailDomain">,
  domain: string,
  organizationId: string,
  source: ClaimSource
): Promise<void> {
  try {
    await tx.orgEmailDomain.create({ data: { domain, organizationId, source } });
  } catch (error) {
    // Only the unique key means "somebody else won". Anything else is a real failure and must
    // surface as one, not be reported to a customer as "your company already has a workspace".
    if ((error as { code?: string }).code === "P2002") throw new DomainAlreadyClaimedError(domain);
    throw error;
  }
}

export async function claimsForOrg(organizationId: string) {
  const rows = await controlPrisma.orgEmailDomain.findMany({ where: { organizationId }, orderBy: { domain: "asc" } });
  return rows.map((row) => ({ domain: row.domain, status: row.status, source: row.source, createdAt: row.createdAt }));
}

/** The canonical form of a domain an operator typed, or a 422 that says what would be accepted. */
function canonicalDomain(typed: string): string {
  const domain = companyDomainOf(`x@${typed.trim().replace(/^@+/, "")}`);
  if (!domain) throw new AppError(422, `"${typed}" is not a company email domain.`);
  if (domain !== typed.trim().toLowerCase()) {
    // A sub-domain belongs to its company's domain (decision 9) — claiming eng.acme.com separately
    // would never match anybody, because every address under it rolls up to acme.com.
    throw new AppError(422, `Claims are made on the company domain: use ${domain}, which covers ${typed.trim().toLowerCase()}.`);
  }
  if (isPersonalDomain(domain)) throw new AppError(422, `${domain} is a personal or temporary email provider — it is nobody's company.`);
  return domain;
}

/** Gives `domain` to a workspace, taking it from another if necessary. An operator decision, audited
 *  with the previous holder so a reassignment can be traced and undone. */
export async function assignClaim(typedDomain: string, organizationId: string, actorLabel: string): Promise<void> {
  const domain = canonicalDomain(typedDomain);
  const org = await controlPrisma.organization.findUnique({ where: { id: organizationId }, select: { id: true, status: true } });
  if (!org) throw new AppError(404, "That workspace does not exist.");
  if (org.status === "ARCHIVED") throw new AppError(422, "That workspace was deleted; a domain cannot point at it.");
  const previous = await controlPrisma.orgEmailDomain.findUnique({ where: { domain } });
  await controlPrisma.orgEmailDomain.upsert({
    where: { domain },
    create: { domain, organizationId, source: "ADMIN" },
    update: { organizationId, source: "ADMIN" }
  });
  await platformAudit("PLATFORM_ADMIN", actorLabel, "company_domain.assigned", "OrgEmailDomain", domain, {
    organizationId,
    previousOrganizationId: previous?.organizationId ?? null
  });
}

export async function releaseClaim(typedDomain: string, actorLabel: string): Promise<void> {
  const domain = typedDomain.trim().toLowerCase();
  const previous = await controlPrisma.orgEmailDomain.findUnique({ where: { domain } });
  if (!previous) throw new AppError(404, `No workspace holds ${domain}.`);
  await controlPrisma.orgEmailDomain.deleteMany({ where: { domain } });
  await platformAudit("PLATFORM_ADMIN", actorLabel, "company_domain.released", "OrgEmailDomain", domain, { organizationId: previous.organizationId });
}

export interface BackfillPlan {
  toClaim: Array<{ domain: string; organizationId: string; orgName: string }>;
  conflicts: Array<{ domain: string; orgs: Array<{ id: string; name: string; slug: string }> }>;
  /** Workspaces with nothing to claim: a personal owner address, no company domain, or a domain
   *  that is already claimed. */
  skipped: number;
}

/**
 * What a backfill would do, without doing it. Existing workspaces predate claims; each one's
 * company domain comes from `ownerEmail` (the address it was signed up or provisioned with).
 *
 * TWO WORKSPACES SHARING A DOMAIN ARE A CONFLICT, AND NEITHER IS CLAIMED. Picking one — the oldest,
 * the biggest, the paying one — is a guess about which of two companies' workspaces a stranger
 * should be sent to, and a wrong guess sends them into the other one. An operator decides.
 */
export async function planBackfill(): Promise<BackfillPlan> {
  const [workspaces, existing] = await Promise.all([
    controlPrisma.organization.findMany({
      where: { status: { not: "ARCHIVED" }, ownerEmail: { not: null } },
      select: { id: true, name: true, slug: true, ownerEmail: true },
      orderBy: { createdAt: "asc" }
    }),
    controlPrisma.orgEmailDomain.findMany({ select: { domain: true } })
  ]);
  const claimed = new Set(existing.map((row) => row.domain));
  const byDomain = new Map<string, Array<{ id: string; name: string; slug: string }>>();
  let skipped = 0;
  for (const org of workspaces) {
    const domain = org.ownerEmail ? companyDomainOf(org.ownerEmail) : null;
    if (!domain || isPersonalDomain(domain) || claimed.has(domain)) {
      skipped += 1;
      continue;
    }
    byDomain.set(domain, [...(byDomain.get(domain) ?? []), { id: org.id, name: org.name, slug: org.slug }]);
  }
  const plan: BackfillPlan = { toClaim: [], conflicts: [], skipped };
  for (const [domain, holders] of byDomain) {
    if (holders.length === 1) plan.toClaim.push({ domain, organizationId: holders[0].id, orgName: holders[0].name });
    else plan.conflicts.push({ domain, orgs: holders });
  }
  return plan;
}

/** Applies the unambiguous part of the plan. Conflicts are reported and left for an operator. */
export async function applyBackfill(actorLabel: string): Promise<{ claimed: number; conflicts: number }> {
  const plan = await planBackfill();
  let claimed = 0;
  for (const entry of plan.toClaim) {
    try {
      await controlPrisma.orgEmailDomain.create({ data: { domain: entry.domain, organizationId: entry.organizationId, source: "BACKFILL" } });
      claimed += 1;
    } catch (error) {
      // Claimed between plan and apply — by a signup that just happened. It won fairly; move on.
      if ((error as { code?: string }).code !== "P2002") throw error;
    }
  }
  await platformAudit("PLATFORM_ADMIN", actorLabel, "company_domain.backfilled", "OrgEmailDomain", null, {
    claimed: plan.toClaim.map((entry) => entry.domain),
    conflicts: plan.conflicts.map((entry) => entry.domain)
  });
  return { claimed, conflicts: plan.conflicts.length };
}

/**
 * After a snapshot restore brings a deleted workspace back (platform-backup.service.ts), its claim —
 * released at deletion — is re-made if the domain is still free. NEVER taken from a workspace that
 * claimed it since: that company now has a live workspace, and the restored one is the newcomer.
 */
export async function reclaimAfterRestore(org: { id: string; ownerEmail: string | null }): Promise<"claimed" | "taken" | "none"> {
  const domain = org.ownerEmail ? companyDomainOf(org.ownerEmail) : null;
  if (!domain || isPersonalDomain(domain)) return "none";
  try {
    await controlPrisma.orgEmailDomain.create({ data: { domain, organizationId: org.id, source: "SIGNUP" } });
    return "claimed";
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") return "taken";
    throw error;
  }
}
