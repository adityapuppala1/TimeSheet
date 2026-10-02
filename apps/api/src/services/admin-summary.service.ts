/**
 * WHAT: the workspace summary behind the home page's admin cards (the workforce card, the stat
 * tiles, the project-hours chart) and the Reports page's tile row — `GET /reports/admin-summary`.
 *
 * WHY IT MOVED OUT OF THE CONTROLLER: it had grown to ~33 queries with each figure defined inline,
 * and several of those inline definitions were wrong in ways nothing on screen could reveal:
 *   - the workforce card divided loggers of ANY role, deactivated people included, by active
 *     employees and team leads — AI agent identities among them, because an agent is an ACTIVE
 *     EMPLOYEE row — so the two sides were different people and the share could pass 100%;
 *   - its "vs YTD avg/day" compared distinct people over a whole range with an average per
 *     CALENDAR day, weekends included;
 *   - "Approved hours" was all-time under a picker that says it governs every card;
 *   - point-in-time tiles (users, projects, pending, escalations) compared "now" with "those that
 *     already existed before the period", a delta that can only go up;
 *   - "Approved this week" counted entries over a rolling 168 hours;
 *   - "Tickets closed" read `updatedAt`, so editing an old ticket closed it again;
 *   - every timestamp window began at UTC midnight, 05:30 IST.
 *
 * THE RULES NOW, so the next figure added here follows them:
 *   - definitions come from services/workspace-metrics.ts (logged hours, open/closed tickets);
 *   - a POINT-IN-TIME figure is reported as "now" and carries no delta;
 *   - a PERIOD figure is reported with its like-for-like comparison (utils/date-window.ts: the same
 *     weekdays whole weeks earlier, to the same point) under a label the page prints;
 *   - an empty denominator is null, never 0%.
 */
import { Prisma, type TicketStatus } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import {
  DAY_MS,
  parseDayWindow,
  platformToday,
  platformWeekStart,
  resolveDayComparison,
  resolveTimestampWindow
} from "../utils/date-window.js";
import { countApprovalSlaBreaches } from "./approval-sla-breaches.service.js";
import { isChangeManagementOn } from "./change.service.js";
import { COUNTED_PEOPLE } from "./people-visibility.service.js";
import { workingDaysBetween } from "./plan-schedule.service.js";
import { getPlanningSettings } from "./planning.service.js";
import { awaitingReviewWhere, loadApprovalAuthority } from "./timesheet-approval-scope.service.js";
import { CLOSED_TICKET_STATUSES, LOGGED_TIMESHEET_STATUSES, percentOf } from "./workspace-metrics.js";

/**
 * The people expected to fill a timesheet every working day: active employees and team leads who
 * are people. The daily reminder worker's population (workers/daily-reminder.worker.ts), minus AI
 * agent identities, which that worker should not be nagging either. BOTH sides of the workforce
 * card are this set — that is the whole fix.
 */
export const WORKFORCE_WHERE = {
  status: "ACTIVE",
  deletedAt: null,
  isAgent: false,
  role: { name: { in: ["EMPLOYEE", "TEAM_LEAD"] } }
} satisfies Prisma.UserWhereInput;

type DateRange = { gte: Date; lte: Date };
type InstantRange = { gte: Date; lt?: Date };

const round2 = (n: number) => Number(n.toFixed(2));
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Distinct (person, day) pairs on WORKING days in [from, to] for the workforce — the numerator of
 * "people logging per working day". One aggregate row from the database: the year-to-date version
 * used to pull every distinct pair into Node on each 30-second poll.
 */
async function countPersonDays(from: Date, to: Date, workingDays: number[]): Promise<number> {
  if (to < from || workingDays.length === 0) return 0;
  // MySQL's DAYOFWEEK is 1 (Sunday) … 7 (Saturday); the workspace stores 0 (Sunday) … 6.
  const mysqlDays = workingDays.map((d) => d + 1);
  const rows = await prisma.$queryRaw<Array<{ n: bigint | number }>>`
    SELECT COUNT(DISTINCT t.userId, t.workDate) AS n
    FROM Timesheet t
    JOIN User u ON u.id = t.userId
    JOIN Role r ON r.id = u.roleId
    WHERE t.deletedAt IS NULL
      AND t.workDate >= ${from} AND t.workDate <= ${to}
      AND DAYOFWEEK(t.workDate) IN (${Prisma.join(mysqlDays)})
      AND u.status = 'ACTIVE' AND u.deletedAt IS NULL AND u.isAgent = false
      AND r.name IN ('EMPLOYEE', 'TEAM_LEAD')
  `;
  return Number(rows[0]?.n ?? 0);
}

/** Distinct workforce members with at least one entry in the day range. "Filled" is any entry —
 *  the reminder worker's own test for "did they log today", so the card and the reminders agree. */
async function workforceLoggers(days: DateRange): Promise<number> {
  const rows = await prisma.timesheet.findMany({
    where: { workDate: days, deletedAt: null, user: WORKFORCE_WHERE },
    select: { userId: true },
    distinct: ["userId"]
  });
  return rows.length;
}

async function workforceSnapshot(days: DateRange, prevDays: DateRange, now: Date, workingDays: number[]) {
  const today = platformToday(now);
  const yearStart = new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
  const yesterday = new Date(today.getTime() - DAY_MS);
  // The period's working days SO FAR — the average must not divide by days that have not happened.
  const periodEnd = days.lte > today ? today : days.lte;
  const periodWorkingDays = periodEnd < days.gte ? 0 : workingDaysBetween(days.gte, periodEnd, workingDays);
  const ytdWorkingDays = yesterday < yearStart ? 0 : workingDaysBetween(yearStart, yesterday, workingDays);

  const [population, logged, loggedPrev, periodPersonDays, ytdPersonDays] = await Promise.all([
    prisma.user.count({ where: WORKFORCE_WHERE }),
    workforceLoggers(days),
    workforceLoggers(prevDays),
    countPersonDays(days.gte, periodEnd, workingDays),
    countPersonDays(yearStart, yesterday, workingDays)
  ]);
  const perDay = (personDays: number, workingDayCount: number) =>
    workingDayCount > 0 ? round2(personDays / workingDayCount) : null;
  return {
    population,
    logged,
    notLogged: Math.max(0, population - logged),
    loggedPrev,
    /** Null, not a red 0%, when there is nobody to measure. */
    loggedPct: percentOf(logged, population),
    /** People logging per working day in the period so far, and year-to-date (to yesterday). Same
     *  population, same unit, so the two can be compared. */
    avgPerWorkingDay: perDay(periodPersonDays, periodWorkingDays),
    ytdAvgPerWorkingDay: perDay(ytdPersonDays, ytdWorkingDays),
    workingDays: periodWorkingDays
  };
}

/** Approved hours, IST week to date, against the same weekdays of last week. */
async function approvedWeekToDate(now: Date) {
  const today = platformToday(now);
  const monday = platformWeekStart(now);
  const sum = (gte: Date, lte: Date) =>
    prisma.timesheet
      .aggregate({ where: { status: "APPROVED", deletedAt: null, workDate: { gte, lte } }, _sum: { totalHours: true } })
      .then((r) => round2(Number(r._sum.totalHours ?? 0)));
  const week = 7 * DAY_MS;
  const [thisWeek, lastWeek] = await Promise.all([
    sum(monday, today),
    sum(new Date(monday.getTime() - week), new Date(today.getTime() - week))
  ]);
  return { thisWeek, lastWeek };
}

/** Tickets that reached done inside a window: resolved in it, or closed in it without having been
 *  resolved first. `updatedAt` moves on every edit, so it cannot say when a ticket was closed. */
function closedInWindow(window: InstantRange): Prisma.TicketWhereInput {
  return {
    deletedAt: null,
    status: { in: CLOSED_TICKET_STATUSES as TicketStatus[] },
    OR: [{ resolvedAt: window }, { resolvedAt: null, closedAt: window }]
  };
}

export async function buildAdminSummary(
  query: { from?: unknown; to?: unknown },
  now: Date = new Date(),
  options: { viewerId?: string } = {}
) {
  // "Pending approvals" is the approvals queue's own count for THIS viewer — SUBMITTED, not their
  // own, not their managers' (timesheet-approval-scope.service.ts). Without a viewer it falls back to
  // every SUBMITTED row, which is what a caller with no person behind it can mean.
  const awaitingReview = options.viewerId
    ? awaitingReviewWhere(await loadApprovalAuthority(options.viewerId))
    : { status: "SUBMITTED" as const, deletedAt: null };
  const window = parseDayWindow(query);
  const day = resolveDayComparison(window, now);
  const stamps = resolveTimestampWindow(window, now);
  const settings = await getPlanningSettings();
  const workingDays = settings.workingDays;

  const inDays: DateRange = { gte: day.from, lte: day.to };
  const prevDays: DateRange = { gte: day.prevFrom, lte: day.prevTo };
  const inWindow: InstantRange = { gte: stamps.start, ...(stamps.end ? { lt: stamps.end } : {}) };
  const inPrevWindow: InstantRange = { gte: stamps.prevStart, lt: stamps.prevEnd };
  const logged = { status: { in: LOGGED_TIMESHEET_STATUSES } };
  /** Hours/status/activity breakdowns are scoped to the range when there is one, and left
   *  unfiltered when there is not — which is what they have always done. */
  const breakdownWhere: Prisma.TimesheetWhereInput = window.ranged ? { deletedAt: null, workDate: inDays } : { deletedAt: null };

  const [
    users,
    usersJoined,
    projects,
    projectsCreated,
    pendingApprovals,
    openEscalations,
    byStatusNow,
    byStatusPrev,
    byProject,
    byStatus,
    byActivity,
    remindersSent,
    remindersSentPrev,
    escalationsSent,
    escalationsSentPrev,
    workforce,
    week,
    slaBreached,
    slaBreachedPrev
  ] = await Promise.all([
    prisma.user.count({ where: COUNTED_PEOPLE }),
    prisma.user.count({ where: { ...COUNTED_PEOPLE, createdAt: inWindow } }),
    prisma.project.count({ where: { deletedAt: null } }),
    prisma.project.count({ where: { deletedAt: null, createdAt: inWindow } }),
    prisma.timesheet.count({ where: awaitingReview }),
    prisma.escalation.count({ where: { resolvedAt: null } }),
    prisma.timesheet.groupBy({ by: ["status"], where: { deletedAt: null, workDate: inDays }, _sum: { totalHours: true } }),
    prisma.timesheet.groupBy({ by: ["status"], where: { deletedAt: null, workDate: prevDays }, _sum: { totalHours: true } }),
    // "Project hours" — LOGGED hours per project (workspace-metrics.ts). There is no capacity in it,
    // which is why the card is no longer called utilisation.
    prisma.timesheet.groupBy({ by: ["projectId"], where: { ...breakdownWhere, ...logged }, _sum: { totalHours: true }, _count: true }),
    prisma.timesheet.groupBy({ by: ["status"], where: breakdownWhere, _sum: { totalHours: true }, _count: true }),
    prisma.timesheet.groupBy({ by: ["activityType"], where: { ...breakdownWhere, ...logged }, _sum: { totalHours: true }, _count: true }),
    prisma.notification.count({ where: { category: "reminder.daily", createdAt: inWindow } }),
    prisma.notification.count({ where: { category: "reminder.daily", createdAt: inPrevWindow } }),
    prisma.notification.count({ where: { category: "reminder.escalation", createdAt: inWindow } }),
    prisma.notification.count({ where: { category: "reminder.escalation", createdAt: inPrevWindow } }),
    workforceSnapshot(inDays, prevDays, now, workingDays),
    approvedWeekToDate(now),
    // Counted in the database (approval-sla-breaches.service.ts): this endpoint is polled.
    countApprovalSlaBreaches(inWindow, now),
    countApprovalSlaBreaches(inPrevWindow, now)
  ]);

  const projectNames = await prisma.project.findMany({
    where: { id: { in: byProject.map((row) => row.projectId) } },
    // code included for the chart axes: two full project names ate the whole axis while the bars
    // between them went unlabeled — the code is the identifier people already use in ticket keys.
    select: { id: true, name: true, code: true }
  });
  const projectById = new Map(projectNames.map((p) => [p.id, p]));

  // Ticket and change activity for the SAME window the logging figures use, so the card's rows are
  // comparable. A failure to read the change setting must not take the home page down with it.
  const changesOn = await isChangeManagementOn().catch(() => false);
  const [ticketsRaised, ticketsRaisedPrev, ticketsClosed, ticketsClosedPrev, changesRaised, changesRaisedPrev, changesClosed, changesClosedPrev] =
    await Promise.all([
      prisma.ticket.count({ where: { deletedAt: null, createdAt: inWindow } }),
      prisma.ticket.count({ where: { deletedAt: null, createdAt: inPrevWindow } }),
      prisma.ticket.count({ where: closedInWindow(inWindow) }),
      prisma.ticket.count({ where: closedInWindow(inPrevWindow) }),
      changesOn ? prisma.changeRequest.count({ where: { createdAt: inWindow } }) : Promise.resolve(0),
      changesOn ? prisma.changeRequest.count({ where: { createdAt: inPrevWindow } }) : Promise.resolve(0),
      changesOn ? prisma.changeRequest.count({ where: { closedAt: inWindow } }) : Promise.resolve(0),
      changesOn ? prisma.changeRequest.count({ where: { closedAt: inPrevWindow } }) : Promise.resolve(0)
    ]);

  const hoursIn = (groups: Array<{ status: string; _sum: { totalHours: unknown } }>, statuses: string[]) =>
    round2(groups.filter((g) => statuses.includes(g.status)).reduce((s, g) => s + Number(g._sum.totalHours ?? 0), 0));
  /** Null, not zero, when change management is off — the card drops the tiles rather than
   *  claiming a measurement of something this workspace does not do. */
  const ifChanges = (n: number) => (changesOn ? n : null);

  return {
    period: {
      from: isoDay(day.from),
      to: isoDay(day.to),
      ranged: window.ranged,
      comparisonFrom: isoDay(day.prevFrom),
      comparisonTo: isoDay(day.prevTo),
      comparisonLabel: day.label
    },
    // ---- point in time ("now"): no deltas. Each states what changed in the period instead.
    users,
    usersJoined,
    projects,
    projectsCreated,
    pendingApprovals,
    openEscalations,
    // ---- the period, each with its like-for-like comparison
    approvedHours: hoursIn(byStatusNow, ["APPROVED"]),
    approvedHoursPrev: hoursIn(byStatusPrev, ["APPROVED"]),
    loggedHours: hoursIn(byStatusNow, LOGGED_TIMESHEET_STATUSES),
    loggedHoursPrev: hoursIn(byStatusPrev, LOGGED_TIMESHEET_STATUSES),
    slaBreached,
    slaBreachedPrev,
    approvedThisWeek: week.thisWeek,
    approvedLastWeek: week.lastWeek,
    workforce,
    remindersSent,
    remindersSentPrev,
    escalationsSent,
    escalationsSentPrev,
    ticketsRaised,
    ticketsRaisedPrev,
    ticketsClosed,
    ticketsClosedPrev,
    changesRaised: ifChanges(changesRaised),
    changesRaisedPrev: ifChanges(changesRaisedPrev),
    changesClosed: ifChanges(changesClosed),
    changesClosedPrev: ifChanges(changesClosedPrev),
    byProject: byProject.map((row) => {
      const project = projectById.get(row.projectId);
      return { ...row, project: project?.name ?? "Unknown", projectCode: project?.code ?? null };
    }),
    byStatus,
    byActivity
  };
}
