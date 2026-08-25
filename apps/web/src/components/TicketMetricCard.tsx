/**
 * WHAT: one metric card on the Tickets page — an icon, a live count, how it moved since yesterday,
 * and a 14-day sparkline of the same number. Clicking it filters the table below to that bucket.
 *
 * WHY THE SPARKLINE IS REAL: it is not a decoration generated from the current value. The series
 * comes from `GET /tickets/metrics`, which reconstructs each day's count by undoing recorded
 * creations and status transitions — so the chart's final point IS the number printed above it. A
 * card that draws a pleasing upward curve unrelated to its own figure is worse than a card with no
 * chart, because it invites people to read a trend that was never measured.
 *
 * WHY SOME TREND CHIPS ARE GREY: `higherIsBetter: null` means the direction carries no judgement.
 * A rising MEDIUM-priority count is neither good nor bad, and colouring it green or red asserts
 * something the number does not support — see `PRIORITY_HIGHER_IS_BETTER`.
 *
 * ANIMATION, AND ITS LIMIT: the count rolls to its new value and the area draws itself in, both
 * short and both once per data change. Everything is wrapped in a `prefers-reduced-motion` check
 * that drops straight to the final frame — an animated dashboard is unusable for somebody who gets
 * motion sick from it, and this one carries no information in the motion.
 */
import { useEffect, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Minus, TrendingDown, TrendingUp } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer, Tooltip as ChartTip, YAxis } from "recharts";
import { computeTrend } from "../lib/trend";
import { TONE_ACCENT_CLASS, TONE_ACTIVE_RING_CLASS, TONE_CHART_COLOR, TONE_TEXT_CLASS, type Tone } from "../lib/ticket-visuals";
import { cn } from "../lib/utils";

/** Honours the OS setting and keeps honouring it if the user changes it mid-session. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)").matches : false
  );
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/**
 * Rolls a number to its new value over ~450ms.
 *
 * Eased rather than linear so it decelerates into the final figure — a linear count reads as a
 * spinner. Always lands EXACTLY on `value`: the last frame assigns the target rather than the
 * interpolation, because a counter that settles on 153 when the answer is 154 is a bug that only
 * shows up on slow machines.
 */
function useCountUp(value: number, disabled: boolean): number {
  const [shown, setShown] = useState(value);
  const fromRef = useRef(value);

  useEffect(() => {
    if (disabled) {
      fromRef.current = value;
      setShown(value);
      return;
    }
    const from = fromRef.current;
    if (from === value) return;
    const start = performance.now();
    const DURATION = 450;
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / DURATION);
      const eased = 1 - Math.pow(1 - t, 3);
      if (t >= 1) {
        fromRef.current = value;
        setShown(value);
        return;
      }
      setShown(Math.round(from + (value - from) * eased));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, disabled]);

  return shown;
}

/**
 * Everything the "vs yesterday" line needs, decided in one place.
 *
 * Kept out of the component because it is the only branchy part of this file, and because the two
 * decisions it makes are easy to get subtly wrong when tangled into JSX: the ARROW follows the
 * arithmetic (a neutral bucket still shows which way it moved), while the COLOUR follows
 * `higherIsBetter` and stays grey when that is null — painting a rising MEDIUM count red would
 * assert a judgement the number does not support.
 */
function describeMovement(value: number, series: number[], higherIsBetter: boolean | null) {
  const yesterday = series.length >= 2 ? series[series.length - 2] : null;
  if (yesterday === null) {
    return { icon: Minus, className: "text-muted-foreground", text: null, delta: 0, title: undefined as string | undefined };
  }

  const delta = value - yesterday;
  // Explicit sign, because "+3" and "3" read differently at a glance and only one of them says
  // "this went up".
  const sign = delta > 0 ? "+" : "";
  const text = delta === 0 ? "no change" : `${sign}${delta}`;

  // Null when there is no meaningful baseline to divide by — see computeTrend. The card still shows
  // the absolute movement in that case; it just cannot offer a percentage.
  const trend = computeTrend(value, yesterday, higherIsBetter ?? true);
  if (!trend || trend.direction === "flat") {
    return { icon: Minus, className: "text-muted-foreground", text, delta, title: undefined as string | undefined };
  }

  // Grey when the direction carries no judgement, even though we know which way it moved.
  const goodClass = trend.good ? "text-success" : "text-destructive";
  const pctSign = trend.pct > 0 ? "+" : "";

  return {
    icon: trend.direction === "up" ? TrendingUp : TrendingDown,
    className: higherIsBetter === null ? "text-muted-foreground" : goodClass,
    text,
    delta,
    title: `${pctSign}${trend.pct}% vs yesterday`
  };
}

export interface TicketMetricCardProps {
  label: string;
  icon: LucideIcon;
  value: number;
  /** Oldest-first daily counts. The last entry must equal `value`. */
  series: number[];
  /** ISO dates matching `series`, for the hover tooltip. */
  days: string[];
  tone: Tone;
  /** true = up is good, false = down is good, null = no judgement (grey chip). */
  higherIsBetter: boolean | null;
  active: boolean;
  onClick: () => void;
  /** Shown under the chart when the series is an approximation rather than a measurement. */
  caveat?: string;
}

export function TicketMetricCard({
  label,
  icon: Icon,
  value,
  series,
  days,
  tone,
  higherIsBetter,
  active,
  onClick,
  caveat
}: TicketMetricCardProps) {
  const reducedMotion = usePrefersReducedMotion();
  const shown = useCountUp(value, reducedMotion);

  const movement = describeMovement(value, series, higherIsBetter);

  const chartData = series.map((count, i) => ({ count, day: days[i] ?? "" }));
  const color = TONE_CHART_COLOR[tone];
  const gradientId = `metric-grad-${label.replace(/\W+/g, "-").toLowerCase()}`;

  /**
   * The y-window the sparkline draws inside.
   *
   * Recharts defaults to fitting the data exactly, which is wrong at both ends here. A FLAT series
   * (a priority nobody has touched in a fortnight) collapses the domain to a single value, and the
   * area then fills the entire card — eleven of those read as a wall of solid colour rather than as
   * eleven charts. A VARYING series padded by the same proportion would flatten the real shape into
   * a straight line. So: a flat series gets a fixed ±1 window that parks the line in the middle,
   * and a varying one gets a small proportional margin that leaves the curve legible.
   */
  // Bounds come from the SERIES, never clamped to zero: a queue that ran between 91 and 154 all
  // fortnight is a visible slope over its own range, and stretching the axis down to 0 would iron
  // that into a flat line near the top of the box.
  const lo = series.length > 0 ? Math.min(...series) : 0;
  const hi = series.length > 0 ? Math.max(...series) : 0;
  const span = hi - lo;
  const domain: [number, number] = span === 0 ? [hi - 1, hi + 1] : [lo - span * 0.25, hi + span * 0.15];

  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      title={active ? `Showing ${label.toLowerCase()} only — click to clear` : `Show ${label.toLowerCase()} only`}
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-xl border border-border bg-card p-3 text-left",
        "transition-all duration-200 hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-md",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:hover:translate-y-0",
        active && "ring-2",
        active && TONE_ACTIVE_RING_CLASS[tone]
      )}
    >
      {/* The tone bar. Colour lives on an edge rather than the whole tile: a grid of ten saturated
          blocks is unreadable, and the number is what people are here to compare. */}
      <span className={cn("absolute inset-x-0 top-0 h-0.5", TONE_ACCENT_CLASS[tone])} aria-hidden />

      <div className="flex items-start justify-between gap-2">
        <p className="truncate text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
        <Icon className={cn("h-4 w-4 shrink-0 opacity-70 transition-opacity group-hover:opacity-100", TONE_TEXT_CLASS[tone])} />
      </div>

      <span className={cn("mt-0.5 text-2xl font-black tabular-nums leading-tight tracking-tight", TONE_TEXT_CLASS[tone])}>
        {shown}
      </span>

      {/* The ABSOLUTE increment leads, not the percentage: at these magnitudes a percentage is
          noise — one ticket moving from 1 to 2 is "+100%", which reads as a crisis. The percentage
          is still there, on hover, for the buckets where it means something. */}
      <span className="mt-0.5 flex items-baseline gap-1 text-[10px] leading-tight" title={movement.title}>
        {movement.text === null ? (
          <span className="text-muted-foreground">no baseline yet</span>
        ) : (
          <>
            <span className={cn("inline-flex items-center gap-0.5 font-semibold", movement.className)}>
              <movement.icon className="h-3 w-3 shrink-0" />
              {movement.text}
            </span>
            {movement.delta !== 0 && <span className="text-muted-foreground">vs yesterday</span>}
          </>
        )}
      </span>

      {/* Above the chart, not below it: the chart is bled to the card's bottom edge, so anything
          after it would sit outside the padding and hang off the card. */}
      {caveat && <p className="mt-1 text-[9px] leading-tight text-muted-foreground">{caveat}</p>}

      {/* Bled to the card's edges rather than inset: the negative margins cancel the card padding so
          the curve runs corner to corner, which is what makes it read as a chart rather than as a
          small picture sitting inside a box. `mt-auto` pins it to the foot so cards in a row line
          their charts up even when a label wraps to two lines. */}
      <div className="pointer-events-none -mx-3 -mb-3 mt-auto h-12 w-[calc(100%+1.5rem)] pt-2">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.28} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            {/* Tooltip stays enabled but the container is pointer-events-none, so hovering the card
                never steals the click that filters — the chart is a picture here, not a control. */}
            <ChartTip
              cursor={false}
              contentStyle={{
                background: "hsl(var(--popover))",
                border: "1px solid hsl(var(--border))",
                borderRadius: 8,
                color: "hsl(var(--popover-foreground))",
                fontSize: 11,
                padding: "4px 8px"
              }}
              labelFormatter={(l: unknown) => String(l)}
              formatter={(v: unknown) => [String(v), label]}
            />
            <YAxis hide domain={domain} />
            <Area
              type="monotone"
              dataKey="count"
              stroke={color}
              strokeWidth={2}
              fill={`url(#${gradientId})`}
              isAnimationActive={!reducedMotion}
              animationDuration={650}
              dot={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </button>
  );
}
