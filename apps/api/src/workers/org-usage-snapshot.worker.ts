/**
 * WHAT: the clock behind every historical number in the platform console — one usage snapshot per
 * workspace per day.
 *
 * WHY DAILY AND NOT HOURLY, unlike its sibling `tenant-db-sample.worker.ts`: the questions this
 * table answers are commercial ones. Churn, retention, cohort survival and revenue movement are all
 * measured in days and months, and twenty-four rows a day would multiply the table by 24 to add
 * nothing a business conversation can use. Database growth genuinely needs the hour — "it grew
 * during Tuesday's import" — and that is what the other worker is for.
 *
 * THE LOGIC IS NOT HERE. `services/platform-admin-analytics.service.ts#captureOrgUsageSnapshots`
 * decides what to read and what to keep; this file only decides when to ask. That is what lets a
 * test drive the same pass without cron, and the console trigger one by hand. It lives in that
 * service and not in a new one because it loops every tenant database, and that file is this
 * codebase's single audited place for doing so.
 *
 * ON 03:40 IN THE PLATFORM'S ZONE (`TZ`, Asia/Kolkata by default) — named in the schedule rather
 * than left to whatever zone the process starts in, the way signup-digest.worker.ts names it. This
 * header used to say "03:40 UTC" while the process ran in IST, so the job fired at 03:40 IST and the
 * copy was wrong. :00 is the trial lifecycle, :05 backups, :25 the hourly database sample, :30
 * retention: four jobs opening tenant databases in the same second is a self-inflicted thundering
 * herd on a box that is also serving requests. 03:40 is quiet, and it is after India's midnight, so
 * the row is India's date and its month to date has already rolled over on the 1st.
 */
import cron from "node-cron";
import { env } from "../config/env.js";
import { captureOrgUsageSnapshots } from "../services/platform-admin-analytics.service.js";
import { runOncePerTick } from "../services/job-claim.service.js";

let started = false;
let running = false;

export function startOrgUsageSnapshotWorker(): void {
  if (started) return;
  started = true;

  cron.schedule("40 3 * * *", async () => {
    // Skipping rather than queueing, exactly like the database sampler: a fleet sweep of a large
    // deployment can outlast its slot, and two sweeps at once doubles the connection load on the
    // one machine this is trying to keep an eye on. Skipping is safe here in a way it is not
    // everywhere, because the pass upserts on (organizationId, day) — tomorrow's run captures
    // tomorrow, and a missed day is a gap in a chart rather than a lost billing event.
    if (running) return;
    running = true;
    try {
      await runOncePerTick("usage-snapshot", "day", async () => {
        const result = await captureOrgUsageSnapshots();
        if (result.failed.length) {
          console.warn(`[usage-snapshot] ${result.captured} captured, ${result.failed.length} unreachable: ${result.failed.map((f) => f.slug).join(", ")}`);
        }
      });
    } catch (error) {
      console.warn(`[usage-snapshot] pass failed: ${(error as Error).message}`);
    } finally {
      running = false;
    }
  }, { timezone: env.TZ });
}
