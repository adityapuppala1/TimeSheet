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

  const appOrigin = req.headers.origin || `${req.protocol}://${req.get("host")}`;
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${appOrigin}/app/settings?billing=success`,
    cancel_url: `${appOrigin}/app/settings?billing=cancelled`,
    metadata: { organizationId: org.id, tier: req.body.tier }
  });

  if (!session.url) throw new AppError(502, "Stripe did not return a checkout URL.");
  res.json({ url: session.url });
});

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
          data: { planTier: tier, stripeSubscriptionId: session.subscription }
        });
      }
    } else if (event.type === "customer.subscription.updated") {
      const subscription = event.data.object as Stripe.Subscription;
      const priceId = subscription.items.data[0]?.price?.id;
      const tier = tierForPriceId(settings, priceId);
      const org = await controlPrisma.organization.findUnique({ where: { stripeSubscriptionId: subscription.id } });
      if (org && tier && subscription.status === "active") {
        await controlPrisma.organization.update({ where: { id: org.id }, data: { planTier: tier } });
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
