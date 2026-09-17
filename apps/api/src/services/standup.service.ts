/**
 * V12 9.1 — the facts behind "write my stand-up".
 *
 * SOURCE: ClickUp's AI StandUp card — "write a summary of what you've been working on … AI uses
 * data from your tasks to summarize your work during a selected period of time".
 *
 * WHY A PURE FORMATTER: the model must never be the thing that decides what happened. It is handed
 * a block of facts gathered here, under the person's own identity, and asked only to phrase them.
 * Every number and every ticket key in a stand-up therefore comes from the database, which is also
 * what makes the empty case answerable without spending a call.
 *
 * WHAT IT READS, and why each is already the caller's own data: tickets assigned to them that moved
 * inside the window, comments they wrote, hours they logged, and the comments still assigned to
 * them (V12 8.3). Nothing here widens what the person can see — a stand-up about work they cannot
 * open would be a data leak with a friendly voice.
 */
import { prisma } from "../config/prisma.js";
import { NOT_DEACTIVATED } from "./people-visibility.service.js";
import { htmlToPlainText } from "../utils/sanitize.js";

/**
 * V12 9.3 — WHOSE stand-up you may write.
 *
 * Deliberately the same shape as `ticketProjectScope`, and for the same reason: "whose work may I
 * read" already has one answer in this codebase, and a second one written here would be the bug.
 * SUPER_ADMIN and ADMIN are unrestricted; a MANAGER or TEAM_LEAD adds the people whose `managerId`
 * is theirs; everybody else is offered themselves and nobody else.
 *
 * Pure so the picker and the route cannot drift: the list a person is OFFERED and the check the
 * route RUNS are this one function, not a list the server hopes the browser respected.
 */
const UNRESTRICTED_ROLES = new Set(["SUPER_ADMIN", "ADMIN"]);
const MANAGING_ROLES = new Set(["MANAGER", "TEAM_LEAD"]);

export interface StandupSubjectRule {
  /** Everyone, because this person may already read everyone's work. */
  unrestricted: boolean;
  /** When not unrestricted: exactly the ids allowed, self included. */
  allowedIds: string[];
}

export function standupSubjectRule(role: string, actorId: string, reportIds: string[]): StandupSubjectRule {
  if (UNRESTRICTED_ROLES.has(role)) return { unrestricted: true, allowedIds: [] };
  if (MANAGING_ROLES.has(role)) return { unrestricted: false, allowedIds: [...new Set([actorId, ...reportIds])] };
  return { unrestricted: false, allowedIds: [actorId] };
}

export function mayWriteStandupFor(rule: StandupSubjectRule, targetId: string): boolean {
  return rule.unrestricted || rule.allowedIds.includes(targetId);
}

/** The people this person may pick, self first. Deactivated accounts are left out through the one
 *  predicate that decides that everywhere else. */
export async function listStandupSubjects(role: string, actorId: string): Promise<Array<{ id: string; name: string; isSelf: boolean }>> {
  const reports = MANAGING_ROLES.has(role)
    ? await prisma.user.findMany({ where: { managerId: actorId, ...NOT_DEACTIVATED }, select: { id: true } })
    : [];
  const rule = standupSubjectRule(role, actorId, reports.map((r) => r.id));

  const people = await prisma.user.findMany({
    where: rule.unrestricted ? { ...NOT_DEACTIVATED } : { id: { in: rule.allowedIds }, ...NOT_DEACTIVATED },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
    take: 200
  });
  return people
    .map((p) => ({ ...p, isSelf: p.id === actorId }))
    .sort((a, b) => Number(b.isSelf) - Number(a.isSelf) || a.name.localeCompare(b.name));
}

/** Resolve the rule for a request, reading the reports only when the role could have any. */
export async function resolveStandupRule(role: string, actorId: string): Promise<StandupSubjectRule> {
  if (!MANAGING_ROLES.has(role)) return standupSubjectRule(role, actorId, []);
  const reports = await prisma.user.findMany({ where: { managerId: actorId, ...NOT_DEACTIVATED }, select: { id: true } });
  return standupSubjectRule(role, actorId, reports.map((r) => r.id));
}

/** The periods the card offers. ClickUp's range is "24 hours to the Last 7 days". */
export const STANDUP_WINDOWS = [24, 72, 168] as const;
export type StandupWindow = (typeof STANDUP_WINDOWS)[number];

export function isStandupWindow(hours: number): hours is StandupWindow {
  return (STANDUP_WINDOWS as readonly number[]).includes(hours);
}

export function standupPeriodLabel(hours: StandupWindow): string {
  if (hours === 24) return "the last 24 hours";
  if (hours === 72) return "the last 3 days";
  return "the last 7 days";
}

export interface StandupFacts {
  movedTickets: Array<{ key: string; title: string; status: string }>;
  commentsWritten: Array<{ ticketKey: string; excerpt: string }>;
  hoursLogged: number;
  timesheetTickets: string[];
  openAssignedComments: Array<{ ticketKey: string; from: string; excerpt: string }>;
}

/** Nothing to say. Checked BEFORE the model call, so an idle week costs nothing. */
export function standupIsEmpty(f: StandupFacts): boolean {
  return (
    f.movedTickets.length === 0 &&
    f.commentsWritten.length === 0 &&
    f.openAssignedComments.length === 0 &&
    f.hoursLogged === 0
  );
}

/** Caps, for the same reason `comment_summary` has them: every string below is user-authored and
 *  a week of activity is not bounded by anything the UI enforces. */
const MAX_TICKETS = 25;
const MAX_COMMENTS = 15;
const MAX_ASSIGNED = 10;
const MAX_EXCERPT = 160;

export function excerpt(html: string): string {
  const text = htmlToPlainText(html).replace(/\s+/g, " ").trim();
  return text.length > MAX_EXCERPT ? `${text.slice(0, MAX_EXCERPT)}…` : text;
}

/** One labelled block. "(none)" is said out loud rather than omitted, so the model cannot read a
 *  missing section as room to invent one. */
function section(label: string, lines: string[], noneText = "(none)"): string {
  if (lines.length === 0) return `${label}: ${noneText}`;
  const body = lines.join("\n");
  return `${label}:\n${body}`;
}

function hoursLine(f: StandupFacts): string {
  if (f.hoursLogged <= 0) return "Time logged: (none recorded)";
  const tickets = f.timesheetTickets.slice(0, MAX_TICKETS);
  if (tickets.length === 0) return `Time logged: ${f.hoursLogged} hours`;
  return `Time logged: ${f.hoursLogged} hours across ${tickets.join(", ")}`;
}

/**
 * The fact block handed to the prompt. Plain text on purpose: it is read by a model, by a test,
 * and by whoever opens the AI activity log to ask what the summary was based on.
 */
export function formatStandupFacts(f: StandupFacts): string {
  const moved = f.movedTickets
    .slice(0, MAX_TICKETS)
    .map((t) => `- [${t.key}] ${t.title} (now ${t.status.replace(/_/g, " ").toLowerCase()})`);
  const written = f.commentsWritten.slice(0, MAX_COMMENTS).map((c) => `- on [${c.ticketKey}]: ${c.excerpt}`);
  const waiting = f.openAssignedComments.slice(0, MAX_ASSIGNED).map((c) => `- on [${c.ticketKey}], from ${c.from}: ${c.excerpt}`);

  return [
    // V12 9.3: the labels are person-neutral on purpose. "Comments I wrote" would argue with the
    // third-person voice a manager's copy is asked for, and the facts must not fight the framing.
    section("Tickets assigned to this person that moved", moved),
    section("Comments this person wrote", written),
    hoursLine(f),
    section("Comments assigned to this person and still unresolved", waiting)
  ].join("\n\n");
}

/**
 * Gathers one person's window.
 *
 * V12 9.3 — `projectIds` is THE guard when the subject is somebody else: their tickets and comments
 * are intersected with the projects the READER may open, so a manager writing a report's stand-up
 * can never be shown a ticket key or a comment from a project they cannot open themselves. Pass
 * `null` only for a person's own facts, where their whole week is theirs by definition.
 */
export async function gatherStandupFacts(
  userId: string,
  sinceHours: StandupWindow,
  projectIds: string[] | null = null
): Promise<StandupFacts> {
  const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
  // An empty allow-list means "no projects", which must read as no rows — never as "unrestricted".
  const ticketScope = projectIds === null ? {} : { projectId: { in: projectIds } };
  const viaTicket = projectIds === null ? {} : { projectId: { in: projectIds } };

  const [tickets, comments, timesheets, assigned] = await Promise.all([
    prisma.ticket.findMany({
      where: { assigneeId: userId, deletedAt: null, updatedAt: { gte: since }, ...ticketScope },
      select: { key: true, title: true, status: true },
      orderBy: { updatedAt: "desc" },
      take: MAX_TICKETS
    }),
    prisma.ticketComment.findMany({
      where: { authorId: userId, createdAt: { gte: since }, ticket: { deletedAt: null, ...viaTicket } },
      select: { body: true, ticket: { select: { key: true } } },
      orderBy: { createdAt: "desc" },
      take: MAX_COMMENTS
    }),
    prisma.timesheet.findMany({
      where: { userId, deletedAt: null, workDate: { gte: since }, ...ticketScope },
      select: { totalHours: true, ticket: { select: { key: true } } }
    }),
    prisma.ticketComment.findMany({
      where: { assigneeId: userId, resolvedAt: null, ticket: { deletedAt: null, ...viaTicket } },
      select: { body: true, ticket: { select: { key: true } }, author: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: MAX_ASSIGNED
    })
  ]);

  const hoursLogged = Math.round(timesheets.reduce((sum, t) => sum + Number(t.totalHours ?? 0), 0) * 10) / 10;
  const timesheetTickets = [...new Set(timesheets.map((t) => t.ticket?.key).filter((k): k is string => Boolean(k)))];

  return {
    movedTickets: tickets,
    commentsWritten: comments.map((c) => ({ ticketKey: c.ticket.key, excerpt: excerpt(c.body) })),
    hoursLogged,
    timesheetTickets,
    openAssignedComments: assigned.map((c) => ({ ticketKey: c.ticket.key, from: c.author.name, excerpt: excerpt(c.body) }))
  };
}
