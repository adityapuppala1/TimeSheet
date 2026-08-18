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
}

const hoursIn = async (where: object) =>
  Number((await prisma.timesheet.aggregate({ where, _sum: { totalHours: true } }))._sum.totalHours ?? 0);

/** One person's or one workspace's totals over a period. `userId` omitted means the whole workspace. */
async function totalsFor(period: Period, userId?: string): Promise<Totals> {
  const [hours, created, resolved] = await Promise.all([
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
    })
  ]);
  return { hours: Number(hours.toFixed(2)), ticketsCreated: created, ticketsResolved: resolved };
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
        // Open work is a SNAPSHOT, not a period total. The other two columns are dashes rather than a
        // repeated number, because repeating it under "month to date" would claim a measurement that
        // was never taken — and the note below says which column the figure belongs to.
        ["Still assigned to you", String(openAssigned), "—", "—"]
      ]
    }) +
    `<div style="font-size:11px;color:#64748B;margin:-2px 0 4px;">Hours count APPROVED timesheets only, the same basis as the portfolio and budget figures. "Still assigned to you" is a count as of this morning, not a total for a period.</div>` +
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

  return (
    `<div style="margin:26px 0 4px;font-size:13px;font-weight:800;letter-spacing:.4px;text-transform:uppercase;color:#0F172A;">The whole workspace</div>` +
    dataTable({
      caption: "Totals",
      head: ["", "Last week", "Month to date", "Year to date"],
      rows: [
        ["Approved hours", hoursLabel(week.hours), hoursLabel(month.hours), hoursLabel(year.hours)],
        ["Tickets raised", String(week.ticketsCreated), String(month.ticketsCreated), String(year.ticketsCreated)],
        ["Tickets resolved", String(week.ticketsResolved), String(month.ticketsResolved), String(year.ticketsResolved)],
        ["Resolved vs raised", closedRatio(week), closedRatio(month), closedRatio(year)]
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
export async function buildDigestTables(params: {
  userId: string;
  periods: DigestPeriods;
  includeWorkspace: boolean;
}): Promise<string> {
  const personal = await personalTables(params.userId, params.periods);
  if (!params.includeWorkspace) return personal;
  return personal + (await workspaceTables(params.periods));
}
