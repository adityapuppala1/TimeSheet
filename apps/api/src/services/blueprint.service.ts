/**
 * WHAT: blueprints — a saved project/work-item structure that can be stamped out again.
 *
 * WHY DATES ARE RELATIVE DAY OFFSETS AND NEVER ABSOLUTE: that is the entire difference between a
 * reusable template and a copy of last quarter's project. A blueprint says "kickoff on day 0,
 * design runs days 1-5, review is day 6"; instantiating it is "pick a start date", not "now fix up
 * thirty dates by hand". Storing absolute dates would make every blueprint wrong the moment it was
 * saved.
 *
 * WHY DEPENDENCIES REFERENCE ITEMS BY INDEX: the items do not have ids until they are created, and
 * a blueprint has to survive being exported, edited as JSON and re-imported. An index into its own
 * `items` array is the only reference that is stable across all of that. The expander resolves
 * them to real ids in one pass after the rows exist.
 *
 * WHY EXPANSION IS A PURE FUNCTION with a separate persist step: "what would this create?" is the
 * question a preview needs to answer without writing anything, and it is the only part with
 * interesting arithmetic (offsets, working days, dependency resolution). Same pure-core split as
 * the scheduler and the workload board, for the same reason.
 *
 * WHO CALLS THIS: `controllers/blueprint.controller.ts` and the request-form intake path, which
 * can instantiate a whole structure instead of a single ticket.
 */
import { AppError } from "../middleware/error.js";
import { addWorkingDays, dayKey, nextWorkingDay, toDay, type WorkingDays, DEFAULT_WORKING_DAYS } from "./plan-schedule.service.js";

export interface BlueprintItem {
  title: string;
  type?: string;
  description?: string;
  priority?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  /** Working days after the chosen start date. 0 = starts on the start date itself. */
  offsetStartDays?: number;
  /** Inclusive span in working days. 1 = a single day. Ignored for milestones. */
  durationDays?: number;
  isMilestone?: boolean;
  estimatedHours?: number;
  /** Index into `items` of this item's parent, for hierarchy. Must be earlier in the array. */
  parentIndex?: number;
  /** Indexes of predecessors — finish-to-start. Must be earlier in the array. */
  dependsOn?: number[];
  /** `{ customFieldKey: value }` applied after creation. */
  customFields?: Record<string, unknown>;
  moduleName?: string;
}

export interface BlueprintPayload {
  /** Modules to ensure exist on the target project before items are placed in them. */
  modules?: string[];
  items: BlueprintItem[];
  /** Approval steps to open on the FIRST item once created. Emails, resolved at instantiation. */
  approvalChain?: Array<{ approverEmail?: string; guestEmail?: string; order: number }>;
}

/**
 * Rejects a blueprint that cannot be expanded.
 *
 * The "must be earlier in the array" rule on both `parentIndex` and `dependsOn` is doing the same
 * work as the equivalent rule in request forms: it makes cycles impossible by construction rather
 * than something to detect at expansion time, and it keeps a blueprint readable top to bottom.
 */
export function validateBlueprint(payload: BlueprintPayload): void {
  if (!payload || !Array.isArray(payload.items)) throw new AppError(400, "A blueprint needs a list of items.");
  if (payload.items.length === 0) throw new AppError(400, "A blueprint needs at least one item.");
  if (payload.items.length > 300) throw new AppError(400, "A blueprint can contain at most 300 items.");

  payload.items.forEach((item, index) => {
    if (!item.title?.trim()) throw new AppError(400, `Item ${index + 1} needs a title.`);
    if (item.offsetStartDays !== undefined && (!Number.isInteger(item.offsetStartDays) || item.offsetStartDays < 0 || item.offsetStartDays > 3650)) {
      throw new AppError(400, `"${item.title}" has an implausible start offset.`);
    }
    if (item.durationDays !== undefined && (!Number.isInteger(item.durationDays) || item.durationDays < 1 || item.durationDays > 3650)) {
      throw new AppError(400, `"${item.title}" has an implausible duration.`);
    }
    if (item.parentIndex !== undefined) {
      if (item.parentIndex >= index || item.parentIndex < 0) {
        throw new AppError(400, `"${item.title}" must sit under an item listed above it.`);
      }
    }
    for (const dep of item.dependsOn ?? []) {
      if (dep >= index || dep < 0) {
        throw new AppError(400, `"${item.title}" can only depend on an item listed above it.`);
      }
    }
  });
}

export interface ExpandedItem extends BlueprintItem {
  index: number;
  /** Absolute calendar day, `YYYY-MM-DD`. Null for an item with no schedule in the blueprint. */
  startDate: string | null;
  endDate: string | null;
  depth: number;
}

export interface ExpandedBlueprint {
  items: ExpandedItem[];
  start: string | null;
  end: string | null;
  modules: string[];
}

/**
 * Turns relative offsets into real dates against a chosen start.
 *
 * An item with no `offsetStartDays` AND no `durationDays` is left unscheduled rather than being
 * given the project start — a blueprint that lists "write the release notes" without saying when
 * is expressing that it has no date yet, and inventing one would put a commitment on the timeline
 * nobody made.
 */
export function expandBlueprint(
  payload: BlueprintPayload,
  startDate: Date | string,
  workingDays: WorkingDays = DEFAULT_WORKING_DAYS
): ExpandedBlueprint {
  validateBlueprint(payload);
  const anchor = nextWorkingDay(toDay(startDate), workingDays);

  const depths: number[] = [];
  const items: ExpandedItem[] = payload.items.map((item, index) => {
    const depth = item.parentIndex === undefined ? 0 : (depths[item.parentIndex] ?? 0) + 1;
    depths[index] = depth;

    const scheduled = item.offsetStartDays !== undefined || item.durationDays !== undefined;
    if (!scheduled) {
      return { ...item, index, depth, startDate: null, endDate: null };
    }

    // Offsets count WORKING days, matching everything else in the planning layer — a blueprint
    // that said "day 5" and landed on a Saturday would be describing a plan nobody can execute.
    const offset = item.offsetStartDays ?? 0;
    const start = offset === 0 ? anchor : addWorkingDays(anchor, offset + 1, workingDays);
    const end = item.isMilestone ? start : addWorkingDays(start, item.durationDays ?? 1, workingDays);

    return { ...item, index, depth, startDate: dayKey(start), endDate: dayKey(end) };
  });

  const dated = items.filter((i) => i.startDate && i.endDate);
  return {
    items,
    start: dated.reduce<string | null>((min, i) => (!min || i.startDate! < min ? i.startDate! : min), null),
    end: dated.reduce<string | null>((max, i) => (!max || i.endDate! > max ? i.endDate! : max), null),
    modules: Array.from(new Set(payload.modules ?? []))
  };
}

/**
 * Derives a reusable blueprint from a project that already exists.
 *
 * Offsets are measured from the EARLIEST dated item rather than from the project's planned start:
 * the useful thing to reuse is the shape of the work, and anchoring to a planned start that the
 * real work overran would bake that overrun into every future instantiation.
 */
export function deriveBlueprint(
  source: Array<{
    id: string;
    title: string;
    type: string;
    priority: string;
    parentId: string | null;
    startDate: Date | null;
    endDate: Date | null;
    isMilestone: boolean;
    estimatedHours: number | null;
    moduleName?: string | null;
  }>,
  links: Array<{ fromId: string; toId: string }>,
  workingDays: WorkingDays = DEFAULT_WORKING_DAYS
): BlueprintPayload {
  if (source.length === 0) throw new AppError(400, "That project has no work items to learn from.");

  const dated = source.filter((s) => s.startDate);
  const anchor = dated.length > 0 ? dated.reduce((min, s) => (s.startDate! < min ? s.startDate! : min), dated[0].startDate!) : null;

  // Parents must precede children, and predecessors must precede successors — the same ordering
  // constraint validateBlueprint enforces. Sorting by depth then date gets both.
  const byId = new Map(source.map((s) => [s.id, s]));
  const depthOf = (s: (typeof source)[number]): number => {
    let depth = 0;
    let cursor = s.parentId;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor) && depth < 20) {
      seen.add(cursor);
      depth++;
      cursor = byId.get(cursor)?.parentId ?? null;
    }
    return depth;
  };
  const ordered = [...source].sort((a, b) => {
    const d = depthOf(a) - depthOf(b);
    if (d !== 0) return d;
    return (a.startDate?.getTime() ?? Infinity) - (b.startDate?.getTime() ?? Infinity);
  });

  const indexOf = new Map(ordered.map((s, i) => [s.id, i]));

  const items: BlueprintItem[] = ordered.map((s) => {
    const item: BlueprintItem = {
      title: s.title,
      type: s.type,
      priority: s.priority as BlueprintItem["priority"],
      isMilestone: s.isMilestone,
      estimatedHours: s.estimatedHours ?? undefined,
      moduleName: s.moduleName ?? undefined
    };
    if (s.parentId && indexOf.has(s.parentId)) item.parentIndex = indexOf.get(s.parentId);
    if (anchor && s.startDate) {
      // Working days between the anchor and this item's start, as an offset.
      let offset = 0;
      let cursor = toDay(anchor);
      const target = toDay(s.startDate);
      while (cursor < target && offset < 3650) {
        cursor = addWorkingDays(cursor, 2, workingDays);
        offset++;
      }
      item.offsetStartDays = offset;
      if (s.endDate && !s.isMilestone) {
        let span = 1;
        let end = toDay(s.startDate);
        const finish = toDay(s.endDate);
        while (end < finish && span < 3650) {
          end = addWorkingDays(end, 2, workingDays);
          span++;
        }
        item.durationDays = span;
      }
    }
    const predecessors = links
      .filter((l) => l.toId === s.id && indexOf.has(l.fromId))
      .map((l) => indexOf.get(l.fromId)!)
      .filter((i) => i < indexOf.get(s.id)!);
    if (predecessors.length > 0) item.dependsOn = predecessors;
    return item;
  });

  const modules = Array.from(new Set(source.map((s) => s.moduleName).filter((m): m is string => Boolean(m))));
  return { modules, items };
}
