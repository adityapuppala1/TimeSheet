/**
 * WHAT: the "why was it slow, when, and on which server" panel on the Maintenance settings tab.
 * Latency percentiles over time, a per-endpoint breakdown, a per-host/pod split, and a drill-down
 * list of individual requests.
 *
 * HOW IT DIFFERS FROM THE TWO PANELS ABOVE IT, since all three look like "monitoring": the Server
 * health card reports the box RIGHT NOW, the status page reports whether FEATURES worked over days.
 * Neither can answer "which endpoint got slow at 14:20 yesterday, and was it one pod or all of
 * them" — that needs per-request measurement, which is what this reads.
 *
 * WHY PERCENTILES ARE THE HEADLINE AND THE AVERAGE IS A FOOTNOTE: an average is the one number that
 * reliably hides the problem. A handful of eight-second responses disappear into a 120ms mean, and
 * those responses are the whole reason somebody opened this page. p50 is what a typical user feels;
 * the p50→p99 gap is the finding.
 *
 * COLOR, per this repo's `dataviz` skill and the convention already set in pages/Insights.tsx:
 * - p50/p95/p99 are an ORDERED family of one measure, so they are one hue at three intensities
 *   (sequential), never three unrelated categorical colors — the same reasoning as Insights'
 *   `heatColor()`.
 * - ok / 4xx / 5xx are STATE, so they use the reserved status colors and are never reused as
 *   generic series hues.
 * - Every color is a CSS variable, so both themes and any future re-theme follow automatically.
 *
 * WHEN THERE IS NO DATA the panel says whether that is because recording is OFF or because nothing
 * was served — an empty chart that cannot distinguish the two is how a monitoring page gets
 * mistrusted on day one.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, AlertTriangle, Database, Gauge, Server, Timer } from "lucide-react";
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

import { Badge } from "./ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Skeleton } from "./ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { apiPerformanceApi, type ApiRequestQuery } from "../services/api";

/* Shared chart styling — identical objects to pages/Insights.tsx so every chart in the product
   reads as one system rather than one-per-author. */
const AXIS_STYLE = { stroke: "hsl(var(--muted-foreground))", fontSize: 12 };
const TOOLTIP_STYLE = {
  contentStyle: {
    background: "hsl(var(--popover))",
    border: "1px solid hsl(var(--border))",
    borderRadius: 8,
    color: "hsl(var(--popover-foreground))"
  }
};
const GRID_STYLE = { strokeDasharray: "3 3", stroke: "hsl(var(--border))" };

/** Sequential, one hue light→dark: these are three points on ONE distribution, so giving them
 *  three unrelated hues would imply three unrelated measures. Fixed — never reassigned by rank. */
const LATENCY_COLOR = {
  p50: "hsl(var(--primary) / 0.4)",
  p95: "hsl(var(--primary) / 0.7)",
  p99: "hsl(var(--primary))"
} as const;

/** State, not identity — the reserved status palette, never reused for a generic series. */
const OUTCOME_COLOR = {
  ok: "hsl(var(--success))",
  clientErrors: "hsl(var(--warning))",
  serverErrors: "hsl(var(--destructive))"
} as const;

/** Fixed order, so a window with no 5xx does not repaint 4xx in the missing color. */
const STATUS_CLASS_COLOR: Record<string, string> = {
  "1xx": "hsl(var(--muted-foreground))",
  "2xx": "hsl(var(--success))",
  "3xx": "hsl(var(--info))",
  "4xx": "hsl(var(--warning))",
  "5xx": "hsl(var(--destructive))"
};
const STATUS_CLASS_ORDER = ["1xx", "2xx", "3xx", "4xx", "5xx"];

const WINDOWS = [
  { value: "1", label: "Last hour" },
  { value: "6", label: "Last 6 hours" },
  { value: "24", label: "Last 24 hours" },
  { value: "72", label: "Last 3 days" },
  { value: "168", label: "Last 7 days" },
  { value: "720", label: "Last 30 days" }
];

function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

function formatCount(value: number): string {
  return value.toLocaleString();
}

/** Bucket width drives the label: a one-minute bucket needs the clock, a six-hour one needs the
 *  date, and showing both everywhere makes a crowded axis illegible on a phone. */
function formatBucket(iso: string, bucketSeconds: number): string {
  const date = new Date(iso);
  if (bucketSeconds >= 21_600) return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (bucketSeconds >= 3_600) {
    return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit" });
  }
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function statusBadgeVariant(statusCode: number) {
  if (statusCode >= 500) return "destructive" as const;
  if (statusCode >= 400) return "warning" as const;
  return "success" as const;
}

/** Latency is the only thing here worth colouring by threshold, and the thresholds are the ones
 *  a person actually reacts to: sub-second is fine, a second is noticeable, three is a complaint. */
function latencyTone(ms: number): string {
  if (ms >= 3000) return "text-destructive";
  if (ms >= 1000) return "text-warning";
  return "";
}

function StatTile({ icon, label, value, hint, tone }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  tone?: "warning" | "destructive";
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 p-3">
      <div
        className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${
          tone === "destructive"
            ? "bg-destructive/10 text-destructive"
            : tone === "warning"
              ? "bg-warning/10 text-warning"
              : "bg-primary/10 text-primary"
        }`}
      >
        {icon}
      </div>
      <div className="min-w-0">
        <p className="truncate text-xs text-muted-foreground">{label}</p>
        <p className="text-lg font-black tracking-tight tabular-nums">{value}</p>
        {hint && <p className="truncate text-[11px] text-muted-foreground">{hint}</p>}
      </div>
    </div>
  );
}

export function ApiPerformancePanel() {
  const [hours, setHours] = useState("24");
  const [drilldown, setDrilldownRaw] = useState<ApiRequestQuery>({ sort: "slowest", limit: 50, offset: 0 });
  /** Every filter change resets to the first page. Without this, narrowing a filter while on page
   *  four shows an empty table and looks like "no results" rather than "you are past the end". */
  const setDrilldown = (next: ApiRequestQuery) => setDrilldownRaw({ ...next, offset: 0 });

  const overview = useQuery({
    queryKey: ["api-performance", hours],
    queryFn: () => apiPerformanceApi.overview(Number(hours)),
    refetchInterval: 60_000
  });

  const requests = useQuery({
    queryKey: ["api-performance", "requests", hours, drilldown],
    queryFn: () => apiPerformanceApi.requests({ ...drilldown, hours: Number(hours) })
  });

  const data = overview.data;
  const collection = data?.collection;
  const bucketSeconds = data?.window.bucketSeconds ?? 900;

  const latencySeries = (data?.series ?? []).map((point) => ({
    ...point,
    label: formatBucket(point.bucketStart, bucketSeconds),
    ok: point.total - point.clientErrors - point.serverErrors
  }));

  const statusMixRow = (data?.statusMix ?? []).reduce<Record<string, number | string>>(
    (row, entry) => ({ ...row, [entry.statusClass]: entry.total }),
    { name: "Requests" }
  );
  const presentStatusClasses = STATUS_CLASS_ORDER.filter((cls) => (data?.statusMix ?? []).some((s) => s.statusClass === cls));

  /** Top 12 by p95 — a bar chart with 25 categories is a wall, and the full set is in the table
   *  right below it. */
  const slowestChart = (data?.endpoints ?? []).slice(0, 12).map((row) => ({
    ...row,
    label: row.apiName.length > 42 ? `${row.apiName.slice(0, 41)}…` : row.apiName
  }));

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <Gauge className="h-4 w-4" />
            API performance
          </CardTitle>
          <CardDescription>
            Per-request timings — how long endpoints took, how often they failed, and which host or pod served them.
          </CardDescription>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Select value={hours} onValueChange={setHours}>
            <SelectTrigger className="h-9 w-[9.5rem]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {WINDOWS.map((w) => (
                <SelectItem key={w.value} value={w.value}>{w.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>

      <CardContent className="grid min-w-0 gap-5">
        {overview.isLoading && <Skeleton className="h-64 w-full" />}

        {!overview.isLoading && collection && !collection.enabled && (
          <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 text-sm">
              <p className="font-semibold">Request recording is switched off</p>
              <p className="text-xs text-muted-foreground">
                Nothing new is being measured, so anything below is history. Set{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-[11px]">API_TELEMETRY_ENABLED=true</code> in the API's
                environment and restart. On a busy deployment set{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-[11px]">API_TELEMETRY_SAMPLE_RATE</code> to a fraction
                (e.g. 0.1) rather than leaving this off — percentiles from a sample are still percentiles.
              </p>
            </div>
          </div>
        )}

        {!overview.isLoading && data && data.totals.total === 0 && (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            {collection?.enabled
              ? "No requests recorded in this window yet."
              : "No requests were ever recorded — nothing to show until recording is switched on."}
          </p>
        )}

        {!overview.isLoading && data && data.totals.total > 0 && (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              <StatTile icon={<Activity className="h-4 w-4" />} label="Requests" value={formatCount(data.totals.total)} hint={`${formatCount(data.totals.distinctUsers)} distinct users`} />
              <StatTile
                icon={<Timer className="h-4 w-4" />}
                label="p95 latency"
                value={formatMs(data.totals.p95Ms)}
                hint={`p50 ${formatMs(data.totals.p50Ms)} · p99 ${formatMs(data.totals.p99Ms)}`}
                tone={data.totals.p95Ms >= 3000 ? "destructive" : data.totals.p95Ms >= 1000 ? "warning" : undefined}
              />
              <StatTile
                icon={<AlertTriangle className="h-4 w-4" />}
                label="Error rate"
                value={`${data.totals.errorRate}%`}
                hint={`${formatCount(data.totals.serverErrors)} server · ${formatCount(data.totals.clientErrors)} client`}
                tone={data.totals.serverErrors > 0 ? "destructive" : data.totals.errorRate > 5 ? "warning" : undefined}
              />
              <StatTile
                icon={<Database className="h-4 w-4" />}
                label="Avg. database time"
                value={formatMs(data.totals.avgDbMs)}
                hint={data.totals.avgMs > 0 && data.totals.avgDbMs !== null ? `${Math.round((data.totals.avgDbMs / data.totals.avgMs) * 100)}% of response time` : "not measured"}
              />
              <StatTile icon={<Server className="h-4 w-4" />} label="Hosts / pods" value={formatCount(data.totals.distinctHosts)} hint={collection?.host.cluster ?? collection?.host.hostname} />
            </div>

            <Tabs defaultValue="overview" className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
              {/* Scrolls itself on a narrow viewport — the PAGE must never scroll sideways. */}
              <TabsList className="w-full justify-start overflow-x-auto">
                <TabsTrigger value="overview">Latency & errors</TabsTrigger>
                <TabsTrigger value="endpoints">Endpoints</TabsTrigger>
                <TabsTrigger value="hosts">Hosts & pods</TabsTrigger>
                <TabsTrigger value="requests">Request log</TabsTrigger>
              </TabsList>

              {/* ------------------------------- Latency & errors ------------------------------- */}
              <TabsContent value="overview" className="grid min-w-0 gap-4">
                <div className="grid min-w-0 gap-1.5">
                  <p className="text-sm font-medium">Response time over time</p>
                  <p className="text-xs text-muted-foreground">
                    Three points on one distribution. A p99 that lifts while p50 stays flat means a few requests are
                    suffering, not everyone — a different problem with a different cause.
                  </p>
                  <div className="h-72 min-w-0">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={latencySeries}>
                        <CartesianGrid {...GRID_STYLE} />
                        <XAxis dataKey="label" {...AXIS_STYLE} minTickGap={24} />
                        <YAxis {...AXIS_STYLE} allowDecimals={false} unit=" ms" width={70} />
                        <RTooltip {...TOOLTIP_STYLE} formatter={(value: number) => formatMs(value)} />
                        <Legend wrapperStyle={{ fontSize: 12, color: "hsl(var(--muted-foreground))" }} />
                        <Line type="monotone" dataKey="p50Ms" name="p50 (typical)" stroke={LATENCY_COLOR.p50} strokeWidth={2} dot={false} />
                        <Line type="monotone" dataKey="p95Ms" name="p95" stroke={LATENCY_COLOR.p95} strokeWidth={2} dot={false} />
                        <Line type="monotone" dataKey="p99Ms" name="p99 (worst)" stroke={LATENCY_COLOR.p99} strokeWidth={2} dot={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div className="grid min-w-0 gap-1.5">
                  <p className="text-sm font-medium">Traffic and outcomes</p>
                  <p className="text-xs text-muted-foreground">
                    Volume per bucket, split by outcome. Its own chart rather than a second axis on the one above —
                    requests and milliseconds do not share a scale.
                  </p>
                  <div className="h-64 min-w-0">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={latencySeries}>
                        <CartesianGrid {...GRID_STYLE} />
                        <XAxis dataKey="label" {...AXIS_STYLE} minTickGap={24} />
                        <YAxis {...AXIS_STYLE} allowDecimals={false} width={60} />
                        <RTooltip {...TOOLTIP_STYLE} />
                        <Legend wrapperStyle={{ fontSize: 12, color: "hsl(var(--muted-foreground))" }} />
                        <Bar dataKey="ok" name="Succeeded" stackId="o" fill={OUTCOME_COLOR.ok} />
                        <Bar dataKey="clientErrors" name="4xx (refused)" stackId="o" fill={OUTCOME_COLOR.clientErrors} />
                        <Bar dataKey="serverErrors" name="5xx (failed)" stackId="o" fill={OUTCOME_COLOR.serverErrors} radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                {presentStatusClasses.length > 0 && (
                  <div className="grid min-w-0 gap-1.5">
                    <p className="text-sm font-medium">Status code mix</p>
                    <div className="h-12 min-w-0">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart layout="vertical" data={[statusMixRow]} margin={{ left: 0, right: 0, top: 0, bottom: 0 }}>
                          <XAxis type="number" hide />
                          <YAxis type="category" dataKey="name" hide />
                          <RTooltip {...TOOLTIP_STYLE} />
                          {presentStatusClasses.map((cls, index, arr) => (
                            <Bar
                              key={cls}
                              dataKey={cls}
                              name={cls}
                              stackId="mix"
                              fill={STATUS_CLASS_COLOR[cls]}
                              radius={index === 0 ? [4, 0, 0, 4] : index === arr.length - 1 ? [0, 4, 4, 0] : [0, 0, 0, 0]}
                            />
                          ))}
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                    {/* Legend in words as well as colour — a red/amber strip is exactly the pattern
                        that fails a colour-vision-deficient reader. */}
                    <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
                      {presentStatusClasses.map((cls) => (
                        <span key={cls} className="inline-flex items-center gap-1.5">
                          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: STATUS_CLASS_COLOR[cls] }} />
                          {cls} ({formatCount(Number(statusMixRow[cls] ?? 0))})
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </TabsContent>

              {/* ---------------------------------- Endpoints ---------------------------------- */}
              <TabsContent value="endpoints" className="grid min-w-0 gap-4">
                <div className="grid min-w-0 gap-1.5">
                  <p className="text-sm font-medium">Slowest endpoints by p95</p>
                  <p className="text-xs text-muted-foreground">
                    Route patterns, not URLs — every <code className="text-[11px]">/api/tickets/:id</code> counts as one
                    endpoint. Top 12 shown; the full table is below.
                  </p>
                  <div className="h-96 min-w-0">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={slowestChart} layout="vertical" margin={{ left: 8, right: 16 }}>
                        <CartesianGrid {...GRID_STYLE} horizontal={false} />
                        <XAxis type="number" {...AXIS_STYLE} allowDecimals={false} unit=" ms" />
                        <YAxis type="category" dataKey="label" {...AXIS_STYLE} width={220} />
                        <RTooltip
                          {...TOOLTIP_STYLE}
                          formatter={(value: number, _name, entry: any) => [formatMs(value), `${formatCount(entry.payload.total)} calls`]}
                        />
                        {/* Single hue: this ranks ONE measure, so colouring bars by rank would add a
                            second, meaningless encoding. */}
                        <Bar dataKey="p95Ms" name="p95" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div className="min-w-0 overflow-x-auto rounded-lg border border-border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="min-w-[16rem]">Endpoint</TableHead>
                        <TableHead className="text-right">Calls</TableHead>
                        <TableHead className="text-right">p50</TableHead>
                        <TableHead className="text-right">p95</TableHead>
                        <TableHead className="text-right">p99</TableHead>
                        <TableHead className="text-right">Max</TableHead>
                        <TableHead className="text-right">Avg. DB</TableHead>
                        <TableHead className="text-right">Errors</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.endpoints.map((row) => (
                        <TableRow key={row.apiName}>
                          <TableCell className="font-mono text-xs">
                            <Badge variant="outline" className="mr-2">{row.method}</Badge>
                            {row.apiPath}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{formatCount(row.total)}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatMs(row.p50Ms)}</TableCell>
                          <TableCell className={`text-right tabular-nums font-medium ${latencyTone(row.p95Ms)}`}>{formatMs(row.p95Ms)}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatMs(row.p99Ms)}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatMs(row.maxMs)}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatMs(row.avgDbMs)}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {row.serverErrors > 0 ? (
                              <span className="text-destructive">{row.errorRate}%</span>
                            ) : row.errorRate > 0 ? (
                              <span className="text-warning">{row.errorRate}%</span>
                            ) : (
                              <span className="text-muted-foreground">0%</span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </TabsContent>

              {/* -------------------------------- Hosts & pods -------------------------------- */}
              <TabsContent value="hosts" className="grid min-w-0 gap-3">
                <p className="text-xs text-muted-foreground">
                  Behind a load balancer every number elsewhere on this page is a fleet average. This is where one slow
                  replica stops hiding in it. CPU, memory and disk are the machine's state around each request, sampled
                  every 15 seconds rather than measured per request.
                </p>
                <div className="min-w-0 overflow-x-auto rounded-lg border border-border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="min-w-[12rem]">Host / pod</TableHead>
                        <TableHead className="min-w-[10rem]">OS</TableHead>
                        <TableHead className="text-right">Requests</TableHead>
                        <TableHead className="text-right">Avg</TableHead>
                        <TableHead className="text-right">p95</TableHead>
                        <TableHead className="text-right">5xx</TableHead>
                        <TableHead className="text-right">CPU</TableHead>
                        <TableHead className="text-right">RAM</TableHead>
                        <TableHead className="text-right">Disk</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.hosts.map((host) => (
                        <TableRow key={`${host.hostname}|${host.podName ?? ""}`}>
                          <TableCell>
                            <p className="font-medium">{host.podName ?? host.hostname}</p>
                            <p className="text-xs text-muted-foreground">
                              {host.podName ? host.hostname : "not running in Kubernetes"}
                              {host.cluster ? ` · ${host.cluster}` : ""}
                            </p>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">{host.osType}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatCount(host.total)}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatMs(host.avgMs)}</TableCell>
                          <TableCell className={`text-right tabular-nums font-medium ${latencyTone(host.p95Ms)}`}>{formatMs(host.p95Ms)}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {host.serverErrors > 0 ? <span className="text-destructive">{formatCount(host.serverErrors)}</span> : "—"}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{host.avgCpuPercent === null ? "—" : `${host.avgCpuPercent}%`}</TableCell>
                          <TableCell className="text-right tabular-nums">{host.avgMemPercent === null ? "—" : `${host.avgMemPercent}%`}</TableCell>
                          <TableCell className="text-right tabular-nums">{host.avgDiskPercent === null ? "—" : `${host.avgDiskPercent}%`}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </TabsContent>

              {/* --------------------------------- Request log --------------------------------- */}
              <TabsContent value="requests" className="grid min-w-0 gap-3">
                {/* Filters in one row above the table, per the shared interaction convention. */}
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    className="h-9 w-full sm:w-56"
                    placeholder="Filter by path…"
                    value={drilldown.path ?? ""}
                    onChange={(event) => setDrilldown({ ...drilldown, path: event.target.value || undefined })}
                  />
                  <Select
                    value={drilldown.method ?? "all"}
                    onValueChange={(value) => setDrilldown({ ...drilldown, method: value === "all" ? undefined : value })}
                  >
                    <SelectTrigger className="h-9 w-[7.5rem]"><SelectValue placeholder="Method" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Any method</SelectItem>
                      {["GET", "POST", "PATCH", "PUT", "DELETE"].map((method) => (
                        <SelectItem key={method} value={method}>{method}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={drilldown.statusClass === undefined ? "all" : String(drilldown.statusClass)}
                    onValueChange={(value) =>
                      setDrilldown({ ...drilldown, statusClass: value === "all" ? undefined : Number(value) })
                    }
                  >
                    <SelectTrigger className="h-9 w-[8.5rem]"><SelectValue placeholder="Status" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Any status</SelectItem>
                      <SelectItem value="2">2xx succeeded</SelectItem>
                      <SelectItem value="3">3xx redirected</SelectItem>
                      <SelectItem value="4">4xx refused</SelectItem>
                      <SelectItem value="5">5xx failed</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select
                    value={drilldown.hostname ?? "all"}
                    onValueChange={(value) => setDrilldown({ ...drilldown, hostname: value === "all" ? undefined : value })}
                  >
                    <SelectTrigger className="h-9 w-[11rem]"><SelectValue placeholder="Host" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Any host</SelectItem>
                      {[...new Set(data.hosts.map((h) => h.hostname))].map((hostname) => (
                        <SelectItem key={hostname} value={hostname}>{hostname}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={drilldown.sort ?? "slowest"}
                    onValueChange={(value) => setDrilldown({ ...drilldown, sort: value as "slowest" | "recent" })}
                  >
                    <SelectTrigger className="h-9 w-[9.5rem]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="slowest">Slowest first</SelectItem>
                      <SelectItem value="recent">Most recent</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {requests.isLoading && <Skeleton className="h-40 w-full" />}
                {requests.data && requests.data.rows.length === 0 && (
                  <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                    No requests match these filters in this window.
                  </p>
                )}

                {/*
                  Position, not just navigation. "50 slowest of 23,783" and "all 50 there are" used
                  to render identically, so somebody hunting a slow endpoint could not tell whether
                  they had seen everything — which is the wrong thing to be unsure about.
                */}
                {requests.data && requests.data.total > 0 && (
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>
                      Showing <strong className="text-foreground">{requests.data.offset + 1}</strong>–
                      <strong className="text-foreground">
                        {Math.min(requests.data.offset + requests.data.rows.length, requests.data.total)}
                      </strong>{" "}
                      of <strong className="text-foreground">{formatCount(requests.data.total)}</strong>
                      {drilldown.sort === "slowest" ? " — slowest first" : " — most recent first"}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <Select
                        value={String(drilldown.limit ?? 50)}
                        onValueChange={(value) => setDrilldownRaw({ ...drilldown, limit: Number(value), offset: 0 })}
                      >
                        <SelectTrigger className="h-8 w-[6.5rem]"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {[25, 50, 100, 200].map((n) => (
                            <SelectItem key={n} value={String(n)}>{n} per page</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8"
                        disabled={(requests.data.offset ?? 0) <= 0 || requests.isFetching}
                        onClick={() =>
                          setDrilldownRaw({
                            ...drilldown,
                            offset: Math.max(0, (drilldown.offset ?? 0) - (drilldown.limit ?? 50))
                          })
                        }
                      >
                        Previous
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8"
                        disabled={
                          requests.data.offset + requests.data.rows.length >= requests.data.total || requests.isFetching
                        }
                        onClick={() =>
                          setDrilldownRaw({ ...drilldown, offset: (drilldown.offset ?? 0) + (drilldown.limit ?? 50) })
                        }
                      >
                        Next
                      </Button>
                    </span>
                  </div>
                )}
                {requests.data && requests.data.rows.length > 0 && (
                  <div className="min-w-0 overflow-x-auto rounded-lg border border-border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="min-w-[7rem]">When</TableHead>
                          <TableHead className="min-w-[16rem]">Endpoint</TableHead>
                          <TableHead className="min-w-[10rem]">User</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead className="text-right">Total</TableHead>
                          <TableHead className="text-right">Database</TableHead>
                          <TableHead className="min-w-[10rem]">Served by</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {requests.data.rows.map((row) => (
                          <TableRow key={row.id}>
                            <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                              {new Date(row.apiRequestAt).toLocaleString(undefined, {
                                month: "short",
                                day: "numeric",
                                hour: "2-digit",
                                minute: "2-digit",
                                second: "2-digit"
                              })}
                            </TableCell>
                            <TableCell className="font-mono text-xs">
                              <Badge variant="outline" className="mr-2">{row.method}</Badge>
                              {row.apiPath}
                            </TableCell>
                            <TableCell className="text-xs">
                              {row.user ? (
                                <>
                                  <p className="truncate font-medium">{row.user.name}</p>
                                  <p className="truncate text-muted-foreground">{row.user.email}</p>
                                </>
                              ) : (
                                <span className="text-muted-foreground">unauthenticated</span>
                              )}
                            </TableCell>
                            <TableCell>
                              <Badge variant={statusBadgeVariant(row.statusCode)}>{row.statusCode}</Badge>
                            </TableCell>
                            <TableCell className={`text-right tabular-nums font-medium ${latencyTone(row.apiResponseTime)}`}>
                              {formatMs(row.apiResponseTime)}
                            </TableCell>
                            <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                              {formatMs(row.dbResponseTime)}
                              {row.dbQueryCount !== null && (
                                <span className="ml-1">
                                  ({row.dbQueryCount} {row.dbQueryCount === 1 ? "query" : "queries"})
                                </span>
                              )}
                            </TableCell>
                            <TableCell className="text-xs">
                              <p className="truncate">{row.podName ?? row.hostname}</p>
                              <p className="truncate text-muted-foreground">
                                {[row.cpuPercent !== null ? `CPU ${row.cpuPercent}%` : null, row.memUsedPercent !== null ? `RAM ${row.memUsedPercent}%` : null]
                                  .filter(Boolean)
                                  .join(" · ") || row.osType}
                              </p>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  Individual requests, capped at {drilldown.limit ?? 50}. Bodies, query strings and headers are never
                  recorded — only the route pattern, the timings, and who was signed in.
                </p>
              </TabsContent>
            </Tabs>

            {collection && (collection.droppedSinceBoot > 0 || collection.failedSinceBoot > 0) && (
              <p className="border-t border-border pt-3 text-xs text-muted-foreground">
                {/* Said out loud rather than hidden: under-reported data that looks complete is worse
                    than a visible gap. */}
                {collection.droppedSinceBoot > 0 &&
                  `${formatCount(collection.droppedSinceBoot)} sample(s) were dropped since this instance started — the buffer filled up, so the figures above under-count. `}
                {collection.failedSinceBoot > 0 &&
                  `${formatCount(collection.failedSinceBoot)} sample(s) could not be written to the database.`}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
