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
 * WHAT THIS NUMBER IS. The subscription's RECURRING price — `unit_amount × quantity`, per month — NET
 * OF ITS RECURRING DISCOUNTS, which is Stripe's own MRR definition: a percent-off or amount-off coupon
 * that runs `forever`, or `repeating` and not yet ended, comes off; a `once` coupon does not (it is a
 * one-off, not a monthly rate). It is still not an invoice total: a one-off credit, tax and a
 * proration on this cycle belong to an invoice, which answers "what did we collect in July?" rather
 * than "what are these customers on the hook for each month?". It used to ignore coupons entirely
 * while the console called the gap to list price "discounting" — a gap that could not contain one.
 *
 * AND ONLY FOR A SUBSCRIPTION THAT BILLS. The status is stored beside the figure, and the revenue
 * screen counts only `active` and `past_due` (stripe-client.service.ts#BILLABLE_SUBSCRIPTION_STATUSES);
 * a trialing, unpaid or paused subscription is reconciled and named, but is not billed MRR.
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

export interface CouponShape {
  id?: string;
  percent_off?: number | null;
  amount_off?: number | null;
  currency?: string | null;
  /** `once` | `repeating` | `forever`. */
  duration?: string | null;
}

/** A Stripe discount, either API shape: the coupon directly on it (older API versions) or under
 *  `source` (current ones). An unexpanded coupon is its id; an unexpanded DISCOUNT is a bare string. */
export interface DiscountShape {
  coupon?: CouponShape | string | null;
  source?: { coupon?: CouponShape | string | null } | null;
  /** Unix seconds a `repeating` coupon stops applying; null for `once` and `forever`. */
  end?: number | null;
}

export interface ItemShape {
  quantity?: number | null;
  price?: PriceShape | null;
  discounts?: Array<DiscountShape | string> | null;
}

export interface SubscriptionShape {
  id?: string;
  status?: string;
  items?: { data?: ItemShape[] } | null;
  discounts?: Array<DiscountShape | string> | null;
}

/** The coupon behind a discount, or a throw when it cannot be read — reporting a gross amount as the
 *  net one is the same silent overstatement as ignoring the discount. */
function couponOf(discount: DiscountShape | string): CouponShape {
  const coupon = typeof discount === "string" ? null : (discount.coupon ?? discount.source?.coupon ?? null);
  if (!coupon || typeof coupon === "string") throw new Error("A discount on this subscription could not be read, so its net monthly amount is unknown.");
  return coupon;
}

/** The coupons that reduce a MONTHLY rate today: recurring ones still in their term. */
function recurringCoupons(discounts: Array<DiscountShape | string> | null | undefined, now: Date): CouponShape[] {
  return (discounts ?? [])
    .filter((discount) => typeof discount === "string" || !discount.end || discount.end * 1000 > now.getTime())
    .map(couponOf)
    .filter((coupon) => coupon.duration !== "once");
}

/** An amount for one billing period after its coupons: percentages first, then fixed amounts, never
 *  below zero. A fixed amount in another currency cannot be subtracted, and says so. */
function afterCoupons(periodAmount: number, coupons: CouponShape[], currency: string): number {
  let amount = periodAmount;
  for (const coupon of coupons) if (coupon.percent_off) amount *= 1 - coupon.percent_off / 100;
  for (const coupon of coupons) {
    if (!coupon.amount_off) continue;
    if ((coupon.currency ?? "").toUpperCase() !== currency) throw new Error("An amount-off coupon is in a different currency from the subscription, so it cannot be netted.");
    amount -= coupon.amount_off;
  }
  return Math.max(0, amount);
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
export function subscriptionMonthlyMinor(subscription: SubscriptionShape, now = new Date()): MonthlyAmount {
  const items = subscription.items?.data ?? [];
  if (items.length === 0) throw new Error("The subscription has no line items, so there is nothing to price.");

  let exact = 0;
  let currency: string | null = null;
  let periodMonths = 1;

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
    // report a paying customer as free. A line's own discounts come off the line, per period.
    const quantity = item.quantity ?? 1;
    exact += afterCoupons(price.unit_amount * quantity, recurringCoupons(item.discounts, now), lineCurrency) / months;
    periodMonths = months;
  }

  // The subscription's discounts come off the whole of it, per billing period — Stripe bills every
  // line of one subscription on one interval, so the last line's is the subscription's.
  const monthly = afterCoupons(exact * periodMonths, recurringCoupons(subscription.discounts, now), currency || "USD") / periodMonths;
  return { amountMinor: Math.round(monthly), currency: currency || "USD" };
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

/** Coupons Stripe returned by id (a discount's coupon is expandable), fetched and put in place so the
 *  pure arithmetic sees whole objects. Only reached for a subscription that HAS a discount. */
async function withCoupons(stripe: Stripe, subscription: SubscriptionShape): Promise<SubscriptionShape> {
  const resolve = async (discounts: Array<DiscountShape | string> | null | undefined) =>
    Promise.all(
      (discounts ?? []).map(async (discount) => {
        if (typeof discount === "string") return discount;
        const coupon = discount.coupon ?? discount.source?.coupon;
        return typeof coupon === "string" ? { ...discount, coupon: (await stripe.coupons.retrieve(coupon)) as CouponShape } : discount;
      })
    );
  const items = await Promise.all((subscription.items?.data ?? []).map(async (item) => ({ ...item, discounts: await resolve(item.discounts) })));
  return { ...subscription, discounts: await resolve(subscription.discounts), items: { data: items } };
}

/** What Stripe answered, or why it did not. Split out so the loop below reads as the policy it is
 *  and the per-workspace error handling is not tangled into the arithmetic. */
async function reconcileOne(stripe: Stripe, subscriptionId: string): Promise<MonthlyAmount & { status: string }> {
  // The discounts are expanded so the figure can be NET of them; a coupon still arriving as an id is
  // fetched by `withCoupons`.
  const subscription = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["discounts", "items.data.discounts"] });
  if (DEAD_SUBSCRIPTION_STATUSES.has(subscription.status)) {
    // NOT recorded as zero, deliberately. A cancelled subscription still attached to a workspace is
    // a stale column, and a workspace whose list price is $200 showing $0 billed would be rendered
    // as a 100% discount — a fabricated number in exactly the place this feature promises not to
    // fabricate one. Naming it as a failure surfaces the stale id, which is the real problem.
    throw new Error(`Stripe reports this subscription as ${subscription.status}; the stored id no longer describes a live subscription.`);
  }
  return { ...subscriptionMonthlyMinor(await withCoupons(stripe, subscription as unknown as SubscriptionShape)), status: subscription.status };
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
          billedSubscriptionStatus: amount.status,
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
