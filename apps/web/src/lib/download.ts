/**
 * Save a blob the browser already has.
 *
 * WHY A HELPER: this is six lines every export in the app needs, and the two that get dropped when
 * it is retyped are `revokeObjectURL` — a leak that only shows up after a long session of exports —
 * and appending the anchor before clicking it, which some browsers require for a programmatic
 * click to do anything at all.
 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** The date every export filename carries, so two files downloaded on the same day sort together. */
export function exportStamp(): string {
  return new Date().toISOString().slice(0, 10);
}
