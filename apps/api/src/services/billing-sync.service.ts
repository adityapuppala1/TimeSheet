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
import Stripe from "stripe";
import { controlPrisma } from "../config/control-prisma.js";
import { countActiveSeats } from "./seat-count.service.js";
import { decryptSecret } from "../utils/encryption.js";

export async function syncSubscriptionSeats(orgId: string): Promise<void> {
  try {
    const org = await controlPrisma.organization.findUnique({
      where: { id: orgId },
      select: { stripeSubscriptionId: true }
    });
    if (!org?.stripeSubscriptionId) return; // Never bought through Stripe — nothing to keep in step.

    const settings = await controlPrisma.platformBillingSettings.findUnique({ where: { id: "global" } });
    if (!settings?.encryptedSecretKey) return; // Billing isn't configured on this deployment.

    const seats = Math.max(1, await countActiveSeats());
    const stripe = new Stripe(decryptSecret(settings.encryptedSecretKey));
    const subscription = await stripe.subscriptions.retrieve(org.stripeSubscriptionId);
    const item = subscription.items.data[0];
    if (!item || item.quantity === seats) return; // Already right — do not spend a write saying so.

    await stripe.subscriptions.update(org.stripeSubscriptionId, {
      items: [{ id: item.id, quantity: seats }],
      proration_behavior: "none"
    });
  } catch (error) {
    console.warn(`[billing] seat sync failed for ${orgId}: ${(error as Error).message}`);
  }
}
