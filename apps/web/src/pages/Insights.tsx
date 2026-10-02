/**
 * Analytics & Insights dashboard — velocity, SLA compliance, cycle time, module hotspots,
 * per-assignee workload, estimate-vs-actual, plus two opt-in sections (cost-per-ticket,
 * team leaderboard) that only render once their GlobalTicketSettings toggle is on.
 *
 * WHY these specific color choices: built per this repo's `dataviz` skill — categorical color
 * is assigned in a fixed order and never re-cycled (created=primary, resolved=info), status
 * pairs (compliant/breached) use reserved status colors instead of generic categorical hues,
 * and magnitude-only charts (cycle time, hotspot) use a single sequential hue rather than
 * coloring bars by rank. See `heatColor()` for the workload heatmap's light->dark single-hue
 * intensity scale.
 */
import { useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { AlertTriangle, BarChart3, Clock, DollarSign, MessageSquare, RotateCcw, Trophy } from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis
} from "recharts";
import { Badge } from "../components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { DataTable } from "../components/ui/data-table";
import { Skeleton } from "../components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { InactivePeopleNote } from "../components/InactivePeopleNote";
import { QueryError } from "../components/QueryState";
import { formatDayMonth, formatHours, formatMoney, formatNumber, formatPercent, NO_VALUE } from "../lib/format";
import { reportApi, settingsApi, type CostInsights } from "../services/api";
import { PageHeader } from "../components/PageHeader";
import { EmptyState } from "../components/ui/empty-state";

const estimateVsActualColumns: ColumnDef<any, any>[] = [
  {
    id: "ticket",
    accessorFn: (row: any) => row.ticketKey,
    header: "Ticket",
    cell: ({ row }) => (
      <>
        <span className="font-mono text-xs text-muted-foreground">{row.original.ticketKey}</span>{" "}
        <span className="truncate">{row.original.title}</span>
      </>
    )
  },
  {
    id: "estimated",
    accessorFn: (row: any) => row.estimatedHours,
    header: "Estimated",
    cell: ({ row }) => formatHours(row.original.estimatedHours)
  },
  {
    id: "actual",
    accessorFn: (row: any) => row.actualHours,
    header: "Actual",
    cell: ({ row }) => formatHours(row.original.actualHours)
  },
  {
    id: "variance",
    accessorFn: (row: any) => row.varianceHours,
    header: "Variance",
    cell: ({ row }) => (
      <span className={row.original.varianceHours > 0 ? "text-destructive" : "text-success"}>
        {row.original.varianceHours > 0 ? "+" : ""}
        {formatHours(row.original.varianceHours)}
      </span>
    )
  }
];

const costColumns: ColumnDef<any, any>[] = [
  {
    id: "ticket",
    accessorFn: (row: any) => row.ticketKey,
    header: "Ticket",
    cell: ({ row }) => (
      <>
        <span className="font-mono text-xs text-muted-foreground">{row.original.ticketKey}</span> {row.original.title}
      </>
    )
  },
  { id: "hours", accessorFn: (row: any) => row.hours, header: "Hours", cell: ({ row }) => formatHours(row.original.hours) },
  // In the ticket's own billing currency — the "$" this used to hardcode was wrong for every other one.
  { id: "cost", accessorFn: (row: any) => row.cost, header: "Cost", cell: ({ row }) => formatMoney(row.original.cost, row.original.currency) }
];

const leaderboardColumns: ColumnDef<any, any>[] = [
  {
    id: "rank",
    accessorFn: (row: any) => row.rank,
    header: "Rank",
    cell: ({ row }) => (row.original.rank === 1 ? <Badge variant="success">#1</Badge> : <span className="text-muted-foreground">#{row.original.rank}</span>)
  },
  { id: "teammate", accessorFn: (row: any) => row.assigneeName, header: "Teammate", cell: ({ row }) => <span className="font-medium">{row.original.assigneeName}</span> },
  { id: "resolved", accessorFn: (row: any) => row.resolvedCount, header: "Resolved" },
  { id: "medianCycle", accessorFn: (row: any) => row.medianCycleHours, header: "Median cycle time", cell: ({ row }) => formatHours(row.original.medianCycleHours) }
];

const AXIS_STYLE = { stroke: "hsl(var(--muted-foreground))", fontSize: 12 };
const TOOLTIP_STYLE = {
  contentStyle: { background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, color: "hsl(var(--popover-foreground))" }
};
const GRID_STYLE = { strokeDasharray: "3 3", stroke: "hsl(var(--border))" };

// Fixed categorical order — never reassigned by rank, only by which series a color names.
const SERIES_COLOR = { created: "hsl(var(--primary))", resolved: "hsl(var(--info))", estimated: "hsl(var(--primary))", actual: "hsl(var(--info))" };
// Status colors (state, not identity) — reserved, never reused as a generic categorical hue.
const STATUS_COLOR = { compliant: "hsl(var(--success))", breached: "hsl(var(--destructive))" };
// Ticket lifecycle status colors — same "state, not identity" convention: OPEN/IN_PROGRESS/
// IN_REVIEW read as in-flight (info/primary/warning), RESOLVED reads as success, CLOSED reads
// as neutral/archived (muted), REOPENED reuses the destructive/warning-adjacent hue since it's
// the same "something went wrong" signal the reopen-rate stat tile already flags.
const TICKET_STATUS_COLOR: Record<string, string> = {
  OPEN: "hsl(var(--info))",
  IN_PROGRESS: "hsl(var(--primary))",
  IN_REVIEW: "hsl(var(--warning))",
  RESOLVED: "hsl(var(--success))",
  CLOSED: "hsl(var(--muted-foreground))",
  REOPENED: "hsl(var(--destructive))"
};
const TICKET_STATUS_LABEL: Record<string, string> = {
  OPEN: "Open",
  IN_PROGRESS: "In progress",
  IN_REVIEW: "In review",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
  REOPENED: "Reopened"
};

/** A week's label. The API sends the IST day its Monday falls on; parsed as UTC midnight it named the
 *  Sunday before anywhere west of Greenwich. */
function formatWeek(dayKey: string) {
  return formatDayMonth(dayKey);
}

/** One sentence a screen reader can say instead of a chart (WCAG 1.1.1). */
function seriesSummary(title: string, rows: Array<{ label: string; parts: Array<[string, number]> }>): string {
  return title + ": " + rows.map((r) => r.label + " — " + r.parts.map(([name, v]) => name + " " + formatNumber(v)).join(", ")).join("; ") + ".";
}

function StatTile({ icon, label, value, tone, detail }: { icon: React.ReactNode; label: string; value: string; tone?: "warning" | "destructive"; detail?: string }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 pt-6">
        <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg ${tone === "destructive" ? "bg-destructive/10 text-destructive-ink" : tone === "warning" ? "bg-warning/10 text-warning-ink" : "bg-primary/10 text-primary"}`}>
          {icon}
        </div>
        <div className="min-w-0">
          <p className="truncate text-xs text-muted-foreground">{label}</p>
          <p className="text-xl font-black tracking-tight">{value}</p>
          {detail && <p className="text-[11px] leading-snug text-muted-foreground">{detail}</p>}
        </div>
      </CardContent>
    </Card>
  );
}

/** Single sequential hue, light -> dark, driven by value / max — never a second hue. */
function heatColor(value: number, max: number): string {
  if (max <= 0 || value <= 0) return "transparent";
  const intensity = Math.min(1, value / max);
  return `hsl(var(--primary) / ${0.12 + intensity * 0.68})`;
}

/** Text that stays readable on the cell: on the darker half of the scale the default foreground
 *  measured about 1.8:1 against the fill, so those cells switch to the primary's own foreground. */
function heatTextClass(value: number, max: number): { strong: string; soft: string } {
  if (max > 0 && value / max > 0.5) return { strong: "text-primary-foreground", soft: "text-primary-foreground/85" };
  return { strong: "", soft: "text-muted-foreground" };
}

/** Cost totals, one line per currency — never one figure across currencies. */
function CostTotals({ totals }: { totals: CostInsights["totalsByCurrency"] }) {
  if (totals.length === 0) return <p className="mt-1 text-2xl font-black">{NO_VALUE}</p>;
  return (
    <div className="mt-1 grid gap-0.5">
      {totals.map((t) => (
        <p key={t.currency} className="text-2xl font-black tabular-nums">
          {formatMoney(t.total, t.currency)}
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {formatNumber(t.tickets)} ticket{t.tickets === 1 ? "" : "s"} · avg {formatMoney(t.avgPerTicket, t.currency)}
          </span>
        </p>
      ))}
    </div>
  );
}

export function Insights() {
  const insights = useQuery({ queryKey: ["reports", "ticket-insights"], queryFn: reportApi.ticketInsights });
  const ticketSummary = useQuery({ queryKey: ["reports", "ticket-summary"], queryFn: reportApi.tickets });
  // Reads the auth-safe `/settings/effective-flags` projection, NOT `/settings/ticketing` —
  // Insights is REPORTS_VIEW-gated (managers/leads reach it), and the full ticketing settings
  // route is super-admin-only.
  const workspaceFlags = useQuery({ queryKey: ["settings", "effective-flags"], queryFn: settingsApi.getEffectiveFlags });

  const costInsights = useQuery({
    queryKey: ["reports", "cost-insights"],
    queryFn: reportApi.costInsights,
    enabled: Boolean(workspaceFlags.data?.enableCostAnalytics)
  });
  const leaderboard = useQuery({
    queryKey: ["reports", "leaderboard"],
    queryFn: reportApi.leaderboard,
    enabled: Boolean(workspaceFlags.data?.enableLeaderboard)
  });

  const data = insights.data;
  const maxHeatCell = Math.max(1, ...(data?.workloadHeatmap.rows.flatMap((r) => r.cells.map((c) => c.openCount)) ?? [1]));

  return (
    <div className="grid gap-5">
      <PageHeader
        title="Insights"
        icon={BarChart3}
        description="Ticket velocity, SLA health, workload, and quality signals across the workspace."
      />

      {insights.isLoading && <Skeleton className="h-24 w-full" />}
      {/* No data is not zero: a failed request says so and offers a retry instead of a blank page. */}
      {insights.isError && !insights.data && <QueryError what="the ticket insights" onRetry={() => insights.refetch()} />}

      {data && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-4">
            <StatTile
              icon={<RotateCcw className="h-4 w-4" />}
              label="Reopen rate (8wk)"
              value={formatPercent(data.reopenRate.pct)}
              tone={data.reopenRate.pct !== null && data.reopenRate.pct > 20 ? "warning" : undefined}
              detail={`${formatNumber(data.reopenRate.reopenedCount)} of ${formatNumber(data.reopenRate.everResolvedCount)} resolved tickets reopened afterwards`}
            />
            {/* The median, over tickets raised in the window, counting only a reply by someone other
                than the reporter, an AI agent or an intake/system account — and saying how many have
                had no reply at all, rather than dropping them. */}
            <StatTile
              icon={<MessageSquare className="h-4 w-4" />}
              label="Median first response (8wk)"
              value={formatHours(data.firstResponseHours.medianHours)}
              detail={`${formatNumber(data.firstResponseHours.sampleSize)} answered · ${formatNumber(data.firstResponseHours.unanswered)} with no reply yet`}
            />
            <StatTile
              icon={<Clock className="h-4 w-4" />}
              label="Tickets resolved (8wk)"
              value={String(data.velocity.reduce((s, w) => s + w.resolved, 0))}
            />
            <StatTile
              icon={<AlertTriangle className="h-4 w-4" />}
              label="Tickets created (8wk)"
              value={String(data.velocity.reduce((s, w) => s + w.created, 0))}
            />
          </div>

          {ticketSummary.data && ticketSummary.data.byStatus.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Ticket status mix</CardTitle>
                <CardDescription>Every ticket in the workspace by lifecycle stage — resolved and closed included.</CardDescription>
              </CardHeader>
              <CardContent>
                <div
                  className="h-16"
                  role="img"
                  aria-label={seriesSummary("Tickets by status", [
                    { label: "All tickets", parts: ticketSummary.data.byStatus.map((s) => [TICKET_STATUS_LABEL[s.status] ?? s.status, s._count] as [string, number]) }
                  ])}
                >
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      accessibilityLayer
                      layout="vertical"
                      data={[
                        ticketSummary.data.byStatus.reduce<Record<string, number | string>>(
                          (row, s) => ({ ...row, [s.status]: s._count }),
                          { name: "Tickets" }
                        )
                      ]}
                      margin={{ left: 0, right: 0, top: 0, bottom: 0 }}
                    >
                      <XAxis type="number" hide />
                      <YAxis type="category" dataKey="name" hide />
                      <RTooltip {...TOOLTIP_STYLE} formatter={(value: number, name) => [value, TICKET_STATUS_LABEL[name as string] ?? name]} />
                      {Object.keys(TICKET_STATUS_COLOR).map((status, index, arr) => (
                        <Bar
                          key={status}
                          dataKey={status}
                          name={status}
                          stackId="mix"
                          fill={TICKET_STATUS_COLOR[status]}
                          radius={index === 0 ? [4, 0, 0, 4] : index === arr.length - 1 ? [0, 4, 4, 0] : [0, 0, 0, 0]}
                        />
                      ))}
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
                  {ticketSummary.data.byStatus.map((s) => (
                    <span key={s.status} className="inline-flex items-center gap-1.5">
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: TICKET_STATUS_COLOR[s.status] }} />
                      {TICKET_STATUS_LABEL[s.status] ?? s.status} ({s._count})
                    </span>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Ticket velocity</CardTitle>
              <CardDescription>Created vs. resolved, by week (weeks start Monday) — a gap widening on "created" is a growing backlog.</CardDescription>
            </CardHeader>
            <CardContent>
              <div
                className="h-72"
                role="img"
                aria-label={seriesSummary(
                  "Tickets created and resolved per week",
                  data.velocity.map((w) => ({ label: "week of " + formatWeek(w.weekStart), parts: [["created", w.created], ["resolved", w.resolved]] }))
                )}
              >
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart accessibilityLayer data={data.velocity.map((w) => ({ ...w, label: formatWeek(w.weekStart) }))}>
                    <CartesianGrid {...GRID_STYLE} />
                    <XAxis dataKey="label" {...AXIS_STYLE} />
                    <YAxis {...AXIS_STYLE} allowDecimals={false} />
                    <RTooltip {...TOOLTIP_STYLE} />
                    <Legend wrapperStyle={{ fontSize: 12, color: "hsl(var(--muted-foreground))" }} />
                    <Line type="monotone" dataKey="created" name="Created" stroke={SERIES_COLOR.created} strokeWidth={2} dot={{ r: 4 }} />
                    <Line type="monotone" dataKey="resolved" name="Resolved" stroke={SERIES_COLOR.resolved} strokeWidth={2} dot={{ r: 4 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Cumulative flow</CardTitle>
              <CardDescription>Running totals of created vs. resolved — the gap between the two lines is your current backlog size.</CardDescription>
            </CardHeader>
            <CardContent>
              <div
                className="h-72"
                role="img"
                aria-label={`Cumulative tickets over the last ${data.velocity.length} weeks: ${formatNumber(data.velocity.reduce((s, w) => s + w.created, 0))} created and ${formatNumber(data.velocity.reduce((s, w) => s + w.resolved, 0))} resolved.`}
              >
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart
                    accessibilityLayer
                    data={data.velocity.reduce<Array<{ label: string; created: number; resolved: number }>>((rows, w) => {
                      const prevCreated = rows.at(-1)?.created ?? 0;
                      const prevResolved = rows.at(-1)?.resolved ?? 0;
                      rows.push({ label: formatWeek(w.weekStart), created: prevCreated + w.created, resolved: prevResolved + w.resolved });
                      return rows;
                    }, [])}
                  >
                    <CartesianGrid {...GRID_STYLE} />
                    <XAxis dataKey="label" {...AXIS_STYLE} />
                    <YAxis {...AXIS_STYLE} allowDecimals={false} />
                    <RTooltip {...TOOLTIP_STYLE} />
                    <Legend wrapperStyle={{ fontSize: 12, color: "hsl(var(--muted-foreground))" }} />
                    <Area type="monotone" dataKey="created" name="Created (cumulative)" stroke={SERIES_COLOR.created} fill={SERIES_COLOR.created} fillOpacity={0.15} strokeWidth={2} />
                    <Area type="monotone" dataKey="resolved" name="Resolved (cumulative)" stroke={SERIES_COLOR.resolved} fill={SERIES_COLOR.resolved} fillOpacity={0.25} strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">SLA compliance</CardTitle>
                <CardDescription>
                  Resolutions per week that met their due date vs. were resolved after it. Tickets without a due date are not counted.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div
                  className="h-64"
                  role="img"
                  aria-label={seriesSummary(
                    "Resolutions within and outside their SLA per week",
                    data.slaCompliance.map((w) => ({ label: "week of " + formatWeek(w.weekStart), parts: [["within SLA", w.compliant], ["breached", w.breached]] }))
                  )}
                >
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart accessibilityLayer data={data.slaCompliance.map((w) => ({ ...w, label: formatWeek(w.weekStart) }))}>
                      <CartesianGrid {...GRID_STYLE} />
                      <XAxis dataKey="label" {...AXIS_STYLE} />
                      <YAxis {...AXIS_STYLE} allowDecimals={false} />
                      <RTooltip {...TOOLTIP_STYLE} />
                      <Legend wrapperStyle={{ fontSize: 12, color: "hsl(var(--muted-foreground))" }} />
                      <Bar dataKey="compliant" name="Within SLA" stackId="s" fill={STATUS_COLOR.compliant} radius={[0, 0, 0, 0]} />
                      <Bar dataKey="breached" name="Breached" stackId="s" fill={STATUS_COLOR.breached} radius={[4, 4, 0, 0]}>
                        {/* The stack TOTAL, above the whole bar — labeling each segment would put
                            two numbers per week in a 64px-tall chart. Rides the top Bar because
                            that's where recharts anchors "top" for a stack. */}
                        <LabelList
                          position="top"
                          fill="hsl(var(--muted-foreground))"
                          fontSize={11}
                          valueAccessor={(entry: any) => {
                            const total = Number(entry?.payload?.compliant ?? 0) + Number(entry?.payload?.breached ?? 0);
                            return total > 0 ? total : "";
                          }}
                        />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Cycle time distribution</CardTitle>
                <CardDescription>How long tickets resolved in the last {data.velocity.length} weeks took, created to resolved.</CardDescription>
              </CardHeader>
              <CardContent>
                <div
                  className="h-64"
                  role="img"
                  aria-label={seriesSummary("Resolved tickets by cycle time", [{ label: "Tickets", parts: data.cycleTimeHistogram.map((b) => [b.bucket, b.count] as [string, number]) }])}
                >
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart accessibilityLayer data={data.cycleTimeHistogram}>
                      <CartesianGrid {...GRID_STYLE} />
                      <XAxis dataKey="bucket" {...AXIS_STYLE} />
                      <YAxis {...AXIS_STYLE} allowDecimals={false} />
                      <RTooltip {...TOOLTIP_STYLE} />
                      <Bar dataKey="count" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]}>
                        <LabelList
                          dataKey="count"
                          position="top"
                          fill="hsl(var(--muted-foreground))"
                          fontSize={11}
                          formatter={(value: number) => (value > 0 ? value : "")}
                        />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Bug hotspot by module</CardTitle>
              <CardDescription>Which modules generate the most tickets — top 10.</CardDescription>
            </CardHeader>
            <CardContent>
              {data.hotspotByModule.length === 0 ? (
                <EmptyState compact title="No module data yet" description="Hotspots appear once tickets carry a module." />
              ) : (
                <div
                  className="h-80"
                  role="img"
                  aria-label={seriesSummary("Tickets by module", [{ label: "Top modules", parts: data.hotspotByModule.map((m) => [m.moduleName, m.count] as [string, number]) }])}
                >
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart accessibilityLayer data={data.hotspotByModule} layout="vertical" margin={{ left: 24 }}>
                      <CartesianGrid {...GRID_STYLE} horizontal={false} />
                      <XAxis type="number" {...AXIS_STYLE} allowDecimals={false} />
                      <YAxis type="category" dataKey="moduleName" {...AXIS_STYLE} width={140} />
                      <RTooltip
                        {...TOOLTIP_STYLE}
                        formatter={(value: number, _name, entry: any) => [value, entry.payload.projectName]}
                      />
                      <Bar dataKey="count" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]}>
                        {/* Horizontal bars label at the bar's END — "top" would float mid-air. */}
                        <LabelList
                          dataKey="count"
                          position="right"
                          fill="hsl(var(--muted-foreground))"
                          fontSize={11}
                          formatter={(value: number) => (value > 0 ? value : "")}
                        />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Workload heatmap</CardTitle>
              <CardDescription>
                Open tickets per person, by week, with the hours they logged that week — darker means more open work. People only:
                AI agents are not on it.
              </CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              {data.workloadHeatmap.rows.length === 0 ? (
                <EmptyState compact title="No assigned tickets yet" description="The heatmap fills in as tickets are assigned." className="m-3" />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Assignee</TableHead>
                      {data.workloadHeatmap.weeks.map((w) => (
                        <TableHead key={w} className="text-center">{formatWeek(w)}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.workloadHeatmap.rows.map((row) => (
                      <TableRow key={row.assigneeId}>
                        <TableCell className="font-medium">{row.assigneeName}</TableCell>
                        {row.cells.map((cell) => {
                          const text = heatTextClass(cell.openCount, maxHeatCell);
                          return (
                            <TableCell key={cell.weekStart} className="text-center text-xs" style={{ backgroundColor: heatColor(cell.openCount, maxHeatCell) }}>
                              <div className={`font-semibold ${text.strong}`}>{cell.openCount}</div>
                              <div className={text.soft}>{formatHours(cell.hoursLogged)}</div>
                            </TableCell>
                          );
                        })}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              <InactivePeopleNote count={data.workloadHeatmap.hiddenInactive} />
            </CardContent>
          </Card>

          {data.estimateVsActual.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Estimate vs. actual</CardTitle>
                <CardDescription>Tickets with an estimate and logged time, ranked by the biggest variance.</CardDescription>
              </CardHeader>
              <CardContent className="p-4">
                <DataTable columns={estimateVsActualColumns} data={data.estimateVsActual} enableSearch={false} pageSize={10} />
              </CardContent>
            </Card>
          )}
        </>
      )}

      {workspaceFlags.data?.enableCostAnalytics && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><DollarSign className="h-4 w-4 text-primary" />Cost per ticket</CardTitle>
            <CardDescription>
              Opt-in — approved, billable hours only, priced at the rate frozen when each entry was approved.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {costInsights.isLoading && <Skeleton className="h-24 w-full" />}
            {costInsights.isError && !costInsights.data && <QueryError what="cost per ticket" onRetry={() => costInsights.refetch()} compact />}
            {costInsights.data && (
              <>
                {/* One line per currency. Each entry is priced in its project's billing currency, and
                    rupees and dollars added into one "$" total was the figure this replaced. */}
                <div className="rounded-lg border border-border bg-muted/30 p-4">
                  <p className="text-xs uppercase text-muted-foreground">Total cost, all tickets</p>
                  <CostTotals totals={costInsights.data.totalsByCurrency} />
                </div>
                {/* Explains why these totals are lower than they used to be: unapproved and
                    rejected hours are no longer counted as cost, and hours with no rate on record
                    are reported rather than silently treated as free. */}
                <p className="text-xs text-muted-foreground">
                  Covers {costInsights.data.ticketCount ?? costInsights.data.rows.length} ticket(s)
                  {(costInsights.data.excludedDraftHours ?? 0) + (costInsights.data.excludedRejectedHours ?? 0) > 0 && (
                    <>
                      {" "}— excludes {formatHours(costInsights.data.excludedDraftHours ?? 0)} draft and{" "}
                      {formatHours(costInsights.data.excludedRejectedHours ?? 0)} rejected
                    </>
                  )}
                  {(costInsights.data.unratedHours ?? 0) > 0 && (
                    <>
                      {" "}— {formatHours(costInsights.data.unratedHours ?? 0)} have no rate on record and are not priced
                    </>
                  )}
                  . Table shows the top 25 by cost.
                </p>
                {costInsights.data.rows.length > 0 && (
                  <DataTable columns={costColumns} data={costInsights.data.rows} enableSearch={false} pageSize={10} />
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      {workspaceFlags.data?.enableLeaderboard && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><Trophy className="h-4 w-4 text-primary" />Team leaderboard</CardTitle>
            <CardDescription>
              Opt-in — tickets resolved in the last {leaderboard.data?.windowDays ?? 90} days and the median cycle time, for recognition. People only.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            {leaderboard.isLoading && <Skeleton className="h-24 w-full" />}
            {leaderboard.isError && !leaderboard.data && <QueryError what="the leaderboard" onRetry={() => leaderboard.refetch()} compact />}
            {leaderboard.data && leaderboard.data.rows.length > 0 && (
              <DataTable
                columns={leaderboardColumns}
                data={leaderboard.data.rows.map((row, i) => ({ ...row, rank: i + 1 }))}
                enableSearch={false}
                pageSize={10}
              />
            )}
            {leaderboard.data && leaderboard.data.rows.length === 0 && (
              <EmptyState compact title="No resolved tickets yet" description="The leaderboard counts tickets resolved in this window." />
            )}
            <InactivePeopleNote count={leaderboard.data?.hiddenInactive} className="px-0" />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
