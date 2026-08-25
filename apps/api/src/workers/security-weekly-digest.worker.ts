/**
 * AI weekly security digest worker — fires Monday 10:30 server-local time (30 minutes after the
 * per-user weekly-digest worker, so the two Monday-morning emails don't compete for the same AI
 * budget window; both moved from 08:00/08:30 on request). Generalizes weekly-digest.worker.ts's pattern to an admin audience: one
 * org-wide security-posture recap sent to every ADMIN/SUPER_ADMIN, not a per-user recap.
 * WHY skip a week with nothing to report: same reasoning weekly-digest.worker.ts gives for
 * skipping zero-activity users — an AI-authored "nothing happened" email erodes trust in the
 * feature; silence is the correct behavior for a quiet week.
 *
 * ── THE FIGURES SEND WHETHER OR NOT A MODEL ANSWERS ──────────────────────────────────────────
 *
 * This worker used to `return { sent: false }` when `generateSecurityWeeklyDigest` threw or came
 * back empty — so an unconfigured, slow, or too-small model meant the security digest did not go
 * out AT ALL. Not a degraded digest: no open-finding count, no risk score, no SLA breaches,
 * nothing. weekly-digest.worker.ts's header already describes making exactly this correction for
 * the per-user digest ("a weekly report that a manager plans around had the availability of an
 * LLM"); the security one kept the flaw, on the report where a silent week is most expensive.
 *
 * Now the counts come from this workspace's own records and always send. The summary is a
 * garnish on top of them, and its absence costs a paragraph rather than the report.
 */
import cron from "node-cron";
import { prisma } from "../config/prisma.js";
import { generateSecurityWeeklyDigest, getGlobalAISettings } from "../services/ai.service.js";
import { emailBlocks, templates } from "../services/mail-templates.js";
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

  // The opening paragraph, when a model can write one. A failure is logged and the digest goes
  // anyway — the table below IS the report. See the header.
  let summary = "";
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
    summary = result.summary ?? "";
  } catch (error) {
    console.warn("[security-weekly-digest] no AI summary (sending the figures anyway):", (error as Error).message);
  }

  const tablesHtml = buildSecurityTables({
    weekLabel,
    openFindings,
    newCriticalOrHigh,
    resolvedThisWeek,
    riskScore,
    riskScoreLastWeek,
    stuckTickets,
    topRepos
  });

  // What the in-app row says when there is no model sentence: the headline numbers, not an empty
  // title. Same rule the per-user digest follows.
  const fallbackBody =
    `${openFindings.length} open finding${openFindings.length === 1 ? "" : "s"}, ` +
    `${newCriticalOrHigh} new critical/high, ${resolvedThisWeek} resolved, risk score ${riskScore}.`;

  for (const admin of admins) {
    await dispatchNotification({
      userId: admin.id,
      category: "digest.security_weekly",
      title: `Security digest — ${weekLabel}`,
      body: summary || fallbackBody,
      link: "/app/security-insights",
      email: {
        templateKey: "digest.security_weekly",
        vars: { weekLabel, summary, riskScore, tablesHtml },
        fallback: {
          subject: `Security digest — week of ${weekLabel}`,
          html: templates.securityWeeklyDigest({ weekLabel, summary, riskScore, tablesHtml })
        }
      }
    });
  }

  return { sent: true };
}

/**
 * The counted half of the security digest — severity mix, week-over-week movement, and the
 * repositories carrying the most open findings.
 *
 * Every figure is read from `SecurityFinding` rows, so this renders identically whether or not a
 * model was available. Deltas are shown with an explicit sign because "12" and "+12" answer
 * different questions, and a security report that makes the reader work out the direction is doing
 * the opposite of its job.
 */
function buildSecurityTables(input: {
  weekLabel: string;
  openFindings: Array<{ severity: string; createdAt: Date }>;
  newCriticalOrHigh: number;
  resolvedThisWeek: number;
  riskScore: number;
  riskScoreLastWeek: number;
  stuckTickets: number;
  topRepos: Array<{ repository: string | null; _count: number }>;
}): string {
  const { dataTable, periodStrip, escape } = emailBlocks;

  const bySeverity = new Map<string, number>();
  for (const f of input.openFindings) bySeverity.set(f.severity, (bySeverity.get(f.severity) ?? 0) + 1);
  // Fixed order, highest first — a severity table sorted by count buries CRITICAL under LOW.
  const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];

  const riskDelta = input.riskScore - input.riskScoreLastWeek;
  const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
  // Rising risk is the bad direction, so it is the one that gets colour.
  const riskSub = riskDelta === 0 ? "unchanged on last week" : `${signed(riskDelta)} on last week`;

  return (
    periodStrip([
      { label: "Open findings", value: String(input.openFindings.length), sub: `${input.resolvedThisWeek} resolved last week` },
      { label: "Risk score", value: String(input.riskScore), sub: riskSub },
      { label: "New critical / high", value: String(input.newCriticalOrHigh), sub: input.newCriticalOrHigh === 0 ? "none last week" : "raised last week" }
    ]) +
    dataTable({
      caption: "Open findings by severity",
      head: ["Severity", "Open now"],
      rows: SEVERITIES.filter((sev) => (bySeverity.get(sev) ?? 0) > 0).map((sev) => [escape(sev), String(bySeverity.get(sev) ?? 0)]),
      empty: "No open findings."
    }) +
    dataTable({
      caption: `Movement — ${escape(input.weekLabel)}`,
      head: ["", "Count"],
      rows: [
        ["New critical or high", String(input.newCriticalOrHigh)],
        ["Resolved", String(input.resolvedThisWeek)],
        ["Risk score change", signed(riskDelta)],
        // Named for what it is. "Stuck" is a judgement; "past its SLA" is a fact about a clock.
        ["Security tickets past their SLA", String(input.stuckTickets)]
      ]
    }) +
    dataTable({
      caption: "Repositories with the most open findings",
      head: ["Repository", "Open findings"],
      rows: input.topRepos.map((r) => [escape(r.repository ?? "Unattributed"), String(r._count)]),
      empty: "No findings are attributed to a repository."
    }) +
    `<div style="font-size:11px;color:#64748B;margin:-2px 0 4px;">Counts are open findings as of this morning; movement covers last week only. Risk score is computed in security-report.service.ts and weights severity by age.</div>`
  );
}

export function startSecurityWeeklyDigestWorker() {
  if (started) return;
  started = true;

  // Monday 08:30 server-local time — 30 minutes after the per-user weekly digest.
  cron.schedule("30 10 * * 1", () => {
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
