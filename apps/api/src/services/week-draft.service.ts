/**
 * "Draft my week" — proposes timesheet rows from the work a person actually did, for them to review.
 *
 * WHAT IT IS NOT: it never writes a timesheet. It returns suggestions; the person ticks the ones that
 * are right and the client creates them through the ordinary `POST /timesheets/draft` route, so every
 * existing rule (validation, overlap, permissions) applies unchanged and nothing is ever submitted on
 * anyone's behalf. Deterministic on purpose — the same inputs give the same rows, every row says which
 * activity produced it, and it works on a workspace with no AI provider configured.
 *
 * THE SIGNALS: tickets the person changed (audit log, entity "Ticket") or commented on, per day.
 * THE HOURS: only what is left of each day — the person's daily capacity (weekly ÷ 5, else 8h) minus
 * what they already logged — split across that day's tickets by how much activity each had, in
 * quarter hours, never below half an hour. A ticket already logged on a day is not suggested again.
 */
import { prisma } from "../config/prisma.js";

export interface WeekDraftActivity {
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
  ticketId: string;
  kind: "change" | "comment";
  at: Date;
}

export interface WeekDraftTicket {
  id: string;
  key: string;
  title: string;
  type: string;
  projectId: string;
  projectName: string;
  moduleId: string | null;
  moduleName: string | null;
}

export interface WeekDraftDayState {
  day: string;
  loggedHours: number;
  /** Latest end time already logged that day, "HH:MM", or null when nothing is logged. */
  lastEnd: string | null;
  loggedTicketIds: string[];
}

export interface WeekDraftSuggestion {
  workDate: string;
  ticketId: string;
  ticketKey: string;
  projectId: string;
  projectName: string;
  moduleId: string;
  moduleName: string;
  /** True when the ticket had no module and the project's first one was used — the UI says so. */
  moduleGuessed: boolean;
  activityType: string;
  taskDescription: string;
  hours: number;
  startTime: string;
  endTime: string;
  sources: { kind: "change" | "comment"; count: number }[];
}

const DAY_START = "09:00";
const MIN_HOURS = 0.5;

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
const toHHMM = (minutes: number) => {
  const clamped = Math.min(Math.max(minutes, 0), 23 * 60 + 59);
  return `${String(Math.floor(clamped / 60)).padStart(2, "0")}:${String(clamped % 60).padStart(2, "0")}`;
};
const quarter = (hours: number) => Math.round(hours * 4) / 4;

/** Bug-shaped tickets are bug fixing; everything else is development work. */
export function activityTypeFor(ticketType: string): string {
  return /bug|defect|incident/i.test(ticketType) ? "Bug Fixing" : "Development";
}

function describe(ticket: WeekDraftTicket, changes: number, comments: number): string {
  const parts: string[] = [];
  if (changes) parts.push(`${changes} update${changes === 1 ? "" : "s"}`);
  if (comments) parts.push(`${comments} comment${comments === 1 ? "" : "s"}`);
  return `${ticket.key} — ${ticket.title} (${parts.join(", ")})`;
}

type ActivityCount = { changes: number; comments: number };

/** One day's activity per ticket, skipping tickets already on a timesheet that day. */
function activityByTicket(day: WeekDraftDayState, activities: WeekDraftActivity[], tickets: Map<string, WeekDraftTicket>): Map<string, ActivityCount> {
  const perTicket = new Map<string, ActivityCount>();
  for (const a of activities) {
    if (a.day !== day.day || day.loggedTicketIds.includes(a.ticketId) || !tickets.has(a.ticketId)) continue;
    const row = perTicket.get(a.ticketId) ?? { changes: 0, comments: 0 };
    if (a.kind === "change") row.changes++;
    else row.comments++;
    perTicket.set(a.ticketId, row);
  }
  return perTicket;
}

/** `hours` split by weight in quarter hours, at least half an hour each, never more than `hours`. */
function splitHours(weights: number[], hours: number): number[] {
  const total = weights.reduce((sum, w) => sum + w, 0);
  const shares = weights.map((w) => Math.max(MIN_HOURS, quarter((hours * w) / total)));
  // Rounding can overshoot the day; take the excess off the largest share in quarter-hour steps.
  let over = quarter(shares.reduce((s, h) => s + h, 0) - hours);
  while (over > 0) {
    const i = shares.indexOf(Math.max(...shares));
    if (shares[i] - 0.25 < MIN_HOURS) break;
    shares[i] -= 0.25;
    over = quarter(over - 0.25);
  }
  return shares.map(quarter);
}

/**
 * The pure part, unit-tested on its own: activity + what is already logged + capacity → rows.
 * `fallbackModule` resolves a module for a ticket that has none (the project's first module).
 */
export function allocateWeekDraft(input: {
  activities: WeekDraftActivity[];
  tickets: Map<string, WeekDraftTicket>;
  days: WeekDraftDayState[];
  dailyCapacityHours: number;
  fallbackModule: (projectId: string) => { id: string; name: string } | null;
}): WeekDraftSuggestion[] {
  const suggestions: WeekDraftSuggestion[] = [];
  for (const day of input.days) {
    const remaining = quarter(input.dailyCapacityHours - day.loggedHours);
    if (remaining < MIN_HOURS) continue;
    const perTicket = activityByTicket(day, input.activities, input.tickets);
    if (perTicket.size === 0) continue;

    // Most active first, and no more tickets than the remaining time can give half an hour each.
    const ranked = [...perTicket.entries()]
      .sort(([, a], [, b]) => b.changes + b.comments - (a.changes + a.comments))
      .slice(0, Math.max(1, Math.floor(remaining / MIN_HOURS)));
    const shares = splitHours(ranked.map(([, r]) => r.changes + r.comments), remaining);

    let cursor = day.lastEnd ? Math.max(toMinutes(day.lastEnd), toMinutes(DAY_START)) : toMinutes(DAY_START);
    ranked.forEach(([ticketId, r], i) => {
      const ticket = input.tickets.get(ticketId)!;
      const module = ticket.moduleId ? { id: ticket.moduleId, name: ticket.moduleName ?? "" } : input.fallbackModule(ticket.projectId);
      if (!module) return; // a project with no module can't take a timesheet row
      const hours = shares[i];
      const start = cursor;
      const end = start + Math.round(hours * 60);
      if (end > 23 * 60 + 59) return; // would run past midnight — leave it for the person
      cursor = end;
      suggestions.push({
        workDate: day.day,
        ticketId,
        ticketKey: ticket.key,
        projectId: ticket.projectId,
        projectName: ticket.projectName,
        moduleId: module.id,
        moduleName: module.name,
        moduleGuessed: !ticket.moduleId,
        activityType: activityTypeFor(ticket.type),
        taskDescription: describe(ticket, r.changes, r.comments),
        hours,
        startTime: toHHMM(start),
        endTime: toHHMM(end),
        sources: [
          ...(r.changes ? [{ kind: "change" as const, count: r.changes }] : []),
          ...(r.comments ? [{ kind: "comment" as const, count: r.comments }] : [])
        ]
      });
    });
  }
  return suggestions;
}

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Monday of the week containing `date` (local), at 00:00. */
export function mondayOf(date: Date): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const offset = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - offset);
  return d;
}

/** Loads the signals for one person and one week, then allocates. Weekdays up to today only. */
export async function buildWeekDraft(userId: string, weekStart: Date, now = new Date()) {
  const monday = mondayOf(weekStart);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayDates: Date[] = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    if (d <= today) dayDates.push(d);
  }
  const weekEnd = new Date(monday);
  weekEnd.setDate(monday.getDate() + 7);
  if (dayDates.length === 0) return { weekStart: ymd(monday), dailyCapacityHours: 8, days: [], suggestions: [] };

  const [user, audits, comments, logged] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { weeklyCapacityHours: true } }),
    prisma.auditLog.findMany({
      where: { actorId: userId, entity: "Ticket", entityId: { not: null }, createdAt: { gte: monday, lt: weekEnd } },
      select: { entityId: true, createdAt: true },
      take: 2000
    }),
    prisma.ticketComment.findMany({
      where: { authorId: userId, createdAt: { gte: monday, lt: weekEnd } },
      select: { ticketId: true, createdAt: true },
      take: 2000
    }),
    prisma.timesheet.findMany({
      where: { userId, workDate: { gte: monday, lt: weekEnd } },
      select: { workDate: true, totalHours: true, endTime: true, ticketId: true }
    })
  ]);

  const activities: WeekDraftActivity[] = [
    ...audits.map((a) => ({ day: ymd(a.createdAt), ticketId: a.entityId!, kind: "change" as const, at: a.createdAt })),
    ...comments.map((c) => ({ day: ymd(c.createdAt), ticketId: c.ticketId, kind: "comment" as const, at: c.createdAt }))
  ];
  const ticketIds = [...new Set(activities.map((a) => a.ticketId))];
  const ticketRows = ticketIds.length
    ? await prisma.ticket.findMany({
        // Deleted tickets keep their history but cannot take new time — never suggest them.
        where: { id: { in: ticketIds }, deletedAt: null },
        select: { id: true, key: true, title: true, type: true, projectId: true, moduleId: true, project: { select: { name: true } }, module: { select: { name: true } } }
      })
    : [];
  const tickets = new Map<string, WeekDraftTicket>(
    ticketRows.map((t) => [
      t.id,
      { id: t.id, key: t.key, title: t.title, type: t.type, projectId: t.projectId, projectName: t.project.name, moduleId: t.moduleId, moduleName: t.module?.name ?? null }
    ])
  );
  const projectIds = [...new Set(ticketRows.filter((t) => !t.moduleId).map((t) => t.projectId))];
  const firstModules = projectIds.length
    ? await prisma.projectModule.findMany({ where: { projectId: { in: projectIds } }, orderBy: { createdAt: "asc" }, select: { id: true, name: true, projectId: true } })
    : [];
  const fallback = new Map<string, { id: string; name: string }>();
  for (const m of firstModules) if (!fallback.has(m.projectId)) fallback.set(m.projectId, { id: m.id, name: m.name });

  // Timesheet.workDate is a DATE column, read back as UTC midnight — key it by its UTC date.
  const utcYmd = (d: Date) => d.toISOString().slice(0, 10);
  const days: WeekDraftDayState[] = dayDates.map((d) => {
    const key = ymd(d);
    const rows = logged.filter((t) => utcYmd(t.workDate) === key);
    const ends = rows.map((t) => t.endTime).filter(Boolean).sort();
    return {
      day: key,
      loggedHours: rows.reduce((s, t) => s + Number(t.totalHours), 0),
      lastEnd: ends.at(-1) ?? null,
      loggedTicketIds: rows.map((t) => t.ticketId).filter((id): id is string => Boolean(id))
    };
  });

  const weekly = user?.weeklyCapacityHours ? Number(user.weeklyCapacityHours) : 40;
  const dailyCapacityHours = quarter(weekly / 5);
  const suggestions = allocateWeekDraft({ activities, tickets, days, dailyCapacityHours, fallbackModule: (p) => fallback.get(p) ?? null });
  return { weekStart: ymd(monday), dailyCapacityHours, days: days.map(({ day, loggedHours }) => ({ day, loggedHours })), suggestions };
}
