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
import { awaitingReviewWhere, loadApprovalAuthority } from "./timesheet-approval-scope.service.js";
import { userClock } from "./user-clock.service.js";
import { activeSteps } from "./approval.service.js";

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
 *  - timesheet approvals → `awaitingReviewWhere`, the approvals queue's own scope
 *  - deliverable approvals → `ApprovalStep` rows awaiting this person's decision NOW (`activeSteps`)
 *  - unlogged time      → the `Timesheet.workDate = today` check `/daily-status` performs
 *  - at-risk projects   → the latest `ProjectRiskSnapshot` per project, RED band
 *  - unread             → unread rows the bell shows (`shownInBell`)
 */
export async function buildDailyBrief(
  user: { id: string; permissions: string[] },
  now: Date = new Date()
): Promise<DailyBrief> {
  const canApprove = user.permissions.includes(permissions.TIMESHEETS_APPROVE);
  const canSeeRisk = user.permissions.includes(permissions.REPORTS_VIEW);
  // The person's own today, from the same helper `/daily-status` uses — this used to take the UTC
  // date while claiming to match it, so from 00:00 to 05:30 IST it asked about yesterday.
  const { today } = await userClock(user.id, now);

  const [myWork, pendingTimesheets, pendingApprovals, loggedToday, redProjects, unread] = await Promise.all([
    computeMyWork(user.id, now),
    // Only for people who can actually act on it: a queue you cannot clear is not a to-do. Counted
    // with the approvals queue's own predicate — not yours, not your managers' — so the number here
    // is the number of rows the link opens onto.
    canApprove
      ? loadApprovalAuthority(user.id).then((authority) => prisma.timesheet.count({ where: awaitingReviewWhere(authority) }))
      : Promise.resolve(0),
    signOffsWaitingOn(user.id),
    prisma.timesheet.count({ where: { userId: user.id, workDate: today, deletedAt: null } }),
    canSeeRisk ? latestRedProjectCount() : Promise.resolve(0),
    // The bell's own predicate: a row marked done or still snoozed is not "unread" anywhere else,
    // so the brief must not say "Unread notifications: 4" beside a bell that says 0.
    prisma.notification.count({ where: { ...shownInBell(user.id, now), readAt: null } })
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
    count: pendingApprovals.count,
    // The ticket the oldest waiting step belongs to. This used to be /app/approvals, which lists
    // TIMESHEETS only (and redirects anyone without timesheets:approve to the home page).
    link: pendingApprovals.oldest ? `/app/tickets?open=${pendingApprovals.oldest.ticketId}` : null,
    detail: pendingApprovals.oldest ? `Oldest: ${pendingApprovals.oldest.key} — ${pendingApprovals.oldest.title}` : null,
    tone: pendingApprovals.count > 0 ? "attention" : "ok"
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
 * Approval-chain steps that are waiting on this person RIGHT NOW: the request is still PENDING, and
 * the step is one `activeSteps` says is being asked (in a sequential chain, only the lowest undecided
 * order). It used to count every PENDING step naming them — but a rejected chain deliberately leaves
 * its later steps PENDING forever, and a sequential chain's later steps are PENDING long before their
 * turn — so people saw "Sign-offs waiting on you: 1" for a decision nobody could make, and the brief
 * never read all-clear. Oldest request first, for the link.
 */
async function signOffsWaitingOn(userId: string): Promise<{ count: number; oldest: { ticketId: string; key: string; title: string } | null }> {
  const steps = await prisma.approvalStep.findMany({
    where: { approverId: userId, decision: "PENDING", request: { status: "PENDING" } },
    select: {
      id: true,
      request: {
        select: {
          ticketId: true,
          isSequential: true,
          ticket: { select: { key: true, title: true } },
          steps: { select: { id: true, order: true, approverId: true, guestEmail: true, decision: true } }
        }
      }
    },
    orderBy: { request: { createdAt: "asc" } }
  });
  const waiting = steps.filter((step) => activeSteps(step.request.steps, step.request.isSequential).some((s) => s.id === step.id));
  const first = waiting[0];
  return {
    count: waiting.length,
    oldest: first ? { ticketId: first.request.ticketId, key: first.request.ticket.key, title: first.request.ticket.title } : null
  };
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

/** What the bell shows a person: theirs, not handled, and not still snoozed. ONE definition, because
 *  the bell's list, its badge, "Mark all read" and the brief's unread count must all mean the same
 *  rows. */
export const shownInBell = (userId: string, now: Date) => ({
  userId,
  handledAt: null,
  OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }]
});

export type InboxFilter = "unhandled" | "snoozed" | "handled" | "all";

/**
 * The queue itself.
 *
 * WHY A SNOOZED ROW IS HIDDEN FROM `unhandled` UNTIL ITS TIME PASSES, and then reappears without
 * anybody re-filing it: that is the only behaviour that makes snoozing safe to use. A snooze that
 * has to be remembered is a delete.
 */
/**
 * One entry in the queue, which is usually one notification and sometimes many.
 *
 * WHY THIS EXISTS: `dispatchNotification` writes a row every time something happens, and several
 * producers legitimately fire for a run of similar events. Measured on this workspace: 706 of 1,916
 * notifications repeat an existing row's recipient, title and category on the same day; the
 * unhandled queues across every user hold 1,916 rows that are 1,000 distinct notices; and the
 * largest single notice is 205 rows for ONE person, all pointing at the same page. The queue reads
 * newest first and stops at a couple of hundred rows, so a burst like that does not merely look
 * untidy — it pushes every other kind of notice out of the list. The reader's own approvals become
 * invisible behind it.
 *
 * WHY IT COLLAPSES AT READ TIME AND NOT AT DISPATCH: a dedupe window at the point of writing has to
 * guess, and when it guesses wrong it silently swallows something somebody needed, with no record
 * that it did. Nothing is dropped here. Every row is still written, still counted in the badge, and
 * still reachable — `ids` carries all of them, so acting on the entry acts on every row behind it,
 * and `bodies` carries the distinct wordings so no message is hidden by the collapse.
 */
export interface InboxEntry {
  id: string;
  title: string;
  body: string;
  category: string | null;
  link: string | null;
  createdAt: Date;
  readAt: Date | null;
  handledAt: Date | null;
  snoozedUntil: Date | null;
  /** Rows this entry stands for, itself included. 1 for an ordinary notification. */
  repeats: number;
  /** Every row it covers, newest first. Acting on the entry acts on all of them. */
  ids: string[];
  /** The DISTINCT wordings among them, newest first — `body` is the first of these. Capped, because
   *  a detail pane listing four hundred variations is its own kind of unreadable. */
  bodies: string[];
}

/** Two rows are the same NOTICE when they say the same thing about the same place. The body is not
 *  part of the key on purpose: two hundred rows differing only in which attempt they name are still
 *  one thing to go and look at, and every distinct wording survives in `bodies`. */
const noticeKey = (row: { title: string; category: string | null; link: string | null }) =>
  JSON.stringify([row.title, row.category ?? "", row.link ?? ""]);

const MAX_BODIES_PER_ENTRY = 20;
const MAX_IDS_PER_ENTRY = 500;

/** Pure, and ORDER-PRESERVING: the caller hands rows newest first and the entries come back in the
 *  order their newest row appeared, so collapsing can never promote an old notice up the queue. */
export function rollUpInbox<T extends {
  id: string; title: string; body: string; category: string | null; link: string | null;
  createdAt: Date; readAt: Date | null; handledAt: Date | null; snoozedUntil: Date | null;
}>(rows: readonly T[]): InboxEntry[] {
  const byKey = new Map<string, InboxEntry>();
  for (const row of rows) {
    const key = noticeKey(row);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        id: row.id,
        title: row.title,
        body: row.body,
        category: row.category,
        link: row.link,
        createdAt: row.createdAt,
        readAt: row.readAt,
        handledAt: row.handledAt,
        snoozedUntil: row.snoozedUntil,
        repeats: 1,
        ids: [row.id],
        bodies: [row.body]
      });
      continue;
    }
    existing.repeats += 1;
    if (existing.ids.length < MAX_IDS_PER_ENTRY) existing.ids.push(row.id);
    if (existing.bodies.length < MAX_BODIES_PER_ENTRY && !existing.bodies.includes(row.body)) existing.bodies.push(row.body);
    // An entry counts as unread while ANY row behind it is unread, and as not-yet-handled while any
    // row is unhandled. The other way round, one glance at the newest would mark the whole burst
    // read and the rest would never be seen again.
    if (!row.readAt) existing.readAt = null;
    if (!row.handledAt) existing.handledAt = null;
  }
  return [...byKey.values()];
}

/** How many rows are scanned before collapsing. Wider than the page it produces, because the whole
 *  point is that one repeated notice must not be able to fill the window. */
const SCAN_LIMIT = 1000;
const PAGE_LIMIT = 200;

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
    prisma.notification.findMany({ where, orderBy: { createdAt: "desc" }, take: SCAN_LIMIT }),
    inboxCounts(userId, now)
  ]);
  // `counts` stays a count of ROWS, not of entries, because that is what the bell and every other
  // place in the app means by "how many notifications". The entries' `repeats` therefore add up to
  // the rows THESE ENTRIES COVER, which is the whole queue only when it fits inside PAGE_LIMIT —
  // exactly as the old row-capped list was only ever the newest 200. Each entry says how many it
  // stands for, so the arithmetic the reader can see is honest either way.
  return { items: rollUpInbox(rows).slice(0, PAGE_LIMIT), counts };
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
