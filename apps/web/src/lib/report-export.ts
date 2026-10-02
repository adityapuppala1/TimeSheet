import type { GroupByKey, TimesheetReportFilters } from "../services/api";

/**
 * The query a timesheet-report download is sent with.
 *
 * The on-screen grouping goes along for EVERY grouped format — the workbook's Summary sheet and the
 * PDF's sections both group. It used to go with the XLSX only, so a screen grouped by Project
 * exported a PDF grouped by user, under a panel promising the download matches the screen. The CSV
 * is flat rows, so it carries the filters alone.
 */
export function exportParams(
  type: "csv" | "pdf" | "xlsx",
  filters: TimesheetReportFilters,
  groupBy: GroupByKey
): TimesheetReportFilters & { groupBy?: GroupByKey } {
  return type === "csv" ? filters : { ...filters, groupBy };
}
