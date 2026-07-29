import Stripe from "stripe";

/** Builds a genuinely valid `Stripe-Signature` header for `payload` signed with `secret`, using
 *  the real SDK's own test helper — `stripe.webhooks.constructEvent` does local HMAC verification
 *  only (no network call), so exercising the real implementation is both simpler and more
 *  meaningful than mocking it. */
export function signWebhookPayload(payload: string, secret: string): string {
  return Stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp: Math.floor(Date.now() / 1000) });
}
