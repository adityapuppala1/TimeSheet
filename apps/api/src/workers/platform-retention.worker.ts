/**
 * WHAT: the daily tick of the trial retention programme — the day-10 check-in, the trial-ended
 * message, the 30/60/80/90-day reminders, and the deletion the policy promises after 90 days.
 *
 * The logic lives in `services/retention.service.ts#runRetentionTick` so the console can run the
 * same pass on demand (and as a dry run with a simulated clock). This file is only the schedule.
 *
 * 09:30, half an hour after `trial-lifecycle.worker.ts`, on purpose: that worker is what moves an
 * expired trial to GRACE, and the "your trial has ended" message here reads that status. Running
 * first would mean sending it a day late.
 */
import cron from "node-cron";
import { runRetentionTick } from "../services/retention.service.js";

let started = false;
let running = false;

export function startPlatformRetentionWorker(): void {
  if (started) return;
  started = true;

  cron.schedule("30 9 * * *", async () => {
    if (running) return;
    running = true;
    try {
      const result = await runRetentionTick(new Date(), { dryRun: false, actorLabel: "scheduler" });
      if (result.sent.length || result.deleted.length || result.failed.length) {
        console.log(`[platform-retention] ${result.sent.length} sent, ${result.failed.length} failed, ${result.deleted.length} deleted, ${result.held.length} held`);
      }
    } catch (error) {
      console.warn(`[platform-retention] tick failed: ${(error as Error).message}`);
    } finally {
      running = false;
    }
  });
}
