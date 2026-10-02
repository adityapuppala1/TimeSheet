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
  TIMESHEET_CSV_HEADER,
  timesheetCsvValues,
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

  describe("money in more than one currency", () => {
    // Each entry's cost is frozen at approval in its project's billing currency. A workspace with an
    // INR project and a USD project used to get one "Cost" column adding rupees to dollars — on the
    // document people forward to clients.
    const ANA = { userId: "u2", user: { id: "u2", name: "Ana", email: "a@x.com" } };
    const mixed = () => [
      row({ id: "a", billedRate: 1000, billedAmount: 2000, billedCurrency: "INR" }),
      row({ id: "b", billedRate: 1000, billedAmount: 1000, billedCurrency: "INR" }),
      row({ id: "c", billedRate: 25, billedAmount: 50, billedCurrency: "USD", ...ANA })
    ];

    /** The summary sheet's rows as arrays of cell values (1-based, as ExcelJS hands them back). */
    function summaryRows(wb: ExcelJS.Workbook): unknown[][] {
      const out: unknown[][] = [];
      wb.getWorksheet("Summary")!.eachRow((r) => out.push(r.values as unknown[]));
      return out;
    }

    it("gives each currency its own Cost column on the summary sheet, for totals, groups and the grand total", async () => {
      const rows = summaryRows(await reload(documentWith(mixed())));
      const totalsHead = rows.find((r) => r[1] === "Entries")!;
      const breakdownHead = rows.find((r) => r[1] === "Group")!;
      for (const head of [totalsHead, breakdownHead]) {
        expect(head).toContain("Cost (INR)");
        expect(head).toContain("Cost (USD)");
        expect(head).not.toContain("Cost");
      }
      const at = (r: unknown[], head: unknown[], label: string) => r[head.indexOf(label)] ?? null;

      const totals = rows[rows.indexOf(totalsHead) + 1];
      expect([at(totals, totalsHead, "Cost (INR)"), at(totals, totalsHead, "Cost (USD)")]).toEqual([3000, 50]);
      const dev = rows.find((r) => r[1] === "Dev Patel")!;
      expect([at(dev, breakdownHead, "Cost (INR)"), at(dev, breakdownHead, "Cost (USD)")]).toEqual([3000, null]);
      const grand = rows.find((r) => r[1] === "GRAND TOTAL")!;
      expect([at(grand, breakdownHead, "Cost (INR)"), at(grand, breakdownHead, "Cost (USD)")]).toEqual([3000, 50]);
      // The cross-currency sum appears nowhere.
      expect(rows.flat()).not.toContain(3050);
    });

    it("keeps a single Cost column when there is one currency", async () => {
      const rows = summaryRows(await reload(documentWith(mixed().slice(0, 2))));
      const totalsHead = rows.find((r) => r[1] === "Entries")!;
      expect(totalsHead.filter((v) => String(v).startsWith("Cost"))).toEqual(["Cost (INR)"]);
      expect(rows[rows.indexOf(totalsHead) + 1][totalsHead.indexOf("Cost (INR)")]).toBe(3000);
    });

    it("labels every entry with its currency and subtotals each currency on its own line", async () => {
      const wb = await reload(documentWith(mixed()));
      const entries = wb.getWorksheet("Entries")!;
      const [employee, amount, currency] = ["Employee", "Amount", "Currency"].map((h) => columnIndex(entries, h));
      // Currency sits immediately after Amount, so the figure and its unit read together.
      expect(currency).toBe(amount + 1);

      const lines: Array<{ who: string; amount: unknown; currency: unknown }> = [];
      entries.eachRow((r, n) => {
        if (n > 1) lines.push({ who: String(r.getCell(employee).value ?? ""), amount: r.getCell(amount).value, currency: r.getCell(currency).value });
      });
      expect(lines.filter((l) => l.who === "Dev Patel").map((l) => l.currency)).toEqual(["INR", "INR"]);
      const devSubtotal = lines.find((l) => l.who === "Subtotal — Dev Patel")!;
      expect([devSubtotal.amount, devSubtotal.currency]).toEqual([3000, "INR"]);

      // The grand total is one line per currency: its own line, then a continuation line.
      const grandAt = lines.findIndex((l) => l.who === "GRAND TOTAL");
      expect(lines.slice(grandAt).map((l) => [l.amount, l.currency])).toEqual([[3000, "INR"], [50, "USD"]]);
      expect(lines.map((l) => l.amount)).not.toContain(3050);
    });
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

describe("the CSV export", () => {
  it("states each entry's currency right after its amount", () => {
    const amountAt = TIMESHEET_CSV_HEADER.indexOf("Amount");
    expect(TIMESHEET_CSV_HEADER[amountAt + 1]).toBe("Currency");
    const values = timesheetCsvValues(row({ billedRate: 25, billedAmount: 62.5, billedCurrency: "USD" }), "");
    expect(values).toHaveLength(TIMESHEET_CSV_HEADER.length);
    expect([values[amountAt], values[amountAt + 1]]).toEqual(["62.50", "USD"]);
    // Unrated: no amount and no currency, never "0.00".
    const unrated = timesheetCsvValues(row(), "");
    expect([unrated[amountAt], unrated[amountAt + 1]]).toEqual(["", ""]);
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
