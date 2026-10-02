/**
 * WHAT: what the console's organization dialog says and sends for a workspace still on a trial.
 * Pure, so tests/unit/org-trial.test.ts pins each decision.
 *
 * WHY THE NOTE. Setting a plan on a trialling workspace is a CONVERSION: the API clears the trial's
 * clock (no more "your trial ends in 3 days" emails, no lapse) and brings a lapsed trial back to
 * Active (platform-admin.controller.ts#trialEffects). An operator who only meant to "bump the tier"
 * should read that before saving, not discover it in the audit trail.
 */

type Tier = "STARTER" | "TEAM" | "ENTERPRISE";

export interface TrialFields {
  planTier: Tier;
  trialTier: Tier | null;
  trialEndsAt: string | null;
  stripeSubscriptionId: string | null;
}

const TIER_LABEL: Record<Tier, string> = { STARTER: "Starter", TEAM: "Team", ENTERPRISE: "Enterprise" };

/**
 * A trial clock is set and nobody is paying — the inverse of the API's
 * `retention.service.ts#isConverted`, which every server-side decision about trials reads. Kept to
 * the same three facts so the dialog never offers to extend a trial the server considers converted.
 */
export function hasLiveTrial(org: TrialFields): boolean {
  if (!org.trialEndsAt) return false;
  return org.trialTier !== null && !org.stripeSubscriptionId && org.planTier === "STARTER";
}

/** The line under the plan picker, or null when there is no trial to speak of. */
export function trialEditNote(org: TrialFields, nextTier: Tier): string | null {
  if (!hasLiveTrial(org)) return null;
  if (nextTier !== "STARTER") {
    return "Setting a plan ends the trial: its dates are cleared, the trial emails stop, and a lapsed trial goes back to Active.";
  }
  const ends = new Date(org.trialEndsAt!).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  const tier = org.trialTier ? TIER_LABEL[org.trialTier] : "a";
  return `On a ${tier} trial that ends ${ends}. Setting a plan ends the trial; extending it moves that date.`;
}

/**
 * A `<input type="date">` value as the last second of that day in the operator's own zone, as the ISO
 * string the API takes. "Extend to the 30th" means through the 30th, not until it starts.
 */
export function endOfDayIso(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
