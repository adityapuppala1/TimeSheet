/**
 * WHAT: the daily history behind the Tickets page's metric cards — how many tickets sat in each
 * status and each priority at the end of every day in a trailing window.
 *
 * WHY IT IS RECONSTRUCTED RATHER THAN STORED: nothing in this schema snapshots a queue nightly, and
 * adding a rollup table to draw a sparkline would be a second source of truth for a number the
 * ticket rows already determine. So this walks BACKWARDS from the counts as they stand right now,
 * undoing the events that produced them — which means the last point of every series is, by
 * construction, the same number the card's headline shows. A series computed independently of that
 * headline is a series that can disagree with it.
 *
 * WHAT MAKES IT EXACT, AND WHERE IT IS NOT:
 *  - STATUS is exact. Every transition is audited as `ticket.status_changed` with `{from, to}`, and
 *    every creation is a row with a `createdAt`, so both directions of movement are recoverable.
 *  - PRIORITY is exact except for a ticket whose priority was CHANGED inside the window.
 *    `ticket.updated` records the new value without the old one, so a re-prioritised ticket is
 *    attributed to its current bucket for the whole window. Re-prioritising is rare and the
 *    headline number is always the exact live count; `priorityExact` on the result says whether any
 *    such change happened in the window, so a caller can label the series honestly rather than
 *    having to assume.
 *
 * WHAT BOUNDS THE COST: both queries are limited to the window, so this reads events — not tickets.
 * A workspace with 100k tickets and 30 created this week fetches 30 rows, not 100k.
 */
import { ticketPriorities, ticketStatuses } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";

/** How many daily points a card's sparkline draws. Two weeks reads as a trend without becoming a
 *  chart that needs axes to be legible at 180px wide. */
export const METRIC_WINDOW_DAYS = 14;

/** A hard stop so a workspace that imported a hundred thousand tickets last Tuesday cannot turn one
 *  page load into an unbounded read. Hitting it is reported, never silently truncated. */
const MAX_WINDOW_EVENTS = 20_000;

export interface TicketMetricSeries {
  /** ISO `YYYY-MM-DD`, oldest first. The last entry is today. */
  days: string[];
  total: number[];
  byStatus: Record<string, number[]>;
  byPriority: Record<string, number[]>;
  /** False when a priority was reassigned inside the window — see the file header. */
  priorityExact: boolean;
  /** True when the event cap was hit and the series is therefore incomplete. */
  truncated: boolean;
}

/** UTC midnight opening the day `daysAgo` days before today. UTC throughout, matching every other
 *  date bucket in this codebase — a local-time boundary would shift the whole series for anybody in
 *  a different timezone from the server. */
function startOfUtcDay(daysAgo: number): Date {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d;
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

type WindowEvent =
  | { at: Date; kind: "create"; ticketId: string; priority: string }
  | { at: Date; kind: "status"; ticketId: string; from: string; to: string };

/**
 * @param where       the SAME Prisma filter the live counts were taken under, so the history is a
 *                    history OF those counts and not of some wider set.
 * @param nowByStatus live counts per status — the series' final point.
 * @param nowByPriority likewise per priority.
 */
export async function buildTicketMetricSeries(
  where: Record<string, unknown>,
  nowByStatus: Record<string, number>,
  nowByPriority: Record<string, number>
): Promise<TicketMetricSeries> {
  const windowStart = startOfUtcDay(METRIC_WINDOW_DAYS - 1);

  // Tickets born inside the window, with the status they are in NOW. Walking backwards turns that
  // into the status they were in at any earlier moment.
  const created = await prisma.ticket.findMany({
    where: { ...where, createdAt: { gte: windowStart } },
    select: { id: true, createdAt: true, status: true, priority: true },
    take: MAX_WINDOW_EVENTS
  });

  const transitions = await prisma.auditLog.findMany({
    where: { entity: "Ticket", action: "ticket.status_changed", createdAt: { gte: windowStart } },
    select: { entityId: true, createdAt: true, metadata: true },
    orderBy: { createdAt: "desc" },
    take: MAX_WINDOW_EVENTS
  });

  // An audit row carries no project, so the caller's scope cannot be expressed in its query. Vet the
  // ticket ids it named against the same `where` instead — bounded by the number of transitions in
  // the window, never by the size of the workspace. Without this a scoped user's sparkline would be
  // nudged by movement on tickets they cannot see.
  const transitionIds = [...new Set(transitions.map((t) => t.entityId).filter((id): id is string => Boolean(id)))];
  const visibleIds = new Set<string>(
    transitionIds.length === 0
      ? []
      : (await prisma.ticket.findMany({ where: { ...where, id: { in: transitionIds } }, select: { id: true } })).map((t) => t.id)
  );

  // Did anything get re-prioritised in the window? If so the priority series is an approximation and
  // says so, rather than quietly presenting itself as measured.
  const reprioritised = await prisma.auditLog.count({
    where: {
      entity: "Ticket",
      action: "ticket.updated",
      createdAt: { gte: windowStart },
      // Prisma cannot index into JSON portably here, so this is a substring test on the serialised
      // metadata. It over-counts (an update mentioning the word elsewhere also matches) and never
      // under-counts, which is the safe direction for a flag that only ever downgrades a claim.
      metadata: { string_contains: "priority" }
    }
  });

  const events: WindowEvent[] = [
    ...created.map((t) => ({ at: t.createdAt, kind: "create" as const, ticketId: t.id, priority: String(t.priority) })),
    ...transitions
      .filter((row) => row.entityId && visibleIds.has(row.entityId))
      .map((row) => {
        const meta = (row.metadata ?? {}) as { from?: string; to?: string };
        return { at: row.createdAt, kind: "status" as const, ticketId: row.entityId!, from: String(meta.from ?? ""), to: String(meta.to ?? "") };
      })
      .filter((e) => e.from && e.to)
  ].sort((a, b) => b.at.getTime() - a.at.getTime());

  // Running state, walked from now into the past.
  const statusCounts: Record<string, number> = { ...nowByStatus };
  const priorityCounts: Record<string, number> = { ...nowByPriority };
  // Only tickets born in the window need per-ticket tracking: undoing their creation has to remove
  // them from whichever status they were in AT creation, which is what reverse replay reveals.
  const statusOfCreated = new Map(created.map((t) => [t.id, String(t.status)]));

  const days: string[] = [];
  const total: number[] = [];
  // Seeded from the ENUMS, not from the live counts: a status sitting at zero today may have held
  // tickets last week, and keying off `nowByStatus` would drop that bucket's series entirely — the
  // card would render an empty chart for exactly the movement worth seeing. Allocated up front so
  // every bucket is guaranteed a full-length array, whatever the replay does or does not touch.
  const statusKeys = [...new Set<string>([...ticketStatuses, ...Object.keys(nowByStatus)])];
  const priorityKeys = [...new Set<string>([...ticketPriorities, ...Object.keys(nowByPriority)])];
  const byStatus: Record<string, number[]> = Object.fromEntries(statusKeys.map((k) => [k, [] as number[]]));
  const byPriority: Record<string, number[]> = Object.fromEntries(priorityKeys.map((k) => [k, [] as number[]]));

  /** Reverses one event, moving the running counts one step further into the past. */
  const undo = (event: WindowEvent) => {
    if (event.kind === "status") {
      // Undo B←A: the ticket goes back to where it came from.
      statusCounts[event.to] = (statusCounts[event.to] ?? 0) - 1;
      statusCounts[event.from] = (statusCounts[event.from] ?? 0) + 1;
      if (statusOfCreated.has(event.ticketId)) statusOfCreated.set(event.ticketId, event.from);
      return;
    }
    // Undo the creation: before this instant the ticket did not exist at all.
    const status = statusOfCreated.get(event.ticketId);
    if (status) statusCounts[status] = (statusCounts[status] ?? 0) - 1;
    priorityCounts[event.priority] = (priorityCounts[event.priority] ?? 0) - 1;
  };

  let cursor = 0;
  for (let i = 0; i < METRIC_WINDOW_DAYS; i++) {
    const dayStart = startOfUtcDay(i);
    // Snapshot BEFORE undoing this day's events: the counts as they stand are the end of this day
    // (and, for i = 0, the state right now).
    days.unshift(dayKey(dayStart));
    let dayTotal = 0;
    for (const key of statusKeys) {
      // Clamped at zero: an audit trail that disagrees with the live counts (a hard-deleted ticket,
      // a back-dated import) must degrade to an empty bucket, never to a chart below its own axis.
      const value = Math.max(0, statusCounts[key] ?? 0);
      byStatus[key].unshift(value);
      dayTotal += value;
    }
    for (const key of priorityKeys) {
      byPriority[key].unshift(Math.max(0, priorityCounts[key] ?? 0));
    }
    total.unshift(dayTotal);

    while (cursor < events.length && events[cursor].at >= dayStart) undo(events[cursor++]);
  }

  return {
    days,
    total,
    byStatus,
    byPriority,
    priorityExact: reprioritised === 0,
    truncated: created.length >= MAX_WINDOW_EVENTS || transitions.length >= MAX_WINDOW_EVENTS
  };
}


/**
 * The series the metric cards actually consume, assembled under the RIGHT filter for each dimension.
 *
 * The tallies deliberately exclude the axis being counted — a status tally filtered by status would
 * report the selected status and zero for everything else — which means the two dimensions can sit
 * under different filters. When they do, their histories have to as well, or a card's sparkline
 * would end somewhere other than the number printed above it. When no cross-axis filter is set (the
 * default view, and the overwhelmingly common one) both dimensions share a filter and one
 * reconstruction serves both.
 */
export async function buildTicketMetricSeriesFor(args: {
  statusWhere: Record<string, unknown>;
  priorityWhere: Record<string, unknown>;
  crossFiltered: boolean;
  byStatus: Record<string, number>;
  byPriority: Record<string, number>;
}): Promise<TicketMetricSeries> {
  if (!args.crossFiltered) {
    return buildTicketMetricSeries(args.statusWhere, args.byStatus, args.byPriority);
  }
  const [statusSide, prioritySide] = await Promise.all([
    buildTicketMetricSeries(args.statusWhere, args.byStatus, {}),
    buildTicketMetricSeries(args.priorityWhere, {}, args.byPriority)
  ]);
  return {
    days: statusSide.days,
    // The total follows the STATUS side: it is the same set of tickets the status cards add up to,
    // and picking one keeps "All tickets" reconcilable against the row beneath it.
    total: statusSide.total,
    byStatus: statusSide.byStatus,
    byPriority: prioritySide.byPriority,
    priorityExact: prioritySide.priorityExact,
    truncated: statusSide.truncated || prioritySide.truncated
  };
}
