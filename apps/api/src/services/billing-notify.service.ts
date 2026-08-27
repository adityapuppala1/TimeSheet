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

/** Tells a workspace's super admins that a renewal failed. Never throws: a webhook that 500s
 *  because an email bounced is a webhook Stripe retries forever over something already recorded. */
export async function notifyPaymentFailed(slug: string, name: string): Promise<void> {
  try {
    await withOrgTenant(slug, async () => {
      const admins = await prisma.user.findMany({
        where: { status: "ACTIVE", deletedAt: null, isAgent: false, role: { name: "SUPER_ADMIN" } },
        select: { email: true }
      });
      if (admins.length === 0) return;
      const billingUrl = `${env.APP_BASE_URL.replace(/\/$/, "")}/app/settings?tab=billing`;
      await dispatchTransactional({
        to: admins.map((a) => a.email).join(","),
        templateKey: "billing.payment_failed",
        vars: { workspace: name, billingUrl },
        fallback: { subject: "A payment for TimeSphere didn't go through", html: templates.paymentFailed(name, GRACE_DAYS, billingUrl) }
      });
    });
  } catch (error) {
    console.warn(`[billing] could not notify ${slug} of a failed payment: ${(error as Error).message}`);
  }
}
