/**
 * The current lifecycle status of a workspace, cached, for the request hot path.
 *
 * WHY IT IS CACHED. `middleware/auth.ts` reads this on EVERY authenticated request, and it lives in
 * the control plane — a different database from the one the request is already talking to. An
 * uncached read would add a cross-database round trip to every API call in the product to answer a
 * question whose answer changes a few times in a workspace's entire life.
 *
 * WHY THE TTL IS SHORT ANYWAY. The staleness window is the delay between a customer paying and
 * their workspace unlocking. Ten seconds is imperceptible to them and is the same figure
 * `maintenance.service.ts` uses for the check sitting immediately above this one — no reason for
 * two hot-path caches on the same path to disagree about what "fresh enough" means.
 *
 * WHY A SUCCESSFUL PAYMENT CLEARS IT EXPLICITLY. Waiting out a TTL after handing over a credit card
 * is exactly the moment a customer decides the product is broken, so the Stripe webhook calls
 * `forgetOrgStatus` rather than trusting the clock.
 */
import { controlPrisma } from "../config/control-prisma.js";

export type OrgLifecycleStatus = "PROVISIONING" | "ACTIVE" | "GRACE" | "SUSPENDED" | "ARCHIVED";

const CACHE_TTL_MS = 10_000;
const cache = new Map<string, { status: OrgLifecycleStatus; fetchedAt: number }>();

export async function getOrgStatus(orgId: string): Promise<OrgLifecycleStatus> {
  const cached = cache.get(orgId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.status;

  let status: OrgLifecycleStatus;
  try {
    const org = await controlPrisma.organization.findUnique({ where: { id: orgId }, select: { status: true } });
    status = (org?.status as OrgLifecycleStatus) ?? "ACTIVE";
  } catch {
    // FAILS OPEN, and this is the important line in the file. A control-plane blip must degrade to
    // "the app works", never to "every customer is locked out for non-payment" — the same call
    // `isMaintenanceActive` makes one check earlier, for the same reason. The blast radius of
    // being wrong in the other direction is every request on the deployment.
    status = "ACTIVE";
  }

  cache.set(orgId, { status, fetchedAt: Date.now() });
  return status;
}

/** Drops the cached answer for one workspace — called the moment a payment lands, so an unlocked
 *  workspace is unlocked now rather than within ten seconds. */
export function forgetOrgStatus(orgId: string): void {
  cache.delete(orgId);
}

/** Test-only, so one spec's cached status cannot decide another spec's outcome. */
export function __resetOrgStatusCacheForTests(): void {
  cache.clear();
}
