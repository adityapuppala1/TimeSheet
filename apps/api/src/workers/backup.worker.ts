/**
 * WHAT: the clock behind managed backups. Hourly, because the finest cadence a policy can ask for
 * is hourly — a coarser tick would make "hourly" a lie, and a finer one would spend wake-ups on
 * nothing.
 *
 * THE LOGIC IS NOT HERE. `services/backup.service.ts#runBackupTick` decides what is due, clamps
 * every policy to its tier and runs each one; this file only decides WHEN to ask. That is what lets
 * the console dry-run the identical pass and a test drive it without cron.
 *
 * ON THE MINUTE 5 OFFSET: the trial-lifecycle worker runs at :00 and the retention programme at
 * :30. Three jobs that all open tenant databases starting in the same second is a self-inflicted
 * thundering herd on a box that is also serving requests.
 */
import cron from "node-cron";
import { runBackupTick } from "../services/backup.service.js";

let started = false;
let running = false;

export function startBackupWorker(): void {
  if (started) return;
  started = true;

  cron.schedule("5 * * * *", async () => {
    // A dump of a large workspace can outlast the hour. Skipping rather than queueing is right:
    // the next tick will find the same policy still due and run it then, and two mysqldumps of one
    // database at once is worse than a late backup.
    if (running) return;
    running = true;
    try {
      const result = await runBackupTick(new Date(), { dryRun: false, actorLabel: "scheduler" });
      if (result.ran.length || result.clamped.length) {
        console.log(`[backup] ${result.due} due, ${result.ran.filter((r) => r.status === "SUCCEEDED").length} succeeded, ${result.ran.filter((r) => r.status !== "SUCCEEDED").length} not, ${result.clamped.length} clamped to their tier`);
      }
    } catch (error) {
      console.warn(`[backup] tick failed: ${(error as Error).message}`);
    } finally {
      running = false;
    }
  });
}
