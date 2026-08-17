/**
 * WHAT: the Inbox — a triage queue over `Notification` rows — and the daily brief that answers
 * "what needs me today" without anybody asking a model.
 *
 * WHY THE BRIEF IS ARITHMETIC AND NOT A PROMPT: every number in it already has exactly one
 * server-side definition somewhere in this codebase, and the honest way to assemble a brief is to
 * call those definitions. A model asked to summarise the workspace would produce a fluent
 * paragraph whose numbers nobody can reconcile with the pages they came from — and the first time
 * the brief and the dashboard disagree, both stop being read. A narration layer can sit ON TOP of
 * this later (the plan reserves the `daily_brief` capability at ceiling AUTONOMOUS for exactly
 * that: it explains figures it cannot change, like `project_risk_narrative` does), but the figures
 * are computed here, first, and are true on their own.
 *
 * WHY THERE IS NO ENTITLEMENT GATE: this is the caller's own queue over notifications they already
 * receive, in a product whose whole premise is that people log time daily. Selling "your own inbox"
 * as an upsell would be the wrong shape, and it is the same reasoning that leaves `/plan/my-work`
 * ungated.
 *
 * WHO CALLS THIS: `controllers/inbox.controller.ts`.
 */
import { permissions } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { computeMyWork } from "./my-work.service.js";

/** UTC midnight, matching `Timesheet.workDate`'s DATE semantics — the same normalisation
 *  report.controller.ts's `/daily-status` uses, so "did I log today" means one thing. */
function todayUtcDate(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export interface BriefSection {
  /** Stable machine key, so the UI can route a click without string-matching a label. */
  key: string;
  label: string;
  count: number;
  /** Where clicking goes. Null when there is nothing to open (a zero row stays inert). */
  link: string | null;
  /** One line of context. Never invented — either a real figure or omitted. */
  detail: string | null;
  /** `attention` renders as a warning, `ok` as a quiet confirmation. Zero counts are `ok`, which
   *  is why "0 overdue" reads as reassurance rather than as an empty error state. */
  tone: "attention" | "ok";
}

export interface DailyBrief {
  generatedAt: string;
  /** True when nothing anywhere needs this person. The UI shows a genuine all-clear rather than a
   *  wall of zeroes — an empty state is a message, not a layout failure. */
  allClear: boolean;
  sections: BriefSection[];
}

/**
 * The brief. Each section names its own source so a reader can go and check it:
 *
 *  - overdue / blocked  → `my-work.service.ts` (the same buckets `/plan/my-work` renders)
 *  - timesheet approvals → the SUBMITTED predicate `timesheet.controller.ts` approves against
 *  - deliverable approvals → `ApprovalStep` rows awaiting this person's decision
 *  - unlogged time      → the `Timesheet.workDate = today` check `/daily-status` performs
 *  - at-risk projects   → the latest `ProjectRiskSnapshot` per project, RED band
 *  - unread             → `Notification.readAt IS NULL`
 */
export async function buildDailyBrief(
  user: { id: string; permissions: string[] },
  now: Date = new Date()
): Promise<DailyBrief> {
  const canApprove = user.permissions.includes(permissions.TIMESHEETS_APPROVE);
  const canSeeRisk = user.permissions.includes(permissions.REPORTS_VIEW);
  const today = todayUtcDate(now);

  const [myWork, pendingTimesheets, pendingApprovals, loggedToday, redProjects, unread] = await Promise.all([
    computeMyWork(user.id, now),
    // Only for people who can actually act on it: a queue you cannot clear is not a to-do.
    canApprove
      ? prisma.timesheet.count({ where: { status: "SUBMITTED", deletedAt: null, userId: { not: user.id } } })
      : Promise.resolve(0),
    prisma.approvalStep.count({ where: { approverId: user.id, decision: "PENDING" } }),
    prisma.timesheet.count({ where: { userId: user.id, workDate: today, deletedAt: null } }),
    canSeeRisk ? latestRedProjectCount() : Promise.resolve(0),
    prisma.notification.count({ where: { userId: user.id, readAt: null } })
  ]);

  const sections: BriefSection[] = [
    {
      key: "overdue",
      label: "Past their date",
      count: myWork.overdue.length,
      link: myWork.overdue.length > 0 ? "/app/my-work" : null,
      detail: myWork.overdue.length > 0 ? `Oldest: ${myWork.overdue[0].key} — ${myWork.overdue[0].title}` : null,
      tone: myWork.overdue.length > 0 ? "attention" : "ok"
    },
    {
      key: "today",
      label: "Due today",
      count: myWork.today.length,
      link: myWork.today.length > 0 ? "/app/my-work" : null,
      detail: null,
      tone: "ok"
    },
    {
      key: "blocked",
      label: "Blocked on somebody else",
      count: myWork.blocked.length,
      link: myWork.blocked.length > 0 ? "/app/my-work" : null,
      // Naming the blocker is the difference between "you are blocked" and "go and ask Priya".
      detail:
        myWork.blocked.length > 0 && myWork.blocked[0].blockers.length > 0
          ? `${myWork.blocked[0].key} waits on ${myWork.blocked[0].blockers[0].key}`
          : null,
      tone: myWork.blocked.length > 0 ? "attention" : "ok"
    },
    {
      key: "unlogged",
      // Phrased as the ACTION, not as an accusation: this is the product's daily habit.
      label: loggedToday > 0 ? "Time logged today" : "No time logged today",
      count: loggedToday > 0 ? loggedToday : 1,
      link: "/app/timesheet",
      detail: loggedToday > 0 ? `${loggedToday} ${loggedToday === 1 ? "entry" : "entries"}` : "Log it before the day closes",
      tone: loggedToday > 0 ? "ok" : "attention"
    }
  ];

  if (canApprove) {
    sections.push({
      key: "timesheetApprovals",
      label: "Timesheets awaiting review",
      count: pendingTimesheets,
      link: pendingTimesheets > 0 ? "/app/approvals" : null,
      detail: null,
      tone: pendingTimesheets > 0 ? "attention" : "ok"
    });
  }

  sections.push({
    key: "deliverableApprovals",
    label: "Sign-offs waiting on you",
    count: pendingApprovals,
    link: pendingApprovals > 0 ? "/app/approvals" : null,
    detail: null,
    tone: pendingApprovals > 0 ? "attention" : "ok"
  });

  if (canSeeRisk) {
    sections.push({
      key: "atRisk",
      label: "Projects reading red",
      count: redProjects,
      link: redProjects > 0 ? "/app/portfolio" : null,
      detail: null,
      tone: redProjects > 0 ? "attention" : "ok"
    });
  }

  sections.push({
    key: "unread",
    label: "Unread notifications",
    count: unread,
    link: unread > 0 ? "/app/inbox" : null,
    detail: null,
    tone: "ok"
  });

  // "All clear" ignores the informational rows (due today, unread, logged time): a person with
  // three things due today and nothing overdue has a normal day, not an alarm.
  const allClear = sections.every((s) => s.tone === "ok");

  return { generatedAt: now.toISOString(), allClear, sections };
}

/**
 * Projects whose LATEST risk snapshot is RED. `distinct` on an ordered query gives the newest per
 * project — the same shape the goals RISK_SCORE source uses, and for the same reason: a project
 * that was red in March is not red now, and counting historical snapshots would inflate this
 * number permanently.
 */
async function latestRedProjectCount(): Promise<number> {
  const latest = await prisma.projectRiskSnapshot.findMany({
    orderBy: { computedAt: "desc" },
    distinct: ["projectId"],
    select: { band: true }
  });
  return latest.filter((s) => s.band === "RED").length;
}

export type InboxFilter = "unhandled" | "snoozed" | "handled" | "all";

/**
 * The queue itself.
 *
 * WHY A SNOOZED ROW IS HIDDEN FROM `unhandled` UNTIL ITS TIME PASSES, and then reappears without
 * anybody re-filing it: that is the only behaviour that makes snoozing safe to use. A snooze that
 * has to be remembered is a delete.
 */
export async function listInbox(userId: string, filter: InboxFilter, now: Date = new Date()) {
  const base = { userId };
  const where =
    filter === "unhandled"
      ? { ...base, handledAt: null, OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }] }
      : filter === "snoozed"
        ? { ...base, handledAt: null, snoozedUntil: { gt: now } }
        : filter === "handled"
          ? { ...base, handledAt: { not: null } }
          : base;

  const [rows, counts] = await Promise.all([
    prisma.notification.findMany({ where, orderBy: { createdAt: "desc" }, take: 200 }),
    inboxCounts(userId, now)
  ]);
  return { items: rows, counts };
}

export async function inboxCounts(userId: string, now: Date = new Date()) {
  const [unhandled, snoozed, handled, unread] = await Promise.all([
    prisma.notification.count({
      where: { userId, handledAt: null, OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }] }
    }),
    prisma.notification.count({ where: { userId, handledAt: null, snoozedUntil: { gt: now } } }),
    prisma.notification.count({ where: { userId, handledAt: { not: null } } }),
    prisma.notification.count({ where: { userId, readAt: null } })
  ]);
  return { unhandled, snoozed, handled, unread };
}
