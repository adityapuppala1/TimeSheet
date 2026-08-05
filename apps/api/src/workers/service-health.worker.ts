/**
 * WHAT: probes every monitored service every five minutes, for every org, and records the result.
 *
 * WHY FIVE MINUTES: it is the resolution the status page's day strip actually needs (288 samples a
 * day is plenty to colour a square and compute a credible uptime figure) and it keeps the write
 * volume at roughly 100k rows a year per tenant, which the retention sweep inside runHealthChecks
 * then bounds. Probing every thirty seconds would give a prettier graph and a materially larger
 * table for no decision anybody makes differently.
 *
 * WHY IT RUNS PER ORG rather than once globally: every probe below the control-plane check is a
 * query against a TENANT database. "Are tickets working" has a different answer for each tenant —
 * one org's database can be fine while another's is out of connections — and a single global
 * answer would be a claim about a system that does not exist.
 *
 * The whole body is wrapped so a failing org never stops the others: one tenant with a broken
 * database must not take the monitoring down for everybody, which would mean losing the record
 * exactly when it is most wanted.
 */
import cron from "node-cron";
import { runForEveryOrg } from "./run-for-every-org.js";
import { runHealthChecks } from "../services/service-health.service.js";

export function startServiceHealthWorker() {
  // Offset from the top of the minute so this does not contend with the other cron jobs that
  // (understandably) all chose :00.
  cron.schedule("2,7,12,17,22,27,32,37,42,47,52,57 * * * *", () => {
    void runForEveryOrg("service-health", async () => {
      await runHealthChecks();
    });
  });
}
