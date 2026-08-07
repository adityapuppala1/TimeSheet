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
import { calculateHours } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { htmlToText } from "../utils/sanitize.js";

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

export type ReportRow = Prisma.TimesheetGetPayload<{ include: typeof REPORT_INCLUDE }>;

/**
 * The hours of ONE entry, and the only place any report is allowed to ask.
 *
 * `totalHours` is authoritative: it is what `calculateHours` produced when the entry was written
 * (timesheet.controller.ts), and re-deriving it here would let an export disagree with the screen
 * the entry was logged on. The fallback exists only for a row that carries no stored total, and it
 * calls THE SAME helper rather than an inline `end - start` — an export that rounds or wraps
 * midnight differently from the write path is the failure this function prevents.
 */
export function entryHours(row: {
  totalHours?: Prisma.Decimal | number | null;
  startTime?: string | null;
  endTime?: string | null;
}): number {
  if (row.totalHours != null) return Number(row.totalHours);
  if (row.startTime && row.endTime) return calculateHours(row.startTime, row.endTime);
  return 0;
}

/**
 * The export's columns, and the one function that fills them.
 *
 * WHY HERE RATHER THAN INLINE IN THE CSV HANDLER: the approvals queue exports ONE entry, the
 * report screen exports many, and both are the same document at different cardinalities. Two
 * builders drift — and the way that drift presents is an approver exporting a row to attach to a
 * decision, then finding it has different columns (or a different idea of what an unrated row
 * costs) from the workspace export the same row appears in.
 */
export const TIMESHEET_CSV_HEADER = [
  "User", "Email", "Date", "Project", "Project code", "Module", "Submodule", "Ticket",
  "Activity", "Start", "End", "Hours", "Billable", "Rate", "Amount", "Status",
  "Reviewed by", "Reviewed at", "Approval deadline", "SLA breached at", "Task", "Notes",
  "Submitted at", "Last updated"
] as const;

export function timesheetCsvValues(row: ReportRow, reviewerName: string): Array<string | null | undefined> {
  const iso = (value: Date | null | undefined) => (value ? value.toISOString() : "");
  return [
    row.user.name, row.user.email, row.workDate.toISOString().slice(0, 10),
    row.project.name, row.project.code, row.module.name, row.submodule?.name,
    row.ticket?.key,
    row.activityType, row.startTime, row.endTime,
    entryHours(row).toFixed(2),
    row.billable ? "Yes" : "No",
    // Blank rather than 0 when unrated: a rate of zero is a claim that the work was free, and
    // these rows are deliberately never backfilled (see the schema comment on billedRate).
    row.billedRate == null ? "" : Number(row.billedRate).toFixed(2),
    row.billedAmount == null ? "" : Number(row.billedAmount).toFixed(2),
    row.status,
    reviewerName,
    iso(row.reviewedAt), iso(row.approvalDeadline), iso(row.slaBreachAt),
    htmlToText(row.taskDescription), htmlToText(row.notes ?? ""),
    iso(row.submittedAt), iso(row.updatedAt)
  ];
}

/** Every field is quoted unconditionally — a task description containing a comma, a newline or a
 *  quote is the normal case here, not the edge case. */
export function toCsvLine(values: ReadonlyArray<string | null | undefined>): string {
  return values.map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`).join(",");
}

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
    const hours = entryHours(row);
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
  totals: TimesheetTotals;
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

  return {
    filters,
    groupBy,
    truncated,
    rowsScanned: used.length,
    totals: summariseTimesheetRows(used),
    groups: groupTimesheetRows(used, groupBy)
  };
}

/* ------------------------------------------------------------------------------------------ *
 * EXPORT DOCUMENT — the shape both the workbook and the PDF are rendered from.
 *
 * WHY IT IS ASSEMBLED HERE rather than in each renderer: the XLSX and the PDF are the same
 * document in two formats, and the moment each one groups and totals its own rows they drift.
 * The way that drift presents is somebody comparing the spreadsheet a colleague sent with the PDF
 * they printed, finding different subtotals, and having no way to tell which is lying — the same
 * failure the top of this file exists to prevent for filters.
 * ------------------------------------------------------------------------------------------ */

export interface TimesheetTotals {
  entries: number;
  hours: number;
  billableHours: number;
  cost: number | null;
  unratedEntries: number;
  people: number;
}

/** Grand totals over exactly the rows a document PRINTS — never over a wider query. A total that
 *  covers rows the reader cannot see is the truncation bug this report already had once. */
export function summariseTimesheetRows(rows: ReportRow[]): TimesheetTotals {
  const rated = rows.filter((r) => r.billedAmount != null);
  const round = (n: number) => Number(n.toFixed(2));
  return {
    entries: rows.length,
    hours: round(rows.reduce((s, r) => s + entryHours(r), 0)),
    billableHours: round(rows.filter((r) => r.billable).reduce((s, r) => s + entryHours(r), 0)),
    cost: rated.length === 0 ? null : round(rated.reduce((s, r) => s + Number(r.billedAmount ?? 0), 0)),
    unratedEntries: rows.length - rated.length,
    people: new Set(rows.map((r) => r.userId)).size
  };
}

/** One printed section: the group's own subtotal line plus the entries behind it. */
export interface TimesheetExportSection {
  summary: GroupedRow;
  rows: ReportRow[];
}

/**
 * Splits rows into printable sections, ordered and totalled by `groupTimesheetRows`.
 *
 * Deliberately delegating the ordering and the arithmetic means a section heading can never
 * disagree with the summary table above it — they are literally the same object.
 */
export function buildTimesheetSections(rows: ReportRow[], groupBy: GroupByKey): TimesheetExportSection[] {
  const byKey = new Map<string, ReportRow[]>();
  for (const row of rows) {
    const { key } = bucketOf(row, groupBy);
    const list = byKey.get(key);
    if (list) list.push(row);
    else byKey.set(key, [row]);
  }
  for (const list of byKey.values()) {
    // Within a person (or a project) a timesheet reads forwards, whatever order the query
    // returned — the query sorts newest-first so that a TRUNCATED export keeps the most recent
    // work, which is a different question from how a section should read.
    list.sort((a, b) => a.workDate.getTime() - b.workDate.getTime() || a.startTime.localeCompare(b.startTime));
  }
  return groupTimesheetRows(rows, groupBy).map((summary) => ({ summary, rows: byKey.get(summary.key) ?? [] }));
}

/** A human-readable one-liner describing what was filtered, printed onto every export so the
 *  document states its own scope. A report that does not say what it covers invites being read as
 *  covering everything. */
export function describeReportFilters(filters: TimesheetReportFilters): string {
  const parts: string[] = [];
  if (filters.from || filters.to) parts.push(`${filters.from ?? "start"} to ${filters.to ?? "today"}`);
  if (filters.status) parts.push(`status ${filters.status}`);
  if (filters.activityType) parts.push(`activity ${filters.activityType}`);
  if (typeof filters.billable === "boolean") parts.push(filters.billable ? "billable only" : "non-billable only");
  return parts.length ? parts.join(" · ") : "all entries, all time";
}

/**
 * The date range the document actually covers.
 *
 * When no bounds were asked for, the answer is the range of the rows themselves rather than the
 * words "all time": a header that says "all time" over a set that happens to stop in March reads
 * as a claim that nothing was logged afterwards.
 */
export function describeReportPeriod(filters: TimesheetReportFilters, rows: ReportRow[]): string {
  if (filters.from && filters.to) return `${filters.from} to ${filters.to}`;
  const days = rows.map((r) => isoDay(r.workDate)).sort();
  const covered = days.length > 0 ? `${days[0]} to ${days[days.length - 1]}` : null;
  if (filters.from) return `${filters.from} onwards${covered ? ` (covering ${covered})` : ""}`;
  if (filters.to) return `up to ${filters.to}${covered ? ` (covering ${covered})` : ""}`;
  return covered ? `All dates (${covered})` : "All dates";
}

export interface TimesheetExportDocument {
  workspace: string;
  title: string;
  periodLabel: string;
  scopeLabel: string;
  generatedBy: string;
  generatedAt: Date;
  groupBy: GroupByKey;
  /** What the document prints vs what the filter matched — never equal silently. */
  rowsIncluded: number;
  totalMatching: number;
  truncated: boolean;
  sections: TimesheetExportSection[];
  totals: TimesheetTotals;
  approvedHours: number;
  /** `Timesheet.reviewedById` has no relation behind it — see `resolveReviewerNames`. */
  reviewers: Map<string, string>;
}

export function buildTimesheetExportDocument(input: {
  rows: ReportRow[];
  totalMatching: number;
  filters: TimesheetReportFilters;
  groupBy: GroupByKey;
  workspace: string;
  generatedBy: string;
  reviewers: Map<string, string>;
  generatedAt?: Date;
}): TimesheetExportDocument {
  const { rows, filters, groupBy } = input;
  return {
    workspace: input.workspace,
    title: "Timesheet Report",
    periodLabel: describeReportPeriod(filters, rows),
    scopeLabel: describeReportFilters(filters),
    generatedBy: input.generatedBy,
    generatedAt: input.generatedAt ?? new Date(),
    groupBy,
    rowsIncluded: rows.length,
    totalMatching: input.totalMatching,
    truncated: input.totalMatching > rows.length,
    sections: buildTimesheetSections(rows, groupBy),
    totals: summariseTimesheetRows(rows),
    approvedHours: Number(
      rows
        .filter((r) => r.status === "APPROVED")
        .reduce((s, r) => s + entryHours(r), 0)
        .toFixed(2)
    ),
    reviewers: input.reviewers
  };
}

/** Display helpers shared by both renderers, so "—" means the same thing in each. */
export function reviewerNameFor(doc: TimesheetExportDocument, row: ReportRow): string {
  return row.reviewedById ? (doc.reviewers.get(row.reviewedById) ?? "") : "";
}

export function entryPlaceLabel(row: ReportRow): string {
  return row.submodule?.name ? `${row.module.name} › ${row.submodule.name}` : row.module.name;
}
