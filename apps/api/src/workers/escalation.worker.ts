import cron from "node-cron";
import { env } from "../config/env.js";
import { processSlaSweep } from "../services/sla.service.js";

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

  cron.schedule(env.SLA_CRON_SCHEDULE, async () => {
    try {
      const result = await processSlaSweep();
      if (result.breaches > 0) {
        console.info(`[sla] sweep: ${result.breaches} breach(es), ${result.escalations} escalation(s).`);
      }
    } catch (error) {
      console.error("[sla] sweep failed:", (error as Error).message);
    }
  });

  started = true;
  console.info(`[sla] worker scheduled (${env.SLA_CRON_SCHEDULE}).`);
}
