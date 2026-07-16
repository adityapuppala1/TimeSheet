/**
 * AI weekly security digest worker — fires Monday 08:30 server-local time (30 minutes after the
 * per-user weekly-digest worker, so the two Monday-morning emails don't compete for the same AI
 * budget window). Generalizes weekly-digest.worker.ts's pattern to an admin audience: one
 * org-wide security-posture recap sent to every ADMIN/SUPER_ADMIN, not a per-user recap.
 * WHY skip a week with nothing to report: same reasoning weekly-digest.worker.ts gives for
 * skipping zero-activity users — an AI-authored "nothing happened" email erodes trust in the
 * feature; silence is the correct behavior for a quiet week.
 */
import cron from "node-cron";
import { prisma } from "../config/prisma.js";
import { generateSecurityWeeklyDigest, getGlobalAISettings } from "../services/ai.service.js";
import { templates } from "../services/mail-templates.js";
import { dispatchNotification } from "../services/notify.service.js";
import { runForEveryOrg } from "./run-for-every-org.js";

let started = false;
let running = false;

const DAY_MS = 24 * 60 * 60 * 1000;
const OPEN_STATUSES = ["OPEN", "ACKNOWLEDGED"] as const;

function startOfLocalDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Monday 00:00 local time of the week containing `date`. */
function startOfWeekLocal(date: Date): Date {
  const d = startOfLocalDay(date);
  const day = d.getDay();
  const diff = (day + 6) % 7;
  d.setDate(d.getDate() - diff);
  return d;
}

/** Same weighted, age-decayed formula report.controller.ts#computeRiskScore uses — duplicated
 *  rather than imported since that one lives in an Express route module; kept in sync by hand,
 *  same trade-off this codebase already accepts for the handful of other small pure functions
 *  that appear in both a route handler and a worker. */
function computeRiskScore(openFindings: Array<{ severity: string; createdAt: Date }>, asOf: number): number {
  const WEIGHT: Record<string, number> = { CRITICAL: 10, HIGH: 5, MEDIUM: 2, LOW: 1 };
  const HALF_LIFE_MS = 30 * DAY_MS;
  return Math.round(
    openFindings.reduce((sum, f) => {
      const ageMs = Math.max(0, asOf - f.createdAt.getTime());
      const decay = Math.pow(0.5, ageMs / HALF_LIFE_MS);
      return sum + (WEIGHT[f.severity] ?? 1) * Math.max(decay, 0.25);
    }, 0)
  );
}

async function alreadySentThisRun(weekStart: Date): Promise<boolean> {
  const count = await prisma.notification.count({
    where: { category: "digest.security_weekly", createdAt: { gte: weekStart } }
  });
  return count > 0;
}

/** Runs the AI weekly security digest for the current tenant, if enabled and there's something
 *  worth reporting. Returns whether it actually sent, for the caller's log line. */
export async function runSecurityWeeklyDigest(now: Date = new Date()): Promise<{ sent: boolean; reason?: string }> {
  const aiSettings = await getGlobalAISettings();
  if (!aiSettings.aiEnabled || !aiSettings.securityWeeklyDigestEnabled) return { sent: false, reason: "disabled" };

  const currentWeekStart = startOfWeekLocal(now);
  if (await alreadySentThisRun(currentWeekStart)) return { sent: false, reason: "already sent this week" };

  const weekStart = new Date(currentWeekStart.getTime() - 7 * DAY_MS);
  const weekEnd = currentWeekStart;
  const weekLabel = `${weekStart.toLocaleDateString(undefined, { month: "short", day: "numeric" })} - ${new Date(weekEnd.getTime() - DAY_MS).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;

  const [openFindings, newCriticalOrHigh, resolvedThisWeek, topRepos, stuckTickets] = await Promise.all([
    prisma.securityFinding.findMany({ where: { status: { in: [...OPEN_STATUSES] } }, select: { severity: true, createdAt: true } }),
    prisma.securityFinding.count({
      where: { createdAt: { gte: weekStart, lt: weekEnd }, severity: { in: ["CRITICAL", "HIGH"] } }
    }),
    prisma.securityFinding.count({ where: { status: { in: ["FIXED", "ACCEPTED_RISK"] }, updatedAt: { gte: weekStart, lt: weekEnd } } }),
    prisma.securityFinding.groupBy({
      by: ["repository"],
      where: { status: { in: [...OPEN_STATUSES] }, repository: { not: null } },
      _count: true,
      orderBy: { _count: { repository: "desc" } },
      take: 5
    }),
    prisma.ticket.count({
      where: {
        deletedAt: null,
        status: { notIn: ["RESOLVED", "CLOSED"] },
        dueAt: { lt: now },
        securityFindings: { some: {} }
      }
    })
  ]);

  if (openFindings.length === 0 && newCriticalOrHigh === 0 && resolvedThisWeek === 0) {
    return { sent: false, reason: "nothing to report" };
  }

  const riskScore = computeRiskScore(openFindings, now.getTime());
  const riskScoreLastWeek = computeRiskScore(
    openFindings.filter((f) => f.createdAt < weekStart),
    weekStart.getTime()
  );

  const admins = await prisma.user.findMany({
    where: { status: "ACTIVE", deletedAt: null, role: { name: { in: ["ADMIN", "SUPER_ADMIN"] } } },
    select: { id: true, email: true }
  });
  if (admins.length === 0) return { sent: false, reason: "no admins" };

  let summary: string;
  try {
    const result = await generateSecurityWeeklyDigest({
      weekLabel,
      openFindings: openFindings.length,
      newCriticalOrHigh,
      resolvedThisWeek,
      riskScore,
      riskScoreLastWeek,
      ticketsStuckPastSla: stuckTickets,
      topRepositories: topRepos.map((r) => ({ repository: r.repository ?? "Unknown", count: r._count }))
    });
    summary = result.summary;
  } catch (error) {
    console.error("[security-weekly-digest] AI generation failed:", (error as Error).message);
    return { sent: false, reason: "AI generation failed" };
  }
  if (!summary) return { sent: false, reason: "empty summary" };

  for (const admin of admins) {
    await dispatchNotification({
      userId: admin.id,
      category: "digest.security_weekly",
      title: `Security digest — ${weekLabel}`,
      body: summary,
      link: "/app/security-insights",
      email: {
        templateKey: "digest.security_weekly",
        vars: { weekLabel, summary, riskScore },
        fallback: {
          subject: `Security digest — week of ${weekLabel}`,
          html: templates.securityWeeklyDigest({ weekLabel, summary, riskScore })
        }
      }
    });
  }

  return { sent: true };
}

export function startSecurityWeeklyDigestWorker() {
  if (started) return;
  started = true;

  // Monday 08:30 server-local time — 30 minutes after the per-user weekly digest.
  cron.schedule("30 8 * * 1", () => {
    if (running) return;
    running = true;
    runForEveryOrg("security-weekly-digest", async () => {
      const result = await runSecurityWeeklyDigest();
      if (result.sent) console.info("[security-weekly-digest] sent.");
    })
      .catch((error) => console.error("[security-weekly-digest] run failed:", (error as Error).message))
      .finally(() => {
        running = false;
      });
  });

  console.info("[security-weekly-digest] worker scheduled (Monday 08:30).");
}
