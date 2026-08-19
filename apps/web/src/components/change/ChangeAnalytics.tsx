/**
 * WHAT: the change register's analytics — a twelve-week trend of what was raised against what was
 * closed, the four delivery-health figures a change manager is judged on, the SLA rollup, and which
 * projects are carrying the load.
 *
 * WHY THE TREND IS REAL: every point comes from `GET /changes/metrics`, which buckets actual
 * `createdAt` and `closedAt` timestamps into twelve weeks server-side. Nothing here is synthesised
 * from the current total. This follows the same rule as the ticket metric cards: a chart that draws a
 * pleasing curve unrelated to its own figures is worse than no chart, because it invites people to
 * read a trend that was never measured.
 *
 * WHY SOME NUMBERS SAY "—" RATHER THAN 0%: the API returns null, never zero, when there is nothing to
 * divide by. "No change has closed yet" and "every change succeeded" are different facts, and a 0%
 * failure rate over an empty set is exactly the number that ends up quoted in a review.
 *
 * ANIMATION, AND ITS LIMIT: the areas draw in once per data change and the bars grow to width. Both
 * are wrapped in a `prefers-reduced-motion` check that drops straight to the final frame — no
 * information is carried in the motion, so removing it costs the reader nothing.
 */
import { useEffect, useState } from "react";
import { Activity, AlarmClock, Flame, ShieldAlert, TrendingDown, TrendingUp } from "lucide-react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip as ChartTip, XAxis, YAxis } from "recharts";
import type { ChangeMetrics } from "../../services/api";
import { cn } from "../../lib/utils";
import { Card, CardContent } from "../ui/card";

/** Honours the OS setting, and keeps honouring it if it changes mid-session. */
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

/** "2026-08-17" → "17 Aug". The axis is weekly, so the year would be noise on every tick. */
const weekLabel = (iso: string) =>
  new Date(iso + "T00:00:00Z").toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });

/* ------------------------------------------------------------------ *
 * Delivery health
 * ------------------------------------------------------------------ */

/**
 * One health figure.
 *
 * `higherIsBetter` decides the colour of the comparison, and it is deliberately nullable: an
 * emergency rate rising is bad, an approval turnaround falling is good, and a raw count of changes
 * is neither — colouring that green or red would assert something the number does not support.
 */
function HealthTile({
  label,
  value,
  suffix,
  hint,
  icon: Icon,
  severity
}: {
  label: string;
  value: number | null;
  suffix: string;
  hint: string;
  icon: typeof Flame;
  severity: "neutral" | "good" | "warn" | "bad";
}) {
  const tone = {
    neutral: "text-foreground",
    good: "text-emerald-600 dark:text-emerald-500",
    warn: "text-amber-600 dark:text-amber-500",
    bad: "text-destructive"
  }[severity];

  return (
    <div className="rounded-xl border border-border bg-card p-3.5">
      <div className="flex items-center justify-between gap-2 text-muted-foreground">
        <p className="truncate text-[11px] font-semibold uppercase tracking-wide">{label}</p>
        <Icon className={cn("h-4 w-4 shrink-0 opacity-80", tone)} />
      </div>
      <p className={cn("mt-1 text-2xl font-black tabular-nums tracking-tight", tone)}>
        {/* An em dash, not 0: there is nothing to divide by, and a zero here reads as a measurement. */}
        {value === null ? <span className="text-muted-foreground">—</span> : `${value}${suffix}`}
      </p>
      <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">{hint}</p>
    </div>
  );
}

/**
 * Turns a rate into a severity band.
 *
 * One helper rather than a ternary chain at each call site: the three health figures share the shape
 * "null means unmeasured, then two thresholds", and writing it out three times is how the bands come
 * to disagree with each other.
 */
function severityFor(value: number | null, warnAt: number, badAt: number): "neutral" | "good" | "warn" | "bad" {
  if (value === null) return "neutral";
  if (value >= badAt) return "bad";
  if (value >= warnAt) return "warn";
  return "good";
}

/* ------------------------------------------------------------------ *
 * Panel
 * ------------------------------------------------------------------ */

export function ChangeAnalytics({ metrics }: { metrics: ChangeMetrics }) {
  const reduced = usePrefersReducedMotion();
  const trend = metrics.trend ?? [];
  const byProject = metrics.byProject ?? [];
  const sla = metrics.sla ?? { ON_TRACK: 0, WARNING: 0, BREACHED: 0 };

  const data = trend.map((t) => ({ ...t, label: weekLabel(t.week) }));
  const raised = trend.reduce((sum, t) => sum + t.raised, 0);
  const closed = trend.reduce((sum, t) => sum + t.closed, 0);
  // Positive means the backlog grew over the window. Named rather than left as a bare delta, because
  // the sign alone does not say which direction is which.
  const netBacklog = raised - closed;

  const busiest = Math.max(1, ...byProject.map((p) => p.total));
  const slaTotal = sla.ON_TRACK + sla.WARNING + sla.BREACHED;

  return (
    <div className="grid gap-4">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <HealthTile
          label="Change failure rate"
          value={metrics.changeFailureRate}
          suffix="%"
          hint="Closed changes that failed or were rolled back"
          icon={Flame}
          severity={severityFor(metrics.changeFailureRate, 5, 15)}
        />
        <HealthTile
          label="Emergency rate"
          value={metrics.emergencyRate}
          suffix="%"
          hint="Raised as emergency rather than planned"
          icon={ShieldAlert}
          severity={severityFor(metrics.emergencyRate, 10, 25)}
        />
        <HealthTile
          label="Approval turnaround"
          value={metrics.avgApprovalHours}
          suffix="h"
          hint="Average from submission to decision"
          icon={AlarmClock}
          severity={severityFor(metrics.avgApprovalHours, 24, 72)}
        />
        <HealthTile
          label="SLA breached"
          value={slaTotal === 0 ? null : sla.BREACHED}
          suffix=""
          hint={slaTotal === 0 ? "No stage clocks running" : `${sla.WARNING} due soon · ${sla.ON_TRACK} on track`}
          icon={Activity}
          severity={severityFor(slaTotal === 0 ? null : sla.BREACHED + sla.WARNING * 0.5, 0.5, 1)}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Card>
          <CardContent className="p-4">
            <header className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Raised against closed</h3>
                <p className="text-xs text-muted-foreground">Twelve weeks, from when each change was raised and closed.</p>
              </div>
              <p
                className={cn(
                  "flex items-center gap-1 text-xs font-medium tabular-nums",
                  netBacklog > 0 ? "text-amber-600 dark:text-amber-500" : "text-emerald-600 dark:text-emerald-500"
                )}
              >
                {netBacklog > 0 ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
                {netBacklog > 0 ? `+${netBacklog} net open` : `${Math.abs(netBacklog)} net cleared`}
              </p>
            </header>

            <div className="h-56 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -22 }}>
                  <defs>
                    <linearGradient id="changeRaised" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.02} />
                    </linearGradient>
                    <linearGradient id="changeClosed" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(160 84% 39%)" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="hsl(160 84% 39%)" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false} allowDecimals={false} width={34} />
                  <ChartTip
                    contentStyle={{
                      borderRadius: 8,
                      border: "1px solid hsl(var(--border))",
                      background: "hsl(var(--popover))",
                      color: "hsl(var(--popover-foreground))",
                      fontSize: 12
                    }}
                    labelFormatter={(l) => `Week of ${l}`}
                  />
                  <Area
                    type="monotone"
                    dataKey="raised"
                    name="Raised"
                    stroke="hsl(var(--primary))"
                    strokeWidth={2}
                    fill="url(#changeRaised)"
                    isAnimationActive={!reduced}
                    animationDuration={650}
                  />
                  <Area
                    type="monotone"
                    dataKey="closed"
                    name="Closed"
                    stroke="hsl(160 84% 39%)"
                    strokeWidth={2}
                    fill="url(#changeClosed)"
                    isAnimationActive={!reduced}
                    animationDuration={650}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <header className="mb-3">
              <h3 className="text-sm font-semibold text-foreground">Busiest projects</h3>
              <p className="text-xs text-muted-foreground">Where the change load actually sits.</p>
            </header>

            {byProject.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">No changes raised yet.</p>
            ) : (
              <ul className="grid gap-2.5">
                {byProject.map((p) => (
                  <li key={p.id} className="grid gap-1">
                    <div className="flex items-baseline justify-between gap-2 text-xs">
                      <span className="truncate font-medium text-foreground" title={p.name}>
                        {p.code}
                      </span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {p.total}
                        {p.high > 0 && <span className="ml-1.5 text-destructive">{p.high} high</span>}
                      </span>
                    </div>
                    {/* Two stacked widths, not two bars: in-flight is a subset of the total, and drawing
                        them side by side would read as two independent quantities. */}
                    <div className="relative h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className={cn("absolute inset-y-0 left-0 rounded-full bg-primary/30", !reduced && "transition-[width] duration-700 ease-out")}
                        style={{ width: `${Math.max(2, (p.total / busiest) * 100)}%` }}
                      />
                      <div
                        className={cn("absolute inset-y-0 left-0 rounded-full bg-primary", !reduced && "transition-[width] duration-700 ease-out")}
                        style={{ width: `${(p.inFlight / busiest) * 100}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
