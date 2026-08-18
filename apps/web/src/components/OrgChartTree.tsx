/**
 * WHAT: an interactive, pan/zoomable reporting-line tree — replaces Team.tsx's original
 * indent-and-collapse `OrgChartRow` list with a real node-link diagram (d3-hierarchy for layout,
 * d3-zoom for pan/zoom, plain SVG for rendering — no canvas/WebGL needed at this data scale).
 * WHY d3-hierarchy over a full org-chart library: the data (`OrgChartNode[]`, `User.managerId`)
 * is already a plain tree — `d3.hierarchy` + `d3.tree()` is exactly the "compute x/y for each
 * node" layout engine this needs, without pulling in a heavier chart framework for what's
 * fundamentally still "boxes connected by lines."
 * HOW collapsing works: each node keeps its full subtree in React state (`collapsedIds`, a Set)
 * — collapsing hides children from the layout computation (not just visually), so the tree
 * genuinely reflows and re-centers rather than just hiding DOM nodes under an unchanged layout.
 */
import { hierarchy, tree, type HierarchyPointNode } from "d3-hierarchy";
import { linkVertical } from "d3-shape";
import { select } from "d3-selection";
// Side-effect import — augments d3-selection's Selection type with `.transition()`, used below
// for the smooth zoom/pan-to-reset animation. Never called directly, only needed for its types
// (d3-zoom's `.call(zoomBehavior.transform, ...)` doesn't need it) plus the runtime prototype
// patch `.transition()` itself relies on.
import "d3-transition";
import { zoom, zoomIdentity, type D3ZoomEvent } from "d3-zoom";
import { ChevronsDownUp, ChevronsUpDown, Crown, Maximize2, Minus, Plus, Shield, ShieldCheck, User, UserCog } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { OrgChartNode } from "../services/api";
import { fileUrl } from "../services/api";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";
import { Button } from "./ui/button";

const NODE_WIDTH = 190;
const NODE_HEIGHT = 108;
const LEVEL_HEIGHT = 142;

interface LayoutNode {
  id: string;
  data: OrgChartNode;
  x: number;
  y: number;
  hasHiddenChildren: boolean;
}

const ROLE_STYLES: Record<string, { icon: typeof Crown; badge: string; ring: string }> = {
  SUPER_ADMIN: { icon: Crown, badge: "bg-rose-500/15 text-rose-600 dark:text-rose-400", ring: "border-rose-500/40" },
  ADMIN: { icon: ShieldCheck, badge: "bg-violet-500/15 text-violet-600 dark:text-violet-400", ring: "border-violet-500/40" },
  MANAGER: { icon: Shield, badge: "bg-amber-500/15 text-amber-600 dark:text-amber-400", ring: "border-amber-500/40" },
  TEAM_LEAD: { icon: UserCog, badge: "bg-sky-500/15 text-sky-600 dark:text-sky-400", ring: "border-sky-500/40" },
  EMPLOYEE: { icon: User, badge: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400", ring: "border-emerald-500/40" }
};
const DEFAULT_ROLE_STYLE = { icon: User, badge: "bg-muted text-muted-foreground", ring: "border-border" };

function initialsFor(name?: string) {
  if (!name) return "?";
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("");
}

/** Strips `reports` off any node whose id is in `collapsedIds` before handing the tree to
 *  d3-hierarchy, so a collapsed branch is actually absent from the layout, not just hidden. */
function pruneForCollapse(node: OrgChartNode, collapsedIds: Set<string>): OrgChartNode {
  const pruned = collapsedIds.has(node.id) ? [] : node.reports.map((child) => pruneForCollapse(child, collapsedIds));
  return { ...node, reports: pruned };
}

export function OrgChartTree({ roots }: { roots: OrgChartNode[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const zoomGroupRef = useRef<SVGGElement>(null);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const zoomBehavior = useRef<ReturnType<typeof zoom<SVGSVGElement, unknown>> | null>(null);

  // A synthetic single root when there's more than one real root (e.g. two people with no
  // manager) — d3.hierarchy needs exactly one root node to lay out from.
  const virtualRoot: OrgChartNode = useMemo(
    () => ({ id: "__root__", name: "", email: "", avatarUrl: null, designation: null, role: "", reports: roots }),
    [roots]
  );

  const { nodes, links } = useMemo(() => {
    const pruned = pruneForCollapse(virtualRoot, collapsedIds);
    const root = hierarchy(pruned, (d) => d.reports);
    const layout = tree<OrgChartNode>().nodeSize([NODE_WIDTH + 24, LEVEL_HEIGHT]);
    layout(root);

    const allNodes = root.descendants().filter((d) => d.data.id !== "__root__") as HierarchyPointNode<OrgChartNode>[];
    const allLinks = root
      .links()
      .filter((l) => l.source.data.id !== "__root__")
      .map((l) => ({ source: l.source as HierarchyPointNode<OrgChartNode>, target: l.target as HierarchyPointNode<OrgChartNode> }));

    // Root's own direct children (real roots) get their links drawn from a shared invisible
    // point above them instead of from the zero-width synthetic root, so multi-root companies
    // don't show a weird single point fanning out from x=0.
    const rootLevelLinks = root
      .links()
      .filter((l) => l.source.data.id === "__root__")
      .map((l) => ({ source: l.source as HierarchyPointNode<OrgChartNode>, target: l.target as HierarchyPointNode<OrgChartNode> }));

    const laidOut: LayoutNode[] = allNodes.map((d) => ({
      id: d.data.id,
      data: d.data,
      x: d.x,
      y: d.y,
      hasHiddenChildren: collapsedIds.has(d.data.id) && d.data.reports.length === 0 && roots.some((r) => findNode(r, d.data.id)?.reports.length)
    }));

    // No width/height returned: the <svg> is h-full w-full and the tree is reached by panning and
    // zooming (see resetView), so an extent computed here was measured on every layout and read by
    // nobody. Bring it back if a "fit to view" control ever needs it.
    return { nodes: laidOut, links: [...rootLevelLinks, ...allLinks] };
  }, [virtualRoot, collapsedIds, roots]);

  function findNode(node: OrgChartNode, id: string): OrgChartNode | null {
    if (node.id === id) return node;
    for (const child of node.reports) {
      const found = findNode(child, id);
      if (found) return found;
    }
    return null;
  }

  // Original (uncollapsed) child counts, so a collapsed node can still show "(N)" — the pruned
  // tree above has already zeroed out `reports` for collapsed nodes, so this reads from the
  // original `roots` data instead.
  const originalChildCount = useMemo(() => {
    const map = new Map<string, number>();
    function walk(node: OrgChartNode) {
      map.set(node.id, node.reports.length);
      node.reports.forEach(walk);
    }
    roots.forEach(walk);
    return map;
  }, [roots]);

  // Center on the tree's horizontal midpoint (not its left edge) so a lopsided tree — more
  // reports fanning right than left, or vice versa — still lands centered in the viewport
  // instead of hugging one side.
  const treeCenterX = useMemo(() => {
    if (!nodes.length) return 0;
    const xs = nodes.map((n) => n.x);
    return (Math.min(...xs) + Math.max(...xs)) / 2;
  }, [nodes]);

  useEffect(() => {
    if (!svgRef.current || !zoomGroupRef.current) return;
    const svgSel = select(svgRef.current);
    const z = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.3, 2])
      .on("zoom", (event: D3ZoomEvent<SVGSVGElement, unknown>) => {
        select(zoomGroupRef.current).attr("transform", event.transform.toString());
      });
    svgSel.call(z);
    zoomBehavior.current = z;
    // Center the tree horizontally on first render.
    const containerWidth = containerRef.current?.clientWidth ?? 800;
    const initialX = containerWidth / 2 - treeCenterX;
    svgSel.call(z.transform, zoomIdentity.translate(initialX, 40));
    return () => {
      svgSel.on(".zoom", null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roots]);

  function zoomBy(factor: number) {
    if (!svgRef.current || !zoomBehavior.current) return;
    select(svgRef.current).transition().duration(200).call(zoomBehavior.current.scaleBy, factor);
  }

  function resetView() {
    if (!svgRef.current || !zoomBehavior.current) return;
    const containerWidth = containerRef.current?.clientWidth ?? 800;
    const initialX = containerWidth / 2 - treeCenterX;
    select(svgRef.current)
      .transition()
      .duration(300)
      .call(zoomBehavior.current.transform, zoomIdentity.translate(initialX, 40));
  }

  function toggleCollapse(id: string) {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function collapseAll() {
    const ids = new Set<string>();
    roots.forEach((r) => r.reports.forEach((child) => collectIds(child, ids)));
    setCollapsedIds(ids);
  }
  function collectIds(node: OrgChartNode, set: Set<string>) {
    if (node.reports.length > 0) set.add(node.id);
    node.reports.forEach((c) => collectIds(c, set));
  }

  const linkGenerator = linkVertical<{ source: HierarchyPointNode<OrgChartNode>; target: HierarchyPointNode<OrgChartNode> }, [number, number]>()
    .x((d) => d[0])
    .y((d) => d[1])
    .source((l) => [l.source.x, l.source.y + (l.source.data.id === "__root__" ? 0 : NODE_HEIGHT / 2)])
    .target((l) => [l.target.x, l.target.y - NODE_HEIGHT / 2]);

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => zoomBy(1.3)}>
          <Plus className="h-3.5 w-3.5" />
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => zoomBy(0.75)}>
          <Minus className="h-3.5 w-3.5" />
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={resetView}>
          <Maximize2 className="h-3.5 w-3.5" />Reset view
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={collapseAll}>
          <ChevronsDownUp className="h-3.5 w-3.5" />Collapse all
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setCollapsedIds(new Set())}>
          <ChevronsUpDown className="h-3.5 w-3.5" />Expand all
        </Button>
        <span className="ml-auto hidden text-xs text-muted-foreground sm:inline">Scroll/pinch to zoom, drag to pan, click a node to expand/collapse.</span>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-muted-foreground">
        {(["SUPER_ADMIN", "ADMIN", "MANAGER", "TEAM_LEAD", "EMPLOYEE"] as const).map((role) => {
          const style = ROLE_STYLES[role];
          const Icon = style.icon;
          return (
            <span key={role} className="inline-flex items-center gap-1">
              <span className={`grid h-4 w-4 place-items-center rounded-full ${style.badge}`}>
                <Icon className="h-2.5 w-2.5" />
              </span>
              {role.replace("_", " ")}
            </span>
          );
        })}
      </div>

      <div ref={containerRef} className="relative h-[520px] w-full overflow-hidden rounded-lg border border-border bg-muted/20">
        <svg ref={svgRef} className="h-full w-full cursor-grab active:cursor-grabbing">
          <g ref={zoomGroupRef}>
            {links.map((link, i) => (
              <path
                key={i}
                d={linkGenerator(link) ?? undefined}
                fill="none"
                stroke="hsl(var(--border))"
                strokeWidth={1.5}
              />
            ))}
            {nodes.map((node) => {
              const avatarSrc = fileUrl(node.data.avatarUrl);
              const childCount = originalChildCount.get(node.id) ?? 0;
              const collapsed = collapsedIds.has(node.id);
              const roleStyle = ROLE_STYLES[node.data.role] ?? DEFAULT_ROLE_STYLE;
              const RoleIcon = roleStyle.icon;
              const designation = node.data.designation;
              return (
                <foreignObject
                  key={node.id}
                  x={node.x - NODE_WIDTH / 2}
                  y={node.y - NODE_HEIGHT / 2}
                  width={NODE_WIDTH}
                  height={NODE_HEIGHT}
                >
                  <button
                    type="button"
                    onClick={() => childCount > 0 && toggleCollapse(node.id)}
                    className={`grid h-full w-full grid-cols-[auto_1fr] items-center gap-2 rounded-lg border-2 bg-card p-2.5 text-left shadow-sm transition hover:shadow-md ${
                      childCount > 0 ? "cursor-pointer" : "cursor-default"
                    } ${collapsed ? "ring-1 ring-primary/30" : ""} ${roleStyle.ring}`}
                  >
                    <div className="relative shrink-0">
                      <Avatar className="h-9 w-9">
                        {avatarSrc ? <AvatarImage src={avatarSrc} alt={node.data.name} /> : null}
                        <AvatarFallback className="text-[11px]">{initialsFor(node.data.name)}</AvatarFallback>
                      </Avatar>
                      <span className={`absolute -bottom-1 -right-1 grid h-4 w-4 place-items-center rounded-full ring-2 ring-card ${roleStyle.badge}`}>
                        <RoleIcon className="h-2.5 w-2.5" />
                      </span>
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold leading-tight text-foreground">{node.data.name}</p>
                      <p className={`mt-0.5 inline-block truncate rounded px-1 py-0.5 text-[10px] font-semibold leading-none ${roleStyle.badge}`}>
                        {node.data.role.replace("_", " ")}
                      </p>
                      {designation && <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{designation}</p>}
                      {childCount > 0 && (
                        <p className="mt-0.5 text-[10px] font-semibold text-primary">
                          {collapsed ? `+ ${childCount} report${childCount === 1 ? "" : "s"} (click to expand)` : `${childCount} direct report${childCount === 1 ? "" : "s"}`}
                        </p>
                      )}
                    </div>
                  </button>
                </foreignObject>
              );
            })}
          </g>
        </svg>
      </div>
    </div>
  );
}
