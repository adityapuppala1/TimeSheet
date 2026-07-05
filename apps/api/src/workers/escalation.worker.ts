/**
 * WHAT: cron entry point registering `services/sla.service.ts#processSlaSweep` on
 * `env.SLA_CRON_SCHEDULE` (default every 15 minutes) — the timesheet-approval SLA breach sweep.
 * WHY: kept as its own tiny worker file (rather than folded into `sla.service.ts`) so the
 * scheduling concern (cron validation, per-org fan-out, error isolation) stays separate from
 * the sweep's actual business logic — same split as every other `workers/*.ts` file.
 * WHO calls this: started once from `server.ts`.
 */
import cron from "node-cron";
import { env } from "../config/env.js";
import { processSlaSweep } from "../services/sla.service.js";
import { runForEveryOrg } from "./run-for-every-org.js";

let started = false;

export function startEscalationWorker() {
  if (started) return;
  if (!env.SLA_ENABLED) {
    console.info("[sla] worker disabled via SLA_ENABLED=false");
    return;
  }
  if (!cron.validate(env.SLA_CRON_SCHEDULE)) {
    console.warn(`[sla] invalid cron schedule "${env.SLA_CRON_SCHEDULE}" — worker will not start.`);
    return;
  }

  cron.schedule(env.SLA_CRON_SCHEDULE, () => {
    runForEveryOrg("sla", async () => {
      const result = await processSlaSweep();
      if (result.breaches > 0) console.info(`[sla] sweep: ${result.breaches} breach(es), ${result.escalations} escalation(s).`);
    }).catch((error) => console.error("[sla] sweep failed:", (error as Error).message));
  });

  started = true;
  console.info(`[sla] worker scheduled (${env.SLA_CRON_SCHEDULE}).`);
}
