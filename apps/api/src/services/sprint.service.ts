/**
 * WHAT: sprints — a project's time-boxed iterations — and the burndown that reads them.
 *
 * WHY THE BURNDOWN IS A PURE FUNCTION OVER A REPLAY, not a stored snapshot: the same reason the
 * metric cards' sparklines are (ticket-metrics.service.ts). Every status change is already audited
 * as `ticket.status_changed` with `{ from, to }`, so "how much of this sprint was still open at the
 * end of each day" can be answered exactly from data that exists, for sprints that started before
 * this feature did, with nothing to keep in sync. A stored daily snapshot would be a second source
 * of truth that drifts the first time a transition is backdated.
 *
 * WHAT "REMAINING" MEANS: the sum of story points of the sprint's tickets whose status at the end
 * of that day was not RESOLVED or CLOSED. A ticket with no points counts as one item in the
 * `remainingCount` series, so a team that never estimates still gets a burndown that means
 * something. Days after today carry `null` — a burndown does not forecast; the ideal line does.
 *
 * WHY MEMBERSHIP IS READ AS OF NOW: a ticket moved out of the sprint is no longer part of its
 * story, and one moved in was planned in late. Sprint membership is not audited today (Open
 * Questions in the V12 state file); the honest series is over the current membership.
 *
 * WHO CALLS THIS: controllers/sprint.controller.ts.
 */
import { AppError } from "../middleware/error.js";

export const SPRINT_STATUSES = ["PLANNED", "ACTIVE", "COMPLETED"] as const;
export type SprintStatusValue = (typeof SPRINT_STATUSES)[number];

/** The only legal moves. A completed sprint is history and does not reopen. */
const TRANSITIONS: Record<SprintStatusValue, SprintStatusValue[]> = {
  PLANNED: ["ACTIVE"],
  ACTIVE: ["COMPLETED"],
  COMPLETED: []
};

export function assertSprintTransition(from: SprintStatusValue, to: SprintStatusValue): void {
  if (from === to) return;
  if (!TRANSITIONS[from].includes(to)) {
    throw new AppError(409, `A ${from.toLowerCase()} sprint cannot move to ${to.toLowerCase()}.`);
  }
}

/** Calendar days from `start` to `end` inclusive, as YYYY-MM-DD in UTC. */
export function sprintDays(start: Date, end: Date): string[] {
  const days: string[] = [];
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const last = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  while (cursor.getTime() <= last && days.length <= 400) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

export interface BurndownTicket {
  id: string;
  createdAt: Date;
  status: string;
  storyPoints: number | null;
  /** Status changes, any order; each carries the status the ticket moved TO and when. */
  transitions: Array<{ at: Date; to: string }>;
}

export interface BurndownPoint {
  date: string;
  /** Points still open at the end of the day; null for days that have not happened yet. */
  remainingPoints: number | null;
  /** Open tickets at the end of the day, for teams that do not estimate. */
  remainingCount: number | null;
  /** The straight line from the sprint's total to zero, for the same days. */
  idealPoints: number;
}

const DONE = new Set(["RESOLVED", "CLOSED"]);

/** A ticket's status at the end of a calendar day, from its transitions; its current status when
 *  there is no transition after that day (so an unaudited ticket reads as it is today). */
export function statusAtEndOf(ticket: BurndownTicket, dayEnd: Date): string | null {
  if (ticket.createdAt > dayEnd) return null;
  const sorted = [...ticket.transitions].sort((a, b) => a.at.getTime() - b.at.getTime());
  const later = sorted.find((t) => t.at > dayEnd);
  if (!later) return ticket.status;
  // The first transition after this day says what the status was BEFORE it — but we only store
  // `to`. The status before the first later transition is the `to` of the last transition on or
  // before the day, or, with none, whatever the ticket started as: we take the earliest known
  // pre-state as "not done", since tickets are created open.
  const before = sorted.filter((t) => t.at <= dayEnd);
  return before.length ? before[before.length - 1].to : "OPEN";
}

export function burndown(days: string[], tickets: BurndownTicket[], today: Date = new Date()): BurndownPoint[] {
  const total = tickets.reduce((sum, t) => sum + (t.storyPoints ?? 0), 0);
  const steps = Math.max(1, days.length - 1);
  const todayKey = today.toISOString().slice(0, 10);
  return days.map((date, i) => {
    const idealPoints = Math.round((total - (total * i) / steps) * 10) / 10;
    if (date > todayKey) return { date, remainingPoints: null, remainingCount: null, idealPoints };
    const dayEnd = new Date(`${date}T23:59:59.999Z`);
    let points = 0;
    let count = 0;
    for (const t of tickets) {
      const status = statusAtEndOf(t, dayEnd);
      if (status === null || DONE.has(status)) continue;
      points += t.storyPoints ?? 0;
      count += 1;
    }
    return { date, remainingPoints: Math.round(points * 10) / 10, remainingCount: count, idealPoints };
  });
}
