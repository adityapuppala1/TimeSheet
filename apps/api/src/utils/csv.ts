/**
 * WHAT: the two rules that make a CSV survive Excel, in one place.
 *
 * WHY IT IS ITS OWN FILE: every exporter in this app needs the same escaping, and the failure of
 * getting it wrong is silent — a description containing a comma or a newline does not error, it
 * shifts every later column on that row, or splits one record across two. That is the kind of bug
 * that reaches an auditor before it reaches a developer.
 */

/** RFC 4180 line ending. CRLF, not LF: Excel on Windows treats a lone LF inside a quoted field
 *  inconsistently, and CRLF is what the spec actually says. */
export const CSV_EOL = "\r\n";

/** Prepended so Excel opens the file as UTF-8 rather than guessing a legacy code page and turning
 *  every accented name into mojibake. */
export const UTF8_BOM = "﻿";

/**
 * One field, escaped.
 *
 * Newlines are collapsed to spaces rather than quoted-and-preserved: a quoted newline is legal
 * RFC 4180 and still renders as a split row in several spreadsheet tools, and a rich-text
 * description is the field most likely to contain one.
 */
export function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value).replace(/[\r\n]+/g, " ").trim();
  // Quotes are doubled, and any field carrying a delimiter, a quote or a leading/trailing space is
  // wrapped — the three cases that otherwise corrupt the row.
  return /["|,]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
