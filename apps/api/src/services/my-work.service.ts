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
import { dayKey, legacyCategory, toDay } from "./plan-schedule.service.js";

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

export interface MyWork {
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
  const today = toDay(now);
  const weekEnd = new Date(today.getTime() + 7 * 86_400_000);

  const items = await prisma.ticket.findMany({
    where: {
      deletedAt: null,
      assigneeId: userId,
      status: { notIn: ["CLOSED", "RESOLVED"] }
    },
    select: {
      id: true, key: true, title: true, startDate: true, endDate: true, dueAt: true, priority: true,
      status: true, type: true, isMilestone: true, progressPct: true, estimatedHours: true,
      workflowStatus: { select: { name: true, category: true, color: true } },
      project: { select: { id: true, code: true, name: true } },
      linksTo: {
        // Incoming BLOCKS/FS edges whose SOURCE is not finished — i.e. what is holding this up.
        where: { type: { in: ["BLOCKS", "FINISH_TO_START"] } },
        select: { id: true, sourceTicket: { select: { id: true, key: true, title: true, status: true } } }
      }
    },
    orderBy: [{ dueAt: "asc" }, { priority: "desc" }],
    take: 300
  });

  const enriched: MyWorkItem[] = items.map((t) => {
    const blockers = t.linksTo
      .map((l) => l.sourceTicket)
      .filter((s): s is NonNullable<typeof s> => Boolean(s) && !["RESOLVED", "CLOSED"].includes(s!.status));
    const deadline = t.endDate ?? t.dueAt ?? null;
    return {
      id: t.id,
      key: t.key,
      title: t.title,
      startDate: t.startDate ? dayKey(t.startDate) : null,
      endDate: t.endDate ? dayKey(t.endDate) : null,
      dueAt: t.dueAt ? dayKey(t.dueAt) : null,
      deadline: deadline ? dayKey(deadline) : null,
      priority: t.priority,
      status: t.status,
      statusCategory: t.workflowStatus?.category ?? legacyCategory(t.status),
      statusLabel: t.workflowStatus?.name ?? null,
      type: t.type,
      isMilestone: t.isMilestone,
      progressPct: t.progressPct,
      estimatedHours: t.estimatedHours ? Number(t.estimatedHours) : null,
      project: t.project,
      blockers
    };
  });

  const blocked = enriched.filter((t) => t.blockers.length > 0);
  const actionable = enriched.filter((t) => t.blockers.length === 0);
  const bucket = (predicate: (deadline: Date | null) => boolean) =>
    actionable.filter((t) => predicate(t.deadline ? toDay(t.deadline) : null));

  return {
    overdue: bucket((d) => Boolean(d && d < today)),
    today: bucket((d) => Boolean(d && dayKey(d) === dayKey(today))),
    thisWeek: bucket((d) => Boolean(d && d > today && d <= weekEnd)),
    later: bucket((d) => !d || d > weekEnd),
    blocked,
    counts: { total: enriched.length, blocked: blocked.length }
  };
}
