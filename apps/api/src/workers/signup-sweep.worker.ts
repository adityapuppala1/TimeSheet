/**
 * WHAT: every ten minutes, removes self-serve signups left in PROVISIONING by an interrupted request
 * (services/signup-sweep.service.ts holds the rule and why).
 *
 * Ten minutes against a thirty-minute threshold: a company locked out by an interrupted signup is
 * free again within forty minutes at worst. Claimed per tick like every other worker.
 */
import cron from "node-cron";
import { runOncePerTick } from "../services/job-claim.service.js";
import { sweepAbandonedSignups } from "../services/signup-sweep.service.js";

let started = false;
let running = false;

export function startSignupSweepWorker(): void {
  if (started) return;
  started = true;

  cron.schedule("*/10 * * * *", async () => {
    if (running) return;
    running = true;
    try {
      await runOncePerTick("signup-sweep", "minute", async () => {
        const { removed } = await sweepAbandonedSignups();
        if (removed.length) console.warn(`[signup-sweep] removed ${removed.length} interrupted signup(s): ${removed.join(", ")}`);
      });
    } catch (error) {
      console.warn(`[signup-sweep] sweep failed: ${(error as Error).message}`);
    } finally {
      running = false;
    }
  });
}
