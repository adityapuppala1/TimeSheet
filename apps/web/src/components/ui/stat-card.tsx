/**
 * WHAT: the one stat-tile component every "row of KPI numbers" section in this app renders —
 * replaces three near-identical local implementations that had drifted apart (Dashboard.tsx's
 * `MiniStat`/plain stat `Card`s, Team.tsx's `StatCard`, AdminPages.tsx's `StatCard`).
 * WHY one shared component: consistent sizing/spacing across pages, and a trend badge (see
 * `lib/trend.ts`) that every page gets "for free" by passing a `trend` prop instead of
 * reimplementing the up/down/flat arrow + color logic locally.
 * RESPONSIVE: 2 columns on a phone, up to 4-6 on desktop (the grid itself is the caller's
 * choice — this component just keeps each tile's own padding/font-size compact below `sm` so a
 * 2-up mobile grid doesn't look cramped or force horizontal scroll).
 */
import { Minus, TrendingDown, TrendingUp } from "lucide-react";
import type { ReactNode } from "react";
import type { Trend } from "../../lib/trend";
import { cn } from "../../lib/utils";

export function TrendBadge({ trend, label }: { trend: Trend; label?: string }) {
  // Grey covers two different cases on purpose: a flat trend, and one whose direction carries no
  // judgement (`good: null`) — see the Trend type. Colouring the latter would assert a reading the
  // number does not support.
  const colorClass =
    trend.direction === "flat" || trend.good === null ? "text-muted-foreground" : trend.good ? "text-success" : "text-destructive";
  const Icon = trend.direction === "up" ? TrendingUp : trend.direction === "down" ? TrendingDown : Minus;
  return (
    <span className={cn("inline-flex items-center gap-0.5 text-[10px] font-semibold sm:text-xs", colorClass)} title={label}>
      <Icon className="h-3 w-3 shrink-0" />
      {trend.direction === "flat" ? "flat" : `${trend.pct > 0 ? "+" : ""}${trend.pct}%`}
    </span>
  );
}

export function StatCard({
  label,
  value,
  icon,
  tone = "default",
  trend,
  trendLabel,
  hint
}: {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  tone?: "default" | "success" | "warning" | "destructive";
  trend?: Trend | null;
  /** e.g. "vs yesterday" — shown as a tooltip on the badge and, space permitting, inline. */
  trendLabel?: string;
  /**
   * One sentence explaining what the number does or does not include, when that is not obvious
   * from the label. A tile that quietly excludes something has to be able to say so — otherwise
   * the only way to discover the rule is to notice the arithmetic not adding up.
   *
   * Rendered as small print under the value AND as the tile's `title`, so it survives truncation.
   */
  hint?: string;
}) {
  const toneClass =
    tone === "success" ? "text-success" : tone === "warning" ? "text-warning" : tone === "destructive" ? "text-destructive" : "";
  return (
    <div className="rounded-lg border border-border bg-card p-2.5 sm:p-3.5" title={hint}>
      <div className="flex items-center justify-between gap-1.5 text-muted-foreground">
        <p className="truncate text-[10px] font-semibold uppercase tracking-wide sm:text-xs">{label}</p>
        {icon && <span className={cn("shrink-0 opacity-80", toneClass)}>{icon}</span>}
      </div>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 sm:mt-1.5">
        <p className={cn("text-lg font-black tracking-tight sm:text-2xl", toneClass)}>{value}</p>
        {trend && <TrendBadge trend={trend} label={trendLabel} />}
      </div>
      {hint && <p className="mt-1 text-[10px] leading-snug text-muted-foreground sm:text-[11px]">{hint}</p>}
    </div>
  );
}
