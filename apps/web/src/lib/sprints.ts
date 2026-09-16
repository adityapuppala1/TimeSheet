/**
 * WHAT: the small pure rules the Sprints page and the ticket sheet share — how far along a sprint
 * is, and what its status reads as. Kept out of the components so they are tested once.
 *
 * WHY PROGRESS COMES FROM THE BURNDOWN AND NOT FROM A COUNT: the burndown's last non-null point is
 * "what is still open as of today", replayed from the audited status changes on the server. Reading
 * the same series the chart draws means the headline percentage and the line can never disagree.
 */
import type { BurndownRow, SprintStatusValue } from "../services/api";

export interface SprintProgress {
  /** Points (or items, when nobody estimated) still open as of today. */
  remaining: number;
  total: number;
  /** 0–100, rounded; 0 when there is nothing to burn. */
  percentDone: number;
  /** True when the sprint has no estimated ticket, so the chart should read counts. */
  countsOnly: boolean;
}

export function sprintProgress(b: Pick<BurndownRow, "points" | "totalPoints" | "ticketCount">): SprintProgress {
  const countsOnly = b.totalPoints === 0;
  const total = countsOnly ? b.ticketCount : b.totalPoints;
  const valueOf = (p: BurndownRow["points"][number]) => (countsOnly ? p.remainingCount : p.remainingPoints);
  const latest = [...b.points].reverse().find((p) => valueOf(p) !== null);
  let remaining = total;
  if (latest) remaining = Number(valueOf(latest));
  const percentDone = total === 0 ? 0 : Math.round(((total - remaining) / total) * 100);
  return { remaining, total, percentDone: Math.max(0, Math.min(100, percentDone)), countsOnly };
}

export const SPRINT_STATUS_LABEL: Record<SprintStatusValue, string> = {
  PLANNED: "Planned",
  ACTIVE: "Active",
  COMPLETED: "Completed"
};

/** The one action a sprint offers next, or null for a completed one. */
export function nextSprintAction(status: SprintStatusValue): { to: SprintStatusValue; label: string } | null {
  if (status === "PLANNED") return { to: "ACTIVE", label: "Start sprint" };
  if (status === "ACTIVE") return { to: "COMPLETED", label: "Complete sprint" };
  return null;
}

/** "8 Sep – 19 Sep" for the list; the year only when it differs from today's. */
export function sprintRange(startDate: string, endDate: string, now: Date = new Date()): string {
  const fmt = (iso: string) => {
    const d = new Date(iso);
    const sameYear = d.getUTCFullYear() === now.getUTCFullYear();
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }), timeZone: "UTC" });
  };
  return `${fmt(startDate)} – ${fmt(endDate)}`;
}
