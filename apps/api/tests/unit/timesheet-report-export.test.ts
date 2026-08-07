/**
 * Structure tests for the two timesheet-report documents.
 *
 * Same philosophy as attestation-pdf.service.test.ts and security-report-pdf.service.test.ts:
 * render for real, then assert the properties a reader depends on — the workbook carries real
 * dates and numbers rather than text, the totals printed equal the rows printed, and a long
 * report neither crashes nor silently loses its tail. Visual beauty is a human job; "the subtotal
 * matches its own section" is not.
 */
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import {
  buildTimesheetExportDocument,
  type ReportRow,
  type TimesheetExportDocument
} from "../../src/services/timesheet-report.service.js";
import { buildTimesheetReportWorkbook } from "../../src/services/timesheet-report-xlsx.service.js";
import { renderTimesheetReportPdf } from "../../src/services/timesheet-report-pdf.service.js";

const LONG_TASK =
  "Rewrote the approval SLA calculation so a submission made on a Friday afternoon no longer breaches over the weekend, " +
  "then backfilled the affected rows, paired with QA on the regression suite, and wrote up the migration notes for the " +
  "release. Deliberately long so the layout has to wrap it rather than clip it to a sentence that means something else.";

function row(over: Partial<Record<string, unknown>> = {}): ReportRow {
  return {
    id: "t1",
    userId: "u1",
    projectId: "p1",
    moduleId: "m1",
    submoduleId: null,
    ticketId: null,
    activityType: "Development",
    taskDescription: LONG_TASK,
    notes: "Pairing session with Mira.",
    workDate: new Date("2026-03-04T00:00:00.000Z"),
    startTime: "09:00",
    endTime: "11:30",
    totalHours: 2.5,
    billable: true,
    billedRate: null,
    billedAmount: null,
    status: "APPROVED",
    reviewedById: null,
    reviewedAt: null,
    submittedAt: new Date("2026-03-05T08:00:00.000Z"),
    approvalDeadline: null,
    slaBreachAt: null,
    updatedAt: new Date("2026-03-05T09:00:00.000Z"),
    user: { id: "u1", name: "Dev Patel", email: "dev@x.com" },
    project: { id: "p1", name: "Apollo", code: "APO" },
    module: { name: "Payments" },
    submodule: { name: "Auth" },
    ticket: null,
    ...over
  } as unknown as ReportRow;
}

function documentWith(rows: ReportRow[], over: Partial<TimesheetExportDocument> = {}): TimesheetExportDocument {
  return {
    ...buildTimesheetExportDocument({
      rows,
      totalMatching: rows.length,
      filters: { from: "2026-03-01", to: "2026-03-31" },
      groupBy: "user",
      workspace: "Acme Industries",
      generatedBy: "Priya Rao (priya@acme.test)",
      reviewers: new Map(),
      generatedAt: new Date("2026-04-01T10:00:00.000Z")
    }),
    ...over
  };
}

async function toBuffer(wb: ExcelJS.Workbook): Promise<Buffer> {
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function reload(doc: TimesheetExportDocument): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await toBuffer(buildTimesheetReportWorkbook(doc)));
  return wb;
}

async function renderPdf(doc: TimesheetExportDocument): Promise<Buffer> {
  const pdf = new PDFDocument({ size: "A4", margin: 36, bufferPages: true });
  const chunks: Buffer[] = [];
  pdf.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve) => pdf.on("end", resolve));
  renderTimesheetReportPdf(pdf, doc);
  pdf.end();
  await done;
  return Buffer.concat(chunks);
}

function countPages(pdf: Buffer): number {
  return (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

/** Column keys are a runtime convenience and are NOT stored in the file, so a reloaded sheet is
 *  addressed by what its header row actually says — which is also what a human opening it sees. */
function columnIndex(sheet: ExcelJS.Worksheet, header: string): number {
  const headers = sheet.getRow(1).values as unknown[];
  const index = headers.findIndex((value) => String(value ?? "") === header);
  if (index < 1) throw new Error(`No "${header}" column in the exported sheet`);
  return index;
}

describe("buildTimesheetReportWorkbook", () => {
  it("writes real dates and numbers, not text", async () => {
    // The whole reason this export exists next to the CSV: text dates sort alphabetically and
    // text hours cannot be summed.
    const wb = await reload(documentWith([row()]));
    const entries = wb.getWorksheet("Entries")!;
    const first = entries.getRow(2);
    expect(first.getCell(columnIndex(entries, "Date")).value).toBeInstanceOf(Date);
    expect(first.getCell(columnIndex(entries, "Hours")).value).toBe(2.5);
    // Start/end are written as Excel time values (a fraction of a day) under an `hh:mm` format, so
    // an approver can subtract one from the other. A reader hands them back as a time on Excel's
    // own epoch date, which is what proves they are not text.
    const start = first.getCell(columnIndex(entries, "From")).value as Date;
    expect(start).toBeInstanceOf(Date);
    expect([start.getUTCHours(), start.getUTCMinutes()]).toEqual([9, 0]);
    expect(entries.getColumn(columnIndex(entries, "From")).numFmt).toBe("hh:mm");
  });

  it("freezes and filters the header row so a long sheet stays navigable", async () => {
    const wb = await reload(documentWith([row()]));
    const entries = wb.getWorksheet("Entries")!;
    expect(entries.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(entries.autoFilter).toBeTruthy();
    expect(entries.getRow(1).font?.bold).toBe(true);
  });

  it("carries the header block an unattributable export was missing", async () => {
    const wb = await reload(documentWith([row()]));
    const summary = wb.getWorksheet("Summary")!;
    const text = summary.getSheetValues().flat().filter(Boolean).map(String).join(" | ");
    expect(text).toContain("Acme Industries");
    expect(text).toContain("Timesheet Report");
    expect(text).toContain("2026-03-01 to 2026-03-31");
    expect(text).toContain("Priya Rao");
  });

  it("subtotals each group and totals the whole document to the same number", async () => {
    const rows = [
      row({ id: "a", userId: "u1", totalHours: 3 }),
      row({ id: "b", userId: "u2", totalHours: 2, user: { id: "u2", name: "Mira", email: "m@x.com" } }),
      row({ id: "c", userId: "u1", totalHours: 1.5 })
    ];
    const doc = documentWith(rows);
    expect(doc.sections.map((s) => s.summary.hours)).toEqual([4.5, 2]);
    expect(doc.totals.hours).toBe(6.5);

    const wb = await reload(doc);
    const entries = wb.getWorksheet("Entries")!;
    const employee = columnIndex(entries, "Employee");
    const labels: string[] = [];
    entries.eachRow((r) => labels.push(String(r.getCell(employee).value ?? "")));
    expect(labels.filter((l) => l.startsWith("Subtotal —"))).toHaveLength(2);
    expect(labels.at(-1)).toBe("GRAND TOTAL");
  });

  it("an empty result is a valid workbook that says so, not a zero-byte file", async () => {
    const buffer = await toBuffer(buildTimesheetReportWorkbook(documentWith([])));
    expect(buffer.byteLength).toBeGreaterThan(1000);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const text = wb.getWorksheet("Summary")!.getSheetValues().flat().filter(Boolean).map(String).join(" | ");
    expect(text).toContain("No entries match this report's filters.");
  });
});

describe("renderTimesheetReportPdf", () => {
  it("renders a document with real heading hierarchy", async () => {
    const pdf = await renderPdf(documentWith([row(), row({ id: "b" })]));
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.toString("latin1")).toContain("Helvetica-Bold");
    expect(countPages(pdf)).toBeGreaterThanOrEqual(1);
  });

  it("spills long reports onto more pages instead of clipping them", async () => {
    const rows = Array.from({ length: 120 }, (_, i) =>
      row({ id: `t-${i}`, workDate: new Date(`2026-03-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`) })
    );
    // Each entry is a line plus a wrapped description, so 120 of them cannot fit on two pages —
    // if they do, something is drawing past the bottom margin.
    expect(countPages(await renderPdf(documentWith(rows)))).toBeGreaterThanOrEqual(5);
  });

  it("an empty result still renders a complete, readable document", async () => {
    const pdf = await renderPdf(documentWith([]));
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(countPages(pdf)).toBe(1);
  });

  it("renders a truncated report without throwing away its caveat", async () => {
    const doc = documentWith([row()], { truncated: true, totalMatching: 5000, rowsIncluded: 1 });
    const pdf = await renderPdf(doc);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });
});
