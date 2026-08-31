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
import { Router, type Request } from "express";
import PDFDocument from "pdfkit";
import {
  permissions,
  qualityDisciplineFindingTypes,
  resolvedSecurityFindingStatuses,
  securityDisciplineFindingTypes,
  unresolvedSecurityFindingStatuses
} from "@timesheet/shared";
import type { Prisma, TicketStatus } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { DAY_MS, parseDayWindow, resolveTimestampWindow, windowDays } from "../utils/date-window.js";
import { isChangeManagementOn } from "../services/change.service.js";
import { controlPrisma } from "../config/control-prisma.js";
import { tenantContext } from "../config/tenant-context.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import { generateStatusReport } from "../services/ai.service.js";
import { computeTimesheetCost } from "../services/billing-rate.service.js";
import { buildTimesheetAnalytics } from "../services/timesheet-analytics.service.js";
import {
  GROUP_BY_KEYS,
  REPORT_INCLUDE,
  REPORT_ROW_LIMIT,
  TIMESHEET_CSV_HEADER,
  buildTimesheetExportDocument,
  buildTimesheetReport,
  buildTimesheetWhere,
  resolveReviewerNames,
  timesheetCsvValues,
  toCsvLine,
  type GroupByKey,
  type TimesheetReportFilters
} from "../services/timesheet-report.service.js";
import { buildTimesheetReportWorkbook } from "../services/timesheet-report-xlsx.service.js";
import { renderTimesheetReportPdf } from "../services/timesheet-report-pdf.service.js";

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
 * Personal status for a period: hours logged + whether a reminder/escalation has been raised
 * against the calling user. Used by the dashboard hero card.
 *
 * Takes `from`/`to`; with neither it answers for today exactly as it always did. The card's copy
 * follows the period rather than saying "today" over a month of data, which is why `days` is
 * returned — the caller cannot infer it from the numbers alone.
 */
reportRouter.get("/daily-status", async (req, res) => {
  const today = todayUtcDate();
  const sinceLocal = startOfLocalDay();
  const window = parseDayWindow(req.query);
  const from = window.from ?? today;
  const to = window.to ?? today;
  const days = windowDays(from, to);
  const [aggregate, reminded, escalated] = await Promise.all([
    prisma.timesheet.aggregate({
      where: { userId: req.user!.id, workDate: { gte: from, lte: to }, deletedAt: null },
      _sum: { totalHours: true },
      _count: true
    }),
    // Reminders stay scoped to TODAY even over a longer range: "were you nudged" is a live fact
    // about right now, and answering "yes, at some point in the last 30 days" would turn a
    // prompt-to-act into background noise.
    prisma.notification.count({
      where: { userId: req.user!.id, category: "reminder.daily", createdAt: { gte: sinceLocal } }
    }),
    prisma.notification.count({
      where: { userId: req.user!.id, category: "reminder.escalation", createdAt: { gte: sinceLocal } }
    })
  ]);
  res.json({
    date: to.toISOString().slice(0, 10),
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
    days,
    entries: aggregate._count,
    hours: Number(aggregate._sum.totalHours ?? 0),
    reminderReceived: reminded > 0,
    escalated: escalated > 0
  });
});

/**
 * The workspace summary behind the home page's cards.
 *
 * IT USED TO IGNORE THE REQUEST ENTIRELY and hardcode today / yesterday / 7d / year-to-date. With a
 * date filter on the page that is no longer good enough, so it takes `from`/`to` — and with neither,
 * it computes exactly the windows it always did, so every other caller is unaffected.
 *
 * "vs YESTERDAY" BECOMES "vs THE PREVIOUS EQUAL-LENGTH PERIOD" once a range is given, because that
 * is the only thing a delta can honestly mean for an arbitrary span: comparing a fortnight against
 * one day would read as a collapse every time.
 *
 * The project/status/activity breakdowns gain the filter too. They were ALL-TIME, which was its own
 * quiet bug — "Project utilization" on a page showing one week silently answered for all history.
 */
reportRouter.get("/admin-summary", requirePermission(permissions.REPORTS_VIEW), async (req, res) => {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const today = todayUtcDate();
  const yesterday = new Date(today);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yearStart = new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
  const sinceLocal = startOfLocalDay();

  const sinceYesterdayLocal = new Date(sinceLocal);
  sinceYesterdayLocal.setDate(sinceYesterdayLocal.getDate() - 1);

  const window = parseDayWindow(req.query);
  const { from: rangeFrom, to: rangeTo, ranged } = window;

  // Timestamp windows for the "raised / closed / reminded" counts, which filter on createdAt.
  // See utils/date-window.ts for why `end` is exclusive and where the comparison period comes from.
  const { start: winStart, end: winEnd, prevStart } = resolveTimestampWindow(window, sinceLocal, new Date());

  const inWindow = { gte: winStart, ...(winEnd ? { lt: winEnd } : {}) };
  const inPrevWindow = { gte: prevStart, lt: winStart };

  // Day windows for the counts that filter on `workDate`, which is a date column, not a timestamp.
  const dayFrom = rangeFrom ?? today;
  const dayTo = rangeTo ?? today;
  const dayLength = Math.max(DAY_MS, dayTo.getTime() - dayFrom.getTime() + DAY_MS);
  const inDays = { gte: dayFrom, lte: dayTo };
  const inPrevDays = { gte: new Date(dayFrom.getTime() - dayLength), lte: new Date(dayFrom.getTime() - DAY_MS) };

  /** Hours/status/activity breakdowns are scoped to the range when there is one, and left
   *  unfiltered when there is not — which is what they have always done. */
  const breakdownWhere = ranged ? { deletedAt: null, workDate: inDays } : { deletedAt: null };

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
    prisma.user.count({ where: { deletedAt: null, createdAt: { lt: winStart } } }),
    prisma.user.count({
      where: { deletedAt: null, status: "ACTIVE", role: { name: { in: ["EMPLOYEE", "TEAM_LEAD"] } } }
    }),
    prisma.project.count({ where: { deletedAt: null } }),
    prisma.project.count({ where: { deletedAt: null, createdAt: { lt: winStart } } }),
    prisma.timesheet.aggregate({ where: { status: "APPROVED", deletedAt: null }, _sum: { totalHours: true } }),
    prisma.timesheet.aggregate({
      where: { status: "APPROVED", deletedAt: null, reviewedAt: { lt: winStart } },
      _sum: { totalHours: true }
    }),
    prisma.timesheet.count({ where: { status: "SUBMITTED", deletedAt: null } }),
    prisma.timesheet.count({ where: { status: "SUBMITTED", deletedAt: null, createdAt: { lt: winStart } } }),
    prisma.timesheet.count({ where: { slaBreachAt: { not: null }, deletedAt: null } }),
    prisma.timesheet.count({ where: { deletedAt: null, slaBreachAt: { not: null, lt: winStart } } }),
    prisma.escalation.count({ where: { resolvedAt: null } }),
    prisma.escalation.count({ where: { resolvedAt: null, createdAt: { lt: winStart } } }),
    prisma.timesheet.count({ where: { status: "APPROVED", reviewedAt: { gte: weekAgo }, deletedAt: null } }),
    prisma.timesheet.count({
      where: { status: "APPROVED", reviewedAt: { gte: new Date(weekAgo.getTime() - WEEK_MS), lt: weekAgo }, deletedAt: null }
    }),
    prisma.timesheet.findMany({
      where: { workDate: inDays, deletedAt: null },
      select: { userId: true },
      distinct: ["userId"]
    }),
    prisma.timesheet.findMany({
      where: { workDate: inPrevDays, deletedAt: null },
      select: { userId: true },
      distinct: ["userId"]
    }),
    prisma.notification.count({
      where: { category: "reminder.daily", createdAt: inWindow }
    }),
    prisma.notification.count({
      where: { category: "reminder.daily", createdAt: inPrevWindow }
    }),
    prisma.notification.count({
      where: { category: "reminder.escalation", createdAt: inWindow }
    }),
    prisma.notification.count({
      where: { category: "reminder.escalation", createdAt: inPrevWindow }
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
    prisma.timesheet.groupBy({ by: ["projectId"], where: breakdownWhere, _sum: { totalHours: true }, _count: true }),
    prisma.timesheet.groupBy({ by: ["status"], where: breakdownWhere, _sum: { totalHours: true }, _count: true }),
    prisma.timesheet.groupBy({ by: ["activityType"], where: breakdownWhere, _sum: { totalHours: true }, _count: true })
  ]);

  const projectNames = await prisma.project.findMany({
    where: { id: { in: byProject.map((row) => row.projectId) } },
    // code included for the chart x-axes: two full project names ate the whole axis while the
    // bars between them went unlabeled — the code is the identifier people already use in
    // ticket keys, and the full name stays in the tooltip.
    select: { id: true, name: true, code: true }
  });

  // Ticket and change activity for the SAME day boundary the logging figures use, so the card's
  // rows are comparable. Counted here rather than in a second request because the workforce card
  // renders them together and a half-arrived card is the bug the project rollup was just fixed for.
  // Typed through Prisma's own enum rather than string literals, so renaming a status is a
  // compile error here instead of a silently-zero count.
  const CLOSED_TICKET: TicketStatus[] = ["RESOLVED", "CLOSED"];
  const changesOn = await isChangeManagementOn().catch(() => false);
  const [
    ticketsRaisedToday,
    ticketsRaisedYesterday,
    ticketsClosedToday,
    ticketsClosedYesterday,
    changesRaisedToday,
    changesRaisedYesterday,
    changesClosedToday,
    changesClosedYesterday
  ] = await Promise.all([
    prisma.ticket.count({ where: { deletedAt: null, createdAt: inWindow } }),
    prisma.ticket.count({ where: { deletedAt: null, createdAt: inPrevWindow } }),
    prisma.ticket.count({ where: { deletedAt: null, status: { in: CLOSED_TICKET }, updatedAt: inWindow } }),
    prisma.ticket.count({ where: { deletedAt: null, status: { in: CLOSED_TICKET }, updatedAt: inPrevWindow } }),
    changesOn ? prisma.changeRequest.count({ where: { createdAt: inWindow } }) : Promise.resolve(0),
    changesOn ? prisma.changeRequest.count({ where: { createdAt: inPrevWindow } }) : Promise.resolve(0),
    changesOn ? prisma.changeRequest.count({ where: { closedAt: inWindow } }) : Promise.resolve(0),
    changesOn ? prisma.changeRequest.count({ where: { closedAt: inPrevWindow } }) : Promise.resolve(0)
  ]);

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
    ticketsRaisedToday,
    ticketsRaisedYesterday,
    ticketsClosedToday,
    ticketsClosedYesterday,
    /** Null, not zero, when change management is off — the card drops the tiles rather than
     *  claiming a measurement of something this workspace does not do. */
    changesRaisedToday: changesOn ? changesRaisedToday : null,
    changesRaisedYesterday: changesOn ? changesRaisedYesterday : null,
    changesClosedToday: changesOn ? changesClosedToday : null,
    changesClosedYesterday: changesOn ? changesClosedYesterday : null,
    byProject: byProject.map((row) => {
      const project = projectNames.find((p) => p.id === row.projectId);
      return { ...row, project: project?.name ?? "Unknown", projectCode: project?.code ?? null };
    }),
    byStatus,
    byActivity
  });
});

/**
 * Ticket metrics for the Reports page — kept separate from /admin-summary
 * (already a large batched payload) for cleaner separation of concerns.
 */
// Broadened to every authenticated member (was reports:view). Team leads and employees can now see workspace productivity — see docs note on the org-visibility change.
reportRouter.get("/ticket-summary", async (_req, res) => {
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
// Broadened to every authenticated member (was reports:view). Team leads and employees can now see workspace productivity — see docs note on the org-visibility change.
reportRouter.get("/ticket-insights", async (_req, res) => {
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
/** The by-type breakdown iterates a shared constant rather than a literal copy of one: a type this
 *  list did not know about was ingested, stored, counted in `totalOpen` — and then missing from the
 *  chart that is supposed to say where the risk is. It is the SECURITY slice of
 *  `securityFindingTypes`, because this chart sits under the security totals; the quality types get
 *  their own list in the `quality` block below. */
const SECURITY_TYPES = securityDisciplineFindingTypes;
/**
 * This page's definition of "still a problem" and "done with", read from the shared bucket map
 * (`securityFindingStatusBuckets`) rather than typed out here — see that map's comment for the
 * four hand-maintained copies this replaced and what a missing status did to them.
 *
 * THE DECISION THIS PAGE MAKES: `unresolved` = open + pending, so a finding somebody has marked
 * fixed but no scan has confirmed still counts on every number below — the open totals, the
 * severity breakdown, the per-repo table and the risk score. The alternative would let a
 * workspace's headline security figure be improved by closing tickets rather than by fixing code.
 * `resolved` stays strictly the confirmed-or-accepted set, which is what
 * `meanTimeToRemediateHours` should measure: time until a fix was PROVEN, not until it was
 * claimed.
 */
const OPEN_FINDING_STATUSES = unresolvedSecurityFindingStatuses;
const RESOLVED_FINDING_STATUSES = resolvedSecurityFindingStatuses;

/**
 * THE OTHER DECISION THIS PAGE MAKES, and the one SonarQube/ESLint ingestion forced: every headline
 * number on this page is SECURITY-discipline only.
 *
 * Quality findings (Sonar's bugs and code smells, lint results) arrive through the same webhook into
 * the same table, and a busy monorepo produces them by the thousand. Counted here they would climb
 * the risk score, fill the by-severity chart with MEDIUMs, dominate the per-repo and per-module
 * tables, and bury the one CRITICAL that actually matters. Nothing about that would be a bug — every
 * row is a real thing a real tool found — which is exactly why it is dangerous: the page would keep
 * working and quietly stop measuring security.
 *
 * They are NOT dropped. `quality` in the response below carries their own totals, severity mix and
 * type breakdown, so the page can show them in their own section — see SecurityInsights.tsx. One
 * table, two questions, answered separately.
 */
const SECURITY_DISCIPLINE = { type: { in: securityDisciplineFindingTypes } };
const QUALITY_DISCIPLINE = { type: { in: qualityDisciplineFindingTypes } };

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
 * mean-time-to-remediate, top repos by finding count, open findings per MODULE, and the org-wide
 * risk score. Powers the Security insights page (Phase 2 of the "Competitive parity" roadmap
 * section) the same way /ticket-insights powers the Insights page — one batched call, everything
 * the page needs.
 *
 * The per-module breakdown is the one figure here no scanner vendor can produce: it needs the work
 * breakdown (Project → ProjectModule) and the map from repository paths onto it, and a scanner owns
 * neither. It is only as complete as the routing rules an admin has written, which is why
 * `openWithoutModuleCount` is reported beside it rather than left for somebody to infer.
 *
 * WHAT "MEAN TIME TO REMEDIATE" NOW MEASURES, per finding, in this order:
 *
 *   1. `verifiedFixedAt - firstSeenAt` when a scan PROVED the fix — the real answer. That column is
 *      written only by the verification verdict (security-report.service.ts), never by any human
 *      action, so this half of the average measures remediation rather than measuring how willing
 *      somebody was to close a ticket.
 *   2. `updatedAt - createdAt` otherwise — the old approximation, kept deliberately so that findings
 *      resolved before verification existed, and findings an admin accepted as risk (which no scan
 *      will ever confirm), still report SOMETHING instead of vanishing from the figure the day this
 *      shipped.
 *
 * BE HONEST ABOUT (2). `updatedAt` moves on every re-sighting, so a FIXED finding a scanner keeps
 * reporting inflates its own remediation time — a flaw the deduplication work made worse, and the
 * reason (1) exists. The two are averaged together rather than reported separately because a
 * workspace's history is mostly (2) and would otherwise read as a step change on the day it turned
 * verification on. `verifiedFixedCount` beside it is what says how much of this figure is real:
 * when that number approaches the resolved count, the average is measurement rather than estimate.
 */
// Broadened to every authenticated member (was reports:view). NOTE: this deliberately exposes the workspace's security findings / SBOM to all staff — an internal-transparency decision, reversible by restoring requirePermission(REPORTS_VIEW).
reportRouter.get("/security-insights", async (_req, res) => {
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
    openYesterday,
    awaitingVerificationCount,
    openByModuleRows,
    openWithoutModuleCount,
    openQualityFindings,
    qualityByType
  ] = await Promise.all([
    prisma.securityFinding.findMany({
      where: { status: { in: OPEN_FINDING_STATUSES }, ...SECURITY_DISCIPLINE },
      select: { severity: true, createdAt: true }
    }),
    prisma.securityFinding.findMany({
      where: { createdAt: { gte: rangeStart }, ...SECURITY_DISCIPLINE },
      select: { createdAt: true, severity: true }
    }),
    prisma.securityFinding.findMany({
      where: { status: { in: RESOLVED_FINDING_STATUSES }, updatedAt: { gte: rangeStart }, ...SECURITY_DISCIPLINE },
      // `firstSeenAt` is when this exact problem was FIRST reported, which is what "how long did it
      // take to remediate" should be measured from — `createdAt` is the row's birthday and only
      // happens to be the same thing for a finding that was never deduplicated.
      select: { createdAt: true, updatedAt: true, firstSeenAt: true, verifiedFixedAt: true }
    }),
    prisma.securityFinding.groupBy({ by: ["type"], where: { status: { in: OPEN_FINDING_STATUSES }, ...SECURITY_DISCIPLINE }, _count: true }),
    prisma.securityFinding.groupBy({
      by: ["repository"],
      where: { status: { in: OPEN_FINDING_STATUSES }, repository: { not: null }, ...SECURITY_DISCIPLINE },
      _count: true,
      orderBy: { _count: { repository: "desc" } },
      take: 10
    }),
    prisma.securityFinding.count({ where: { status: { in: OPEN_FINDING_STATUSES }, createdAt: { lt: sinceLocal }, ...SECURITY_DISCIPLINE } }),
    // Claimed fixed, waiting on a scan to agree. A LIVE count rather than a windowed one, because
    // unlike everything else on this page it is a queue somebody can act on right now — and it is
    // the number that says whether verification is actually running or just switched on.
    prisma.securityFinding.count({ where: { verificationState: "AWAITING_PROOF", ...SECURITY_DISCIPLINE } }),
    // WHICH PART OF THE PRODUCT CARRIES THE RISK — grouped on the module the ingest resolved from
    // the finding's repository and path (see services/finding-routing.service.ts). Uses the same
    // `OPEN_FINDING_STATUSES` as every other number on this page, so a module's count and the
    // headline total are answering the same question.
    prisma.securityFinding.groupBy({
      by: ["moduleId"],
      where: { status: { in: OPEN_FINDING_STATUSES }, moduleId: { not: null }, ...SECURITY_DISCIPLINE },
      _count: true,
      orderBy: { _count: { moduleId: "desc" } },
      take: 10
    }),
    // Reported beside the breakdown rather than hidden by it: a table of five modules means
    // something very different when four hundred findings are routed nowhere. This is also the
    // number that tells an admin their rule set has a hole in it.
    prisma.securityFinding.count({ where: { status: { in: OPEN_FINDING_STATUSES }, moduleId: null, ...SECURITY_DISCIPLINE } }),
    // --- The quality discipline, counted entirely separately ------------------------------------
    // Two queries, not nine: this section answers "how big is the code-quality backlog and what is
    // in it", which is all the page needs to render it beside the security numbers. Everything the
    // security half computes and this one does not — a risk score, a remediation average, a per-repo
    // table — is deliberately absent, because those figures are claims about EXPOSURE and a code
    // smell is not one.
    prisma.securityFinding.findMany({
      where: { status: { in: OPEN_FINDING_STATUSES }, ...QUALITY_DISCIPLINE },
      select: { severity: true }
    }),
    prisma.securityFinding.groupBy({ by: ["type"], where: { status: { in: OPEN_FINDING_STATUSES }, ...QUALITY_DISCIPLINE }, _count: true })
  ]);

  // Names are looked up after the aggregation rather than joined into it — `groupBy` cannot include
  // a relation, and this is one small query against at most ten ids. Skipped entirely when the
  // breakdown is empty, which is every workspace that has not written routing rules yet: there is
  // nothing to name, so there is no reason to ask.
  const breakdownModuleIds = openByModuleRows.map((row) => row.moduleId).filter((id): id is string => Boolean(id));
  const breakdownModules = breakdownModuleIds.length
    ? await prisma.projectModule.findMany({
        where: { id: { in: breakdownModuleIds } },
        select: { id: true, name: true, project: { select: { name: true, code: true } } }
      })
    : [];
  const moduleById = new Map(breakdownModules.map((module) => [module.id, module]));

  const countBySeverity = (rows: Array<{ severity: (typeof SECURITY_SEVERITIES)[number] }>) =>
    Object.fromEntries(SECURITY_SEVERITIES.map((s) => [s, rows.filter((f) => f.severity === s).length])) as Record<
      (typeof SECURITY_SEVERITIES)[number],
      number
    >;
  const openBySeverity = countBySeverity(openFindings);

  const findingsOverTime = weeks.map((weekStart) => ({
    weekStart: weekStart.toISOString().slice(0, 10),
    count: findingsInRange.filter((f) => weekIndexFor(f.createdAt, weeks) === weeks.indexOf(weekStart)).length
  }));

  // Proof where there is proof, the old approximation where there is not — see this route's header
  // for why the two are averaged together rather than reported as separate figures.
  const remediationHours = resolvedFindings.map((f) =>
    f.verifiedFixedAt
      ? (f.verifiedFixedAt.getTime() - f.firstSeenAt.getTime()) / (1000 * 60 * 60)
      : (f.updatedAt.getTime() - f.createdAt.getTime()) / (1000 * 60 * 60)
  );
  const meanTimeToRemediateHours =
    remediationHours.length > 0 ? remediationHours.reduce((sum, hours) => sum + hours, 0) / remediationHours.length : 0;
  const verifiedFixedCount = resolvedFindings.filter((f) => f.verifiedFixedAt).length;

  const riskScore = computeRiskScore(openFindings);
  const riskScoreYesterday = computeRiskScore(openFindings.filter((f) => f.createdAt < sinceLocal));

  res.json({
    totalOpen: openFindings.length,
    totalOpenYesterday: openYesterday,
    openBySeverity,
    byType: SECURITY_TYPES.map((type) => ({ type, count: byType.find((row) => row.type === type)?._count ?? 0 })),
    findingsOverTime,
    meanTimeToRemediateHours: Number(meanTimeToRemediateHours.toFixed(1)),
    /** How many of the findings behind that average were confirmed gone by a scan rather than
     *  estimated from `updatedAt`. Reported beside the average, never folded into it, so a reader can
     *  see how much of the number is measurement. */
    verifiedFixedCount,
    awaitingVerificationCount,
    topRepositories: topRepos.map((row) => ({ repository: row.repository ?? "Unknown", count: row._count })),
    /** Open findings per module of the work breakdown. A module whose row has vanished between the
     *  aggregation and the name lookup (deleted mid-request) is reported as "Unknown" rather than
     *  dropped — its findings are still open and still counted in `totalOpen`. */
    openByModule: openByModuleRows.map((row) => {
      const module = row.moduleId ? moduleById.get(row.moduleId) : undefined;
      return {
        moduleId: row.moduleId,
        moduleName: module?.name ?? "Unknown",
        projectName: module?.project.name ?? "Unknown",
        projectCode: module?.project.code ?? null,
        count: row._count
      };
    }),
    /** Open findings no path rule has claimed. Not an error — it is every finding in a workspace
     *  that has not written a rule yet, and it is what makes the breakdown above honest. */
    openWithoutModuleCount,
    riskScore,
    riskScoreYesterday,
    /**
     * THE CODE-QUALITY BACKLOG, in its own block so the page can render it in its own section.
     *
     * Every number above this line is security-only (see `SECURITY_DISCIPLINE`). These three are the
     * quality equivalent, and they are deliberately fewer: a count, a severity mix and a type
     * split — no risk score, no trend, no remediation average. Those figures are statements about
     * exposure, and giving code smells one would be exactly the conflation this split exists to
     * prevent. `totalOpen` here plus `totalOpen` above is the whole open backlog, which is a number
     * nothing on this page reports, on purpose: adding them together answers no question anyone has.
     */
    quality: {
      totalOpen: openQualityFindings.length,
      openBySeverity: countBySeverity(openQualityFindings),
      byType: qualityDisciplineFindingTypes.map((type) => ({
        type,
        count: qualityByType.find((row) => row.type === type)?._count ?? 0
      }))
    }
  });
});

/**
 * SBOM dependency inventory — basic "what's in our supply chain, and is any of it known-
 * vulnerable" view, fed by ingested SPDX/CycloneDX documents (devops-webhook.controller.ts's
 * /sbom route). Deliberately not attempting Black Duck's full license-obligation-text depth —
 * see docs/ROADMAP.md's "Competitive parity" Phase 3.
 */
// Broadened to every authenticated member (was reports:view). NOTE: this deliberately exposes the workspace's security findings / SBOM to all staff — an internal-transparency decision, reversible by restoring requirePermission(REPORTS_VIEW).
reportRouter.get("/sbom-inventory", async (_req, res) => {
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

/**
 * Opt-in cost-per-ticket analytics — gated behind GlobalTicketSettings.enableCostAnalytics.
 *
 * WHAT CHANGED (and why totals in an existing workspace will DROP after this ships — that's the
 * correction, not a regression):
 * 1. Only APPROVED, billable hours count. This previously summed EVERY non-deleted timesheet,
 *    including DRAFT and REJECTED ones — i.e. it charged the business for work nobody had
 *    accepted, and for work explicitly turned down.
 * 2. It prefers the rate frozen at approval (`billedAmount`/`billedRate`, see
 *    billing-rate.service.ts) and only falls back to the person's CURRENT rate for rows approved
 *    before snapshotting existed. Previously every figure was recomputed live, so a raise
 *    retroactively rewrote history.
 * 3. Hours with no rate available are reported as `unratedHours` instead of silently contributing
 *    0 — "we don't know" and "it was free" are not the same statement.
 * 4. `totalCostUsd`/`avgCostPerTicket` are computed over ALL tickets; they were previously derived
 *    from the top-25 slice, so both headline numbers were wrong whenever more than 25 tickets had
 *    cost.
 *
 * The response is strictly additive — existing consumers (Insights.tsx) keep working unchanged.
 */
// Broadened to every authenticated member (was reports:view). NOTE: exposes workspace cost figures to all staff — reversible by restoring requirePermission(REPORTS_VIEW).
reportRouter.get("/cost-insights", async (_req, res) => {
  const settings = await prisma.globalTicketSettings.findUnique({ where: { id: "global" } });
  if (!settings?.enableCostAnalytics) throw new AppError(403, "Cost analytics is disabled for this workspace.");

  const [timesheets, excluded] = await Promise.all([
    prisma.timesheet.findMany({
      where: { deletedAt: null, ticketId: { not: null }, status: "APPROVED", billable: true },
      select: {
        ticketId: true,
        totalHours: true,
        billable: true,
        billedAmount: true,
        billedRate: true,
        user: { select: { hourlyRate: true } }
      }
    }),
    // Reported so the UI can explain the drop rather than leaving it looking like data loss.
    prisma.timesheet.groupBy({
      by: ["status"],
      where: { deletedAt: null, ticketId: { not: null }, status: { in: ["DRAFT", "REJECTED"] } },
      _sum: { totalHours: true }
    })
  ]);

  const costByTicket = new Map<string, number>();
  const hoursByTicket = new Map<string, number>();
  let unratedHours = 0;

  for (const row of timesheets) {
    if (!row.ticketId) continue;
    const { amount, unratedHours: rowUnrated } = computeTimesheetCost([
      {
        totalHours: row.totalHours,
        billable: row.billable,
        billedAmount: row.billedAmount,
        billedRate: row.billedRate,
        liveFallbackRate: row.user.hourlyRate
      }
    ]);
    const hours = Number(row.totalHours);
    costByTicket.set(row.ticketId, (costByTicket.get(row.ticketId) ?? 0) + amount);
    hoursByTicket.set(row.ticketId, (hoursByTicket.get(row.ticketId) ?? 0) + hours);
    unratedHours += rowUnrated;
  }

  const ticketIds = Array.from(costByTicket.keys());
  const tickets = await prisma.ticket.findMany({ where: { id: { in: ticketIds } }, select: { id: true, key: true, title: true } });
  const ticketById = new Map(tickets.map((t) => [t.id, t]));

  const allRows = ticketIds
    .map((id) => ({
      ticketKey: ticketById.get(id)?.key ?? "?",
      title: ticketById.get(id)?.title ?? "",
      hours: Number((hoursByTicket.get(id) ?? 0).toFixed(2)),
      costUsd: Number((costByTicket.get(id) ?? 0).toFixed(2))
    }))
    .sort((a, b) => b.costUsd - a.costUsd);

  // Totals over EVERY ticket; only the returned table is capped at 25.
  const totalCostUsd = allRows.reduce((sum, r) => sum + r.costUsd, 0);
  const avgCostPerTicket = allRows.length > 0 ? totalCostUsd / allRows.length : 0;
  const excludedHoursByStatus = Object.fromEntries(excluded.map((e) => [e.status, Number(e._sum.totalHours ?? 0)]));

  res.json({
    totalCostUsd: Number(totalCostUsd.toFixed(2)),
    avgCostPerTicket: Number(avgCostPerTicket.toFixed(2)),
    rows: allRows.slice(0, 25),
    // Additive fields — see the header comment.
    basis: "APPROVED_BILLABLE" as const,
    ticketCount: allRows.length,
    unratedHours: Number(unratedHours.toFixed(2)),
    excludedDraftHours: excludedHoursByStatus.DRAFT ?? 0,
    excludedRejectedHours: excludedHoursByStatus.REJECTED ?? 0
  });
});

/** Opt-in team leaderboard — gated behind GlobalTicketSettings.enableLeaderboard. Framed as recognition, not surveillance. */
// Broadened to every authenticated member (was reports:view). Team leads and employees can now see workspace productivity — see docs note on the org-visibility change.
reportRouter.get("/leaderboard", async (_req, res) => {
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
 * On-demand "generate a stakeholder update", for ONE project or for every active project.
 *
 * Synchronous (no worker/cron involved) — the numbers are cheap to compute and the AI call is a
 * single completion, so this runs inline within the request like /export.pdf does. Gated by
 * GlobalAISettings.statusReportEnabled via ai.service.ts#generateStatusReport's own preflight.
 *
 * THE PORTFOLIO PATH USES GROUPED QUERIES, not a loop. Five aggregates per project across twenty
 * projects is a hundred round trips on a request someone is waiting on; `groupBy` makes it five
 * regardless of how many projects there are.
 */

/** How many projects one report may cover. When more exist the report SAYS so — a portfolio update
 *  that silently covers 12 of 30 projects is worse than one that admits its scope. */
const STATUS_REPORT_PROJECT_LIMIT = 12;

reportRouter.post("/status-report", requirePermission(permissions.REPORTS_VIEW), async (req, res) => {
  const projectId = String(req.body?.projectId ?? "");
  const periodDays = Math.min(Math.max(Number(req.body?.periodDays) || 7, 1), 90);

  const periodStart = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);
  const periodLabel =
    periodDays === 7 ? "the past week" : periodDays === 30 ? "the past month" : `the past ${periodDays} days`;
  const sinceLocal = startOfLocalDay();
  const hoursSince = new Date(Date.UTC(periodStart.getFullYear(), periodStart.getMonth(), periodStart.getDate()));

  // An empty projectId is the ALL-PROJECTS request, not a validation failure — the picker offers
  // "All projects" as a first-class choice.
  const scopedProjects = projectId
    ? await prisma.project.findMany({ where: { id: projectId }, select: { id: true, name: true } })
    : await prisma.project.findMany({
        // `status` is a plain string column on Project, not an enum — ACTIVE is the default.
        where: { deletedAt: null, status: "ACTIVE" },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
        take: STATUS_REPORT_PROJECT_LIMIT + 1
      });

  if (scopedProjects.length === 0) {
    throw new AppError(projectId ? 404 : 422, projectId ? "Project not found" : "No active projects to report on.");
  }

  const truncated = !projectId && scopedProjects.length > STATUS_REPORT_PROJECT_LIMIT;
  const projects = truncated ? scopedProjects.slice(0, STATUS_REPORT_PROJECT_LIMIT) : scopedProjects;
  const ids = projects.map((p) => p.id);

  // Typed through Prisma's own input type rather than inferred: a bare object literal widens the
  // status array to string[], which the generated enum filter rejects.
  const openWhere: Prisma.TicketWhereInput = {
    projectId: { in: ids },
    deletedAt: null,
    status: { notIn: ["RESOLVED", "CLOSED"] }
  };

  const [createdRows, resolvedRows, openRows, overdueRows, hoursRows, resolvedNotable] = await Promise.all([
    prisma.ticket.groupBy({ by: ["projectId"], where: { projectId: { in: ids }, deletedAt: null, createdAt: { gte: periodStart } }, _count: { _all: true } }),
    prisma.ticket.groupBy({ by: ["projectId"], where: { projectId: { in: ids }, deletedAt: null, resolvedAt: { gte: periodStart } }, _count: { _all: true } }),
    prisma.ticket.groupBy({ by: ["projectId"], where: openWhere, _count: { _all: true } }),
    prisma.ticket.groupBy({ by: ["projectId"], where: { ...openWhere, slaBreachAt: { not: null, lt: sinceLocal } }, _count: { _all: true } }),
    prisma.timesheet.groupBy({ by: ["projectId"], where: { projectId: { in: ids }, deletedAt: null, workDate: { gte: hoursSince } }, _sum: { totalHours: true } }),
    // Resolved-in-period first; a period that resolved nothing falls back to what is still open
    // below, so the model always has concrete tickets to name rather than only counts.
    prisma.ticket.findMany({
      where: { projectId: { in: ids }, deletedAt: null, resolvedAt: { gte: periodStart } },
      select: { key: true, title: true, status: true },
      take: projectId ? 5 : 12
    })
  ]);

  const countOf = (rows: Array<{ projectId: string; _count: { _all: number } }>, id: string) =>
    rows.find((r) => r.projectId === id)?._count._all ?? 0;

  const per = projects.map((p) => ({
    name: p.name,
    created: countOf(createdRows, p.id),
    resolved: countOf(resolvedRows, p.id),
    open: countOf(openRows, p.id),
    overdue: countOf(overdueRows, p.id),
    hours: Number(Number(hoursRows.find((r) => r.projectId === p.id)?._sum.totalHours ?? 0).toFixed(1))
  }));
  const sum = (pick: (row: (typeof per)[number]) => number) => per.reduce((total, row) => total + pick(row), 0);

  const notableTickets =
    resolvedNotable.length > 0
      ? resolvedNotable
      : await prisma.ticket.findMany({
          where: openWhere,
          select: { key: true, title: true, status: true },
          take: projectId ? 5 : 12
        });

  const scopeLabel = projectId
    ? `the project "${projects[0].name}"`
    : `all ${projects.length} active project${projects.length === 1 ? "" : "s"} in this workspace${
        truncated ? ` (these are the first ${STATUS_REPORT_PROJECT_LIMIT} of more than that — say so in the summary)` : ""
      }`;

  const { report } = await generateStatusReport({
    projectName: projects[0].name,
    scopeLabel,
    projectBreakdown: projectId
      ? undefined
      : per.map((r) => `- ${r.name} — ${r.created} created, ${r.resolved} resolved, ${r.open} open, ${r.overdue} overdue, ${r.hours} h`).join("\n"),
    periodLabel,
    ticketsCreated: sum((r) => r.created),
    ticketsResolved: sum((r) => r.resolved),
    openCount: sum((r) => r.open),
    overdueCount: sum((r) => r.overdue),
    hoursLogged: Number(sum((r) => r.hours).toFixed(1)),
    notableTickets,
    userId: req.user!.id
  });

  res.json({
    report,
    projectName: projectId ? projects[0].name : `All projects (${projects.length})`,
    periodLabel,
    // Surfaced rather than left to the prose: the UI states the cap plainly instead of relying on
    // the model to have mentioned it.
    truncated,
    projectCount: projects.length
  });
});


/**
 * Parses the filter query string shared by both exports and the grouped report.
 *
 * Unknown values are DROPPED rather than rejected. A report URL is something people bookmark,
 * hand-edit and paste to each other; refusing the whole request over one stale `status=CLOSED`
 * from an older build would be worse than quietly reporting on everything else. The response
 * echoes back the filters it actually applied, so nothing is guessed at silently.
 */
/** Rows a single PDF will render. Generous — and when it is exceeded the document SAYS so rather
 *  than quietly reporting a total that covers only part of what matched. A PDF is a paginated
 *  document somebody prints; an unbounded one is a denial-of-service on the person who opens it. */
const PDF_ROW_LIMIT = 2_000;

const TIMESHEET_STATUSES = ["DRAFT", "SUBMITTED", "APPROVED", "REJECTED"] as const;

function parseReportFilters(query: Record<string, unknown>): TimesheetReportFilters {
  const str = (key: string): string | undefined => {
    const raw = query[key];
    return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
  };
  const isoDate = (key: string): string | undefined => {
    const raw = str(key);
    return raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined;
  };
  const status = str("status");
  const billable = str("billable");

  return {
    from: isoDate("from"),
    to: isoDate("to"),
    projectId: str("projectId"),
    moduleId: str("moduleId"),
    userId: str("userId"),
    ticketId: str("ticketId"),
    status: (TIMESHEET_STATUSES as readonly string[]).includes(status ?? "")
      ? (status as TimesheetReportFilters["status"])
      : undefined,
    activityType: str("activityType"),
    billable: billable === "true" ? true : billable === "false" ? false : undefined
  };
}

/**
 * The workspace an export belongs to, for its header block. A report naming only the product is
 * unattributable once printed — three orgs' PDFs look identical on a desk.
 *
 * Falls back to the slug, then to the product name: the control-plane row is not worth failing a
 * download over, and the tenant context is always present on an authenticated request.
 */
async function resolveWorkspaceName(): Promise<string> {
  const ctx = tenantContext.getStore();
  if (!ctx) return "TimeSphere";
  const org = await controlPrisma.organization
    .findUnique({ where: { id: ctx.orgId }, select: { name: true } })
    .catch(() => null);
  return org?.name ?? ctx.orgSlug ?? "TimeSphere";
}

/** Everything the two exports need, gathered once. Both answer the same question in different
 *  formats, so they must not each decide for themselves what "the rows" are. */
async function loadExportDocument(req: Request, rowLimit: number) {
  const filters = parseReportFilters(req.query as Record<string, unknown>);
  const requested = String((req.query as Record<string, unknown>).groupBy ?? "user");
  const groupBy = (GROUP_BY_KEYS as string[]).includes(requested) ? (requested as GroupByKey) : "user";
  const where = buildTimesheetWhere(filters);

  // Counted separately so the document can compare what it is showing against what matched, and
  // say plainly when those differ.
  const [totalMatching, rows, workspace] = await Promise.all([
    prisma.timesheet.count({ where }),
    prisma.timesheet.findMany({
      where,
      include: REPORT_INCLUDE,
      // Newest first so a capped export keeps the most recent work; each section re-sorts its own
      // rows forwards for reading.
      orderBy: [{ workDate: "desc" }, { startTime: "asc" }],
      take: rowLimit
    }),
    resolveWorkspaceName()
  ]);

  return buildTimesheetExportDocument({
    rows,
    totalMatching,
    filters,
    groupBy,
    workspace,
    generatedBy: `${req.user!.name} (${req.user!.email})`,
    reviewers: await resolveReviewerNames(rows)
  });
}

/**
 * GET /reports/timesheets — the grouped report.
 *
 * One endpoint, nine groupings. This is the thing that turns rows into an answer: "hours per
 * person per month", "which activity ate Project Apollo", "what does each ticket actually cost".
 * Before it, the only way to ask any of those was to export every row in the workspace and pivot
 * it in Excel.
 */
reportRouter.get("/timesheets", requirePermission(permissions.REPORTS_VIEW), async (req, res) => {
  const filters = parseReportFilters(req.query as Record<string, unknown>);
  const requested = String((req.query as Record<string, unknown>).groupBy ?? "user");
  const groupBy = (GROUP_BY_KEYS as string[]).includes(requested) ? (requested as GroupByKey) : "user";
  res.json({ ...(await buildTimesheetReport(filters, groupBy)), groupByOptions: GROUP_BY_KEYS });
});

/**
 * GET /reports/export.csv — every matching row, with the columns a report is actually asked for.
 *
 * WHAT CHANGED AND WHY IT MATTERED: this handler used to be `async (_req, res)` — the underscore
 * was honest, the request was ignored — with `where: { deletedAt: null }` and nothing else. Every
 * timesheet in the workspace, for all time, for everybody, on one button. It also omitted every
 * field that makes an export worth having: no billing, no SLA, no ticket, no reviewer. So it could
 * not answer "what did this cost", "who approved it", or "was it late", which is most of what
 * somebody exports a timesheet report to find out.
 */
/**
 * GET /reports/analytics — utilisation, approval latency and activity mix.
 *
 * A DATE RANGE IS REQUIRED here, unlike the grouped report, and that is not laziness. Utilisation
 * is hours divided by capacity, and capacity only exists relative to a period — "utilisation, all
 * time" is not a question with an answer. Defaulting silently to some window would produce a
 * confident percentage nobody asked for.
 */
reportRouter.get("/analytics", requirePermission(permissions.REPORTS_VIEW), async (req, res) => {
  const filters = parseReportFilters(req.query as Record<string, unknown>);
  if (!filters.from || !filters.to) {
    throw new AppError(
      422,
      "Analytics needs a date range: utilisation is hours against capacity, and capacity only means something over a period."
    );
  }
  res.json(await buildTimesheetAnalytics({ ...filters, from: filters.from, to: filters.to }));
});

/**
 * GET /reports/export.xlsx — the same filtered set as a real spreadsheet.
 *
 * WHY THIS EXISTS ALONGSIDE CSV: CSV has no types. Every date arrives as text, every number as
 * text, and the first thing anyone does is re-type the columns by hand before they can pivot —
 * or worse, does not, and sorts "10.5" before "9.0" because it sorted alphabetically. A workbook
 * carries real number and date cells, and can hold the grouped summary on a second sheet next to
 * the raw rows, which is exactly the shape people were building by hand from the CSV.
 */
reportRouter.get("/export.xlsx", requirePermission(permissions.REPORTS_VIEW), async (req, res) => {
  const report = await loadExportDocument(req, REPORT_ROW_LIMIT);
  const wb = buildTimesheetReportWorkbook(report);

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="timesheet-report-${stamp}.xlsx"`);
  res.setHeader("X-Report-Rows-Included", String(report.rowsIncluded));
  res.setHeader("X-Report-Total-Matching", String(report.totalMatching));
  if (report.truncated) res.setHeader("X-Report-Truncated", "true");
  await wb.xlsx.write(res);
  res.end();
});

reportRouter.get("/export.csv", requirePermission(permissions.REPORTS_VIEW), async (req, res) => {
  const filters = parseReportFilters(req.query as Record<string, unknown>);
  const rows = await prisma.timesheet.findMany({
    where: buildTimesheetWhere(filters),
    include: REPORT_INCLUDE,
    orderBy: [{ workDate: "desc" }, { startTime: "asc" }],
    take: REPORT_ROW_LIMIT
  });
  const reviewers = await resolveReviewerNames(rows);

  const lines = [
    toCsvLine(TIMESHEET_CSV_HEADER),
    ...rows.map((row) => toCsvLine(timesheetCsvValues(row, row.reviewedById ? (reviewers.get(row.reviewedById) ?? "") : "")))
  ];

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename=timesheet-report-${stamp}.csv`);
  res.setHeader("X-Report-Rows-Included", String(rows.length));
  // A CSV cannot carry a caveat in its body without corrupting the data, so the header is the
  // only honest channel. Hitting this at all means the filter was too broad to be a report.
  if (rows.length === REPORT_ROW_LIMIT) res.setHeader("X-Report-Truncated", "true");
  // A BOM, so Excel opens UTF-8 correctly instead of mangling every accented name. Costs three
  // bytes and removes the single most common "your export is broken" report.
  res.send("\uFEFF" + lines.join("\n"));
});

/**
 * GET /reports/timesheets/:id/export.csv — one entry, same columns as the bulk export.
 *
 * WHY A ROUTE AND NOT A FILTER: `parseReportFilters` deliberately has no `id` — every filter it
 * accepts describes a SET ("this project, this month"), and adding a single-row escape hatch to
 * it would blur what an export's scope line means. This is a different question ("give me the
 * record behind this decision") asked from the approvals queue, where an approver wants the row
 * they are about to sign off on as a file they can attach to why they signed it.
 *
 * Gated on REPORTS_VIEW like the rest of the export family rather than TIMESHEETS_APPROVE: this
 * returns somebody else's hours, rate and cost, and the approvals queue can only show another
 * person's rows to a REPORTS_VIEW holder in the first place (see timesheet.controller.ts's list).
 */
reportRouter.get("/timesheets/:id/export.csv", requirePermission(permissions.REPORTS_VIEW), async (req, res) => {
  const row = await prisma.timesheet.findFirst({
    // Soft-deleted rows stay unreachable here for the same reason every other export excludes
    // them: somebody retracted that work.
    where: { id: String(req.params.id), deletedAt: null },
    include: REPORT_INCLUDE
  });
  if (!row) throw new AppError(404, "Timesheet entry not found");

  const reviewers = await resolveReviewerNames([row]);
  const lines = [
    toCsvLine(TIMESHEET_CSV_HEADER),
    toCsvLine(timesheetCsvValues(row, row.reviewedById ? (reviewers.get(row.reviewedById) ?? "") : ""))
  ];

  const day = row.workDate.toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename=timesheet-entry-${day}-${row.id.slice(0, 8)}.csv`);
  res.setHeader("X-Report-Rows-Included", "1");
  res.send("\uFEFF" + lines.join("\n"));
});

/**
 * GET /reports/export.pdf — the same filtered set, as a document.
 *
 * TWO THINGS THIS USED TO GET WRONG, and the second was the dangerous one.
 *
 * It took no filters (`async (_req, res)`), so it was always the whole workspace.
 *
 * And it capped at `take: 500` and then printed `Entries: N  Total hours: X` computed from those
 * 500 — with nothing anywhere on the page saying it had been cut. Past 500 live entries the
 * document stated a total that was simply wrong, in a file somebody might hand to a client or an
 * auditor. A silent truncation on a report is the same class of failure as colouring an unmonitored
 * day green: it is not missing information, it is confidently asserted wrong information.
 *
 * Now the cap is high, and when it is hit the document says so in the header, in red, before any
 * numbers are read.
 */
reportRouter.get("/export.pdf", requirePermission(permissions.REPORTS_VIEW), async (req, res) => {
  const report = await loadExportDocument(req, PDF_ROW_LIMIT);

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="timesheet-report-${stamp}.pdf"`);
  // Machine-readable truncation, alongside the human-readable warning printed on the page. A
  // caller scripting this export cannot reasonably parse the PDF to discover the document is
  // partial, and "partial" is exactly the thing it must not miss.
  res.setHeader("X-Report-Total-Matching", String(report.totalMatching));
  res.setHeader("X-Report-Rows-Included", String(report.rowsIncluded));
  if (report.truncated) res.setHeader("X-Report-Truncated", "true");

  // bufferPages so the footer pass can stamp "Page X of Y" — Y does not exist until the last row
  // has been drawn.
  const doc = new PDFDocument({ size: "A4", margin: 36, bufferPages: true });
  doc.pipe(res);
  renderTimesheetReportPdf(doc, report);
  doc.end();
});
