/**
 * V12 9.2 — the Agent runs list, as the reference's Activity tab reads it: "organized into sections
 * based on the date your Automation or Agent ran".
 *
 * Pure, because the grouping is the only part with a rule in it: rows arrive newest-first from the
 * API and must stay in that order inside each day, and the day itself is the viewer's local day —
 * a run at 00:30 belongs to the date the person reading it would name, not to UTC's.
 */

export interface DatedRun {
  id: string;
  createdAt: string;
}

export interface RunDayGroup<T> {
  /** Stable key: the local calendar date, YYYY-MM-DD. */
  key: string;
  /** What the heading says: Today, Yesterday, or the date. */
  label: string;
  runs: T[];
}

function localKey(d: Date): string {
  const month = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

export function groupRunsByDay<T extends DatedRun>(runs: T[], now: Date = new Date()): Array<RunDayGroup<T>> {
  const today = localKey(now);
  const yesterday = localKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));

  const groups: Array<RunDayGroup<T>> = [];
  const byKey = new Map<string, RunDayGroup<T>>();

  for (const run of runs) {
    const when = new Date(run.createdAt);
    // A row whose timestamp cannot be read still has to appear somewhere — losing a run from an
    // audit list is worse than showing it under an honest "Unknown date".
    const key = Number.isNaN(when.getTime()) ? "unknown" : localKey(when);
    let group = byKey.get(key);
    if (!group) {
      group = { key, label: labelFor(key, today, yesterday, when), runs: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.runs.push(run);
  }
  return groups;
}

function labelFor(key: string, today: string, yesterday: string, when: Date): string {
  if (key === "unknown") return "Unknown date";
  if (key === today) return "Today";
  if (key === yesterday) return "Yesterday";
  return when.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

/** The periods the card offers for "Date run". `0` means every run it can fetch. */
export const RUN_PERIODS = [
  { value: "0", label: "Any time" },
  { value: "1", label: "Last 24 hours" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" }
] as const;

/** Every status an agent run reaches, with the words the card shows. Kept in step with the API's
 *  own list by agent-run-filters.test.ts on the server side. */
export const RUN_STATUS_LABELS: Record<string, string> = {
  QUEUED: "Queued",
  RUNNING: "Running",
  COMPLETED: "Completed",
  PARTIAL: "Stopped at a limit",
  BLOCKED: "Held for review",
  FAILED: "Failed",
  ABORTED: "Stopped by a person"
};
