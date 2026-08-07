/**
 * WHAT: renders a filtered timesheet report to PDF — the document an approver prints, a lead
 * emails to a client, or a finance team files against an invoice.
 *
 * WHY it's its own service: same reason as attestation-pdf.service.ts and
 * security-report-pdf.service.ts — a document that travels outside the team earns real layout
 * code, and report.controller.ts is a routing file, not a typesetting one.
 *
 * WHAT THE PREVIOUS VERSION GOT WRONG, and this fixes:
 *  - **A flat list.** One row per entry, no grouping, no subtotals — so "how many hours did this
 *    person bill" was a question the reader answered with a calculator.
 *  - **Silent truncation of the text that mattered.** `taskDescription.slice(0, 110)`, with no
 *    ellipsis and nothing saying it had been cut. A description reading "fixed the auth bug and
 *    rolled back" is a different claim from the full sentence it came from. Descriptions now wrap.
 *  - **Columns drawn with `continued: true` and hand-computed padding**, which drift out of
 *    alignment the moment a name is wide. Fixed x-positions, like the other two documents.
 *  - **No page numbers.** A printed report that spills across 30 pages and cannot say which page
 *    it is on cannot be checked for completeness.
 *  - **Rows that ran off the bottom.** The break guard fired AFTER the row was drawn, so a tall
 *    row (long description) hung past the margin. Every row is measured before it is placed.
 *
 * House style shared with attestation-pdf.service.ts and security-report-pdf.service.ts: A4, 36pt
 * margins, #0F9AA8 brand (`--primary` in apps/web/src/index.css), #0F172A ink, #64748B muted,
 * #E2E8F0 rules, #94A3B8 footer, Helvetica-Bold headings, re-drawn table headers, Page N of M.
 *
 * The document is created with `bufferPages: true` by the caller — the footer pass needs the final
 * page count, which does not exist until the last row is drawn.
 */
import type PDFKit from "pdfkit";
import { htmlToText } from "../utils/sanitize.js";
import {
  entryHours,
  entryPlaceLabel,
  reviewerNameFor,
  type ReportRow,
  type TimesheetExportDocument
} from "./timesheet-report.service.js";

const BRAND = "#0F9AA8";
const BRAND_TINT = "#E6F5F7";
const INK = "#0F172A";
const MUTED = "#64748B";
const RULE = "#E2E8F0";
const RULE_LIGHT = "#F1F5F9";
const FOOTER = "#94A3B8";
const DANGER = "#DC2626";
const SUCCESS = "#16A34A";
const AMBER = "#D97706";

const LEFT = 36;
const RIGHT = 560;
const WIDTH = RIGHT - LEFT;
const PAGE_BREAK_Y = 720;
/** The last y a row may still OCCUPY. A4 is 842pt; the two footer lines sit at 782/792, so
 *  anything drawn past this collides with them. */
const CONTENT_BOTTOM = 756;

const BOLD = "Helvetica-Bold";
const REGULAR = "Helvetica";

const STATUS_COLOR: Record<string, string> = {
  APPROVED: SUCCESS,
  REJECTED: DANGER,
  SUBMITTED: AMBER,
  DRAFT: MUTED
};

/** Fixed columns for the entry table. Widths are the gap to the next column, so nothing can
 *  collide with its neighbour however long a project name is. */
const COL = { date: LEFT, who: 96, place: 214, activity: 322, time: 392, hours: 468, status: 504 };
const COL_WIDTH = {
  date: COL.who - COL.date - 6,
  who: COL.place - COL.who - 6,
  place: COL.activity - COL.place - 6,
  activity: COL.time - COL.activity - 6,
  time: COL.hours - COL.time - 6,
  hours: COL.status - COL.hours - 6,
  status: RIGHT - COL.status
};
/** Prose (task, notes) starts under the "who" column and runs to the right edge. */
const PROSE_X = COL.who;
const PROSE_WIDTH = RIGHT - PROSE_X;

function truncate(input: string, max: number): string {
  return input.length > max ? `${input.slice(0, max - 1)}…` : input;
}

function rule(doc: PDFKit.PDFDocument, color = RULE, lineWidth = 0.5) {
  doc.strokeColor(color).lineWidth(lineWidth).moveTo(LEFT, doc.y).lineTo(RIGHT, doc.y).stroke();
}

function breakIfNeeded(doc: PDFKit.PDFDocument, threshold = PAGE_BREAK_Y): boolean {
  if (doc.y > threshold) {
    doc.addPage();
    return true;
  }
  return false;
}

function sectionHeading(doc: PDFKit.PDFDocument, label: string, right?: string) {
  breakIfNeeded(doc, PAGE_BREAK_Y - 60);
  doc.moveDown(0.7);
  const y = doc.y;
  doc.font(BOLD).fontSize(11).fillColor(INK).text(truncate(label, 70), LEFT, y, { width: WIDTH - 190, lineBreak: false });
  if (right) {
    doc.font(REGULAR).fontSize(9).fillColor(MUTED).text(right, RIGHT - 190, y + 1, { width: 190, align: "right", lineBreak: false });
  }
  doc.y = y + 14;
  rule(doc);
  doc.moveDown(0.3);
}

/** One line of the header block: a fixed label column, then the value. Two independent `text`
 *  calls rather than `continued: true`, because a continued run inherits the label's width and a
 *  long scope line then wraps under the LABEL instead of under itself. */
function labelled(doc: PDFKit.PDFDocument, label: string, value: string) {
  const y = doc.y;
  doc.font(BOLD).fontSize(7.5).fillColor(MUTED).text(label.toUpperCase(), LEFT, y + 1.5, { width: 84, lineBreak: false });
  doc.font(REGULAR).fontSize(9).fillColor(INK).text(value, LEFT + 88, y, { width: WIDTH - 88 });
  doc.y = Math.max(doc.y, y + 12);
}

/** The five figures a reader who stops here still leaves with. */
function summaryStrip(doc: PDFKit.PDFDocument, cells: Array<[string, string]>) {
  const y = doc.y;
  const cellWidth = WIDTH / cells.length;
  cells.forEach(([label, value], i) => {
    const x = LEFT + i * cellWidth;
    doc.font(REGULAR).fontSize(7.5).fillColor(MUTED).text(label.toUpperCase(), x, y, { width: cellWidth - 8, lineBreak: false });
    doc.font(BOLD).fontSize(13).fillColor(INK).text(value, x, y + 11, { width: cellWidth - 8, lineBreak: false });
  });
  doc.y = y + 32;
}

function drawTableHeader(doc: PDFKit.PDFDocument, whoHeading: string) {
  const y = doc.y;
  doc.font(BOLD).fontSize(7.5).fillColor(MUTED);
  doc.text("DATE", COL.date, y, { width: COL_WIDTH.date, lineBreak: false });
  doc.text(whoHeading, COL.who, y, { width: COL_WIDTH.who, lineBreak: false });
  doc.text("MODULE", COL.place, y, { width: COL_WIDTH.place, lineBreak: false });
  doc.text("ACTIVITY", COL.activity, y, { width: COL_WIDTH.activity, lineBreak: false });
  doc.text("TIME", COL.time, y, { width: COL_WIDTH.time, lineBreak: false });
  doc.text("HOURS", COL.hours, y, { width: COL_WIDTH.hours, align: "right", lineBreak: false });
  doc.text("STATUS", COL.status, y, { width: COL_WIDTH.status, align: "right", lineBreak: false });
  doc.y = y + 11;
  rule(doc);
  doc.moveDown(0.25);
}

/**
 * What goes in the second column: whichever of person/project the section heading does NOT already
 * say. Repeating "Dev Patel" on all forty of Dev Patel's rows wastes the widest column in the
 * document; dropping the project instead would leave a per-person report unable to say what the
 * work was for.
 */
function whoValue(row: ReportRow, groupBy: string): string {
  return groupBy === "user" ? (row.project.code || row.project.name) : row.user.name;
}

/** Measured up front so a row is never STARTED at a y it cannot finish at — the bug that let a
 *  long description hang off the bottom margin. */
function entryHeight(doc: PDFKit.PDFDocument, task: string, notes: string): number {
  doc.font(REGULAR).fontSize(7.5);
  const taskHeight = task ? doc.heightOfString(task, { width: PROSE_WIDTH }) : 0;
  const notesHeight = notes ? doc.heightOfString(`Notes: ${notes}`, { width: PROSE_WIDTH }) : 0;
  return 12 + taskHeight + notesHeight + 6;
}

function drawEntry(doc: PDFKit.PDFDocument, exportDoc: TimesheetExportDocument, row: ReportRow) {
  // Collapse whitespace only — the text itself is never shortened. An approver reading a clipped
  // description is reading a different claim from the one that was made.
  const task = htmlToText(row.taskDescription).replace(/\s+/g, " ").trim();
  const notes = htmlToText(row.notes ?? "").replace(/\s+/g, " ").trim();
  const reviewer = reviewerNameFor(exportDoc, row);

  if (doc.y + entryHeight(doc, task, notes) > CONTENT_BOTTOM) {
    doc.addPage();
    drawTableHeader(doc, exportDoc.groupBy === "user" ? "PROJECT" : "EMPLOYEE");
  }

  const y = doc.y;
  doc.font(REGULAR).fontSize(8).fillColor(INK);
  doc.text(row.workDate.toISOString().slice(0, 10), COL.date, y, { width: COL_WIDTH.date, lineBreak: false });
  doc.text(truncate(whoValue(row, exportDoc.groupBy), 24), COL.who, y, { width: COL_WIDTH.who, lineBreak: false });
  doc.text(truncate(entryPlaceLabel(row), 26), COL.place, y, { width: COL_WIDTH.place, lineBreak: false });
  doc.text(truncate(row.activityType, 16), COL.activity, y, { width: COL_WIDTH.activity, lineBreak: false });
  doc.fillColor(MUTED).text(`${row.startTime}–${row.endTime}`, COL.time, y, { width: COL_WIDTH.time, lineBreak: false });
  doc.font(BOLD).fillColor(INK).text(entryHours(row).toFixed(2), COL.hours, y, {
    width: COL_WIDTH.hours,
    align: "right",
    lineBreak: false
  });
  doc.font(BOLD).fontSize(7).fillColor(STATUS_COLOR[row.status] ?? MUTED);
  doc.text(row.status, COL.status, y + 1, { width: COL_WIDTH.status, align: "right", lineBreak: false });

  doc.y = y + 11;
  if (task) {
    doc.font(REGULAR).fontSize(7.5).fillColor(MUTED).text(task, PROSE_X, doc.y, { width: PROSE_WIDTH });
  }
  if (notes) {
    doc.font(REGULAR).fontSize(7.5).fillColor(FOOTER).text(`Notes: ${notes}`, PROSE_X, doc.y, { width: PROSE_WIDTH });
  }
  if (row.ticket || reviewer) {
    const trail = [row.ticket ? `${row.ticket.key}` : null, reviewer ? `reviewed by ${reviewer}` : null]
      .filter(Boolean)
      .join("   ·   ");
    doc.font(REGULAR).fontSize(7).fillColor(FOOTER).text(trail, PROSE_X, doc.y, { width: PROSE_WIDTH });
  }

  doc.moveDown(0.3);
  rule(doc, RULE_LIGHT, 0.4);
  doc.moveDown(0.2);
}

export function renderTimesheetReportPdf(doc: PDFKit.PDFDocument, report: TimesheetExportDocument): void {
  // ---- 1. Header block ----------------------------------------------------------------------
  doc.font(BOLD).fontSize(20).fillColor(BRAND).text(report.workspace, LEFT, doc.y, { width: WIDTH - 160 });
  doc.font(BOLD).fontSize(15).fillColor(INK).text(report.title, LEFT, doc.y);
  doc.moveDown(0.5);
  labelled(doc, "Period", report.periodLabel);
  labelled(doc, "Scope", report.scopeLabel);
  labelled(doc, "Grouped by", report.groupBy);
  labelled(doc, "Generated by", report.generatedBy);
  labelled(doc, "Generated at", report.generatedAt.toLocaleString());
  doc.moveDown(0.5);

  if (report.truncated) {
    // Before any number is read: a total that silently covers part of the matching set is the
    // same class of failure as a confidently wrong figure.
    const boxY = doc.y;
    doc.rect(LEFT, boxY, WIDTH, 32).fillColor("#FEF2F2").fill();
    doc.rect(LEFT, boxY, 3, 32).fillColor(DANGER).fill();
    doc
      .font(BOLD)
      .fontSize(8.5)
      .fillColor(DANGER)
      .text(
        `Showing the ${report.rowsIncluded} most recent of ${report.totalMatching} matching entries. Every total below covers only what is printed here — narrow the date range, or use the CSV export, for the complete set.`,
        LEFT + 12,
        boxY + 7,
        { width: WIDTH - 24 }
      );
    doc.y = boxY + 40;
  }

  // ---- 2. Totals ----------------------------------------------------------------------------
  summaryStrip(doc, [
    ["Entries", String(report.totals.entries)],
    ["Total hours", report.totals.hours.toFixed(2)],
    ["Billable hours", report.totals.billableHours.toFixed(2)],
    ["Approved hours", report.approvedHours.toFixed(2)],
    ["People", String(report.totals.people)]
  ]);
  rule(doc);

  if (report.sections.length === 0) {
    doc.moveDown(2);
    doc
      .font(REGULAR)
      .fontSize(11)
      .fillColor(MUTED)
      .text("No timesheet entries match this report's filters.", LEFT, doc.y, { width: WIDTH, align: "center" });
    doc.moveDown(0.5);
    doc
      .font(REGULAR)
      .fontSize(8.5)
      .fillColor(FOOTER)
      .text("This is an empty result, not a failed export — the filters above matched nothing.", LEFT, doc.y, {
        width: WIDTH,
        align: "center"
      });
    paginate(doc, report);
    return;
  }

  // ---- 3. Breakdown, before the detail ------------------------------------------------------
  sectionHeading(doc, `Breakdown by ${report.groupBy}`);
  const headY = doc.y;
  doc.font(BOLD).fontSize(7.5).fillColor(MUTED);
  doc.text("GROUP", LEFT, headY, { width: 240, lineBreak: false });
  doc.text("ENTRIES", 300, headY, { width: 60, align: "right", lineBreak: false });
  doc.text("PEOPLE", 366, headY, { width: 60, align: "right", lineBreak: false });
  doc.text("BILLABLE", 432, headY, { width: 60, align: "right", lineBreak: false });
  doc.text("HOURS", 498, headY, { width: 62, align: "right", lineBreak: false });
  doc.y = headY + 11;
  rule(doc);
  doc.moveDown(0.25);

  for (const { summary } of report.sections) {
    breakIfNeeded(doc);
    const y = doc.y;
    doc.font(REGULAR).fontSize(8.5).fillColor(INK).text(truncate(summary.label, 46), LEFT, y, { width: 240, lineBreak: false });
    doc.fillColor(MUTED).text(String(summary.entries), 300, y, { width: 60, align: "right", lineBreak: false });
    doc.text(String(summary.people), 366, y, { width: 60, align: "right", lineBreak: false });
    doc.text(summary.billableHours.toFixed(2), 432, y, { width: 60, align: "right", lineBreak: false });
    doc.font(BOLD).fillColor(INK).text(summary.hours.toFixed(2), 498, y, { width: 62, align: "right", lineBreak: false });
    doc.y = y + 13;
  }

  breakIfNeeded(doc);
  const totalY = doc.y;
  doc.rect(LEFT, totalY - 2, WIDTH, 18).fillColor(BRAND_TINT).fill();
  doc.font(BOLD).fontSize(9).fillColor(INK).text("GRAND TOTAL", LEFT + 6, totalY + 3, { width: 240, lineBreak: false });
  doc.text(String(report.totals.entries), 300, totalY + 3, { width: 60, align: "right", lineBreak: false });
  doc.text(String(report.totals.people), 366, totalY + 3, { width: 60, align: "right", lineBreak: false });
  doc.text(report.totals.billableHours.toFixed(2), 432, totalY + 3, { width: 60, align: "right", lineBreak: false });
  doc.text(report.totals.hours.toFixed(2), 498, totalY + 3, { width: 62, align: "right", lineBreak: false });
  doc.y = totalY + 22;

  // ---- 4. Detail, one section per group -----------------------------------------------------
  const whoHeading = report.groupBy === "user" ? "PROJECT" : "EMPLOYEE";
  for (const section of report.sections) {
    const { summary } = section;
    sectionHeading(
      doc,
      summary.label,
      `${summary.entries} entr${summary.entries === 1 ? "y" : "ies"}   ·   ${summary.billableHours.toFixed(2)} billable   ·   ${summary.hours.toFixed(2)} h`
    );
    drawTableHeader(doc, whoHeading);
    for (const row of section.rows) drawEntry(doc, report, row);

    breakIfNeeded(doc);
    const y = doc.y;
    doc.font(BOLD).fontSize(8.5).fillColor(BRAND);
    doc.text(`Subtotal — ${truncate(summary.label, 40)}`, LEFT, y, { width: WIDTH - 130, lineBreak: false });
    doc.text(`${summary.hours.toFixed(2)} h`, COL.hours, y, { width: RIGHT - COL.hours, align: "right", lineBreak: false });
    doc.y = y + 14;
  }

  paginate(doc, report);
}

/** Footer pass — written last, because the page count does not exist until the last row is drawn.
 *  `bufferedPageRange` covers the pages the break logic added, which is why the caller creates the
 *  document with `bufferPages: true`. */
function paginate(doc: PDFKit.PDFDocument, report: TimesheetExportDocument) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.font(REGULAR).fontSize(7).fillColor(FOOTER);
    doc.text(`${report.workspace} · ${report.title} · ${report.periodLabel}`, LEFT, 782, { width: WIDTH - 90, lineBreak: false });
    doc.text(`Page ${i - range.start + 1} of ${range.count}`, RIGHT - 80, 782, { width: 80, align: "right", lineBreak: false });
    doc.text("Confidential — for internal operational review.", LEFT, 792, { width: WIDTH - 90, lineBreak: false });
    if (report.truncated) {
      // Repeated on every page because a long report is read from wherever it was opened, and the
      // caveat has to be where the reader is.
      doc.fillColor(DANGER).text(`Partial: ${report.rowsIncluded} of ${report.totalMatching} entries`, RIGHT - 200, 792, {
        width: 200,
        align: "right",
        lineBreak: false
      });
    }
  }
}
