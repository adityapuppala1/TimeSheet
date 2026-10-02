/**
 * WHAT: the second layer of the Weekly AI/ML Practice Update — the figures that answer the
 * leadership questions the headline counts cannot.
 *
 * WHY IT IS A SEPARATE FILE FROM practice-update.service.ts: that one answers "what happened"
 * (tickets, hours, initiatives, releases) and is the spine of the report. This one answers "how
 * are we doing" — rates, ratios, quality gates, remediation, capacity — and is the part a
 * director actually reads. Keeping them apart means the spine cannot be broken by a query added
 * for a ratio, and it means every figure here can be tested against a fixture without standing up
 * the whole report.
 *
 * THE HONESTY RULE, inherited from timesheet-analytics.service.ts and enforced throughout:
 * a rate whose denominator is zero is `null`, never `0`. "0% on-time" and "nothing had a deadline"
 * are opposite sentences, and a percentage is the single easiest number in a report to state
 * confidently and wrongly. Every `*Pct` here is nullable for that reason, and the email renders a
 * null as "—" with the denominator beside it rather than as a figure.
 *
 * WHAT IS COUNTED AND WHAT IS INFERRED:
 *  - Everything in `delivery`, `priority`, `quality`, `security`, `change`, `goals` and `ai` is
 *    counted from the database.
 *  - `people.utilisationPct` reuses `capacityForBucket` from the workload service rather than
 *    reimplementing it, so the practice update cannot disagree with the workload board about the
 *    same fortnight.
 *  - `poc` leans on the same category inference the initiative table uses; a POC is a project
 *    whose name or logged activity says so, and the lifecycle split is by dates on the project.
 *
 * NOTHING HERE THROWS INTO THE REPORT. Optional subsystems — change management, security
 * scanning, goals, AI agents — are absent in most workspaces, and a practice update that fails
 * because nobody has configured SonarQube would be a worse product than one that omits a row.
 * Each block that depends on an optional table degrades to zeroes and nulls on its own.
 */
import type { Prisma } from "@prisma/client";
import { securityDisciplineFindingTypes } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { getPlanningSettings } from "./planning.service.js";
import { capacityForBucket } from "./workload.service.js";
import { COUNTED_PEOPLE } from "./people-visibility.service.js";
import { LOGGED_HOURS_WHERE } from "./workspace-metrics.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const CLOSED: Prisma.EnumTicketStatusFilter = { in: ["RESOLVED", "CLOSED"] };
const NOT_CLOSED: Prisma.EnumTicketStatusFilter = { notIn: ["RESOLVED", "CLOSED"] };
const SECURITY_DISCIPLINE = { type: { in: securityDisciplineFindingTypes } };

/** A percentage, or null when the denominator was zero. The single most repeated decision here. */
export function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Number(((numerator / denominator) * 100).toFixed(1));
}

/** Median of a sample, or null when the sample is empty. Median rather than mean throughout:
 *  one ticket that sat open over Christmas moves a mean enough to make the figure a talking point
 *  about itself rather than about the week. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export interface DeliveryAnalytics {
  /** Closed ÷ raised. Above 100 means the backlog shrank; below, it grew. The one ratio that says
   *  whether a team is keeping up, and it is not visible in either count alone. */
  closureRatePct: number | null;
  /** Of the tickets closed this period that HAD a due date, how many made it. Null when none did —
   *  which is itself worth seeing, because it means "on time" is not being measured at all. */
  onTimeClosurePct: number | null;
  closedWithDueDate: number;
  /** Created → resolved, median, over this period's closures. */
  medianCycleHours: number | null;
  /** Work that came back, WITHIN this period. Read from the audit trail, because reopening clears
   *  `resolvedAt` and the ticket row itself then carries no memory of having ever been closed. */
  reopened: number;
  everResolved: number;
  reopenRatePct: number | null;
  /** Open, and nobody owns it. A blocker that hides inside a healthy-looking backlog count.
   *  POINT-IN-TIME — a ticket carries only its current assignee, so there is no way to ask who
   *  owned it last Friday. Rendered without a delta for that reason. */
  unassignedOpen: number;
  /** Everything raised before the period ended and not resolved by then — reconstructed from
   *  dates rather than read as "open now", so the figure for last period is genuinely different
   *  and the delta beside it is a real trend. */
  backlogOpen: number;
  /** Falls due in the seven days AFTER this period — the factual half of "Next Week Priorities". */
  dueNextWeek: number;
}

export interface PriorityAnalytics {
  criticalOpen: number;
  highOpen: number;
  criticalClosed: number;
  highClosed: number;
  /** Critical AND late. The one number in this report that should always be zero. */
  criticalOverdue: number;
}

export interface QualityAnalytics {
  testRuns: number;
  /**
   * Runs, and individual assertions, are reported SEPARATELY and both rates are kept — because on
   * real data they disagree hard enough to look like a bug. A week of 7 runs where 2 passed and 5
   * failed can still contain 62 passing tests and 2 failing ones: 28.6% of runs green, 96.9% of
   * tests green. Both are true and they answer different questions — "can we ship?" is the run
   * rate, "how broken is it?" is the test rate. Printing only one, or printing them adjacent with
   * no labels, is how a reader concludes the report cannot do arithmetic.
   */
  runsPassed: number;
  runsFailed: number;
  testsPassed: number;
  testsFailed: number;
  /** Runs that passed ÷ runs that finished. RUNNING rows are excluded from both halves rather than
   *  counted as failures — a suite still executing has not failed. */
  runPassRatePct: number | null;
  /** Individual assertions that passed ÷ assertions that ran. */
  testPassRatePct: number | null;
  gatesPassed: number;
  gatesWarned: number;
  gatesFailed: number;
}

export interface SecurityAnalytics {
  /** Proven fixed in the period — `verifiedFixedAt`, not "somebody closed the ticket". */
  verifiedFixed: number;
  /** Claimed fixed, not yet proven by a re-scan. The gap between the two is the honest measure of
   *  remediation, and it is the number this product exists to make visible. */
  awaitingVerification: number;
  scanRuns: number;
  newCritical: number;
  newHigh: number;
  /** Age of what is still open, in days. A backlog of ten findings a year old is a different
   *  posture from ten found yesterday, and the counts alone cannot tell them apart. */
  medianOpenAgeDays: number | null;
  oldestOpenDays: number | null;
}

export interface ChangeAnalytics {
  successful: number;
  withIssues: number;
  failed: number;
  rolledBack: number;
  /** Of the changes that closed WITH a recorded outcome, how many succeeded outright. */
  successRatePct: number | null;
  outcomeRecorded: number;
  /** Raised as EMERGENCY. A rising count is a planning signal, not a delivery one. */
  emergency: number;
  awaitingApproval: number;
  /** Scheduled to start in the seven days after this period. The other factual half of next week. */
  scheduledNextWeek: number;
}

export interface PeopleAnalytics {
  /** Who moved the most this period. Names only — hours and closures beside them, no ranking prize.
   *  Deactivated people are excluded, like every other on-screen per-person breakdown. */
  topContributors: Array<{ name: string; hours: number; ticketsClosed: number }>;
  /** Logged ÷ capacity across everyone who logged anything, using the workload board's own capacity
   *  function so the two cannot disagree. Null when nobody has contracted hours on file. */
  utilisationPct: number | null;
  capacityHours: number | null;
  billablePct: number | null;
  /** People who logged nothing this period but hold open tickets — quiet, not idle, and worth a
   *  question rather than an accusation. */
  silentOwners: number;
}

export interface PocAnalytics {
  /** POC-category initiatives whose project row was created inside the period. */
  started: number;
  ongoing: number;
  /** Archived inside the period — this workspace's terminal project state. */
  completed: number;
  hours: number;
}

export interface GoalAnalytics {
  active: number;
  achievedThisPeriod: number;
  /** Still ACTIVE with an end date already behind us. */
  overdue: number;
}

export interface AiPracticeAnalytics {
  /** An AI/ML practice reporting on itself: what the teammates did, and what it cost. */
  agentRuns: number;
  agentRunsFailed: number;
  interactions: number;
  spendUsd: number | null;
}

export interface PracticeAnalytics {
  delivery: DeliveryAnalytics;
  priority: PriorityAnalytics;
  quality: QualityAnalytics;
  security: SecurityAnalytics;
  change: ChangeAnalytics;
  people: PeopleAnalytics;
  poc: PocAnalytics;
  goals: GoalAnalytics;
  ai: AiPracticeAnalytics;
}

/**
 * Every figure absent, every rate unmeasured.
 *
 * WHY IT IS EXPORTED AND NOT JUST A TEST FIXTURE: `PracticeUpdateRecord.data` is a JSON column that
 * the controller replays through a bare `as unknown as PracticeUpdateData` cast — which checks
 * nothing at runtime. Every draft and history row written before this layer existed has no
 * `analytics` key at all, and the email reads into it unconditionally. Without a default, shipping
 * this feature would have turned every stored draft in every workspace into a 500 on the page a
 * super admin opens to send the update.
 *
 * NULLS RATHER THAN ZEROES, for the same reason as everywhere else here: an old draft does not know
 * what its closure rate was. It is unmeasured, and printing 0% would be inventing a figure for a
 * week nobody can go back and count.
 */
export const EMPTY_PRACTICE_ANALYTICS: PracticeAnalytics = {
  delivery: {
    closureRatePct: null,
    onTimeClosurePct: null,
    closedWithDueDate: 0,
    medianCycleHours: null,
    reopened: 0,
    everResolved: 0,
    reopenRatePct: null,
    unassignedOpen: 0,
    backlogOpen: 0,
    dueNextWeek: 0
  },
  priority: { criticalOpen: 0, highOpen: 0, criticalClosed: 0, highClosed: 0, criticalOverdue: 0 },
  quality: {
    testRuns: 0,
    runsPassed: 0,
    runsFailed: 0,
    testsPassed: 0,
    testsFailed: 0,
    runPassRatePct: null,
    testPassRatePct: null,
    gatesPassed: 0,
    gatesWarned: 0,
    gatesFailed: 0
  },
  security: {
    verifiedFixed: 0,
    awaitingVerification: 0,
    scanRuns: 0,
    newCritical: 0,
    newHigh: 0,
    medianOpenAgeDays: null,
    oldestOpenDays: null
  },
  change: {
    successful: 0,
    withIssues: 0,
    failed: 0,
    rolledBack: 0,
    successRatePct: null,
    outcomeRecorded: 0,
    emergency: 0,
    awaitingApproval: 0,
    scheduledNextWeek: 0
  },
  people: { topContributors: [], utilisationPct: null, capacityHours: null, billablePct: null, silentOwners: 0 },
  poc: { started: 0, ongoing: 0, completed: 0, hours: 0 },
  goals: { active: 0, achievedThisPeriod: 0, overdue: 0 },
  ai: { agentRuns: 0, agentRunsFailed: 0, interactions: 0, spendUsd: null }
};

/** Optional subsystems are absent in most workspaces; a missing table must cost a row, not the
 *  report. Every query against one goes through this. */
function optional<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return promise.catch(() => fallback);
}

/**
 * Every derived figure for one period.
 *
 * `pocProjectIds` comes from the caller because the POC/Product/Training split is inferred by
 * `categoriseInitiative`, and recomputing that here would be a second opinion on the same
 * question — the exact failure mode this codebase keeps writing comments about.
 */
export async function buildPracticeAnalytics(input: {
  start: Date;
  end: Date;
  pocProjectIds: string[];
  /** Hours logged against those projects this period. Passed in rather than re-queried: the caller
   *  already grouped timesheets by project to build the initiative table, and a second query for
   *  the same sum is how two figures in one email start disagreeing. */
  pocHours: number;
}): Promise<PracticeAnalytics> {
  const { start, end, pocProjectIds, pocHours } = input;
  const endExclusive = new Date(end.getTime() + DAY_MS);
  const nextWeekEnd = new Date(endExclusive.getTime() + 7 * DAY_MS);
  const inPeriod = { gte: start, lt: endExclusive };

  const [
    closedTickets,
    createdCount,
    statusAudits,
    unassignedOpen,
    backlogOpen,
    dueNextWeek,
    priorityOpenRows,
    priorityClosedRows,
    criticalOverdue,
    testRows,
    gateRows,
    verifiedFixed,
    awaitingVerification,
    scanRuns,
    newFindings,
    openFindings,
    changeOutcomeRows,
    emergencyChanges,
    awaitingApproval,
    scheduledNextWeek,
    hoursByUser,
    closedByUser,
    billableAgg,
    totalAgg,
    openAssignees,
    pocProjects,
    goalsActive,
    goalsAchieved,
    goalsOverdue,
    agentRuns,
    agentRunsFailed,
    interactions,
    spendRows
  ] = await Promise.all([
    // Cycle time and on-time rate both need the rows, not a count.
    prisma.ticket.findMany({
      where: { deletedAt: null, status: CLOSED, resolvedAt: inPeriod },
      select: { createdAt: true, resolvedAt: true, dueAt: true }
    }),
    prisma.ticket.count({ where: { deletedAt: null, createdAt: inPeriod } }),
    // Reopen detection, same source and same reason as the Insights page: reopening clears
    // `resolvedAt`, so the audit trail is the only durable record that it ever happened.
    // SCOPED TO THE PERIOD. The Insights page computes an all-time reopen rate, which is the right
    // figure for a trend chart and the wrong one under a heading that says "this period" — it would
    // barely move week to week and would describe work done months ago. Here it is the week's own
    // flow: resolve events and reopen events that happened inside it.
    optional(
      prisma.auditLog.findMany({
        where: { action: "ticket.status_changed", entity: "Ticket", createdAt: inPeriod },
        select: { entityId: true, metadata: true }
      }),
      [] as Array<{ entityId: string | null; metadata: unknown }>
    ),
    prisma.ticket.count({ where: { deletedAt: null, status: NOT_CLOSED, assigneeId: null } }),
    // AS AT THE END OF THE PERIOD, not as at now. A plain "currently open" count returns the same
    // number for this period and the one before it, so the email would print "unchanged" every
    // single week — a confident statement about a trend that had not been measured. Reconstructed
    // instead from the dates the rows carry: raised before the period ended, and not resolved
    // before it ended.
    prisma.ticket.count({
      where: {
        deletedAt: null,
        createdAt: { lt: endExclusive },
        OR: [{ resolvedAt: null }, { resolvedAt: { gte: endExclusive } }]
      }
    }),
    prisma.ticket.count({
      where: { deletedAt: null, status: NOT_CLOSED, dueAt: { gte: endExclusive, lt: nextWeekEnd } }
    }),
    prisma.ticket.groupBy({ by: ["priority"], where: { deletedAt: null, status: NOT_CLOSED }, _count: { _all: true } }),
    prisma.ticket.groupBy({
      by: ["priority"],
      where: { deletedAt: null, status: CLOSED, resolvedAt: inPeriod },
      _count: { _all: true }
    }),
    prisma.ticket.count({
      // Past its due date by the end of the period — the one SLA rule (workspace-metrics.ts); the
      // sweep's `slaBreachAt` stamp only exists while TICKET_SLA_ENABLED is on.
      where: { deletedAt: null, status: NOT_CLOSED, priority: "CRITICAL", dueAt: { lt: endExclusive } }
    }),
    optional(
      prisma.testRun.groupBy({ by: ["status"], where: { createdAt: inPeriod }, _count: { _all: true }, _sum: { passCount: true, failCount: true } }),
      [] as Array<{ status: string; _count: unknown; _sum: { passCount: number | null; failCount: number | null } }>
    ),
    optional(
      prisma.qualityGateRun.groupBy({ by: ["status"], where: { analysedAt: inPeriod }, _count: { _all: true } }),
      [] as Array<{ status: string; _count: unknown }>
    ),
    optional(prisma.securityFinding.count({ where: { verifiedFixedAt: inPeriod, ...SECURITY_DISCIPLINE } }), 0),
    optional(prisma.securityFinding.count({ where: { status: "PENDING_VERIFICATION", ...SECURITY_DISCIPLINE } }), 0),
    optional(prisma.scanRun.count({ where: { createdAt: inPeriod } }), 0),
    optional(
      prisma.securityFinding.groupBy({
        by: ["severity"],
        where: { createdAt: inPeriod, ...SECURITY_DISCIPLINE },
        _count: { _all: true }
      }),
      [] as Array<{ severity: string; _count: unknown }>
    ),
    optional(
      prisma.securityFinding.findMany({
        where: { status: { in: ["OPEN", "PENDING_VERIFICATION"] }, ...SECURITY_DISCIPLINE },
        select: { firstSeenAt: true }
      }),
      [] as Array<{ firstSeenAt: Date }>
    ),
    optional(
      prisma.changeRequest.groupBy({
        by: ["outcome"],
        where: { closedAt: inPeriod, outcome: { not: null } },
        _count: { _all: true }
      }),
      [] as Array<{ outcome: string | null; _count: unknown }>
    ),
    optional(prisma.changeRequest.count({ where: { createdAt: inPeriod, changeKind: "EMERGENCY" } }), 0),
    optional(prisma.changeRequest.count({ where: { state: "AWAITING_APPROVAL" } }), 0),
    optional(
      prisma.changeRequest.count({ where: { plannedStart: { gte: endExclusive, lt: nextWeekEnd } } }),
      0
    ),
    // LOGGED hours — submitted + approved (workspace-metrics.ts) — in every hours figure below.
    prisma.timesheet.groupBy({
      by: ["userId"],
      where: { deletedAt: null, ...LOGGED_HOURS_WHERE, workDate: { gte: start, lte: end } },
      _sum: { totalHours: true }
    }),
    prisma.ticket.groupBy({
      by: ["assigneeId"],
      where: { deletedAt: null, status: CLOSED, resolvedAt: inPeriod, assigneeId: { not: null } },
      _count: { _all: true }
    }),
    prisma.timesheet.aggregate({ where: { deletedAt: null, ...LOGGED_HOURS_WHERE, billable: true, workDate: { gte: start, lte: end } }, _sum: { totalHours: true } }),
    prisma.timesheet.aggregate({ where: { deletedAt: null, ...LOGGED_HOURS_WHERE, workDate: { gte: start, lte: end } }, _sum: { totalHours: true } }),
    // Open work held by PEOPLE. An AI agent never logs hours, so it was always a "silent owner".
    prisma.ticket.findMany({
      where: { deletedAt: null, status: NOT_CLOSED, assigneeId: { not: null }, assignee: { isAgent: false } },
      select: { assigneeId: true },
      distinct: ["assigneeId"]
    }),
    pocProjectIds.length
      ? prisma.project.findMany({
          where: { id: { in: pocProjectIds } },
          select: { id: true, createdAt: true, status: true, updatedAt: true }
        })
      : Promise.resolve([] as Array<{ id: string; createdAt: Date; status: string; updatedAt: Date }>),
    optional(prisma.goal.count({ where: { deletedAt: null, status: "ACTIVE" } }), 0),
    optional(prisma.goal.count({ where: { deletedAt: null, status: "ACHIEVED", updatedAt: inPeriod } }), 0),
    optional(prisma.goal.count({ where: { deletedAt: null, status: "ACTIVE", endDate: { lt: end } } }), 0),
    optional(prisma.agentRun.count({ where: { createdAt: inPeriod } }), 0),
    optional(prisma.agentRun.count({ where: { createdAt: inPeriod, status: "FAILED" } }), 0),
    optional(prisma.aIInteraction.count({ where: { createdAt: inPeriod } }), 0),
    optional(
      prisma.aIUsageLog.aggregate({ where: { createdAt: inPeriod }, _sum: { costUsdEstimate: true } }),
      { _sum: { costUsdEstimate: null } } as { _sum: { costUsdEstimate: unknown } }
    )
  ]);

  // ---------------------------------------------------------------- delivery
  const cycleHours = closedTickets
    .filter((t) => t.resolvedAt)
    .map((t) => (t.resolvedAt!.getTime() - t.createdAt.getTime()) / 3_600_000);
  const withDue = closedTickets.filter((t) => t.dueAt);
  const onTime = withDue.filter((t) => t.resolvedAt! <= t.dueAt!);

  const everResolvedIds = new Set<string>();
  const everReopenedIds = new Set<string>();
  for (const row of statusAudits) {
    const meta = row.metadata as { to?: string } | null;
    if (!row.entityId || !meta?.to) continue;
    if (meta.to === "RESOLVED") everResolvedIds.add(row.entityId);
    if (meta.to === "REOPENED") everReopenedIds.add(row.entityId);
  }

  const delivery: DeliveryAnalytics = {
    closureRatePct: rate(closedTickets.length, createdCount),
    onTimeClosurePct: rate(onTime.length, withDue.length),
    closedWithDueDate: withDue.length,
    medianCycleHours: median(cycleHours) === null ? null : Number(median(cycleHours)!.toFixed(1)),
    reopened: everReopenedIds.size,
    everResolved: everResolvedIds.size,
    reopenRatePct: rate(everReopenedIds.size, everResolvedIds.size),
    unassignedOpen,
    backlogOpen,
    dueNextWeek
  };

  // ---------------------------------------------------------------- priority
  const countOf = (rows: Array<{ _count: unknown }>, index: number) => {
    const c = rows[index]?._count;
    return typeof c === "object" && c !== null ? Number((c as { _all?: number })._all ?? 0) : 0;
  };
  const byPriority = (rows: Array<{ priority: string; _count: unknown }>, level: string) => {
    const i = rows.findIndex((r) => r.priority === level);
    return i === -1 ? 0 : countOf(rows, i);
  };

  const priority: PriorityAnalytics = {
    criticalOpen: byPriority(priorityOpenRows as never, "CRITICAL"),
    highOpen: byPriority(priorityOpenRows as never, "HIGH"),
    criticalClosed: byPriority(priorityClosedRows as never, "CRITICAL"),
    highClosed: byPriority(priorityClosedRows as never, "HIGH"),
    criticalOverdue
  };

  // ---------------------------------------------------------------- quality & testing
  const testCount = (status: string) => {
    const row = testRows.find((r) => r.status === status);
    return row ? countOf([row], 0) : 0;
  };
  const testsPassed = testRows.reduce((s, r) => s + Number(r._sum?.passCount ?? 0), 0);
  const testsFailed = testRows.reduce((s, r) => s + Number(r._sum?.failCount ?? 0), 0);
  const runsPassed = testCount("PASSED");
  const runsFailed = testCount("FAILED");
  const gateCount = (status: string) => {
    const row = gateRows.find((r) => r.status === status);
    return row ? countOf([row], 0) : 0;
  };

  const quality: QualityAnalytics = {
    testRuns: testRows.reduce((s, r) => s + countOf([r], 0), 0),
    runsPassed,
    runsFailed,
    testsPassed,
    testsFailed,
    // RUNNING is in neither half: a suite still executing has not failed.
    runPassRatePct: rate(runsPassed, runsPassed + runsFailed),
    testPassRatePct: rate(testsPassed, testsPassed + testsFailed),
    gatesPassed: gateCount("OK"),
    gatesWarned: gateCount("WARN"),
    gatesFailed: gateCount("ERROR")
  };

  // ---------------------------------------------------------------- security
  const openAges = openFindings.map((f) => (end.getTime() - f.firstSeenAt.getTime()) / DAY_MS).filter((d) => d >= 0);
  const medianAge = median(openAges);
  const severityCount = (level: string) => {
    const row = newFindings.find((r) => r.severity === level);
    return row ? countOf([row], 0) : 0;
  };

  const security: SecurityAnalytics = {
    verifiedFixed,
    awaitingVerification,
    scanRuns,
    newCritical: severityCount("CRITICAL"),
    newHigh: severityCount("HIGH"),
    medianOpenAgeDays: medianAge === null ? null : Number(medianAge.toFixed(1)),
    oldestOpenDays: openAges.length ? Number(Math.max(...openAges).toFixed(1)) : null
  };

  // ---------------------------------------------------------------- change
  const outcomeCount = (name: string) => {
    const row = changeOutcomeRows.find((r) => r.outcome === name);
    return row ? countOf([row], 0) : 0;
  };
  const successful = outcomeCount("SUCCESSFUL");
  const withIssues = outcomeCount("SUCCESSFUL_WITH_ISSUES");
  const failed = outcomeCount("FAILED");
  const rolledBack = outcomeCount("ROLLED_BACK");
  const outcomeRecorded = successful + withIssues + failed + rolledBack;

  const change: ChangeAnalytics = {
    successful,
    withIssues,
    failed,
    rolledBack,
    successRatePct: rate(successful, outcomeRecorded),
    outcomeRecorded,
    emergency: emergencyChanges,
    awaitingApproval,
    scheduledNextWeek
  };

  // ---------------------------------------------------------------- people
  const closedByUserMap = new Map<string, number>();
  for (const row of closedByUser) {
    if (row.assigneeId) closedByUserMap.set(row.assigneeId, countOf([row], 0));
  }
  const hoursByUserMap = new Map<string, number>();
  for (const row of hoursByUser) hoursByUserMap.set(row.userId, Number(row._sum.totalHours ?? 0));

  const contributorIds = [...hoursByUserMap.keys()];
  const visiblePeople = contributorIds.length
    ? await prisma.user.findMany({
        where: { id: { in: contributorIds }, ...COUNTED_PEOPLE },
        select: { id: true, name: true, weeklyCapacityHours: true, plannedUtilizationPct: true }
      })
    : [];

  const settings = await optional(getPlanningSettings(), {
    workingDays: [1, 2, 3, 4, 5],
    defaultWeeklyCapacityHours: 40
  } as never);
  const workingDayNumbers = Array.isArray((settings as { workingDays?: unknown }).workingDays)
    ? ((settings as { workingDays: number[] }).workingDays)
    : [1, 2, 3, 4, 5];
  let workingDays = 0;
  for (let d = new Date(start.getTime()); d <= end; d = new Date(d.getTime() + DAY_MS)) {
    if (workingDayNumbers.includes(d.getUTCDay())) workingDays += 1;
  }
  const defaults = {
    weeklyCapacityHours: Number((settings as { defaultWeeklyCapacityHours?: number }).defaultWeeklyCapacityHours ?? 40),
    workingDaysPerWeek: workingDayNumbers.length || 5
  };

  // Contracted capacity of the people shown — not discounted by their target utilisation, which is
  // what they are expected to log against it (workspace-metrics.ts), not less capacity.
  const capacityHours = visiblePeople.reduce(
    (sum, person) =>
      sum +
      capacityForBucket(
        { weeklyCapacityHours: person.weeklyCapacityHours == null ? null : Number(person.weeklyCapacityHours), plannedUtilizationPct: null },
        { workingDays },
        defaults
      ),
    0
  );
  const loggedHours = Number(totalAgg._sum.totalHours ?? 0);
  // Utilisation's numerator is the SAME people's hours as its denominator's capacity. It divided
  // everyone's hours — leavers and agents included — by the capacity of the people still shown.
  const visibleLoggedHours = visiblePeople.reduce((sum, person) => sum + (hoursByUserMap.get(person.id) ?? 0), 0);

  const topContributors = visiblePeople
    .map((person) => ({
      name: person.name,
      hours: Number((hoursByUserMap.get(person.id) ?? 0).toFixed(1)),
      ticketsClosed: closedByUserMap.get(person.id) ?? 0
    }))
    .sort((a, b) => b.hours - a.hours || b.ticketsClosed - a.ticketsClosed)
    .slice(0, 5);

  const people: PeopleAnalytics = {
    topContributors,
    utilisationPct: capacityHours > 0 ? rate(visibleLoggedHours, capacityHours) : null,
    capacityHours: capacityHours > 0 ? Number(capacityHours.toFixed(1)) : null,
    billablePct: rate(Number(billableAgg._sum.totalHours ?? 0), loggedHours),
    silentOwners: openAssignees.filter((row) => row.assigneeId && !hoursByUserMap.has(row.assigneeId)).length
  };

  // ---------------------------------------------------------------- POCs
  const poc: PocAnalytics = {
    started: pocProjects.filter((p) => p.createdAt >= start && p.createdAt < endExclusive).length,
    // ARCHIVED is this workspace's terminal project state; a POC that reached it inside the period
    // is one that finished, which is exactly what "completed POCs" was asking for.
    completed: pocProjects.filter((p) => p.status === "ARCHIVED" && p.updatedAt >= start && p.updatedAt < endExclusive).length,
    ongoing: pocProjects.filter((p) => p.status !== "ARCHIVED").length,
    hours: Number(pocHours.toFixed(1))
  };

  const goals: GoalAnalytics = { active: goalsActive, achievedThisPeriod: goalsAchieved, overdue: goalsOverdue };

  const spend = (spendRows as { _sum: { costUsdEstimate: unknown } })._sum.costUsdEstimate;
  const ai: AiPracticeAnalytics = {
    agentRuns,
    agentRunsFailed,
    interactions,
    spendUsd: spend == null ? null : Number(Number(spend).toFixed(2))
  };

  return { delivery, priority, quality, security, change, people, poc, goals, ai };
}
