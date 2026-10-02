/**
 * WHAT: one person's cross-project queue, bucketed into overdue / today / this week / later /
 * blocked.
 *
 * WHY IT IS A SERVICE AND NOT INLINE IN THE ROUTE (it used to be): two surfaces now need these
 * numbers — `GET /plan/my-work` renders them, and the Inbox brief counts them. The moment a
 * second caller exists, an inline definition becomes two definitions, and "overdue" is exactly
 * the word that must not mean two things in one product. The route's response shape is unchanged;
 * this is a move, not a redesign.
 *
 * WHY A BLOCKED ITEM IS IN ONE BUCKET ONLY: showing it under "today" as well puts work at the top
 * of somebody's list that they cannot actually start, which is the fastest way to make a to-do
 * list untrustworthy.
 *
 * WHO CALLS THIS: `controllers/plan.controller.ts` (`/my-work`) and `services/inbox.service.ts`.
 */
import { prisma } from "../config/prisma.js";
import { htmlToPlainText } from "../utils/sanitize.js";
import { platformToday } from "../utils/date-window.js";
import { platformDayKey } from "../utils/platform-time.js";
import { dayKey, legacyCategory, toDay } from "./plan-schedule.service.js";
import { isSlaBreached, OPEN_TICKET_STATUS } from "./workspace-metrics.js";

export interface MyWorkItem {
  id: string;
  key: string;
  title: string;
  startDate: string | null;
  endDate: string | null;
  dueAt: string | null;
  /** `endDate` if the item is scheduled, else the SLA-derived `dueAt`. The date a person is
   *  actually judged against, which is why every bucket reads this rather than one column. */
  deadline: string | null;
  priority: string;
  status: string;
  statusCategory: string;
  statusLabel: string | null;
  type: string;
  isMilestone: boolean;
  progressPct: number | null;
  estimatedHours: number | null;
  project: { id: string; code: string; name: string } | null;
  blockers: Array<{ id: string; key: string; title: string; status: string }>;
}

/** V12 8.3: a comment assigned to this person and not yet resolved — an action item. */
export interface AssignedCommentItem {
  id: string;
  ticketId: string;
  ticketKey: string;
  ticketTitle: string;
  excerpt: string;
  author: { id: string; name: string };
  createdAt: string;
}

export interface MyWork {
  assignedComments: AssignedCommentItem[];
  overdue: MyWorkItem[];
  today: MyWorkItem[];
  thisWeek: MyWorkItem[];
  later: MyWorkItem[];
  blocked: MyWorkItem[];
  counts: { total: number; blocked: number };
}

/** `now` is a parameter so the brief and the page can agree on one instant, and so tests can pin
 *  a day rather than racing midnight. */
export async function computeMyWork(userId: string, now: Date = new Date()): Promise<MyWork> {
  // Today on the PLATFORM's calendar (IST). `toDay(now)` was UTC's day, so until 05:30 IST the page
  // still thought it was yesterday, and yesterday's work sat under "Due today".
  const today = platformToday(now);
  const weekEnd = new Date(today.getTime() + 7 * 86_400_000);

  const items = await prisma.ticket.findMany({
    where: {
      deletedAt: null,
      assigneeId: userId,
      status: OPEN_TICKET_STATUS
    },
    select: {
      id: true, key: true, title: true, startDate: true, endDate: true, dueAt: true, priority: true,
      status: true, type: true, isMilestone: true, progressPct: true, estimatedHours: true,
      // No `workflowStatus`: the pointer is frozen at upgrade day — see plan-schedule.service.ts#legacyCategory.
      project: { select: { id: true, code: true, name: true, color: true } },
      linksTo: {
        // Incoming BLOCKS/FS edges whose SOURCE is not finished — i.e. what is holding this up.
        where: { type: { in: ["BLOCKS", "FINISH_TO_START"] } },
        select: { id: true, sourceTicket: { select: { id: true, key: true, title: true, status: true } } }
      }
    },
    // Dated work first: MySQL sorts NULLs first, so `dueAt asc` let 300 undated tickets crowd out
    // the ones with a deadline.
    orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }, { priority: "desc" }],
    take: 300
  });

  const enriched: MyWorkItem[] = items.map((t) => {
    const blockers = t.linksTo
      .map((l) => l.sourceTicket)
      .filter((s): s is NonNullable<typeof s> => Boolean(s) && !["RESOLVED", "CLOSED"].includes(s!.status));
    // The planned end is a calendar day; the SLA is an instant, dated by its IST day.
    let deadline: string | null = null;
    if (t.endDate) deadline = dayKey(t.endDate);
    else if (t.dueAt) deadline = platformDayKey(t.dueAt);
    return {
      id: t.id,
      key: t.key,
      title: t.title,
      startDate: t.startDate ? dayKey(t.startDate) : null,
      endDate: t.endDate ? dayKey(t.endDate) : null,
      dueAt: t.dueAt ? platformDayKey(t.dueAt) : null,
      deadline,
      priority: t.priority,
      status: t.status,
      statusCategory: legacyCategory(t.status),
      // No custom label until custom workflows actually drive status — see legacyCategory.
      statusLabel: null,
      type: t.type,
      isMilestone: t.isMilestone,
      progressPct: t.progressPct,
      estimatedHours: t.estimatedHours ? Number(t.estimatedHours) : null,
      project: t.project,
      blockers
    };
  });

  const blocked = enriched.filter((t) => t.blockers.length > 0);
  /**
   * OVERDUE is one rule across the product (workspace-metrics.ts, and the OVERDUE_ITEMS widget):
   * past its planned end DAY, or past its SLA INSTANT — either broken promise counts. It used to be
   * `(endDate ?? dueAt) < today`, so a ticket whose SLA had passed but whose planned end was later
   * never read as overdue here while the dashboard counted it.
   */
  const slaById = new Map(items.map((t) => [t.id, t.dueAt]));
  const isOverdue = (t: MyWorkItem) =>
    Boolean(t.endDate && toDay(t.endDate) < today) || isSlaBreached({ dueAt: slaById.get(t.id) ?? null, resolvedAt: null }, now);
  const actionable = enriched.filter((t) => t.blockers.length === 0);
  const overdue = actionable.filter(isOverdue);
  const bucket = (predicate: (deadline: Date | null) => boolean) =>
    actionable.filter((t) => !isOverdue(t) && predicate(t.deadline ? toDay(t.deadline) : null));

  const assignedRows = await prisma.ticketComment.findMany({
    where: { assigneeId: userId, resolvedAt: null, ticket: { deletedAt: null } },
    select: { id: true, body: true, createdAt: true, ticket: { select: { id: true, key: true, title: true } }, author: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
    take: 50
  });
  const assignedComments: AssignedCommentItem[] = assignedRows.map((c) => ({
    id: c.id,
    ticketId: c.ticket.id,
    ticketKey: c.ticket.key,
    ticketTitle: c.ticket.title,
    excerpt: htmlToPlainText(c.body).trim().slice(0, 140),
    author: c.author,
    createdAt: c.createdAt.toISOString()
  }));

  return {
    assignedComments,
    overdue,
    today: bucket((d) => Boolean(d && dayKey(d) === dayKey(today))),
    thisWeek: bucket((d) => Boolean(d && d > today && d <= weekEnd)),
    later: bucket((d) => !d || d > weekEnd),
    blocked,
    counts: { total: enriched.length, blocked: blocked.length }
  };
}
