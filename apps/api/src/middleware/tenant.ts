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

/** Also exported for the SSO start route — same org lookup + status validation `resolveTenant`
 *  does below, reused so there's exactly one place that decides what counts as a usable org. */
export async function resolveActiveOrgBySlug(slug: string) {
  const org = await controlPrisma.organization.findUnique({ where: { slug }, include: { database: true } });
  if (!org?.database) throw new AppError(404, "Unknown workspace.");
  if (org.status === "SUSPENDED") throw new AppError(403, "This workspace has been suspended.");
  if (org.status !== "ACTIVE") throw new AppError(503, "This workspace isn't ready yet — try again shortly.");
  return org;
}

export async function resolveTenant(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const org = await resolveActiveOrgBySlug(resolveOrgSlug(req));
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
