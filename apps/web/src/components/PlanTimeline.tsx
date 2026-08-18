/**
 * WHAT: the Gantt/timeline surface — a hierarchy tree on the left, zoomable date-scaled bars on
 * the right, dependency arrows, baseline ghosts, a today marker and critical-path emphasis.
 * Bars can be dragged to move and edge-dragged to resize, which writes real dates.
 *
 * WHY IT IS HAND-BUILT SVG RATHER THAN A GANTT LIBRARY: every option either ships its own design
 * system (so the one screen that is mostly colour would look like a different product), assumes
 * it owns the data layer, or is unmaintained. The parts that are genuinely hard — dependency
 * resolution, critical path, working-day arithmetic — already live on the server in
 * `plan-schedule.service.ts` and are unit-tested there. What is left here is layout: x = f(date),
 * which is one function. `d3-shape`/`d3-zoom` are already dependencies for the org chart.
 *
 * WHY THE SERVER DECIDES THE DATES AND THIS ONLY DRAWS THEM: the same plan is rendered here, in
 * the portfolio roll-up, and (from phase 5) in a risk score and a scheduled PDF. If each
 * re-derived "when does this actually start" they would disagree, and the one that disagrees is
 * always the one someone is looking at. So this component never computes a schedule — it reads
 * `resolvedStart`/`resolvedEnd` and renders.
 *
 * RESPONSIVENESS: below `lg` the chart is replaced by a compact list rather than being made
 * scrollable. A 3-month Gantt on a 390px phone is not a small Gantt, it is an unusable one, and
 * the honest answer at that width is a different view of the same data.
 *
 * WHO RENDERS THIS: `pages/Timeline.tsx` and the Timeline tab of `pages/Tickets.tsx`.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ChevronDown, ChevronRight, Diamond, Flag, GripVertical, Link2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../lib/utils";
import { planApi, type PlanDependencyRow, type PlanItemRow, type PlanTimeline as PlanTimelineData } from "../services/api";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { toast } from "./ui/toaster";

export type TimelineZoom = "day" | "week" | "month";

/** Pixels per day at each zoom. Chosen so a bar's minimum readable width (~18px) survives: at
 *  month zoom a 1-day task is still a visible tick rather than a sub-pixel sliver. */
const DAY_WIDTH: Record<TimelineZoom, number> = { day: 34, week: 14, month: 5 };
const ROW_HEIGHT = 34;
const BAR_HEIGHT = 18;
const HEADER_HEIGHT = 44;
const TREE_WIDTH = 320;

const MS_PER_DAY = 86_400_000;

const toDay = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);
const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * MS_PER_DAY);
const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / MS_PER_DAY);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const serverMessage = (err: any, fallback: string) => err?.response?.data?.message ?? fallback;

/**
 * Ids that belong on the timeline by default: anything with entered dates, plus every ancestor of
 * such an item so the tree stays connected.
 *
 * Exported because the toolbar (owned by the page) has to label its toggle with the same count
 * the chart hides, and re-deriving the ancestor walk in two places is how those two numbers end
 * up disagreeing.
 */
export function scheduledItemIds(items: PlanItemRow[]): Set<string> {
  const keep = new Set<string>();
  const parentOf = new Map(items.map((i) => [i.id, i.parentId]));
  for (const item of items) {
    if (!item.startDate && !item.endDate) continue;
    keep.add(item.id);
    let cursor = parentOf.get(item.id) ?? null;
    const guard = new Set<string>();
    while (cursor && !guard.has(cursor)) {
      guard.add(cursor);
      keep.add(cursor);
      cursor = parentOf.get(cursor) ?? null;
    }
  }
  return keep;
}

interface Props {
  data: PlanTimelineData;
  dependencies: PlanDependencyRow[];
  zoom: TimelineZoom;
  /** False for viewers without `plan:write` — bars render but never drag. */
  canEdit: boolean;
  onOpenItem?: (id: string) => void;
  showCriticalOnly?: boolean;
  showBaseline?: boolean;
  /** When false (the default), items nobody has scheduled are hidden. See the note in `visible`. */
  showUnscheduled?: boolean;
}

export function PlanTimeline({
  data,
  dependencies,
  zoom,
  canEdit,
  onOpenItem,
  showCriticalOnly,
  showBaseline,
  showUnscheduled
}: Props) {
  const queryClient = useQueryClient();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ id: string; mode: "move" | "start" | "end"; dxDays: number } | null>(null);

  const dayWidth = DAY_WIDTH[zoom];

  /* --- The visible rows: tree order minus anything inside a collapsed parent ------------- */

  /**
   * Which items are scheduled enough to belong on a timeline by default.
   *
   * WHY THIS FILTER EXISTS AT ALL: a workspace that turns planning on for the first time has
   * hundreds of tickets and nothing scheduled. Without it, the timeline opens as a wall of
   * identical one-day stubs stacked on today, and the four bars that DO carry a plan are
   * invisible in the noise — the first impression of the feature is that it is broken. Hiding
   * unscheduled work by default (with a toggle to show it) makes the first view show exactly the
   * plan that exists.
   *
   * An unscheduled item is KEPT when a descendant is scheduled, so an epic never vanishes out
   * from under its own children and the tree stays connected.
   */
  const scheduledIds = useMemo(() => scheduledItemIds(data.items), [data.items]);

  const visible = useMemo(() => {
    const hidden = new Set<string>();
    const rows: PlanItemRow[] = [];
    for (const item of data.items) {
      // A collapsed ancestor hides the whole subtree, not just direct children — walking the
      // parent chain here is what makes collapsing an epic actually collapse it.
      if (item.parentId && hidden.has(item.parentId)) {
        hidden.add(item.id);
        continue;
      }
      if (collapsed.has(item.id)) hidden.add(item.id);
      if (showCriticalOnly && !item.isCritical) continue;
      if (!showUnscheduled && !scheduledIds.has(item.id)) continue;
      rows.push(item);
    }
    return rows;
  }, [data.items, collapsed, showCriticalOnly, showUnscheduled, scheduledIds]);

  const hasChildren = useMemo(() => {
    const set = new Set<string>();
    for (const item of data.items) if (item.parentId) set.add(item.parentId);
    return set;
  }, [data.items]);

  /* --- The date axis --------------------------------------------------------------------- */

  const { axisStart, totalDays } = useMemo(() => {
    if (data.items.length === 0) {
      const today = toDay(new Date().toISOString());
      return { axisStart: addDays(today, -7), totalDays: 60 };
    }
    let min = toDay(data.items[0].resolvedStart);
    let max = toDay(data.items[0].resolvedEnd);
    for (const item of data.items) {
      const s = toDay(item.resolvedStart);
      const e = toDay(item.resolvedEnd);
      if (s < min) min = s;
      if (e > max) max = e;
      // Baselines can sit outside the current schedule; the axis has to cover them or a slipped
      // bar renders with its own baseline off-screen, which is exactly the comparison being made.
      if (item.baselineStart && toDay(item.baselineStart) < min) min = toDay(item.baselineStart);
      if (item.baselineEnd && toDay(item.baselineEnd) > max) max = toDay(item.baselineEnd);
    }
    const pad = zoom === "day" ? 3 : zoom === "week" ? 7 : 14;
    const start = addDays(min, -pad);
    return { axisStart: start, totalDays: Math.max(30, daysBetween(start, max) + pad * 2) };
  }, [data.items, zoom]);

  const chartWidth = totalDays * dayWidth;
  const xFor = useCallback((iso: string) => daysBetween(axisStart, toDay(iso)) * dayWidth, [axisStart, dayWidth]);
  const rowIndex = useMemo(() => new Map(visible.map((item, i) => [item.id, i])), [visible]);

  /* --- Scroll to today on first paint ---------------------------------------------------- */

  const today = dayKey(toDay(new Date().toISOString()));
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Land today about a third in, not hard left: the useful question on opening a plan is
    // "what is happening now and what is next", and both need to be on screen.
    el.scrollLeft = Math.max(0, xFor(today) - el.clientWidth / 3);
    // Only on mount and on zoom change — re-running on every data refetch would yank the
    // viewport back while someone is reading a different part of the plan.
  }, [zoom]); // eslint-disable-line react-hooks/exhaustive-deps

  /* --- Dragging -------------------------------------------------------------------------- */

  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) => planApi.updateItem(id, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["plan"] });
      queryClient.invalidateQueries({ queryKey: ["tickets"] });
    },
    onError: (err: any) => toast.error("Could not move that item", { description: serverMessage(err, "Try again.") })
  });

  const beginDrag = (event: React.PointerEvent, item: PlanItemRow, mode: "move" | "start" | "end") => {
    if (!canEdit) return;
    event.preventDefault();
    event.stopPropagation();
    const originX = event.clientX;
    const startIso = item.startDate ?? item.resolvedStart;
    const endIso = item.endDate ?? item.resolvedEnd;

    const onMove = (e: PointerEvent) => {
      setDrag({ id: item.id, mode, dxDays: Math.round((e.clientX - originX) / dayWidth) });
    };
    const onUp = (e: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const delta = Math.round((e.clientX - originX) / dayWidth);
      setDrag(null);
      if (delta === 0) return;

      const patch: Record<string, unknown> = {};
      if (mode === "move") {
        patch.startDate = dayKey(addDays(toDay(startIso), delta));
        patch.endDate = dayKey(addDays(toDay(endIso), delta));
      } else if (mode === "start") {
        const next = addDays(toDay(startIso), delta);
        // Refuse to drag a start past its own end rather than silently swapping them — a swap
        // guesses which of the two the person meant, and guessing wrong writes a plan nobody
        // asked for. The server enforces the same rule.
        if (next > toDay(endIso)) return;
        patch.startDate = dayKey(next);
      } else {
        const next = addDays(toDay(endIso), delta);
        if (next < toDay(startIso)) return;
        patch.endDate = dayKey(next);
      }
      update.mutate({ id: item.id, patch });
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  /** Where a bar should appear right now, including any in-flight drag offset. */
  const barRect = (item: PlanItemRow) => {
    const active = drag?.id === item.id ? drag : null;
    const shiftStart = active && (active.mode === "move" || active.mode === "start") ? active.dxDays : 0;
    const shiftEnd = active && (active.mode === "move" || active.mode === "end") ? active.dxDays : 0;
    const x = xFor(item.resolvedStart) + shiftStart * dayWidth;
    const right = xFor(item.resolvedEnd) + dayWidth + shiftEnd * dayWidth;
    return { x, width: Math.max(dayWidth * 0.6, right - x) };
  };

  /* --- Axis ticks ------------------------------------------------------------------------ */

  const ticks = useMemo(() => {
    const out: Array<{ x: number; label: string; major: boolean }> = [];
    for (let i = 0; i <= totalDays; i++) {
      const day = addDays(axisStart, i);
      const dow = day.getUTCDay();
      const dom = day.getUTCDate();
      if (zoom === "day") {
        out.push({ x: i * dayWidth, label: `${dom}`, major: dow === 1 });
      } else if (zoom === "week") {
        if (dow === 1) out.push({ x: i * dayWidth, label: `${dom} ${MONTHS[day.getUTCMonth()]}`, major: dom <= 7 });
      } else if (dom === 1) {
        out.push({ x: i * dayWidth, label: `${MONTHS[day.getUTCMonth()]} ${String(day.getUTCFullYear()).slice(2)}`, major: true });
      }
    }
    return out;
  }, [axisStart, totalDays, dayWidth, zoom]);

  /** Non-working-day bands, so a weekend reads as a weekend and not as a suspiciously idle gap. */
  const offDays = useMemo(() => {
    if (zoom === "month") return []; // sub-pixel at this scale; drawing them would just be noise
    const working = new Set(data.workingDays);
    const bands: number[] = [];
    for (let i = 0; i <= totalDays; i++) {
      if (!working.has(addDays(axisStart, i).getUTCDay())) bands.push(i * dayWidth);
    }
    return bands;
  }, [axisStart, totalDays, dayWidth, zoom, data.workingDays]);

  const chartHeight = Math.max(visible.length * ROW_HEIGHT, ROW_HEIGHT);
  const todayX = xFor(today) + dayWidth / 2;

  // Two different empty states, because they need two different things from the reader. "No work
  // items at all" is a data problem; "items exist but none are scheduled" is the normal state of
  // a workspace that just turned planning on, and the useful response is to say where dates come
  // from rather than implying something is wrong.
  if (data.items.length === 0 || visible.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border p-10 text-center">
        <Flag className="mx-auto h-8 w-8 text-muted-foreground" />
        <p className="mt-3 text-sm font-medium">
          {data.items.length === 0 ? "No work items here yet" : "Nothing is scheduled yet"}
        </p>
        <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
          {data.items.length === 0
            ? "Create a ticket in this project and it becomes a work item you can schedule."
            : `Open any of the ${data.items.length} work items here, go to its Plan tab, and give it start and end dates — it appears on this timeline straight away.`}
        </p>
      </div>
    );
  }

  return (
    <>
      {/* Desktop/laptop: the real chart. */}
      <div className="hidden overflow-hidden rounded-xl border border-border bg-card lg:block">
        <div className="flex">
          {/* Tree pane — sticky, never scrolls horizontally with the chart. */}
          <div className="shrink-0 border-r border-border" style={{ width: TREE_WIDTH }}>
            <div
              className="flex items-end border-b border-border bg-muted/40 px-3 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
              style={{ height: HEADER_HEIGHT }}
            >
              Work item
            </div>
            <div>
              {visible.map((item) => (
                <div
                  key={item.id}
                  className={cn(
                    "flex items-center gap-1 border-b border-border/50 px-2 text-sm",
                    item.isCritical && !showCriticalOnly && "bg-destructive/[0.04]"
                  )}
                  style={{ height: ROW_HEIGHT, paddingLeft: 8 + item.depth * 14 }}
                >
                  {hasChildren.has(item.id) ? (
                    <button
                      type="button"
                      aria-label={collapsed.has(item.id) ? `Expand ${item.key}` : `Collapse ${item.key}`}
                      className="rounded p-0.5 text-muted-foreground hover:bg-muted"
                      onClick={() =>
                        setCollapsed((current) => {
                          const next = new Set(current);
                          if (next.has(item.id)) next.delete(item.id);
                          else next.add(item.id);
                          return next;
                        })
                      }
                    >
                      {collapsed.has(item.id) ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                    </button>
                  ) : (
                    <span className="w-[18px]" />
                  )}
                  {item.isMilestone && <Diamond className="h-3 w-3 shrink-0 text-plan-today" />}
                  <button
                    type="button"
                    className="truncate text-left hover:underline"
                    onClick={() => onOpenItem?.(item.id)}
                    title={`${item.key} — ${item.title}`}
                  >
                    <span className="font-mono text-[11px] text-muted-foreground">{item.key}</span>{" "}
                    <span className={cn(item.statusCategory === "DONE" && "text-muted-foreground line-through")}>{item.title}</span>
                  </button>
                  {item.violations.length > 0 && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <AlertTriangle className="ml-auto h-3.5 w-3.5 shrink-0 text-warning" />
                      </TooltipTrigger>
                      <TooltipContent className="max-w-sm">
                        {item.violations.map((v) => (
                          <p key={v.dependencyId} className="text-xs">
                            {v.message}
                          </p>
                        ))}
                      </TooltipContent>
                    </Tooltip>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Chart pane — owns its own horizontal scroll. The page must never scroll sideways;
              see the `body { overflow-x: clip }` note in index.css. */}
          <div ref={scrollRef} className="min-w-0 flex-1 overflow-x-auto">
            <div style={{ width: chartWidth }}>
              {/* Axis */}
              <svg width={chartWidth} height={HEADER_HEIGHT} className="block border-b border-border bg-muted/40">
                {ticks.map((tick, i) => (
                  <g key={i}>
                    <line
                      x1={tick.x}
                      x2={tick.x}
                      y1={tick.major ? 12 : 26}
                      y2={HEADER_HEIGHT}
                      stroke="hsl(var(--plan-grid))"
                      strokeWidth={tick.major ? 1 : 0.5}
                    />
                    <text
                      x={tick.x + 3}
                      y={tick.major ? 22 : 36}
                      fontSize={tick.major ? 11 : 9}
                      fill="hsl(var(--muted-foreground))"
                    >
                      {tick.label}
                    </text>
                  </g>
                ))}
              </svg>

              {/* Rows */}
              <svg width={chartWidth} height={chartHeight} className="block">
                {offDays.map((x, i) => (
                  <rect key={`off-${i}`} x={x} y={0} width={dayWidth} height={chartHeight} fill="hsl(var(--plan-lane-alt))" opacity={0.6} />
                ))}
                {visible.map((item, i) => (
                  <rect
                    key={`lane-${item.id}`}
                    x={0}
                    y={i * ROW_HEIGHT}
                    width={chartWidth}
                    height={ROW_HEIGHT}
                    fill={i % 2 === 0 ? "hsl(var(--plan-lane))" : "transparent"}
                    opacity={0.5}
                  />
                ))}
                {ticks.filter((t) => t.major).map((tick, i) => (
                  <line key={`grid-${i}`} x1={tick.x} x2={tick.x} y1={0} y2={chartHeight} stroke="hsl(var(--plan-grid))" strokeWidth={0.5} />
                ))}

                {/* Dependency arrows, drawn UNDER the bars so a bar is never obscured by a line
                    crossing it. */}
                <g>
                  {dependencies.map((dep) => {
                    const fromRow = rowIndex.get(dep.fromId);
                    const toRow = rowIndex.get(dep.toId);
                    const from = data.items.find((i) => i.id === dep.fromId);
                    const to = data.items.find((i) => i.id === dep.toId);
                    if (fromRow === undefined || toRow === undefined || !from || !to) return null;

                    const startsAtSource = dep.type === "START_TO_START" || dep.type === "START_TO_FINISH";
                    const x1 = startsAtSource ? xFor(from.resolvedStart) : xFor(from.resolvedEnd) + dayWidth;
                    const y1 = fromRow * ROW_HEIGHT + ROW_HEIGHT / 2;
                    const endsAtTarget = dep.type === "FINISH_TO_FINISH" || dep.type === "START_TO_FINISH";
                    const x2 = endsAtTarget ? xFor(to.resolvedEnd) + dayWidth : xFor(to.resolvedStart);
                    const y2 = toRow * ROW_HEIGHT + ROW_HEIGHT / 2;
                    // Orthogonal elbow rather than a bezier: with 50 dependencies on screen,
                    // curves become an unreadable tangle while right angles stay traceable.
                    const mid = x2 - 8 > x1 + 8 ? (x1 + x2) / 2 : x1 + 12;
                    const critical = from.isCritical && to.isCritical;
                    return (
                      <g key={dep.id} opacity={critical ? 0.9 : 0.45}>
                        <path
                          d={`M ${x1} ${y1} H ${mid} V ${y2} H ${x2}`}
                          fill="none"
                          stroke={critical ? "hsl(var(--plan-critical))" : "hsl(var(--plan-dependency))"}
                          strokeWidth={critical ? 1.5 : 1}
                        />
                        <path
                          d={`M ${x2} ${y2} l -5 -3.5 v 7 z`}
                          fill={critical ? "hsl(var(--plan-critical))" : "hsl(var(--plan-dependency))"}
                        />
                      </g>
                    );
                  })}
                </g>

                {/* Bars */}
                {visible.map((item, i) => {
                  const { x, width } = barRect(item);
                  const y = i * ROW_HEIGHT + (ROW_HEIGHT - BAR_HEIGHT) / 2;
                  const isParent = hasChildren.has(item.id);
                  const fill = item.isCritical
                    ? "hsl(var(--plan-critical))"
                    : isParent
                      ? "hsl(var(--plan-bar-parent))"
                      : "hsl(var(--plan-bar))";

                  return (
                    <g key={item.id}>
                      {/* Baseline ghost: an OUTLINE, never a fill. It is a reference, not a
                          value — filling it would make every bar look doubled. */}
                      {showBaseline && item.baselineStart && item.baselineEnd && (
                        <rect
                          x={xFor(item.baselineStart)}
                          y={y + BAR_HEIGHT + 1}
                          width={Math.max(2, xFor(item.baselineEnd) + dayWidth - xFor(item.baselineStart))}
                          height={3}
                          fill="none"
                          stroke="hsl(var(--plan-baseline))"
                          strokeWidth={2}
                          strokeDasharray="3 2"
                        />
                      )}

                      {item.isMilestone ? (
                        <g
                          transform={`translate(${x + dayWidth / 2}, ${y + BAR_HEIGHT / 2})`}
                          className={canEdit ? "cursor-grab" : "cursor-pointer"}
                          onPointerDown={(e) => beginDrag(e, item, "move")}
                          onClick={() => onOpenItem?.(item.id)}
                        >
                          <rect
                            x={-7}
                            y={-7}
                            width={14}
                            height={14}
                            transform="rotate(45)"
                            fill={item.isCritical ? "hsl(var(--plan-critical))" : "hsl(var(--plan-today))"}
                          />
                        </g>
                      ) : (
                        <g
                          className={canEdit ? "cursor-grab" : "cursor-pointer"}
                          onClick={() => onOpenItem?.(item.id)}
                        >
                          <rect
                            x={x}
                            y={y}
                            width={width}
                            height={BAR_HEIGHT}
                            rx={4}
                            fill={fill}
                            // An inferred bar is hatched, not solid: the timeline must never let
                            // a date the system guessed look like one a person committed to.
                            opacity={item.isInferred ? 0.35 : 1}
                            stroke={item.isInferred ? fill : "none"}
                            strokeDasharray={item.isInferred ? "4 3" : undefined}
                            onPointerDown={(e) => beginDrag(e, item, "move")}
                          />
                          {/* Progress fill, clipped to the bar. */}
                          {item.effectiveProgressPct > 0 && !item.isInferred && (
                            <rect
                              x={x}
                              y={y}
                              width={(width * Math.min(100, item.effectiveProgressPct)) / 100}
                              height={BAR_HEIGHT}
                              rx={4}
                              fill="hsl(var(--plan-bar-fg))"
                              opacity={0.35}
                              pointerEvents="none"
                            />
                          )}
                          {canEdit && !item.isInferred && (
                            <>
                              <rect
                                x={x - 2}
                                y={y}
                                width={6}
                                height={BAR_HEIGHT}
                                fill="transparent"
                                className="cursor-ew-resize"
                                onPointerDown={(e) => beginDrag(e, item, "start")}
                              />
                              <rect
                                x={x + width - 4}
                                y={y}
                                width={6}
                                height={BAR_HEIGHT}
                                fill="transparent"
                                className="cursor-ew-resize"
                                onPointerDown={(e) => beginDrag(e, item, "end")}
                              />
                            </>
                          )}
                        </g>
                      )}

                      {/* Label to the right of the bar, at day zoom only — at week/month there
                          is no room and overlapping text is worse than none. */}
                      {zoom === "day" && (
                        <text x={x + width + 6} y={y + BAR_HEIGHT - 5} fontSize={10} fill="hsl(var(--muted-foreground))">
                          {item.effectiveProgressPct > 0 ? `${item.effectiveProgressPct}%` : ""}
                          {item.slipDays !== null && item.slipDays > 0 ? `  +${item.slipDays}d` : ""}
                        </text>
                      )}
                    </g>
                  );
                })}

                {/* Today marker, drawn last so it is never hidden behind a bar. */}
                <line x1={todayX} x2={todayX} y1={0} y2={chartHeight} stroke="hsl(var(--plan-today))" strokeWidth={1.5} />
              </svg>
            </div>
          </div>
        </div>
      </div>

      {/* Below lg: the same plan as a list. Not a shrunken chart — a 3-month Gantt on a phone is
          not a small Gantt, it is an unusable one. */}
      <div className="grid gap-2 lg:hidden">
        {visible.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onOpenItem?.(item.id)}
            className={cn(
              "grid gap-1 rounded-lg border border-border bg-card p-3 text-left",
              item.isCritical && "border-l-2 border-l-destructive"
            )}
            style={{ marginLeft: Math.min(item.depth, 3) * 12 }}
          >
            <div className="flex flex-wrap items-center gap-1.5">
              {item.isMilestone && <Diamond className="h-3 w-3 text-plan-today" />}
              <span className="font-mono text-[11px] text-muted-foreground">{item.key}</span>
              <span className="truncate text-sm font-medium">{item.title}</span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span>
                {item.resolvedStart} → {item.resolvedEnd}
              </span>
              {item.isInferred && <Badge variant="outline">Not scheduled</Badge>}
              {item.isCritical && <Badge variant="destructive">Critical</Badge>}
              {item.slipDays !== null && item.slipDays > 0 && <Badge variant="warning">+{item.slipDays}d</Badge>}
              {item.effectiveProgressPct > 0 && <span>{item.effectiveProgressPct}%</span>}
            </div>
          </button>
        ))}
      </div>
    </>
  );
}

/** Legend + zoom control, exported so the page owns the toolbar layout while the meaning of each
 *  mark stays defined next to the component that draws it. */
export function TimelineLegend({
  zoom,
  onZoom,
  showBaseline,
  onToggleBaseline,
  showCriticalOnly,
  onToggleCritical,
  showUnscheduled,
  onToggleUnscheduled,
  unscheduledCount,
  violationCount
}: {
  zoom: TimelineZoom;
  onZoom: (z: TimelineZoom) => void;
  showBaseline: boolean;
  onToggleBaseline: () => void;
  showCriticalOnly: boolean;
  onToggleCritical: () => void;
  showUnscheduled?: boolean;
  onToggleUnscheduled?: () => void;
  unscheduledCount?: number;
  violationCount: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex overflow-hidden rounded-lg border border-border">
        {(["day", "week", "month"] as TimelineZoom[]).map((z) => (
          <button
            key={z}
            type="button"
            onClick={() => onZoom(z)}
            className={cn(
              "px-2.5 py-1 text-xs capitalize transition-colors",
              zoom === z ? "bg-primary text-primary-foreground" : "hover:bg-muted"
            )}
          >
            {z}
          </button>
        ))}
      </div>

      <Button size="sm" variant={showBaseline ? "default" : "outline"} onClick={onToggleBaseline}>
        <GripVertical className="mr-1.5 h-3.5 w-3.5" />
        Baseline
      </Button>
      <Button size="sm" variant={showCriticalOnly ? "default" : "outline"} onClick={onToggleCritical}>
        <Link2 className="mr-1.5 h-3.5 w-3.5" />
        Critical path
      </Button>

      {onToggleUnscheduled && (unscheduledCount ?? 0) > 0 && (
        <Button size="sm" variant={showUnscheduled ? "default" : "outline"} onClick={onToggleUnscheduled}>
          <Flag className="mr-1.5 h-3.5 w-3.5" />
          {showUnscheduled ? "Hide" : "Show"} {unscheduledCount} unscheduled
        </Button>
      )}

      {violationCount > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="warning" className="gap-1">
              <AlertTriangle className="h-3 w-3" />
              {violationCount} scheduling conflict{violationCount === 1 ? "" : "s"}
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm">
            An item is dated earlier than one of its dependencies allows. The dates you entered are shown as-is —
            nothing has been moved for you.
          </TooltipContent>
        </Tooltip>
      )}

      <div className="ml-auto hidden items-center gap-3 text-[11px] text-muted-foreground xl:flex">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2.5 w-4 rounded-sm bg-plan-bar" /> Task
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2.5 w-4 rounded-sm bg-plan-bar-parent" /> Summary
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2.5 w-4 rounded-sm bg-plan-critical" /> Critical
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2.5 w-4 rounded-sm border border-dashed border-plan-bar bg-plan-bar/30" /> Not scheduled
        </span>
      </div>
    </div>
  );
}
