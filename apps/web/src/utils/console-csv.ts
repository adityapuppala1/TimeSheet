/**
 * WHAT: CSV export for the platform console's data tables.
 *
 * ONE RULE, AND IT IS THE WHOLE REASON THIS FILE EXISTS: an export carries WHAT THE OPERATOR IS
 * LOOKING AT. Every console table already has a search box, a status filter and a sort; a button
 * that quietly ignores all three and dumps the raw table is not a shortcut, it is a support ticket
 * — somebody filters to twelve suspended workspaces, exports, opens four hundred rows in a
 * spreadsheet, and either notices and mistrusts the button forever or does not notice and sends the
 * wrong list to somebody. So `toCsv` takes ROWS, and every call site is required to hand it the
 * array it has already filtered and sorted rather than the query cache's.
 *
 * WHY IT IS A BLOB AND NOT AN `<a href>`. The same reason `platformAdminApi.downloadBackup` gives:
 * this console authenticates with an in-memory bearer token and its refresh cookie is path-scoped
 * to `/auth`, so a plain link to any API route downloads a 401 page with a `.csv` name — which is
 * the worst kind of failure, because it looks like it worked. Here the rows are already in the
 * browser, so nothing needs to be fetched at all: the file is built from what is on screen, which
 * is also what makes "exports the filter" true by construction rather than by a second server-side
 * implementation of every filter.
 *
 * THE ESCAPING IS NOT DECORATION. A workspace is named by a stranger at signup, and the fields here
 * legitimately contain commas, quotes and newlines. Excel and Sheets both read RFC 4180: wrap in
 * double quotes, double any interior quote. Getting it wrong shifts every later column by one,
 * silently, in a file somebody then makes a decision from.
 */

/** One column: its header, and how to read it out of a row. */
export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number | boolean | null | undefined;
}

/**
 * RFC 4180 for one field.
 *
 * ALWAYS QUOTED, not only when it has to be. A conditional quote is a second rule to get wrong and
 * buys nothing but a few bytes, and a value that is empty today can contain a comma tomorrow.
 *
 * The leading apostrophe on a value starting with `=`, `+`, `-` or `@` is a CSV-injection guard,
 * not tidiness: Excel and Sheets evaluate such a cell as a formula, so a workspace named
 * `=HYPERLINK(...)` becomes a live link in an operator's spreadsheet. Prefixing is the mitigation
 * OWASP recommends and is what every export in this repo does.
 */
export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '""';
  const raw = String(value);
  const guarded = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${guarded.replaceAll('"', '""')}"`;
}

/**
 * Rows to a CSV document.
 *
 * `\r\n` line endings, deliberately: RFC 4180 specifies them and Excel on Windows — where most of
 * these files are opened — still treats a bare `\n` file as one long line in some locales.
 */
export function toCsv<T>(columns: Array<CsvColumn<T>>, rows: T[]): string {
  const lines = [columns.map((column) => csvCell(column.header)).join(",")];
  for (const row of rows) lines.push(columns.map((column) => csvCell(column.value(row))).join(","));
  return lines.join("\r\n");
}

/** `organizations-2026-08-31.csv` — dated, because an operator ends up with several and an
 *  undated one is indistinguishable from last month's. */
export const csvFileName = (base: string, at = new Date()): string => `${base}-${at.toISOString().slice(0, 10)}.csv`;

/**
 * The byte-order mark, CONSTRUCTED rather than typed.
 *
 * It is what makes Excel open a UTF-8 file as UTF-8 rather than as the local codepage — without it,
 * a workspace named "Grüner Weg" arrives as mojibake in the one application these files are most
 * often opened in. `String.fromCharCode` and not the literal character, because a raw U+FEFF in
 * source is invisible in every editor and every diff, which is exactly why `no-irregular-whitespace`
 * refuses it.
 */
const UTF8_BOM = String.fromCharCode(0xfeff);

/** Hand the file to the browser. */
export function downloadCsv(fileName: string, csv: string): void {
  const blob = new Blob([`${UTF8_BOM}${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** The whole export, in one call, so a page never assembles the three steps differently. */
export function exportCsv<T>(base: string, columns: Array<CsvColumn<T>>, rows: T[]): void {
  downloadCsv(csvFileName(base), toCsv(columns, rows));
}
