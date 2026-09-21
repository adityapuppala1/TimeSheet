/**
 * WHAT: the figures behind the Weekly AI/ML Practice Update — one consolidated executive view of
 * Products, POCs/Innovation, Bugs/Stability, Security, Training, the week's metrics, and what is
 * at risk.
 *
 * WHY IT IS A SEPARATE SERVICE FROM THE NARRATIVE: everything here is COUNTED, from this database,
 * and goes out whether or not a model answers. `ai.service.ts#generatePracticeUpdate` writes the
 * prose around these numbers and is allowed to fail. That division is not a preference — it is the
 * correction `weekly-digest.worker.ts` carries in its own header, where gating the whole digest on
 * the model succeeding meant an unconfigured or slow one sent nothing at all.
 *
 * WHY INITIATIVES ARE PROJECTS: the CEO's format asks for Owner / Status / This Week's Progress /
 * Next Steps / Risks per initiative. A project already carries all of that in data the team
 * produces by working — tickets, hours, SLA state — so nobody has to fill in a form. The
 * alternative, a free-form weekly initiative list, is precisely the "detailed status-reporting
 * exercise" the request said it did not want.
 *
 * WHAT IS DERIVED AND WHAT IS NOT, stated plainly because a reader is entitled to know:
 *  - Counts, hours, releases, findings: read from the database.
 *  - Category (Product / POC / Bug / Security / Training): INFERRED, from the project's name and
 *    what its people actually logged against it. A wrong guess is visible and correctable in the
 *    draft before anything is sent.
 *  - Owner: whoever logged the most hours on it this period, falling back to the most-assigned
 *    ticket holder. `Project` has no owner column, and inventing one for this would be a schema
 *    change nobody asked for.
 *  - RAG status: arithmetic, from overdue and SLA-breach counts — never a model's opinion. A red a
 *    model chose is not reproducible in the meeting where someone asks why their project is red.
 */
import type { TicketStatus } from "@prisma/client";
import { securityDisciplineFindingTypes } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { isChangeManagementOn } from "./change.service.js";
import { buildPracticeAnalytics, type PracticeAnalytics } from "./practice-analytics.service.js";
import { htmlToText } from "../utils/sanitize.js";

export type PracticeCategory = "PRODUCT" | "POC" | "BUGS" | "SECURITY" | "TRAINING";

/** The CEO's section order, and the order the email renders in. */
export const PRACTICE_CATEGORIES: Array<{ key: PracticeCategory; label: string }> = [
  { key: "PRODUCT", label: "Products / Features" },
  { key: "POC", label: "POCs / Innovation" },
  { key: "BUGS", label: "Bugs / Stability" },
  { key: "SECURITY", label: "Security" },
  { key: "TRAINING", label: "Training / Capability Building" }
];

export type RagStatus = "GREEN" | "AMBER" | "RED";

/** 🟢/🟡/🔴, as the request asked for them. */
export const RAG_EMOJI: Record<RagStatus, string> = { GREEN: "🟢", AMBER: "🟡", RED: "🔴" };

export interface PracticeInitiative {
  id: string;
  name: string;
  code: string | null;
  category: PracticeCategory;
  owner: string | null;
  status: RagStatus;
  ticketsCreated: number;
  ticketsClosed: number;
  openCount: number;
  overdueCount: number;
  hours: number;
  /** Open CRITICAL and HIGH tickets. "Critical/high-priority issues" is what the Bugs / Stability
   *  section was asked for by name, and a single open count cannot answer it — twelve open lows and
   *  twelve open criticals are the same number and a different conversation. */
  criticalOpen?: number;
  highOpen?: number;
  /** The nearest unmet deadline on this initiative, ISO date, or null when nothing is dated. It is
   *  what makes "Next steps" a fact rather than a guess when the model writes nothing.
   *
   *  All three are optional for the same reason `analytics` is: a stored draft written before this
   *  release carries none of them, and the cast that replays it checks nothing. */
  nextDueDate?: string | null;
  /**
   * WHAT happened, named — as opposed to how much, which is every field above.
   *
   * A count tells a reader that four things closed; it cannot tell them that one of the four was
   * the payment bug the CEO asked about on Monday. These are the handful of concrete facts the
   * narrative is allowed to reach for, capped hard because this is a digest and not a log.
   * Optional for the same reason the fields above it are: a draft stored before this release
   * carries none of them and must still render.
   */
  highlights?: {
    /** Work that reached a closed state inside the window. */
    closed: Array<{ key: string; title: string; by: string | null }>;
    /** Raised inside the window and still open — the new load, not the backlog. */
    opened: Array<{ key: string; title: string; priority: string }>;
    /** What people actually logged against it, in their own words. */
    work: Array<{ who: string; hours: number; what: string }>;
  };
  /** One line of what actually moved, assembled from the counts above. */
  progress: string;
  /** One line of what is in the way, or empty when nothing is. */
  risks: string;
}

export interface PracticeMetrics {
  ticketsCreated: number;
  ticketsClosed: number;
  hours: number;
  billableHours: number;
  contributors: number;
  overdue: number;
  /**
   * TIMESHEET APPROVALS that blew their SLA in the period — NOT tickets.
   *
   * The name is kept because it is persisted inside `PracticeUpdateRecord.data` and every stored
   * draft and history row already carries it; renaming the field would make those rows render
   * `undefined`. What was wrong was every LABEL around it, which said "SLA breaches" beside a
   * column of ticket figures, so a reader concluded that many TICKETS had breached. On the dev
   * workspace the two differ by an order of magnitude — 23 approvals against 320 tickets past SLA
   * — and this figure also forces an initiative RED, so a project was going red for late timesheet
   * approvals inside a row that otherwise talks only about tickets.
   */
  slaBreaches: number;
  openEscalations: number;
  changesRaised: number;
  changesImplemented: number;
  releases: number;
  securityOpenCritical: number;
  securityOpenHigh: number;
  securityNewFindings: number;
  trainingHours: number;
}

export interface PracticeUpdateData {
  period: { from: string; to: string; label: string };
  previous: { from: string; to: string };
  metrics: PracticeMetrics;
  /** Same shape as `metrics`, for the week before — every figure gets a delta or none does. */
  previousMetrics: PracticeMetrics;
  initiatives: PracticeInitiative[];
  /**
   * The derived layer — rates, quality gates, remediation, capacity. Computed alongside the counts
   * above rather than in the email, so the web preview, the email and the AI prompt all read the
   * same figures. See practice-analytics.service.ts.
   *
   * OPTIONAL because this type is also the shape a stored `PracticeUpdateRecord.data` is cast to,
   * and every draft written before this layer existed has no such key. Marking it optional is what
   * makes the compiler insist every reader handle that — the renderers go through `analyticsOf`,
   * which substitutes `EMPTY_PRACTICE_ANALYTICS`. A freshly built report always has it.
   */
  analytics?: PracticeAnalytics;
  /** Same shape, for the period before, so a rate can carry a direction and not just a value.
   *  Optional for the same reason. */
  previousAnalytics?: PracticeAnalytics;
  releases: Array<{ version: string; product: string | null; closedAt: string | null; state: string }>;
  /** Nothing at all happened in the period. The caller decides what to do about it rather than
   *  this returning a misleadingly cheerful empty report. */
  isEmpty: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** How many rows the three "what actually happened" reads scan across the WHOLE update before each
 *  project takes its own few off the top. A digest that scanned without a bound would turn one
 *  weekly email into the slowest query in the app on the workspace with the most work in it. */
const HIGHLIGHT_SCAN_CAP = 400;
/** Per initiative, per kind. Three is a digest; ten is a log, and nobody reads the log. */
const HIGHLIGHTS_PER_INITIATIVE = 3;
// NOT `as const`: Prisma's generated `in`/`notIn` want a mutable TicketStatus[], and a readonly
// tuple is rejected. Typed through the generated enum so a renamed status is a compile error
// here rather than a silently-zero count.
const CLOSED_TICKET: TicketStatus[] = ["RESOLVED", "CLOSED"];

/** The three finding counts in this update are labelled "security" where they are read, so they are
 *  filtered to the security discipline — see `securityFindingTypeDisciplines` in packages/shared.
 *  Code-quality and lint findings share the table and would otherwise be counted as vulnerabilities
 *  in a governance report. */
const SECURITY_DISCIPLINE = { type: { in: securityDisciplineFindingTypes } };

/** Timesheets store `workDate` as a UTC-midnight day, so a range built from local dates has to be
 *  converted the same way or a Monday-morning run drops a day at each edge — the same trap
 *  `weekly-digest-data.service.ts` documents. */
const toUtcDay = (d: Date) => new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));

/** Monday 00:00 of the week containing `now`, and the Sunday that ends it. */
export function lastCompleteWeek(now: Date): { from: Date; to: Date; label: string } {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const mondayOffset = (day.getDay() + 6) % 7;
  const thisMonday = new Date(day.getTime() - mondayOffset * DAY_MS);
  const from = new Date(thisMonday.getTime() - 7 * DAY_MS);
  const to = new Date(thisMonday.getTime() - DAY_MS);
  const fmt = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  return { from, to, label: `${fmt(from)} – ${fmt(to)} ${to.getFullYear()}` };
}

const NAME_RULES: Array<{ category: PracticeCategory; test: RegExp }> = [
  { category: "SECURITY", test: /secur|vapt|pentest|complian/i },
  { category: "TRAINING", test: /learn|training|certif|academy|upskill|enablement/i },
  { category: "POC", test: /poc|proof.of.concept|proto|pilot|innovat|experiment|drill|spike|r&d/i }
];

/** Activity types that mean "this was learning, not delivery". Matches what people actually pick
 *  in this workspace — Learning, Code Study, Documentation — rather than a fixed enum. */
const TRAINING_ACTIVITY = /learn|study|training|certif|onboard|document/i;
const POC_ACTIVITY = /poc|proof|proto|spike|research/i;

/**
 * Which of the CEO's buckets a project belongs in.
 *
 * The project's NAME wins when it says so outright, because a project called "Security Hardening"
 * is that regardless of what got logged against it last week. Otherwise the week's own work
 * decides: mostly learning hours means Training, mostly POC hours means POC, mostly bug tickets
 * means Bugs/Stability, and anything else is a product.
 */
export function categoriseInitiative(input: {
  name: string;
  code?: string | null;
  hoursByActivity: Map<string, number>;
  closedBugs: number;
  closedTotal: number;
}): PracticeCategory {
  const haystack = `${input.name} ${input.code ?? ""}`;
  for (const rule of NAME_RULES) {
    if (rule.test.test(haystack)) return rule.category;
  }

  let total = 0;
  let training = 0;
  let poc = 0;
  for (const [activity, hours] of input.hoursByActivity) {
    total += hours;
    if (TRAINING_ACTIVITY.test(activity)) training += hours;
    if (POC_ACTIVITY.test(activity)) poc += hours;
  }
  if (total > 0 && training / total > 0.5) return "TRAINING";
  if (total > 0 && poc / total > 0.5) return "POC";
  if (input.closedTotal > 0 && input.closedBugs / input.closedTotal > 0.5) return "BUGS";
  return "PRODUCT";
}

/**
 * The RAG status, computed and never asked of a model.
 *
 * RED is reserved for a breached commitment — an SLA breach, or a backlog where more than a third
 * of what is open is already late. AMBER is anything overdue at all. The thresholds are here, in
 * one place, so the meeting that argues about a red can argue about a number.
 */
export function ragFor(input: { overdueCount: number; openCount: number; slaBreaches: number }): RagStatus {
  // `slaBreaches` here is TIMESHEET APPROVALS past SLA, not tickets — see PracticeMetrics. It still
  // earns a RED: an approval queue nobody is clearing is a broken commitment to the people waiting
  // on it. The row's risk text names it precisely so the red is explainable in the meeting.
  if (input.slaBreaches > 0) return "RED";
  if (input.openCount > 0 && input.overdueCount / input.openCount > 1 / 3) return "RED";
  return input.overdueCount > 0 ? "AMBER" : "GREEN";
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** `{ id: count }` from a Prisma groupBy, so the callers below stay readable. */
function countMap(rows: Array<{ projectId: string | null; _count: unknown }>): Map<string, number> {
  // `_count` types as a union of every selectable field until it is narrowed, so it is read
  // defensively here rather than fighting the generic at eleven call sites.
  const total = (count: unknown) => (typeof count === "object" && count !== null ? Number((count as { _all?: number })._all ?? 0) : 0);
  return new Map(rows.filter((r) => r.projectId).map((r) => [r.projectId as string, total(r._count)]));
}

async function metricsFor(from: Date, to: Date): Promise<PracticeMetrics> {
  const start = toUtcDay(from);
  const end = toUtcDay(to);
  const endExclusive = new Date(end.getTime() + DAY_MS);
  const changesOn = await isChangeManagementOn().catch(() => false);

  const [
    ticketsCreated,
    ticketsClosed,
    hoursAgg,
    billableAgg,
    contributors,
    overdue,
    slaBreaches,
    openEscalations,
    changesRaised,
    changesImplemented,
    releases,
    securityOpenCritical,
    securityOpenHigh,
    securityNewFindings,
    trainingRows
  ] = await Promise.all([
    prisma.ticket.count({ where: { deletedAt: null, createdAt: { gte: start, lt: endExclusive } } }),
    prisma.ticket.count({ where: { deletedAt: null, status: { in: CLOSED_TICKET }, resolvedAt: { gte: start, lt: endExclusive } } }),
    prisma.timesheet.aggregate({ where: { deletedAt: null, workDate: { gte: start, lte: end } }, _sum: { totalHours: true } }),
    prisma.timesheet.aggregate({ where: { deletedAt: null, billable: true, workDate: { gte: start, lte: end } }, _sum: { totalHours: true } }),
    prisma.timesheet.findMany({ where: { deletedAt: null, workDate: { gte: start, lte: end } }, select: { userId: true }, distinct: ["userId"] }),
    prisma.ticket.count({ where: { deletedAt: null, status: { notIn: CLOSED_TICKET }, slaBreachAt: { not: null, lt: endExclusive } } }),
    prisma.timesheet.count({ where: { deletedAt: null, slaBreachAt: { not: null, gte: start, lt: endExclusive } } }),
    prisma.escalation.count({ where: { resolvedAt: null } }),
    changesOn ? prisma.changeRequest.count({ where: { createdAt: { gte: start, lt: endExclusive } } }) : Promise.resolve(0),
    changesOn ? prisma.changeRequest.count({ where: { closedAt: { gte: start, lt: endExclusive } } }) : Promise.resolve(0),
    // A "release" in this app is a change request that shipped carrying a version — there is no
    // separate Release model, and inventing one for a digest would be the wrong way round.
    changesOn
      ? prisma.changeRequest.count({ where: { closedAt: { gte: start, lt: endExclusive }, releaseVersion: { not: null } } })
      : Promise.resolve(0),
    // SECURITY-discipline findings only. These three are rendered as "Open security findings:
    // N critical, N high" and "New security findings" (practice-update-mail.service.ts), so a code
    // smell reaching them would make that sentence false — see `securityFindingTypeDisciplines` in
    // packages/shared for the argument and the Security Insights page for the same filter.
    prisma.securityFinding.count({ where: { status: "OPEN", severity: "CRITICAL", ...SECURITY_DISCIPLINE } }),
    prisma.securityFinding.count({ where: { status: "OPEN", severity: "HIGH", ...SECURITY_DISCIPLINE } }),
    prisma.securityFinding.count({ where: { createdAt: { gte: start, lt: endExclusive }, ...SECURITY_DISCIPLINE } }),
    prisma.timesheet.groupBy({
      by: ["activityType"],
      where: { deletedAt: null, workDate: { gte: start, lte: end } },
      _sum: { totalHours: true }
    })
  ]);

  const trainingHours = trainingRows
    .filter((row) => TRAINING_ACTIVITY.test(row.activityType ?? ""))
    .reduce((sum, row) => sum + Number(row._sum.totalHours ?? 0), 0);

  return {
    ticketsCreated,
    ticketsClosed,
    hours: Number(Number(hoursAgg._sum.totalHours ?? 0).toFixed(1)),
    billableHours: Number(Number(billableAgg._sum.totalHours ?? 0).toFixed(1)),
    contributors: contributors.length,
    overdue,
    slaBreaches,
    openEscalations,
    changesRaised,
    changesImplemented,
    releases,
    securityOpenCritical,
    securityOpenHigh,
    securityNewFindings,
    trainingHours: Number(trainingHours.toFixed(1))
  };
}

/**
 * Everything the update needs, for one period.
 *
 * Grouped queries throughout, not a loop over projects: five aggregates across twenty projects is
 * a hundred round trips on a request somebody is watching a spinner for.
 */
export async function buildPracticeUpdateData(from: Date, to: Date, label: string): Promise<PracticeUpdateData> {
  const start = toUtcDay(from);
  const end = toUtcDay(to);
  const endExclusive = new Date(end.getTime() + DAY_MS);
  const spanDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1);
  const prevTo = new Date(start.getTime() - DAY_MS);
  const prevFrom = new Date(start.getTime() - spanDays * DAY_MS);

  const projects = await prisma.project.findMany({
    where: { deletedAt: null, status: "ACTIVE" },
    select: { id: true, name: true, code: true },
    orderBy: { name: "asc" }
  });
  const ids = projects.map((p) => p.id);

  const [metrics, previousMetrics, createdRows, closedRows, openRows, overdueRows, slaRows, hourRows, activityRows, bugRows, ownerRows, assigneeRows, releaseRows, priorityRows, dueRows, closedTicketRows, openedTicketRows, workRows] =
    await Promise.all([
      metricsFor(from, to),
      metricsFor(prevFrom, prevTo),
      prisma.ticket.groupBy({ by: ["projectId"], where: { projectId: { in: ids }, deletedAt: null, createdAt: { gte: start, lt: endExclusive } }, _count: { _all: true } }),
      prisma.ticket.groupBy({ by: ["projectId"], where: { projectId: { in: ids }, deletedAt: null, status: { in: CLOSED_TICKET }, resolvedAt: { gte: start, lt: endExclusive } }, _count: { _all: true } }),
      prisma.ticket.groupBy({ by: ["projectId"], where: { projectId: { in: ids }, deletedAt: null, status: { notIn: CLOSED_TICKET } }, _count: { _all: true } }),
      prisma.ticket.groupBy({ by: ["projectId"], where: { projectId: { in: ids }, deletedAt: null, status: { notIn: CLOSED_TICKET }, slaBreachAt: { not: null, lt: endExclusive } }, _count: { _all: true } }),
      prisma.timesheet.groupBy({ by: ["projectId"], where: { projectId: { in: ids }, deletedAt: null, slaBreachAt: { not: null, gte: start, lt: endExclusive } }, _count: { _all: true } }),
      prisma.timesheet.groupBy({ by: ["projectId"], where: { projectId: { in: ids }, deletedAt: null, workDate: { gte: start, lte: end } }, _sum: { totalHours: true } }),
      prisma.timesheet.groupBy({ by: ["projectId", "activityType"], where: { projectId: { in: ids }, deletedAt: null, workDate: { gte: start, lte: end } }, _sum: { totalHours: true } }),
      // Bug tickets closed in the period, for the category call.
      prisma.ticket.groupBy({
        by: ["projectId"],
        where: { projectId: { in: ids }, deletedAt: null, status: { in: CLOSED_TICKET }, resolvedAt: { gte: start, lt: endExclusive }, type: { contains: "BUG" } },
        _count: { _all: true }
      }),
      // Owner: most hours logged on the project this period. `Project` has no owner column, and
      // adding one for a digest would be the wrong way round.
      prisma.timesheet.groupBy({
        by: ["projectId", "userId"],
        where: { projectId: { in: ids }, deletedAt: null, workDate: { gte: start, lte: end } },
        _sum: { totalHours: true }
      }),
      // The owner fallback: who holds the most OPEN tickets on it. A project can have a week with
      // no hours logged against it and still very much have an owner — PropTech_ERP was showing a
      // dash for exactly that reason.
      prisma.ticket.groupBy({
        by: ["projectId", "assigneeId"],
        where: { projectId: { in: ids }, deletedAt: null, status: { notIn: CLOSED_TICKET }, assigneeId: { not: null } },
        _count: { _all: true }
      }),
      prisma.changeRequest
        .findMany({
          where: { closedAt: { gte: start, lt: endExclusive }, releaseVersion: { not: null } },
          select: { releaseVersion: true, productName: true, closedAt: true, state: true },
          orderBy: { closedAt: "desc" },
          take: 20
        })
        .catch(() => []),
      // Open CRITICAL/HIGH per project, for the per-initiative severity split.
      prisma.ticket.groupBy({
        by: ["projectId", "priority"],
        where: { projectId: { in: ids }, deletedAt: null, status: { notIn: CLOSED_TICKET }, priority: { in: ["CRITICAL", "HIGH"] } },
        _count: { _all: true }
      }),
      // The nearest unmet deadline per project. Ordered ascending and reduced in one pass rather
      // than one query per project — same reason the rest of this function groups.
      prisma.ticket.findMany({
        where: { projectId: { in: ids }, deletedAt: null, status: { notIn: CLOSED_TICKET }, dueAt: { not: null } },
        select: { projectId: true, dueAt: true },
        orderBy: { dueAt: "asc" }
      }),
      // ── The NAMED half of each initiative. Three capped reads for the whole update rather than
      // three per project: the caps are global, and each project takes its own few off the top.
      prisma.ticket.findMany({
        where: { projectId: { in: ids }, deletedAt: null, status: { in: CLOSED_TICKET }, resolvedAt: { gte: start, lt: endExclusive } },
        select: { projectId: true, key: true, title: true, assignee: { select: { name: true } } },
        orderBy: { resolvedAt: "desc" },
        take: HIGHLIGHT_SCAN_CAP
      }),
      prisma.ticket.findMany({
        where: { projectId: { in: ids }, deletedAt: null, status: { notIn: CLOSED_TICKET }, createdAt: { gte: start, lt: endExclusive } },
        select: { projectId: true, key: true, title: true, priority: true },
        orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
        take: HIGHLIGHT_SCAN_CAP
      }),
      prisma.timesheet.findMany({
        where: { projectId: { in: ids }, deletedAt: null, workDate: { gte: start, lte: end } },
        select: { projectId: true, totalHours: true, taskDescription: true, user: { select: { name: true } } },
        orderBy: { totalHours: "desc" },
        take: HIGHLIGHT_SCAN_CAP
      })
    ]);

  const created = countMap(createdRows);
  const closed = countMap(closedRows);
  const open = countMap(openRows);
  const overdue = countMap(overdueRows);
  const sla = countMap(slaRows);
  const bugs = countMap(bugRows);
  const hours = new Map(hourRows.filter((r) => r.projectId).map((r) => [r.projectId as string, Number(r._sum.totalHours ?? 0)]));

  // ── The named half, bucketed per project and capped. Built here rather than inside the map below
  // so the three scans are walked once each instead of once per initiative.
  function bucket<T extends { projectId: string | null }>(rows: T[]): Map<string, T[]> {
    const byProject = new Map<string, T[]>();
    for (const row of rows) {
      if (!row.projectId) continue;
      const list = byProject.get(row.projectId);
      if (list) {
        if (list.length < HIGHLIGHTS_PER_INITIATIVE) list.push(row);
      } else byProject.set(row.projectId, [row]);
    }
    return byProject;
  }
  const closedByProject = bucket(closedTicketRows);
  const openedByProject = bucket(openedTicketRows);
  const workByProject = bucket(workRows);

  const criticalOpen = new Map<string, number>();
  const highOpen = new Map<string, number>();
  for (const row of priorityRows) {
    if (!row.projectId) continue;
    const n = typeof row._count === "object" && row._count !== null ? Number((row._count as { _all?: number })._all ?? 0) : 0;
    const target = row.priority === "CRITICAL" ? criticalOpen : highOpen;
    target.set(row.projectId, (target.get(row.projectId) ?? 0) + n);
  }

  // `dueRows` arrives ascending, so the FIRST row seen for a project is its nearest deadline.
  const nextDue = new Map<string, Date>();
  for (const row of dueRows) {
    if (!row.projectId || !row.dueAt || nextDue.has(row.projectId)) continue;
    nextDue.set(row.projectId, row.dueAt);
  }

  const activityByProject = new Map<string, Map<string, number>>();
  for (const row of activityRows) {
    if (!row.projectId) continue;
    const map = activityByProject.get(row.projectId) ?? new Map<string, number>();
    map.set(row.activityType ?? "", (map.get(row.activityType ?? "") ?? 0) + Number(row._sum.totalHours ?? 0));
    activityByProject.set(row.projectId, map);
  }

  const topContributor = new Map<string, { userId: string; hours: number }>();
  for (const row of ownerRows) {
    if (!row.projectId) continue;
    const total = Number(row._sum.totalHours ?? 0);
    const best = topContributor.get(row.projectId);
    if (!best || total > best.hours) topContributor.set(row.projectId, { userId: row.userId, hours: total });
  }
  // Second choice, used only where nobody logged time: the biggest open-ticket holder.
  const topAssignee = new Map<string, { userId: string; count: number }>();
  for (const row of assigneeRows) {
    if (!row.projectId || !row.assigneeId) continue;
    const count = typeof row._count === "object" && row._count !== null ? Number((row._count as { _all?: number })._all ?? 0) : 0;
    const best = topAssignee.get(row.projectId);
    if (!best || count > best.count) topAssignee.set(row.projectId, { userId: row.assigneeId, count });
  }

  const ownerFor = (projectId: string) => topContributor.get(projectId)?.userId ?? topAssignee.get(projectId)?.userId ?? null;
  const ownerIds = [...new Set(projects.map((p) => ownerFor(p.id)).filter((id): id is string => Boolean(id)))];
  const ownerNames = new Map(
    (await prisma.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, name: true } })).map((u) => [u.id, u.name])
  );

  const initiatives: PracticeInitiative[] = projects
    .map((project) => {
      const ticketsCreated = created.get(project.id) ?? 0;
      const ticketsClosed = closed.get(project.id) ?? 0;
      const openCount = open.get(project.id) ?? 0;
      const overdueCount = overdue.get(project.id) ?? 0;
      const slaBreaches = sla.get(project.id) ?? 0;
      const projectHours = Number((hours.get(project.id) ?? 0).toFixed(1));

      const progressParts = [
        ticketsClosed > 0 ? `${ticketsClosed} closed` : null,
        ticketsCreated > 0 ? `${ticketsCreated} raised` : null,
        projectHours > 0 ? `${projectHours} h logged` : null
      ].filter(Boolean);

      const criticals = criticalOpen.get(project.id) ?? 0;
      const highs = highOpen.get(project.id) ?? 0;

      const riskParts = [
        // Severity leads: "3 overdue" and "3 overdue, 2 of them critical" prompt different meetings.
        criticals > 0 ? `${criticals} critical open` : null,
        overdueCount > 0 ? `${overdueCount} overdue` : null,
        slaBreaches > 0 ? `${slaBreaches} approval${slaBreaches === 1 ? "" : "s"} past SLA` : null,
        openCount > 0 && ticketsClosed === 0 && projectHours === 0 ? `${openCount} open, no movement this period` : null
      ].filter(Boolean);

      return {
        id: project.id,
        name: project.name,
        code: project.code,
        category: categoriseInitiative({
          name: project.name,
          code: project.code,
          hoursByActivity: activityByProject.get(project.id) ?? new Map(),
          closedBugs: bugs.get(project.id) ?? 0,
          closedTotal: ticketsClosed
        }),
        owner: ownerNames.get(ownerFor(project.id) ?? "") ?? null,
        status: ragFor({ overdueCount, openCount, slaBreaches }),
        ticketsCreated,
        ticketsClosed,
        openCount,
        overdueCount,
        hours: projectHours,
        criticalOpen: criticals,
        highOpen: highs,
        nextDueDate: nextDue.has(project.id) ? iso(nextDue.get(project.id)!) : null,
        highlights: {
          closed: (closedByProject.get(project.id) ?? []).map((t) => ({ key: t.key, title: t.title, by: t.assignee?.name ?? null })),
          opened: (openedByProject.get(project.id) ?? []).map((t) => ({ key: t.key, title: t.title, priority: t.priority })),
          work: (workByProject.get(project.id) ?? []).map((w) => ({
            who: w.user?.name ?? "somebody",
            hours: Number(w.totalHours ?? 0),
            // Logged descriptions are rich text written by whoever filled the timesheet — stripped
            // and clipped, because this goes into a prompt and then into an email.
            what: htmlToText(String(w.taskDescription ?? "")).replace(/\s+/g, " ").trim().slice(0, 120)
          }))
        },
        progress: progressParts.join(" · ") || "No activity recorded this period",
        risks: riskParts.join(" · ")
      };
    })
    // A project with nothing open and nothing done is not an initiative anyone needs a line about.
    .filter((i) => i.ticketsCreated + i.ticketsClosed + i.openCount > 0 || i.hours > 0);

  // The POC set is taken from the initiatives that were just categorised rather than re-derived:
  // a second opinion on which projects are POCs is how one section of an email starts contradicting
  // another.
  const pocInitiatives = initiatives.filter((i) => i.category === "POC");
  const pocIds = pocInitiatives.map((i) => i.id);
  const pocHours = pocInitiatives.reduce((sum, i) => sum + i.hours, 0);

  const [analytics, previousAnalytics] = await Promise.all([
    buildPracticeAnalytics({ start, end, pocProjectIds: pocIds, pocHours }),
    buildPracticeAnalytics({ start: prevFrom, end: prevTo, pocProjectIds: pocIds, pocHours: 0 })
  ]);

  return {
    period: { from: iso(start), to: iso(end), label },
    previous: { from: iso(prevFrom), to: iso(prevTo) },
    metrics,
    previousMetrics,
    initiatives,
    analytics,
    previousAnalytics,
    releases: releaseRows.map((r) => ({
      version: r.releaseVersion ?? "—",
      product: r.productName ?? null,
      closedAt: r.closedAt ? iso(r.closedAt) : null,
      state: r.state
    })),
    isEmpty: metrics.ticketsCreated + metrics.ticketsClosed === 0 && metrics.hours === 0 && initiatives.length === 0
  };
}
