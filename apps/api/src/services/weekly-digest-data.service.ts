/**
 * WHAT: the numbers behind the Monday digest, and the tables that render them.
 *
 * WHY IT IS NOT IN THE WORKER: the worker's job is scheduling and delivery. What a recipient may SEE
 * is an access-control question — an employee gets their own week, a manager or administrator also
 * gets the workspace user-by-user and project-by-project — and that decision belongs beside the
 * queries rather than inside an email template.
 *
 * WHY THE NUMBERS DO NOT DEPEND ON A MODEL: the digest previously consisted of one AI-written
 * paragraph. If the model was slow, unconfigured or too small to answer, the worker logged the error
 * and sent nothing at all — so the report a manager relies on had the availability of an LLM. The
 * tables here are counted from the database and always send; the written summary is a garnish the
 * worker adds when it can.
 *
 * WHY LAST WEEK, MONTH TO DATE AND YEAR TO DATE TOGETHER: "we logged 214 hours" is unreadable alone.
 * The question the reader actually has is whether last week was normal, and that is a comparison
 * against the month and the year. Year to date is the CALENDAR year: this product has no fiscal-year
 * setting anywhere, and inventing one here — silently assuming April, or January — would put a number
 * under a heading it does not match. When a fiscal year is configured one day, this is the one place
 * that changes.
 *
 * WHY APPROVED HOURS ONLY: every other money- and hours-shaped figure in this product counts approved
 * timesheets — the portfolio roll-up, the budget burn, the attestation. A digest that counted drafts
 * would disagree with all of them, and the person who notices is in a review meeting.
 *
 * WHO CALLS THIS: `workers/weekly-digest.worker.ts`.
 */
import { prisma } from "../config/prisma.js";
import { emailBlocks } from "./mail-templates.js";

const { dataTable, periodStrip, share, escape } = emailBlocks;

export interface Period {
  from: Date;
  to: Date;
  label: string;
}

export interface DigestPeriods {
  week: Period;
  month: Period;
  year: Period;
}

/** Timesheets store `workDate` as a UTC-midnight day, so a range built from local dates has to be
 *  converted the same way or a Monday-morning run drops or double-counts a day at each edge. */
const toUtcDay = (d: Date) => new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));

export function buildPeriods(now: Date, weekFrom: Date, weekTo: Date, weekLabel: string): DigestPeriods {
  return {
    week: { from: toUtcDay(weekFrom), to: toUtcDay(weekTo), label: weekLabel },
    month: { from: toUtcDay(new Date(now.getFullYear(), now.getMonth(), 1)), to: toUtcDay(now), label: "Month to date" },
    year: { from: toUtcDay(new Date(now.getFullYear(), 0, 1)), to: toUtcDay(now), label: "Year to date" }
  };
}

interface Totals {
  hours: number;
  ticketsCreated: number;
  ticketsResolved: number;
  /** Change requests RAISED in the period. Counted through the owning ticket, because a
   *  ChangeRequest has no reporter of its own — `ChangeRequest.ticketId` is unique. */
  changesRaised: number;
  /** Change requests that reached CLOSED in the period. `CANCELLED` and `REJECTED` are
   *  deliberately not counted as closed: a change that never happened is not delivered work, and
   *  rolling them in would flatter the number every time a plan is abandoned. */
  changesClosed: number;
}

const hoursIn = async (where: object) =>
  Number((await prisma.timesheet.aggregate({ where, _sum: { totalHours: true } }))._sum.totalHours ?? 0);

/** One person's or one workspace's totals over a period. `userId` omitted means the whole workspace. */
async function totalsFor(period: Period, userId?: string): Promise<Totals> {
  const [hours, created, resolved, changesRaised, changesClosed] = await Promise.all([
    hoursIn({
      deletedAt: null,
      status: "APPROVED",
      workDate: { gte: period.from, lt: period.to },
      ...(userId ? { userId } : {})
    }),
    prisma.ticket.count({
      where: { deletedAt: null, createdAt: { gte: period.from, lt: period.to }, ...(userId ? { reporterId: userId } : {}) }
    }),
    prisma.ticket.count({
      where: { deletedAt: null, resolvedAt: { gte: period.from, lt: period.to }, ...(userId ? { assigneeId: userId } : {}) }
    }),
    // Raised: the change's ticket was created in the window, by this person when scoped.
    prisma.changeRequest.count({
      where: {
        ticket: {
          deletedAt: null,
          createdAt: { gte: period.from, lt: period.to },
          ...(userId ? { reporterId: userId } : {})
        }
      }
    }),
    // Closed: reached CLOSED, attributed to whoever the ticket is assigned to. `updatedAt` is the
    // best available "when did it get there" signal — ChangeRequest carries no closedAt column, and
    // inventing one would need a migration and a backfill that could only guess at history.
    prisma.changeRequest.count({
      where: {
        state: "CLOSED",
        updatedAt: { gte: period.from, lt: period.to },
        ticket: { deletedAt: null, ...(userId ? { assigneeId: userId } : {}) }
      }
    })
  ]);
  return {
    hours: Number(hours.toFixed(2)),
    ticketsCreated: created,
    ticketsResolved: resolved,
    changesRaised,
    changesClosed
  };
}

const hoursLabel = (n: number) => `${n.toFixed(1)}h`;

/* ------------------------------------------------------------------ *
 * The personal half — what every recipient gets
 * ------------------------------------------------------------------ */

async function personalTables(userId: string, periods: DigestPeriods): Promise<string> {
  const [week, month, year] = await Promise.all([
    totalsFor(periods.week, userId),
    totalsFor(periods.month, userId),
    totalsFor(periods.year, userId)
  ]);

  // Where the week's hours went. Grouped in SQL, named in a second query: a project name per row
  // would otherwise be a query per row.
  const byProject = await prisma.timesheet.groupBy({
    by: ["projectId"],
    where: { userId, deletedAt: null, status: "APPROVED", workDate: { gte: periods.week.from, lt: periods.week.to } },
    _sum: { totalHours: true },
    orderBy: { _sum: { totalHours: "desc" } },
    take: 8
  });
  const projects = byProject.length
    ? await prisma.project.findMany({ where: { id: { in: byProject.map((r) => r.projectId) } }, select: { id: true, code: true, name: true } })
    : [];
  const projectName = new Map(projects.map((p) => [p.id, `${p.code} — ${p.name}`]));

  const openAssigned = await prisma.ticket.count({
    where: { assigneeId: userId, deletedAt: null, status: { notIn: ["RESOLVED", "CLOSED"] } }
  });

  return (
    periodStrip([
      { label: periods.week.label, value: hoursLabel(week.hours), sub: `${week.ticketsResolved} resolved` },
      { label: "Month to date", value: hoursLabel(month.hours), sub: `${month.ticketsResolved} resolved` },
      { label: "Year to date", value: hoursLabel(year.hours), sub: `${year.ticketsResolved} resolved` }
    ]) +
    dataTable({
      caption: "Your activity",
      head: ["", "Last week", "Month to date", "Year to date"],
      rows: [
        ["Approved hours", hoursLabel(week.hours), hoursLabel(month.hours), hoursLabel(year.hours)],
        ["Tickets you raised", String(week.ticketsCreated), String(month.ticketsCreated), String(year.ticketsCreated)],
        ["Tickets you resolved", String(week.ticketsResolved), String(month.ticketsResolved), String(year.ticketsResolved)],
        ["Changes you raised", String(week.changesRaised), String(month.changesRaised), String(year.changesRaised)],
        ["Changes you closed", String(week.changesClosed), String(month.changesClosed), String(year.changesClosed)],
        // Open work is a SNAPSHOT, not a period total. The other two columns are dashes rather than a
        // repeated number, because repeating it under "month to date" would claim a measurement that
        // was never taken — and the note below says which column the figure belongs to.
        ["Still assigned to you", String(openAssigned), "—", "—"]
      ]
    }) +
    `<div style="font-size:11px;color:#64748B;margin:-2px 0 4px;">Hours count APPROVED timesheets only, the same basis as the portfolio and budget figures. "Still assigned to you" is a count as of this morning, not a total for a period. A change counts as closed only when it reaches CLOSED — cancelled and rejected changes are not delivered work.</div>` +
    dataTable({
      caption: `Where your hours went — ${periods.week.label}`,
      head: ["Project", "Hours", "Share"],
      rows: byProject.map((r) => [
        escape(projectName.get(r.projectId) ?? "a removed project"),
        hoursLabel(Number(r._sum.totalHours ?? 0)),
        share(Number(r._sum.totalHours ?? 0), week.hours)
      ]),
      empty: "No approved hours last week."
    })
  );
}

/* ------------------------------------------------------------------ *
 * The team half — a manager's own reports, and nobody else's
 * ------------------------------------------------------------------ */

/**
 * WHY THIS EXISTS SEPARATELY FROM THE WORKSPACE HALF: a manager needs to see whether their people
 * logged their week, and previously could not. The digest was binary — hold `reports:view` and see
 * every person in the workspace, or hold nothing and see only yourself — so a line manager with
 * five reports got a personal recap and no way to answer "did my team file their time?".
 *
 * Scoped strictly to `managerId = this manager`. It is a direct-reports view, not a transitive
 * tree: a skip-level manager sees their own reports, and each of those sees theirs. Widening it to
 * the whole subtree would quietly turn a team digest into a department one, and the permission that
 * governs seeing everybody is `reports:view`, which has its own section below.
 */
async function teamTables(managerId: string, periods: DigestPeriods): Promise<string> {
  const reports = await prisma.user.findMany({
    where: { managerId, status: "ACTIVE", deletedAt: null, isAgent: false },
    select: { id: true, name: true, email: true },
    orderBy: { name: "asc" }
  });
  if (reports.length === 0) return "";

  const ids = reports.map((r) => r.id);

  const [hoursByUser, resolvedByUser, openByUser, teamWeek] = await Promise.all([
    prisma.timesheet.groupBy({
      by: ["userId"],
      where: { userId: { in: ids }, deletedAt: null, status: "APPROVED", workDate: { gte: periods.week.from, lt: periods.week.to } },
      _sum: { totalHours: true }
    }),
    prisma.ticket.groupBy({
      by: ["assigneeId"],
      where: { assigneeId: { in: ids }, deletedAt: null, resolvedAt: { gte: periods.week.from, lt: periods.week.to } },
      _count: { _all: true }
    }),
    prisma.ticket.groupBy({
      by: ["assigneeId"],
      where: { assigneeId: { in: ids }, deletedAt: null, status: { notIn: ["RESOLVED", "CLOSED"] } },
      _count: { _all: true }
    }),
    // The team's own roll-up, so the header figure and the rows below cannot disagree.
    Promise.all(ids.map((id) => totalsFor(periods.week, id)))
  ]);

  const hoursFor = new Map(hoursByUser.map((r) => [r.userId, Number(r._sum.totalHours ?? 0)]));
  const resolvedFor = new Map(resolvedByUser.map((r) => [r.assigneeId, r._count._all]));
  const openFor = new Map(openByUser.map((r) => [r.assigneeId, r._count._all]));

  const teamHours = teamWeek.reduce((sum, t) => sum + t.hours, 0);
  const teamResolved = teamWeek.reduce((sum, t) => sum + t.ticketsResolved, 0);
  const teamChangesClosed = teamWeek.reduce((sum, t) => sum + t.changesClosed, 0);
  const loggedCount = reports.filter((r) => (hoursFor.get(r.id) ?? 0) > 0).length;

  return (
    `<div style="margin:26px 0 4px;font-size:13px;font-weight:800;letter-spacing:.4px;text-transform:uppercase;color:#0F172A;">Your team — ${escape(periods.week.label)}</div>` +
    periodStrip([
      { label: "Team hours", value: hoursLabel(teamHours), sub: `${reports.length} report${reports.length === 1 ? "" : "s"}` },
      // The number a manager actually acts on: who did NOT file. Stated as a ratio rather than a
      // percentage, because with five reports a percentage is false precision.
      { label: "Logged last week", value: `${loggedCount}/${reports.length}`, sub: loggedCount === reports.length ? "everyone filed" : `${reports.length - loggedCount} with nothing` },
      { label: "Resolved", value: String(teamResolved), sub: `${teamChangesClosed} change${teamChangesClosed === 1 ? "" : "s"} closed` }
    ]) +
    dataTable({
      caption: "Per person, last week",
      head: ["Person", "Approved hours", "Resolved", "Open now"],
      rows: reports.map((r) => {
        const hours = hoursFor.get(r.id) ?? 0;
        return [
          // A report who filed nothing is the row worth finding, so it is marked rather than left
          // as a 0.0h to be scanned past.
          escape(r.name) + (hours === 0 ? ' <span style="color:#B45309;">· nothing logged</span>' : ""),
          hoursLabel(hours),
          String(resolvedFor.get(r.id) ?? 0),
          String(openFor.get(r.id) ?? 0)
        ];
      }),
      empty: "No active reports."
    }) +
    `<div style="font-size:11px;color:#64748B;margin:-2px 0 4px;">Your direct reports only. Hours are APPROVED timesheets for last week; "Open now" is a count as of this morning.</div>`
  );
}

/* ------------------------------------------------------------------ *
 * The workspace half — managers and administrators only
 * ------------------------------------------------------------------ */

async function workspaceTables(periods: DigestPeriods): Promise<string> {
  const [week, month, year] = await Promise.all([
    totalsFor(periods.week),
    totalsFor(periods.month),
    totalsFor(periods.year)
  ]);

  const [byUser, byProject, openByPriority, totalOpen] = await Promise.all([
    prisma.timesheet.groupBy({
      by: ["userId"],
      where: { deletedAt: null, status: "APPROVED", workDate: { gte: periods.week.from, lt: periods.week.to } },
      _sum: { totalHours: true },
      orderBy: { _sum: { totalHours: "desc" } },
      take: 12
    }),
    prisma.timesheet.groupBy({
      by: ["projectId"],
      where: { deletedAt: null, status: "APPROVED", workDate: { gte: periods.week.from, lt: periods.week.to } },
      _sum: { totalHours: true },
      orderBy: { _sum: { totalHours: "desc" } },
      take: 12
    }),
    prisma.ticket.groupBy({
      by: ["priority"],
      where: { deletedAt: null, status: { notIn: ["RESOLVED", "CLOSED"] } },
      _count: true
    }),
    prisma.ticket.count({ where: { deletedAt: null, status: { notIn: ["RESOLVED", "CLOSED"] } } })
  ]);

  const [users, projects] = await Promise.all([
    byUser.length
      ? prisma.user.findMany({ where: { id: { in: byUser.map((r) => r.userId) } }, select: { id: true, name: true } })
      : [],
    byProject.length
      ? prisma.project.findMany({ where: { id: { in: byProject.map((r) => r.projectId) } }, select: { id: true, code: true, name: true } })
      : []
  ]);
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const projectName = new Map(projects.map((p) => [p.id, `${p.code} — ${p.name}`]));

  // Resolved ÷ created over the same window. Not a "resolution rate" in any strict sense — the
  // tickets resolved last week are mostly not the ones raised last week — so it is labelled as the
  // ratio it is rather than as a performance figure it is not.
  const closedRatio = (t: Totals) => share(t.ticketsResolved, t.ticketsCreated);
  const changeRatio = (t: Totals) => share(t.changesClosed, t.changesRaised);

  return (
    `<div style="margin:26px 0 4px;font-size:13px;font-weight:800;letter-spacing:.4px;text-transform:uppercase;color:#0F172A;">The whole workspace</div>` +
    dataTable({
      caption: "Totals",
      head: ["", "Last week", "Month to date", "Year to date"],
      rows: [
        ["Approved hours", hoursLabel(week.hours), hoursLabel(month.hours), hoursLabel(year.hours)],
        ["Tickets raised", String(week.ticketsCreated), String(month.ticketsCreated), String(year.ticketsCreated)],
        ["Tickets resolved", String(week.ticketsResolved), String(month.ticketsResolved), String(year.ticketsResolved)],
        ["Resolved vs raised", closedRatio(week), closedRatio(month), closedRatio(year)],
        ["Changes raised", String(week.changesRaised), String(month.changesRaised), String(year.changesRaised)],
        ["Changes closed", String(week.changesClosed), String(month.changesClosed), String(year.changesClosed)],
        ["Closed vs raised", changeRatio(week), changeRatio(month), changeRatio(year)]
      ]
    }) +
    dataTable({
      caption: `By person — ${periods.week.label}`,
      head: ["Person", "Hours", "Share"],
      rows: byUser.map((r) => [
        escape(userName.get(r.userId) ?? "a removed account"),
        hoursLabel(Number(r._sum.totalHours ?? 0)),
        share(Number(r._sum.totalHours ?? 0), week.hours)
      ]),
      empty: "No approved hours anywhere last week."
    }) +
    dataTable({
      caption: `By project — ${periods.week.label}`,
      head: ["Project", "Hours", "Share"],
      rows: byProject.map((r) => [
        escape(projectName.get(r.projectId) ?? "a removed project"),
        hoursLabel(Number(r._sum.totalHours ?? 0)),
        share(Number(r._sum.totalHours ?? 0), week.hours)
      ]),
      empty: "No approved hours against any project last week."
    }) +
    dataTable({
      caption: "Open tickets right now, by priority",
      head: ["Priority", "Open", "Share"],
      rows: openByPriority
        .sort((a, b) => b._count - a._count)
        .map((r) => [escape(r.priority), String(r._count), share(r._count, totalOpen)]),
      empty: "Nothing open."
    })
  );
}

/**
 * Everything the digest shows this person, as ready-to-send HTML.
 *
 * The workspace half is appended only for somebody who may already see it elsewhere — the same
 * permission that opens the reports pages. A digest must never become a way around a permission.
 */
/**
 * How much of the workspace this recipient's digest may show.
 *
 *   SELF      — their own week. Everybody gets this.
 *   TEAM      — plus their direct reports. Anybody who has reports.
 *   WORKSPACE — plus every person and project. Anybody holding `reports:view`.
 *
 * The levels ACCUMULATE rather than replace: a super admin who also line-manages three people
 * gets their own week, then their team, then the workspace. Before this, the digest was binary and
 * a manager without `reports:view` had no way to see whether their own reports had filed.
 */
export type DigestScope = "SELF" | "TEAM" | "WORKSPACE";

export async function buildDigestTables(params: {
  userId: string;
  periods: DigestPeriods;
  scope: DigestScope;
}): Promise<string> {
  let html = await personalTables(params.userId, params.periods);

  // A WORKSPACE recipient still gets their team section when they have reports — the workspace
  // table is 12 rows of everybody and does not answer "did MY people file this week".
  if (params.scope === "TEAM" || params.scope === "WORKSPACE") {
    html += await teamTables(params.userId, params.periods);
  }
  if (params.scope === "WORKSPACE") {
    html += await workspaceTables(params.periods);
  }
  return html;
}
