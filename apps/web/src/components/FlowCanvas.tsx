/**
 * The Workflow Studio's canvas — an n8n-style node graph: a trigger on the left, steps flowing
 * left to right, curved connectors between output and input handles, drag to move, wheel to zoom.
 *
 * WHY POSITIONS LIVE IN EACH STEP'S `config` AS `{x, y}`: that column is already free-form per
 * step kind, so the canvas needs no migration. A step with no position is auto-laid-out on open,
 * so every flow built before the canvas existed opens as a sensible graph rather than a pile at
 * the origin.
 *
 * WHY DRAGGING A NODE REORDERS RATHER THAN STORING AN EDGE: the steps ARE a sequence, and the
 * authority calculation depends on their order (taint propagates forward, so triage-then-assign
 * and assign-then-triage are different flows). Storing edges as well would give two sources of
 * truth for one fact, and the first disagreement between them is a flow nobody can read. So the
 * canvas is a VIEW of the sequence: drag a node left past another and their order swaps, and the
 * connectors redraw. This is the one place the n8n metaphor bends to the engine — n8n edges are
 * free, ours are the order — and it is deliberate.
 *
 * WHY A BRANCH DROPS AN ARM TO A TERMINUS RATHER THAN FORKING INTO TWO LANES: a condition that
 * does not match STOPS the run — that is what the dispatcher does, and the simulation says the
 * same. A second lane of steps would draw a path this engine cannot take. The dashed arm down to
 * "flow stops" says exactly what happens instead.
 *
 * WHY CURVED CONNECTORS HERE (the vertical version used elbows): a horizontal left-to-right graph
 * is the n8n convention, and a horizontal cubic bezier between two handles is the connector people
 * recognise from it — it reads as "output flows into input" at a glance. With one linear spine and
 * a single branch arm there is no tangle for a curve to become, which was the elbow's whole reason.
 *
 * WHY IT IS HAND-BUILT SVG: every canvas library ships its own design system, assumes it owns the
 * data layer, or is unmaintained — and the genuinely hard part (the authority arithmetic) is
 * already server-side, leaving `x = f(order)`.
 *
 * WHO renders this: `pages/Studio.tsx`, on the Canvas tab, at `lg` and above.
 */
import { GitBranch, Hand, Play, Sparkles, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../lib/utils";
import type { FlowRow, FlowStepKind } from "../services/api";

const NODE_W = 208;
const NODE_H = 84;
/** Horizontal gap between auto-laid-out nodes — wide enough that a connector reads as a connector. */
const GAP_X = 268;
/** The lane every auto-laid-out node sits on until it is dragged. */
const LANE_Y = 150;
/** Left inset for the first step, leaving room for the trigger node. */
const FIRST_X = 150;

const KIND_META: Record<
  FlowStepKind,
  { label: string; icon: typeof Zap; ring: string; chip: string }
> = {
  CAPABILITY: { label: "AI step", icon: Sparkles, ring: "border-primary/50", chip: "bg-primary/15 text-primary" },
  ACTION: { label: "Action", icon: Zap, ring: "border-emerald-500/50", chip: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
  HUMAN_GATE: { label: "Ask a person", icon: Hand, ring: "border-amber-500/60", chip: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
  BRANCH: { label: "Only if", icon: GitBranch, ring: "border-sky-500/50", chip: "bg-sky-500/15 text-sky-600 dark:text-sky-400" }
};

export interface CanvasStep {
  id: string;
  order: number;
  kind: FlowStepKind;
  title: string | null;
  config: Record<string, unknown>;
}

interface Point {
  x: number;
  y: number;
}

/** A step's stored position, or the one it should get if it has none yet. Auto-layout is a single
 *  left-to-right lane: a flow is a sequence, and pretending otherwise before the user has moved
 *  anything would be inventing a shape they did not choose. */
function positionOf(step: CanvasStep, index: number): Point {
  const x = typeof step.config?.x === "number" ? (step.config.x as number) : FIRST_X + index * GAP_X;
  const y = typeof step.config?.y === "number" ? (step.config.y as number) : LANE_Y;
  return { x, y };
}

/** A horizontal cubic bezier from an output handle (right edge) to an input handle (left edge) —
 *  the n8n connector. Control points are pushed out horizontally by half the gap so the curve
 *  leaves and arrives flat, however the two nodes are stacked. */
function bezier(from: Point, to: Point): string {
  const sx = from.x + NODE_W;
  const sy = from.y + NODE_H / 2;
  const ex = to.x;
  const ey = to.y + NODE_H / 2;
  const dx = Math.max(40, Math.abs(ex - sx) * 0.5);
  return `M ${sx} ${sy} C ${sx + dx} ${sy}, ${ex - dx} ${ey}, ${ex} ${ey}`;
}

export function FlowCanvas({
  authoritySteps,
  steps,
  readOnly,
  selectedId,
  trigger,
  onSelect,
  onMove,
  onReorder
}: Readonly<{
  /** What each step resolves to, so a node states its own authority. Empty while a new flow is unsaved. */
  authoritySteps: FlowRow["authority"]["steps"];
  steps: CanvasStep[];
  readOnly: boolean;
  selectedId: string | null;
  /** The flow's trigger, rendered as the start node — n8n always begins with one. */
  trigger?: { label: string };
  onSelect: (id: string) => void;
  /** Persisted into the step's own config by the caller. */
  onMove: (id: string, at: Point) => void;
  /** Dragging a node left/right past another reorders the sequence — see the header. */
  onReorder: (id: string, newIndex: number) => void;
}>) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const drag = useRef<{ id: string; offset: Point; moved: boolean } | null>(null);
  const panning = useRef<{ from: Point; origin: Point } | null>(null);

  const ordered = useMemo(() => [...steps].sort((a, b) => a.order - b.order), [steps]);
  const positions = useMemo(() => ordered.map((s, i) => ({ step: s, at: positionOf(s, i) })), [ordered]);

  const toCanvas = useCallback(
    (clientX: number, clientY: number): Point => {
      const rect = surfaceRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return { x: (clientX - rect.left - pan.x) / zoom, y: (clientY - rect.top - pan.y) / zoom };
    },
    [pan, zoom]
  );

  useEffect(() => {
    if (readOnly) return undefined;

    const move = (e: PointerEvent) => {
      if (panning.current) {
        setPan({ x: panning.current.origin.x + (e.clientX - panning.current.from.x), y: panning.current.origin.y + (e.clientY - panning.current.from.y) });
        return;
      }
      if (!drag.current) return;
      const at = toCanvas(e.clientX, e.clientY);
      drag.current.moved = true;
      onMove(drag.current.id, { x: Math.round(at.x - drag.current.offset.x), y: Math.round(at.y - drag.current.offset.y) });
    };

    const up = () => {
      // On release, the node's HORIZONTAL position decides where it sits in the SEQUENCE — the
      // "connections are implied by order" decision made tangible in a left-to-right graph: you
      // move a box, and what changes is what runs when.
      if (drag.current?.moved) {
        const id = drag.current.id;
        const withPositions = ordered.map((s, i) => ({ id: s.id, x: positionOf(s, i).x }));
        const sorted = [...withPositions].sort((a, b) => a.x - b.x);
        const newIndex = sorted.findIndex((s) => s.id === id);
        const oldIndex = ordered.findIndex((s) => s.id === id);
        if (newIndex >= 0 && newIndex !== oldIndex) onReorder(id, newIndex);
      }
      drag.current = null;
      panning.current = null;
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [ordered, onMove, onReorder, readOnly, toCanvas]);

  const width = Math.max(1200, positions.reduce((max, p) => Math.max(max, p.at.x + NODE_W + 120), 0));
  const height = Math.max(460, positions.reduce((max, p) => Math.max(max, p.at.y + NODE_H + 140), 0));

  const first = positions[0];
  const triggerNode = { x: 24, y: (first?.at.y ?? LANE_Y) + NODE_H / 2 - 28 };

  return (
    <div className="relative overflow-hidden rounded-lg border bg-muted/20 bg-[radial-gradient(circle,hsl(var(--muted-foreground)/0.18)_1px,transparent_1px)] [background-size:18px_18px]">
      {/* Zoom controls, mirroring n8n's corner rail. */}
      <div className="absolute right-3 top-3 z-10 flex flex-col gap-1 rounded-md border bg-background/90 p-1 shadow-sm backdrop-blur">
        <button type="button" className="grid h-7 w-7 place-items-center rounded text-sm hover:bg-muted" onClick={() => setZoom((z) => Math.min(1.6, +(z + 0.15).toFixed(2)))} aria-label="Zoom in">
          +
        </button>
        <button type="button" className="grid h-7 w-7 place-items-center rounded text-sm hover:bg-muted" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.15).toFixed(2)))} aria-label="Zoom out">
          −
        </button>
        <button
          type="button"
          className="grid h-7 w-7 place-items-center rounded text-[10px] hover:bg-muted"
          onClick={() => {
            setZoom(1);
            setPan({ x: 0, y: 0 });
          }}
          aria-label="Reset view"
        >
          1:1
        </button>
      </div>

      <div
        ref={surfaceRef}
        className="relative h-[520px] w-full cursor-grab overflow-hidden active:cursor-grabbing"
        onPointerDown={(e) => {
          // Panning starts only on the background — a pointer-down on a node is a drag of that node.
          if (e.target === e.currentTarget) panning.current = { from: { x: e.clientX, y: e.clientY }, origin: pan };
        }}
        onWheel={(e) => {
          // Wheel zooms toward the cursor, the n8n gesture. Non-passive via React's synthetic
          // handler; the small step keeps it controllable on a trackpad.
          const delta = e.deltaY > 0 ? -0.1 : 0.1;
          setZoom((z) => Math.min(1.6, Math.max(0.5, +(z + delta).toFixed(2))));
        }}
      >
        <div
          className="absolute origin-top-left"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, width, height }}
        >
          <svg className="pointer-events-none absolute inset-0 h-full w-full" width={width} height={height} aria-hidden>
            <defs>
              <marker id="flow-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto">
                <path d="M 0 0 L 10 5 L 0 10 z" className="fill-muted-foreground/70" />
              </marker>
            </defs>

            {/* Trigger → first step. */}
            {first && (
              <path
                d={bezier({ x: triggerNode.x - NODE_W + 56, y: triggerNode.y - NODE_H / 2 + 28 }, first.at)}
                fill="none"
                className="stroke-muted-foreground/50"
                strokeWidth={2}
                markerEnd="url(#flow-arrow)"
              />
            )}

            {/* Spine: step → next step. */}
            {positions.slice(0, -1).map((p, i) => (
              <path
                key={p.step.id}
                d={bezier(p.at, positions[i + 1].at)}
                fill="none"
                className="stroke-muted-foreground/50"
                strokeWidth={2}
                markerEnd="url(#flow-arrow)"
              />
            ))}

            {/* A branch's "does not match" arm drops down to a terminus — the run stops, so the
                honest picture is an arm to nowhere rather than a second lane of steps. */}
            {positions
              .filter(({ step }) => step.kind === "BRANCH")
              .map(({ step, at }) => {
                const sx = at.x + NODE_W / 2;
                const sy = at.y + NODE_H;
                const ey = at.y + NODE_H + 58;
                return (
                  <path
                    key={`no-${step.id}`}
                    d={`M ${sx} ${sy} C ${sx} ${sy + 30}, ${sx} ${ey - 30}, ${sx} ${ey}`}
                    fill="none"
                    className="stroke-muted-foreground/35"
                    strokeWidth={2}
                    strokeDasharray="4 3"
                    markerEnd="url(#flow-arrow)"
                  />
                );
              })}
          </svg>

          {/* Branch terminus chips. */}
          {positions
            .filter(({ step }) => step.kind === "BRANCH")
            .map(({ step, at }) => (
              <span
                key={`stop-${step.id}`}
                style={{ left: at.x + NODE_W / 2 - 62, top: at.y + NODE_H + 60 }}
                className="absolute whitespace-nowrap rounded-full border border-dashed bg-muted/70 px-2 py-0.5 text-[10px] text-muted-foreground"
              >
                does not match — flow stops
              </span>
            ))}

          {/* The trigger start node. Not draggable and not selectable — the trigger is edited in the
              form, not on the canvas — but drawn so the graph reads like n8n: a thing that starts it. */}
          <div
            style={{ left: triggerNode.x, top: triggerNode.y, width: 56, height: 56 }}
            className="absolute grid place-items-center rounded-full border-2 border-primary/60 bg-primary/10 shadow-sm"
            title={trigger?.label ?? "Trigger"}
          >
            <Play className="h-5 w-5 fill-primary text-primary" aria-hidden />
            <span className="absolute -bottom-5 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] font-medium text-muted-foreground">
              {trigger?.label ?? "Trigger"}
            </span>
            {/* Output handle. */}
            <span className="absolute -right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 rounded-full border-2 border-primary/70 bg-background" />
          </div>

          {positions.map(({ step, at }) => {
            const meta = KIND_META[step.kind];
            const Icon = meta.icon;
            const authority = authoritySteps.find((s) => s.order === step.order);
            const selected = step.id === selectedId;
            return (
              <div
                key={step.id}
                role="button"
                tabIndex={0}
                onPointerDown={(e) => {
                  if (readOnly) return;
                  e.stopPropagation();
                  const p = toCanvas(e.clientX, e.clientY);
                  drag.current = { id: step.id, offset: { x: p.x - at.x, y: p.y - at.y }, moved: false };
                  onSelect(step.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") onSelect(step.id);
                }}
                style={{ left: at.x, top: at.y, width: NODE_W, minHeight: NODE_H }}
                className={cn(
                  "absolute rounded-xl border-2 bg-card shadow-sm transition-shadow hover:shadow-md",
                  meta.ring,
                  selected && "ring-2 ring-primary ring-offset-2 ring-offset-background",
                  !readOnly && "cursor-grab active:cursor-grabbing"
                )}
              >
                {/* Input handle (left) and output handle (right) — the n8n connection dots. */}
                <span className="absolute -left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 rounded-full border-2 border-muted-foreground/50 bg-background" aria-hidden />
                <span className="absolute -right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 rounded-full border-2 border-muted-foreground/50 bg-background" aria-hidden />

                <div className="flex items-start gap-2.5 p-2.5">
                  {/* Icon square, n8n-style. */}
                  <span className={cn("mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg", meta.chip)}>
                    <Icon className="h-4.5 w-4.5" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                      {meta.label}
                      <span className="ml-auto tabular-nums">{step.order}</span>
                    </div>
                    {/* The kind is the line above, so a node whose title WOULD be its kind states what
                        it is configured to do instead — "Action / Action" reads as broken. */}
                    <p className="mt-0.5 truncate text-sm font-semibold">{step.title ?? describeConfig(step)}</p>
                    {authority && step.kind === "CAPABILITY" && (
                      <p className={cn("mt-0.5 truncate text-[11px]", authority.clampedReason ? "text-warning-foreground" : "text-muted-foreground")}>
                        {authority.effectiveLevel}
                        {authority.clampedReason ? " · clamped" : ""}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** One line of what the step is configured to do — the difference between a shape and a rule. */
export function describeConfig(step: CanvasStep): string {
  const c = step.config ?? {};
  if (step.kind === "ACTION") {
    const action = typeof c.action === "string" ? c.action : null;
    if (!action) return "Not configured yet";
    if (action === "assign") return "Assigns it to somebody";
    if (action === "label") return "Adds a label";
    return "Notifies somebody";
  }
  if (step.kind === "BRANCH") {
    if (!c.field) return "Not configured yet";
    return `${String(c.field)} ${c.op === "is_not" ? "is not" : "is"} ${String(c.value ?? "")}`;
  }
  if (step.kind === "HUMAN_GATE") return c.approverId ? "Waits for approval" : "Nobody chosen yet";
  return "";
}
