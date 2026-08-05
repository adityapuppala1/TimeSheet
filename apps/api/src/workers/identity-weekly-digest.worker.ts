/**
 * Weekly identity-assurance digest — fires Monday 08:45 server-local time (15 minutes after the
 * security digest so the Monday-morning admin emails arrive as a readable sequence, not a
 * pile). One org-wide recap of last week's face-verification activity sent to every
 * ADMIN/SUPER_ADMIN.
 *
 * Deliberately NOT AI-generated, unlike the security digest it otherwise mirrors: everything in
 * it is threshold arithmetic over attempt rows (counts, failure streaks, signal totals), so a
 * deterministic template is always correct, always free, and can't hallucinate an accusation
 * into an email about named employees — which matters more here than anywhere else in the app.
 *
 * Skips quietly when the feature is off, the plan doesn't include it, or the week had no
 * attempts: a "nothing happened" email erodes trust in the digest.
 */
import cron from "node-cron";
import { prisma } from "../config/prisma.js";
import { getFaceSettings, isFaceFeatureAllowedForOrg } from "../services/face.service.js";
import { templates } from "../services/mail-templates.js";
import { dispatchNotification } from "../services/notify.service.js";
import { runForEveryOrg } from "./run-for-every-org.js";

let started = false;
let running = false;

function startOfLocalDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Monday 00:00 local time of the week containing `date`. */
function startOfWeekLocal(date: Date): Date {
  const d = startOfLocalDay(date);
  const diff = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - diff);
  return d;
}

/** One digest per org per week, even across restarts — same Notification-table dedupe the other
 *  digest workers use (the notification row IS the "already sent" marker). */
async function alreadySentThisWeek(weekStart: Date): Promise<boolean> {
  const count = await prisma.notification.count({
    where: { category: "digest.identity_weekly", createdAt: { gte: weekStart } }
  });
  return count > 0;
}

export async function runIdentityWeeklyDigest(now = new Date()): Promise<{ sent: number }> {
  const settings = await getFaceSettings();
  if (!settings.enabled) return { sent: 0 };
  if (!(await isFaceFeatureAllowedForOrg())) return { sent: 0 };

  const thisWeekStart = startOfWeekLocal(now);
  const lastWeekStart = new Date(thisWeekStart.getTime() - 7 * 24 * 60 * 60 * 1000);
  if (await alreadySentThisWeek(thisWeekStart)) return { sent: 0 };

  const attempts = await prisma.faceVerificationAttempt.findMany({
    where: { createdAt: { gte: lastWeekStart, lt: thisWeekStart } },
    select: { userId: true, outcome: true, virtualCameraSuspected: true, unfamiliarNetwork: true }
  });
  if (attempts.length === 0) return { sent: 0 };

  const passed = attempts.filter((a) => a.outcome === "PASSED").length;
  const failed = attempts.length - passed;
  const flaggedPending = await prisma.faceVerificationAttempt.count({ where: { flaggedForReview: true } });

  const failuresByUser = new Map<string, number>();
  for (const attempt of attempts) {
    if (attempt.outcome !== "PASSED") failuresByUser.set(attempt.userId, (failuresByUser.get(attempt.userId) ?? 0) + 1);
  }
  const repeatFailers = [...failuresByUser.values()].filter((n) => n >= 3).length;
  const virtualCamera = attempts.filter((a) => a.virtualCameraSuspected).length;
  const unfamiliar = attempts.filter((a) => a.unfamiliarNetwork).length;

  const noteParts: string[] = [];
  if (repeatFailers > 0) noteParts.push(`${repeatFailers} ${repeatFailers === 1 ? "person" : "people"} failed 3+ times`);
  if (virtualCamera > 0) noteParts.push(`${virtualCamera} attempt(s) via a suspected virtual camera`);
  if (unfamiliar > 0) noteParts.push(`${unfamiliar} attempt(s) from an unfamiliar network`);
  const notes = noteParts.length > 0 ? `Worth a look: ${noteParts.join("; ")}.` : "";

  const weekLabel = lastWeekStart.toISOString().slice(0, 10);
  const admins = await prisma.user.findMany({
    where: { role: { name: { in: ["SUPER_ADMIN", "ADMIN"] } }, status: "ACTIVE", deletedAt: null },
    select: { id: true, name: true }
  });

  let sent = 0;
  for (const admin of admins) {
    await dispatchNotification({
      userId: admin.id,
      category: "digest.identity_weekly",
      title: `Identity assurance — week of ${weekLabel}`,
      body: `${attempts.length} checks: ${passed} passed, ${failed} failed. ${flaggedPending} flagged awaiting review.${notes ? ` ${notes}` : ""}`,
      link: "/app/settings",
      email: {
        templateKey: "digest.identity_weekly",
        vars: { targetName: admin.name, weekLabel, total: attempts.length, passed, failed, flaggedPending, notes },
        fallback: {
          subject: `Identity assurance — week of ${weekLabel}`,
          html: templates.identityWeeklyDigest({ targetName: admin.name, weekLabel, total: attempts.length, passed, failed, flaggedPending, notes })
        }
      }
    });
    sent++;
  }
  return { sent };
}

export function startIdentityWeeklyDigestWorker(): void {
  if (started) return;
  started = true;

  cron.schedule("45 8 * * 1", async () => {
    if (running) return;
    running = true;
    try {
      await runForEveryOrg("identity-weekly-digest", async () => {
        await runIdentityWeeklyDigest();
      });
    } catch (error) {
      console.error("[identity-weekly-digest] failed:", (error as Error).message);
    } finally {
      running = false;
    }
  });
}
