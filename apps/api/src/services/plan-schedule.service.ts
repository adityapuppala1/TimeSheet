/**
 * WHAT: the scheduling engine behind the timeline — working-day arithmetic, dependency
 * resolution, critical-path analysis, progress roll-up and slip detection.
 *
 * WHY IT IS A PURE CORE WITH A THIN DB SHELL: every interesting failure in a scheduler is an
 * arithmetic one — an off-by-one on a working day, a cycle that hangs the solver, a lag applied
 * to the wrong end of a link. Those are exactly the things that are cheap to unit-test and
 * miserable to debug through a database. So everything below the "DB-facing" banner is a thin
 * loader; everything above it takes plain objects and returns plain objects, and that is where
 * the tests live (`tests/unit/plan-schedule.service.test.ts`).
 *
 * WHAT IT DELIBERATELY IS NOT: an auto-scheduler. It never moves a date on its own. It computes
 * what the dates IMPLY (this task can't start before that one finishes; this chain is what makes
 * the project end when it does; this item has slipped 6 days from its baseline) and hands that
 * to the UI, or to a human-reviewed AI proposal in Phase 5. A scheduler that silently rewrites
 * dates because a dependency moved is a scheduler people stop trusting the first time it's
 * wrong, and there is no undo for "40 dates moved overnight".
 *
 * WHO CALLS THIS: `controllers/plan.controller.ts` (timeline feed, dependency validation),
 * `controllers/portfolio.controller.ts` (roll-up), and from Phase 5 the risk scorer.
 */
import { SCHEDULING_LINK_TYPES, type TicketLinkType } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { AppError } from "../middleware/error.js";

/* ================================================================== *
 * Day arithmetic
 *
 * Everything is a UTC-midnight Date. A planning date is a CALENDAR DAY, not an instant: "starts
 * on the 3rd" means the same thing in Mumbai and Chicago, and the moment a time-of-day creeps in,
 * the same stored value renders as two different days either side of a timezone boundary. That
 * bug is invisible in development (one timezone) and immediate in production (a distributed
 * team), so it is prevented here rather than caught later.
 * ================================================================== */

/** UTC-midnight Date for a `YYYY-MM-DD` string or any Date/ISO input. */
export function toDay(value: Date | string): Date {
  const source = typeof value === "string" ? value : value.toISOString();
  return new Date(`${source.slice(0, 10)}T00:00:00.000Z`);
}

export function dayKey(value: Date | string): string {
  return toDay(value).toISOString().slice(0, 10);
}

const MS_PER_DAY = 86_400_000;

export function addDays(day: Date, count: number): Date {
  return new Date(day.getTime() + count * MS_PER_DAY);
}

/** Calendar days between two days, signed. */
export function daysBetween(from: Date, to: Date): number {
  return Math.round((toDay(to).getTime() - toDay(from).getTime()) / MS_PER_DAY);
}

export type WorkingDays = readonly number[];
export const DEFAULT_WORKING_DAYS: WorkingDays = [1, 2, 3, 4, 5];

export function isWorkingDay(day: Date, workingDays: WorkingDays = DEFAULT_WORKING_DAYS): boolean {
  return workingDays.includes(day.getUTCDay());
}

/**
 * The next working day on or after `day`. Used to land every computed date on a day people
 * actually work — a task that "starts Saturday" is a scheduling artefact, not a plan.
 *
 * Bounded at 14 iterations: `workingDays` is validated non-empty at the API layer, but a bad row
 * reaching here must not spin forever inside a request. 14 is two full weeks — unreachable with
 * any non-empty set, so hitting it means the data is wrong, and saying so beats hanging.
 */
export function nextWorkingDay(day: Date, workingDays: WorkingDays = DEFAULT_WORKING_DAYS): Date {
  let cursor = toDay(day);
  for (let i = 0; i < 14; i++) {
    if (isWorkingDay(cursor, workingDays)) return cursor;
    cursor = addDays(cursor, 1);
  }
  throw new AppError(500, "No working days configured — check Workspace Settings → Planning.");
}

/**
 * Move `count` WORKING days from `start`. `count` is a span, not an offset: a 1-day task starting
 * Monday finishes Monday, so `addWorkingDays(mon, 1)` is Monday, and `addWorkingDays(mon, 5)` is
 * Friday. Getting this off by one is the classic Gantt bug where every bar is a day too long.
 */
export function addWorkingDays(start: Date, count: number, workingDays: WorkingDays = DEFAULT_WORKING_DAYS): Date {
  if (count <= 0) return nextWorkingDay(start, workingDays);
  let cursor = nextWorkingDay(start, workingDays);
  let remaining = count - 1;
  let guard = 0;
  while (remaining > 0) {
    cursor = addDays(cursor, 1);
    if (isWorkingDay(cursor, workingDays)) remaining--;
    // 20 years of calendar days. A span that large is a data error, not a plan.
    if (++guard > 7300) throw new AppError(422, "Task duration is implausibly long.");
  }
  return cursor;
}

/** Inclusive count of working days in [start, end]. Zero if end precedes start. */
export function workingDaysBetween(start: Date, end: Date, workingDays: WorkingDays = DEFAULT_WORKING_DAYS): number {
  const from = toDay(start);
  const to = toDay(end);
  if (to < from) return 0;
  let count = 0;
  let cursor = from;
  let guard = 0;
  while (cursor <= to) {
    if (isWorkingDay(cursor, workingDays)) count++;
    cursor = addDays(cursor, 1);
    if (++guard > 7300) break;
  }
  return count;
}

/* ================================================================== *
 * The schedule model
 * ================================================================== */

export interface PlanItem {
  id: string;
  key: string;
  title: string;
  parentId: string | null;
  startDate: Date | null;
  endDate: Date | null;
  isMilestone: boolean;
  /** Manual override, 0-100. Null = derive it. */
  progressPct: number | null;
  estimatedHours: number | null;
  status: string;
  statusCategory: string;
  baselineStartDate: Date | null;
  baselineEndDate: Date | null;
  /** Hours already logged against this item (approved timesheets). Drives derived progress. */
  loggedHours?: number;
}

export interface PlanDependency {
  id: string;
  /** The PREDECESSOR — the item that must happen first. */
  fromId: string;
  /** The SUCCESSOR — the item constrained by it. */
  toId: string;
  type: TicketLinkType;
  lagDays: number;
}

export interface ScheduledItem extends PlanItem {
  /** Resolved span, always populated — an item with no dates still occupies a row on the
   *  timeline, and giving it a computed placeholder is more useful than hiding it. */
  resolvedStart: Date;
  resolvedEnd: Date;
  durationDays: number;
  /** Working days this item could slip without moving the project end. 0 = critical. */
  totalFloatDays: number;
  isCritical: boolean;
  /** Computed roll-up for parents; the manual override when set. */
  effectiveProgressPct: number;
  /** Working days later than baseline the item now ends. Negative = ahead. Null = no baseline. */
  slipDays: number | null;
  /** Dependencies this item VIOLATES as currently dated, e.g. it starts before its predecessor
   *  finishes. Reported, never auto-fixed — see the file header. */
  violations: Array<{ dependencyId: string; message: string }>;
  /** True when the dates are inferred rather than entered — the UI renders these differently so
   *  nobody mistakes a guess for a commitment. */
  isInferred: boolean;
  depth: number;
}

const DEFAULT_DURATION_DAYS = 1;
/** Only used to turn an estimate into a span when no dates exist. Not a capacity model — that
 *  arrives in Phase 3 with real per-person capacity. */
const ASSUMED_HOURS_PER_DAY = 8;

function inferDuration(item: PlanItem): number {
  if (item.isMilestone) return 0;
  if (item.estimatedHours && item.estimatedHours > 0) {
    return Math.max(1, Math.ceil(item.estimatedHours / ASSUMED_HOURS_PER_DAY));
  }
  return DEFAULT_DURATION_DAYS;
}

/* ================================================================== *
 * Cycle detection
 * ================================================================== */

/**
 * Returns the cycle as a list of ids if the dependency graph has one, else null.
 *
 * WHY THIS RUNS BEFORE EVERY DEPENDENCY WRITE, not just before solving: a cycle makes the
 * topological sort below undefined, and the honest place to refuse one is at the moment someone
 * creates it, while they still have the context to know which link they meant. Discovering it
 * later, as a timeline that renders wrong, gives them no way to tell which of forty links is the
 * culprit — so `assertNoCycle` names the ring.
 */
export function findCycle(items: Array<{ id: string }>, dependencies: PlanDependency[]): string[] | null {
  const adjacency = new Map<string, string[]>();
  for (const item of items) adjacency.set(item.id, []);
  for (const dep of dependencies) {
    if (!adjacency.has(dep.fromId) || !adjacency.has(dep.toId)) continue;
    adjacency.get(dep.fromId)!.push(dep.toId);
  }

  const UNVISITED = 0;
  const IN_STACK = 1;
  const DONE = 2;
  const state = new Map<string, number>();
  for (const item of items) state.set(item.id, UNVISITED);
  const stack: string[] = [];

  // Iterative rather than recursive: a long dependency chain in a big project would blow the
  // call stack, and "the timeline 500s on our biggest project" is a bad way to find that out.
  for (const root of items) {
    if (state.get(root.id) !== UNVISITED) continue;
    const work: Array<{ id: string; index: number }> = [{ id: root.id, index: 0 }];
    state.set(root.id, IN_STACK);
    stack.push(root.id);

    while (work.length > 0) {
      const frame = work[work.length - 1];
      const neighbours = adjacency.get(frame.id) ?? [];
      if (frame.index >= neighbours.length) {
        state.set(frame.id, DONE);
        stack.pop();
        work.pop();
        continue;
      }
      const next = neighbours[frame.index++];
      const nextState = state.get(next);
      if (nextState === IN_STACK) {
        // Slice from where the ring starts so the message names only the cycle, not the path
        // that led to it.
        const start = stack.indexOf(next);
        return [...stack.slice(start), next];
      }
      if (nextState === UNVISITED) {
        state.set(next, IN_STACK);
        stack.push(next);
        work.push({ id: next, index: 0 });
      }
    }
  }
  return null;
}

export function assertNoCycle(
  items: Array<{ id: string; key?: string }>,
  dependencies: PlanDependency[]
): void {
  const cycle = findCycle(items, dependencies);
  if (!cycle) return;
  const label = new Map(items.map((i) => [i.id, i.key ?? i.id]));
  throw new AppError(422, `That dependency would create a loop: ${cycle.map((id) => label.get(id) ?? id).join(" → ")}`);
}

/* ================================================================== *
 * The solver
 * ================================================================== */

/**
 * Topological order. Assumes `assertNoCycle` already passed; any node left unemitted (which can
 * only happen if a cycle slipped through) is appended rather than dropped, because losing a task
 * off the timeline is a worse failure than showing it in a slightly odd order.
 */
function topologicalOrder(items: PlanItem[], dependencies: PlanDependency[]): PlanItem[] {
  const indegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const item of items) {
    indegree.set(item.id, 0);
    adjacency.set(item.id, []);
  }
  for (const dep of dependencies) {
    if (!indegree.has(dep.fromId) || !indegree.has(dep.toId)) continue;
    adjacency.get(dep.fromId)!.push(dep.toId);
    indegree.set(dep.toId, (indegree.get(dep.toId) ?? 0) + 1);
  }

  const byId = new Map(items.map((i) => [i.id, i]));
  const queue = items.filter((i) => (indegree.get(i.id) ?? 0) === 0).map((i) => i.id);
  const ordered: PlanItem[] = [];
  const emitted = new Set<string>();

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (emitted.has(id)) continue;
    emitted.add(id);
    ordered.push(byId.get(id)!);
    for (const next of adjacency.get(id) ?? []) {
      indegree.set(next, (indegree.get(next) ?? 1) - 1);
      if ((indegree.get(next) ?? 0) === 0) queue.push(next);
    }
  }
  for (const item of items) if (!emitted.has(item.id)) ordered.push(item);
  return ordered;
}

/**
 * The constraint a dependency puts on its successor's START, expressed as "not before this day".
 *
 * The four types differ only in which endpoints they tie together. `BLOCKS` is treated as
 * finish-to-start because that is what it has always meant in this app's ticket detail sheet, and
 * V5 orgs have real data recorded under it — reinterpreting it would silently change their plans.
 */
function earliestStartFrom(
  dep: PlanDependency,
  predecessor: { start: Date; end: Date },
  workingDays: WorkingDays
): Date | null {
  const lag = dep.lagDays ?? 0;
  switch (dep.type) {
    case "BLOCKS":
    case "FINISH_TO_START":
      // Day AFTER the predecessor finishes, then the lag.
      return addWorkingDays(addDays(predecessor.end, 1), lag + 1, workingDays);
    case "START_TO_START":
      return addWorkingDays(predecessor.start, lag + 1, workingDays);
    case "FINISH_TO_FINISH":
    case "START_TO_FINISH":
      // These constrain the successor's FINISH, not its start; handled by the caller, which
      // needs the successor's own duration to convert. Signalled by returning null here.
      return null;
    default:
      return null;
  }
}

export interface SolveOptions {
  workingDays?: WorkingDays;
  /** Anchor for items with no dates and no dated predecessor. Defaults to today. */
  projectStart?: Date;
}

export interface SolvedSchedule {
  items: ScheduledItem[];
  /** Earliest resolved start across every item, or null when there are none. */
  start: Date | null;
  end: Date | null;
  criticalPath: string[];
  /** Every violated dependency across the plan, flattened for a single "N scheduling conflicts"
   *  banner rather than making the UI walk the tree to find them. */
  violations: Array<{ itemId: string; dependencyId: string; message: string }>;
}

/**
 * Resolves dates, float, critical path, progress and slip for one set of items.
 *
 * Explicit dates ALWAYS win. The forward pass computes what a dependency implies, but if a human
 * typed a start date, that is what the bar shows — with the conflict reported separately. This is
 * the difference between a tool that tells you your plan is inconsistent and one that silently
 * disagrees with what you entered.
 */
export function solveSchedule(
  items: PlanItem[],
  dependencies: PlanDependency[],
  options: SolveOptions = {}
): SolvedSchedule {
  const workingDays = options.workingDays?.length ? options.workingDays : DEFAULT_WORKING_DAYS;
  const anchor = nextWorkingDay(options.projectStart ? toDay(options.projectStart) : toDay(new Date()), workingDays);

  const scheduling = dependencies.filter((d) => SCHEDULING_LINK_TYPES.includes(d.type));
  const ordered = topologicalOrder(items, scheduling);

  const byId = new Map(items.map((i) => [i.id, i]));
  const resolved = new Map<string, { start: Date; end: Date; duration: number; inferred: boolean }>();
  const violations: Array<{ itemId: string; dependencyId: string; message: string }> = [];

  const incoming = new Map<string, PlanDependency[]>();
  for (const dep of scheduling) {
    if (!byId.has(dep.fromId) || !byId.has(dep.toId)) continue;
    if (!incoming.has(dep.toId)) incoming.set(dep.toId, []);
    incoming.get(dep.toId)!.push(dep);
  }

  for (const item of ordered) {
    const duration = item.isMilestone ? 0 : item.startDate && item.endDate
      ? Math.max(1, workingDaysBetween(toDay(item.startDate), toDay(item.endDate), workingDays))
      : inferDuration(item);

    // What the dependencies say the earliest legal start is.
    let constraint: Date | null = null;
    for (const dep of incoming.get(item.id) ?? []) {
      const pred = resolved.get(dep.fromId);
      if (!pred) continue;
      const fromLink = earliestStartFrom(dep, pred, workingDays);
      if (fromLink && (!constraint || fromLink > constraint)) constraint = fromLink;

      if (dep.type === "FINISH_TO_FINISH" || dep.type === "START_TO_FINISH") {
        // These constrain the successor's FINISH. Convert "must not finish before X" into a
        // start by walking back this item's own duration — which is why they're handled here,
        // where the duration is known, rather than inside earliestStartFrom.
        const anchorEnd = dep.type === "FINISH_TO_FINISH" ? pred.end : pred.start;
        const requiredEnd = addWorkingDays(anchorEnd, (dep.lagDays ?? 0) + 1, workingDays);
        const candidate = subtractWorkingDays(requiredEnd, Math.max(0, duration - 1), workingDays);
        if (!constraint || candidate > constraint) constraint = candidate;
      }
    }

    let start: Date;
    let inferred = false;
    if (item.startDate) {
      start = nextWorkingDay(toDay(item.startDate), workingDays);
    } else if (constraint) {
      start = constraint;
      inferred = true;
    } else {
      start = anchor;
      inferred = true;
    }

    let end: Date;
    if (item.isMilestone) {
      end = start;
    } else if (item.endDate) {
      end = nextWorkingDay(toDay(item.endDate), workingDays);
      if (end < start) end = start;
    } else {
      end = addWorkingDays(start, duration, workingDays);
      inferred = true;
    }

    // Explicit dates that contradict a dependency are REPORTED, never silently corrected.
    if (constraint && item.startDate && start < constraint) {
      for (const dep of incoming.get(item.id) ?? []) {
        const pred = resolved.get(dep.fromId);
        if (!pred) continue;
        const required = earliestStartFrom(dep, pred, workingDays);
        if (required && start < required) {
          violations.push({
            itemId: item.id,
            dependencyId: dep.id,
            message: `${item.key} starts ${dayKey(start)}, before ${byId.get(dep.fromId)?.key ?? "its predecessor"} allows (${dayKey(required)}).`
          });
        }
      }
    }

    resolved.set(item.id, {
      start,
      end,
      duration: item.isMilestone ? 0 : workingDaysBetween(start, end, workingDays),
      inferred
    });
  }

  /* --- Backward pass: latest dates, float, critical path -------------------------------- */

  const projectEnd = items.length
    ? items.reduce<Date | null>((latest, item) => {
        const r = resolved.get(item.id)!;
        return !latest || r.end > latest ? r.end : latest;
      }, null)
    : null;

  const outgoing = new Map<string, PlanDependency[]>();
  for (const dep of scheduling) {
    if (!byId.has(dep.fromId) || !byId.has(dep.toId)) continue;
    if (!outgoing.has(dep.fromId)) outgoing.set(dep.fromId, []);
    outgoing.get(dep.fromId)!.push(dep);
  }

  const latestFinish = new Map<string, Date>();
  for (const item of [...ordered].reverse()) {
    const successors = outgoing.get(item.id) ?? [];
    if (successors.length === 0) {
      latestFinish.set(item.id, projectEnd ?? resolved.get(item.id)!.end);
      continue;
    }
    let latest: Date | null = null;
    for (const dep of successors) {
      const succLatest = latestFinish.get(dep.toId);
      const succ = resolved.get(dep.toId);
      if (!succLatest || !succ) continue;
      // How late this item may finish and still let its successor hit ITS latest finish.
      const succLatestStart = subtractWorkingDays(succLatest, Math.max(0, succ.duration - 1), workingDays);
      const allowed =
        dep.type === "START_TO_START"
          ? addWorkingDays(succLatestStart, -(dep.lagDays ?? 0) + 1, workingDays)
          : subtractWorkingDays(succLatestStart, (dep.lagDays ?? 0) + 1, workingDays);
      if (!latest || allowed < latest) latest = allowed;
    }
    latestFinish.set(item.id, latest ?? projectEnd ?? resolved.get(item.id)!.end);
  }

  /* --- Progress roll-up ----------------------------------------------------------------- */

  const childrenOf = new Map<string, PlanItem[]>();
  for (const item of items) {
    if (!item.parentId) continue;
    if (!childrenOf.has(item.parentId)) childrenOf.set(item.parentId, []);
    childrenOf.get(item.parentId)!.push(item);
  }
  const progress = rollUpProgress(items, childrenOf);
  const depth = computeDepth(items);

  const scheduled: ScheduledItem[] = items.map((item) => {
    const r = resolved.get(item.id)!;
    const latest = latestFinish.get(item.id) ?? r.end;
    const float = Math.max(0, workingDaysBetween(r.end, latest, workingDays) - 1);
    const itemViolations = violations.filter((v) => v.itemId === item.id).map(({ dependencyId, message }) => ({ dependencyId, message }));

    return {
      ...item,
      resolvedStart: r.start,
      resolvedEnd: r.end,
      durationDays: r.duration,
      totalFloatDays: float,
      isCritical: float === 0,
      effectiveProgressPct: progress.get(item.id) ?? 0,
      slipDays: item.baselineEndDate ? workingDaysBetween(toDay(item.baselineEndDate), r.end, workingDays) - 1 : null,
      violations: itemViolations,
      isInferred: r.inferred,
      depth: depth.get(item.id) ?? 0
    };
  });

  const start = scheduled.reduce<Date | null>((min, i) => (!min || i.resolvedStart < min ? i.resolvedStart : min), null);

  return {
    items: scheduled,
    start,
    end: projectEnd,
    criticalPath: scheduled.filter((i) => i.isCritical).map((i) => i.id),
    violations
  };
}

/** Mirror of addWorkingDays going backwards. Kept separate rather than passing a negative count,
 *  because the "a 1-day span starts and ends on the same day" rule reads clearly in one direction
 *  and confusingly in both. */
export function subtractWorkingDays(end: Date, count: number, workingDays: WorkingDays = DEFAULT_WORKING_DAYS): Date {
  let cursor = toDay(end);
  let remaining = count;
  let guard = 0;
  while (remaining > 0) {
    cursor = addDays(cursor, -1);
    if (isWorkingDay(cursor, workingDays)) remaining--;
    if (++guard > 7300) break;
  }
  while (!isWorkingDay(cursor, workingDays) && guard++ < 7314) cursor = addDays(cursor, -1);
  return cursor;
}

/**
 * Progress for every item.
 *
 * A leaf uses its manual `progressPct` when set; otherwise it derives one from status category
 * (DONE = 100, TODO = 0) and, for in-flight work, from logged-vs-estimated hours — which is the
 * number this app uniquely has and a pure PM tool does not.
 *
 * A parent is the EFFORT-WEIGHTED average of its descendants, not the plain mean. A 40-hour epic
 * with one finished 1-hour subtask is 2.5% done, not 50%, and the plain mean is how status
 * reports end up cheerfully wrong.
 */
export function rollUpProgress(items: PlanItem[], childrenOf: Map<string, PlanItem[]>): Map<string, number> {
  const result = new Map<string, number>();
  const byId = new Map(items.map((i) => [i.id, i]));

  function leafProgress(item: PlanItem): number {
    if (item.progressPct !== null && item.progressPct !== undefined) {
      return Math.min(100, Math.max(0, item.progressPct));
    }
    if (item.statusCategory === "DONE") return 100;
    if (item.statusCategory === "CANCELLED") return 100;
    if (item.statusCategory === "TODO") return 0;
    if (item.estimatedHours && item.estimatedHours > 0 && item.loggedHours) {
      return Math.min(95, Math.round((item.loggedHours / item.estimatedHours) * 100));
    }
    // In flight, nothing to measure with: 50 is a placeholder, and the UI marks these as
    // estimated so nobody reads it as a measurement.
    return item.statusCategory === "REVIEW" ? 90 : 50;
  }

  function weightOf(item: PlanItem): number {
    return item.estimatedHours && item.estimatedHours > 0 ? item.estimatedHours : 1;
  }

  const visiting = new Set<string>();
  function compute(item: PlanItem): number {
    if (result.has(item.id)) return result.get(item.id)!;
    // Parent cycles are impossible via the API (assertNoParentCycle) but a hand-edited database
    // must not hang the request.
    if (visiting.has(item.id)) return 0;
    visiting.add(item.id);

    const children = childrenOf.get(item.id) ?? [];
    let value: number;
    if (children.length === 0) {
      value = leafProgress(item);
    } else if (item.progressPct !== null && item.progressPct !== undefined) {
      // An explicit number on a parent is a deliberate override of the roll-up — someone
      // reporting "this epic is 30% done" outranks arithmetic over its children.
      value = Math.min(100, Math.max(0, item.progressPct));
    } else {
      let weighted = 0;
      let total = 0;
      for (const child of children) {
        const w = subtreeWeight(child);
        weighted += compute(child) * w;
        total += w;
      }
      value = total > 0 ? Math.round(weighted / total) : 0;
    }
    visiting.delete(item.id);
    result.set(item.id, value);
    return value;
  }

  const weightCache = new Map<string, number>();
  function subtreeWeight(item: PlanItem): number {
    if (weightCache.has(item.id)) return weightCache.get(item.id)!;
    weightCache.set(item.id, 1); // cycle guard
    const children = childrenOf.get(item.id) ?? [];
    const value = children.length === 0 ? weightOf(item) : children.reduce((sum, c) => sum + subtreeWeight(c), 0);
    weightCache.set(item.id, value);
    return value;
  }

  for (const item of items) compute(byId.get(item.id)!);
  return result;
}

function computeDepth(items: PlanItem[]): Map<string, number> {
  const byId = new Map(items.map((i) => [i.id, i]));
  const depth = new Map<string, number>();
  for (const item of items) {
    let level = 0;
    let cursor: PlanItem | undefined = item;
    const seen = new Set<string>();
    while (cursor?.parentId && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      cursor = byId.get(cursor.parentId);
      if (!cursor) break;
      level++;
      if (level > 20) break;
    }
    depth.set(item.id, level);
  }
  return depth;
}

/**
 * Refuses a parent assignment that would make an item its own ancestor.
 *
 * Separate from `findCycle` because hierarchy and dependencies are different graphs with
 * different failure modes: a dependency cycle makes the schedule undefined, a parent cycle makes
 * the TREE infinite — every render, every roll-up and every breadcrumb would loop.
 */
export function assertNoParentCycle(
  itemId: string,
  proposedParentId: string,
  parentOf: Map<string, string | null>
): void {
  if (itemId === proposedParentId) throw new AppError(422, "An item can't be its own parent.");
  let cursor: string | null | undefined = proposedParentId;
  const seen = new Set<string>();
  while (cursor) {
    if (cursor === itemId) throw new AppError(422, "That would make the item its own ancestor.");
    if (seen.has(cursor)) break;
    seen.add(cursor);
    cursor = parentOf.get(cursor) ?? null;
  }
}

/* ================================================================== *
 * DB-facing shell
 * ================================================================== */

const PLAN_SELECT = {
  id: true,
  key: true,
  title: true,
  parentId: true,
  startDate: true,
  endDate: true,
  isMilestone: true,
  progressPct: true,
  estimatedHours: true,
  status: true,
  priority: true,
  type: true,
  assigneeId: true,
  projectId: true,
  baselineStartDate: true,
  baselineEndDate: true,
  baselineEffortHours: true,
  workflowStatus: { select: { id: true, name: true, category: true, color: true } },
  assignee: { select: { id: true, name: true, avatarUrl: true } },
  project: { select: { id: true, code: true, name: true } }
} as const;

export async function readWorkingDays(): Promise<WorkingDays> {
  const settings = await prisma.globalPlanningSettings.findUnique({ where: { id: "global" } });
  const days = settings?.workingDays;
  return Array.isArray(days) && days.length > 0 ? (days as number[]) : DEFAULT_WORKING_DAYS;
}

/**
 * Loads a plan (one project, or a set of projects) and solves it.
 *
 * Logged hours are fetched in ONE grouped query rather than per item — the timeline is the
 * densest read in the app (every work item in a project, plus its links, plus its actuals), and
 * an N+1 here is the difference between a page that opens and one that times out on a real
 * backlog.
 */
export async function buildPlan(params: {
  projectIds: string[];
  includeClosed?: boolean;
  from?: Date;
  to?: Date;
}): Promise<SolvedSchedule & { raw: Array<Record<string, unknown>> }> {
  const workingDays = await readWorkingDays();

  const where: Record<string, unknown> = {
    deletedAt: null,
    projectId: { in: params.projectIds }
  };
  if (!params.includeClosed) where.status = { notIn: ["CLOSED"] };
  if (params.from && params.to) {
    // Overlap, not containment: a bar that starts before the window and ends inside it is very
    // much on screen, and filtering it out is how timelines end up with mysterious gaps.
    where.OR = [
      { startDate: { lte: params.to }, endDate: { gte: params.from } },
      { startDate: null },
      { endDate: null }
    ];
  }

  const rows = await prisma.ticket.findMany({ where, select: PLAN_SELECT, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return { items: [], start: null, end: null, criticalPath: [], violations: [], raw: [] };

  const [links, logged] = await Promise.all([
    prisma.ticketLink.findMany({
      where: { OR: [{ sourceTicketId: { in: ids } }, { targetTicketId: { in: ids } }] },
      select: { id: true, sourceTicketId: true, targetTicketId: true, type: true, lagDays: true }
    }),
    prisma.timesheet.groupBy({
      by: ["ticketId"],
      where: { ticketId: { in: ids }, status: "APPROVED", deletedAt: null },
      _sum: { totalHours: true }
    })
  ]);

  const loggedByTicket = new Map(logged.map((l) => [l.ticketId!, Number(l._sum.totalHours ?? 0)]));

  const items: PlanItem[] = rows.map((r) => ({
    id: r.id,
    key: r.key,
    title: r.title,
    parentId: r.parentId,
    startDate: r.startDate,
    endDate: r.endDate,
    isMilestone: r.isMilestone,
    progressPct: r.progressPct,
    estimatedHours: r.estimatedHours ? Number(r.estimatedHours) : null,
    status: r.status,
    statusCategory: r.workflowStatus?.category ?? legacyCategory(r.status),
    baselineStartDate: r.baselineStartDate,
    baselineEndDate: r.baselineEndDate,
    loggedHours: loggedByTicket.get(r.id) ?? 0
  }));

  const dependencies: PlanDependency[] = links
    .filter((l) => SCHEDULING_LINK_TYPES.includes(l.type as TicketLinkType))
    .map((l) => ({
      id: l.id,
      fromId: l.sourceTicketId,
      toId: l.targetTicketId,
      type: l.type as TicketLinkType,
      lagDays: l.lagDays ?? 0
    }));

  const solved = solveSchedule(items, dependencies, { workingDays });
  return { ...solved, raw: rows as unknown as Array<Record<string, unknown>> };
}

/** Fallback when a ticket has no workflowStatus row (custom workflows never enabled).
 *  Mirrors DEFAULT_STATUS_CATEGORY in @timesheet/shared. */
export function legacyCategory(status: string): string {
  switch (status) {
    case "OPEN":
    case "REOPENED":
      return "TODO";
    case "IN_PROGRESS":
      return "ACTIVE";
    case "IN_REVIEW":
      return "REVIEW";
    case "RESOLVED":
    case "CLOSED":
      return "DONE";
    default:
      return "TODO";
  }
}
