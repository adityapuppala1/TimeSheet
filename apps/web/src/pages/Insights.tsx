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
import { AlertTriangle, BarChart3, Clock, DollarSign, MessageSquare, RotateCcw, Trophy } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
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
import { Skeleton } from "../components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { reportApi, settingsApi } from "../services/api";

const AXIS_STYLE = { stroke: "hsl(var(--muted-foreground))", fontSize: 12 };
const TOOLTIP_STYLE = {
  contentStyle: { background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, color: "hsl(var(--popover-foreground))" }
};
const GRID_STYLE = { strokeDasharray: "3 3", stroke: "hsl(var(--border))" };

// Fixed categorical order — never reassigned by rank, only by which series a color names.
const SERIES_COLOR = { created: "hsl(var(--primary))", resolved: "hsl(var(--info))", estimated: "hsl(var(--primary))", actual: "hsl(var(--info))" };
// Status colors (state, not identity) — reserved, never reused as a generic categorical hue.
const STATUS_COLOR = { compliant: "hsl(var(--success))", breached: "hsl(var(--destructive))" };

function formatWeek(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function StatTile({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: string; tone?: "warning" | "destructive" }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 pt-6">
        <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg ${tone === "destructive" ? "bg-destructive/10 text-destructive" : tone === "warning" ? "bg-warning/10 text-warning" : "bg-primary/10 text-primary"}`}>
          {icon}
        </div>
        <div className="min-w-0">
          <p className="truncate text-xs text-muted-foreground">{label}</p>
          <p className="text-xl font-black tracking-tight">{value}</p>
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

export function Insights() {
  const insights = useQuery({ queryKey: ["reports", "ticket-insights"], queryFn: reportApi.ticketInsights });
  const ticketSettings = useQuery({ queryKey: ["settings", "ticketing"], queryFn: settingsApi.getTicketing });

  const costInsights = useQuery({
    queryKey: ["reports", "cost-insights"],
    queryFn: reportApi.costInsights,
    enabled: Boolean(ticketSettings.data?.enableCostAnalytics)
  });
  const leaderboard = useQuery({
    queryKey: ["reports", "leaderboard"],
    queryFn: reportApi.leaderboard,
    enabled: Boolean(ticketSettings.data?.enableLeaderboard)
  });

  const data = insights.data;
  const maxHeatCell = Math.max(1, ...(data?.workloadHeatmap.rows.flatMap((r) => r.cells.map((c) => c.openCount)) ?? [1]));

  return (
    <div className="grid gap-5">
      <div className="flex items-center gap-3">
        <div className="grid h-10 w-10 place-items-center rounded-lg bg-primary/10 text-primary">
          <BarChart3 className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-black tracking-tight">Insights</h1>
          <p className="mt-1 text-sm text-muted-foreground">Ticket velocity, SLA health, workload, and quality signals across the workspace.</p>
        </div>
      </div>

      {insights.isLoading && <Skeleton className="h-24 w-full" />}

      {data && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-4">
            <StatTile
              icon={<RotateCcw className="h-4 w-4" />}
              label="Reopen rate"
              value={data.reopenRate.pct === null ? "n/a" : `${data.reopenRate.pct}%`}
              tone={data.reopenRate.pct !== null && data.reopenRate.pct > 20 ? "warning" : undefined}
            />
            <StatTile
              icon={<MessageSquare className="h-4 w-4" />}
              label="Avg. first response"
              value={data.firstResponseHours.avgHours === null ? "n/a" : `${data.firstResponseHours.avgHours}h`}
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

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Ticket velocity</CardTitle>
              <CardDescription>Created vs. resolved, by week — a gap widening on "created" is a growing backlog.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={data.velocity.map((w) => ({ ...w, label: formatWeek(w.weekStart) }))}>
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

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">SLA compliance</CardTitle>
                <CardDescription>Resolutions per week that beat their due date vs. missed it.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data.slaCompliance.map((w) => ({ ...w, label: formatWeek(w.weekStart) }))}>
                      <CartesianGrid {...GRID_STYLE} />
                      <XAxis dataKey="label" {...AXIS_STYLE} />
                      <YAxis {...AXIS_STYLE} allowDecimals={false} />
                      <RTooltip {...TOOLTIP_STYLE} />
                      <Legend wrapperStyle={{ fontSize: 12, color: "hsl(var(--muted-foreground))" }} />
                      <Bar dataKey="compliant" name="Within SLA" stackId="s" fill={STATUS_COLOR.compliant} radius={[0, 0, 0, 0]} />
                      <Bar dataKey="breached" name="Breached" stackId="s" fill={STATUS_COLOR.breached} radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Cycle time distribution</CardTitle>
                <CardDescription>How long resolved tickets took, created-to-resolved (last 300).</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data.cycleTimeHistogram}>
                      <CartesianGrid {...GRID_STYLE} />
                      <XAxis dataKey="bucket" {...AXIS_STYLE} />
                      <YAxis {...AXIS_STYLE} allowDecimals={false} />
                      <RTooltip {...TOOLTIP_STYLE} />
                      <Bar dataKey="count" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
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
                <p className="py-6 text-center text-sm text-muted-foreground">No tickets have a module assigned yet.</p>
              ) : (
                <div className="h-80">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data.hotspotByModule} layout="vertical" margin={{ left: 24 }}>
                      <CartesianGrid {...GRID_STYLE} horizontal={false} />
                      <XAxis type="number" {...AXIS_STYLE} allowDecimals={false} />
                      <YAxis type="category" dataKey="moduleName" {...AXIS_STYLE} width={140} />
                      <RTooltip
                        {...TOOLTIP_STYLE}
                        formatter={(value: number, _name, entry: any) => [value, entry.payload.projectName]}
                      />
                      <Bar dataKey="count" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Workload heatmap</CardTitle>
              <CardDescription>Open tickets per assignee, by week — darker means more open work in that week.</CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              {data.workloadHeatmap.rows.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">No assigned tickets yet.</p>
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
                        {row.cells.map((cell) => (
                          <TableCell key={cell.weekStart} className="text-center text-xs" style={{ backgroundColor: heatColor(cell.openCount, maxHeatCell) }}>
                            <div className="font-semibold">{cell.openCount}</div>
                            <div className="text-muted-foreground">{cell.hoursLogged}h</div>
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {data.estimateVsActual.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Estimate vs. actual</CardTitle>
                <CardDescription>Tickets with an estimate and logged time, ranked by the biggest variance.</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Ticket</TableHead>
                      <TableHead>Estimated</TableHead>
                      <TableHead>Actual</TableHead>
                      <TableHead>Variance</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.estimateVsActual.slice(0, 15).map((row) => (
                      <TableRow key={row.ticketKey}>
                        <TableCell>
                          <span className="font-mono text-xs text-muted-foreground">{row.ticketKey}</span>{" "}
                          <span className="truncate">{row.title}</span>
                        </TableCell>
                        <TableCell>{row.estimatedHours.toFixed(1)}h</TableCell>
                        <TableCell>{row.actualHours.toFixed(1)}h</TableCell>
                        <TableCell className={row.varianceHours > 0 ? "text-destructive" : "text-success"}>
                          {row.varianceHours > 0 ? "+" : ""}
                          {row.varianceHours.toFixed(1)}h
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </>
      )}

      {ticketSettings.data?.enableCostAnalytics && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><DollarSign className="h-4 w-4 text-primary" />Cost per ticket</CardTitle>
            <CardDescription>Opt-in — computed from logged hours x each contributor's hourly rate.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {costInsights.isLoading && <Skeleton className="h-24 w-full" />}
            {costInsights.data && (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="rounded-lg border border-border bg-muted/30 p-4">
                    <p className="text-xs uppercase text-muted-foreground">Total cost (top tickets)</p>
                    <p className="mt-1 text-2xl font-black">${costInsights.data.totalCostUsd.toFixed(2)}</p>
                  </div>
                  <div className="rounded-lg border border-border bg-muted/30 p-4">
                    <p className="text-xs uppercase text-muted-foreground">Avg. cost per ticket</p>
                    <p className="mt-1 text-2xl font-black">${costInsights.data.avgCostPerTicket.toFixed(2)}</p>
                  </div>
                </div>
                {costInsights.data.rows.length > 0 && (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Ticket</TableHead>
                        <TableHead>Hours</TableHead>
                        <TableHead>Cost</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {costInsights.data.rows.slice(0, 10).map((row) => (
                        <TableRow key={row.ticketKey}>
                          <TableCell>
                            <span className="font-mono text-xs text-muted-foreground">{row.ticketKey}</span> {row.title}
                          </TableCell>
                          <TableCell>{row.hours.toFixed(1)}h</TableCell>
                          <TableCell>${row.costUsd.toFixed(2)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      {ticketSettings.data?.enableLeaderboard && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><Trophy className="h-4 w-4 text-primary" />Team leaderboard</CardTitle>
            <CardDescription>Opt-in — resolved-ticket counts and average cycle time, for recognition.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {leaderboard.isLoading && <Skeleton className="h-24 w-full" />}
            {leaderboard.data && leaderboard.data.rows.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Rank</TableHead>
                    <TableHead>Teammate</TableHead>
                    <TableHead>Resolved</TableHead>
                    <TableHead>Avg. cycle time</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {leaderboard.data.rows.map((row, i) => (
                    <TableRow key={row.assigneeId}>
                      <TableCell>
                        {i === 0 ? <Badge variant="success">#1</Badge> : <span className="text-muted-foreground">#{i + 1}</span>}
                      </TableCell>
                      <TableCell className="font-medium">{row.assigneeName}</TableCell>
                      <TableCell>{row.resolvedCount}</TableCell>
                      <TableCell>{row.avgCycleHours}h</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {leaderboard.data && leaderboard.data.rows.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">No resolved tickets yet.</p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
