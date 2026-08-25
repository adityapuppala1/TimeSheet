/**
 * WHAT: the metric strip above the ticket table — a headline total, a card per status and per
 * priority (each with its own 14-day trend and yesterday-comparison), and a per-project breakdown.
 *
 * WHY THE CARDS ARE THE FILTERS: a metric a user cannot act on sends them to the filter row to
 * re-express by hand what they just read, and the two can then disagree. Every card here writes the
 * page's existing `filters` state — the same state the dropdowns write — so there is one source of
 * truth for what the table below is showing, and clicking an active card clears it rather than
 * needing a separate reset.
 *
 * WHY THE COUNTS COME FROM THEIR OWN ENDPOINT: the list this page renders is capped at 200 rows.
 * Tallying that would let a card report "200 open" for a workspace with 900, which is the one thing
 * a metric must never do. `GET /tickets/metrics` counts server-side over everything in scope, and
 * returns the daily history each sparkline draws.
 *
 * LAYOUT, AND WHY IT IS ORDERED THIS WAY: statuses read left-to-right in the order work moves
 * through them (open → in progress → in review → resolved → closed → reopened); priorities read
 * CRITICAL-first, the order somebody triaging cares about, not the order the enum happens to be
 * declared in. Below `sm` the grid drops to two columns and the project breakdown becomes stacked
 * cards — the same dual rendering the ticket list itself uses rather than a horizontal scroll
 * nobody discovers.
 */
import { useState } from "react";
import {
  Archive,
  ChevronDown,
  CircleDot,
  Eye,
  FolderKanban,
  Flame,
  Layers,
  Minus,
  RotateCcw,
  ArrowDown,
  AlertTriangle,
  CheckCircle2,
  SlidersHorizontal,
  Ticket as TicketIcon,
  Timer
} from "lucide-react";
import { ticketPriorities, ticketStatuses, type TicketPriority, type TicketStatus } from "@timesheet/shared";
import type { TicketMetrics } from "../services/api";
import {
  humanizeEnum,
  PRIORITY_HIGHER_IS_BETTER,
  PRIORITY_VARIANT,
  STATUS_HIGHER_IS_BETTER,
  STATUS_VARIANT,
  TONE_ACCENT_CLASS,
  type Tone
} from "../lib/ticket-visuals";
import { cn } from "../lib/utils";
import { TicketMetricCard } from "./TicketMetricCard";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import { Skeleton } from "./ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/** The axes this panel can both reflect and clear. `type`/`reporterId` are not tallied here — they
 *  live in the filter row below — but the headline and its "Clear filters" action have to know about
 *  them, or a button labelled "clear" would leave two filters silently applied. */
export interface TicketMetricFilters {
  projectId: string;
  status: string;
  priority: string;
  type: string;
  reporterId: string;
}

/** One icon per bucket, chosen to read as the thing itself rather than as generic decoration. */
const STATUS_ICON = {
  OPEN: CircleDot,
  IN_PROGRESS: Timer,
  IN_REVIEW: Eye,
  RESOLVED: CheckCircle2,
  CLOSED: Archive,
  REOPENED: RotateCcw
} as const;

const PRIORITY_ICON = {
  CRITICAL: Flame,
  HIGH: AlertTriangle,
  MEDIUM: Minus,
  LOW: ArrowDown
} as const;

/** A compact stacked bar showing a project's priority mix, so a row reads as a shape not four numbers. */
function PriorityBar({ byPriority, total }: { byPriority: Partial<Record<TicketPriority, number>>; total: number }) {
  if (total === 0) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <div className="flex h-2 w-full min-w-[80px] overflow-hidden rounded-full bg-muted">
      {ticketPriorities.map((p) => {
        const count = byPriority[p] ?? 0;
        if (count === 0) return null;
        const tone = (PRIORITY_VARIANT[p] ?? "muted") as Tone;
        return (
          <Tooltip key={p}>
            <TooltipTrigger asChild>
              <span className={cn("h-full", TONE_ACCENT_CLASS[tone])} style={{ width: `${(count / total) * 100}%` }} />
            </TooltipTrigger>
            <TooltipContent>
              {count} {humanizeEnum(p).toLowerCase()}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

/** A section heading with an inline "clear this axis" affordance that only exists while it applies. */
function SectionLabel({
  icon: Icon,
  children,
  onClear
}: {
  icon: typeof Layers;
  children: React.ReactNode;
  onClear?: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      <Icon className="h-3.5 w-3.5" />
      {children}
      {onClear && (
        <Button variant="ghost" size="sm" className="h-5 px-1.5 text-[10px]" onClick={onClear}>
          Clear
        </Button>
      )}
    </div>
  );
}

export function TicketMetricsPanel({
  metrics,
  loading,
  filters,
  onFilterChange
}: {
  metrics: TicketMetrics | undefined;
  loading: boolean;
  filters: TicketMetricFilters;
  /** Writes the page's own filter state. Passing "all" clears that axis. */
  onFilterChange: (patch: Partial<TicketMetricFilters>) => void;
}) {
  // Collapsed by default: the per-project breakdown is a second screenful on a workspace with many
  // projects, and the status/priority rows answer the everyday question on their own.
  const [projectsOpen, setProjectsOpen] = useState(false);

  if (loading && !metrics) {
    return (
      <Card>
        <CardContent className="grid gap-3 p-3 sm:p-4">
          <Skeleton className="h-6 w-48" />
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-[132px] w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }
  if (!metrics) return null;

  const byProject = metrics.byProject ?? [];
  const series = metrics.series;
  const days = series?.days ?? [];
  // A card with no history still renders — it just shows the count with no chart and no comparison,
  // which is the honest rendering of "this workspace has no recorded movement yet".
  const seriesFor = (bucket: Record<string, number[]> | undefined, key: string, current: number): number[] =>
    bucket?.[key] ?? (current > 0 ? [current] : []);

  const toggle = (axis: keyof TicketMetricFilters, value: string) =>
    onFilterChange({ [axis]: filters[axis] === value ? "all" : value } as Partial<TicketMetricFilters>);

  const filtered = (Object.keys(filters) as Array<keyof TicketMetricFilters>).some((key) => filters[key] !== "all");
  const priorityCaveat = series && !series.priorityExact ? "priority changed in window — trend approximate" : undefined;

  return (
    <Card>
      <CardContent className="grid gap-4 p-3 sm:p-4">
        {/* ---- Headline ---- */}
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border pb-3">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
              <TicketIcon className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {filtered ? "Tickets in this view" : "All tickets"}
              </p>
              <p className="text-3xl font-black leading-tight tracking-tight tabular-nums">{metrics.total}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground">
              Trends over the last {days.length || 14} days
              {series?.truncated ? " · partial (event cap reached)" : ""}
            </span>
            {filtered && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onFilterChange({ status: "all", priority: "all", projectId: "all", type: "all", reporterId: "all" })}
              >
                Clear filters
              </Button>
            )}
          </div>
        </div>

        {/* ---- Status ---- */}
        <div className="grid gap-2">
          <SectionLabel icon={Layers} onClear={filters.status !== "all" ? () => onFilterChange({ status: "all" }) : undefined}>
            By status
          </SectionLabel>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {ticketStatuses.map((status) => {
              const count = metrics.byStatus[status as TicketStatus] ?? 0;
              return (
                <TicketMetricCard
                  key={status}
                  label={humanizeEnum(status)}
                  icon={STATUS_ICON[status as keyof typeof STATUS_ICON]}
                  value={count}
                  series={seriesFor(series?.byStatus, status, count)}
                  days={days}
                  tone={(STATUS_VARIANT[status as TicketStatus] ?? "muted") as Tone}
                  higherIsBetter={STATUS_HIGHER_IS_BETTER[status as TicketStatus]}
                  active={filters.status === status}
                  onClick={() => toggle("status", status)}
                />
              );
            })}
          </div>
        </div>

        {/* ---- Priority ---- */}
        <div className="grid gap-2">
          <SectionLabel
            icon={SlidersHorizontal}
            onClear={filters.priority !== "all" ? () => onFilterChange({ priority: "all" }) : undefined}
          >
            By priority
          </SectionLabel>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[...ticketPriorities].reverse().map((priority) => {
              const count = metrics.byPriority[priority as TicketPriority] ?? 0;
              return (
                <TicketMetricCard
                  key={priority}
                  label={humanizeEnum(priority)}
                  icon={PRIORITY_ICON[priority as keyof typeof PRIORITY_ICON]}
                  value={count}
                  series={seriesFor(series?.byPriority, priority, count)}
                  days={days}
                  tone={(PRIORITY_VARIANT[priority as TicketPriority] ?? "muted") as Tone}
                  higherIsBetter={PRIORITY_HIGHER_IS_BETTER[priority as TicketPriority]}
                  active={filters.priority === priority}
                  onClick={() => toggle("priority", priority)}
                  caveat={priorityCaveat}
                />
              );
            })}
          </div>
        </div>

        {/* ---- Per project ---- */}
        {byProject.length > 0 && (
          <div className="grid gap-2">
            <button
              type="button"
              onClick={() => setProjectsOpen((v) => !v)}
              aria-expanded={projectsOpen}
              className="flex items-center gap-1.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground transition hover:text-foreground"
            >
              <FolderKanban className="h-3.5 w-3.5" />
              By project
              <span className="font-normal normal-case tracking-normal">({byProject.length})</span>
              <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", projectsOpen && "rotate-180")} />
            </button>

            {projectsOpen && (
              <>
                <div className="hidden overflow-x-auto sm:block">
                  <table className="w-full text-sm">
                    <thead className="text-left text-muted-foreground">
                      <tr>
                        <th className="p-2 font-medium">Project</th>
                        <th className="p-2 text-right font-medium">Total</th>
                        <th className="p-2 text-right font-medium">Open</th>
                        <th className="p-2 text-right font-medium">Closed</th>
                        <th className="w-[28%] p-2 font-medium">Priority mix</th>
                      </tr>
                    </thead>
                    <tbody>
                      {byProject.map((row) => {
                        const active = filters.projectId === row.projectId;
                        return (
                          <tr
                            key={row.projectId}
                            onClick={() => toggle("projectId", row.projectId)}
                            aria-selected={active}
                            className={cn(
                              "cursor-pointer border-t border-border transition hover:bg-muted/50",
                              active && "bg-primary/5"
                            )}
                          >
                            <td className="p-2">
                              <span className="font-medium">{row.name}</span>
                              <span className="ml-2 font-mono text-xs text-muted-foreground">{row.code}</span>
                            </td>
                            <td className="p-2 text-right font-semibold tabular-nums">{row.total}</td>
                            <td className="p-2 text-right tabular-nums text-info">{row.open}</td>
                            <td className="p-2 text-right tabular-nums text-success">{row.closed}</td>
                            <td className="p-2">
                              <PriorityBar byPriority={row.byPriority} total={row.total} />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="grid gap-2 sm:hidden">
                  {byProject.map((row) => {
                    const active = filters.projectId === row.projectId;
                    return (
                      <button
                        type="button"
                        key={row.projectId}
                        aria-pressed={active}
                        onClick={() => toggle("projectId", row.projectId)}
                        className={cn(
                          "rounded-lg border border-border p-3 text-left transition",
                          active && "bg-primary/5 ring-2 ring-primary/50"
                        )}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <p className="min-w-0 truncate font-medium">{row.name}</p>
                          <span className="font-semibold tabular-nums">{row.total}</span>
                        </div>
                        <div className="mt-2">
                          <PriorityBar byPriority={row.byPriority} total={row.total} />
                        </div>
                        <p className="mt-2 text-xs text-muted-foreground">
                          <span className="text-info">{row.open} open</span> ·{" "}
                          <span className="text-success">{row.closed} closed</span>
                        </p>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
