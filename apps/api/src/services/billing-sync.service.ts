/**
 * Keeps the seat count Stripe bills in step with the seat count this workspace actually uses.
 *
 * WHY IT EXISTS. Checkout used to send `quantity: 1` while the pricing page sold "$8 per seat", so
 * a fifty-person workspace was billed for one. Fixing checkout fixed the moment of purchase; this
 * fixes every moment after it, which is where a growing customer spends most of their life.
 *
 * BEST-EFFORT AND NON-BLOCKING, ALWAYS. Creating a user must not fail because Stripe is slow, and
 * it must certainly not fail because this deployment has no Stripe configured at all — which is the
 * common case, since self-hosted and manually-tiered workspaces never touch billing. Every path out
 * of here is a silent return.
 *
 * `proration_behavior: "none"` is deliberate: adding somebody mid-cycle should not produce a
 * surprise mid-cycle charge. The new headcount is what the NEXT invoice is for, which is what a
 * customer expects from a per-seat plan and what avoids a support ticket per hire.
 */
import { controlPrisma } from "../config/control-prisma.js";
import { getTenantClient } from "../config/prisma.js";
import { tenantContext } from "../config/tenant-context.js";
import { decryptSecret } from "../utils/encryption.js";
import { countActiveSeats } from "./seat-count.service.js";
import { resolveStripeClient } from "./stripe-client.service.js";

/** The sync itself, THROWING — for the nightly sweep, which names what failed. Must run inside the
 *  workspace's tenant context (`countActiveSeats` reads its database). True when it wrote. */
async function bringQuantityToSeatCount(orgId: string): Promise<boolean> {
  const org = await controlPrisma.organization.findUnique({
    where: { id: orgId },
    select: { stripeSubscriptionId: true }
  });
  if (!org?.stripeSubscriptionId) return false; // Never bought through Stripe — nothing to keep in step.

  const context = await resolveStripeClient();
  if (!context) return false; // Billing isn't configured on this deployment.

  const seats = Math.max(1, await countActiveSeats());
  const { stripe } = context;
  const subscription = await stripe.subscriptions.retrieve(org.stripeSubscriptionId);
  const item = subscription.items.data[0];
  if (!item || item.quantity === seats) return false; // Already right — do not spend a write saying so.

  await stripe.subscriptions.update(org.stripeSubscriptionId, {
    items: [{ id: item.id, quantity: seats }],
    proration_behavior: "none"
  });
  return true;
}

export async function syncSubscriptionSeats(orgId: string): Promise<void> {
  try {
    await bringQuantityToSeatCount(orgId);
  } catch (error) {
    console.warn(`[billing] seat sync failed for ${orgId}: ${(error as Error).message}`);
  }
}

export interface SeatReconcileResult {
  /** False on a deployment with no Stripe key — the common case, and not an error. */
  configured: boolean;
  /** Subscribed workspaces with a database, i.e. the ones actually asked. */
  attempted: number;
  /** How many had drifted and were corrected. */
  updated: number;
  failed: Array<{ slug: string; message: string }>;
}

/**
 * THE NIGHTLY BACKSTOP. The sync above runs after each user-lifecycle change, but "each change" is a
 * list somebody has to keep complete — it was three paths long until 2026-10, and first sign-in
 * through SSO still adds people without calling it. Once a night, every subscribed workspace's
 * quantity is brought to its real active-seat count, so drift lasts a day at most whichever path
 * caused it. Scheduled by workers/billed-revenue-reconcile.worker.ts, BEFORE the revenue read, so the
 * figure that sweep records is the corrected one.
 *
 * SAFE TO RUN TWICE (two API replicas each run their cron): it writes only when the quantity differs,
 * so the second pass finds nothing to do; `proration_behavior: "none"` means a correction never
 * produces a mid-cycle charge.
 *
 * ACTIVE and GRACE only: a GRACE workspace is still subscribed (a renewal failed), and its next
 * invoice should bill its real headcount; a SUSPENDED or deleting one is not being billed forward.
 * One unreachable workspace is named and skipped, never allowed to cost the others their sync.
 */
export async function reconcileSubscriptionSeats(): Promise<SeatReconcileResult> {
  if (!(await resolveStripeClient())) return { configured: false, attempted: 0, updated: 0, failed: [] };

  const orgs = await controlPrisma.organization.findMany({
    where: { stripeSubscriptionId: { not: null }, status: { in: ["ACTIVE", "GRACE"] } },
    select: { id: true, slug: true, database: { select: { encryptedDsn: true } } }
  });

  let attempted = 0;
  let updated = 0;
  const failed: SeatReconcileResult["failed"] = [];
  for (const org of orgs) {
    // A subscription with no database yet is a provisioning still in flight, not a failure.
    if (!org.database) continue;
    attempted += 1;
    try {
      const client = await getTenantClient(org.id, decryptSecret(org.database.encryptedDsn));
      const wrote = await tenantContext.run({ orgId: org.id, orgSlug: org.slug, client }, () => bringQuantityToSeatCount(org.id));
      if (wrote) updated += 1;
    } catch (error) {
      failed.push({ slug: org.slug, message: (error as Error).message || "unreachable" });
    }
  }
  return { configured: true, attempted, updated, failed };
}
