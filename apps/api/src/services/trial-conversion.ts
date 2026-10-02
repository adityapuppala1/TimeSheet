/**
 * WHAT: the ONE rule for "this workspace left its trial for a paid plan" — shared by the trial
 * lifecycle worker, the retention programme, the console's plan edit, and every console metric that
 * counts conversions (Revenue's trial→paid, the Signups page, the revenue snapshot's "still trialling").
 *
 * WHY ITS OWN MODULE. It lived in retention.service.ts, which opens tenant databases, spawns dumps and
 * reads the environment at import — a revenue screen that only needs this one predicate should not
 * drag that in, and a second copy written to avoid the import is exactly how "converted" came to have
 * three definitions across the console. retention.service.ts re-exports it, so its callers are unchanged.
 *
 * STRUCTURAL TYPES, so a snapshot row (whose plan columns are plain strings, kept that way for history)
 * is asked the same question as a live `Organization`.
 */
export interface ConversionFields {
  trialTier: string | null;
  stripeSubscriptionId: string | null;
  planTier: string;
}

export function isConverted(org: ConversionFields): boolean {
  // The Stripe webhook nulls `trialTier` when a checkout completes; a platform admin converting a
  // customer by hand raises `planTier` (and the console now clears the trial fields as well). Either
  // is "somebody is paying" — and a paying customer is never in the retention programme, whatever
  // the clock says.
  return org.trialTier === null || Boolean(org.stripeSubscriptionId) || org.planTier !== "STARTER";
}
