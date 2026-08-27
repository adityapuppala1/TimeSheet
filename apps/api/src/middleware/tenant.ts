/**
 * Tenant resolution — the request-path half of Phase B1 (see config/tenant-context.ts and
 * config/prisma.ts for the other half: how `prisma` resolves to the right client once this
 * middleware has decided which tenant is active).
 *
 * WHAT: resolves which Organization a request belongs to from its subdomain (e.g.
 * `acme.timesphere.app` -> slug "acme"), looks up that org's database connection in the
 * control-plane, and wraps the rest of the request in a tenant context so every
 * `import { prisma }` downstream transparently talks to that org's own database.
 *
 * WHY subdomain, and why before authentication: the browser already tells the server which
 * org it's talking to via the Host header, before any credentials are exchanged — this is
 * what makes per-org-configurable login methods possible without a chicken-and-egg problem
 * (you need to know which org's SSO config to redirect to before you know who the user is).
 * On-prem/local-dev requests (localhost, a bare IP, a domain with no subdomain) fall back to
 * `DEFAULT_ORG_SLUG` — a self-hosted deployment only ever has the one org this resolves to.
 */
import type { NextFunction, Request, Response } from "express";
import { controlPrisma } from "../config/control-prisma.js";
import { env } from "../config/env.js";
import { getTenantClient } from "../config/prisma.js";
import { tenantContext } from "../config/tenant-context.js";
import { decryptSecret } from "../utils/encryption.js";
import { verifyAccessToken } from "../utils/security.js";
import { AppError } from "./error.js";

const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/** The hostname a request names, lowercased and without its port. */
export function requestHostname(req: Request): string {
  return (req.headers.host ?? "").split(":")[0]?.toLowerCase() ?? "";
}

/**
 * True when this request is for the deployment's bare root domain rather than any workspace.
 *
 * Only meaningful in multi-org mode. It exists because that request used to resolve to
 * `DEFAULT_ORG_SLUG` — so `timesphere.app` silently served one specific customer's branded login
 * page to everybody who typed the domain without a subdomain. It should serve the workspace finder
 * instead, and the routing layer needs to be able to tell.
 */
export function isRootDomainRequest(req: Request): boolean {
  if (!env.ROOT_DOMAIN) return false;
  const hostname = requestHostname(req);
  return hostname === env.ROOT_DOMAIN.toLowerCase() || hostname === `www.${env.ROOT_DOMAIN.toLowerCase()}`;
}

/** Exported for the SSO start route (controllers/sso.controller.ts), which needs the same
 *  Host-header org resolution but runs outside this middleware (see that file's header
 *  comment for why the SSO routes are mounted before this one).
 *
 *  STRIPS `ROOT_DOMAIN` RATHER THAN COUNTING LABELS. The old rule was `labels.length < 3 →
 *  DEFAULT_ORG_SLUG`, which is wrong in both directions and was wrong quietly: the apex
 *  `timesphere.app` has two labels, so it fell through to one customer's workspace, and
 *  `timesphere.co.uk` has three, so it read "timesphere" as a slug. A domain's real root is not
 *  derivable from how many dots it has — the public suffix list exists because of exactly this.
 *  With ROOT_DOMAIN configured the answer is unambiguous; without it, every deployment keeps the
 *  behaviour it has today, which is what every current install runs on. */
export function resolveOrgSlug(req: Request): string {
  const hostname = requestHostname(req);

  if (env.ROOT_DOMAIN) {
    const root = env.ROOT_DOMAIN.toLowerCase();
    const suffix = `.${root}`;
    if (hostname.endsWith(suffix)) {
      // Everything to the left of the root. `a.b.timesphere.app` yields "a.b" and will simply not
      // match an org, which is the correct outcome for a hostname nothing was provisioned for.
      const slug = hostname.slice(0, -suffix.length);
      if (slug && slug !== "www") return slug;
    }
    // The apex, `www`, or an unrelated hostname (a custom domain — resolved by the caller before
    // this point). Falls through to the default, and `isRootDomainRequest` is what lets the
    // routing layer serve the finder instead of a tenant's login page.
    return env.DEFAULT_ORG_SLUG;
  }

  // Single-org / on-prem: unchanged. localhost, a bare IP, or a domain with too few labels to
  // carry a subdomain — none of these have a real subdomain to parse.
  const labels = hostname.split(".").filter(Boolean);
  if (!hostname || hostname === "localhost" || IP_RE.test(hostname) || labels.length < 3) {
    return env.DEFAULT_ORG_SLUG;
  }
  return labels[0];
}

/**
 * Resolves a verified CUSTOM domain to its org slug, or null.
 *
 * Checked before the subdomain rule by `resolveTenant`, so `time.acme.com` reaches Acme without any
 * other code path knowing custom domains exist. Only `verifiedAt` rows are consulted: an
 * unverified row is a claim, not a fact, and honouring one would let anybody point a hostname at
 * somebody else's workspace.
 */
export async function resolveCustomDomainSlug(hostname: string): Promise<string | null> {
  if (!hostname) return null;
  const row = await controlPrisma.orgDomain.findUnique({
    where: { domain: hostname },
    select: { verifiedAt: true, organization: { select: { slug: true } } }
  });
  return row?.verifiedAt ? row.organization.slug : null;
}

/**
 * Does this caller already know the workspace exists?
 *
 * Only the access-token signature and its `org` claim are checked — no session lookup, no user
 * lookup, because by definition we are on a path where the tenant database is NOT reachable
 * (that is the whole reason we are about to refuse the request). A valid signature over a
 * matching org id is enough for the one decision being made here: this caller held a session in
 * this workspace, so telling them WHY it is unavailable discloses nothing they did not already
 * know. It is deliberately not an authorization check and grants nothing.
 */
function callerHoldsSessionForOrg(req: Request | undefined, orgId: string): boolean {
  const header = req?.headers.authorization ?? "";
  if (!header.startsWith("Bearer ")) return false;
  try {
    return verifyAccessToken(header.slice(7).trim()).org === orgId;
  } catch {
    return false;
  }
}

/**
 * Also exported for the SSO start route and the five webhook receivers — same org lookup +
 * status validation `resolveTenant` does below, reused so there's exactly one place that decides
 * what counts as a usable org.
 *
 * WHY THE THREE FAILURE MODES COLLAPSE INTO ONE for a caller who can't prove they belong here:
 * this function runs BEFORE authentication on every request — it has to, since authenticating
 * needs the tenant's database, which needs this lookup. Answering 404 / 403 / 503 for
 * unknown / suspended / provisioning therefore hands any anonymous caller a lifecycle oracle:
 * `/api/scim/<guess>/v2/Users` and a forged `Host:` header both take a slug straight off the
 * wire, so an attacker could walk a wordlist and learn not just which workspaces exist but which
 * ones are suspended (a company in billing trouble) or mid-provisioning (a brand-new customer,
 * before anyone has logged in). That is competitive intelligence about someone else's tenant.
 *
 * `req` is threaded in so the distinction survives for the callers who are entitled to it: a
 * user holding a valid access token for THIS org still gets the real 403/503 and its explanation.
 * Everyone else gets the same 404 they'd get for a slug that was never registered. The webhook
 * receivers deliberately pass NO `req` — a machine caller holds a webhook secret, never a tenant
 * session, so there is nobody there to be entitled to the detail.
 *
 * WHAT THIS DELIBERATELY DOES NOT CLAIM: an ACTIVE workspace still answers requests, and no
 * status code can hide that — a correct slug reaches a login form and a wrong one does not. The
 * hole being closed is the LIFECYCLE STATE of workspaces that are not serving traffic, not the
 * existence of ones that are.
 *
 * WHY HERE AND NOT AT THE WEBHOOK ENTRY POINTS: the path-param receivers are the cheapest oracle,
 * but they are not the only one — `resolveTenant` below takes the slug from a Host header the
 * caller also controls, so fixing only the receivers would leave the same walk available one
 * route over. One choke point, and every future entry point inherits it.
 */
export async function resolveActiveOrgBySlug(slug: string, req?: Request) {
  const org = await controlPrisma.organization.findUnique({ where: { slug }, include: { database: true } });
  if (!org?.database) throw new AppError(404, "Unknown workspace.");
  // GRACE RESOLVES LIKE ACTIVE, and is shut everywhere past authentication instead — see the
  // OrgStatus comment. Refusing it here would refuse sign-in, and sign-in is how the one person who
  // can pay reaches the page that takes payment. `middleware/auth.ts` is what closes the door.
  if (org.status === "ACTIVE" || org.status === "GRACE") return org;

  if (!callerHoldsSessionForOrg(req, org.id)) throw new AppError(404, "Unknown workspace.");
  if (org.status === "SUSPENDED") throw new AppError(403, "This workspace has been suspended.");
  throw new AppError(503, "This workspace isn't ready yet — try again shortly.");
}

export async function resolveTenant(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    // A verified custom domain wins over the subdomain rule — see resolveCustomDomainSlug. One
    // extra indexed lookup per request only when ROOT_DOMAIN says this is a multi-org deployment
    // AND the hostname is not already a subdomain of it, so a single-org install pays nothing.
    const hostname = requestHostname(req);
    const custom =
      env.ROOT_DOMAIN && !hostname.endsWith(`.${env.ROOT_DOMAIN.toLowerCase()}`) ? await resolveCustomDomainSlug(hostname) : null;

    const org = await resolveActiveOrgBySlug(custom ?? resolveOrgSlug(req), req);
    // Non-null assertion is genuinely needed here, not just IDE-lint noise: TS's control-flow
    // narrowing of `org.database` inside resolveActiveOrgBySlug doesn't propagate through that
    // function's inferred return type across this call boundary, even though the guard there
    // already guarantees it.
    const dsn = decryptSecret(org.database!.encryptedDsn);
    const client = await getTenantClient(org.id, dsn);

    tenantContext.run({ orgId: org.id, orgSlug: org.slug, client }, () => next());
  } catch (error) {
    next(error);
  }
}
