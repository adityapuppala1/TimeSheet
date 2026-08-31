/**
 * WHAT: the one place a Stripe client is built from the deployment's stored secret key.
 *
 * WHY IT IS ITS OWN MODULE. The same six lines — read `PlatformBillingSettings`, check there is a
 * key, `decryptSecret`, `new Stripe(...)` — had been written out three times: in
 * `billing.controller.ts` (twice, once for the routes and once for the webhook) and in
 * `billing-sync.service.ts`. A fourth caller arrived with the billed-revenue reconciliation, and
 * four copies of "how do we talk to Stripe" is four places to forget when the key moves, the client
 * gains an API-version pin, or somebody adds a timeout. It is a service and not a util because it
 * reads the control database.
 *
 * TWO ENTRY POINTS, AND THE DIFFERENCE IS THE WHOLE DESIGN.
 *
 * `requireStripeClient()` THROWS when Stripe is not configured. That is right for a route somebody
 * clicked: they asked to open Checkout, and "billing isn't configured on this deployment" is the
 * true and useful answer.
 *
 * `resolveStripeClient()` returns `null` instead. That is right for everything that runs on its
 * own — a seat sync, a nightly reconciliation, a screen deciding whether to render a card. MOST
 * INSTALLATIONS OF THIS PRODUCT HAVE NO STRIPE ACCOUNT AT ALL; they assign tiers by hand. For them
 * an absent key is the ordinary state of the world, not a fault, and a background job that logged
 * an error every night about it would train its operator to ignore the log.
 *
 * NOTHING HERE CACHES THE CLIENT. The key is editable at runtime from the platform console, and a
 * cached client would keep using a rotated or revoked key until the process restarted — which is
 * exactly when somebody is watching to see whether the rotation worked. Constructing a `Stripe`
 * object is local work; the request it later makes is the expensive part either way.
 */
import Stripe from "stripe";
import { controlPrisma } from "../config/control-prisma.js";
import { AppError } from "../middleware/error.js";
import { decryptSecret } from "../utils/encryption.js";

/** The whole settings row, not a projection: callers need the price ids, the webhook signing
 *  secret, or neither, and narrowing here would just mean a second read at three call sites. */
export type StripeSettings = NonNullable<Awaited<ReturnType<typeof controlPrisma.platformBillingSettings.findUnique>>>;

export interface StripeContext {
  stripe: Stripe;
  settings: StripeSettings;
}

/**
 * A client, or `null` when this deployment has no Stripe secret key.
 *
 * The `catch` is deliberate and narrow in intent: a control database that cannot answer must not
 * take down a background sweep that is only asking an optional question. It degrades to "no Stripe"
 * — the same answer as an unconfigured deployment, which is the safe direction, because every
 * caller of this function treats that as "show nothing" rather than as "the amount is zero".
 */
export async function resolveStripeClient(): Promise<StripeContext | null> {
  const settings = await controlPrisma.platformBillingSettings.findUnique({ where: { id: "global" } }).catch(() => null);
  if (!settings?.encryptedSecretKey) return null;
  return { stripe: new Stripe(decryptSecret(settings.encryptedSecretKey)), settings };
}

/** The same, for a route a person is waiting on. 503 rather than 500: the deployment is fine, the
 *  capability is simply not switched on, and that is a configuration answer not a crash. */
export async function requireStripeClient(): Promise<StripeContext> {
  const context = await resolveStripeClient();
  if (!context) throw new AppError(503, "Billing isn't configured on this deployment yet.");
  return context;
}

/**
 * Is Stripe configured at all?
 *
 * Separate from the two above because the revenue screen asks this question WITHOUT wanting a
 * client: it decides whether to render the reconciliation card, and building a `Stripe` object to
 * throw it away would read as though the page were about to call out to Stripe — which is the one
 * thing that screen must never do.
 */
/**
 * Statuses a subscription never comes back from.
 *
 * Anything else — `past_due`, `unpaid`, `paused`, a card stuck in `incomplete` — is a LIVE
 * subscription with a problem, and every caller here treats it as live: changing its plan is still
 * the right move, and its billed amount is still what the customer is on the hook for.
 *
 * HERE RATHER THAN IN EITHER CALLER because it is a fact about Stripe, not a policy of the plan
 * changer or of the revenue reconciliation, and those two were about to hold separate copies of it.
 */
export const DEAD_SUBSCRIPTION_STATUSES = new Set<Stripe.Subscription.Status>(["canceled", "incomplete_expired"]);

export async function isStripeConfigured(): Promise<boolean> {
  const settings = await controlPrisma.platformBillingSettings
    .findUnique({ where: { id: "global" }, select: { encryptedSecretKey: true } })
    .catch(() => null);
  return Boolean(settings?.encryptedSecretKey);
}
