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

/** Exported for the SSO start route (controllers/sso.controller.ts), which needs the same
 *  Host-header org resolution but runs outside this middleware (see that file's header
 *  comment for why the SSO routes are mounted before this one). */
export function resolveOrgSlug(req: Request): string {
  const hostHeader = req.headers.host ?? "";
  const hostname = hostHeader.split(":")[0]?.toLowerCase() ?? "";
  const labels = hostname.split(".").filter(Boolean);

  // localhost / 127.0.0.1 / a bare IP / a domain with too few labels to carry a subdomain
  // (e.g. just "timesphere.app") — none of these have a real subdomain to parse.
  if (!hostname || hostname === "localhost" || IP_RE.test(hostname) || labels.length < 3) {
    return env.DEFAULT_ORG_SLUG;
  }
  return labels[0];
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
  if (org.status === "ACTIVE") return org;

  if (!callerHoldsSessionForOrg(req, org.id)) throw new AppError(404, "Unknown workspace.");
  if (org.status === "SUSPENDED") throw new AppError(403, "This workspace has been suspended.");
  throw new AppError(503, "This workspace isn't ready yet — try again shortly.");
}

export async function resolveTenant(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const org = await resolveActiveOrgBySlug(resolveOrgSlug(req), req);
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
