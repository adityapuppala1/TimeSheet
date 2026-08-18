/**
 * WHAT: agent work, on the same ledger as human work.
 *
 * WHY THIS IS THE DIFFERENTIATOR (docs/AGENTIC_WORK_MANAGEMENT.md §4): every competitor's agent story
 * ends at "it ran". Asana, Monday, Wrike and ClickUp hold estimates, not measured effort, so they can
 * tell you an agent acted and nothing more. This product already holds approved hours per person per
 * project per day with a rate snapshot captured at approval — so an agent's work can be attributed,
 * priced and compared against the real thing rather than asserted.
 *
 * THREE RULES THAT KEEP IT HONEST, and each of them is a decision that could easily have gone the
 * flattering way instead:
 *
 *   1. MEASURED, NOT ESTIMATED. Duration is the run's own wall clock; cost is summed from
 *      `AIUsageLog` for that run. Both are recorded facts.
 *   2. DISPLACEMENT IS STATED OR ABSENT, NEVER GUESSED. `displacedMinutes` is populated only where
 *      this workspace's own approved timesheets give a baseline for comparable work, and the basis is
 *      stored beside it so the figure can be checked. Where there is no baseline it is NULL and the UI
 *      says "not measurable" — the same rule the dashboard widgets and `budget.service.ts`'s forecast
 *      already follow. An invented saving is the number a customer quotes back at renewal.
 *   3. NEVER BILLABLE BY DEFAULT (decision 3, §7). Agent cost is real cost, but invoicing machine
 *      minutes is a commercial choice no default should make. Nothing here is priced into
 *      `Timesheet.billedAmount`, so `budget.service.ts` keeps its single definition of money.
 *
 * WHY WRITING IS FIRE-AND-FORGET: this is called from the run's `finish`, and a ledger row failing to
 * write must never turn a completed run into a failed one. Accounting is downstream of the work.
 *
 * WHO CALLS THIS: `agent-run.service.ts#finish` (write), `controllers/agent.controller.ts` (read).
 */
import { prisma } from "../config/prisma.js";

/**
 * The one place a displacement baseline is decided.
 *
 * Only capabilities whose human equivalent is a thing people actually log time against get one, and
 * the baseline is this workspace's own median for that activity — never a vendor's benchmark. The map
 * is deliberately small: three honest entries beat twenty invented ones, and a capability absent from
 * it reports "not measurable" rather than a plausible guess.
 */
const DISPLACEMENT_ACTIVITY: Record<string, string> = {
  triage: "Support",
  duplicate_detection: "Support",
  ci_failure_triage: "Bug Fixing",
  security_finding_triage: "Bug Fixing",
  status_report: "Documentation",
  plan_breakdown: "Planning"
};

/**
 * Median minutes this workspace's own people spend on one entry of comparable work.
 *
 * A median, not a mean: one 9-hour day of triage would drag a mean far enough to make every later
 * saving look heroic. Returns null below five samples — a "median" of two rows is an anecdote, and
 * this figure appears next to a currency amount.
 */
async function baselineMinutes(activityName: string): Promise<{ minutes: number; basis: string } | null> {
  const rows = await prisma.timesheet.findMany({
    where: { status: "APPROVED", deletedAt: null, activityType: activityName },
    select: { totalHours: true },
    orderBy: { workDate: "desc" },
    take: 200
  });
  if (rows.length < 5) return null;

  const minutes = rows.map((r) => Number(r.totalHours) * 60).sort((a, b) => a - b);
  const mid = Math.floor(minutes.length / 2);
  const median = minutes.length % 2 === 0 ? (minutes[mid - 1] + minutes[mid]) / 2 : minutes[mid];
  return {
    minutes: Math.round(median),
    basis: `median of ${rows.length} approved "${activityName}" entries in this workspace`
  };
}

/**
 * Records what a finished run cost and displaced. Idempotent on `agentRunId`, so a retried finish
 * cannot double-count — the same reasoning as `AgentRun.triggerKey`, one level down.
 */
export async function recordAgentWork(runId: string): Promise<void> {
  const run = await prisma.agentRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      capability: true,
      status: true,
      onBehalfOfId: true,
      scopeProjectId: true,
      costUsd: true,
      startedAt: true,
      finishedAt: true,
      createdAt: true,
      onBehalfOf: { select: { isAgent: true } }
    }
  });

  // Only an agent identity's work belongs on this ledger. A human triggering a capability by hand is
  // their own work, already on their timesheet if it was worth logging.
  if (!run || !run.onBehalfOf?.isAgent) return;
  // ABORTED and FAILED runs cost money and are recorded; only work that never started is skipped.
  if (run.status === "QUEUED" || run.status === "RUNNING") return;

  const existing = await prisma.agentWorkEntry.findUnique({ where: { agentRunId: run.id }, select: { id: true } });
  if (existing) return;

  const started = run.startedAt ?? run.createdAt;
  const finished = run.finishedAt ?? new Date();
  const durationSeconds = Math.max(0, Math.round((finished.getTime() - started.getTime()) / 1000));

  const activity = DISPLACEMENT_ACTIVITY[run.capability];
  const baseline = activity ? await baselineMinutes(activity) : null;

  await prisma.agentWorkEntry.create({
    data: {
      agentRunId: run.id,
      capability: run.capability,
      agentUserId: run.onBehalfOfId,
      projectId: run.scopeProjectId ?? null,
      durationSeconds,
      costUsd: run.costUsd ?? 0,
      displacedMinutes: baseline?.minutes ?? null,
      displacedBasis: baseline?.basis ?? null,
      // Opt-in per project, and there is deliberately no route that flips this yet: the commercial
      // decision comes before the switch for it.
      billable: false
    }
  });
}

export interface LedgerSummary {
  /** Rows on the ledger, all time. */
  entries: number;
  totalCostUsd: number;
  totalDurationHours: number;
  /** Sum of the displacements that ARE measurable, and a count of the ones that are not — reported
   *  separately so the figure is never read as covering everything. */
  displacedHours: number;
  measuredEntries: number;
  unmeasurableEntries: number;
  /** None of it is billable while decision 3 stands, but the number is returned so the UI can say so
   *  rather than leaving the question open. */
  billableCostUsd: number;
  byCapability: Array<{ capability: string; entries: number; costUsd: number; displacedMinutes: number | null }>;
}

/** Read side. Aggregated in JS over a bounded fetch rather than in SQL: the volume is small, and the
 *  "measurable versus not" split is the whole point — a `SUM` would silently treat NULL as zero. */
export async function summariseLedger(): Promise<LedgerSummary> {
  const rows = await prisma.agentWorkEntry.findMany({
    orderBy: { occurredAt: "desc" },
    take: 5000,
    select: { capability: true, costUsd: true, durationSeconds: true, displacedMinutes: true, billable: true }
  });

  const byCapability = new Map<string, { entries: number; costUsd: number; displacedMinutes: number | null }>();
  let totalCostUsd = 0;
  let totalSeconds = 0;
  let displacedMinutes = 0;
  let measuredEntries = 0;
  let billableCostUsd = 0;

  for (const row of rows) {
    const cost = Number(row.costUsd ?? 0);
    totalCostUsd += cost;
    totalSeconds += row.durationSeconds;
    if (row.billable) billableCostUsd += cost;
    if (row.displacedMinutes != null) {
      displacedMinutes += row.displacedMinutes;
      measuredEntries += 1;
    }

    const bucket = byCapability.get(row.capability) ?? { entries: 0, costUsd: 0, displacedMinutes: null };
    bucket.entries += 1;
    bucket.costUsd += cost;
    if (row.displacedMinutes != null) bucket.displacedMinutes = (bucket.displacedMinutes ?? 0) + row.displacedMinutes;
    byCapability.set(row.capability, bucket);
  }

  return {
    entries: rows.length,
    totalCostUsd: Number(totalCostUsd.toFixed(4)),
    totalDurationHours: Number((totalSeconds / 3600).toFixed(2)),
    displacedHours: Number((displacedMinutes / 60).toFixed(2)),
    measuredEntries,
    unmeasurableEntries: rows.length - measuredEntries,
    billableCostUsd: Number(billableCostUsd.toFixed(4)),
    byCapability: [...byCapability.entries()]
      .map(([capability, v]) => ({ capability, ...v, costUsd: Number(v.costUsd.toFixed(4)) }))
      .sort((a, b) => b.entries - a.entries)
  };
}
