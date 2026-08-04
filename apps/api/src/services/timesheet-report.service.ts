/**
 * WHAT: the one place a "which timesheet rows?" question is turned into a database filter, plus
 * the grouping that turns those rows into a report.
 *
 * WHY IT IS A SERVICE AND NOT THREE COPIES IN THE CONTROLLER: the CSV export, the PDF export and
 * the group-by report all answer the same question and must answer it identically. The moment
 * they each build their own `where`, they drift — and the way that failure presents is somebody
 * exporting a CSV and a PDF for "March, Project Apollo", getting different totals, and having no
 * way to tell which one is lying. Same reason the user bulk-action re-derives its filter server-side
 * instead of trusting a list of ids.
 *
 * THE PREVIOUS EXPORTS TOOK NO FILTERS AT ALL. Both handlers were `async (_req, res)` — the
 * underscore was accurate, the request was unused — and the query was `where: { deletedAt: null }`
 * and nothing else. "Export" meant every timesheet in the workspace, for all time, for everybody.
 * You could not export one project, one month, or one person.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma.js";

export type TimesheetStatusValue = "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED";

export interface TimesheetReportFilters {
  /** Inclusive, ISO yyyy-mm-dd. */
  from?: string;
  to?: string;
  projectId?: string;
  moduleId?: string;
  userId?: string;
  ticketId?: string;
  status?: TimesheetStatusValue;
  activityType?: string;
  /** Undefined means "either" — the distinction matters, because `false` is a real filter. */
  billable?: boolean;
}

/**
 * Turns a filter set into a Prisma `where`.
 *
 * `deletedAt: null` is not optional and is not exposed as a filter: a soft-deleted entry is one
 * somebody removed, and an export that resurrects it into a client-facing document would be
 * reporting work that was explicitly retracted.
 */
export function buildTimesheetWhere(filters: TimesheetReportFilters): Prisma.TimesheetWhereInput {
  const where: Prisma.TimesheetWhereInput = { deletedAt: null };

  if (filters.from || filters.to) {
    where.workDate = {
      // Dates are stored as @db.Date, so both bounds are inclusive whole days — `to` does NOT
      // need the usual "+1 day, exclusive" dance, and adding it would silently include a day the
      // person did not ask for.
      ...(filters.from ? { gte: new Date(`${filters.from}T00:00:00.000Z`) } : {}),
      ...(filters.to ? { lte: new Date(`${filters.to}T00:00:00.000Z`) } : {})
    };
  }
  if (filters.projectId) where.projectId = filters.projectId;
  if (filters.moduleId) where.moduleId = filters.moduleId;
  if (filters.userId) where.userId = filters.userId;
  if (filters.ticketId) where.ticketId = filters.ticketId;
  if (filters.status) where.status = filters.status;
  if (filters.activityType) where.activityType = filters.activityType;
  if (typeof filters.billable === "boolean") where.billable = filters.billable;

  return where;
}

/** Everything an export needs, joined once. */
export const REPORT_INCLUDE = {
  user: { select: { id: true, name: true, email: true } },
  project: { select: { id: true, name: true, code: true } },
  module: { select: { name: true } },
  submodule: { select: { name: true } },
  ticket: { select: { key: true, title: true } }
} as const;

/**
 * Reviewer names, resolved separately.
 *
 * `Timesheet.reviewedById` is a bare String with no Prisma relation behind it, so it cannot be
 * `include`d. It typechecks if you try — `TimesheetGetPayload` widens rather than erroring — and
 * then throws at runtime with "Unknown field `reviewedBy` for include statement". One extra query
 * for the whole page is cheaper than a schema migration and a foreign key, for what is a display
 * column in an export.
 */
export async function resolveReviewerNames(rows: Array<{ reviewedById: string | null }>): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => r.reviewedById).filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return new Map();
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  return new Map(users.map((u) => [u.id, u.name]));
}

export type GroupByKey = "user" | "project" | "module" | "activity" | "status" | "ticket" | "day" | "week" | "month";

export const GROUP_BY_KEYS: GroupByKey[] = [
  "user",
  "project",
  "module",
  "activity",
  "status",
  "ticket",
  "day",
  "week",
  "month"
];

export interface GroupedRow {
  key: string;
  label: string;
  entries: number;
  hours: number;
  billableHours: number;
  /** Null when NO row in this group carries a rate snapshot — see below on why that is not zero. */
  cost: number | null;
  /** How many rows in the group had no rate. Surfaced so a partial cost can be read as partial. */
  unratedEntries: number;
  people: number;
  firstDate: string | null;
  lastDate: string | null;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Monday-start ISO week key, matching the weekly AI-usage trend so two reports on the same
 *  screen cannot disagree about where a week begins. */
function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - day + 1);
  return isoDay(d);
}

type ReportRow = Prisma.TimesheetGetPayload<{ include: typeof REPORT_INCLUDE }>;

function bucketOf(row: ReportRow, groupBy: GroupByKey): { key: string; label: string } {
  switch (groupBy) {
    case "user":
      return { key: row.userId, label: row.user.name };
    case "project":
      return { key: row.projectId, label: row.project.code ? `${row.project.code} — ${row.project.name}` : row.project.name };
    case "module":
      return { key: row.moduleId, label: row.module.name };
    case "activity":
      return { key: row.activityType, label: row.activityType };
    case "status":
      return { key: row.status, label: row.status };
    case "ticket":
      // Un-ticketed work is a real, meaningful bucket rather than something to drop: for most
      // workspaces it is the majority of hours, and silently excluding it would make the report
      // understate every total.
      return row.ticket ? { key: row.ticketId!, label: `${row.ticket.key} — ${row.ticket.title}` } : { key: "__none__", label: "No ticket" };
    case "day":
      return { key: isoDay(row.workDate), label: isoDay(row.workDate) };
    case "week":
      return { key: isoWeek(row.workDate), label: `Week of ${isoWeek(row.workDate)}` };
    case "month": {
      const key = isoDay(row.workDate).slice(0, 7);
      return { key, label: key };
    }
  }
}

/**
 * Groups rows and totals them.
 *
 * COST IS NULL, NOT ZERO, WHEN NOTHING IN THE GROUP CARRIES A RATE. `billedAmount` is a snapshot
 * frozen at approval; rows approved before that feature existed have none, and they are
 * deliberately not backfilled because inventing "the rate at the time" from today's rate would
 * make the number assert something untrue. A group of entirely unrated rows therefore has no
 * cost — and reporting £0 would read as "this work was free" rather than "we do not know". Where
 * a group is partly rated, the cost is the part we know and `unratedEntries` says how much we do
 * not.
 */
export function groupTimesheetRows(rows: ReportRow[], groupBy: GroupByKey): GroupedRow[] {
  const buckets = new Map<
    string,
    { label: string; entries: number; hours: number; billableHours: number; cost: number; rated: number; unrated: number; people: Set<string>; first: string; last: string }
  >();

  for (const row of rows) {
    const { key, label } = bucketOf(row, groupBy);
    const hours = Number(row.totalHours ?? 0);
    const day = isoDay(row.workDate);
    const bucket = buckets.get(key) ?? {
      label,
      entries: 0,
      hours: 0,
      billableHours: 0,
      cost: 0,
      rated: 0,
      unrated: 0,
      people: new Set<string>(),
      first: day,
      last: day
    };

    bucket.entries += 1;
    bucket.hours += hours;
    if (row.billable) bucket.billableHours += hours;
    if (row.billedAmount != null) {
      bucket.cost += Number(row.billedAmount);
      bucket.rated += 1;
    } else {
      bucket.unrated += 1;
    }
    bucket.people.add(row.userId);
    if (day < bucket.first) bucket.first = day;
    if (day > bucket.last) bucket.last = day;
    buckets.set(key, bucket);
  }

  const rounded = (n: number) => Number(n.toFixed(2));

  return [...buckets.entries()]
    .map(([key, b]) => ({
      key,
      label: b.label,
      entries: b.entries,
      hours: rounded(b.hours),
      billableHours: rounded(b.billableHours),
      cost: b.rated === 0 ? null : rounded(b.cost),
      unratedEntries: b.unrated,
      people: b.people.size,
      firstDate: b.first,
      lastDate: b.last
    }))
    // Time buckets read chronologically; everything else reads biggest-first, because the
    // question behind a grouped report is almost always "where did the hours go".
    .sort((a, b) =>
      groupBy === "day" || groupBy === "week" || groupBy === "month"
        ? a.key.localeCompare(b.key)
        : b.hours - a.hours
    );
}

export interface TimesheetReport {
  filters: TimesheetReportFilters;
  groupBy: GroupByKey;
  totals: {
    entries: number;
    hours: number;
    billableHours: number;
    cost: number | null;
    unratedEntries: number;
    people: number;
  };
  groups: GroupedRow[];
}

/** Hard ceiling on rows pulled into memory for a grouped report. Generous, and reported rather
 *  than silent — see the controller for why a truncated report must say so. */
export const REPORT_ROW_LIMIT = 20_000;

export async function buildTimesheetReport(
  filters: TimesheetReportFilters,
  groupBy: GroupByKey
): Promise<TimesheetReport & { truncated: boolean; rowsScanned: number }> {
  const where = buildTimesheetWhere(filters);
  const rows = await prisma.timesheet.findMany({
    where,
    include: REPORT_INCLUDE,
    orderBy: [{ workDate: "asc" }, { startTime: "asc" }],
    take: REPORT_ROW_LIMIT + 1
  });

  const truncated = rows.length > REPORT_ROW_LIMIT;
  const used = truncated ? rows.slice(0, REPORT_ROW_LIMIT) : rows;
  const groups = groupTimesheetRows(used, groupBy);

  const ratedTotal = used.filter((r) => r.billedAmount != null);
  return {
    filters,
    groupBy,
    truncated,
    rowsScanned: used.length,
    totals: {
      entries: used.length,
      hours: Number(used.reduce((s, r) => s + Number(r.totalHours ?? 0), 0).toFixed(2)),
      billableHours: Number(used.filter((r) => r.billable).reduce((s, r) => s + Number(r.totalHours ?? 0), 0).toFixed(2)),
      cost: ratedTotal.length === 0 ? null : Number(ratedTotal.reduce((s, r) => s + Number(r.billedAmount ?? 0), 0).toFixed(2)),
      unratedEntries: used.length - ratedTotal.length,
      people: new Set(used.map((r) => r.userId)).size
    },
    groups
  };
}
