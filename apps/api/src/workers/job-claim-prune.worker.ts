/**
 * WHAT: deletes `PlatformJobClaim` rows older than a week, once a day.
 *
 * WHY. Every scheduled tick claims its period (services/job-claim.service.ts), and several jobs tick
 * every minute — about ten thousand rows a day on a normal deployment. Each row is tiny and is never
 * read again once its period is over, so a week is kept (enough to answer "did Monday's 09:00 run
 * happen, and on which pod's watch?") and the rest goes.
 *
 * 04:30 in the platform's zone: in the gap between the 04:10 telemetry sweep and the 04:50
 * verification sweep, and nowhere near the 08:00–10:30 digest block. Claimed like every other tick,
 * although a second prune would only delete nothing.
 */
import cron from "node-cron";
import { pruneJobClaims, runOncePerTick } from "../services/job-claim.service.js";

let started = false;
let running = false;

export function startJobClaimPruneWorker(): void {
  if (started) return;
  started = true;

  cron.schedule("30 4 * * *", async () => {
    if (running) return;
    running = true;
    try {
      await runOncePerTick("job-claim-prune", "day", async () => {
        const deleted = await pruneJobClaims();
        if (deleted > 0) console.info(`[job-claim-prune] deleted ${deleted} claim(s) older than a week.`);
      });
    } catch (error) {
      console.warn(`[job-claim-prune] prune failed: ${(error as Error).message}`);
    } finally {
      running = false;
    }
  });
}
