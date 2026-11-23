/**
 * Formatting for the attendance analytics views (V17 A6). Pure, so the "—, not 0%" rule and the
 * clock formatting are tested without rendering a chart.
 */

export const RANGE_OPTIONS = [7, 30, 90] as const;
export type RangeDays = (typeof RANGE_OPTIONS)[number];

/** The admin roles that see the Organisation tab — mirrors the server's assertOrgScope. */
export const ORG_VIEW_ROLES = new Set(["SUPER_ADMIN", "ADMIN"]);

/** A rate as a whole percent, or an em dash when there was nothing to divide by. */
export function pctText(rate: number | null | undefined): string {
  return rate == null ? "—" : `${Math.round(rate * 100)}%`;
}

/** Minutes after midnight → "09:05". */
export function minuteText(minute: number | null | undefined): string {
  if (minute == null) return "—";
  const m = Math.round(minute);
  return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** "+12 min/wk later", "6 min/wk earlier", "Steady" or "—" under five punches. */
export function driftText(perWeek: number | null | undefined): string {
  if (perWeek == null) return "—";
  if (Math.abs(perWeek) < 2) return "Steady";
  return perWeek > 0 ? `+${Math.round(perWeek)} min/wk later` : `${Math.round(-perWeek)} min/wk earlier`;
}

/** "from" and "to" for the last `days` days ending today (local). */
export function rangeFor(days: number, today: string): { from: string; to: string } {
  const from = new Date(new Date(`${today}T12:00:00Z`).getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  return { from, to: today };
}

/** A count map as rows, largest first, codes made readable ("SYSTEM_ISSUE" → "System issue"). */
export function countRows(map: Record<string, number | undefined>): Array<{ key: string; label: string; count: number }> {
  return Object.entries(map)
    .filter((e): e is [string, number] => typeof e[1] === "number" && e[1] > 0)
    .map(([key, count]) => ({ key, label: humanCode(key), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export function humanCode(code: string): string {
  const words = code.replaceAll("_", " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
