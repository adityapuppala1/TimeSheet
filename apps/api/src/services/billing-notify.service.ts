/**
 * Billing mail that has to be sent from OUTSIDE a tenant context.
 *
 * The Stripe webhook is control-plane-only by design — it never resolves a tenant, because billing
 * is a platform concern and the route has no Host header naming a workspace. But the mail it needs
 * to send has to go through that workspace's own SMTP settings and land in its own EmailLog, both
 * of which live in the tenant database. This is the bridge, kept in one place so the webhook itself
 * stays free of tenant plumbing.
 */
import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { withOrgTenant } from "../config/with-org-tenant.js";
import { templates } from "./mail-templates.js";
import { dispatchTransactional } from "./notify.service.js";

const GRACE_DAYS = 14;

/** The one place a stored PlanTier becomes something a human reads. `ENTERPRISE` in a sentence
 *  looks like a database leak, which is roughly what it is. */
const TIER_LABEL: Record<string, string> = { STARTER: "Starter", TEAM: "Team", ENTERPRISE: "Enterprise" };

/** Every send here goes to the same audience for the same reason: these are workspace-wide billing
 *  facts, and the only people who can act on them are the admins who can reach the Billing tab. */
async function superAdminRecipients(): Promise<string> {
  const admins = await prisma.user.findMany({
    where: { status: "ACTIVE", deletedAt: null, isAgent: false, role: { name: "SUPER_ADMIN" } },
    select: { email: true }
  });
  return admins.map((a) => a.email).join(",");
}

const billingUrl = () => `${env.APP_BASE_URL.replace(/\/$/, "")}/app/settings?tab=billing`;

/** Tells a workspace's super admins that a renewal failed. Never throws: a webhook that 500s
 *  because an email bounced is a webhook Stripe retries forever over something already recorded. */
export async function notifyPaymentFailed(slug: string, name: string): Promise<void> {
  try {
    await withOrgTenant(slug, async () => {
      const to = await superAdminRecipients();
      if (!to) return;
      const url = billingUrl();
      await dispatchTransactional({
        to,
        templateKey: "billing.payment_failed",
        vars: { workspace: name, billingUrl: url },
        fallback: { subject: "A payment for TimeSphere didn't go through", html: templates.paymentFailed(name, GRACE_DAYS, url) }
      });
    });
  } catch (error) {
    console.warn(`[billing] could not notify ${slug} of a failed payment: ${(error as Error).message}`);
  }
}

/**
 * Confirms a plan change to a workspace's super admins — the receipt for a purchase.
 *
 * WHY IT EXISTS. Both ways of changing plan end somewhere that is not this product: a hosted
 * Checkout page, or a click that silently updates a subscription and returns nothing. Either way
 * the only proof the customer had that anything happened was a badge on a settings tab they had to
 * go and look at. Money moved and nothing arrived in an inbox, which is how a legitimate charge
 * ends up as a chargeback.
 *
 * WHO DECIDES WHEN: the webhook, not this function. It is called only where a tier genuinely
 * changed — never on the quantity-only `customer.subscription.updated` a seat sync produces, or
 * this becomes an email per hire.
 *
 * Never throws, for the same reason `notifyPaymentFailed` doesn't: the caller is a Stripe webhook,
 * and a 500 over a bounced email is retried forever against work that is already recorded.
 */
export async function notifyPlanChanged(slug: string, name: string, tier: string): Promise<void> {
  try {
    await withOrgTenant(slug, async () => {
      const to = await superAdminRecipients();
      if (!to) return;
      const url = billingUrl();
      const plan = TIER_LABEL[tier] ?? tier;
      await dispatchTransactional({
        to,
        templateKey: "billing.plan_changed",
        vars: { workspace: name, plan, billingUrl: url },
        fallback: { subject: `Your TimeSphere plan is now ${plan}`, html: templates.planChanged(name, plan, url) }
      });
    });
  } catch (error) {
    console.warn(`[billing] could not notify ${slug} of a plan change: ${(error as Error).message}`);
  }
}
