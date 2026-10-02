/**
 * WHAT: where a billing link lands, for a workspace in a given state — the hosted Stripe pages'
 * return addresses and every billing email's button.
 *
 * WHY ONE PLACE. A workspace in GRACE cannot use the app shell: its own requests (the notifications
 * bell, the project sidebar) are refused with a 402, and the client answers every 402 by navigating
 * to /plan-lapsed. So any billing link into /app for a lapsed workspace bounces straight back — which
 * is how a lapsed trial could not pay, and how a customer returning from a successful Checkout landed
 * on "this workspace is paused". /plan-lapsed takes payment in place; /app/settings?tab=billing is the
 * right page only while the workspace is ACTIVE. Every link-builder asks here, so no new email can
 * quietly reintroduce the loop.
 */

/** The Billing tab, inside the app shell — for a workspace that is ACTIVE. */
export const BILLING_SETTINGS_PATH = "/app/settings?tab=billing";

/** The standalone page a lapsed workspace pays from (apps/web/src/pages/PlanLapsed.tsx). */
export const PLAN_LAPSED_PATH = "/plan-lapsed";

/** Where to send somebody to pay for a workspace whose status is `status`. Anything but ACTIVE is
 *  lapsed for this purpose: a SUSPENDED workspace does not resolve at all, and its emails carry the
 *  reactivation link besides. */
export function billingPathFor(status: string): string {
  return status === "ACTIVE" ? BILLING_SETTINGS_PATH : PLAN_LAPSED_PATH;
}

/** Where a hosted Stripe page sends the browser back to. The `?billing=` marker is what the landing
 *  page reads to say "payment received" or "nothing was charged". */
export function stripeReturnPath(status: string, outcome?: "success" | "cancelled"): string {
  const base = status === "ACTIVE" ? "/app/settings" : PLAN_LAPSED_PATH;
  return outcome ? `${base}?billing=${outcome}` : base;
}
