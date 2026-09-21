/**
 * Past incidents, grouped the way a person scans them: by month, then by day, newest first.
 *
 * WHY GROUP AT ALL: a flat list of forty five-minute blips reads as forty problems. Grouped, the
 * same data reads as "August had eleven, all short, mostly sign-in" — which is the finding. Each
 * month heading carries its count and its WORST status, so a folded month still says whether
 * anything inside it was a real outage.
 *
 * Pure, and keyed by the viewer's LOCAL calendar: an incident at 00:30 belongs to the day the
 * person reading it would name.
 */

export type IncidentStatus = "OPERATIONAL" | "DEGRADED" | "DOWN";

export interface IncidentLike {
  id: string;
  status: IncidentStatus;
  startedAt: string;
}

export interface IncidentDay<T> {
  key: string;
  label: string;
  incidents: T[];
}

export interface IncidentMonth<T> {
  key: string;
  label: string;
  count: number;
  /** The worst status inside the month — DOWN beats DEGRADED beats OPERATIONAL. */
  worst: IncidentStatus;
  /** Per-status counts, for the "3 down · 8 degraded" line on the heading. */
  byStatus: Record<IncidentStatus, number>;
  days: Array<IncidentDay<T>>;
}

const RANK: Record<IncidentStatus, number> = { OPERATIONAL: 0, DEGRADED: 1, DOWN: 2 };

function pad(n: number): string {
  return `${n}`.padStart(2, "0");
}

export function groupIncidentsByMonth<T extends IncidentLike>(incidents: T[]): Array<IncidentMonth<T>> {
  const months = new Map<string, IncidentMonth<T>>();
  const dayMaps = new Map<string, Map<string, IncidentDay<T>>>();

  // Newest first, decided here rather than trusted from the API — a list that sorts itself cannot
  // be handed an out-of-order page and render August under September.
  const sorted = [...incidents].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));

  for (const incident of sorted) {
    const when = new Date(incident.startedAt);
    if (Number.isNaN(when.getTime())) continue;
    const monthKey = `${when.getFullYear()}-${pad(when.getMonth() + 1)}`;
    const dayKey = `${monthKey}-${pad(when.getDate())}`;

    let month = months.get(monthKey);
    if (!month) {
      month = {
        key: monthKey,
        label: when.toLocaleDateString(undefined, { month: "long", year: "numeric" }),
        count: 0,
        worst: "OPERATIONAL",
        byStatus: { OPERATIONAL: 0, DEGRADED: 0, DOWN: 0 },
        days: []
      };
      months.set(monthKey, month);
      dayMaps.set(monthKey, new Map());
    }
    month.count += 1;
    month.byStatus[incident.status] += 1;
    if (RANK[incident.status] > RANK[month.worst]) month.worst = incident.status;

    const days = dayMaps.get(monthKey)!;
    let day = days.get(dayKey);
    if (!day) {
      day = { key: dayKey, label: when.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }), incidents: [] };
      days.set(dayKey, day);
      month.days.push(day);
    }
    day.incidents.push(incident);
  }

  return [...months.values()];
}

/** "3 down · 8 degraded" — only the statuses that occurred, so a clean month does not read "0 down". */
export function incidentMixLabel(byStatus: Record<IncidentStatus, number>): string {
  const parts: string[] = [];
  if (byStatus.DOWN > 0) parts.push(`${byStatus.DOWN} down`);
  if (byStatus.DEGRADED > 0) parts.push(`${byStatus.DEGRADED} degraded`);
  return parts.join(" · ");
}
