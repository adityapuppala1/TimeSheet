/**
 * WHAT: the clock behind the platform console's database TRENDS. Hourly, because that is the
 * resolution a capacity conversation needs — "it grew 4 GB this month" is answerable from daily
 * samples, but "it grew 4 GB during Tuesday's import" is not.
 *
 * THE LOGIC IS NOT HERE. `services/tenant-db-metrics.service.ts#sampleAllTenantDatabases` decides
 * what to read and what to keep; this file only decides when to ask. That is what lets a test drive
 * the same pass without cron, and the console trigger one by hand.
 *
 * ON THE MINUTE 25 OFFSET: :00 is the trial lifecycle, :05 backups, :30 retention. Four jobs that
 * all open tenant databases in the same second is a self-inflicted thundering herd on a box that is
 * also serving requests.
 */
import cron from "node-cron";
import { sampleAllTenantDatabases } from "../services/tenant-db-metrics.service.js";

let started = false;
let running = false;

export function startTenantDbSampleWorker(): void {
  if (started) return;
  started = true;

  cron.schedule("25 * * * *", async () => {
    // A fleet sweep of a large deployment can outlast the hour. Skipping rather than queueing is
    // right: a missing sample is a gap in a chart, while two sweeps at once doubles the connection
    // load on the one machine this is trying to keep an eye on.
    if (running) return;
    running = true;
    try {
      const result = await sampleAllTenantDatabases();
      if (result.failed.length) {
        console.warn(`[db-sample] ${result.sampled} sampled, ${result.failed.length} unreachable: ${result.failed.map((f) => f.slug).join(", ")}`);
      }
    } catch (error) {
      console.warn(`[db-sample] pass failed: ${(error as Error).message}`);
    } finally {
      running = false;
    }
  });
}
