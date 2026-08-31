/**
 * WHAT: the sweep that asks Stripe what each subscribed workspace is ACTUALLY billed, normalises it
 * to a monthly figure, and writes it down.
 *
 * WHY IT IS A JOB AND NOT A PAGE READ. Every revenue number in the platform console is LIST PRICE
 * — `PlanTierLimit.listPricePerSeatMinor` × billable seats — and it is labelled as such on every
 * screen that shows one. The number an operator actually wants next to it is the gap against what
 * customers pay, because that gap IS the discounting. Stripe is the only source for it, and asking
 * Stripe means one outbound HTTP call per subscribed workspace. Doing that on the revenue screen —
 * which an operator refreshes while talking to somebody — is a rate limit with a date on it. So the
 * answer is computed here, on a schedule, and written to `Organization.billed*`; the screen reads a
 * column. Exactly the trade `OrgUsageSnapshot` made, for exactly the same reason.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE ONE ARITHMETIC MISTAKE THIS FILE EXISTS TO PREVENT: COUNTING AN ANNUAL SUBSCRIPTION TWELVE
 * TIMES OVER. A Stripe price carries `recurring.interval` — a customer on `year` is charged the
 * whole year's money in one go, and storing that number as "MRR" reports them as worth twelve months
 * of revenue every month. It is the easiest way for this entire feature to be confidently, plausibly
 * wrong, and no amount of looking at the console would reveal it. `subscriptionMonthlyMinor` below
 * is pure and takes plain objects precisely so a fixture can prove the division, and so breaking it
 * turns a test red rather than a board slide.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * WHAT THIS NUMBER IS NOT. It is the subscription's RECURRING price — `unit_amount × quantity`, per
 * month. It is not an invoice total: it does not know about a percent-off coupon, a one-off credit,
 * tax, or a proration on this cycle. Those belong to an invoice, and an invoice is a different
 * question ("what did we collect in July?") from the one the revenue screen asks ("what are these
 * customers on the hook for each month?"). Stated here rather than implied, because the difference
 * is exactly the sort of thing somebody later assumes was handled.
 *
 * FAILURE IS PER WORKSPACE, AND IT IS NAMED. One unreachable org must not abort the sweep, and a
 * workspace whose reconciliation failed must never be folded into the total as zero — a Stripe
 * outage reported as a 100% discount is worse than no number at all. Every failure is written to
 * `billedReconcileError`, counted separately, and named on the screen. Modelled on
 * `org-usage-snapshot.worker.ts` / `captureOrgUsageSnapshots`, which learned the same lesson about
 * an unreachable tenant.
 */
import type Stripe from "stripe";
import { controlPrisma } from "../config/control-prisma.js";
import { DEAD_SUBSCRIPTION_STATUSES, resolveStripeClient } from "./stripe-client.service.js";

/* ------------------------------------------------------------------------------------------ */
/* Pure: an interval, and what a subscription is worth per month                                */
/* ------------------------------------------------------------------------------------------ */

/** The shape this file needs from a Stripe price. Structural rather than `Stripe.Price` so a test
 *  fixture is three fields instead of forty, and so the arithmetic can be exercised with no SDK. */
export interface RecurringShape {
  interval: string;
  /** How many `interval`s one billing period spans. Stripe defaults it to 1; a subscription billed
   *  every 3 months has `interval: "month", interval_count: 3`. */
  interval_count?: number | null;
}

export interface PriceShape {
  unit_amount?: number | null;
  currency?: string | null;
  recurring?: RecurringShape | null;
}

export interface ItemShape {
  quantity?: number | null;
  price?: PriceShape | null;
}

export interface SubscriptionShape {
  id?: string;
  status?: string;
  items?: { data?: ItemShape[] } | null;
}

/**
 * How many MONTHS one billing period of this price covers.
 *
 * The whole normalisation lives in this one number: an amount charged once per period, divided by
 * the months that period spans, is the monthly figure. Yearly → 12. Quarterly (`month` × 3) → 3.
 * Weekly and daily are converted through a 365-day year, which is an approximation and an
 * intentional one: Stripe bills on the real calendar, but a weekly plan's contribution to an MRR
 * figure does not need to know which months have 31 days, and pretending otherwise would add a
 * clock to a pure function for no readable gain.
 *
 * Returns `null` for an interval this build has never heard of. The caller treats that as
 * unpriceable and fails the workspace by name, rather than guessing "probably monthly" — a guess
 * here is silently wrong money.
 */
export function monthsInBillingPeriod(recurring: RecurringShape | null | undefined): number | null {
  if (!recurring) return null;
  const count = recurring.interval_count ?? 1;
  if (!Number.isFinite(count) || count <= 0) return null;
  switch (recurring.interval) {
    case "month":
      return count;
    case "year":
      return 12 * count;
    case "week":
      return (7 / 365) * 12 * count;
    case "day":
      return (1 / 365) * 12 * count;
    default:
      return null;
  }
}

export interface MonthlyAmount {
  /** Minor units per month, rounded ONCE across the whole subscription. */
  amountMinor: number;
  currency: string;
}

/**
 * A subscription's recurring value as a MONTHLY amount in minor units.
 *
 * THROWS rather than returning a partial answer, and that is the design. Every reason it can fail —
 * a tiered price with no `unit_amount`, a one-off line with no `recurring`, an interval this build
 * does not know, two currencies on one subscription — leaves us unable to say what this customer
 * pays per month. Returning "what we could work out" would put a number under a heading claiming to
 * be the whole of it, and the sweep would store it as fact. The caller catches, records the message
 * against the workspace, and the console names it as unreconciled.
 *
 * ROUNDED ONCE, AT THE END. Rounding each line and summing accumulates the error across a
 * subscription with several items; one rounding at the boundary is off by at most half a cent.
 */
export function subscriptionMonthlyMinor(subscription: SubscriptionShape): MonthlyAmount {
  const items = subscription.items?.data ?? [];
  if (items.length === 0) throw new Error("The subscription has no line items, so there is nothing to price.");

  let exact = 0;
  let currency: string | null = null;

  for (const item of items) {
    const price = item.price;
    if (!price || price.unit_amount === null || price.unit_amount === undefined) {
      // Tiered and usage-based prices carry no `unit_amount`; what they bill depends on metered
      // usage nobody here has. An unpriceable line makes the whole subscription unpriceable.
      throw new Error("A line has no fixed unit amount (a tiered or metered price), so its monthly value cannot be read from the subscription.");
    }
    const months = monthsInBillingPeriod(price.recurring);
    if (months === null) {
      throw new Error(`A line has an unsupported billing interval (${price.recurring?.interval ?? "none"}), so it cannot be normalised to a monthly figure.`);
    }
    const lineCurrency = (price.currency ?? "").toUpperCase();
    if (currency === null) currency = lineCurrency;
    else if (currency !== lineCurrency) {
      // Two currencies on one subscription cannot be added. Stripe does not allow it today, and if
      // that ever changes a thrown error is the honest answer rather than a meaningless sum.
      throw new Error("The subscription mixes currencies, so its lines cannot be added into one monthly figure.");
    }

    // `quantity` is the seat count. Null on a licensed price means one; treating it as zero would
    // report a paying customer as free.
    const quantity = item.quantity ?? 1;
    exact += (price.unit_amount * quantity) / months;
  }

  return { amountMinor: Math.round(exact), currency: currency || "USD" };
}

/* ------------------------------------------------------------------------------------------ */
/* The sweep                                                                                    */
/* ------------------------------------------------------------------------------------------ */

export interface ReconcileFailure {
  orgId: string;
  slug: string;
  message: string;
}

export interface ReconcileResult {
  /** False when this deployment has no Stripe secret key — the common case, and not an error. The
   *  caller reports "nothing to do", never "0 reconciled", because those read differently. */
  configured: boolean;
  attempted: number;
  reconciled: number;
  failed: ReconcileFailure[];
  /** ISO timestamp of the sweep, so a caller can say when rather than assuming "just now". */
  at: string;
}

/** What Stripe answered, or why it did not. Split out so the loop below reads as the policy it is
 *  and the per-workspace error handling is not tangled into the arithmetic. */
async function reconcileOne(stripe: Stripe, subscriptionId: string): Promise<MonthlyAmount> {
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  if (DEAD_SUBSCRIPTION_STATUSES.has(subscription.status)) {
    // NOT recorded as zero, deliberately. A cancelled subscription still attached to a workspace is
    // a stale column, and a workspace whose list price is $200 showing $0 billed would be rendered
    // as a 100% discount — a fabricated number in exactly the place this feature promises not to
    // fabricate one. Naming it as a failure surfaces the stale id, which is the real problem.
    throw new Error(`Stripe reports this subscription as ${subscription.status}; the stored id no longer describes a live subscription.`);
  }
  return subscriptionMonthlyMinor(subscription as unknown as SubscriptionShape);
}

/**
 * Walk every workspace holding a `stripeSubscriptionId`, ask Stripe what it bills, store it.
 *
 * WHAT IT DOES NOT DO: reach a workspace with no subscription. Those are not attempted, not
 * recorded, and not counted as zero — the great majority of installations of this product have no
 * Stripe account whatsoever and assign tiers by hand, and for them this sweep is a no-op that says
 * so.
 *
 * ONE FAILURE IS ONE WORKSPACE. The `try` is inside the loop for the same reason the usage-snapshot
 * sweep's is: an expired card on one customer must not cost the other ninety-nine their figures.
 */
export async function reconcileBilledRevenue(): Promise<ReconcileResult> {
  const at = new Date();
  const context = await resolveStripeClient();
  if (!context) return { configured: false, attempted: 0, reconciled: 0, failed: [], at: at.toISOString() };

  const orgs = await controlPrisma.organization.findMany({
    where: { stripeSubscriptionId: { not: null } },
    select: { id: true, slug: true, stripeSubscriptionId: true }
  });

  const failed: ReconcileFailure[] = [];
  let reconciled = 0;

  for (const org of orgs) {
    try {
      const amount = await reconcileOne(context.stripe, org.stripeSubscriptionId!);
      await controlPrisma.organization.update({
        where: { id: org.id },
        data: {
          billedMrrMinor: amount.amountMinor,
          billedCurrency: amount.currency,
          billedSubscriptionId: org.stripeSubscriptionId,
          billedReconciledAt: at,
          billedReconcileAttemptedAt: at,
          // Cleared on success: a workspace that recovered must stop being named as broken, and a
          // stale error beside a fresh figure is the kind of thing an operator stops trusting.
          billedReconcileError: null
        }
      });
      reconciled += 1;
    } catch (error) {
      const message = (error as Error).message || "Stripe could not be reached.";
      failed.push({ orgId: org.id, slug: org.slug, message });
      // The FIGURE is left exactly as it was — a previously good amount stays readable, with its
      // own older `billedReconciledAt` beside it, rather than being wiped because today's attempt
      // failed. Only the attempt marker and the error move.
      await controlPrisma.organization
        .update({ where: { id: org.id }, data: { billedReconcileAttemptedAt: at, billedReconcileError: message.slice(0, 500) } })
        .catch(() => undefined);
    }
  }

  return { configured: true, attempted: orgs.length, reconciled, failed, at: at.toISOString() };
}
