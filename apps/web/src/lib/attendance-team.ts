/**
 * Pure helpers for the Attendance pages (V17 A5): the status chips' counts, the timeline grouped by
 * the viewer's local day, and "3h ago". Kept out of the components so they are unit-tested without
 * a DOM (tests/unit/attendance-team.test.ts).
 */
export type AttendanceDayStatus = "WEEKEND" | "HOLIDAY" | "LEAVE" | "PRESENT" | "ABSENT" | "PENDING";

/** The chips the Team screen shows, in reading order. LEAVE joins in Phase B. */
export const SUMMARY_CHIPS: ReadonlyArray<{ status: AttendanceDayStatus; label: string }> = [
  { status: "PRESENT", label: "Present" },
  { status: "PENDING", label: "Pending" },
  { status: "ABSENT", label: "Absent" },
  { status: "HOLIDAY", label: "Holiday" },
  { status: "WEEKEND", label: "Weekend" }
];

export const STATUS_LABELS: Record<AttendanceDayStatus, string> = {
  PRESENT: "Present",
  PENDING: "Pending",
  ABSENT: "Absent",
  HOLIDAY: "Holiday",
  WEEKEND: "Weekend",
  LEAVE: "On leave"
};

export type StatusTone = "success" | "warning" | "destructive" | "info" | "muted";

export const STATUS_TONES: Record<AttendanceDayStatus, StatusTone> = {
  PRESENT: "success",
  PENDING: "warning",
  ABSENT: "destructive",
  HOLIDAY: "info",
  LEAVE: "info",
  WEEKEND: "muted"
};

/** Counts per status, every status present (zero when nobody has it). */
export function summarizeStatuses(rows: ReadonlyArray<{ status: AttendanceDayStatus }>): Record<AttendanceDayStatus, number> {
  const out: Record<AttendanceDayStatus, number> = { PRESENT: 0, PENDING: 0, ABSENT: 0, HOLIDAY: 0, WEEKEND: 0, LEAVE: 0 };
  for (const row of rows) out[row.status] += 1;
  return out;
}

/** `YYYY-MM-DD` of an instant in `timeZone` (the viewer's). */
export function localDateKey(iso: string, timeZone?: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

export interface TimelineDay<T extends { at: string }> {
  dateKey: string;
  events: T[];
}

/** Events grouped by the viewer's local day, newest day first, oldest event first inside a day. */
export function groupTimelineByDay<T extends { at: string }>(events: readonly T[], timeZone?: string): Array<TimelineDay<T>> {
  const byDay = new Map<string, T[]>();
  for (const event of [...events].sort((a, b) => a.at.localeCompare(b.at))) {
    const key = localDateKey(event.at, timeZone);
    const list = byDay.get(key) ?? [];
    list.push(event);
    byDay.set(key, list);
  }
  return [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([dateKey, list]) => ({ dateKey, events: list }));
}

/** "just now", "5m ago", "3h ago", "2d ago" — and the same in the future for a clock skew. */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const diff = now.getTime() - new Date(iso).getTime();
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? "ago" : "from now";
  if (abs < 60_000) return "just now";
  if (abs < 3_600_000) return `${Math.floor(abs / 60_000)}m ${suffix}`;
  if (abs < 86_400_000) return `${Math.floor(abs / 3_600_000)}h ${suffix}`;
  return `${Math.floor(abs / 86_400_000)}d ${suffix}`;
}

/** The roles that may open the Team tab — the same set the server's teamScopeFor allows. */
export const TEAM_VIEW_ROLES = new Set(["SUPER_ADMIN", "ADMIN", "MANAGER", "TEAM_LEAD"]);
