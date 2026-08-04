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
 * knows what they are looking at.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip as RTooltip } from "recharts";
import { Activity, Clock, Gauge, HelpCircle } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Skeleton } from "./ui/skeleton";
import { reportApi } from "../services/api";
import { cn } from "../lib/utils";

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
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return {
    from: iso(new Date(now.getFullYear(), now.getMonth(), 1)),
    to: iso(new Date(now.getFullYear(), now.getMonth() + 1, 0))
  };
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

  const data = analytics.data;
  const mix = useMemo(() => data?.activityMix ?? [], [data?.activityMix]);
  const latency = data?.approvalLatency;

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
        <div className="flex shrink-0 flex-wrap gap-2">
          <div className="grid gap-1">
            <Label htmlFor="analytics-from" className="text-xs">From</Label>
            <Input
              id="analytics-from"
              type="date"
              className="h-9 w-[9.5rem]"
              value={range.from}
              onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="analytics-to" className="text-xs">To</Label>
            <Input
              id="analytics-to"
              type="date"
              className="h-9 w-[9.5rem]"
              value={range.to}
              onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
            />
          </div>
        </div>
      </CardHeader>

      <CardContent className="grid gap-6">
        {analytics.isLoading && <Skeleton className="h-64 w-full" />}

        {!analytics.isLoading && data && (
          <>
            <p className="text-xs text-muted-foreground">
              {data.range.workingDays} working days in this range · {data.totals.entries} entries ·{" "}
              {data.totals.people} {data.totals.people === 1 ? "person" : "people"}
            </p>

            {/* ---------------------------------------------------------------- utilisation */}
            <div className="grid gap-2">
              <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <Gauge className="h-3.5 w-3.5" />
                Utilisation — logged hours against contracted capacity
              </p>
              <div className="max-w-full overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/40">
                      <th scope="col" className="px-3 py-2 text-left font-semibold">Person</th>
                      <th scope="col" className="px-3 py-2 text-right font-semibold">Logged</th>
                      <th scope="col" className="px-3 py-2 text-right font-semibold">Capacity</th>
                      <th scope="col" className="px-3 py-2 text-right font-semibold">Utilisation</th>
                      <th scope="col" className="px-3 py-2 text-right font-semibold">Billable</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.utilisation.map((row) => (
                      <tr key={row.userId} className="border-b border-border last:border-0">
                        <td className="px-3 py-2 font-medium">{row.name}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{row.loggedHours.toFixed(2)}h</td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {row.capacityHours === null ? (
                            <Unknown hint="No contracted capacity on file for this person, and no workspace default." />
                          ) : (
                            `${row.capacityHours.toFixed(0)}h`
                          )}
                        </td>
                        <td className={cn("px-3 py-2 text-right font-semibold tabular-nums", utilisationTone(row.utilisationPct))}>
                          {row.utilisationPct === null ? (
                            <Unknown hint="Cannot be computed without a capacity figure." />
                          ) : (
                            `${row.utilisationPct}%`
                          )}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {row.billableUtilisationPct === null ? "—" : `${row.billableUtilisationPct}%`}
                        </td>
                      </tr>
                    ))}
                    {data.utilisation.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-3 py-6 text-center text-sm text-muted-foreground">
                          Nobody logged time in this range.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-muted-foreground">
                Capacity is each person's contracted weekly hours scaled to the working days in this range, reduced by
                their expected utilisation — the same figure the workload board uses, so the two cannot disagree.
              </p>
            </div>

            {/* ---------------------------------------------------------------- approvals */}
            <div className="grid gap-2">
              <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <Clock className="h-3.5 w-3.5" />
                Approval latency
              </p>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {[
                  { label: "Median", value: latency?.medianHours, suffix: "h" },
                  { label: "90th percentile", value: latency?.p90Hours, suffix: "h" },
                  { label: "Slowest", value: latency?.slowestHours, suffix: "h" },
                  { label: "SLA breach rate", value: latency?.breachRatePct, suffix: "%" }
                ].map((s) => (
                  <div key={s.label} className="rounded-lg border border-border bg-muted/30 p-3">
                    <p className="text-xs uppercase text-muted-foreground">{s.label}</p>
                    <p className="mt-1 text-xl font-black tabular-nums">
                      {s.value == null ? (
                        <Unknown hint="Not enough measurable entries in this range." />
                      ) : (
                        `${s.value}${s.suffix}`
                      )}
                    </p>
                  </div>
                ))}
              </div>

              {latency && latency.unmeasurable > 0 && (
                <p className="text-xs text-muted-foreground">
                  {latency.measured === 0
                    ? `None of the ${latency.unmeasurable} reviewed entries in this range can be timed — they were submitted before submit times were recorded. Latency will fill in as new entries are submitted.`
                    : `${latency.measured} of ${latency.measured + latency.unmeasurable} reviewed entries can be timed; the rest were submitted before submit times were recorded and are excluded rather than guessed at.`}{" "}
                  The breach rate above is unaffected — it reads the approval deadline, which has always been stored.
                </p>
              )}

              {latency && latency.byApprover.length > 0 && (
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
                          <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{a.reviewed}</td>
                          <td className="px-3 py-2 text-right font-semibold tabular-nums">
                            {a.medianHours === null ? "—" : `${a.medianHours}h`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* ---------------------------------------------------------------- activity mix */}
            <div className="grid gap-2">
              <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <Activity className="h-3.5 w-3.5" />
                Where the hours went
              </p>
              {mix.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">No entries in this range.</p>
              ) : (
                <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
                  <div className="h-56">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie data={mix} dataKey="hours" nameKey="activity" innerRadius="45%" outerRadius="80%" paddingAngle={2}>
                          {mix.map((row, i) => (
                            <Cell key={row.activity} fill={SERIES_COLORS[i % SERIES_COLORS.length]} />
                          ))}
                        </Pie>
                        <RTooltip
                          {...TOOLTIP_STYLE}
                          formatter={(v: number, name: string) => [`${v.toFixed(2)}h`, name]}
                        />
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
                          <th scope="col" className="px-3 py-2 text-right font-semibold">Cost</th>
                        </tr>
                      </thead>
                      <tbody>
                        {mix.map((row, i) => (
                          <tr key={row.activity} className="border-b border-border last:border-0">
                            <td className="px-3 py-2">
                              <span className="flex items-center gap-2">
                                <span
                                  className="h-2.5 w-2.5 shrink-0 rounded-sm"
                                  style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }}
                                  aria-hidden
                                />
                                <span className="font-medium">{row.activity}</span>
                              </span>
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">{row.hours.toFixed(2)}h</td>
                            <td className="px-3 py-2 text-right font-semibold tabular-nums">{row.sharePct}%</td>
                            <td className="px-3 py-2 text-right tabular-nums">
                              {row.cost === null ? (
                                <Unknown hint={`No rate recorded on any of these ${row.unratedEntries} entries.`} />
                              ) : (
                                row.cost.toFixed(2)
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
