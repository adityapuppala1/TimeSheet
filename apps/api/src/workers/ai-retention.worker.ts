/**
 * Deletes captured AI interactions past their retention window.
 *
 * WHY this is its own worker rather than a stage in face-retention.worker.ts: that worker governs
 * biometric data under a specific legal regime (GDPR Art.9 / BIPA / DPDP) with its own consent and
 * grace-period rules. AI capture is ordinary operational telemetry with a different rationale and
 * a different admin-set window. Folding them together would make it easy to change one and
 * silently alter the other.
 *
 * WHY retention exists at all: with `aiCaptureContentEnabled` on, these rows hold real user
 * content — ticket descriptions, timesheet notes, PR diffs. Keeping that indefinitely to answer
 * "how good is our AI?" is not a trade worth making, and an unbounded table would grow with every
 * AI call forever.
 */
import cron from "node-cron";
import { prisma } from "../config/prisma.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { getGlobalAISettings } from "../services/ai.service.js";
import { runForEveryOrg } from "./run-for-every-org.js";

let started = false;
let running = false;

const DAY_MS = 24 * 60 * 60 * 1000;
/** Bounds one tick so a large backlog can't hold the tenant loop open — the next tick continues. */
const BATCH_SIZE = 5_000;

export async function sweepExpiredAIInteractions(now: Date = new Date()): Promise<{ deleted: number }> {
  const settings = await getGlobalAISettings();
  // Nothing captured means nothing to sweep. Deliberately does NOT purge historical rows when the
  // toggle is switched off — turning capture off should stop new collection, not silently destroy
  // data an admin may still be analysing. Retention alone decides deletion.
  const retentionDays = settings.aiCaptureRetentionDays ?? 30;
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);

  const expired = await prisma.aIInteraction.findMany({
    where: { createdAt: { lt: cutoff } },
    select: { id: true },
    take: BATCH_SIZE
  });
  if (expired.length === 0) return { deleted: 0 };

  const result = await prisma.aIInteraction.deleteMany({ where: { id: { in: expired.map((row) => row.id) } } });
  return { deleted: result.count };
}

export function startAIRetentionWorker(): void {
  if (started) return;
  started = true;

  // 03:40 daily — after the face-retention sweep (03:15) so the two don't contend for the same
  // tenant connections.
  cron.schedule("40 3 * * *", () => {
    if (running) return;
    running = true;
    runForEveryOrg("ai-retention", async () => {
      const { deleted } = await sweepExpiredAIInteractions();
      if (deleted > 0) console.info(`[ai-retention] ${requireTenantContext().orgSlug}: deleted ${deleted} expired AI interaction(s).`);
    })
      .catch((error) => console.error("[ai-retention] sweep failed:", (error as Error).message))
      .finally(() => {
        running = false;
      });
  });

  console.info("[ai-retention] worker scheduled (03:40 daily).");
}
