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
import { prisma } from "../config/prisma.js";
import { capacityForBucket } from "./workload.service.js";
import { getPlanningSettings } from "./planning.service.js";
import {
  buildTimesheetWhere,
  REPORT_INCLUDE,
  REPORT_ROW_LIMIT,
  type TimesheetReportFilters
} from "./timesheet-report.service.js";

/** Inclusive working days between two dates, honouring the workspace's configured working week. */
function workingDaysBetween(from: Date, to: Date, workingDays: number[]): number {
  let count = 0;
  const cursor = new Date(from.getTime());
  while (cursor <= to) {
    if (workingDays.includes(cursor.getUTCDay())) count += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

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
  loggedHours: number;
  billableHours: number;
  /** Null when this person has no capacity on file AND the workspace has no default — dividing by
   *  an unknown is how a utilisation chart ends up showing 0% for a contractor nobody configured. */
  capacityHours: number | null;
  utilisationPct: number | null;
  billableUtilisationPct: number | null;
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
}

export interface ActivityMixRow {
  activity: string;
  hours: number;
  sharePct: number;
  cost: number | null;
  unratedEntries: number;
}

export interface TimesheetAnalytics {
  range: { from: string; to: string; workingDays: number };
  utilisation: UtilisationRow[];
  approvalLatency: ApprovalLatency;
  activityMix: ActivityMixRow[];
  totals: { hours: number; billableHours: number; entries: number; people: number };
  truncated: boolean;
}

const DAY_MS = 86_400_000;

/**
 * Utilisation, approval latency and activity mix over a window.
 *
 * The range is REQUIRED, unlike the grouped report. Utilisation is hours ÷ capacity, and capacity
 * only exists relative to a period — "utilisation, all time" is not a question with an answer.
 */
export async function buildTimesheetAnalytics(
  filters: TimesheetReportFilters & { from: string; to: string }
): Promise<TimesheetAnalytics> {
  const from = new Date(`${filters.from}T00:00:00.000Z`);
  const to = new Date(`${filters.to}T00:00:00.000Z`);

  const [rows, settings] = await Promise.all([
    prisma.timesheet.findMany({
      where: buildTimesheetWhere(filters),
      include: REPORT_INCLUDE,
      take: REPORT_ROW_LIMIT + 1
    }),
    getPlanningSettings()
  ]);

  const truncated = rows.length > REPORT_ROW_LIMIT;
  const used = truncated ? rows.slice(0, REPORT_ROW_LIMIT) : rows;

  const workingDayNumbers = Array.isArray(settings.workingDays)
    ? (settings.workingDays as number[])
    : [1, 2, 3, 4, 5];
  const workingDays = workingDaysBetween(from, to, workingDayNumbers);

  // ---------------------------------------------------------------- utilisation
  const peopleIds = [...new Set(used.map((r) => r.userId))];
  const people = peopleIds.length
    ? await prisma.user.findMany({
        where: { id: { in: peopleIds } },
        select: { id: true, name: true, weeklyCapacityHours: true, plannedUtilizationPct: true }
      })
    : [];
  const defaults = {
    weeklyCapacityHours: Number(settings.defaultWeeklyCapacityHours ?? 40),
    workingDaysPerWeek: workingDayNumbers.length || 5
  };

  const utilisation: UtilisationRow[] = people
    .map((person) => {
      const mine = used.filter((r) => r.userId === person.id);
      const loggedHours = Number(mine.reduce((s, r) => s + Number(r.totalHours ?? 0), 0).toFixed(2));
      const billableHours = Number(
        mine.filter((r) => r.billable).reduce((s, r) => s + Number(r.totalHours ?? 0), 0).toFixed(2)
      );

      // Reuses the workload board's own capacity function, so a person cannot read as 80% booked
      // on one screen and 120% utilised on another for the same fortnight.
      const capacityHours = capacityForBucket(
        {
          weeklyCapacityHours: person.weeklyCapacityHours == null ? null : Number(person.weeklyCapacityHours),
          plannedUtilizationPct: person.plannedUtilizationPct
        },
        { workingDays },
        defaults
      );

      const usable = capacityHours > 0 ? capacityHours : null;
      return {
        userId: person.id,
        name: person.name,
        loggedHours,
        billableHours,
        capacityHours: usable,
        utilisationPct: usable === null ? null : Number(((loggedHours / usable) * 100).toFixed(1)),
        billableUtilisationPct: usable === null ? null : Number(((billableHours / usable) * 100).toFixed(1))
      };
    })
    .sort((a, b) => (b.utilisationPct ?? -1) - (a.utilisationPct ?? -1));

  // ---------------------------------------------------------------- approval latency
  const reviewed = used.filter((r) => r.reviewedAt != null);
  const timed = reviewed.filter((r) => r.submittedAt != null);
  const latencies = timed.map((r) => (r.reviewedAt!.getTime() - r.submittedAt!.getTime()) / 3_600_000);

  const withDeadline = reviewed.filter((r) => r.approvalDeadline != null);
  const breached = withDeadline.filter(
    (r) => r.slaBreachAt != null || r.reviewedAt!.getTime() > r.approvalDeadline!.getTime()
  );

  const perApprover = new Map<string, { name: string; latencies: number[] }>();
  for (const row of timed) {
    if (!row.reviewedById) continue;
    const entry = perApprover.get(row.reviewedById) ?? { name: row.reviewedById, latencies: [] };
    entry.latencies.push((row.reviewedAt!.getTime() - row.submittedAt!.getTime()) / 3_600_000);
    perApprover.set(row.reviewedById, entry);
  }
  const approverNames = perApprover.size
    ? await prisma.user.findMany({ where: { id: { in: [...perApprover.keys()] } }, select: { id: true, name: true } })
    : [];
  const nameById = new Map(approverNames.map((u) => [u.id, u.name]));

  const round1 = (n: number | null) => (n === null ? null : Number(n.toFixed(1)));

  const approvalLatency: ApprovalLatency = {
    measured: timed.length,
    unmeasurable: reviewed.length - timed.length,
    medianHours: round1(median(latencies)),
    p90Hours: round1(percentile(latencies, 90)),
    slowestHours: latencies.length ? round1(Math.max(...latencies)) : null,
    breached: breached.length,
    breachRatePct:
      withDeadline.length === 0 ? null : Number(((breached.length / withDeadline.length) * 100).toFixed(1)),
    byApprover: [...perApprover.entries()]
      .map(([id, entry]) => ({
        approverId: id,
        name: nameById.get(id) ?? "Unknown",
        reviewed: entry.latencies.length,
        medianHours: round1(median(entry.latencies))
      }))
      .sort((a, b) => (b.medianHours ?? 0) - (a.medianHours ?? 0))
  };

  // ---------------------------------------------------------------- activity mix
  const totalHours = used.reduce((s, r) => s + Number(r.totalHours ?? 0), 0);
  const byActivity = new Map<string, { hours: number; cost: number; rated: number; unrated: number }>();
  for (const row of used) {
    const bucket = byActivity.get(row.activityType) ?? { hours: 0, cost: 0, rated: 0, unrated: 0 };
    bucket.hours += Number(row.totalHours ?? 0);
    if (row.billedAmount != null) {
      bucket.cost += Number(row.billedAmount);
      bucket.rated += 1;
    } else {
      bucket.unrated += 1;
    }
    byActivity.set(row.activityType, bucket);
  }

  const activityMix: ActivityMixRow[] = largestRemainderShares(
    [...byActivity.entries()]
      .map(([activity, b]) => ({
        activity,
        hours: Number(b.hours.toFixed(2)),
        exactShare: totalHours === 0 ? 0 : (b.hours / totalHours) * 100,
        cost: b.rated === 0 ? null : Number(b.cost.toFixed(2)),
        unratedEntries: b.unrated
      }))
      .sort((a, b) => b.hours - a.hours)
  );

  return {
    range: { from: filters.from, to: filters.to, workingDays },
    utilisation,
    approvalLatency,
    activityMix,
    totals: {
      hours: Number(totalHours.toFixed(2)),
      billableHours: Number(
        used.filter((r) => r.billable).reduce((s, r) => s + Number(r.totalHours ?? 0), 0).toFixed(2)
      ),
      entries: used.length,
      people: peopleIds.length
    },
    truncated
  };
}

export const ANALYTICS_DAY_MS = DAY_MS;
