/**
 * Cron entry point for the ticket SLA sweep. Registered once from server.ts on boot.
 * WHY a fixed interval (env.TICKET_SLA_CRON_SCHEDULE, default every 15 min) rather than
 * event-driven: due dates are set once at creation and don't change on their own, so a
 * periodic "has anything gone overdue since last check" sweep is enough — no need to react
 * to every write.
 */
import cron from "node-cron";
import { env } from "../config/env.js";
import { processTicketSlaSweep } from "../services/ticket-sla.service.js";
import { runForEveryOrg } from "./run-for-every-org.js";

let started = false;

export function startTicketEscalationWorker() {
  if (started) return;
  if (!env.TICKET_SLA_ENABLED) {
    console.info("[ticket-sla] worker disabled via TICKET_SLA_ENABLED=false");
    return;
  }
  if (!cron.validate(env.TICKET_SLA_CRON_SCHEDULE)) {
    console.warn(`[ticket-sla] invalid cron schedule "${env.TICKET_SLA_CRON_SCHEDULE}" — worker will not start.`);
    return;
  }

  cron.schedule(env.TICKET_SLA_CRON_SCHEDULE, () => {
    runForEveryOrg("ticket-sla", async () => {
      const result = await processTicketSlaSweep();
      if (result.breaches > 0) console.info(`[ticket-sla] sweep: ${result.breaches} breach(es), ${result.escalations} escalation(s).`);
    }).catch((error) => console.error("[ticket-sla] sweep failed:", (error as Error).message));
  });

  started = true;
  console.info(`[ticket-sla] worker scheduled (${env.TICKET_SLA_CRON_SCHEDULE}).`);
}
