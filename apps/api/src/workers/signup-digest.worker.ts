/**
 * WHAT: the clock behind the daily signup summary (signup Phase 1).
 *
 * THE LOGIC IS NOT HERE. `services/signup-digest.service.ts#runSignupDigest` decides whether there is
 * news, who hears it, and claims the day so that only one replica sends; this file only decides when
 * to ask. Same split as platform-alert-digest.worker.ts, so the console's "Run now" runs the identical
 * code path.
 *
 * AT 08:15 EVERY DAY, IN THE PLATFORM'S ZONE (`TZ`, Asia/Kolkata by default) — named explicitly rather
 * than left to whatever zone the process happens to run in. Early enough to be read with the morning's mail and to act on a failed signup
 * the same day; :15 keeps it clear of the hourly jobs at :00, :05, :25 and :30. Every replica schedules
 * it — the PlatformJobClaim row is what makes one email, not the scheduler.
 */
import cron from "node-cron";
import { env } from "../config/env.js";
import { runSignupDigest } from "../services/signup-digest.service.js";

let started = false;
let running = false;

export function startSignupDigestWorker(): void {
  if (started) return;
  started = true;

  cron.schedule("15 8 * * *", async () => {
    if (running) return;
    running = true;
    try {
      const result = await runSignupDigest(new Date());
      // Logged either way: "nothing was sent" and "the worker did not run" must be told apart.
      console.info(
        `[signup-digest] ${result.sent ? "sent" : "quiet"}: ${result.reason} (created ${result.counts.created}, failed ${result.counts.failed}, join ${result.counts.joinRequested}, refused ${result.counts.refused})`
      );
    } catch (error) {
      console.warn(`[signup-digest] pass failed: ${(error as Error).message}`);
    } finally {
      running = false;
    }
  }, { timezone: env.TZ });
}
