/**
 * What the timesheet report's download buttons send.
 *
 * THE DEFECT (audit 2026-10, notifications #6 / analytics M12): the on-screen "Group by" went along
 * for the XLSX only, so grouping the screen by Project and exporting a PDF produced a document
 * grouped by user — under a panel that promises "What you see here is exactly what the download
 * contains". The CSV is flat rows and has no grouping to carry.
 */
import { describe, expect, it } from "vitest";
import { exportParams } from "../../src/lib/report-export";

const filters = { projectId: "p-1", from: "2026-09-01" };

describe("exportParams", () => {
  it("sends the on-screen grouping with the PDF", () => {
    expect(exportParams("pdf", filters, "project")).toEqual({ ...filters, groupBy: "project" });
  });

  it("sends it with the workbook, as before", () => {
    expect(exportParams("xlsx", filters, "month")).toEqual({ ...filters, groupBy: "month" });
  });

  it("sends only the filters with the CSV, which has no grouping", () => {
    expect(exportParams("csv", filters, "project")).toEqual(filters);
  });
});
