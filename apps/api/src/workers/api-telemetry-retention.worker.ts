/**
 * Prunes `ApiRequestSample` past its retention window.
 *
 * WHY THIS TABLE NEEDS ITS OWN WORKER RATHER THAN A SWEEP INSIDE THE WRITER: service-health prunes
 * inline because it writes ~13 rows every five minutes and the delete is free. This table grows
 * with TRAFFIC — one row per sampled request, so a moderately busy workspace produces more rows in
 * an hour than the health sampler does in a year. A delete on that scale must never happen on the
 * path that is also trying to flush new telemetry.
 *
 * WHY IT DELETES IN BATCHES: a single `deleteMany` covering a fortnight of an unpruned table locks
 * and replicates as one enormous transaction. Bounded batches with a bounded number of rounds keep
 * each statement short and let the next night's tick continue a backlog, which is the same shape as
 * ai-retention.worker.ts.
 */
import cron from "node-cron";
import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { runForEveryOrg } from "./run-for-every-org.js";

let started = false;
let running = false;

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 10_000;
/** Ceiling per tenant per tick, so one tenant with a huge backlog cannot hold the org loop open all
 *  night and starve the tenants after it. */
const MAX_BATCHES = 20;

export async function sweepExpiredApiRequestSamples(now: Date = new Date()): Promise<{ deleted: number }> {
  const cutoff = new Date(now.getTime() - env.API_TELEMETRY_RETENTION_DAYS * DAY_MS);

  let deleted = 0;
  for (let round = 0; round < MAX_BATCHES; round += 1) {
    // Select ids first, then delete by id: `deleteMany` with only a date predicate gives MySQL no
    // bound on how many rows one statement touches.
    const expired = await prisma.apiRequestSample.findMany({
      where: { createdAt: { lt: cutoff } },
      select: { id: true },
      take: BATCH_SIZE
    });
    if (expired.length === 0) break;
    const result = await prisma.apiRequestSample.deleteMany({ where: { id: { in: expired.map((row) => row.id) } } });
    deleted += result.count;
    if (expired.length < BATCH_SIZE) break;
  }

  return { deleted };
}

export function startApiTelemetryRetentionWorker(): void {
  if (started) return;
  started = true;

  // 04:10 daily — after the AI sweep (03:40) so the two never contend for the same tenant
  // connections. Scheduled even when collection is off: turning recording off must not strand the
  // rows it already wrote, which would leave them un-pruned forever.
  cron.schedule("10 4 * * *", () => {
    if (running) return;
    running = true;
    runForEveryOrg("api-telemetry-retention", async () => {
      const { deleted } = await sweepExpiredApiRequestSamples();
      if (deleted > 0) {
        console.info(`[api-telemetry-retention] ${requireTenantContext().orgSlug}: deleted ${deleted} expired request sample(s).`);
      }
    })
      .catch((error) => console.error("[api-telemetry-retention] sweep failed:", (error as Error).message))
      .finally(() => {
        running = false;
      });
  });

  console.info(`[api-telemetry-retention] worker scheduled (04:10 daily, keeping ${env.API_TELEMETRY_RETENTION_DAYS} days).`);
}
