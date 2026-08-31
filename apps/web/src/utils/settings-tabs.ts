/**
 * Which tab Workspace Settings opens on, decided from the URL.
 *
 * WHY IT IS ITS OWN MODULE rather than a helper inside WorkspaceSettings.tsx: it is a pure rule
 * about untrusted input, so it is tested as one — the same reasoning `utils/return-to.ts` records.
 * Importing the settings page into a test would drag recharts and fourteen settings cards along
 * with it to check a string comparison.
 *
 * WHY IT EXISTS AT ALL. The page always opened on Reminders, ignoring the query string entirely,
 * and two things had been quietly pointing at it for a long time:
 *  - `?tab=` — what every billing email's `billingUrl` has always been (`/app/settings?tab=billing`),
 *    and what the Integrations card's pointer at Single sign-on uses.
 *  - `?billing=` — Stripe's own return redirect after Checkout. It names no tab, but there is only
 *    one it can mean.
 * So a customer coming back from paying, and anyone following "update your card" out of a
 * failed-payment email, landed on a panel about reminder schedules with no mention of billing on
 * screen. That reads as a payment that did not register.
 */

/** Every value carried by a `TabsTrigger` in WorkspaceSettings.tsx. Kept as a set because the point
 *  is to REFUSE anything else: Radix renders no panel for a value that has no trigger, so honouring
 *  an unknown `?tab=` would open the page onto blank space with nothing selected. A stale link is
 *  better answered with the default tab than with an empty screen. */
export const SETTINGS_TABS = new Set([
  "branding",
  "reminders",
  "emails",
  "mail-server",
  "ticketing",
  "planning",
  "changes",
  "ai",
  "email-intake",
  "chat-integrations",
  "security-devops",
  "face-verification",
  "integrations",
  "billing",
  "public-api",
  "mcp",
  "sso",
  "maintenance",
  "storage",
  "bcc"
]);

/** The tab to open on. `?tab=` wins when it names a real tab; `?billing=` (Stripe's redirect, which
 *  carries `success` or `cancelled`) falls back to Billing; everything else gets the default.
 *  Read once, at mount — after that the tab strip belongs to the user. */
export function initialSettingsTab(params: URLSearchParams): string {
  const requested = params.get("tab");
  if (requested && SETTINGS_TABS.has(requested)) return requested;
  if (params.has("billing")) return "billing";
  return "reminders";
}
