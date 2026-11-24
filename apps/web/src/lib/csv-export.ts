/**
 * Client-side CSV for the Organisation tables (V17 UI v2). Cells that a spreadsheet would read as a
 * formula (leading = + - @ tab or CR, also behind leading whitespace) are prefixed with an apostrophe, so an exported name can never
 * run as one when the file is opened.
 */
export function csvCell(value: string | number | null | undefined): string {
  let text = value == null ? "" : String(value);
  if (/^\s*[=+\-@\t\r]/.test(text) && Number.isNaN(Number(text))) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(headers: readonly string[], rows: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>): string {
  return [headers, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** Saves `content` through a temporary object URL (a plain `<a href>` cannot download here). */
export function downloadText(filename: string, content: string, mime = "text/csv;charset=utf-8"): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
