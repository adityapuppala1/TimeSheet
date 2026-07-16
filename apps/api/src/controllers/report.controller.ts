/**
 * Reporting & analytics endpoints. Two tiers: personal (`/employee-summary`, `/daily-status`,
 * no permission gate beyond auth — a user's own numbers) and workspace-wide (`/admin-summary`,
 * `/ticket-summary`, `/ticket-insights`, `/cost-insights`, `/leaderboard`, all gated
 * `REPORTS_VIEW`). `/cost-insights` and `/leaderboard` additionally 403 unless their own
 * GlobalTicketSettings toggle is on — they're opt-in because they touch compensation-adjacent
 * data (hourly rates) or individual rankings.
 *
 * WHY reopen rate is computed from AuditLog rather than Ticket.resolvedAt: reopening a ticket
 * clears resolvedAt back to null (see ticket.controller.ts's status-update handler), so the
 * audit trail (`action: "ticket.status_changed"`) is the only durable record of "was this ever
 * resolved, and was it later reopened."
 */
import { Router } from "express";
import PDFDocument from "pdfkit";
import { permissions } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import { htmlToText } from "../utils/sanitize.js";
import { generateStatusReport } from "../services/ai.service.js";

export const reportRouter = Router();
reportRouter.use(requireAuth);

function todayUtcDate(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

function startOfLocalDay(date = new Date()): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

reportRouter.get("/employee-summary", async (req, res) => {
  const rows = await prisma.timesheet.groupBy({
    by: ["status", "activityType"],
    where: { userId: req.user!.id, deletedAt: null },
    _sum: { totalHours: true },
    _count: true
  });
  res.json(rows);
});

/**
 * Personal daily status: hours logged today + whether a reminder/escalation
 * has been raised against the calling user. Used by the dashboard hero card.
 */
reportRouter.get("/daily-status", async (req, res) => {
  const today = todayUtcDate();
  const sinceLocal = startOfLocalDay();
  const [aggregate, reminded, escalated] = await Promise.all([
    prisma.timesheet.aggregate({
      where: { userId: req.user!.id, workDate: today, deletedAt: null },
      _sum: { totalHours: true },
      _count: true
    }),
    prisma.notification.count({
      where: { userId: req.user!.id, category: "reminder.daily", createdAt: { gte: sinceLocal } }
    }),
    prisma.notification.count({
      where: { userId: req.user!.id, category: "reminder.escalation", createdAt: { gte: sinceLocal } }
    })
  ]);
  res.json({
    date: today.toISOString().slice(0, 10),
    entries: aggregate._count,
    hours: Number(aggregate._sum.totalHours ?? 0),
    reminderReceived: reminded > 0,
    escalated: escalated > 0
  });
});

reportRouter.get("/admin-summary", requirePermission(permissions.REPORTS_VIEW), async (_req, res) => {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const today = todayUtcDate();
  const yesterday = new Date(today);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yearStart = new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
  const sinceLocal = startOfLocalDay();

  const sinceYesterdayLocal = new Date(sinceLocal);
  sinceYesterdayLocal.setDate(sinceYesterdayLocal.getDate() - 1);

  const [
    users,
    usersYesterday,
    activeWorkforce,
    projects,
    projectsYesterday,
    approved,
    approvedYesterday,
    pending,
    pendingYesterday,
    slaBreached,
    slaBreachedYesterday,
    openEscalations,
    openEscalationsYesterday,
    approvedThisWeek,
    approvedLastWeek,
    loggedTodayDistinct,
    loggedYesterdayDistinct,
    todayDailyRemindersSent,
    todayDailyRemindersSentYesterday,
    todayEscalationsSent,
    todayEscalationsSentYesterday,
    ytdEntries,
    byProject,
    byStatus,
    byActivity
  ] = await Promise.all([
    prisma.user.count({ where: { deletedAt: null } }),
    prisma.user.count({ where: { deletedAt: null, createdAt: { lt: sinceLocal } } }),
    prisma.user.count({
      where: { deletedAt: null, status: "ACTIVE", role: { name: { in: ["EMPLOYEE", "TEAM_LEAD"] } } }
    }),
    prisma.project.count({ where: { deletedAt: null } }),
    prisma.project.count({ where: { deletedAt: null, createdAt: { lt: sinceLocal } } }),
    prisma.timesheet.aggregate({ where: { status: "APPROVED", deletedAt: null }, _sum: { totalHours: true } }),
    prisma.timesheet.aggregate({
      where: { status: "APPROVED", deletedAt: null, reviewedAt: { lt: sinceLocal } },
      _sum: { totalHours: true }
    }),
    prisma.timesheet.count({ where: { status: "SUBMITTED", deletedAt: null } }),
    prisma.timesheet.count({ where: { status: "SUBMITTED", deletedAt: null, createdAt: { lt: sinceLocal } } }),
    prisma.timesheet.count({ where: { slaBreachAt: { not: null }, deletedAt: null } }),
    prisma.timesheet.count({ where: { deletedAt: null, slaBreachAt: { not: null, lt: sinceLocal } } }),
    prisma.escalation.count({ where: { resolvedAt: null } }),
    prisma.escalation.count({ where: { resolvedAt: null, createdAt: { lt: sinceLocal } } }),
    prisma.timesheet.count({ where: { status: "APPROVED", reviewedAt: { gte: weekAgo }, deletedAt: null } }),
    prisma.timesheet.count({
      where: { status: "APPROVED", reviewedAt: { gte: new Date(weekAgo.getTime() - WEEK_MS), lt: weekAgo }, deletedAt: null }
    }),
    prisma.timesheet.findMany({
      where: { workDate: today, deletedAt: null },
      select: { userId: true },
      distinct: ["userId"]
    }),
    prisma.timesheet.findMany({
      where: { workDate: yesterday, deletedAt: null },
      select: { userId: true },
      distinct: ["userId"]
    }),
    prisma.notification.count({
      where: { category: "reminder.daily", createdAt: { gte: sinceLocal } }
    }),
    prisma.notification.count({
      where: { category: "reminder.daily", createdAt: { gte: sinceYesterdayLocal, lt: sinceLocal } }
    }),
    prisma.notification.count({
      where: { category: "reminder.escalation", createdAt: { gte: sinceLocal } }
    }),
    prisma.notification.count({
      where: { category: "reminder.escalation", createdAt: { gte: sinceYesterdayLocal, lt: sinceLocal } }
    }),
    // Year-to-date average — the baseline "today vs typical day" is measured against, not just
    // yesterday (a single prior day is noisy; e.g. a Monday after a weekend always looks like a
    // spike vs Sunday). Counts distinct (user, workDate) pairs so a person logging 3 entries in
    // one day still counts once toward "a day someone filled something," same definition as
    // loggedToday/loggedYesterday above.
    prisma.timesheet.findMany({
      where: { workDate: { gte: yearStart, lt: today }, deletedAt: null },
      select: { userId: true, workDate: true },
      distinct: ["userId", "workDate"]
    }),
    prisma.timesheet.groupBy({ by: ["projectId"], where: { deletedAt: null }, _sum: { totalHours: true }, _count: true }),
    prisma.timesheet.groupBy({ by: ["status"], where: { deletedAt: null }, _sum: { totalHours: true }, _count: true }),
    prisma.timesheet.groupBy({ by: ["activityType"], where: { deletedAt: null }, _sum: { totalHours: true }, _count: true })
  ]);

  const projectNames = await prisma.project.findMany({
    where: { id: { in: byProject.map((row) => row.projectId) } },
    select: { id: true, name: true }
  });

  const loggedToday = loggedTodayDistinct.length;
  const notLoggedToday = Math.max(0, activeWorkforce - loggedToday);
  const loggedYesterday = loggedYesterdayDistinct.length;

  // Days actually elapsed this year up to (not including) today, floored at 1 to avoid a
  // divide-by-zero on Jan 1st when there's no prior YTD data yet.
  const ytdDaysElapsed = Math.max(1, Math.round((today.getTime() - yearStart.getTime()) / 86_400_000));
  const ytdAvgLoggedPerDay = ytdEntries.length / ytdDaysElapsed;

  res.json({
    users,
    usersYesterday,
    projects,
    projectsYesterday,
    approvedHours: approved._sum.totalHours ?? 0,
    approvedHoursYesterday: approvedYesterday._sum.totalHours ?? 0,
    pendingApprovals: pending,
    pendingApprovalsYesterday: pendingYesterday,
    slaBreached,
    slaBreachedYesterday,
    openEscalations,
    openEscalationsYesterday,
    approvedThisWeek,
    approvedLastWeek,
    activeWorkforce,
    loggedToday,
    notLoggedToday,
    loggedYesterday,
    ytdAvgLoggedPerDay,
    todayDailyRemindersSent,
    todayDailyRemindersSentYesterday,
    todayEscalationsSent,
    todayEscalationsSentYesterday,
    byProject: byProject.map((row) => ({ ...row, project: projectNames.find((p) => p.id === row.projectId)?.name ?? "Unknown" })),
    byStatus,
    byActivity
  });
});

/**
 * Ticket metrics for the Reports page — kept separate from /admin-summary
 * (already a large batched payload) for cleaner separation of concerns.
 */
reportRouter.get("/ticket-summary", requirePermission(permissions.REPORTS_VIEW), async (_req, res) => {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const sinceLocal = startOfLocalDay();

  const [
    byStatus,
    byPriority,
    byAssignee,
    openSlaBreaches,
    openSlaBreachesYesterday,
    createdThisWeek,
    resolvedThisWeek,
    resolvedLastWeek,
    recentlyResolved,
    recentlyResolvedLastWeek
  ] = await Promise.all([
    prisma.ticket.groupBy({ by: ["status"], where: { deletedAt: null }, _count: true }),
    prisma.ticket.groupBy({ by: ["priority"], where: { deletedAt: null }, _count: true }),
    prisma.ticket.groupBy({ by: ["assigneeId"], where: { deletedAt: null, assigneeId: { not: null } }, _count: true }),
    prisma.ticket.count({ where: { deletedAt: null, slaBreachAt: { not: null }, status: { notIn: ["RESOLVED", "CLOSED"] } } }),
    prisma.ticket.count({
      where: { deletedAt: null, status: { notIn: ["RESOLVED", "CLOSED"] }, slaBreachAt: { not: null, lt: sinceLocal } }
    }),
    prisma.ticket.count({ where: { deletedAt: null, createdAt: { gte: weekAgo } } }),
    prisma.ticket.count({ where: { deletedAt: null, resolvedAt: { gte: weekAgo } } }),
    prisma.ticket.count({ where: { deletedAt: null, resolvedAt: { gte: twoWeeksAgo, lt: weekAgo } } }),
    prisma.ticket.findMany({
      where: { deletedAt: null, resolvedAt: { not: null } },
      select: { createdAt: true, resolvedAt: true },
      orderBy: { resolvedAt: "desc" },
      take: 200
    }),
    prisma.ticket.findMany({
      where: { deletedAt: null, resolvedAt: { gte: twoWeeksAgo, lt: weekAgo } },
      select: { createdAt: true, resolvedAt: true }
    })
  ]);

  // Prisma groupBy can't include relations, so resolve assignee names with a second query
  // — the same manual-join pattern /admin-summary uses for byProject.
  const assigneeIds = byAssignee.map((row) => row.assigneeId).filter((id): id is string => Boolean(id));
  const assignees = await prisma.user.findMany({ where: { id: { in: assigneeIds } }, select: { id: true, name: true } });

  // Prisma has no native duration aggregate, so average resolution time is reduced in-app.
  const avgResolutionHours =
    recentlyResolved.length > 0
      ? recentlyResolved.reduce(
          (sum, t) => sum + (t.resolvedAt!.getTime() - t.createdAt.getTime()) / (1000 * 60 * 60),
          0
        ) / recentlyResolved.length
      : 0;
  const avgResolutionHoursLastWeek =
    recentlyResolvedLastWeek.length > 0
      ? recentlyResolvedLastWeek.reduce(
          (sum, t) => sum + (t.resolvedAt!.getTime() - t.createdAt.getTime()) / (1000 * 60 * 60),
          0
        ) / recentlyResolvedLastWeek.length
      : 0;

  res.json({
    total: byStatus.reduce((sum, row) => sum + row._count, 0),
    byStatus,
    byPriority,
    byAssignee: byAssignee.map((row) => ({
      ...row,
      assignee: assignees.find((a) => a.id === row.assigneeId)?.name ?? "Unknown"
    })),
    openSlaBreaches,
    openSlaBreachesYesterday,
    createdThisWeek,
    resolvedThisWeek,
    resolvedLastWeek,
    avgResolutionHours: Number(avgResolutionHours.toFixed(1)),
    avgResolutionHoursLastWeek: Number(avgResolutionHoursLastWeek.toFixed(1))
  });
});

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Monday 00:00 UTC of the week containing `date`. */
function startOfWeekUtc(date: Date): Date {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay();
  const diff = (day + 6) % 7; // days since Monday (Sun=0 -> 6)
  d.setUTCDate(d.getUTCDate() - diff);
  return d;
}

/** `count` Monday-anchored week-start boundaries, oldest first, ending with the current week. */
function recentWeekStarts(count: number): Date[] {
  const current = startOfWeekUtc(new Date());
  return Array.from({ length: count }, (_, i) => new Date(current.getTime() - (count - 1 - i) * WEEK_MS));
}

/** Which bucket (by index into `weekStarts`) a date falls into, or -1 if before the first week. */
function weekIndexFor(date: Date, weekStarts: Date[]): number {
  for (let i = weekStarts.length - 1; i >= 0; i--) {
    if (date.getTime() >= weekStarts[i].getTime()) return i;
  }
  return -1;
}

const CYCLE_TIME_BUCKETS = [
  { label: "< 4h", maxHours: 4 },
  { label: "4-24h", maxHours: 24 },
  { label: "1-3d", maxHours: 72 },
  { label: "3-7d", maxHours: 168 },
  { label: "7-14d", maxHours: 336 },
  { label: "14d+", maxHours: Infinity }
];

/**
 * Bundled ticket analytics for the Insights page — velocity, SLA compliance, cycle time
 * distribution, module hotspots, reopen rate, first-response time, per-assignee workload,
 * and estimate-vs-actual variance. Kept as one batched call (Promise.all), same style as
 * /admin-summary and /ticket-summary, since the Insights page loads all of it together.
 */
reportRouter.get("/ticket-insights", requirePermission(permissions.REPORTS_VIEW), async (_req, res) => {
  const velocityWeeks = recentWeekStarts(8);
  const heatmapWeeks = recentWeekStarts(6);
  const rangeStart = velocityWeeks[0];
  const heatmapRangeStart = heatmapWeeks[0];

  const [
    createdInRange,
    resolvedInRange,
    cycleTimeSample,
    moduleGroups,
    statusChangeAudits,
    ticketsWithComments,
    assignedTickets,
    ticketsWithEstimate
  ] = await Promise.all([
    prisma.ticket.findMany({ where: { deletedAt: null, createdAt: { gte: rangeStart } }, select: { createdAt: true } }),
    prisma.ticket.findMany({
      where: { deletedAt: null, resolvedAt: { gte: rangeStart } },
      select: { resolvedAt: true, dueAt: true }
    }),
    prisma.ticket.findMany({
      where: { deletedAt: null, resolvedAt: { not: null } },
      select: { createdAt: true, resolvedAt: true },
      orderBy: { resolvedAt: "desc" },
      take: 300
    }),
    prisma.ticket.groupBy({
      by: ["moduleId"],
      where: { deletedAt: null, moduleId: { not: null } },
      _count: true,
      orderBy: { _count: { moduleId: "desc" } },
      take: 10
    }),
    prisma.auditLog.findMany({
      where: { action: "ticket.status_changed", entity: "Ticket" },
      select: { entityId: true, metadata: true }
    }),
    prisma.ticket.findMany({
      where: { deletedAt: null },
      select: { id: true, createdAt: true, comments: { orderBy: { createdAt: "asc" }, take: 1, select: { createdAt: true } } },
      take: 500
    }),
    prisma.ticket.findMany({
      where: { deletedAt: null, assigneeId: { not: null } },
      select: { assigneeId: true, createdAt: true, resolvedAt: true }
    }),
    prisma.ticket.findMany({
      where: { deletedAt: null, estimatedHours: { not: null } },
      select: { id: true, key: true, title: true, estimatedHours: true }
    })
  ]);

  // --- Velocity: tickets created vs resolved per week ---
  const velocity = velocityWeeks.map((weekStart) => ({
    weekStart: weekStart.toISOString().slice(0, 10),
    created: 0,
    resolved: 0
  }));
  for (const t of createdInRange) {
    const i = weekIndexFor(t.createdAt, velocityWeeks);
    if (i >= 0) velocity[i].created += 1;
  }
  for (const t of resolvedInRange) {
    const i = weekIndexFor(t.resolvedAt!, velocityWeeks);
    if (i >= 0) velocity[i].resolved += 1;
  }

  // --- SLA compliance: % of that week's resolutions that beat their due date ---
  const slaCompliance = velocityWeeks.map((weekStart) => ({
    weekStart: weekStart.toISOString().slice(0, 10),
    compliant: 0,
    breached: 0
  }));
  for (const t of resolvedInRange) {
    if (!t.dueAt) continue;
    const i = weekIndexFor(t.resolvedAt!, velocityWeeks);
    if (i < 0) continue;
    if (t.resolvedAt! <= t.dueAt) slaCompliance[i].compliant += 1;
    else slaCompliance[i].breached += 1;
  }
  const slaComplianceWithPct = slaCompliance.map((w) => ({
    ...w,
    pct: w.compliant + w.breached > 0 ? Math.round((w.compliant / (w.compliant + w.breached)) * 100) : null
  }));

  // --- Cycle time distribution ---
  const cycleTimeHistogram = CYCLE_TIME_BUCKETS.map((b) => ({ bucket: b.label, count: 0 }));
  for (const t of cycleTimeSample) {
    const hours = (t.resolvedAt!.getTime() - t.createdAt.getTime()) / (1000 * 60 * 60);
    const idx = CYCLE_TIME_BUCKETS.findIndex((b) => hours < b.maxHours);
    cycleTimeHistogram[idx === -1 ? CYCLE_TIME_BUCKETS.length - 1 : idx].count += 1;
  }

  // --- Bug hotspot by module ---
  const moduleIds = moduleGroups.map((g) => g.moduleId).filter((id): id is string => Boolean(id));
  const modules = await prisma.projectModule.findMany({
    where: { id: { in: moduleIds } },
    select: { id: true, name: true, project: { select: { name: true } } }
  });
  const hotspotByModule = moduleGroups.map((g) => {
    const mod = modules.find((m) => m.id === g.moduleId);
    return { moduleId: g.moduleId, moduleName: mod?.name ?? "Unknown", projectName: mod?.project.name ?? "Unknown", count: g._count };
  });

  // --- Reopen rate: of tickets ever resolved (per audit trail), how many were later reopened ---
  const everResolved = new Set<string>();
  const everReopened = new Set<string>();
  for (const row of statusChangeAudits) {
    const meta = row.metadata as { to?: string } | null;
    if (!row.entityId || !meta?.to) continue;
    if (meta.to === "RESOLVED") everResolved.add(row.entityId);
    if (meta.to === "REOPENED") everReopened.add(row.entityId);
  }
  const reopenRate = {
    reopenedCount: everReopened.size,
    everResolvedCount: everResolved.size,
    pct: everResolved.size > 0 ? Math.round((everReopened.size / everResolved.size) * 100) : null
  };

  // --- First-response time: createdAt -> first comment ---
  const firstResponseSamples = ticketsWithComments
    .filter((t) => t.comments.length > 0)
    .map((t) => (t.comments[0].createdAt.getTime() - t.createdAt.getTime()) / (1000 * 60 * 60));
  const firstResponseHours = {
    avgHours: firstResponseSamples.length > 0 ? Number((firstResponseSamples.reduce((s, h) => s + h, 0) / firstResponseSamples.length).toFixed(1)) : null,
    sampleSize: firstResponseSamples.length
  };

  // --- Workload heatmap: assignee x week, open-ticket count ---
  const assigneeIds = Array.from(new Set(assignedTickets.map((t) => t.assigneeId!).filter(Boolean)));
  const assigneeUsers = await prisma.user.findMany({ where: { id: { in: assigneeIds } }, select: { id: true, name: true } });
  const hoursLoggedRows = await prisma.timesheet.findMany({
    where: { deletedAt: null, userId: { in: assigneeIds }, workDate: { gte: heatmapRangeStart } },
    select: { userId: true, workDate: true, totalHours: true }
  });

  const workloadRows = assigneeIds
    .map((assigneeId) => {
      const userTickets = assignedTickets.filter((t) => t.assigneeId === assigneeId);
      const userHours = hoursLoggedRows.filter((h) => h.userId === assigneeId);
      const cells = heatmapWeeks.map((weekStart) => {
        const weekEnd = new Date(weekStart.getTime() + WEEK_MS);
        const openCount = userTickets.filter(
          (t) => t.createdAt < weekEnd && (!t.resolvedAt || t.resolvedAt >= weekEnd)
        ).length;
        const hoursLogged = userHours
          .filter((h) => h.workDate >= weekStart && h.workDate < weekEnd)
          .reduce((sum, h) => sum + Number(h.totalHours), 0);
        return { weekStart: weekStart.toISOString().slice(0, 10), openCount, hoursLogged: Number(hoursLogged.toFixed(1)) };
      });
      return {
        assigneeId,
        assigneeName: assigneeUsers.find((u) => u.id === assigneeId)?.name ?? "Unknown",
        cells,
        totalOpen: cells.reduce((s, c) => s + c.openCount, 0)
      };
    })
    .sort((a, b) => b.totalOpen - a.totalOpen)
    .slice(0, 15);

  // --- Estimate vs. actual variance ---
  const estimateTicketIds = ticketsWithEstimate.map((t) => t.id);
  const actualByTicket = await prisma.timesheet.groupBy({
    by: ["ticketId"],
    where: { deletedAt: null, ticketId: { in: estimateTicketIds } },
    _sum: { totalHours: true }
  });
  const estimateVsActual = ticketsWithEstimate
    .map((t) => {
      const actual = Number(actualByTicket.find((a) => a.ticketId === t.id)?._sum.totalHours ?? 0);
      const estimated = Number(t.estimatedHours);
      return { ticketKey: t.key, title: t.title, estimatedHours: estimated, actualHours: actual, varianceHours: Number((actual - estimated).toFixed(2)) };
    })
    .filter((row) => row.actualHours > 0)
    .sort((a, b) => Math.abs(b.varianceHours) - Math.abs(a.varianceHours))
    .slice(0, 50);

  res.json({
    velocity,
    slaCompliance: slaComplianceWithPct,
    cycleTimeHistogram,
    hotspotByModule,
    reopenRate,
    firstResponseHours,
    workloadHeatmap: { weeks: heatmapWeeks.map((w) => w.toISOString().slice(0, 10)), rows: workloadRows },
    estimateVsActual
  });
});

const SECURITY_SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;
const SECURITY_TYPES = ["SAST", "DAST", "SSAT", "SSCT", "VAPT"] as const;
const OPEN_FINDING_STATUSES = ["OPEN", "ACKNOWLEDGED"] as const;
const RESOLVED_FINDING_STATUSES = ["FIXED", "ACCEPTED_RISK"] as const;

/** Weighted, age-decayed org-wide risk score — see docs/ROADMAP.md's "Competitive parity"
 *  section (Phase 2). Deliberately simple (not trying to match Black Duck's CVSS-aware BDSA
 *  scoring): critical/high/medium/low weights roughly mirror how urgently each severity should
 *  be worked, and the age decay (halving influence every 30 days a finding stays open) means a
 *  score reflects "how much open risk right now," not a monotonically growing backlog count. */
function computeRiskScore(openFindings: Array<{ severity: (typeof SECURITY_SEVERITIES)[number]; createdAt: Date }>): number {
  const WEIGHT: Record<(typeof SECURITY_SEVERITIES)[number], number> = { CRITICAL: 10, HIGH: 5, MEDIUM: 2, LOW: 1 };
  const now = Date.now();
  const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;
  return Math.round(
    openFindings.reduce((sum, f) => {
      const ageMs = Math.max(0, now - f.createdAt.getTime());
      const decay = Math.pow(0.5, ageMs / HALF_LIFE_MS);
      return sum + WEIGHT[f.severity] * Math.max(decay, 0.25); // floor at 25% — an old CRITICAL is still worth flagging, not zeroed out
    }, 0)
  );
}

/**
 * Security & DevOps analytics — findings-over-time trend, open-by-severity/type breakdown,
 * mean-time-to-remediate, top repos by finding count, and the org-wide risk score. Powers the
 * Security insights page (Phase 2 of the "Competitive parity" roadmap section) the same way
 * /ticket-insights powers the Insights page — one batched call, everything the page needs.
 *
 * WHY "mean time to remediate" uses `updatedAt - createdAt` rather than a dedicated
 * resolvedAt-style column: SecurityFinding has no separate status-change timestamp (unlike
 * Ticket.resolvedAt) — updatedAt is bumped on any field change, so this is an approximation,
 * not an exact remediation-time measurement. Documented here rather than silently treated as
 * precise; a dedicated `resolvedAt` column is a reasonable follow-up if this proves too noisy.
 */
reportRouter.get("/security-insights", requirePermission(permissions.REPORTS_VIEW), async (_req, res) => {
  const weeks = recentWeekStarts(8);
  const rangeStart = weeks[0];
  const sinceLocal = startOfLocalDay();
  const yesterdayLocal = new Date(sinceLocal);
  yesterdayLocal.setDate(yesterdayLocal.getDate() - 1);

  const [
    openFindings,
    findingsInRange,
    resolvedFindings,
    byType,
    topRepos,
    openYesterday
  ] = await Promise.all([
    prisma.securityFinding.findMany({
      where: { status: { in: [...OPEN_FINDING_STATUSES] } },
      select: { severity: true, createdAt: true }
    }),
    prisma.securityFinding.findMany({
      where: { createdAt: { gte: rangeStart } },
      select: { createdAt: true, severity: true }
    }),
    prisma.securityFinding.findMany({
      where: { status: { in: [...RESOLVED_FINDING_STATUSES] }, updatedAt: { gte: rangeStart } },
      select: { createdAt: true, updatedAt: true }
    }),
    prisma.securityFinding.groupBy({ by: ["type"], where: { status: { in: [...OPEN_FINDING_STATUSES] } }, _count: true }),
    prisma.securityFinding.groupBy({
      by: ["repository"],
      where: { status: { in: [...OPEN_FINDING_STATUSES] }, repository: { not: null } },
      _count: true,
      orderBy: { _count: { repository: "desc" } },
      take: 10
    }),
    prisma.securityFinding.count({ where: { status: { in: [...OPEN_FINDING_STATUSES] }, createdAt: { lt: sinceLocal } } })
  ]);

  const openBySeverity = Object.fromEntries(
    SECURITY_SEVERITIES.map((s) => [s, openFindings.filter((f) => f.severity === s).length])
  ) as Record<(typeof SECURITY_SEVERITIES)[number], number>;

  const findingsOverTime = weeks.map((weekStart) => ({
    weekStart: weekStart.toISOString().slice(0, 10),
    count: findingsInRange.filter((f) => weekIndexFor(f.createdAt, weeks) === weeks.indexOf(weekStart)).length
  }));

  const meanTimeToRemediateHours =
    resolvedFindings.length > 0
      ? resolvedFindings.reduce((sum, f) => sum + (f.updatedAt.getTime() - f.createdAt.getTime()) / (1000 * 60 * 60), 0) / resolvedFindings.length
      : 0;

  const riskScore = computeRiskScore(openFindings);
  const riskScoreYesterday = computeRiskScore(openFindings.filter((f) => f.createdAt < sinceLocal));

  res.json({
    totalOpen: openFindings.length,
    totalOpenYesterday: openYesterday,
    openBySeverity,
    byType: SECURITY_TYPES.map((type) => ({ type, count: byType.find((row) => row.type === type)?._count ?? 0 })),
    findingsOverTime,
    meanTimeToRemediateHours: Number(meanTimeToRemediateHours.toFixed(1)),
    topRepositories: topRepos.map((row) => ({ repository: row.repository ?? "Unknown", count: row._count })),
    riskScore,
    riskScoreYesterday
  });
});

/**
 * SBOM dependency inventory — basic "what's in our supply chain, and is any of it known-
 * vulnerable" view, fed by ingested SPDX/CycloneDX documents (devops-webhook.controller.ts's
 * /sbom route). Deliberately not attempting Black Duck's full license-obligation-text depth —
 * see docs/ROADMAP.md's "Competitive parity" Phase 3.
 */
reportRouter.get("/sbom-inventory", requirePermission(permissions.REPORTS_VIEW), async (_req, res) => {
  const [totalComponents, vulnerableComponents, byEcosystem, byRepository] = await Promise.all([
    prisma.sbomComponent.count(),
    prisma.sbomComponent.findMany({
      where: { knownCve: { not: null } },
      select: { id: true, name: true, version: true, ecosystem: true, license: true, knownCve: true, repository: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 100
    }),
    prisma.sbomComponent.groupBy({ by: ["ecosystem"], _count: true, orderBy: { _count: { ecosystem: "desc" } }, take: 10 }),
    prisma.sbomComponent.groupBy({
      by: ["repository"],
      where: { repository: { not: null } },
      _count: true,
      orderBy: { _count: { repository: "desc" } },
      take: 10
    })
  ]);

  res.json({
    totalComponents,
    vulnerableCount: vulnerableComponents.length,
    vulnerableComponents,
    byEcosystem: byEcosystem.map((row) => ({ ecosystem: row.ecosystem ?? "Unknown", count: row._count })),
    byRepository: byRepository.map((row) => ({ repository: row.repository ?? "Unknown", count: row._count }))
  });
});

/** Opt-in cost-per-ticket analytics — gated behind GlobalTicketSettings.enableCostAnalytics (needs User.hourlyRate). */
reportRouter.get("/cost-insights", requirePermission(permissions.REPORTS_VIEW), async (_req, res) => {
  const settings = await prisma.globalTicketSettings.findUnique({ where: { id: "global" } });
  if (!settings?.enableCostAnalytics) throw new AppError(403, "Cost analytics is disabled for this workspace.");

  const timesheets = await prisma.timesheet.findMany({
    where: { deletedAt: null, ticketId: { not: null } },
    select: { ticketId: true, totalHours: true, user: { select: { hourlyRate: true } } }
  });

  const costByTicket = new Map<string, number>();
  const hoursByTicket = new Map<string, number>();
  for (const row of timesheets) {
    if (!row.ticketId) continue;
    const rate = Number(row.user.hourlyRate ?? 0);
    const hours = Number(row.totalHours);
    costByTicket.set(row.ticketId, (costByTicket.get(row.ticketId) ?? 0) + rate * hours);
    hoursByTicket.set(row.ticketId, (hoursByTicket.get(row.ticketId) ?? 0) + hours);
  }

  const ticketIds = Array.from(costByTicket.keys());
  const tickets = await prisma.ticket.findMany({ where: { id: { in: ticketIds } }, select: { id: true, key: true, title: true } });

  const rows = ticketIds
    .map((id) => ({
      ticketKey: tickets.find((t) => t.id === id)?.key ?? "?",
      title: tickets.find((t) => t.id === id)?.title ?? "",
      hours: Number((hoursByTicket.get(id) ?? 0).toFixed(2)),
      costUsd: Number((costByTicket.get(id) ?? 0).toFixed(2))
    }))
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, 25);

  const totalCostUsd = rows.reduce((sum, r) => sum + r.costUsd, 0);
  const avgCostPerTicket = rows.length > 0 ? totalCostUsd / rows.length : 0;

  res.json({ totalCostUsd: Number(totalCostUsd.toFixed(2)), avgCostPerTicket: Number(avgCostPerTicket.toFixed(2)), rows });
});

/** Opt-in team leaderboard — gated behind GlobalTicketSettings.enableLeaderboard. Framed as recognition, not surveillance. */
reportRouter.get("/leaderboard", requirePermission(permissions.REPORTS_VIEW), async (_req, res) => {
  const settings = await prisma.globalTicketSettings.findUnique({ where: { id: "global" } });
  if (!settings?.enableLeaderboard) throw new AppError(403, "The team leaderboard is disabled for this workspace.");

  const resolved = await prisma.ticket.findMany({
    where: { deletedAt: null, resolvedAt: { not: null }, assigneeId: { not: null } },
    select: { assigneeId: true, createdAt: true, resolvedAt: true }
  });

  const byAssignee = new Map<string, { resolvedCount: number; totalCycleHours: number }>();
  for (const t of resolved) {
    const entry = byAssignee.get(t.assigneeId!) ?? { resolvedCount: 0, totalCycleHours: 0 };
    entry.resolvedCount += 1;
    entry.totalCycleHours += (t.resolvedAt!.getTime() - t.createdAt.getTime()) / (1000 * 60 * 60);
    byAssignee.set(t.assigneeId!, entry);
  }

  const assigneeIds = Array.from(byAssignee.keys());
  const users = await prisma.user.findMany({ where: { id: { in: assigneeIds } }, select: { id: true, name: true } });

  const rows = assigneeIds
    .map((id) => {
      const entry = byAssignee.get(id)!;
      return {
        assigneeId: id,
        assigneeName: users.find((u) => u.id === id)?.name ?? "Unknown",
        resolvedCount: entry.resolvedCount,
        avgCycleHours: Number((entry.totalCycleHours / entry.resolvedCount).toFixed(1))
      };
    })
    .sort((a, b) => b.resolvedCount - a.resolvedCount);

  res.json({ rows });
});

/**
 * On-demand "generate a stakeholder update" for one project. Synchronous (no worker/cron
 * involved) — the numbers are cheap to compute and the AI call is a single short completion,
 * so this runs inline within the request like /export.pdf does. Gated by
 * GlobalAISettings.statusReportEnabled via ai.service.ts#generateStatusReport's own preflight.
 */
reportRouter.post("/status-report", requirePermission(permissions.REPORTS_VIEW), async (req, res) => {
  const projectId = String(req.body?.projectId ?? "");
  const periodDays = Math.min(Math.max(Number(req.body?.periodDays) || 7, 1), 90);
  if (!projectId) throw new AppError(422, "projectId is required");

  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, name: true } });
  if (!project) throw new AppError(404, "Project not found");

  const periodStart = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);
  const periodLabel =
    periodDays === 7 ? "the past week" : periodDays === 30 ? "the past month" : `the past ${periodDays} days`;
  const sinceLocal = startOfLocalDay();

  const [ticketsCreated, resolvedTickets, openTickets, overdueCount, hoursAgg] = await Promise.all([
    prisma.ticket.count({ where: { projectId, deletedAt: null, createdAt: { gte: periodStart } } }),
    prisma.ticket.findMany({
      where: { projectId, deletedAt: null, resolvedAt: { gte: periodStart } },
      select: { key: true, title: true, status: true },
      take: 5
    }),
    prisma.ticket.findMany({
      where: { projectId, deletedAt: null, status: { notIn: ["RESOLVED", "CLOSED"] } },
      select: { key: true, title: true, status: true }
    }),
    prisma.ticket.count({
      where: { projectId, deletedAt: null, status: { notIn: ["RESOLVED", "CLOSED"] }, slaBreachAt: { not: null, lt: sinceLocal } }
    }),
    prisma.timesheet.aggregate({
      where: { projectId, deletedAt: null, workDate: { gte: new Date(Date.UTC(periodStart.getFullYear(), periodStart.getMonth(), periodStart.getDate())) } },
      _sum: { totalHours: true }
    })
  ]);

  const notableTickets = resolvedTickets.length > 0 ? resolvedTickets : openTickets.slice(0, 5);

  const { report } = await generateStatusReport({
    projectName: project.name,
    periodLabel,
    ticketsCreated,
    ticketsResolved: resolvedTickets.length,
    openCount: openTickets.length,
    overdueCount,
    hoursLogged: Number(Number(hoursAgg._sum.totalHours ?? 0).toFixed(1)),
    notableTickets,
    userId: req.user!.id
  });

  res.json({ report, projectName: project.name, periodLabel });
});

reportRouter.get("/export.csv", requirePermission(permissions.REPORTS_VIEW), async (_req, res) => {
  const rows = await prisma.timesheet.findMany({
    where: { deletedAt: null },
    include: { user: true, project: true, module: true, submodule: true },
    orderBy: [{ workDate: "desc" }, { startTime: "asc" }]
  });
  const header = ["User", "Email", "Date", "Project", "Module", "Submodule", "Activity", "Start", "End", "Hours", "Status", "Task", "Notes"];
  const escape = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const lines = [
    header.join(","),
    ...rows.map((row) =>
      [
        row.user.name, row.user.email, row.workDate.toISOString().slice(0, 10),
        row.project.name, row.module.name, row.submodule?.name,
        row.activityType, row.startTime, row.endTime,
        Number(row.totalHours).toFixed(2), row.status,
        htmlToText(row.taskDescription), htmlToText(row.notes ?? "")
      ]
        .map(escape)
        .join(",")
    )
  ];
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=timesheet-report.csv");
  res.send(lines.join("\n"));
});

reportRouter.get("/export.pdf", requirePermission(permissions.REPORTS_VIEW), async (_req, res) => {
  const rows = await prisma.timesheet.findMany({
    where: { deletedAt: null },
    include: { user: { select: { name: true, email: true } }, project: { select: { name: true } } },
    orderBy: [{ workDate: "desc" }, { startTime: "asc" }],
    take: 500
  });

  const totalHours = rows.reduce((sum, row) => sum + Number(row.totalHours ?? 0), 0);
  const approvedHours = rows
    .filter((row) => row.status === "APPROVED")
    .reduce((sum, row) => sum + Number(row.totalHours ?? 0), 0);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", 'attachment; filename="timesheet-report.pdf"');

  const doc = new PDFDocument({ size: "A4", margin: 36 });
  doc.pipe(res);

  doc.fontSize(20).fillColor("#0F9AA8").text("TimeSphere", { continued: false });
  doc.fontSize(10).fillColor("#64748B").text(`Generated ${new Date().toLocaleString()}`);
  doc.moveDown(0.5);
  doc.fontSize(16).fillColor("#0F172A").text("Timesheet Report");
  doc.moveDown(0.5);
  doc.fontSize(10).fillColor("#0F172A");
  doc.text(`Entries: ${rows.length}    Total hours: ${totalHours.toFixed(2)}    Approved hours: ${approvedHours.toFixed(2)}`);
  doc.moveDown(0.75);

  const colX = { date: 36, user: 100, project: 215, activity: 320, hours: 410, status: 460 };
  function drawTableHeader() {
    doc.fontSize(9).fillColor("#64748B");
    doc.text("Date", colX.date, doc.y, { continued: true });
    doc.text("  User", colX.user - colX.date - 24, undefined, { continued: true });
    doc.text("  Project", colX.project - colX.user - 50, undefined, { continued: true });
    doc.text("  Activity", colX.activity - colX.project - 50, undefined, { continued: true });
    doc.text("  Hours", colX.hours - colX.activity - 50, undefined, { continued: true });
    doc.text("  Status");
    doc.moveDown(0.3);
    doc.strokeColor("#E2E8F0").lineWidth(0.5).moveTo(36, doc.y).lineTo(560, doc.y).stroke();
    doc.moveDown(0.2);
  }
  drawTableHeader();
  doc.fontSize(9).fillColor("#0F172A");
  const truncate = (input: string, max: number) => (input.length > max ? `${input.slice(0, max - 1)}…` : input);

  for (const row of rows) {
    if (doc.y > 760) { doc.addPage(); drawTableHeader(); }
    const rowY = doc.y;
    doc.text(row.workDate.toISOString().slice(0, 10), colX.date, rowY);
    doc.text(truncate(row.user.name, 16), colX.user, rowY);
    doc.text(truncate(row.project.name, 18), colX.project, rowY);
    doc.text(truncate(row.activityType, 14), colX.activity, rowY);
    doc.text(Number(row.totalHours).toFixed(2), colX.hours, rowY);
    doc.fillColor(
      row.status === "APPROVED" ? "#16A34A" : row.status === "REJECTED" ? "#DC2626" : row.status === "SUBMITTED" ? "#D97706" : "#64748B"
    );
    doc.text(row.status, colX.status, rowY);
    doc.fillColor("#0F172A");
    const taskPreview = htmlToText(row.taskDescription).slice(0, 110);
    if (taskPreview) {
      doc.moveDown(0.2);
      doc.fontSize(8).fillColor("#64748B").text(taskPreview, colX.date, doc.y, { width: 524 });
      doc.fontSize(9).fillColor("#0F172A");
    }
    doc.moveDown(0.35);
    doc.strokeColor("#F1F5F9").lineWidth(0.4).moveTo(36, doc.y).lineTo(560, doc.y).stroke();
    doc.moveDown(0.15);
  }
  if (rows.length === 0) {
    doc.moveDown(2);
    doc.fontSize(11).fillColor("#64748B").text("No timesheet entries to export.", { align: "center" });
  }
  doc.moveDown(2);
  doc.fontSize(8).fillColor("#94A3B8").text("Confidential — for internal operational review.", { align: "center" });
  doc.end();
});
