/**
 * The verified custom domains this deployment serves, cached so CORS can ask on every request.
 *
 * WHY THIS EXISTS. A workspace can be reached on its own domain (`time.acme.com`), and the browser
 * then sends `Origin: https://time.acme.com` on every write. `WEB_ORIGIN` is a fixed list written at
 * deploy time and `ROOT_DOMAIN` only covers subdomains of one root, so neither can answer for a
 * customer domain that was verified after the process started. Without this, verifying a custom
 * domain in the platform console produced a workspace whose login page rendered perfectly and could
 * not sign anybody in — the same failure shape as the ROOT_DOMAIN bug, one layer out, and just as
 * silent.
 *
 * WHY A CACHE AND NOT A QUERY. This is consulted on every request that carries an `Origin` header,
 * which is every write in the product. A control-plane round trip there would put a database call in
 * front of the CORS middleware — before authentication, before rate limiting, reachable by anyone.
 * The set is small (one row per customer domain), changes only when an operator verifies or removes
 * one, and is stale for at most `REFRESH_MS`.
 *
 * WHY STALENESS IS ACCEPTABLE IN BOTH DIRECTIONS. A newly verified domain waits up to a minute to
 * start working, which is nothing next to the DNS propagation it just went through — and
 * `refreshCustomDomainOrigins()` is called directly when a domain is verified, so in practice it is
 * immediate. A REMOVED domain keeps working for up to a minute; that domain still has to resolve to
 * this deployment to reach it at all, and `resolveCustomDomainSlug` (which reads the database, not
 * this cache) stops routing it immediately. CORS is not what authorises the request.
 *
 * FAILURE IS SILENT AND SAFE. If the control plane cannot be read, the previous snapshot is kept
 * rather than cleared: dropping every custom domain because one query timed out would sign every
 * such customer out of a working deployment.
 */
import { controlPrisma } from "./control-prisma.js";

/** One minute. Long enough that this is not a per-request query, short enough that nobody waits. */
const REFRESH_MS = 60_000;

let domains = new Set<string>();
let lastLoadedAt = 0;
let inFlight: Promise<void> | null = null;

/**
 * Reloads the set from the control plane.
 *
 * Single-flight: a burst of requests arriving after the cache expires triggers ONE query, not one
 * per request. Without that, the moment of expiry is exactly when traffic is highest.
 */
export async function refreshCustomDomainOrigins(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const rows = await controlPrisma.orgDomain.findMany({
        // Only verified rows, for the same reason `resolveCustomDomainSlug` says so: an unverified
        // row is a claim, not a fact, and honouring one would let anybody nominate a hostname.
        where: { verifiedAt: { not: null } },
        select: { domain: true }
      });
      domains = new Set(rows.map((row) => row.domain.toLowerCase()));
      lastLoadedAt = Date.now();
    } catch (error) {
      // Keep the previous snapshot — see the header. A warning, because a control plane that cannot
      // be read is worth knowing about even when nothing broke yet.
      console.warn(`[custom-domains] could not refresh the origin cache: ${(error as Error).message}`);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * Is this hostname a verified custom domain?
 *
 * Synchronous on purpose, so the CORS middleware stays synchronous: it answers from the last
 * snapshot and kicks off a refresh in the background when that snapshot is stale. The request being
 * answered right now uses the old set, which is the whole point of a cache.
 */
export function isVerifiedCustomDomain(hostname: string): boolean {
  if (Date.now() - lastLoadedAt > REFRESH_MS) void refreshCustomDomainOrigins();
  return domains.has(hostname.toLowerCase());
}

/** Test seam — lets a spec state the cache's contents without a database. */
export function __setCustomDomainsForTests(next: string[], loadedAt = Date.now()): void {
  domains = new Set(next.map((d) => d.toLowerCase()));
  lastLoadedAt = loadedAt;
}
