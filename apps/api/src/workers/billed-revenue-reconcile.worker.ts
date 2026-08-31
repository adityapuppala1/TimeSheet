/**
 * WHAT: the clock behind the one number on the revenue screen that is not list price — what Stripe
 * actually bills each subscribed workspace, per month.
 *
 * WHY A WORKER AND NOT A PAGE READ. Asking Stripe costs one outbound HTTP call per subscribed
 * workspace. The revenue screen is one an operator refreshes while talking to somebody, so doing it
 * on render is a rate limit with a date on it — which is exactly why the field sat hard-coded null
 * until this shipped. Sweeping once a night writes the answer into `Organization.billed*`, and the
 * screen reads a column. Same trade `org-usage-snapshot.worker.ts` made, and this file is modelled
 * on it deliberately: same skip-don't-queue guard, same per-org isolation in the service, same
 * "name what failed" logging.
 *
 * THE LOGIC IS NOT HERE. `services/platform-billing-reconcile.service.ts` decides what to ask and
 * what to keep; this file only decides when. That is what lets a test drive the same pass without
 * cron, and the console trigger one by hand from the Revenue page.
 *
 * ON 03:50 UTC: :00 is the trial lifecycle, :05 backups, :25 the hourly database sample, :30
 * retention, :40 the usage snapshot. This runs last of the nightly set on purpose — it is the only
 * one that leaves the building, so it should not be competing for the box with four jobs opening
 * tenant databases, and nothing else waits on its result.
 *
 * WHY NIGHTLY AND NOT HOURLY: a subscription's recurring amount changes when somebody changes plan
 * or seat count, which is a handful of events a month across a whole fleet. Twenty-four sweeps a
 * day would multiply the Stripe traffic by 24 to catch those a few hours sooner, and the console's
 * "Reconcile now" button already covers the case where somebody needs it immediately.
 */
import cron from "node-cron";
import { reconcileBilledRevenue } from "../services/platform-billing-reconcile.service.js";

let started = false;
let running = false;

export function startBilledRevenueReconcileWorker(): void {
  if (started) return;
  started = true;

  cron.schedule("50 3 * * *", async () => {
    // Skipping rather than queueing, exactly like the usage snapshot: a sweep of a large fleet can
    // outlast its slot, and two sweeps at once doubles the outbound Stripe traffic this whole
    // design exists to keep low. Safe to skip, because each run overwrites the same columns —
    // tomorrow's run reconciles tomorrow, and a missed night leaves yesterday's figure readable
    // with its own `billedReconciledAt` beside it rather than a hole.
    if (running) return;
    running = true;
    try {
      const result = await reconcileBilledRevenue();
      // A deployment with no Stripe account is the common case and says nothing at all. Logging
      // "0 reconciled" every night for them would train an operator to ignore this line.
      if (!result.configured) return;
      if (result.failed.length) {
        // Named, not counted: "3 failed" is not something anybody can act on at 04:00.
        const named = result.failed.map((entry) => `${entry.slug} (${entry.message})`).join("; ");
        console.warn(`[billed-revenue] ${result.reconciled}/${result.attempted} reconciled, ${result.failed.length} failed: ${named}`);
      }
    } catch (error) {
      console.warn(`[billed-revenue] pass failed: ${(error as Error).message}`);
    } finally {
      running = false;
    }
  });
}
