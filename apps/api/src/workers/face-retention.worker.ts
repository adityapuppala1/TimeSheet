/**
 * Face-capture retention worker — fires daily at 03:15 server-local time.
 * WHAT: deletes stored face-verification images older than
 * `GlobalFaceVerificationSettings.imageRetentionDays`, from disk AND from the row that points
 * at them, then marks the row `purgedAt`.
 * WHY this exists at all: captured face images are biometric data. Every biometric privacy
 * regime this app's customers plausibly fall under (GDPR Art.5(1)(e) storage limitation,
 * Illinois BIPA's mandatory written retention schedule, India's DPDP Act) requires that they
 * are not kept indefinitely — and a retention *policy* that nothing enforces is just a
 * document. This is the enforcement.
 * WHY the row survives: only the IMAGE is deleted. The attempt record (who, when, outcome,
 * scores) is the audit trail and stays — it contains no biometric data once the image is gone,
 * and deleting it would destroy exactly the history the feature exists to produce.
 * WHO calls this: server.ts at boot, alongside every other cron worker.
 */
import fsp from "node:fs/promises";
import cron from "node-cron";
import { prisma } from "../config/prisma.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { getFaceSettings } from "../services/face.service.js";
import { runForEveryOrg } from "./run-for-every-org.js";

let started = false;
let running = false;

/** How many rows to purge per pass. Bounded so one org with a huge backlog can't hold the
 *  tenant loop open for minutes — the next daily run picks up whatever is left. */
const BATCH_SIZE = 500;

export async function purgeExpiredFaceImages(): Promise<{ purged: number }> {
  const settings = await getFaceSettings();

  // 0 means "never store images", which the capture path already honours — there is nothing
  // dated to purge, and treating 0 as "delete everything older than now" would be the same
  // outcome by a more confusing route.
  if (!settings.enabled || settings.imageRetentionDays <= 0) return { purged: 0 };

  const cutoff = new Date(Date.now() - settings.imageRetentionDays * 24 * 60 * 60 * 1000);
  const expired = await prisma.faceVerificationAttempt.findMany({
    where: { imagePath: { not: null }, createdAt: { lt: cutoff } },
    select: { id: true, imagePath: true },
    take: BATCH_SIZE
  });
  if (expired.length === 0) return { purged: 0 };

  for (const row of expired) {
    if (row.imagePath) {
      // Best-effort unlink: a file already gone (manual cleanup, restored volume) must still
      // let the row be marked purged, otherwise it's retried forever.
      await fsp.rm(row.imagePath, { force: true }).catch(() => undefined);
    }
  }

  await prisma.faceVerificationAttempt.updateMany({
    where: { id: { in: expired.map((r) => r.id) } },
    data: { imagePath: null, purgedAt: new Date() }
  });

  return { purged: expired.length };
}

export function startFaceRetentionWorker(): void {
  if (started) return;
  started = true;

  cron.schedule("15 3 * * *", async () => {
    if (running) return;
    running = true;
    try {
      await runForEveryOrg("face-retention", async () => {
        const { purged } = await purgeExpiredFaceImages();
        if (purged > 0) {
          console.log(`[face-retention] ${requireTenantContext().orgSlug}: purged ${purged} expired face capture(s)`);
        }
      });
    } catch (error) {
      console.error("[face-retention] sweep failed:", (error as Error).message);
    } finally {
      running = false;
    }
  });
}
