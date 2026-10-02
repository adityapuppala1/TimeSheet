/**
 * WHAT: a manager's "my team" view — direct reports with timesheet roll-up stats, escalations
 * targeted at them, and an SLA summary for the manager dashboard.
 * WHY: `User.managerId` already encodes the reporting chain; this router is the read-only
 * aggregation over it that `apps/web/src/pages/Team.tsx` renders, computed here rather than
 * client-side so the numbers stay consistent regardless of how much history a report has.
 * WHO calls this: `apps/web/src/pages/Team.tsx`.
 */
import { Router } from "express";
import { prisma } from "../config/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";
import { COUNTED_PEOPLE } from "../services/people-visibility.service.js";
import { LOGGED_HOURS_WHERE } from "../services/workspace-metrics.js";
import { platformDayStart, platformMonth, platformToday, platformWeekStart } from "../utils/date-window.js";
import { CHAT_INTAKE_SYSTEM_EMAIL } from "../services/chat-intake.service.js";
import { EMAIL_INTAKE_SYSTEM_EMAIL } from "../services/email-intake.service.js";
import { SECURITY_INGESTION_SYSTEM_EMAIL } from "../services/security-report.service.js";
import { GIT_INTEGRATION_SYSTEM_EMAIL } from "../services/git-provider.service.js";
import { AGENT_SYSTEM_EMAIL } from "../services/principal.service.js";

/** Unusable-password reporter-of-record accounts (see each constant's own file) — never real
 *  people, so they'd otherwise show up as noise root nodes in the org chart below.
 *
 *  This list must name EVERY such account. `GIT_INTEGRATION_SYSTEM_EMAIL` was missing from it and
 *  so was appearing as a person in the org chart — the failure mode is silent, because a system
 *  account looks exactly like a real employee with no manager and no reports. */
const SYSTEM_ACCOUNT_EMAILS = new Set([
  CHAT_INTAKE_SYSTEM_EMAIL,
  EMAIL_INTAKE_SYSTEM_EMAIL,
  SECURITY_INGESTION_SYSTEM_EMAIL,
  GIT_INTEGRATION_SYSTEM_EMAIL,
  AGENT_SYSTEM_EMAIL
]);

export const teamRouter = Router();
teamRouter.use(requireAuth);

/**
 * GET /api/team/reports
 * Direct reports of the current user, with timesheet roll-ups.
 *
 * DEACTIVATED REPORTS ARE DROPPED. Every row here is a per-person statistic and a door into the
 * hours-trend dialog below, which is exactly what a deactivated colleague should stop having on
 * screen. `managerId` is not cleared when somebody is deactivated — deliberately, because the
 * reporting line is history worth keeping — so without this predicate a manager's team page grew
 * monotonically and never shrank. What that person logged is still in every export and in the
 * workspace totals; it is the named row and its trend that go.
 */
/** The window the roster's per-person figures cover. Pending entries are counted whatever their
 *  date — a queue waiting now is waiting now — but the rest is the last quarter, not all history. */
const ROSTER_WINDOW_DAYS = 90;

teamRouter.get("/reports", async (req, res) => {
  const reports = await prisma.user.findMany({
    where: { managerId: req.user!.id, ...COUNTED_PEOPLE },
    select: { id: true, name: true, email: true, status: true, avatarUrl: true, bio: true, role: { select: { name: true } } },
    orderBy: { name: "asc" }
  });
  const ids = reports.map((r) => r.id);
  const now = new Date();
  const today = platformToday(now);
  const windowStart = new Date(today.getTime() - (ROSTER_WINDOW_DAYS - 1) * DAY_MS);

  // Aggregated in the database, over a stated window. This used to load every timesheet each
  // report had ever logged and count them in Node — the page got slower every week anybody worked.
  const [byStatus, pendingNow, deadlines] = ids.length
    ? await Promise.all([
        prisma.timesheet.groupBy({
          by: ["userId", "status"],
          where: { userId: { in: ids }, deletedAt: null, workDate: { gte: windowStart, lte: today } },
          _count: { _all: true },
          _sum: { totalHours: true }
        }),
        prisma.timesheet.groupBy({ by: ["userId"], where: { userId: { in: ids }, deletedAt: null, status: "SUBMITTED" }, _count: { _all: true } }),
        // Approval-SLA breaches from the deadline (workspace-metrics.ts), not from `slaBreachAt`,
        // which only the SLA_ENABLED sweep writes.
        prisma.timesheet.findMany({
          where: { userId: { in: ids }, deletedAt: null, approvalDeadline: { gte: platformDayStart(windowStart), lt: now } },
          select: { userId: true, approvalDeadline: true, reviewedAt: true }
        })
      ])
    : [[], [], []];

  const enriched = reports.map((person) => {
    const mine = byStatus.filter((g) => g.userId === person.id);
    const countOf = (status: string) => mine.find((g) => g.status === status)?._count._all ?? 0;
    const approvedHours = Number(mine.find((g) => g.status === "APPROVED")?._sum.totalHours ?? 0);
    const slaBreached = deadlines.filter(
      (d) => d.userId === person.id && d.approvalDeadline !== null && (d.reviewedAt ?? now).getTime() > d.approvalDeadline.getTime()
    ).length;
    return {
      ...person,
      role: person.role.name,
      stats: {
        total: mine.reduce((sum, g) => sum + g._count._all, 0),
        pending: pendingNow.find((g) => g.userId === person.id)?._count._all ?? 0,
        approved: countOf("APPROVED"),
        rejected: countOf("REJECTED"),
        slaBreached,
        approvedHours: Number(approvedHours.toFixed(2)),
        windowDays: ROSTER_WINDOW_DAYS
      }
    };
  });

  res.json(enriched);
});

/**
 * GET /api/team/reports/:userId/hours-trend
 * Logged-hours trend for ONE direct report: week-by-week inside the current month, plus the
 * trailing 12 calendar months. Backs the per-person dialog on `apps/web/src/pages/Team.tsx`.
 *
 * WHY LOGGED HOURS — submitted + approved (services/workspace-metrics.ts) — and not just approved:
 * this answers "how much is this person working", and a submitted entry is work that was done and
 * vouched for. Drafts and rejected hours are not: they used to be counted, so this trend disagreed
 * with every other hours figure in the product. The approved-only total is `stats.approvedHours`.
 *
 * "This month" is the PLATFORM's month (IST); workDate values stay UTC-midnight calendar days.
 *
 * WHY EVERY DATE CALCULATION USES THE UTC GETTERS: `Timesheet.workDate` is written as a UTC
 * midnight (see timesheet.controller.ts), so reading it with local getters would push a day's
 * hours into the previous bucket for any server west of UTC.
 */
const TREND_MONTHS = 12;
const DAY_MS = 24 * 60 * 60 * 1000;

function utcDayOf(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function utcIsoWeekStart(date: Date): Date {
  const d = utcDayOf(date);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // Mon=0..Sun=6
  return d;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

teamRouter.get("/reports/:userId/hours-trend", async (req, res) => {
  // The scope check IS the lookup: this is the same predicate `/reports` filters the roster by,
  // so a userId belonging to somebody else's team simply doesn't match and there is no window in
  // which their rows could be aggregated. 404 rather than 403 so this can't be used to probe
  // which user ids exist outside my own team.
  //
  // It has to stay IDENTICAL to the roster's, which is why both spell it with the same constant.
  // A deactivated report is no longer listed, so this dialog cannot be opened for them from the
  // page — but a bookmarked or shared URL would still have reached the endpoint, and a trend
  // that is hidden everywhere except to whoever kept the link is not hidden.
  const report = await prisma.user.findFirst({
    where: { id: String(req.params.userId), managerId: req.user!.id, ...COUNTED_PEOPLE },
    select: { id: true, name: true }
  });
  if (!report) throw new AppError(404, "No such direct report.");

  // IST's month: from 00:00 to 05:30 IST on the 1st, UTC is still in last month.
  const thisMonth = platformMonth(new Date());
  const monthStart = thisMonth.start;
  const monthEnd = new Date(thisMonth.end.getTime() - DAY_MS);
  const windowStart = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() - (TREND_MONTHS - 1), 1));

  // Summed in the database — at most one row per calendar day comes back, and only the ~17
  // finished buckets reach the client. Raw timesheet rows never leave the server.
  const daily = await prisma.timesheet.groupBy({
    by: ["workDate"],
    where: { userId: report.id, deletedAt: null, ...LOGGED_HOURS_WHERE, workDate: { gte: windowStart, lte: monthEnd } },
    _sum: { totalHours: true },
    _count: true
  });

  const months = Array.from({ length: TREND_MONTHS }, (_, i) => ({
    monthStart: isoDate(new Date(Date.UTC(windowStart.getUTCFullYear(), windowStart.getUTCMonth() + i, 1))),
    hours: 0,
    entries: 0
  }));
  const monthIndex = new Map(months.map((m, i) => [m.monthStart, i]));

  // ISO weeks CLIPPED to the month, so the first and last bucket may be short. A bucket that
  // ran into a neighbouring month would attribute hours the monthly chart beside it counts
  // elsewhere, which is exactly the comparison this dialog exists to support.
  const firstWeekStart = utcIsoWeekStart(monthStart);
  const weeks: Array<{ weekStart: string; weekEnd: string; hours: number; entries: number }> = [];
  for (const cursor = new Date(firstWeekStart); cursor <= monthEnd; cursor.setUTCDate(cursor.getUTCDate() + 7)) {
    const weekEnd = new Date(cursor);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
    weeks.push({
      weekStart: isoDate(cursor < monthStart ? monthStart : cursor),
      weekEnd: isoDate(weekEnd > monthEnd ? monthEnd : weekEnd),
      hours: 0,
      entries: 0
    });
  }

  for (const row of daily) {
    const day = utcDayOf(row.workDate);
    const hours = Number(row._sum.totalHours ?? 0);

    const mi = monthIndex.get(isoDate(new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1))));
    if (mi !== undefined) {
      months[mi].hours += hours;
      months[mi].entries += row._count;
    }

    if (day >= monthStart && day <= monthEnd) {
      const wi = Math.floor((day.getTime() - firstWeekStart.getTime()) / (7 * DAY_MS));
      if (weeks[wi]) {
        weeks[wi].hours += hours;
        weeks[wi].entries += row._count;
      }
    }
  }

  const round = <T extends { hours: number }>(bucket: T): T => ({ ...bucket, hours: Number(bucket.hours.toFixed(2)) });

  res.json({
    user: { id: report.id, name: report.name },
    currentMonth: { monthStart: isoDate(monthStart), weeks: weeks.map(round) },
    monthly: months.map(round)
  });
});

/**
 * GET /api/team/escalations
 * Escalations currently targeted at the calling user.
 */
teamRouter.get("/escalations", async (req, res) => {
  const escalations = await prisma.escalation.findMany({
    where: { escalatedToId: req.user!.id, resolvedAt: null },
    orderBy: { createdAt: "desc" },
    include: {
      escalatedFromUser: { select: { id: true, name: true, email: true } },
      timesheet: {
        include: {
          user: { select: { id: true, name: true, email: true, avatarUrl: true } },
          project: { select: { name: true, code: true } }
        }
      }
    },
    take: 100
  });
  res.json(escalations);
});

/**
 * GET /api/team/sla-summary
 * High-level approval SLA snapshot for the manager dashboard.
 */
teamRouter.get("/sla-summary", async (req, res) => {
  const myReportIds = (
    await prisma.user.findMany({
      // Same roster as `/reports` renders, so the card and the list beside it cannot disagree
      // about who is on this team.
      where: { managerId: req.user!.id, ...COUNTED_PEOPLE },
      select: { id: true }
    })
  ).map((u) => u.id);

  if (myReportIds.length === 0) {
    return res.json({ submitted: 0, breached: 0, breachedLastWeek: 0, approvedThisWeek: 0, approvedLastWeek: 0, openEscalations: 0 });
  }

  // "Now" figures (pending, open escalations) carry no comparison: their old "vs yesterday" was the
  // part of today's set that already existed yesterday, a number that can only make the badge go up.
  // Period figures compare like-for-like on the IST calendar.
  const now = new Date();
  const todayStart = platformDayStart(platformToday(now));
  const weekStart = platformWeekStart(now);
  const today = platformToday(now);
  const WEEK_MS = 7 * DAY_MS;
  const approvedHours = (gte: Date, lte: Date) =>
    prisma.timesheet
      .aggregate({ where: { userId: { in: myReportIds }, status: "APPROVED", deletedAt: null, workDate: { gte, lte } }, _sum: { totalHours: true } })
      .then((r) => Number(Number(r._sum.totalHours ?? 0).toFixed(2)));
  /** Approval deadlines in [from, to) that passed before a decision — `(reviewedAt ?? now) > deadline`. */
  const breachesBetween = async (from: Date, to: Date) => {
    const rows = await prisma.timesheet.findMany({
      where: { userId: { in: myReportIds }, deletedAt: null, approvalDeadline: { gte: from, lt: to } },
      select: { approvalDeadline: true, reviewedAt: true }
    });
    return rows.filter((r) => r.approvalDeadline !== null && (r.reviewedAt ?? now).getTime() > r.approvalDeadline.getTime()).length;
  };

  const [submitted, breached, breachedLastWeek, approvedThisWeek, approvedLastWeek, openEscalations] = await Promise.all([
    prisma.timesheet.count({ where: { userId: { in: myReportIds }, status: "SUBMITTED", deletedAt: null } }),
    breachesBetween(todayStart, now),
    breachesBetween(new Date(todayStart.getTime() - WEEK_MS), new Date(now.getTime() - WEEK_MS)),
    approvedHours(weekStart, today),
    approvedHours(new Date(weekStart.getTime() - WEEK_MS), new Date(today.getTime() - WEEK_MS)),
    prisma.escalation.count({ where: { escalatedToId: req.user!.id, resolvedAt: null } })
  ]);

  res.json({
    submitted,
    /** Approval deadlines that fell today (IST) and passed before a decision, and the same day last week. */
    breached,
    breachedLastWeek,
    /** Approved HOURS, Monday to today (IST), and the same weekdays of last week. */
    approvedThisWeek,
    approvedLastWeek,
    openEscalations
  });
});

/**
 * GET /api/team/org-chart
 * Reporting-line tree built from the existing User.managerId self-relation — no new schema,
 * just a new read over data that already exists (see docs/ROADMAP.md's "TL/Manager mapping —
 * new surfaces on existing data"). Privileged roles (SUPER_ADMIN/ADMIN) see the whole company
 * tree (every user with no manager, and their descendants); everyone else sees only their own
 * subtree (themselves + direct + indirect reports) — the same privileged-vs-scoped split
 * `ticketProjectScope` already uses elsewhere, just applied to the manager chain instead of
 * project assignments.
 */
interface OrgChartUser {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  designation: string | null;
  managerId: string | null;
  role: { name: string };
}

/**
 * WHOSE TREE a person sees.
 *
 * THE BUG THIS REPLACED: a non-privileged caller was rooted at THEMSELVES, so the chart showed
 * them their own reports and nothing else — an employee with no reports saw a diagram containing
 * one box, themselves, which answers no question anybody has. It could not show you your own
 * manager, and it could not show you the people you sit next to.
 *
 * Now a non-privileged caller is rooted at their MANAGER, which is the smallest tree that answers
 * the two questions actually asked of an org chart: who do I report to, and who else is on my
 * team. Their own subtree still hangs off it, so a team lead keeps seeing their reports. Somebody
 * with no manager set is rooted at themselves, as before — there is nothing above them to show.
 *
 * Pure, and exported, so the rule is testable without standing up a request.
 */
export function orgChartRoots<T extends { id: string; managerId: string | null }>(
  users: T[],
  viewerId: string,
  privileged: boolean
): T[] {
  if (privileged) return users.filter((u) => u.managerId === null);
  const self = users.find((u) => u.id === viewerId);
  if (!self) return [];
  const manager = self.managerId ? users.find((u) => u.id === self.managerId) : undefined;
  return [manager ?? self];
}

export interface OrgChartNode {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  designation: string | null;
  role: string;
  reports: OrgChartNode[];
}

/**
 * The tree under `roots`, each person drawn ONCE.
 *
 * WHY THE VISITED SET. Reporting lines are now refused when they would loop (see
 * services/reporting-line.service.ts), but data written before that may still hold A → B → A, and
 * this recursion used to follow it until the stack ran out — a 500 for everyone in or under the
 * loop. A person already drawn is not drawn again, so a loop renders as the chain it is.
 *
 * Pure, and exported, so the shape is testable without standing up a request.
 */
export function buildOrgChart(users: OrgChartUser[], roots: OrgChartUser[]): OrgChartNode[] {
  const byManager = new Map<string | null, OrgChartUser[]>();
  for (const user of users) {
    const bucket = byManager.get(user.managerId);
    if (bucket) bucket.push(user);
    else byManager.set(user.managerId, [user]);
  }

  const drawn = new Set<string>();
  function buildNode(user: OrgChartUser): OrgChartNode {
    drawn.add(user.id);
    const reports: OrgChartNode[] = [];
    for (const report of byManager.get(user.id) ?? []) {
      if (!drawn.has(report.id)) reports.push(buildNode(report));
    }
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      avatarUrl: user.avatarUrl,
      designation: user.designation,
      role: user.role.name,
      reports
    };
  }

  return roots.filter((root) => !drawn.has(root.id)).map(buildNode);
}

teamRouter.get("/org-chart", async (req, res) => {
  const allUsers: OrgChartUser[] = await prisma.user.findMany({
    // People only: an AI agent identity is an ACTIVE user row and would otherwise sit on the chart as
    // a colleague with no manager.
    where: { deletedAt: null, status: "ACTIVE", isAgent: false },
    select: {
      id: true,
      name: true,
      email: true,
      avatarUrl: true,
      designation: true,
      managerId: true,
      role: { select: { name: true } }
    },
    orderBy: { name: "asc" }
  });
  const users = allUsers.filter((u) => !SYSTEM_ACCOUNT_EMAILS.has(u.email));

  const privileged = ["SUPER_ADMIN", "ADMIN"].includes(req.user!.role);
  res.json(buildOrgChart(users, orgChartRoots(users, req.user!.id, privileged)));
});

/**
 * GET /api/team/timesheet-anomalies
 * Opt-in manager insight — flags unusual hour patterns among direct reports, not an automatic
 * block (same human-review posture low-confidence email/chat triage already uses elsewhere in
 * this app). Two deterministic checks, no AI/LLM call needed since this is threshold arithmetic
 * over data already logged, not a language-understanding task:
 *  - BURNOUT: a direct report logged 55+ hours in any of the last 4 ISO weeks (sustained
 *    overtime signal).
 *  - IMPLAUSIBLE: a direct report logged more than 16 hours on a single day (a plain physical
 *    upper bound — flags likely data-entry errors or padded entries, not an accusation).
 * Thresholds are fixed constants for this first pass, not admin-configurable yet — tune them
 * from real usage before exposing a settings UI for numbers nobody has validated.
 */
const BURNOUT_WEEKLY_HOURS_THRESHOLD = 55;
const IMPLAUSIBLE_DAILY_HOURS_THRESHOLD = 16;

function isoWeekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  d.setUTCDate(d.getUTCDate() - day); // Monday of that week
  return d.toISOString().slice(0, 10);
}

teamRouter.get("/timesheet-anomalies", async (req, res) => {
  const myReportIds = (
    await prisma.user.findMany({
      // Same roster as `/reports` renders, so the card and the list beside it cannot disagree
      // about who is on this team.
      where: { managerId: req.user!.id, ...COUNTED_PEOPLE },
      select: { id: true }
    })
  ).map((u) => u.id);

  if (myReportIds.length === 0) return res.json({ burnout: [], implausible: [] });

  const fourWeeksAgo = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000);
  const entries = await prisma.timesheet.findMany({
    where: { userId: { in: myReportIds }, deletedAt: null, workDate: { gte: fourWeeksAgo } },
    select: { userId: true, workDate: true, totalHours: true, user: { select: { name: true } } }
  });

  const weeklyByUser = new Map<string, Map<string, number>>();
  const dailyByUser = new Map<string, Map<string, number>>();
  for (const entry of entries) {
    const hours = Number(entry.totalHours);
    const weekKey = isoWeekKey(entry.workDate);
    const dayKey = entry.workDate.toISOString().slice(0, 10);

    const weekMap = weeklyByUser.get(entry.userId) ?? new Map<string, number>();
    weekMap.set(weekKey, (weekMap.get(weekKey) ?? 0) + hours);
    weeklyByUser.set(entry.userId, weekMap);

    const dayMap = dailyByUser.get(entry.userId) ?? new Map<string, number>();
    dayMap.set(dayKey, (dayMap.get(dayKey) ?? 0) + hours);
    dailyByUser.set(entry.userId, dayMap);
  }

  const namesById = new Map(entries.map((e) => [e.userId, e.user.name]));

  const burnout: Array<{ userId: string; name: string; weekStart: string; hours: number }> = [];
  for (const [userId, weekMap] of weeklyByUser) {
    for (const [weekStart, hours] of weekMap) {
      if (hours >= BURNOUT_WEEKLY_HOURS_THRESHOLD) {
        burnout.push({ userId, name: namesById.get(userId) ?? "Unknown", weekStart, hours: Number(hours.toFixed(1)) });
      }
    }
  }

  const implausible: Array<{ userId: string; name: string; date: string; hours: number }> = [];
  for (const [userId, dayMap] of dailyByUser) {
    for (const [date, hours] of dayMap) {
      if (hours > IMPLAUSIBLE_DAILY_HOURS_THRESHOLD) {
        implausible.push({ userId, name: namesById.get(userId) ?? "Unknown", date, hours: Number(hours.toFixed(1)) });
      }
    }
  }

  burnout.sort((a, b) => b.hours - a.hours);
  implausible.sort((a, b) => b.hours - a.hours);

  res.json({ burnout, implausible });
});
