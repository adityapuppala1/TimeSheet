/**
 * Self-serve Stripe billing — turns the previous "a platform admin manually assigns a
 * PlanTier" flow (still available, unchanged, in platform-admin.controller.ts) into a real
 * upgrade funnel an org's own SUPER_ADMIN can drive from Workspace Settings. Two independent
 * pieces:
 *  - `billingRouter` (mounted normally, after tenant resolution): POST /checkout-session starts
 *    a Stripe Checkout session for the calling org.
 *  - `billingWebhookRouter` (mounted BEFORE the global express.json() in app.ts, same reasoning
 *    as git-webhook.controller.ts — Stripe's signature is computed over the exact raw bytes it
 *    sent): POST /webhook receives Stripe's async confirmation and updates Organization.planTier.
 * Both are control-plane-only — billing is a platform-wide concern (Organization.planTier,
 * PlatformBillingSettings), never touches a tenant database, so neither route needs
 * withOrgTenant/tenantContext at all.
 */
import express, { Router } from "express";
import Stripe from "stripe";
import { z } from "zod";
import { controlPrisma } from "../config/control-prisma.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { requireAuth, requireSuperAdmin } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import { validate } from "../middleware/validate.js";
import { getEffectiveSeatLimit } from "../services/plan-limits.service.js";
import { countActiveSeats } from "../services/seat-count.service.js";
import { forgetOrgStatus } from "../services/org-status.service.js";
import { notifyPaymentFailed } from "../services/billing-notify.service.js";
import { decryptSecret } from "../utils/encryption.js";

async function getStripeClient(): Promise<{ stripe: Stripe; settings: NonNullable<Awaited<ReturnType<typeof controlPrisma.platformBillingSettings.findUnique>>> }> {
  const settings = await controlPrisma.platformBillingSettings.findUnique({ where: { id: "global" } });
  if (!settings?.encryptedSecretKey) throw new AppError(503, "Billing isn't configured on this deployment yet.");
  const stripe = new Stripe(decryptSecret(settings.encryptedSecretKey));
  return { stripe, settings };
}

export const billingRouter = Router();
billingRouter.use(requireAuth);

/**
 * GET /status — the org's current plan tier + seat usage, for the Workspace Settings Billing
 * card. Doesn't require `getStripeClient()` — an org that's never touched Stripe (manually
 * assigned a tier, or still on STARTER) still needs to see its own status.
 */
billingRouter.get("/status", async (req, res) => {
  const { orgId } = requireTenantContext();
  const [org, seatLimit, activeSeats, settings] = await Promise.all([
    controlPrisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { planTier: true, stripeCustomerId: true } }),
    getEffectiveSeatLimit(orgId),
    countActiveSeats(),
    controlPrisma.platformBillingSettings.findUnique({ where: { id: "global" }, select: { priceIdTeam: true, priceIdEnterprise: true } })
  ]);
  res.json({
    planTier: org.planTier,
    hasStripeCustomer: Boolean(org.stripeCustomerId),
    seatLimit,
    activeSeats,
    checkoutAvailable: { TEAM: Boolean(settings?.priceIdTeam), ENTERPRISE: Boolean(settings?.priceIdEnterprise) }
  });
});

const checkoutSchema = z.object({ body: z.object({ tier: z.enum(["TEAM", "ENTERPRISE"]) }) });

/**
 * POST /checkout-session — a SUPER_ADMIN starts an upgrade. Creates (or reuses) this org's
 * Stripe Customer, then a Checkout Session for the requested tier's Price, and returns the
 * hosted checkout URL for the frontend to redirect to. The actual tier change happens later,
 * asynchronously, when Stripe calls the webhook below after payment succeeds — never directly
 * from this route, so a browser tab closed mid-checkout can never leave planTier out of sync
 * with what Stripe actually charged.
 */
billingRouter.post("/checkout-session", requireSuperAdmin, validate(checkoutSchema), async (req, res) => {
  const { orgId } = requireTenantContext();
  const { stripe, settings } = await getStripeClient();

  const priceId = req.body.tier === "TEAM" ? settings.priceIdTeam : settings.priceIdEnterprise;
  if (!priceId) throw new AppError(503, `No Stripe Price configured for the ${req.body.tier} tier yet.`);

  const org = await controlPrisma.organization.findUniqueOrThrow({ where: { id: orgId } });

  let customerId = org.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({ name: org.name, metadata: { organizationId: org.id, orgSlug: org.slug } });
    customerId = customer.id;
    await controlPrisma.organization.update({ where: { id: org.id }, data: { stripeCustomerId: customerId } });
  }

  // QUANTITY IS THE SEAT COUNT, not 1. It was 1, and the pricing page sells "$8 per seat / month"
  // — so a fifty-person workspace that upgraded through this route was billed for a single seat.
  // The same `countActiveSeats()` the seat LIMIT is checked against is what gets billed, so the
  // number a customer is charged for and the number they are allowed can never disagree.
  //
  // This bills the seat count AT CHECKOUT. Keeping it in step as the workspace grows is the
  // subscription-quantity sync in billing-sync.service.ts, called from the user lifecycle and
  // reconciled nightly — an org that adds people mid-cycle is corrected there, not here.
  const seats = Math.max(1, await countActiveSeats());

  const appOrigin = req.headers.origin || `${req.protocol}://${req.get("host")}`;
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: priceId, quantity: seats }],
    success_url: `${appOrigin}/app/settings?billing=success`,
    cancel_url: `${appOrigin}/app/settings?billing=cancelled`,
    metadata: { organizationId: org.id, tier: req.body.tier, seatsAtCheckout: String(seats) }
  });

  if (!session.url) throw new AppError(502, "Stripe did not return a checkout URL.");
  res.json({ url: session.url });
});

/**
 * The subscription an invoice belongs to.
 *
 * Reads BOTH shapes on purpose. Stripe moved this from a top-level `invoice.subscription` to
 * `invoice.parent.subscription_details.subscription`, and which one arrives depends on the API
 * version pinned to the ACCOUNT — not on the SDK version compiled here. An account still on an
 * older version sends the old shape to this same webhook, and reading only the new one would
 * silently ignore every dunning event from exactly the deployments most likely to have one.
 *
 * The cast is deliberate and narrow: the old field no longer exists on the SDK's type, so there is
 * no way to check for it without one.
 */
function subscriptionIdFromInvoice(invoice: Stripe.Invoice): string | null {
  const legacy = (invoice as unknown as { subscription?: unknown }).subscription;
  if (typeof legacy === "string") return legacy;
  if (legacy && typeof legacy === "object" && "id" in legacy && typeof (legacy as { id: unknown }).id === "string") {
    return (legacy as { id: string }).id;
  }
  const current = invoice.parent?.subscription_details?.subscription;
  if (typeof current === "string") return current;
  if (current && typeof current === "object" && typeof current.id === "string") return current.id;
  return null;
}

export const billingWebhookRouter = Router();

/** Maps a Stripe Price ID back to a PlanTier via PlatformBillingSettings' own mapping — the
 *  inverse of the lookup checkout-session above does when building the session. */
function tierForPriceId(settings: { priceIdTeam: string | null; priceIdEnterprise: string | null }, priceId: string | undefined): "TEAM" | "ENTERPRISE" | null {
  if (!priceId) return null;
  if (priceId === settings.priceIdTeam) return "TEAM";
  if (priceId === settings.priceIdEnterprise) return "ENTERPRISE";
  return null;
}

billingWebhookRouter.post("/webhook", express.raw({ type: "application/json" }), async (req, res, next) => {
  try {
    const settings = await controlPrisma.platformBillingSettings.findUnique({ where: { id: "global" } });
    if (!settings?.encryptedSecretKey || !settings.encryptedWebhookSigningSecret) {
      throw new AppError(404, "Billing isn't configured on this deployment yet.");
    }
    const stripe = new Stripe(decryptSecret(settings.encryptedSecretKey));
    const signature = req.headers["stripe-signature"];
    if (!signature || Array.isArray(signature)) throw new AppError(401, "Missing Stripe signature.");

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(req.body as Buffer, signature, decryptSecret(settings.encryptedWebhookSigningSecret));
    } catch {
      throw new AppError(401, "Invalid Stripe webhook signature.");
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const organizationId = session.metadata?.organizationId;
      const tier = session.metadata?.tier as "TEAM" | "ENTERPRISE" | undefined;
      if (organizationId && tier && typeof session.subscription === "string") {
        await controlPrisma.organization.update({
          where: { id: organizationId },
          data: {
            planTier: tier,
            stripeSubscriptionId: session.subscription,
            // Paying ENDS the trial and any grace state, whichever the workspace was in. Without
            // this, a customer who buys on day 12 of a 15-day trial is moved to GRACE on day 15 by
            // the lifecycle worker — locked out for non-payment three days after paying.
            status: "ACTIVE",
            graceStartedAt: null,
            suspendedReason: null,
            trialEndsAt: null,
            trialTier: null
          }
        });
        forgetOrgStatus(organizationId);
      }
    } else if (event.type === "customer.subscription.updated") {
      const subscription = event.data.object as Stripe.Subscription;
      const priceId = subscription.items.data[0]?.price?.id;
      const tier = tierForPriceId(settings, priceId);
      const org = await controlPrisma.organization.findUnique({ where: { stripeSubscriptionId: subscription.id } });
      if (org && tier && subscription.status === "active") {
        await controlPrisma.organization.update({ where: { id: org.id }, data: { planTier: tier } });
      }
    } else if (event.type === "invoice.payment_failed") {
      /*
       * DUNNING. This event was previously unhandled, and the consequence was not "nothing" — it
       * was that a failed renewal did nothing at all until Stripe eventually gave up and cancelled,
       * at which point the org silently dropped to STARTER and lost Gantt, goals, change management
       * and AI with no warning to anybody.
       *
       * A workspace that has already paid once and then had a card expire is not the same as one
       * that never paid, so it gets the same grace window a lapsed trial does rather than an
       * immediate downgrade — and an email that says which of the two happened.
       */
      const subscriptionId = subscriptionIdFromInvoice(event.data.object as Stripe.Invoice);
      const org = subscriptionId ? await controlPrisma.organization.findUnique({ where: { stripeSubscriptionId: subscriptionId } }) : null;
      if (org && org.status === "ACTIVE") {
        await controlPrisma.organization.update({
          where: { id: org.id },
          data: { status: "GRACE", graceStartedAt: new Date(), suspendedReason: "A renewal payment failed." }
        });
        forgetOrgStatus(org.id);
        await notifyPaymentFailed(org.slug, org.name);
      }
    } else if (event.type === "invoice.paid") {
      // The other half. Restoring on payment is what makes the grace state recoverable, and the
      // cache is cleared explicitly rather than waited out — ten seconds of "still locked" straight
      // after handing over a card is exactly when a customer decides the product is broken.
      const subscriptionId = subscriptionIdFromInvoice(event.data.object as Stripe.Invoice);
      const org = subscriptionId ? await controlPrisma.organization.findUnique({ where: { stripeSubscriptionId: subscriptionId } }) : null;
      if (org && org.status === "GRACE") {
        await controlPrisma.organization.update({
          where: { id: org.id },
          data: { status: "ACTIVE", graceStartedAt: null, suspendedReason: null }
        });
        forgetOrgStatus(org.id);
      }
    } else if (event.type === "customer.subscription.deleted") {
      const subscription = event.data.object as Stripe.Subscription;
      const org = await controlPrisma.organization.findUnique({ where: { stripeSubscriptionId: subscription.id } });
      if (org) {
        await controlPrisma.organization.update({ where: { id: org.id }, data: { planTier: "STARTER", stripeSubscriptionId: null } });
      }
    }

    res.json({ received: true });
  } catch (error) {
    next(error);
  }
});
