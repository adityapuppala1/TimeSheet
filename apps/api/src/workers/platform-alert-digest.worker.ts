/**
 * WHAT: the clock behind the fleet alert digest — the thing that makes a console alert reach
 * somebody who is not looking at the console.
 *
 * THE LOGIC IS NOT HERE. `services/platform-alerts.service.ts#runAlertDigest` decides what has
 * changed, whether it is worth saying, and where it goes; this file only decides when to ask. Same
 * split as `tenant-db-sample.worker.ts`, and for the same reason: a test can drive the whole pass
 * without cron, and the console's "Run now" button runs the identical code path rather than a
 * second copy of it that will drift.
 *
 * ON EVERY SIX HOURS AT :45. Two constraints meet here.
 *   • A sweep opens a connection to every tenant database (`getFleetHealth`), so it must not be
 *     frequent. The hourly sampler at :25 is already the heaviest thing on that box; :45 keeps
 *     these two apart, as :00 trial lifecycle, :05 backups, :25 sampling and :30 retention already
 *     are from each other.
 *   • Six hours is the longest an operator should wait to hear about a NEW critical. It is not a
 *     pager and does not pretend to be one — a deployment that needs seconds points the webhook at
 *     PagerDuty, which is exactly why the webhook exists.
 * Four passes a day also cost nothing in noise, because of the anti-noise rule: a pass with nothing
 * new to say sends nothing at all, so the frequency of the CHECK is decoupled from the frequency of
 * the MESSAGE. That decoupling is the whole reason this can run often enough to be useful.
 *
 * FAILURE IS PER-PASS, NOT PER-PROCESS. `runAlertDigest` already isolates one workspace's
 * unreachable database and one recipient's bad address internally; what is caught here is the pass
 * as a whole, so a control-plane blip costs one digest rather than the worker.
 */
import cron from "node-cron";
import { runAlertDigest } from "../services/platform-alerts.service.js";

let started = false;
let running = false;

export function startPlatformAlertDigestWorker(): void {
  if (started) return;
  started = true;

  cron.schedule("45 */6 * * *", async () => {
    // A fleet sweep of a large deployment can outlast the gap between passes. Skipping rather than
    // queueing is right for the same reason the sampler skips: two sweeps at once doubles the
    // connection load on the machine this is trying to keep an eye on, and — worse here — two
    // concurrent passes would both read the state table before either wrote it, and the same alert
    // would be announced twice.
    if (running) return;
    running = true;
    try {
      const result = await runAlertDigest();
      // Logged either way, because "nothing was sent" and "the worker did not run" have to be
      // distinguishable from a log file as well as from the console.
      if (result.sent) {
        console.info(`[alert-digest] sent: ${result.appeared} new, ${result.escalated} escalated, ${result.cleared} cleared to ${result.recipients} recipient(s); webhook ${result.webhook?.status ?? "n/a"}`);
      } else {
        console.info(`[alert-digest] quiet: ${result.reason}`);
      }
    } catch (error) {
      console.warn(`[alert-digest] pass failed: ${(error as Error).message}`);
    } finally {
      running = false;
    }
  });
}
