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
 * CSV / formula injection guard. A cell a spreadsheet would evaluate (= + - @, or a tab or CR in
 * front of one, after any leading whitespace) gets an apostrophe in front, the OWASP mitigation.
 * A plain number ("-2.5") is not a formula and is left as a number.
 */
export function neutraliseFormula(text: string): string {
  if (!/^\s*[=+\-@\t\r]/.test(text)) return text;
  if (/^[+-]?\d+(\.\d+)?$/.test(text)) return text;
  return `'${text}`;
}

/**
 * One field, escaped.
 *
 * Newlines are collapsed to spaces rather than quoted-and-preserved: a quoted newline is legal
 * RFC 4180 and still renders as a split row in several spreadsheet tools, and a rich-text
 * description is the field most likely to contain one.
 */
export function csvCell(value: unknown): string {
  // Neutralised AFTER normalising and trimming: checking first let " =cmd" or "\n=cmd" through,
  // because the trim then put the "=" at the front of the cell.
  const text = neutraliseFormula(value === null || value === undefined ? "" : String(value).replace(/[\r\n]+/g, " ").trim());
  // Quotes are doubled, and any field carrying a delimiter, a quote or a leading/trailing space is
  // wrapped — the three cases that otherwise corrupt the row.
  return /["|,]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
