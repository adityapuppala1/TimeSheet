/**
 * Face lifecycle worker — fires daily at 03:15 server-local time and runs the whole
 * face-verification hygiene sweep for every org:
 *
 *  1. IMAGE RETENTION — deletes stored captures older than
 *     `GlobalFaceVerificationSettings.imageRetentionDays`, from disk AND from the row that
 *     points at them, then marks the row `purgedAt`. Every biometric privacy regime this app's
 *     customers plausibly fall under (GDPR Art.5(1)(e) storage limitation, Illinois BIPA's
 *     mandatory written retention schedule, India's DPDP Act) requires images are not kept
 *     indefinitely — and a retention *policy* that nothing enforces is just a document. Runs
 *     even when the feature has since been DISABLED (images from when it was on are still
 *     biometric data), and a retentionDays of 0 purges every stored image (the setting may have
 *     been lowered to 0 after images already existed).
 *     WHY the row survives: only the IMAGE is deleted. The attempt record (who, when, outcome,
 *     scores) is the audit trail and contains no biometric data once the image is gone.
 *
 *  2. ENTITLEMENT GRACE / PURGE — if the org's plan tier no longer includes face verification
 *     (downgrade, lapsed payment), enforcement already stopped instantly (fail-open in
 *     isFaceVerificationRequired). This stage handles the DATA: on first observation it stamps
 *     `entitlementLostAt` and tells the org's admins; after a 30-day grace window (long enough
 *     to re-subscribe without re-enrolling everyone) it purges every enrollment, capture, and
 *     the master switch itself. Keeping biometric data for a feature the org can no longer use
 *     is exactly the "no longer necessary for the purpose it was collected for" case
 *     storage-limitation rules target.
 *
 *  3. ENROLLMENT REMINDERS — nudges covered-but-unenrolled users (deduped to one nudge per 72h
 *     inside notifyEnrollmentRequired) so the enrollment ask arrives by notification, not by a
 *     blocked Friday-evening submission.
 *
 *  4. REVIEW OVERDUE — tells admins when flagged attempts have sat unreviewed for 48h+. A flag
 *     nobody reads is not a control; this is the same breach→escalation ladder the SLA system
 *     uses, applied to identity review.
 *
 *  5. CHALLENGE CLEANUP — deletes FaceChallenge rows a day past expiry. They hold no biometric
 *     data (just "which movement was demanded"), this is pure table hygiene.
 *
 *  6. AUTO-TRIAGE — opt-in (`GlobalFaceVerificationSettings.autoTriageHonestFailures`). Clears
 *     review flags on attempts whose evidence says "honest failure" (see
 *     `autoTriageHonestFailures` in face.service.ts for exactly what qualifies — it never touches
 *     anything carrying a virtual-camera or provenance signal). The same routine is reachable
 *     on demand via `POST /face/auto-triage` for an admin who doesn't want to wait for 03:15.
 *
 * WHO calls this: server.ts at boot, alongside every other cron worker.
 */
import fsp from "node:fs/promises";
import cron from "node-cron";
import { prisma } from "../config/prisma.js";
import { requireTenantContext } from "../config/tenant-context.js";
import {
  autoTriageHonestFailures,
  findCoveredUnenrolledUserIds,
  getFaceSettings,
  isFaceFeatureAllowedForOrg,
  notifyEnrollmentRequired,
  removeUserFaceDirectories
} from "../services/face.service.js";
import { dispatchNotification } from "../services/notify.service.js";
import { templates } from "../services/mail-templates.js";
import { runForEveryOrg } from "./run-for-every-org.js";

let started = false;
let running = false;

/** How many rows to purge per pass. Bounded so one org with a huge backlog can't hold the
 *  tenant loop open for minutes — the next daily run picks up whatever is left. */
const BATCH_SIZE = 500;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Days of grace between losing the plan entitlement and purging stored biometric data. */
export const ENTITLEMENT_GRACE_DAYS = 30;

/** Flagged-and-unreviewed age that earns admins an overdue notification. */
const REVIEW_OVERDUE_HOURS = 48;

export async function purgeExpiredFaceImages(): Promise<{ purged: number }> {
  const settings = await getFaceSettings();

  // retentionDays 0 means "store nothing" — but images may exist from BEFORE the setting was
  // lowered to 0, and "don't store" surely implies "don't keep", so purge everything stored.
  // Otherwise purge what's older than the window. Deliberately NOT gated on settings.enabled:
  // disabling the feature doesn't make yesterday's captures less biometric.
  const cutoff =
    settings.imageRetentionDays <= 0 ? new Date() : new Date(Date.now() - settings.imageRetentionDays * DAY_MS);

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

/** Stage 2 — see the header. Exported for the verification script. */
export async function sweepEntitlement(): Promise<{ state: "ok" | "grace-started" | "grace-running" | "purged" }> {
  const settings = await getFaceSettings();
  const allowed = await isFaceFeatureAllowedForOrg();

  if (allowed) {
    // Entitlement restored (re-upgrade) — clear the clock, keep everything.
    if (settings.entitlementLostAt) {
      await prisma.globalFaceVerificationSettings.update({ where: { id: settings.id }, data: { entitlementLostAt: null } });
    }
    return { state: "ok" };
  }

  // Nothing enrolled and feature off → nothing worth tracking a grace window for.
  const enrollmentCount = await prisma.faceEnrollment.count();
  if (!settings.enabled && enrollmentCount === 0) return { state: "ok" };

  if (!settings.entitlementLostAt) {
    await prisma.globalFaceVerificationSettings.update({ where: { id: settings.id }, data: { entitlementLostAt: new Date() } });
    await notifyAdminsEntitlementLost();
    return { state: "grace-started" };
  }

  const graceEndsAt = settings.entitlementLostAt.getTime() + ENTITLEMENT_GRACE_DAYS * DAY_MS;
  if (Date.now() < graceEndsAt) return { state: "grace-running" };

  // Grace expired: purge templates, captures, and switch the feature off. Attempt rows stay
  // (their images are nulled) — they're the non-biometric audit trail.
  const enrollments = await prisma.faceEnrollment.findMany({ select: { userId: true } });
  await prisma.faceEnrollment.deleteMany({});
  await prisma.faceVerificationAttempt.updateMany({
    where: { imagePath: { not: null } },
    data: { imagePath: null, purgedAt: new Date() }
  });
  for (const enrollment of enrollments) {
    await removeUserFaceDirectories(enrollment.userId);
  }
  await prisma.globalFaceVerificationSettings.update({
    where: { id: settings.id },
    data: { enabled: false, entitlementLostAt: null }
  });
  console.log(
    `[face-retention] ${requireTenantContext().orgSlug}: entitlement grace expired — purged ${enrollments.length} enrollment(s) and disabled the feature`
  );
  return { state: "purged" };
}

async function notifyAdminsEntitlementLost(): Promise<void> {
  const admins = await prisma.user.findMany({
    where: { role: { name: { in: ["SUPER_ADMIN", "ADMIN"] } }, status: "ACTIVE", deletedAt: null },
    select: { id: true, name: true }
  });
  for (const admin of admins) {
    await dispatchNotification({
      userId: admin.id,
      category: "face.entitlement_lost",
      title: "Face verification lost its plan entitlement",
      body: `This workspace's plan no longer includes face verification. Enforcement has stopped; stored face data will be purged in ${ENTITLEMENT_GRACE_DAYS} days unless the plan is upgraded.`,
      link: "/app/settings",
      email: {
        templateKey: "face.entitlement_lost",
        vars: { targetName: admin.name, graceDays: ENTITLEMENT_GRACE_DAYS },
        fallback: {
          subject: "Face verification is no longer in your plan",
          html: templates.faceEntitlementLost({ targetName: admin.name, graceDays: ENTITLEMENT_GRACE_DAYS })
        }
      }
    });
  }
}

/** Stage 4 — overdue flagged reviews, deduped to one nudge per admin per 24h. */
async function sweepOverdueReviews(): Promise<void> {
  const oldest = await prisma.faceVerificationAttempt.findFirst({
    where: { flaggedForReview: true, createdAt: { lt: new Date(Date.now() - REVIEW_OVERDUE_HOURS * HOUR_MS) } },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true }
  });
  if (!oldest) return;

  const pendingCount = await prisma.faceVerificationAttempt.count({
    where: { flaggedForReview: true, createdAt: { lt: new Date(Date.now() - REVIEW_OVERDUE_HOURS * HOUR_MS) } }
  });
  const oldestAgeHours = Math.round((Date.now() - oldest.createdAt.getTime()) / HOUR_MS);

  const admins = await prisma.user.findMany({
    where: { role: { name: { in: ["SUPER_ADMIN", "ADMIN"] } }, status: "ACTIVE", deletedAt: null },
    select: { id: true, name: true }
  });
  const dedupeSince = new Date(Date.now() - 24 * HOUR_MS);

  for (const admin of admins) {
    const recentNudge = await prisma.notification.findFirst({
      where: { userId: admin.id, category: "face.review_overdue", createdAt: { gte: dedupeSince } },
      select: { id: true }
    });
    if (recentNudge) continue;

    await dispatchNotification({
      userId: admin.id,
      category: "face.review_overdue",
      title: "Flagged identity checks awaiting review",
      body: `${pendingCount} flagged identity ${pendingCount === 1 ? "attempt has" : "attempts have"} been waiting over ${REVIEW_OVERDUE_HOURS}h (oldest ~${oldestAgeHours}h).`,
      link: "/app/settings",
      email: {
        templateKey: "face.review_overdue",
        vars: { targetName: admin.name, pendingCount, oldestAgeHours },
        fallback: {
          subject: "Flagged identity checks awaiting review",
          html: templates.faceReviewOverdue({ targetName: admin.name, pendingCount, oldestAgeHours })
        }
      }
    });
  }
}

/** One org's complete daily sweep — exported so the verification script can drive it directly. */
export async function runFaceLifecycleSweep(): Promise<void> {
  const { purged } = await purgeExpiredFaceImages();
  if (purged > 0) {
    console.log(`[face-retention] ${requireTenantContext().orgSlug}: purged ${purged} expired face capture(s)`);
  }

  const entitlement = await sweepEntitlement();

  // Reminders and review nudges only make sense while the feature is actually usable.
  if (entitlement.state === "ok") {
    const settings = await getFaceSettings();
    if (settings.enabled) {
      // Only remind people who became covered at least 48h ago... approximated by the dedupe
      // window inside notifyEnrollmentRequired (72h) — the first notification went out when
      // they became covered (settings PATCH / user PATCH), so the worker's copy IS the
      // follow-up reminder.
      const covered = await findCoveredUnenrolledUserIds();
      await notifyEnrollmentRequired(covered, "face.enrollment_reminder");
      await sweepOverdueReviews();

      // Stage 6 — opt-in only; see the header for exactly what this does and doesn't touch.
      if (settings.autoTriageHonestFailures) {
        const { resolved } = await autoTriageHonestFailures();
        if (resolved > 0) {
          console.log(`[face-retention] ${requireTenantContext().orgSlug}: auto-triaged ${resolved} honest failure(s)`);
        }
      }
    }
  }

  // Stage 5 — expired challenges (no biometric content; plain hygiene).
  await prisma.faceChallenge.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - DAY_MS) } } });
}

export function startFaceRetentionWorker(): void {
  if (started) return;
  started = true;

  cron.schedule("15 3 * * *", async () => {
    if (running) return;
    running = true;
    try {
      await runForEveryOrg("face-retention", runFaceLifecycleSweep);
    } catch (error) {
      console.error("[face-retention] sweep failed:", (error as Error).message);
    } finally {
      running = false;
    }
  });
}
