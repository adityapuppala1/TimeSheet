/**
 * Self-serve Stripe billing — turns the previous "a platform admin manually assigns a
 * PlanTier" flow (still available, unchanged, in platform-admin.controller.ts) into a real
 * upgrade funnel an org's own SUPER_ADMIN can drive from Workspace Settings. Two independent
 * pieces:
 *  - `billingRouter` (mounted normally, after tenant resolution): GET /status, POST
 *    /checkout-session (which either opens Stripe Checkout or changes the EXISTING subscription
 *    in place — see the route), POST /portal-session (Stripe's hosted Customer Portal, which is
 *    where card updates, invoice history and self-serve cancellation come from without this
 *    product building any of them) and GET /invoices.
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
import { notifyPaymentFailed, notifyPlanChanged } from "../services/billing-notify.service.js";
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
    controlPrisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { planTier: true, stripeCustomerId: true, stripeSubscriptionId: true } }),
    getEffectiveSeatLimit(orgId),
    countActiveSeats(),
    controlPrisma.platformBillingSettings.findUnique({ where: { id: "global" }, select: { priceIdTeam: true, priceIdEnterprise: true } })
  ]);
  res.json({
    planTier: org.planTier,
    hasStripeCustomer: Boolean(org.stripeCustomerId),
    // Not a duplicate of `hasStripeCustomer`: a customer record exists from the moment somebody
    // opens Checkout, whether or not they ever paid. This is what tells the frontend which of the
    // two plan-change paths a click will take — and therefore whether the button should promise a
    // Stripe page or say the plan changes on the spot.
    hasSubscription: Boolean(org.stripeSubscriptionId),
    seatLimit,
    activeSeats,
    checkoutAvailable: { TEAM: Boolean(settings?.priceIdTeam), ENTERPRISE: Boolean(settings?.priceIdEnterprise) }
  });
});

const checkoutSchema = z.object({ body: z.object({ tier: z.enum(["TEAM", "ENTERPRISE"]) }) });

/** Where the browser comes back to after any hosted Stripe page. Same origin the request arrived
 *  on, so a LAN IP, a custom domain and localhost all return to themselves rather than to whatever
 *  APP_BASE_URL happens to say. */
function originOf(req: express.Request): string {
  return req.headers.origin || `${req.protocol}://${req.get("host")}`;
}

/**
 * "Stripe has never heard of this id."
 *
 * A stored `stripeSubscriptionId` can outlive the subscription it names — a refund-and-cancel done
 * by hand in the Stripe dashboard, a test-mode key swapped for a live one, a restored database
 * snapshot. Narrow on purpose: only a genuine missing-resource answer counts. A network blip or a
 * rate limit must NOT be read as "it's gone", because the repair for a missing subscription is to
 * create a second one, and doing that to a customer whose subscription is merely unreachable for a
 * second is the exact bug this whole route exists to stop.
 */
function isMissingResource(error: unknown): boolean {
  const stripeError = error as { statusCode?: number; code?: string } | null;
  return stripeError?.statusCode === 404 || stripeError?.code === "resource_missing";
}

/** Statuses a subscription never comes back from. Anything else — `past_due`, `unpaid`, `paused`,
 *  a card in `incomplete` — is a live subscription with a problem, and changing the plan on it is
 *  still the right move; opening a second Checkout for it would just bill the customer twice. */
const DEAD_SUBSCRIPTION_STATUSES = new Set<Stripe.Subscription.Status>(["canceled", "incomplete_expired"]);

/**
 * Moves an EXISTING subscription onto `priceId`, or reports that there is nothing to move.
 *
 * Returns false — rather than throwing — for every "the stored id is no good" case, because the
 * caller's answer to that is not an error page: it is to fall back to Checkout and clear the stale
 * column. A stored id Stripe no longer honours must never dead-end a customer who is trying to
 * give us more money.
 */
async function changeSubscriptionInPlace(stripe: Stripe, subscriptionId: string, priceId: string, seats: number): Promise<boolean> {
  let subscription: Stripe.Subscription;
  try {
    subscription = await stripe.subscriptions.retrieve(subscriptionId);
  } catch (error) {
    if (isMissingResource(error)) return false;
    throw error;
  }
  if (DEAD_SUBSCRIPTION_STATUSES.has(subscription.status)) return false;

  const item = subscription.items.data[0];
  if (!item) return false; // A subscription with no items is not one we can move to a new price.

  await stripe.subscriptions.update(subscriptionId, {
    // The item is UPDATED, never added: passing `{ id, price }` swaps the price on the line the
    // customer already has. Omitting the id would append a second line and bill for both plans.
    items: [{ id: item.id, price: priceId, quantity: seats }],
    // Mid-cycle plan changes are prorated. A customer moving from Team to Enterprise on day 10 is
    // credited the unused Team time and charged the difference — `none` here would silently give
    // away three weeks of the more expensive plan, and `always_invoice` would charge instantly for
    // something they expect on their next invoice.
    proration_behavior: "create_prorations"
  });
  return true;
}

/**
 * POST /checkout-session — a SUPER_ADMIN changes plan. Two paths, and which one runs depends
 * entirely on whether this org already has a live subscription:
 *
 *  - NO SUBSCRIPTION: creates (or reuses) this org's Stripe Customer and returns a hosted Checkout
 *    URL for the frontend to redirect to — `{ mode: "checkout", url }`.
 *  - ALREADY SUBSCRIBED: changes that subscription in place and returns `{ mode: "updated" }`,
 *    with no redirect at all. There is nothing to collect: the card is already on file.
 *
 * WHY THE SECOND PATH EXISTS. This route used to open Checkout unconditionally, and the webhook
 * below then OVERWROTE `stripeSubscriptionId` with whatever the new session created. So a paying
 * TEAM customer who pressed "Upgrade to Enterprise" — a button that renders for every tier below
 * Enterprise — ended up with TWO active subscriptions on one Stripe customer, was billed for both,
 * and the one the database had stopped pointing at kept renewing forever with nothing in this
 * product referencing it. Nothing detected that; the customer's card statement did.
 *
 * WHAT DOES NOT CHANGE: the tier is written by the WEBHOOK, never here. An in-place
 * `subscriptions.update` fires `customer.subscription.updated`, which the webhook already maps
 * back to a PlanTier — so both paths still converge on exactly one writer for `planTier`, and a
 * browser tab closed mid-flow can never leave it out of sync with what Stripe actually charged.
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
  // This bills the seat count AT THE MOMENT OF THE PLAN CHANGE — both paths, which is why the
  // in-place update carries a quantity too rather than only a price: a workspace that grew since
  // it subscribed would otherwise move to the new plan still billed for its old headcount.
  // Keeping it in step from there on is the subscription-quantity sync in billing-sync.service.ts,
  // called from the user lifecycle and reconciled nightly — not here.
  const seats = Math.max(1, await countActiveSeats());

  if (org.stripeSubscriptionId) {
    if (await changeSubscriptionInPlace(stripe, org.stripeSubscriptionId, priceId, seats)) {
      res.json({ mode: "updated" });
      return;
    }
    // The stored id is stale. Clear it before falling through, so the webhook that lands after the
    // Checkout below writes into a clean column instead of appearing to overwrite a live
    // subscription — and so a retry of this same request doesn't pay the retrieve() round-trip again.
    await controlPrisma.organization.update({ where: { id: org.id }, data: { stripeSubscriptionId: null } });
  }

  const appOrigin = originOf(req);
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: priceId, quantity: seats }],
    success_url: `${appOrigin}/app/settings?billing=success`,
    cancel_url: `${appOrigin}/app/settings?billing=cancelled`,
    metadata: { organizationId: org.id, tier: req.body.tier, seatsAtCheckout: String(seats) }
  });

  if (!session.url) throw new AppError(502, "Stripe did not return a checkout URL.");
  res.json({ mode: "checkout", url: session.url });
});

/**
 * POST /portal-session — hands the customer to Stripe's hosted Customer Portal.
 *
 * This one route is what gives a paying workspace card updates, its own invoice history, tax-id
 * and billing-address edits and self-serve cancellation, none of which exist in this product and
 * none of which should: they are Stripe's problem, they are PCI-scoped, and every one of them is a
 * support ticket for as long as there is no button.
 *
 * 409 rather than 404 when there is no customer yet: the route exists and the caller is allowed to
 * use it, the WORKSPACE is simply in a state that has no portal — nobody has ever paid. A 404 here
 * reads as "this deployment doesn't have billing", which is a different and misleading answer.
 */
billingRouter.post("/portal-session", requireSuperAdmin, async (req, res) => {
  const { orgId } = requireTenantContext();
  const org = await controlPrisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { stripeCustomerId: true } });
  if (!org.stripeCustomerId) {
    throw new AppError(409, "This workspace has no billing account with Stripe yet. Choose a plan first — the billing portal opens once there's a subscription to manage.");
  }

  const { stripe } = await getStripeClient();
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: org.stripeCustomerId,
      // Back to the same settings page the button was pressed on. No `?billing=` marker: nothing
      // was necessarily bought, and a success toast for "looked at an invoice" is a lie.
      return_url: `${originOf(req)}/app/settings`
    });
    if (!session.url) throw new AppError(502, "Stripe did not return a portal URL.");
    res.json({ url: session.url });
  } catch (error) {
    // The portal has to be turned on ONCE per Stripe account, in the dashboard, and until it is
    // Stripe answers every create() with an invalid_request naming that configuration. Passing that
    // through raw sends a workspace admin hunting for a bug in this product over a setting only the
    // platform operator can flip — so it is translated into the sentence that names the real fix.
    if ((error as { code?: string })?.code === "invalid_request_error" || /configuration/i.test((error as Error)?.message ?? "")) {
      throw new AppError(503, "Stripe's customer portal hasn't been configured on this deployment's Stripe account yet.");
    }
    throw error;
  }
});

/** One invoice, reduced to what a billing page actually shows. Amounts stay in MINOR UNITS (paise,
 *  cents) exactly as Stripe reports them — dividing by 100 here would be wrong for the zero-decimal
 *  currencies (JPY, KRW) and hides the rounding decision from the one place that knows the
 *  currency. Formatting is the frontend's job; this is the data. */
interface InvoiceSummary {
  id: string;
  number: string | null;
  created: string;
  amountPaid: number;
  amountDue: number;
  currency: string;
  status: string | null;
  hostedInvoiceUrl: string | null;
  invoicePdf: string | null;
}

/**
 * GET /invoices — the 12 most recent invoices for this org's Stripe customer.
 *
 * TWELVE INVOICES, NOT TWELVE MONTHS. There is no date filter here, and the count is a page size
 * rather than a window: for a monthly subscription it happens to be about a year, for an annual one
 * it is a decade, and for anything with mid-cycle proration invoices it is less than a year. The
 * card renders a recent-history list, not an accounting record — the complete set lives in Stripe's
 * own hosted portal, which is what the "Manage billing" button beside the list opens.
 *
 * Deliberately a PROJECTION, not a passthrough. A raw `Stripe.Invoice` carries the customer's
 * billing address, tax ids, payment-method fingerprints, discounts and the full line-item history;
 * none of that belongs in a settings card, and shipping it would make every one of those fields an
 * accidental part of this product's API forever.
 *
 * An org with no Stripe customer gets `[]`, not an error: "you have never been billed" is a
 * perfectly ordinary state (every STARTER workspace, every manually-tiered one, every self-hosted
 * deployment) and it is answered here without touching Stripe at all.
 */
billingRouter.get("/invoices", requireSuperAdmin, async (_req, res) => {
  const { orgId } = requireTenantContext();
  const org = await controlPrisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { stripeCustomerId: true } });
  if (!org.stripeCustomerId) {
    res.json([]);
    return;
  }

  const { stripe } = await getStripeClient();
  const list = await stripe.invoices.list({ customer: org.stripeCustomerId, limit: 12 });
  const invoices: InvoiceSummary[] = list.data.map((invoice) => ({
    id: invoice.id ?? "",
    number: invoice.number ?? null,
    // Stripe counts seconds; everything on this side of the wire is an ISO string.
    created: new Date(invoice.created * 1000).toISOString(),
    amountPaid: invoice.amount_paid,
    amountDue: invoice.amount_due,
    currency: invoice.currency,
    status: invoice.status ?? null,
    hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    invoicePdf: invoice.invoice_pdf ?? null
  }));
  res.json(invoices);
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
        const updated = await controlPrisma.organization.update({
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
        // THE RECEIPT. `update` returns the row it just wrote, so the slug and name this needs cost
        // no second query. Awaited rather than fired-and-forgotten so an unhandled rejection can't
        // outlive the response — and it never throws (see billing-notify.service.ts), because a
        // webhook that 500s over an email is a webhook Stripe retries forever.
        if (updated?.slug) await notifyPlanChanged(updated.slug, updated.name, tier);
      }
    } else if (event.type === "customer.subscription.updated") {
      const subscription = event.data.object as Stripe.Subscription;
      const priceId = subscription.items.data[0]?.price?.id;
      const tier = tierForPriceId(settings, priceId);
      const org = await controlPrisma.organization.findUnique({ where: { stripeSubscriptionId: subscription.id } });
      if (org && tier && subscription.status === "active") {
        // THE TIER MUST ACTUALLY HAVE CHANGED before anyone is emailed. This event does not only
        // fire for plan changes: every seat sync in billing-sync.service.ts updates the quantity on
        // this same subscription and fires it too, and so does a card update, a renewal and a
        // cancel-at-period-end toggle. Emailing on all of them turns "your plan changed" into noise
        // a growing customer receives every time somebody joins, which is exactly the mail people
        // filter — including the one send that mattered.
        const tierChanged = org.planTier !== tier;
        await controlPrisma.organization.update({ where: { id: org.id }, data: { planTier: tier } });
        if (tierChanged && org.slug) await notifyPlanChanged(org.slug, org.name, tier);
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
