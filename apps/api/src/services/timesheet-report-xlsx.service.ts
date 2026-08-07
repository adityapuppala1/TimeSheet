/**
 * WHAT: renders a timesheet report to a real workbook — a header block and grouped subtotals on
 * one sheet, every entry properly typed on another.
 *
 * WHY it's its own service rather than 120 lines inside report.controller.ts: same reason
 * attestation-pdf.service.ts and security-report-pdf.service.ts exist. A file somebody forwards
 * to a client or a payroll team earns real layout code, and the controller is a routing file.
 *
 * WHAT THE PREVIOUS VERSION GOT WRONG, and this fixes:
 *  - **No header block.** The sheet said "TimeSphere — timesheet report" and an ISO timestamp.
 *    Not who ran it, not what period it covers, not which workspace it came from — so a printed
 *    copy was unattributable.
 *  - **A flat dump.** Every row in one undifferentiated list; the person reading "how many hours
 *    did Dev bill to Apollo in March" had to pivot it themselves.
 *  - **Missing detail.** Notes never appeared at all, and start/end were text, so nobody could
 *    subtract one from the other.
 *  - **Two sources of truth.** The summary sheet was grouped over a SECOND query (up to 20k rows)
 *    while the entries sheet showed the capped set, so a truncated export shipped a summary that
 *    did not add up to its own detail.
 *
 * Colours are the app's own: `#0F9AA8` is `--primary` from apps/web/src/index.css, the same brand
 * constant the two PDF services use.
 */
import ExcelJS from "exceljs";
import { htmlToText } from "../utils/sanitize.js";
import {
  entryHours,
  reviewerNameFor,
  type ReportRow,
  type TimesheetExportDocument
} from "./timesheet-report.service.js";

/** ExcelJS wants ARGB, so every colour is the house hex with an opaque alpha in front. */
const BRAND = "FF0F9AA8";
const BRAND_TINT = "FFE6F5F7";
const BRAND_DEEP = "FF0B7A85";
const INK = "FF0F172A";
const MUTED = "FF64748B";
const DANGER = "FFDC2626";
const PAPER = "FFFFFFFF";

const DETAIL_COLUMNS = [
  { header: "Group", key: "group", width: 26 },
  { header: "Date", key: "date", width: 12 },
  { header: "Employee", key: "user", width: 22 },
  { header: "Email", key: "email", width: 28 },
  { header: "Project", key: "project", width: 24 },
  { header: "Project code", key: "projectCode", width: 14 },
  { header: "Module", key: "module", width: 20 },
  { header: "Submodule", key: "submodule", width: 20 },
  { header: "Ticket", key: "ticket", width: 14 },
  { header: "Activity", key: "activity", width: 16 },
  { header: "From", key: "start", width: 9 },
  { header: "To", key: "end", width: 9 },
  { header: "Hours", key: "hours", width: 9 },
  { header: "Billable", key: "billable", width: 10 },
  { header: "Rate", key: "rate", width: 10 },
  { header: "Amount", key: "amount", width: 12 },
  { header: "Status", key: "status", width: 12 },
  { header: "Submitted at", key: "submittedAt", width: 18 },
  { header: "Reviewed by", key: "reviewedBy", width: 20 },
  { header: "Reviewed at", key: "reviewedAt", width: 18 },
  { header: "Approval deadline", key: "deadline", width: 18 },
  { header: "SLA breached at", key: "breach", width: 18 },
  { header: "Task description", key: "task", width: 60 },
  { header: "Notes", key: "notes", width: 40 }
] as const;

/** Group label + the six figures beside it on the summary sheet. */
const SUMMARY_COLUMNS = 7;

/**
 * "09:30" as Excel's own time value — a fraction of a day, displayed by the `hh:mm` format.
 *
 * WHY NOT THE STRING: text times cannot be subtracted, so nobody could check an entry's hours
 * against its own start and end without re-typing both columns by hand. Null (blank) for anything
 * that is not a time, because a malformed value must not silently become midnight.
 */
function timeSerial(value: string | null | undefined): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value ?? "");
  if (!match) return null;
  const [hours, minutes] = [Number(match[1]), Number(match[2])];
  if (hours > 23 || minutes > 59) return null;
  return (hours * 60 + minutes) / 1440;
}

/** Fills a whole band, not only the cells that happen to carry a value — a subtotal row with a
 *  half-painted background reads as a rendering bug. */
function fill(row: ExcelJS.Row, argb: string, columns: number) {
  for (let c = 1; c <= columns; c += 1) {
    row.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb } };
  }
}

function detailValues(doc: TimesheetExportDocument, groupLabel: string, row: ReportRow) {
  return {
    group: groupLabel,
    date: row.workDate,
    user: row.user.name,
    email: row.user.email,
    project: row.project.name,
    projectCode: row.project.code,
    module: row.module.name,
    submodule: row.submodule?.name ?? "",
    ticket: row.ticket?.key ?? "",
    activity: row.activityType,
    start: timeSerial(row.startTime),
    end: timeSerial(row.endTime),
    hours: entryHours(row),
    billable: row.billable ? "Yes" : "No",
    // null, not 0 — a rate of zero claims the work was free, and these rows are deliberately
    // never backfilled (see the schema comment on billedRate).
    rate: row.billedRate == null ? null : Number(row.billedRate),
    amount: row.billedAmount == null ? null : Number(row.billedAmount),
    status: row.status,
    submittedAt: row.submittedAt,
    reviewedBy: reviewerNameFor(doc, row),
    reviewedAt: row.reviewedAt,
    deadline: row.approvalDeadline,
    breach: row.slaBreachAt,
    task: htmlToText(row.taskDescription),
    notes: htmlToText(row.notes ?? "")
  };
}

/** Sheet 1 — what the report SAYS, before anyone scrolls a single row. */
function addSummarySheet(wb: ExcelJS.Workbook, doc: TimesheetExportDocument) {
  const sheet = wb.addWorksheet("Summary", { views: [{ showGridLines: false }] });
  sheet.getColumn(1).width = 46;
  for (let c = 2; c <= 7; c += 1) sheet.getColumn(c).width = 16;

  const brandRow = sheet.addRow([doc.workspace]);
  brandRow.font = { bold: true, size: 16, color: { argb: BRAND } };
  sheet.addRow([doc.title]).font = { bold: true, size: 13, color: { argb: INK } };
  sheet.addRow([]);

  const meta: Array<[string, string]> = [
    ["Period", doc.periodLabel],
    ["Scope", doc.scopeLabel],
    ["Grouped by", doc.groupBy],
    ["Generated by", doc.generatedBy],
    ["Generated at", doc.generatedAt.toISOString().replace("T", " ").slice(0, 19) + " UTC"],
    ["Entries included", `${doc.rowsIncluded} of ${doc.totalMatching} matching`]
  ];
  for (const [label, value] of meta) {
    const row = sheet.addRow([label, value]);
    row.getCell(1).font = { bold: true, color: { argb: MUTED } };
    row.getCell(2).font = { color: { argb: INK } };
  }

  if (doc.truncated) {
    // Stated ON the sheet, not only in an HTTP header — a workbook gets forwarded without its
    // response.
    sheet.addRow([]);
    sheet.addRow([
      `TRUNCATED: this file holds the ${doc.rowsIncluded} most recent of ${doc.totalMatching} matching entries. Every total below covers only what is here.`
    ]).font = { bold: true, color: { argb: DANGER } };
  }

  sheet.addRow([]);
  sheet.addRow(["Totals"]).font = { bold: true, size: 12, color: { argb: INK } };
  const totalsHead = sheet.addRow(["Entries", "Hours", "Billable hours", "Approved hours", "People", "Cost", "Unrated entries"]);
  totalsHead.font = { bold: true, color: { argb: PAPER } };
  fill(totalsHead, BRAND, SUMMARY_COLUMNS);
  const totalsRow = sheet.addRow([
    doc.totals.entries,
    doc.totals.hours,
    doc.totals.billableHours,
    doc.approvedHours,
    doc.totals.people,
    doc.totals.cost,
    doc.totals.unratedEntries
  ]);
  totalsRow.font = { bold: true };
  for (const c of [2, 3, 4, 6]) totalsRow.getCell(c).numFmt = "#,##0.00";

  sheet.addRow([]);
  sheet.addRow([`Breakdown by ${doc.groupBy}`]).font = { bold: true, size: 12, color: { argb: INK } };
  const head = sheet.addRow(["Group", "Hours", "Billable hours", "Entries", "People", "Cost", "Unrated entries"]);
  head.font = { bold: true, color: { argb: PAPER } };
  fill(head, BRAND, SUMMARY_COLUMNS);

  if (doc.sections.length === 0) {
    sheet.addRow(["No entries match this report's filters."]).font = { italic: true, color: { argb: MUTED } };
  }
  for (const section of doc.sections) {
    const g = section.summary;
    const row = sheet.addRow([g.label, g.hours, g.billableHours, g.entries, g.people, g.cost, g.unratedEntries]);
    for (const c of [2, 3, 6]) row.getCell(c).numFmt = "#,##0.00";
  }

  const grand = sheet.addRow([
    "GRAND TOTAL",
    doc.totals.hours,
    doc.totals.billableHours,
    doc.totals.entries,
    doc.totals.people,
    doc.totals.cost,
    doc.totals.unratedEntries
  ]);
  grand.font = { bold: true, color: { argb: INK } };
  fill(grand, BRAND_TINT, SUMMARY_COLUMNS);
  for (const c of [2, 3, 6]) grand.getCell(c).numFmt = "#,##0.00";

  sheet.addRow([]);
  sheet.addRow([
    "Cost is blank where no rate was on record at approval — blank means \"not known\", never \"free\". Unrated entries counts those rows."
  ]).font = { italic: true, size: 9, color: { argb: MUTED } };
}

/** Sheet 2 — every entry, typed, grouped, and subtotalled. */
function addEntriesSheet(wb: ExcelJS.Workbook, doc: TimesheetExportDocument) {
  const sheet = wb.addWorksheet("Entries");
  sheet.columns = DETAIL_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));

  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: PAPER } };
  header.alignment = { vertical: "middle" };
  header.height = 20;
  fill(header, BRAND, DETAIL_COLUMNS.length);
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = { from: "A1", to: { row: 1, column: DETAIL_COLUMNS.length } };

  for (const section of doc.sections) {
    for (const row of section.rows) sheet.addRow(detailValues(doc, section.summary.label, row));

    // The subtotal repeats the group label in the Group column ON PURPOSE: filter the sheet down
    // to one person and their subtotal stays visible with them, instead of being hidden by the
    // filter that was supposed to isolate them.
    const subtotal = sheet.addRow({
      group: section.summary.label,
      user: `Subtotal — ${section.summary.label}`,
      hours: section.summary.hours,
      amount: section.summary.cost,
      status: `${section.summary.entries} entr${section.summary.entries === 1 ? "y" : "ies"}`
    });
    subtotal.font = { bold: true, color: { argb: BRAND_DEEP } };
    fill(subtotal, BRAND_TINT, DETAIL_COLUMNS.length);
  }

  if (doc.sections.length === 0) {
    sheet.addRow({ group: "—", user: "No entries match this report's filters." }).font = {
      italic: true,
      color: { argb: MUTED }
    };
  }

  const grand = sheet.addRow({
    user: "GRAND TOTAL",
    hours: doc.totals.hours,
    amount: doc.totals.cost,
    status: `${doc.totals.entries} entr${doc.totals.entries === 1 ? "y" : "ies"}`
  });
  grand.font = { bold: true, color: { argb: INK } };
  fill(grand, BRAND_TINT, DETAIL_COLUMNS.length);
  grand.getCell("hours").border = { top: { style: "thin", color: { argb: BRAND } } };

  // Types, not text: dates sort as dates and hours sum as numbers, which is the entire reason
  // this export exists alongside the CSV.
  sheet.getColumn("date").numFmt = "yyyy-mm-dd";
  for (const key of ["submittedAt", "reviewedAt", "deadline", "breach"]) sheet.getColumn(key).numFmt = "yyyy-mm-dd hh:mm";
  for (const key of ["start", "end"]) sheet.getColumn(key).numFmt = "hh:mm";
  sheet.getColumn("hours").numFmt = "0.00";
  for (const key of ["rate", "amount"]) sheet.getColumn(key).numFmt = "#,##0.00";
  // Long prose wraps inside its column instead of spilling across the sheet — a task description
  // is the whole point of an approver's read, and must never be clipped to look shorter than it is.
  for (const key of ["task", "notes"]) sheet.getColumn(key).alignment = { wrapText: true, vertical: "top" };
}

export function buildTimesheetReportWorkbook(doc: TimesheetExportDocument): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = doc.workspace;
  wb.lastModifiedBy = doc.generatedBy;
  wb.created = doc.generatedAt;
  wb.title = `${doc.title} — ${doc.periodLabel}`;

  addSummarySheet(wb, doc);
  addEntriesSheet(wb, doc);
  return wb;
}
