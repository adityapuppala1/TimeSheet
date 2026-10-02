/**
 * WHAT: the ticket analytics behind the Insights page and the Reports page's ticket tiles —
 * `GET /reports/ticket-insights`, `/reports/ticket-summary` and `/reports/leaderboard`.
 *
 * WHY IT MOVED OUT OF THE CONTROLLER, and what each figure used to get wrong:
 *   - Weekly buckets began Monday 00:00 UTC (05:30 IST), so Monday's first hours were last week's.
 *   - "Avg. resolution" was the MEAN of the last 200 resolutions of ALL time, compared "vs last week"
 *     with a different-sized sample, and 0h when there were none. It is now the median over a stated
 *     window, compared with the same-length window before it, and null when empty.
 *   - First response was the first comment by anyone — the reporter adding detail, the intake bot
 *     echoing the email — over 500 tickets in no order, and tickets nobody had answered vanished.
 *   - The reopen rate divided "ever reopened" by "ever resolved" without intersecting them, so it
 *     could pass 100%.
 *   - The status-change log and every assigned ticket ever were loaded into Node and filtered
 *     assignees × tickets; the leaderboard read every resolved ticket of all time.
 *   - SLA figures read `slaBreachAt`, which only the TICKET_SLA_ENABLED sweep writes, so they read 0
 *     wherever the sweep is off.
 *   - AI agent identities were ranked and charted as people.
 *
 * Every definition is services/workspace-metrics.ts's. The pure helpers below are exported for tests.
 */
import { prisma } from "../config/prisma.js";
import { DAY_MS, platformDayStart, platformToday, platformWeekStart } from "../utils/date-window.js";
import { platformDayKey } from "../utils/platform-time.js";
import { resolveVisiblePeopleNames, withoutHiddenPeople } from "./people-visibility.service.js";
import { dateKeyToUtc } from "../utils/recipient-time.js";
import { isOpenTicketStatus, isResponseComment, isSlaBreached, median, openBreachedWhere, percentOf } from "./workspace-metrics.js";

const HOUR_MS = 3_600_000;
const WEEK_MS = 7 * DAY_MS;
const round1 = (n: number | null) => (n === null ? null : Number(n.toFixed(1)));
const hoursBetween = (from: Date, to: Date) => (to.getTime() - from.getTime()) / HOUR_MS;

/* ================================================================== *
 * Pure helpers
 * ================================================================== */

/**
 * `count` week starts, oldest first, ending with the current week: Monday 00:00 on the PLATFORM's
 * calendar (IST), as instants for comparing against timestamps.
 */
export function istWeekStarts(count: number, now: Date): Date[] {
  const monday = platformWeekStart(now);
  return Array.from({ length: count }, (_, i) => platformDayStart(new Date(monday.getTime() - (count - 1 - i) * WEEK_MS)));
}

/** Which bucket (index into `weekStarts`) a moment falls into, or -1 if before the first. */
export function weekIndexFor(date: Date, weekStarts: Date[]): number {
  for (let i = weekStarts.length - 1; i >= 0; i--) {
    if (date.getTime() >= weekStarts[i].getTime()) return i;
  }
  return -1;
}

/** A week start's label — its IST calendar day. */
export const weekLabel = (weekStart: Date) => platformDayKey(weekStart);

/** Median resolution time in hours over the rows given, with the sample it covers. */
export function resolutionStats(rows: Array<{ createdAt: Date; resolvedAt: Date | null }>): { medianHours: number | null; sampleSize: number } {
  const hours = rows.filter((r) => r.resolvedAt).map((r) => hoursBetween(r.createdAt, r.resolvedAt!));
  return { medianHours: round1(median(hours)), sampleSize: hours.length };
}

/**
 * Median time to the first RESPONSE (workspace-metrics.ts#isResponseComment), over the tickets
 * given. `comments` must be in ascending `createdAt` order. A ticket nobody has answered is
 * counted in `unanswered` rather than dropped — "half our tickets have no reply" is the finding.
 */
export function firstResponseStats(
  tickets: Array<{ id: string; reporterId: string; createdAt: Date }>,
  comments: Array<{ ticketId: string; authorId: string; createdAt: Date; author: { email: string; isAgent: boolean } }>
): { medianHours: number | null; sampleSize: number; unanswered: number } {
  const ticketById = new Map(tickets.map((t) => [t.id, t]));
  const firstReply = new Map<string, Date>();
  for (const comment of comments) {
    const ticket = ticketById.get(comment.ticketId);
    if (!ticket || firstReply.has(ticket.id) || !isResponseComment(comment, ticket)) continue;
    firstReply.set(ticket.id, comment.createdAt);
  }
  const hours = [...firstReply.entries()].map(([id, at]) => hoursBetween(ticketById.get(id)!.createdAt, at));
  return { medianHours: round1(median(hours)), sampleSize: hours.length, unanswered: tickets.length - firstReply.size };
}

/**
 * Of the tickets RESOLVED in the window (per the status-change log), the share later REOPENED. The
 * reopening must follow the resolution — a ticket reopened before it was resolved, or reopened
 * without being resolved in the window, is not in the ratio, so it can never pass 100%.
 *
 * Reads `ticket.status_changed` only. Every status writer is being brought onto that one action (it
 * carries `metadata.via`), so no second action name is filtered on here.
 */
export function reopenRate(
  audits: Array<{ entityId: string | null; metadata: unknown; createdAt: Date }>,
  windowStart: Date
): { reopenedCount: number; everResolvedCount: number; pct: number | null } {
  const firstResolved = new Map<string, Date>();
  const reopenings = new Map<string, Date[]>();
  for (const row of audits) {
    const to = (row.metadata as { to?: string } | null)?.to;
    if (!row.entityId || !to) continue;
    if (to === "RESOLVED" && row.createdAt >= windowStart) {
      const seen = firstResolved.get(row.entityId);
      if (!seen || row.createdAt < seen) firstResolved.set(row.entityId, row.createdAt);
    }
    if (to === "REOPENED") reopenings.set(row.entityId, [...(reopenings.get(row.entityId) ?? []), row.createdAt]);
  }
  let reopened = 0;
  for (const [id, resolvedAt] of firstResolved) {
    if ((reopenings.get(id) ?? []).some((at) => at > resolvedAt)) reopened += 1;
  }
  return { reopenedCount: reopened, everResolvedCount: firstResolved.size, pct: percentOf(reopened, firstResolved.size) };
}

/** Per resolution week, how many resolutions met their due date — `isSlaBreached`, the one rule. */
export function slaComplianceByWeek(
  resolved: Array<{ resolvedAt: Date | null; dueAt: Date | null }>,
  weekStarts: Date[]
): Array<{ weekStart: string; compliant: number; breached: number; pct: number | null }> {
  const weeks = weekStarts.map((w) => ({ weekStart: weekLabel(w), compliant: 0, breached: 0 }));
  for (const t of resolved) {
    if (!t.dueAt || !t.resolvedAt) continue;
    const i = weekIndexFor(t.resolvedAt, weekStarts);
    if (i < 0) continue;
    if (isSlaBreached(t, t.resolvedAt)) weeks[i].breached += 1;
    else weeks[i].compliant += 1;
  }
  return weeks.map((w) => ({ ...w, pct: percentOf(w.compliant, w.compliant + w.breached) }));
}

const CYCLE_TIME_BUCKETS = [
  { label: "< 4h", maxHours: 4 },
  { label: "4-24h", maxHours: 24 },
  { label: "1-3d", maxHours: 72 },
  { label: "3-7d", maxHours: 168 },
  { label: "7-14d", maxHours: 336 },
  { label: "14d+", maxHours: Infinity }
];

/* ================================================================== *
 * /reports/ticket-insights
 * ================================================================== */

/** People only: an AI agent's tickets are not a person's workload. */
const PERSON_ASSIGNEE = { assignee: { isAgent: false } };

async function workloadHeatmap(heatmapWeeks: Date[], now: Date) {
  const heatmapStart = heatmapWeeks[0];
  // Only tickets that were open at some point during the heatmap's weeks: created before now, and
  // not resolved before the first week began. Every assigned ticket ever was loaded before.
  const assignedTickets = await prisma.ticket.findMany({
    where: {
      deletedAt: null,
      assigneeId: { not: null },
      ...PERSON_ASSIGNEE,
      createdAt: { lt: now },
      OR: [{ resolvedAt: null }, { resolvedAt: { gte: heatmapStart } }]
    },
    select: { assigneeId: true, createdAt: true, resolvedAt: true }
  });
  const ticketsByAssignee = new Map<string, typeof assignedTickets>();
  for (const t of assignedTickets) ticketsByAssignee.set(t.assigneeId!, [...(ticketsByAssignee.get(t.assigneeId!) ?? []), t]);

  // Narrowed to people still shown BEFORE the sort and the top-15 cut, not after: filtering a ranked
  // list afterwards would let a departed colleague hold one of the fifteen slots.
  const assignedIds = [...ticketsByAssignee.keys()];
  const names = await resolveVisiblePeopleNames(assignedIds);
  const visibleIds = assignedIds.filter((id) => names.has(id));
  const hoursRows = visibleIds.length
    ? await prisma.timesheet.findMany({
        // `workDate` is a calendar day: the heatmap's first IST Monday as that day's date value.
        where: { deletedAt: null, userId: { in: visibleIds }, workDate: { gte: dateKeyToUtc(weekLabel(heatmapStart)) } },
        select: { userId: true, workDate: true, totalHours: true }
      })
    : [];
  const hoursByUser = new Map<string, typeof hoursRows>();
  for (const h of hoursRows) hoursByUser.set(h.userId, [...(hoursByUser.get(h.userId) ?? []), h]);

  const rows = visibleIds
    .map((assigneeId) => {
      const tickets = ticketsByAssignee.get(assigneeId) ?? [];
      const hours = hoursByUser.get(assigneeId) ?? [];
      const cells = heatmapWeeks.map((weekStart) => {
        const weekEnd = new Date(weekStart.getTime() + WEEK_MS);
        const firstDay = platformDayKey(weekStart);
        const lastDay = platformDayKey(new Date(weekEnd.getTime() - 1));
        const openCount = tickets.filter((t) => t.createdAt < weekEnd && (!t.resolvedAt || t.resolvedAt >= weekEnd)).length;
        const hoursLogged = hours
          .filter((h) => {
            const key = h.workDate.toISOString().slice(0, 10);
            return key >= firstDay && key <= lastDay;
          })
          .reduce((sum, h) => sum + Number(h.totalHours), 0);
        return { weekStart: firstDay, openCount, hoursLogged: Number(hoursLogged.toFixed(1)) };
      });
      return { assigneeId, assigneeName: names.get(assigneeId)!, cells, totalOpen: cells.reduce((s, c) => s + c.openCount, 0) };
    })
    .sort((a, b) => b.totalOpen - a.totalOpen)
    .slice(0, 15);

  return { weeks: heatmapWeeks.map(weekLabel), rows, hiddenInactive: assignedIds.length - visibleIds.length };
}

async function estimateVsActual() {
  const ticketsWithEstimate = await prisma.ticket.findMany({
    where: { deletedAt: null, estimatedHours: { not: null } },
    select: { id: true, key: true, title: true, estimatedHours: true }
  });
  const actuals = await prisma.timesheet.groupBy({
    by: ["ticketId"],
    where: { deletedAt: null, ticketId: { in: ticketsWithEstimate.map((t) => t.id) } },
    _sum: { totalHours: true }
  });
  const actualBy = new Map(actuals.map((a) => [a.ticketId, Number(a._sum.totalHours ?? 0)]));
  return ticketsWithEstimate
    .map((t) => {
      const actual = actualBy.get(t.id) ?? 0;
      const estimated = Number(t.estimatedHours);
      return { ticketKey: t.key, title: t.title, estimatedHours: estimated, actualHours: actual, varianceHours: Number((actual - estimated).toFixed(2)) };
    })
    .filter((row) => row.actualHours > 0)
    .sort((a, b) => Math.abs(b.varianceHours) - Math.abs(a.varianceHours))
    .slice(0, 50);
}

/**
 * Everything the Insights page shows, over the last eight IST weeks (the heatmap: six). Every figure
 * is over that stated window — nothing here is "all time" any more.
 */
export async function buildTicketInsights(now: Date = new Date()) {
  const velocityWeeks = istWeekStarts(8, now);
  const heatmapWeeks = istWeekStarts(6, now);
  const rangeStart = velocityWeeks[0];

  const [createdInRange, resolvedInRange, moduleGroups, statusChangeAudits, createdTickets, comments] = await Promise.all([
    prisma.ticket.findMany({ where: { deletedAt: null, createdAt: { gte: rangeStart } }, select: { createdAt: true } }),
    prisma.ticket.findMany({ where: { deletedAt: null, resolvedAt: { gte: rangeStart } }, select: { createdAt: true, resolvedAt: true, dueAt: true } }),
    prisma.ticket.groupBy({
      by: ["moduleId"],
      where: { deletedAt: null, moduleId: { not: null } },
      _count: true,
      orderBy: { _count: { moduleId: "desc" } },
      take: 10
    }),
    // The window only. A reopening of a ticket resolved inside it can only happen inside it too.
    prisma.auditLog.findMany({
      where: { action: "ticket.status_changed", entity: "Ticket", createdAt: { gte: rangeStart } },
      select: { entityId: true, metadata: true, createdAt: true }
    }),
    // First response: tickets raised in the window, and the comments on them in time order.
    prisma.ticket.findMany({
      where: { deletedAt: null, createdAt: { gte: rangeStart } },
      select: { id: true, reporterId: true, createdAt: true }
    }),
    prisma.ticketComment.findMany({
      where: { ticket: { deletedAt: null, createdAt: { gte: rangeStart } } },
      select: { ticketId: true, authorId: true, createdAt: true, author: { select: { email: true, isAgent: true } } },
      orderBy: { createdAt: "asc" }
    })
  ]);

  const velocity = velocityWeeks.map((w) => ({ weekStart: weekLabel(w), created: 0, resolved: 0 }));
  for (const t of createdInRange) {
    const i = weekIndexFor(t.createdAt, velocityWeeks);
    if (i >= 0) velocity[i].created += 1;
  }
  for (const t of resolvedInRange) {
    const i = weekIndexFor(t.resolvedAt!, velocityWeeks);
    if (i >= 0) velocity[i].resolved += 1;
  }

  // Cycle time over the same eight weeks of resolutions — it was "the last 300 of all time".
  const cycleTimeHistogram = CYCLE_TIME_BUCKETS.map((b) => ({ bucket: b.label, count: 0 }));
  for (const t of resolvedInRange) {
    const hours = hoursBetween(t.createdAt, t.resolvedAt!);
    const idx = CYCLE_TIME_BUCKETS.findIndex((b) => hours < b.maxHours);
    cycleTimeHistogram[idx === -1 ? CYCLE_TIME_BUCKETS.length - 1 : idx].count += 1;
  }

  const moduleIds = moduleGroups.map((g) => g.moduleId).filter((id): id is string => Boolean(id));
  const modules = moduleIds.length
    ? await prisma.projectModule.findMany({ where: { id: { in: moduleIds } }, select: { id: true, name: true, project: { select: { name: true } } } })
    : [];
  const moduleById = new Map(modules.map((m) => [m.id, m]));

  return {
    window: { from: weekLabel(rangeStart), weeks: velocityWeeks.length },
    velocity,
    slaCompliance: slaComplianceByWeek(resolvedInRange, velocityWeeks),
    cycleTimeHistogram,
    hotspotByModule: moduleGroups.map((g) => {
      const mod = g.moduleId ? moduleById.get(g.moduleId) : undefined;
      return { moduleId: g.moduleId, moduleName: mod?.name ?? "Unknown", projectName: mod?.project.name ?? "Unknown", count: g._count };
    }),
    reopenRate: reopenRate(statusChangeAudits, rangeStart),
    firstResponseHours: firstResponseStats(createdTickets, comments),
    workloadHeatmap: await workloadHeatmap(heatmapWeeks, now),
    estimateVsActual: await estimateVsActual()
  };
}

/* ================================================================== *
 * /reports/ticket-summary
 * ================================================================== */

/** The resolution-time window, stated on the page: four weeks against the four before. */
export const RESOLUTION_WINDOW_DAYS = 28;
const PRIORITY_ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];

export async function buildTicketSummary(now: Date = new Date()) {
  // Week to date on the IST calendar against the same weekdays last week — not a rolling 168 hours.
  const weekStart = platformDayStart(platformWeekStart(now));
  const lastWeekStart = new Date(weekStart.getTime() - WEEK_MS);
  const lastWeekSameMoment = new Date(now.getTime() - WEEK_MS);
  const resolutionFrom = new Date(platformDayStart(platformToday(now)).getTime() - (RESOLUTION_WINDOW_DAYS - 1) * DAY_MS);
  const resolutionPrevFrom = new Date(resolutionFrom.getTime() - RESOLUTION_WINDOW_DAYS * DAY_MS);

  const [byStatus, byPriority, byAssignee, openSlaBreaches, createdThisWeek, resolvedThisWeek, resolvedLastWeek, resolvedRecent, resolvedPrior] =
    await Promise.all([
      prisma.ticket.groupBy({ by: ["status"], where: { deletedAt: null }, _count: true }),
      prisma.ticket.groupBy({ by: ["priority"], where: { deletedAt: null }, _count: true }),
      prisma.ticket.groupBy({ by: ["assigneeId"], where: { deletedAt: null, assigneeId: { not: null }, ...PERSON_ASSIGNEE }, _count: true }),
      // Open and past due NOW — from `dueAt`, so it holds whether or not the SLA sweep runs. A
      // point-in-time figure, so no "vs yesterday".
      prisma.ticket.count({ where: { deletedAt: null, ...openBreachedWhere(now) } }),
      prisma.ticket.count({ where: { deletedAt: null, createdAt: { gte: weekStart } } }),
      prisma.ticket.count({ where: { deletedAt: null, resolvedAt: { gte: weekStart } } }),
      prisma.ticket.count({ where: { deletedAt: null, resolvedAt: { gte: lastWeekStart, lt: lastWeekSameMoment } } }),
      prisma.ticket.findMany({ where: { deletedAt: null, resolvedAt: { gte: resolutionFrom } }, select: { createdAt: true, resolvedAt: true } }),
      prisma.ticket.findMany({
        where: { deletedAt: null, resolvedAt: { gte: resolutionPrevFrom, lt: resolutionFrom } },
        select: { createdAt: true, resolvedAt: true }
      })
    ]);

  // Prisma groupBy can't include relations, so assignee names come from a second query. People who
  // are no longer shown are dropped from the per-person rows; the status counts keep their tickets.
  const assignees = await resolveVisiblePeopleNames(byAssignee.map((row) => row.assigneeId));
  const visibleByAssignee = withoutHiddenPeople(byAssignee, (row) => row.assigneeId, assignees);
  const resolution = resolutionStats(resolvedRecent);
  const resolutionPrev = resolutionStats(resolvedPrior);

  return {
    total: byStatus.reduce((sum, row) => sum + row._count, 0),
    byStatus,
    // Fixed severity order, not whatever order the database grouped them in.
    byPriority: [...byPriority].sort((a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority)),
    byAssignee: visibleByAssignee.rows.map((row) => ({ ...row, assignee: assignees.get(row.assigneeId!)! })),
    hiddenInactiveAssignees: visibleByAssignee.hiddenInactive,
    openTickets: byStatus.filter((row) => isOpenTicketStatus(row.status)).reduce((s, r) => s + r._count, 0),
    openSlaBreaches,
    createdThisWeek,
    resolvedThisWeek,
    resolvedLastWeek,
    /** Median hours, created → resolved, over the last RESOLUTION_WINDOW_DAYS; null when none. */
    resolution: { ...resolution, windowDays: RESOLUTION_WINDOW_DAYS, prevMedianHours: resolutionPrev.medianHours, prevSampleSize: resolutionPrev.sampleSize }
  };
}

/* ================================================================== *
 * /reports/leaderboard
 * ================================================================== */

/** The leaderboard's window — recognition for recent work, not a fixed all-time table nobody can climb. */
export const LEADERBOARD_WINDOW_DAYS = 90;

export async function buildLeaderboard(now: Date = new Date()) {
  const since = new Date(platformDayStart(platformToday(now)).getTime() - (LEADERBOARD_WINDOW_DAYS - 1) * DAY_MS);
  const resolved = await prisma.ticket.findMany({
    where: { deletedAt: null, resolvedAt: { gte: since }, assigneeId: { not: null }, ...PERSON_ASSIGNEE },
    select: { assigneeId: true, createdAt: true, resolvedAt: true }
  });
  const cycleHoursBy = new Map<string, number[]>();
  for (const t of resolved) cycleHoursBy.set(t.assigneeId!, [...(cycleHoursBy.get(t.assigneeId!) ?? []), hoursBetween(t.createdAt, t.resolvedAt!)]);

  // A ranking of people, so it ranks people who are here: a departed high performer would otherwise
  // hold first place with nobody able to overtake them.
  const users = await resolveVisiblePeopleNames(cycleHoursBy.keys());
  const ids = [...cycleHoursBy.keys()].filter((id) => users.has(id));
  const rows = ids
    .map((id) => {
      const hours = cycleHoursBy.get(id)!;
      return { assigneeId: id, assigneeName: users.get(id)!, resolvedCount: hours.length, medianCycleHours: round1(median(hours)) };
    })
    .sort((a, b) => b.resolvedCount - a.resolvedCount);
  return { windowDays: LEADERBOARD_WINDOW_DAYS, rows, hiddenInactive: cycleHoursBy.size - ids.length };
}
