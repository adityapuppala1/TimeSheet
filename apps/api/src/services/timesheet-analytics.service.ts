/**
 * WHAT: the analytics the raw timesheet data already supports but nothing surfaced — utilisation
 * against real capacity, approval latency, and where a project's hours actually went.
 *
 * HOW THIS DIFFERS FROM timesheet-report.service.ts: that one groups and totals rows. This one
 * joins them against things that are NOT on the row — a person's contracted capacity, the SLA
 * clock, the shape of a project's activity mix — to answer questions the rows alone cannot.
 *
 * THE HONESTY RULE THAT SHAPES EVERY FIELD HERE: a number that cannot be computed is `null` and
 * says why, never `0`. Utilisation with no capacity on file is unknown, not 0%. Approval latency
 * for entries submitted before the timestamp existed is unmeasurable, not instant. Each figure is
 * paired with a count of what it could not cover, because a median over three of two hundred rows
 * is a different claim from a median over all two hundred and nothing on a chart says which.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { platformToday } from "../utils/date-window.js";
import { COUNTED_PEOPLE, resolveVisiblePeopleNames } from "./people-visibility.service.js";
import { workingDaysBetween } from "./plan-schedule.service.js";
import { bookedHoursInRange, capacityForBucket } from "./workload.service.js";
import { getPlanningSettings } from "./planning.service.js";
import { buildTimesheetWhere, REPORT_ROW_LIMIT, type TimesheetReportFilters } from "./timesheet-report.service.js";
import { LOGGED_TIMESHEET_STATUSES, median } from "./workspace-metrics.js";

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

/**
 * Rounds a set of percentage shares so they sum to exactly 100.
 *
 * Rounding each share independently is the obvious approach and it produces sets that total 100.1%
 * or 99.9%. On a pie chart labelled with those numbers it reads as an arithmetic error, and a
 * report the reader has caught being wrong about something trivial does not get trusted about
 * anything else. Largest-remainder: floor everything to one decimal, then hand the leftover
 * tenths to whichever entries were rounded down hardest.
 *
 * Skipped entirely when nothing was measured — a set of zeroes must stay zeroes rather than have
 * 100% distributed across it.
 */
function largestRemainderShares<T extends { exactShare: number }>(
  rows: T[]
): Array<Omit<T, "exactShare"> & { sharePct: number }> {
  const total = rows.reduce((s, r) => s + r.exactShare, 0);
  if (rows.length === 0 || total <= 0) {
    return rows.map(({ exactShare: _drop, ...rest }) => ({ ...rest, sharePct: 0 }));
  }

  // Work in tenths of a percent so one decimal place is exact integer arithmetic.
  const scaled = rows.map((r) => r.exactShare * 10);
  const floored = scaled.map((v) => Math.floor(v));
  let remaining = 1000 - floored.reduce((s, v) => s + v, 0);

  const order = scaled
    .map((v, i) => ({ i, remainder: v - Math.floor(v) }))
    .sort((a, b) => b.remainder - a.remainder);

  const bump = new Array(rows.length).fill(0);
  for (let n = 0; n < order.length && remaining > 0; n += 1, remaining -= 1) {
    bump[order[n].i] = 1;
  }

  return rows.map(({ exactShare: _drop, ...rest }, i) => ({
    ...rest,
    sharePct: Number(((floored[i] + bump[i]) / 10).toFixed(1))
  }));
}

export interface UtilisationRow {
  userId: string;
  name: string;
  /** LOGGED hours — submitted + approved — in the range. */
  loggedHours: number;
  billableHours: number;
  /** Working days in the range UP TO TODAY — from the day the person joined, when that is later
   *  than the range's start — minus time off, times the person's daily capacity. Null when there
   *  is nothing to divide by — no capacity on file and no workspace default, a range wholly in the
   *  future or before they joined, or a range wholly on leave. */
  capacityHours: number | null;
  /** Leave booked inside the counted days, already taken off `capacityHours`. */
  timeOffHours: number;
  utilisationPct: number | null;
  billableUtilisationPct: number | null;
  /** The share of capacity this person is EXPECTED to spend on logged work (User.plannedUtilizationPct,
   *  100 when unset). Shown beside utilisation for comparison; never multiplied into capacity. */
  targetUtilisationPct: number;
}

export interface ApprovalLatency {
  /** Entries where BOTH a submit time and a review time exist. */
  measured: number;
  /** Approved/rejected entries with no submit timestamp — submitted before the column existed.
   *  Reported rather than dropped, so a median over a handful is not read as covering everything. */
  unmeasurable: number;
  medianHours: number | null;
  p90Hours: number | null;
  slowestHours: number | null;
  breached: number;
  /** Share of REVIEWED entries that blew their approval SLA. Null when nothing had a deadline. */
  breachRatePct: number | null;
  byApprover: Array<{ approverId: string; name: string; reviewed: number; medianHours: number | null }>;
  /** Approvers dropped from `byApprover` because they are no longer active. Their reviews are
   *  still inside every workspace-level figure above — only the named row is gone. */
  hiddenInactiveApprovers: number;
}

export interface ActivityMixRow {
  activity: string;
  hours: number;
  sharePct: number;
  /** The frozen billed amount per currency, largest first. Never summed across currencies — the
   *  attestation refuses to mix them, and so does this. Empty when no entry carries a rate. */
  costByCurrency: Array<{ currency: string | null; amount: number }>;
  /** The single-currency total, or null when there is none or more than one currency. Kept for the
   *  callers that read one number; `costByCurrency` is the whole answer. */
  cost: number | null;
  unratedEntries: number;
}

export interface TimesheetAnalytics {
  range: {
    from: string;
    to: string;
    /** Working days in the whole range. */
    workingDays: number;
    /** Working days from `from` to today (platform calendar) or `to`, whichever is earlier — what
     *  capacity counts. A day that has not happened yet has no capacity to use. */
    workingDaysToDate: number;
    /** The last day capacity counts, or null when the range has not started. */
    capacityThrough: string | null;
  };
  utilisation: UtilisationRow[];
  approvalLatency: ApprovalLatency;
  activityMix: ActivityMixRow[];
  totals: {
    /** Logged hours (submitted + approved), everybody's — including people no longer shown. */
    hours: number;
    billableHours: number;
    /** Entries carrying those logged hours. */
    entries: number;
    /** Distinct people with logged hours in the range. */
    people: number;
    /** Hours (and the entries carrying them) in the range that are NOT logged and therefore in no
     *  figure above, so a reader can see what was left out rather than wonder why a total is lower
     *  than the grouped report beside it, which lists every status. `hours + draft + rejected` IS
     *  that report's total over the same range. Zero when the caller filtered on a status of its own. */
    excluded: { draftHours: number; rejectedHours: number; draftEntries: number; rejectedEntries: number };
  };
  /** People who logged hours in this window but are no longer shown (deactivated, or an AI agent),
   *  so have no `utilisation` row. `totals.people` still counts them — it answers "how many people's
   *  work is in these numbers", and their work IS in them. */
  hiddenInactivePeople: number;
  /** True when the approval-latency sample hit its row ceiling (the newest `REPORT_ROW_LIMIT`
   *  reviewed entries are measured). Every other figure is aggregated in the database and is whole. */
  truncated: boolean;
}

const DAY_MS = 86_400_000;
const round2 = (n: number) => Number(n.toFixed(2));
const round1 = (n: number | null) => (n === null ? null : Number(n.toFixed(1)));

/** The reviewed-entry columns approval latency reads — and nothing else. */
const LATENCY_SELECT = {
  submittedAt: true,
  reviewedAt: true,
  reviewedById: true,
  approvalDeadline: true
} satisfies Prisma.TimesheetSelect;

type LatencyRow = Prisma.TimesheetGetPayload<{ select: typeof LATENCY_SELECT }>;

const PERSON_SELECT = { id: true, name: true, weeklyCapacityHours: true, plannedUtilizationPct: true, createdAt: true } as const;

/**
 * The people a utilisation table covers: everyone in scope who is still counted (not deactivated,
 * not an AI agent), whether or not they logged anything — the 0% row is the one a manager most
 * needs, and it used to be the one that never appeared. Scope follows the filters: one person, the
 * members of one project, or everybody.
 *
 * A ticket, module or activity filter has no membership to list idle people from, so it lists only
 * the people who logged in scope — "everybody" put the whole workspace at full capacity against one
 * ticket's hours. The idle rows are ACTIVE people only: an invitee who has not verified yet has no
 * capacity to be idle in.
 */
async function peopleInScope(filters: TimesheetReportFilters, loggedIds: string[]) {
  const loggersOnly = Boolean(!filters.userId && (filters.ticketId || filters.moduleId || filters.activityType));
  let scope: Prisma.UserWhereInput = {};
  if (filters.userId) scope = { id: filters.userId };
  else if (filters.projectId) scope = { projectAssignments: { some: { projectId: filters.projectId } } };
  const [inScope, loggers] = await Promise.all([
    loggersOnly ? Promise.resolve([]) : prisma.user.findMany({ where: { ...scope, ...COUNTED_PEOPLE, status: "ACTIVE" }, select: PERSON_SELECT }),
    // Somebody who logged against the project without being assigned to it is still in its numbers.
    loggedIds.length
      ? prisma.user.findMany({ where: { id: { in: loggedIds }, ...COUNTED_PEOPLE }, select: PERSON_SELECT })
      : Promise.resolve([])
  ]);
  return [...new Map([...inScope, ...loggers].map((p) => [p.id, p])).values()];
}

/** Hours of leave booked per person inside [from, through] — the workload board's own arithmetic. */
async function timeOffByPerson(ids: string[], from: Date, through: Date, workingDays: number[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (ids.length === 0 || through < from) return out;
  const bookings = await prisma.resourceBooking.findMany({
    where: { userId: { in: ids }, isTimeOff: true, startDate: { lte: through }, endDate: { gte: from } },
    select: { userId: true, startDate: true, endDate: true, hoursPerDay: true }
  });
  for (const b of bookings) {
    const hours = bookedHoursInRange({ ...b, hoursPerDay: Number(b.hoursPerDay) }, from, through, workingDays);
    out.set(b.userId, (out.get(b.userId) ?? 0) + hours);
  }
  return out;
}

function approvalLatencyOf(rows: LatencyRow[], nameById: Map<string, string>): ApprovalLatency {
  const timed = rows.filter((r) => r.submittedAt != null);
  const hoursOf = (r: LatencyRow) => (r.reviewedAt!.getTime() - r.submittedAt!.getTime()) / 3_600_000;
  const latencies = timed.map(hoursOf);
  const withDeadline = rows.filter((r) => r.approvalDeadline != null);
  // Reviewed after the deadline (workspace-metrics.ts) — never `slaBreachAt`, which only the
  // SLA_ENABLED sweep writes.
  const breached = withDeadline.filter((r) => r.reviewedAt!.getTime() > r.approvalDeadline!.getTime());

  const perApprover = new Map<string, number[]>();
  for (const row of timed) {
    if (!row.reviewedById) continue;
    perApprover.set(row.reviewedById, [...(perApprover.get(row.reviewedById) ?? []), hoursOf(row)]);
  }
  return {
    measured: timed.length,
    unmeasurable: rows.length - timed.length,
    medianHours: round1(median(latencies)),
    p90Hours: round1(percentile(latencies, 90)),
    slowestHours: latencies.length ? round1(Math.max(...latencies)) : null,
    breached: breached.length,
    breachRatePct: withDeadline.length === 0 ? null : Number(((breached.length / withDeadline.length) * 100).toFixed(1)),
    byApprover: [...perApprover.entries()]
      .filter(([id]) => nameById.has(id))
      .map(([id, values]) => ({ approverId: id, name: nameById.get(id)!, reviewed: values.length, medianHours: round1(median(values)) }))
      .sort((a, b) => (b.medianHours ?? 0) - (a.medianHours ?? 0)),
    hiddenInactiveApprovers: [...perApprover.keys()].filter((id) => !nameById.has(id)).length
  };
}

type ActivityGroup = {
  activityType: string;
  billedCurrency: string | null;
  _sum: { totalHours: unknown; billedAmount: unknown };
  _count: { _all: number; billedAmount: number };
};

/** Hours, share and per-currency cost per activity, from the grouped sums. */
function activityMixOf(groups: ActivityGroup[]): { rows: ActivityMixRow[]; totalHours: number } {
  const activities = new Map<string, { hours: number; costs: Map<string | null, number>; unrated: number }>();
  for (const g of groups) {
    const entry = activities.get(g.activityType) ?? { hours: 0, costs: new Map<string | null, number>(), unrated: 0 };
    entry.hours += Number(g._sum.totalHours ?? 0);
    entry.unrated += g._count._all - g._count.billedAmount;
    if (g._count.billedAmount > 0) {
      entry.costs.set(g.billedCurrency, (entry.costs.get(g.billedCurrency) ?? 0) + Number(g._sum.billedAmount ?? 0));
    }
    activities.set(g.activityType, entry);
  }
  const totalHours = [...activities.values()].reduce((s, a) => s + a.hours, 0);
  const rows = largestRemainderShares(
    [...activities.entries()]
      .map(([activity, a]) => {
        const costByCurrency = [...a.costs.entries()]
          .map(([currency, amount]) => ({ currency, amount: round2(amount) }))
          .sort((x, y) => y.amount - x.amount);
        return {
          activity,
          hours: round2(a.hours),
          exactShare: totalHours === 0 ? 0 : (a.hours / totalHours) * 100,
          costByCurrency,
          cost: costByCurrency.length === 1 ? costByCurrency[0].amount : null,
          unratedEntries: a.unrated
        };
      })
      .sort((a, b) => b.hours - a.hours)
  );
  return { rows, totalHours };
}

/**
 * Utilisation, approval latency and activity mix over a window.
 *
 * The range is REQUIRED, unlike the grouped report. Utilisation is hours ÷ capacity, and capacity
 * only exists relative to a period — "utilisation, all time" is not a question with an answer.
 *
 * THE DEFINITIONS are services/workspace-metrics.ts's: hours are LOGGED hours (submitted +
 * approved), capacity is the working days from the start of the range up to today, minus leave,
 * times the person's daily capacity, and target utilisation is reported beside it.
 *
 * AGGREGATED IN THE DATABASE. This used to load up to 20,001 fully-joined rows with no order and
 * cut the list at 20,000, so on a large workspace which rows survived was up to the database and
 * nothing on screen said a cut had happened. Hours, people and the activity mix are now `groupBy`
 * sums and are whole; the only row read left is the approval-latency sample, newest first, with
 * `truncated` saying when it hit the ceiling.
 */
export async function buildTimesheetAnalytics(
  filters: TimesheetReportFilters & { from: string; to: string }
): Promise<TimesheetAnalytics> {
  const from = new Date(`${filters.from}T00:00:00.000Z`);
  const to = new Date(`${filters.to}T00:00:00.000Z`);
  // Capacity stops at today (platform calendar): a day that has not happened has nothing to use.
  const today = platformToday();
  const through = to < today ? to : today;

  const base = buildTimesheetWhere(filters);
  // An explicit status filter is the caller's own definition; otherwise hours mean LOGGED hours.
  const loggedWhere: Prisma.TimesheetWhereInput = filters.status ? base : { ...base, status: { in: LOGGED_TIMESHEET_STATUSES } };

  const [byPerson, byStatus, byActivity, latencyRows, settings] = await Promise.all([
    prisma.timesheet.groupBy({ by: ["userId", "billable"], where: loggedWhere, _sum: { totalHours: true }, _count: { _all: true } }),
    prisma.timesheet.groupBy({ by: ["status"], where: base, _sum: { totalHours: true }, _count: { _all: true } }),
    prisma.timesheet.groupBy({
      by: ["activityType", "billedCurrency"],
      where: loggedWhere,
      _sum: { totalHours: true, billedAmount: true },
      _count: { _all: true, billedAmount: true }
    }),
    prisma.timesheet.findMany({
      where: { ...base, reviewedAt: { not: null } },
      select: LATENCY_SELECT,
      orderBy: { reviewedAt: "desc" },
      take: REPORT_ROW_LIMIT + 1
    }),
    getPlanningSettings()
  ]);

  const workingDayNumbers = Array.isArray(settings.workingDays) ? (settings.workingDays as number[]) : [1, 2, 3, 4, 5];
  const workingDaysToDate = through < from ? 0 : workingDaysBetween(from, through, workingDayNumbers);

  // ---------------------------------------------------------------- utilisation
  const hoursByPerson = new Map<string, { logged: number; billable: number }>();
  for (const g of byPerson) {
    const hours = Number(g._sum.totalHours ?? 0);
    const entry = hoursByPerson.get(g.userId) ?? { logged: 0, billable: 0 };
    entry.logged += hours;
    if (g.billable) entry.billable += hours;
    hoursByPerson.set(g.userId, entry);
  }
  const loggedIds = [...hoursByPerson.keys()];
  const people = await peopleInScope(filters, loggedIds);
  const shownIds = new Set(people.map((p) => p.id));
  const leave = await timeOffByPerson([...shownIds], from, through, workingDayNumbers);
  const defaults = {
    weeklyCapacityHours: Number(settings.defaultWeeklyCapacityHours ?? 40),
    workingDaysPerWeek: workingDayNumbers.length || 5
  };

  const utilisation: UtilisationRow[] = people
    .map((person) => {
      const hours = hoursByPerson.get(person.id) ?? { logged: 0, billable: 0 };
      // Capacity starts the day the person joined (platform calendar) when that is inside the range:
      // somebody who joined on the 20th had no capacity on the 1st.
      const joined = platformToday(person.createdAt);
      const start = joined > from ? joined : from;
      const workingDays = through < start ? 0 : workingDaysBetween(start, through, workingDayNumbers);
      // The workload board's own per-day capacity, WITHOUT the target-utilisation scale: capacity
      // is what the person has; the target is what they are expected to log against it.
      const contracted = capacityForBucket(
        { weeklyCapacityHours: person.weeklyCapacityHours == null ? null : Number(person.weeklyCapacityHours), plannedUtilizationPct: null },
        { workingDays },
        defaults
      );
      const timeOffHours = round2(leave.get(person.id) ?? 0);
      const available = round2(Math.max(0, contracted - timeOffHours));
      const usable = available > 0 ? available : null;
      return {
        userId: person.id,
        name: person.name,
        loggedHours: round2(hours.logged),
        billableHours: round2(hours.billable),
        capacityHours: usable,
        timeOffHours,
        utilisationPct: usable === null ? null : Number(((hours.logged / usable) * 100).toFixed(1)),
        billableUtilisationPct: usable === null ? null : Number(((hours.billable / usable) * 100).toFixed(1)),
        targetUtilisationPct: person.plannedUtilizationPct ?? 100
      };
    })
    .sort((a, b) => (b.utilisationPct ?? -1) - (a.utilisationPct ?? -1) || a.name.localeCompare(b.name));

  // ---------------------------------------------------------------- approval latency
  const truncated = latencyRows.length > REPORT_ROW_LIMIT;
  const sample = truncated ? latencyRows.slice(0, REPORT_ROW_LIMIT) : latencyRows;
  // The approver league table is a per-person comparison on a screen, so it names only people still
  // shown. The workspace-level figures (median, p90, slowest, breach rate) are computed over EVERY
  // reviewed row, including those signed off by somebody since deactivated — an approval that was
  // slow was slow, and dropping it would flatter the workspace.
  const nameById = await resolveVisiblePeopleNames(sample.map((r) => r.reviewedById));
  const approvalLatency = approvalLatencyOf(sample, nameById);

  // ---------------------------------------------------------------- activity mix
  const mix = activityMixOf(byActivity as unknown as ActivityGroup[]);
  const excludedGroup = (status: "DRAFT" | "REJECTED") => (filters.status ? undefined : byStatus.find((g) => g.status === status));
  const excluded = (status: "DRAFT" | "REJECTED") => round2(Number(excludedGroup(status)?._sum.totalHours ?? 0));
  const excludedEntries = (status: "DRAFT" | "REJECTED") => excludedGroup(status)?._count._all ?? 0;

  return {
    range: {
      from: filters.from,
      to: filters.to,
      workingDays: workingDaysBetween(from, to, workingDayNumbers),
      workingDaysToDate,
      capacityThrough: through < from ? null : through.toISOString().slice(0, 10)
    },
    utilisation,
    approvalLatency,
    activityMix: mix.rows,
    totals: {
      hours: round2(mix.totalHours),
      billableHours: round2([...hoursByPerson.values()].reduce((s, h) => s + h.billable, 0)),
      entries: byPerson.reduce((s, g) => s + g._count._all, 0),
      people: loggedIds.length,
      excluded: {
        draftHours: excluded("DRAFT"),
        rejectedHours: excluded("REJECTED"),
        draftEntries: excludedEntries("DRAFT"),
        rejectedEntries: excludedEntries("REJECTED")
      }
    },
    hiddenInactivePeople: loggedIds.filter((id) => !shownIds.has(id)).length,
    truncated
  };
}

export const ANALYTICS_DAY_MS = DAY_MS;
