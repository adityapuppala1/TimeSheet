/**
 * WHAT: turn an ordered list of rows into ordered runs that share a group key — the one pure
 * step behind every "Group by" the app renders (DataTable's table and card views, the Tickets
 * page's own phone cards).
 *
 * WHY RUNS AND NOT A MAP: the caller has already sorted the rows the way it wants them shown,
 * with the group column as the primary sort. Grouping must not re-order anything or it silently
 * undoes the person's secondary sort. Runs preserve order exactly; a group that is split by the
 * caller's ordering (which cannot happen when the group column sorts first) would simply appear
 * twice, which is the honest rendering of that input.
 *
 * WHY THE LABEL IS FORMATTED HERE: status/priority values are enum tokens ("IN_PROGRESS"); a
 * header row should read "In progress". One rule, tested, not a `.replace` per call site.
 */

export interface GroupRun<T> {
  /** The raw grouping value, stringified — stable for keys and collapse state. */
  key: string;
  label: string;
  count: number;
  rows: T[];
}

export const EMPTY_GROUP_LABEL = "Unassigned";

/** "IN_PROGRESS" → "In progress"; "Backend team" stays as typed; empty/null → the placeholder. */
export function formatGroupLabel(value: unknown): string {
  if (value === null || value === undefined) return EMPTY_GROUP_LABEL;
  const text = String(value).trim();
  if (!text) return EMPTY_GROUP_LABEL;
  if (/^[A-Z0-9_]+$/.test(text) && text.includes("_")) {
    const words = text.toLowerCase().split("_");
    return words[0].charAt(0).toUpperCase() + words[0].slice(1) + (words.length > 1 ? " " + words.slice(1).join(" ") : "");
  }
  if (/^[A-Z0-9]+$/.test(text) && text.length > 1) return text.charAt(0) + text.slice(1).toLowerCase();
  return text;
}

export function groupRuns<T>(rows: readonly T[], keyOf: (row: T) => unknown): GroupRun<T>[] {
  const runs: GroupRun<T>[] = [];
  for (const row of rows) {
    const raw = keyOf(row);
    const key = raw === null || raw === undefined ? "" : String(raw);
    const last = runs[runs.length - 1];
    if (last && last.key === key) {
      last.rows.push(row);
      last.count += 1;
    } else {
      runs.push({ key, label: formatGroupLabel(raw), count: 1, rows: [row] });
    }
  }
  return runs;
}

/** Count per group over the WHOLE set — for a header that says "Open · 42" while only one page
 *  of those 42 is on screen. */
export function groupCounts<T>(rows: readonly T[], keyOf: (row: T) => unknown): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const raw = keyOf(row);
    const key = raw === null || raw === undefined ? "" : String(raw);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
