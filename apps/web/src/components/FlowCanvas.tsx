/**
 * The Workflow Studio's canvas — drag the nodes, see the shape, keep the guarantees.
 *
 * WHY POSITIONS LIVE IN EACH STEP'S `config` AS `{x, y}`: that column is already free-form per step
 * kind, so a canvas needed no migration. A step with no position is auto-laid-out on open, which means
 * every flow built before the canvas existed opens as a sensible graph rather than a pile at the origin.
 *
 * WHY DRAGGING A CONNECTION REORDERS RATHER THAN STORING AN EDGE: the steps ARE a sequence, and the
 * authority calculation depends on their order (taint propagates forward, so triage-then-assign and
 * assign-then-triage are different flows). Storing edges as well would give two sources of truth for
 * one fact, and the first disagreement between them is a flow nobody can read. So the canvas is a VIEW
 * of the sequence: moving a node up past another swaps their order, and the connector redraws.
 *
 * WHY A BRANCH SHOWS AN ARM TO A TERMINUS RATHER THAN TWO COLUMNS OF STEPS: a condition that does not
 * match STOPS the run — that is what the dispatcher does, and the simulation says the same. Drawing a
 * second column of steps would show a path this engine cannot take, which is a prettier picture of a
 * flow that does not exist. The dashed arm says exactly what happens instead.
 *
 * WHY ORTHOGONAL ELBOWS AND NOT BEZIER CURVES: the timeline made this call already — curves become an
 * unreadable tangle once there are more than a handful, and a workflow is read to answer "what happens
 * after what", which a right angle answers better than a swoop.
 *
 * WHY IT IS HAND-BUILT SVG: the same argument the Gantt made. Every canvas library ships its own design
 * system, assumes it owns the data layer, or is unmaintained — and the genuinely hard part here (the
 * authority arithmetic) is already server-side, leaving `x = f(order)`.
 *
 * WHO renders this: `pages/Studio.tsx`, on the Canvas tab, at `lg` and above only.
 */
import { GitBranch, Hand, Sparkles, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../lib/utils";
import type { FlowRow, FlowStepKind } from "../services/api";

const NODE_W = 260;
const NODE_H = 96;
/** Vertical gap between auto-laid-out nodes. Wide enough that a connector is visibly a connector. */
const GAP_Y = 150;

const KIND_META: Record<FlowStepKind, { label: string; icon: typeof Zap; ring: string }> = {
  CAPABILITY: { label: "AI step", icon: Sparkles, ring: "border-primary/50" },
  ACTION: { label: "Action", icon: Zap, ring: "border-emerald-500/50" },
  HUMAN_GATE: { label: "Ask a person", icon: Hand, ring: "border-amber-500/60" },
  BRANCH: { label: "Only if", icon: GitBranch, ring: "border-sky-500/50" }
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
 *  column: a flow is a sequence, and pretending otherwise before the user has moved anything would be
 *  inventing a shape they did not choose. */
function positionOf(step: CanvasStep, index: number): Point {
  const x = typeof step.config?.x === "number" ? (step.config.x as number) : 80;
  const y = typeof step.config?.y === "number" ? (step.config.y as number) : 60 + index * GAP_Y;
  return { x, y };
}

/** An orthogonal connector from the bottom of `from` to the top of `to`. Three segments, so it reads
 *  as "down, across, down" however the two nodes are placed relative to each other. */
function elbow(from: Point, to: Point): string {
  const startX = from.x + NODE_W / 2;
  const startY = from.y + NODE_H;
  const endX = to.x + NODE_W / 2;
  const endY = to.y;
  const midY = startY + Math.max(24, (endY - startY) / 2);
  return `M ${startX} ${startY} L ${startX} ${midY} L ${endX} ${midY} L ${endX} ${endY}`;
}

export function FlowCanvas({
  authoritySteps,
  steps,
  readOnly,
  selectedId,
  onSelect,
  onMove,
  onReorder
}: Readonly<{
  /** What each step resolves to, so a node states its own authority. Empty while a new flow is unsaved. */
  authoritySteps: FlowRow["authority"]["steps"];
  steps: CanvasStep[];
  readOnly: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Persisted into the step's own config by the caller. */
  onMove: (id: string, at: Point) => void;
  /** Dragging a node above/below another reorders the sequence — see the header. */
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
      // On release, the node's vertical position decides where it sits in the SEQUENCE. This is the
      // whole "connections are implied by order" decision made tangible: you move a box, and what
      // changes is what runs when.
      if (drag.current?.moved) {
        const id = drag.current.id;
        const withPositions = ordered.map((s, i) => ({ id: s.id, y: positionOf(s, i).y }));
        const sorted = [...withPositions].sort((a, b) => a.y - b.y);
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

  const height = Math.max(420, positions.reduce((max, p) => Math.max(max, p.at.y + NODE_H + 60), 0));

  return (
    <div className="relative overflow-hidden rounded-lg border bg-[radial-gradient(circle,theme(colors.muted.DEFAULT)_1px,transparent_1px)] [background-size:16px_16px]">
      {/* Zoom controls, mirroring the reference's left rail. */}
      <div className="absolute left-3 top-3 z-10 flex flex-col gap-1 rounded-md border bg-background/90 p-1 shadow-sm backdrop-blur">
        <button type="button" className="grid h-7 w-7 place-items-center rounded text-sm hover:bg-muted" onClick={() => setZoom((z) => Math.min(1.6, z + 0.15))} aria-label="Zoom in">
          +
        </button>
        <button type="button" className="grid h-7 w-7 place-items-center rounded text-sm hover:bg-muted" onClick={() => setZoom((z) => Math.max(0.5, z - 0.15))} aria-label="Zoom out">
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
      >
        <div
          className="absolute origin-top-left"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, width: 1400, height }}
        >
          <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
            {positions.slice(0, -1).map((p, i) => (
              <path
                key={p.step.id}
                d={elbow(p.at, positions[i + 1].at)}
                fill="none"
                className="stroke-muted-foreground/40"
                strokeWidth={2}
                markerEnd="url(#flow-arrow)"
              />
            ))}
            {/* A branch's SECOND lane. The runtime stops the whole flow when a condition does not
                match, so the honest second lane is a short arm to a terminus — not a parallel column
                of steps, which would draw a path this engine cannot take. Drawing what the runtime
                actually does is the same rule the connectors follow: the picture may not claim more
                than the sequence can do. */}
            {positions
              .filter(({ step }) => step.kind === "BRANCH")
              .map(({ step, at }) => (
                <path
                  key={`no-${step.id}`}
                  d={`M ${at.x + NODE_W} ${at.y + NODE_H / 2} L ${at.x + NODE_W + 46} ${at.y + NODE_H / 2}`}
                  fill="none"
                  className="stroke-muted-foreground/30"
                  strokeWidth={2}
                  strokeDasharray="4 3"
                  markerEnd="url(#flow-arrow)"
                />
              ))}
            <defs>
              <marker id="flow-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto">
                <path d="M 0 0 L 10 5 L 0 10 z" className="fill-muted-foreground/60" />
              </marker>
            </defs>
          </svg>

          {positions
            .filter(({ step }) => step.kind === "BRANCH")
            .map(({ step, at }) => (
              <span
                key={`stop-${step.id}`}
                style={{ left: at.x + NODE_W + 52, top: at.y + NODE_H / 2 - 11 }}
                className="absolute whitespace-nowrap rounded-full border border-dashed bg-muted/60 px-2 py-0.5 text-[10px] text-muted-foreground"
              >
                does not match — flow stops
              </span>
            ))}

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
                  "absolute rounded-xl border-2 bg-card p-3 shadow-sm transition-shadow",
                  meta.ring,
                  selected && "ring-2 ring-primary ring-offset-2 ring-offset-background",
                  !readOnly && "cursor-grab active:cursor-grabbing"
                )}
              >
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Icon className="h-3 w-3" aria-hidden />
                  {meta.label}
                  <span className="ml-auto tabular-nums">{step.order}</span>
                </div>
                {/* The kind is already the line above, so a node whose title WOULD be its kind says
                    what it is configured to do instead — "Action / Action" is a card that reads as
                    broken. */}
                <p className="mt-1 truncate text-sm font-medium">{step.title ?? describeConfig(step)}</p>
                {authority && step.kind === "CAPABILITY" && (
                  <p className={cn("mt-1 text-[11px]", authority.clampedReason ? "text-warning-foreground" : "text-muted-foreground")}>
                    {authority.effectiveLevel}
                    {authority.clampedReason ? " · clamped" : ""}
                  </p>
                )}
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
