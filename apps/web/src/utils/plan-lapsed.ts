/**
 * WHAT: the decisions behind /plan-lapsed (pages/PlanLapsed.tsx) — who is offered what, whom a member
 * is told to ask, and how long the page waits for a payment to land. Pure, so
 * tests/unit/plan-lapsed.test.ts pins each one.
 *
 * WHY THE PAGE DOES THE PAYING ITSELF. It used to link "Choose a plan" into /app/settings?tab=billing,
 * inside the app shell — whose notifications bell and project sidebar call routes a lapsed workspace
 * is refused, and every refusal navigates back here. A lapsed trial could not pay its way out. So the
 * page calls only the routes GRACE leaves open (middleware/auth.ts) and never mounts the shell.
 */

export type PaidTier = "TEAM" | "ENTERPRISE";

/** The slice of `GET /billing/status` these decisions read. */
export interface BillingSnapshot {
  hasSubscription: boolean;
  checkoutAvailable: Record<PaidTier, boolean>;
}

export interface LapsedActions {
  /** Plans offered through Stripe Checkout, in this order. */
  plans: PaidTier[];
  /** "Update payment method" through Stripe's billing portal. */
  portal: boolean;
  /** The timesheet export buttons — the data export GRACE leaves open to a super admin. */
  exports: boolean;
  /** Nothing can be bought on this deployment: say who to contact instead of showing dead buttons. */
  checkoutUnconfigured: boolean;
}

const PLAN_ORDER: PaidTier[] = ["TEAM", "ENTERPRISE"];

/**
 * What the page offers. Null for anyone but a super admin: they are the only role GRACE lets reach
 * billing, and a button somebody cannot use is a support ticket the admin never hears about.
 *
 * A WORKSPACE WITH A SUBSCRIPTION GETS THE PORTAL, NOT THE PLANS. It lapsed because a renewal failed;
 * the fix is the card, and a Checkout beside a live past-due subscription would bill for two.
 */
export function lapsedActions(role: string | undefined, billing: BillingSnapshot | undefined): LapsedActions | null {
  if (role !== "SUPER_ADMIN") return null;
  if (!billing) return { plans: [], portal: false, exports: true, checkoutUnconfigured: false };
  if (billing.hasSubscription) return { plans: [], portal: true, exports: true, checkoutUnconfigured: false };
  const plans = PLAN_ORDER.filter((tier) => billing.checkoutAvailable[tier]);
  return { plans, portal: false, exports: true, checkoutUnconfigured: plans.length === 0 };
}

export interface BillingContact {
  name: string;
  email: string;
}

/** "Ask Priya Shah (priya@acme.com) to renew it." — the one useful thing to tell a member. */
export function contactLine(contacts: BillingContact[] | undefined): string {
  const named = (contacts ?? []).map((c) => `${c.name} (${c.email})`);
  if (named.length === 0) return "Ask a workspace admin to renew it.";
  const list = named.length === 1 ? named[0] : `${named.slice(0, -1).join(", ")} or ${named[named.length - 1]}`;
  return `Ask ${list} to renew it.`;
}

export type LapsedPageMode = "finishing" | "active" | "lapsed";

/**
 * Which face the page shows. `?billing=success` is Stripe sending the browser back after a payment,
 * usually BEFORE its webhook has unlocked the workspace — so the page waits rather than showing a
 * lock to somebody who has just paid. An ACTIVE workspace says so: a status cache a few seconds stale
 * on another server can still send somebody here straight after paying.
 */
export function lapsedPageMode(billingParam: string | null, status: string | undefined): LapsedPageMode {
  if (billingParam === "success") return "finishing";
  if (status === "ACTIVE") return "active";
  return "lapsed";
}

/** How often the page asks whether the payment has landed, and when it stops asking quietly. */
export const PAYMENT_POLL_MS = 2_000;
export const PAYMENT_WAIT_TIMEOUT_MS = 90_000;

export function paymentWaitState(startedAt: number, now: number, status: string | undefined): "active" | "waiting" | "timed-out" {
  if (status === "ACTIVE") return "active";
  return now - startedAt >= PAYMENT_WAIT_TIMEOUT_MS ? "timed-out" : "waiting";
}
