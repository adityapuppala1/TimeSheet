/**
 * WHAT: the analytics the timesheet data already supported but nothing showed — utilisation
 * against real capacity, approval latency, and where a project's hours actually went.
 *
 * WHY EVERY NUMBER HERE CAN SAY "I DON'T KNOW": each figure joins the rows against something that
 * may be missing. A person with no contracted capacity on file has no utilisation — not 0%.
 * Entries submitted before the submit timestamp existed have no latency — not "instant". Work
 * approved before rate snapshots existed has no cost — not £0. Rendering any of those as a number
 * would be the report asserting something it cannot support, and every one of them is a figure
 * somebody would act on.
 *
 * WHY THE RANGE IS REQUIRED AND DEFAULTS TO THIS MONTH: utilisation is hours over capacity, and
 * capacity only exists relative to a period. The server refuses without a range rather than
 * choosing one silently; this picks a sensible starting window and shows it, so the reader always
 * knows what they are looking at. Capacity is counted only up to today, so "this month" on the 2nd
 * measures two days of work against two days of capacity, not against the whole month.
 *
 * THE DEFINITIONS are the server's (services/workspace-metrics.ts): hours are LOGGED hours
 * (submitted + approved), capacity is working days to date minus leave, and each person's target
 * utilisation is its own column rather than a hidden discount on their capacity.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip as RTooltip } from "recharts";
import { Activity, Clock, Gauge, HelpCircle } from "lucide-react";

import { InactivePeopleNote } from "./InactivePeopleNote";
import { QueryState } from "./QueryState";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { DateRangePicker } from "./ui/date-range-picker";
import { reportApi, type TimesheetAnalytics } from "../services/api";
import { formatDate, formatHours, formatMoney, formatNumber, formatPercent } from "../lib/format";
import { localDateKey } from "../lib/local-day";
import { cn } from "../lib/utils";
import { EmptyState } from "./ui/empty-state";

const SERIES_COLORS = [
  "hsl(var(--primary))",
  "hsl(var(--accent))",
  "hsl(var(--success))",
  "hsl(var(--warning))",
  "hsl(var(--info))",
  "hsl(var(--destructive))",
  "hsl(var(--muted-foreground))"
];

const TOOLTIP_STYLE = {
  contentStyle: {
    background: "hsl(var(--popover))",
    border: "1px solid hsl(var(--border))",
    borderRadius: "0.5rem",
    fontSize: "0.8rem"
  }
} as const;

/** First and last day of the current month, which is the window people mean by "this month". */
function defaultRange(): { from: string; to: string } {
  const now = new Date();
  return {
    from: localDateKey(new Date(now.getFullYear(), now.getMonth(), 1)),
    to: localDateKey(new Date(now.getFullYear(), now.getMonth() + 1, 0))
  };
}

/** One activity's cost, in each of its own currencies — "₹8,000.00 + $100.00". Never one summed figure. */
function costLabel(costs: TimesheetAnalytics["activityMix"][number]["costByCurrency"]): string {
  return costs.map((c) => formatMoney(c.amount, c.currency)).join(" + ");
}

/** "2 of 22 working days, to 2 Oct 2026" — what the capacity column is actually counting. */
function capacityScope(range: TimesheetAnalytics["range"]): string {
  if (range.capacityThrough === null) return "This range has not started, so nobody has capacity in it yet.";
  const days = `${range.workingDaysToDate} of ${range.workingDays} working ${range.workingDays === 1 ? "day" : "days"}`;
  return `Capacity counts ${days}, up to ${formatDate(range.capacityThrough)}.`;
}

/** The house style for "this could not be computed". Never a zero. */
function Unknown({ hint }: { hint: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-muted-foreground" title={hint}>
      —<HelpCircle className="h-3 w-3" />
    </span>
  );
}

function utilisationTone(pct: number | null): string {
  if (pct === null) return "text-muted-foreground";
  if (pct > 110) return "text-destructive";
  if (pct > 95) return "text-warning";
  if (pct < 50) return "text-muted-foreground";
  return "text-success";
}

export function TimesheetAnalyticsPanel() {
  const [range, setRange] = useState(defaultRange);

  const analytics = useQuery({
    queryKey: ["reports", "analytics", range],
    queryFn: () => reportApi.analytics({ from: range.from, to: range.to }),
    enabled: Boolean(range.from && range.to),
    placeholderData: (previous) => previous
  });

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <Gauge className="h-4 w-4" />
            Analytics
          </CardTitle>
          <CardDescription>
            Utilisation against contracted capacity, how long approvals take, and where the hours went.
          </CardDescription>
        </div>
        {/* `allowAllTime` is off here on purpose: utilisation is hours over capacity, and capacity
            only exists relative to a period. Offering "All time" would offer a question the server
            correctly refuses to answer. */}
        <DateRangePicker
          id="analytics-range"
          className="shrink-0"
          value={range}
          onChange={setRange}
          allowAllTime={false}
        />
      </CardHeader>

      <CardContent className="grid gap-6">
        <QueryState query={analytics} what="the analytics for this range">
          {(data) => <AnalyticsBody data={data} />}
        </QueryState>
      </CardContent>
    </Card>
  );
}

/** The panel's figures, once they have loaded. */
function AnalyticsBody({ data }: { data: TimesheetAnalytics }) {
  const mix = data.activityMix;
  const latency = data.approvalLatency;
  const excluded = data.totals.excluded;
  const mixSummary =
    "Logged hours by activity: " +
    mix.map((row) => row.activity + " " + formatHours(row.hours) + " (" + formatPercent(row.sharePct, 1) + ")").join(", ") +
    ".";
  const latencyTiles = [
    { label: "Median", value: latency.medianHours == null ? null : formatHours(latency.medianHours) },
    { label: "90th percentile", value: latency.p90Hours == null ? null : formatHours(latency.p90Hours) },
    { label: "Slowest", value: latency.slowestHours == null ? null : formatHours(latency.slowestHours) },
    { label: "Approval SLA breach rate", value: latency.breachRatePct == null ? null : formatPercent(latency.breachRatePct, 1) }
  ];

  return (
    <>
      <p className="text-xs text-muted-foreground">
        {capacityScope(data.range)} {formatNumber(data.totals.entries)} logged {data.totals.entries === 1 ? "entry" : "entries"} ·{" "}
        {data.totals.people} {data.totals.people === 1 ? "person" : "people"} logged time.
      </p>

      {/* ---------------------------------------------------------------- utilisation */}
      <div className="grid gap-2">
        <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Gauge className="h-3.5 w-3.5" />
          Utilisation — logged hours against capacity to date
        </p>
        <div className="max-w-full overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th scope="col" className="px-3 py-2 text-left font-semibold">Person</th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">Logged</th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">Capacity</th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">Utilisation</th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">Target</th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">Billable</th>
              </tr>
            </thead>
            <tbody>
              {data.utilisation.map((row) => (
                <tr key={row.userId} className="border-b border-border last:border-0">
                  <td className="px-3 py-2 font-medium">{row.name}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatHours(row.loggedHours)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                    {row.capacityHours === null ? (
                      <Unknown hint="No capacity to count: none on file and no workspace default, a range not yet started, or leave for all of it." />
                    ) : (
                      <span title={row.timeOffHours > 0 ? formatHours(row.timeOffHours) + " of leave already taken off" : undefined}>
                        {formatHours(row.capacityHours)}
                      </span>
                    )}
                  </td>
                  <td className={cn("px-3 py-2 text-right font-semibold tabular-nums", utilisationTone(row.utilisationPct))}>
                    {row.utilisationPct === null ? <Unknown hint="Cannot be computed without a capacity figure." /> : formatPercent(row.utilisationPct, 1)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{formatPercent(row.targetUtilisationPct)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{formatPercent(row.billableUtilisationPct, 1)}</td>
                </tr>
              ))}
              {data.utilisation.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-sm text-muted-foreground">
                    Nobody is in scope for this range.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">
          Logged hours are submitted and approved hours. Capacity is each person&apos;s contracted weekly hours spread over the
          working days from the start of the range up to today, less any leave booked on the workload board. Target is the
          share of that capacity they are expected to log; it is shown for comparison and not taken off their capacity.
          Everyone in scope is listed, including people who logged nothing.
        </p>
        {(excluded.draftHours > 0 || excluded.rejectedHours > 0) && (
          <p className="text-xs text-muted-foreground">
            Not counted anywhere above: {formatHours(excluded.draftHours)} still in draft and {formatHours(excluded.rejectedHours)} rejected.
          </p>
        )}
        <InactivePeopleNote count={data.hiddenInactivePeople} className="px-0 pb-0 pt-0" />
      </div>

      {/* ---------------------------------------------------------------- approvals */}
      <div className="grid gap-2">
        <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Clock className="h-3.5 w-3.5" />
          Approval latency
        </p>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {latencyTiles.map((s) => (
            <div key={s.label} className="rounded-lg border border-border bg-muted/30 p-3">
              <p className="text-xs uppercase text-muted-foreground">{s.label}</p>
              <p className="mt-1 text-xl font-black tabular-nums">
                {s.value == null ? <Unknown hint="Not enough measurable entries in this range." /> : s.value}
              </p>
            </div>
          ))}
        </div>

        {latency.unmeasurable > 0 && (
          <p className="text-xs text-muted-foreground">
            {latency.measured === 0
              ? `None of the ${latency.unmeasurable} reviewed entries in this range can be timed — they were submitted before submit times were recorded. Latency will fill in as new entries are submitted.`
              : `${latency.measured} of ${latency.measured + latency.unmeasurable} reviewed entries can be timed; the rest were submitted before submit times were recorded and are excluded rather than guessed at.`}{" "}
            The breach rate above is unaffected — it reads the approval deadline, which has always been stored.
          </p>
        )}
        {data.truncated && (
          <p className="text-xs text-warning-ink">
            Latency is measured over the most recent reviewed entries only — this range holds more than the report reads at
            once. Narrow the range for a complete figure. Hours, utilisation and the activity mix are complete.
          </p>
        )}

        {latency.byApprover.length > 0 && (
          <div className="max-w-full overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  <th scope="col" className="px-3 py-2 text-left font-semibold">Approver</th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">Reviewed</th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">Median time</th>
                </tr>
              </thead>
              <tbody>
                {latency.byApprover.map((a) => (
                  <tr key={a.approverId} className="border-b border-border last:border-0">
                    <td className="px-3 py-2 font-medium">{a.name}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{formatNumber(a.reviewed)}</td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums">{formatHours(a.medianHours)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <InactivePeopleNote count={latency.hiddenInactiveApprovers} className="px-0 pb-0 pt-0" />
      </div>

      {/* ---------------------------------------------------------------- activity mix */}
      <div className="grid gap-2">
        <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Activity className="h-3.5 w-3.5" />
          Where the logged hours went
        </p>
        {mix.length === 0 ? (
          <EmptyState compact title="No logged hours in this range" />
        ) : (
          <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
            <div className="h-56" role="img" aria-label={mixSummary}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart accessibilityLayer>
                  <Pie data={mix} dataKey="hours" nameKey="activity" innerRadius="45%" outerRadius="80%" paddingAngle={2}>
                    {mix.map((row, i) => (
                      <Cell key={row.activity} fill={SERIES_COLORS[i % SERIES_COLORS.length]} />
                    ))}
                  </Pie>
                  <RTooltip {...TOOLTIP_STYLE} formatter={(v: number, name: string) => [formatHours(v), name]} />
                  <Legend formatter={(value: string) => <span className="text-xs">{value}</span>} />
                </PieChart>
              </ResponsiveContainer>
            </div>

            <div className="max-w-full overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/40">
                    <th scope="col" className="px-3 py-2 text-left font-semibold">Activity</th>
                    <th scope="col" className="px-3 py-2 text-right font-semibold">Hours</th>
                    <th scope="col" className="px-3 py-2 text-right font-semibold">Share</th>
                    <th scope="col" className="px-3 py-2 text-right font-semibold">Billed cost</th>
                  </tr>
                </thead>
                <tbody>
                  {mix.map((row, i) => (
                    <tr key={row.activity} className="border-b border-border last:border-0">
                      <td className="px-3 py-2">
                        <span className="flex items-center gap-2">
                          <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} aria-hidden />
                          <span className="font-medium">{row.activity}</span>
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatHours(row.hours)}</td>
                      <td className="px-3 py-2 text-right font-semibold tabular-nums">{formatPercent(row.sharePct, 1)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {row.costByCurrency.length === 0 ? (
                          <Unknown hint={`No rate recorded on any of these ${row.unratedEntries} entries.`} />
                        ) : (
                          <span title={row.unratedEntries > 0 ? `${row.unratedEntries} entries carry no rate and are not in this figure.` : undefined}>
                            {costLabel(row.costByCurrency)}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Cost is the rate frozen on each entry when it was approved, in that project&apos;s billing currency. Amounts in
          different currencies are listed side by side, never added together.
        </p>
      </div>
    </>
  );
}
