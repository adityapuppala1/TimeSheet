/**
 * Per-workspace monitoring — the operator's answer to "is this customer's instance healthy?".
 *
 * WHERE THE NUMBERS COME FROM, AND WHY IT MATTERS. The four panels below the database one are the
 * SAME services that draw a workspace's own Maintenance tab: `getSystemHealth`, `getStatusPage`
 * (with its incident history) and `getApiPerformanceOverview`, called inside that tenant's context.
 * So when a customer's super admin says "our status page shows a degraded service", this page shows
 * the identical row — not a second telemetry pipeline that can disagree with theirs.
 *
 * THE DATABASE PANEL IS THE NEW PART, and it is read through the workspace's OWN connection string,
 * per schema. Two honesty rules are load-bearing:
 *   - counters that describe the MySQL SERVER (connections, buffer pool, uptime) are labelled as
 *     server-wide, because on a shared box they belong to every workspace, not this one. Reading
 *     "connections at 92%" as this tenant's fault is how an operator ends up debugging the wrong
 *     customer;
 *   - row counts are InnoDB's ESTIMATE and say so. An exact count needs a full scan, which is not
 *     worth doing to draw a bar.
 *
 * ALERTS ARE DERIVED, not configured. Every threshold is stated in the alert text — nothing here is
 * a black box, and when these need to become per-tenant rules they are already one pure function.
 *
 * A PANEL THAT FAILS DOES NOT TAKE THE PAGE. Each section arrives as `{ data, error }`; a workspace
 * whose database is unreachable still shows its status page, and says why the rest is missing.
 */
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Boxes,
  CheckCircle2,
  Cpu,
  Database,
  Gauge,
  HardDrive,
  Info,
  LineChart as LineChartIcon,
  MemoryStick,
  Network,
  Radio,
  RefreshCw,
  ServerCrash,
  ShieldCheck,
  Table2,
  Timer,
  TriangleAlert
} from "lucide-react";
import { useMemo, useState } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Progress } from "../../components/ui/progress";
import { Skeleton } from "../../components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import type { ServiceStatusValue, StatusPageService } from "../../services/api";
import { platformOpsApi, type FleetHealthRow, type HealthAlert, type TenantDatabaseMetrics } from "../../services/platform-admin-api";
import { ConsolePage, ConsoleSection, ConsoleTable, EmptyState, KpiCard, KpiGrid, Num, OrgStatusPill, SegmentedControl, TierPill, Toolbar, shortDateTime } from "./console-ui";
import type { OrgStatus } from "../../services/platform-admin-api";

/* ------------------------------------------------------------------------------------------- */
/* Formatting                                                                                   */
/* ------------------------------------------------------------------------------------------- */

function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

const formatCount = (value: number | null | undefined) => (value === null || value === undefined ? "—" : value.toLocaleString());
const formatMs = (value: number | null | undefined) => (value === null || value === undefined ? "—" : `${Math.round(value)} ms`);
const formatPercent = (value: number | null | undefined, digits = 1) => (value === null || value === undefined ? "—" : `${value.toFixed(digits)}%`);

/** Uptime as a person says it, from a seconds counter that can run to months. */
function formatUptime(seconds: number | null): string {
  if (seconds === null) return "—";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/* ------------------------------------------------------------------------------------------- */
/* Small shared pieces                                                                          */
/* ------------------------------------------------------------------------------------------- */

const ALERT_TONE: Record<HealthAlert["severity"], { badge: "destructive" | "warning" | "info"; icon: typeof Info; ring: string }> = {
  critical: { badge: "destructive", icon: ServerCrash, ring: "border-destructive/40 bg-destructive/5" },
  warning: { badge: "warning", icon: TriangleAlert, ring: "border-warning/40 bg-warning/5" },
  info: { badge: "info", icon: Info, ring: "border-info/40 bg-info/5" }
};

function AlertCard({ alert }: { alert: HealthAlert }) {
  const tone = ALERT_TONE[alert.severity];
  const Icon = tone.icon;
  return (
    <div className={`flex min-w-0 items-start gap-3 rounded-lg border p-3 ${tone.ring}`}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
          {alert.title}
          <Badge variant={tone.badge} className="uppercase">
            {alert.severity}
          </Badge>
          <Badge variant="muted">{alert.area}</Badge>
        </p>
        <p className="mt-0.5 text-sm text-muted-foreground">{alert.detail}</p>
      </div>
    </div>
  );
}

/**
 * A labelled utilisation bar. Amber past 75% and red past 90% — the same thresholds the derived
 * alerts use, so the colour and the alert can never tell different stories.
 *
 * `goodHigh` flips that, and it is not a nicety: a cache hit rate is a percentage where 95% is the
 * BAD end, and the first version painted a healthy-but-imperfect 99.4% hit rate in the same red it
 * uses for a disk about to fill. A meter that reads "danger" for a number an operator wants to be
 * large teaches them to ignore the colour.
 */
function Meter({ label, percent, detail, icon: Icon, goodHigh = false }: { label: string; percent: number | null; detail?: string; icon: typeof Cpu; goodHigh?: boolean }) {
  const severity = percent === null ? null : goodHigh ? 100 - percent : percent;
  const tone = severity === null ? "bg-muted-foreground/40" : severity >= 90 ? "bg-destructive" : severity >= 75 ? "bg-warning" : "bg-success";
  return (
    <div className="grid min-w-0 grid-cols-1 gap-1.5 rounded-lg border border-border p-3">
      <div className="flex min-w-0 items-center gap-2">
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
        <span className="shrink-0 font-mono text-sm font-bold tabular-nums text-foreground">{percent === null ? "—" : `${percent.toFixed(0)}%`}</span>
      </div>
      <Progress value={percent ?? 0} className="h-1.5" indicatorClassName={tone} />
      {detail && <p className="truncate text-xs text-muted-foreground">{detail}</p>}
    </div>
  );
}

/** One statistic, stated plainly. Used wherever a panel is a list of facts rather than a chart. */
function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="grid min-w-0 grid-cols-1 gap-0.5 rounded-lg border border-border p-3">
      <p className="truncate text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="truncate font-mono text-lg font-bold tabular-nums text-foreground">{value}</p>
      {hint && <p className="truncate text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function StatGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid min-w-0 grid-cols-2 gap-3 lg:grid-cols-4">{children}</div>;
}

function PanelError({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
      <span className="min-w-0 break-words text-muted-foreground">{message}</span>
    </div>
  );
}

const CHART_TOOLTIP = {
  background: "hsl(var(--popover))",
  border: "1px solid hsl(var(--border))",
  borderRadius: 8,
  fontSize: 12,
  color: "hsl(var(--popover-foreground))"
};

/* ------------------------------------------------------------------------------------------- */
/* The fleet table                                                                              */
/* ------------------------------------------------------------------------------------------- */

type FleetFilter = "all" | "alerting" | "unreachable" | "maintenance";

function FleetView({ onOpen }: { onOpen: (orgId: string) => void }) {
  const [filter, setFilter] = useState<FleetFilter>("all");
  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["platform-admin", "monitoring-fleet"],
    queryFn: platformOpsApi.fleetHealth,
    // A minute: every pass opens one connection per workspace, so this is a screen that refreshes
    // itself, not a live dashboard. The button is there when an operator wants it now.
    refetchInterval: 60_000
  });

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const counts = useMemo(
    () => ({
      all: rows.length,
      alerting: rows.filter((row) => row.alerts.length > 0).length,
      unreachable: rows.filter((row) => !row.reachable).length,
      maintenance: rows.filter((row) => row.maintenancePhase === "active" || row.maintenancePhase === "scheduled").length
    }),
    [rows]
  );

  const shown = useMemo(() => {
    if (filter === "all") return rows;
    if (filter === "alerting") return rows.filter((row) => row.alerts.length > 0);
    if (filter === "unreachable") return rows.filter((row) => !row.reachable);
    return rows.filter((row) => row.maintenancePhase === "active" || row.maintenancePhase === "scheduled");
  }, [rows, filter]);

  // The size bar is relative to the LARGEST workspace on the deployment, not to an absolute
  // ceiling: what an operator is looking for here is the outlier, and an absolute scale hides it.
  const largest = Math.max(1, ...rows.map((row) => row.totalBytes ?? 0));

  const chartData = useMemo(
    () =>
      rows
        .filter((row) => row.reachable)
        .slice()
        .sort((a, b) => (b.totalBytes ?? 0) - (a.totalBytes ?? 0))
        .slice(0, 10)
        .map((row) => ({ name: row.slug, mb: Math.round(((row.totalBytes ?? 0) / 1024 / 1024) * 10) / 10 })),
    [rows]
  );

  return (
    <>
      <KpiGrid>
        <KpiCard label="Databases" value={data?.totals.databases ?? 0} icon={Database} hint="Workspaces with a database registered" />
        <KpiCard
          label="Reachable"
          value={data?.totals.reachable ?? 0}
          icon={ShieldCheck}
          tone={counts.unreachable ? "warning" : "success"}
          hint={counts.unreachable ? `${counts.unreachable} did not answer` : "Every one answered"}
          delay={0.04}
        />
        <KpiCard
          label="Data stored"
          value={data?.totals.totalBytes ?? 0}
          icon={HardDrive}
          format={(n) => formatBytes(n)}
          hint="Tables plus indexes, all workspaces"
          delay={0.08}
        />
        <KpiCard
          label="Open alerts"
          value={data?.totals.alerts ?? 0}
          icon={AlertTriangle}
          tone={(data?.totals.alerts ?? 0) > 0 ? "destructive" : "success"}
          hint="Derived from the numbers on this page"
          delay={0.12}
        />
      </KpiGrid>

      {chartData.length > 1 && (
        <ConsoleSection title="Largest workspaces" description="Data plus indexes, in megabytes. The outlier is usually the story.">
          <div className="h-56 w-full min-w-0 sm:h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} interval={0} angle={-20} textAnchor="end" height={44} />
                <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} width={48} />
                <RTooltip contentStyle={CHART_TOOLTIP} formatter={(value: number) => [`${value} MB`, "Size"]} />
                <Bar dataKey="mb" fill="hsl(var(--accent))" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </ConsoleSection>
      )}

      <ConsoleSection
        title="Every workspace database"
        description="Read one at a time through each workspace's own connection string — sequential on purpose, because forty connections at once against one MySQL server is a self-inflicted outage."
        actions={
          <Toolbar>
            <SegmentedControl<FleetFilter>
              ariaLabel="Filter workspaces"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "All", count: counts.all },
                { value: "alerting", label: "Alerting", count: counts.alerting },
                { value: "maintenance", label: "Maintenance", count: counts.maintenance },
                { value: "unreachable", label: "Unreachable", count: counts.unreachable }
              ]}
            />
            <Button variant="outline" size="sm" className="gap-1.5" disabled={isFetching} onClick={() => void refetch()}>
              <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </Toolbar>
        }
        flush
      >
        {isLoading ? (
          <div className="grid gap-2 p-4">
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className="h-12 w-full" />
            ))}
          </div>
        ) : shown.length === 0 ? (
          <div className="p-4">
            <EmptyState icon={Database} title="Nothing here" description="No workspace matches that filter." />
          </div>
        ) : (
          <ConsoleTable minWidth={1040}>
            <TableHeader>
              <TableRow>
                <TableHead>Workspace</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead>Size</TableHead>
                <TableHead className="text-right">Tables</TableHead>
                <TableHead className="text-right">Rows (est.)</TableHead>
                <TableHead className="text-right">Probe</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="text-right">Detail</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((row) => (
                <FleetRow key={row.organizationId} row={row} largest={largest} onOpen={onOpen} />
              ))}
            </TableBody>
          </ConsoleTable>
        )}
      </ConsoleSection>
    </>
  );
}

function FleetRow({ row, largest, onOpen }: { row: FleetHealthRow; largest: number; onOpen: (orgId: string) => void }) {
  const worst = row.alerts.find((alert) => alert.severity === "critical") ?? row.alerts.find((alert) => alert.severity === "warning") ?? row.alerts[0];
  return (
    <TableRow>
      <TableCell className="min-w-0">
        <p className="truncate text-sm font-medium text-foreground">{row.name}</p>
        <p className="truncate font-mono text-[11px] text-muted-foreground">{row.databaseName ?? row.slug}</p>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center gap-1.5">
          <TierPill tier={row.planTier} />
          <OrgStatusPill status={row.status as OrgStatus} />
        </div>
      </TableCell>
      <TableCell className="min-w-[9rem]">
        {row.reachable ? (
          <>
            <p className="font-mono text-xs tabular-nums text-foreground">{formatBytes(row.totalBytes)}</p>
            <Progress value={((row.totalBytes ?? 0) / largest) * 100} className="mt-1 h-1.5" indicatorClassName="bg-accent" />
          </>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>
      <Num>{formatCount(row.tableCount)}</Num>
      <Num>{formatCount(row.estimatedRows)}</Num>
      <Num className={row.queryMs !== null && row.queryMs > 2000 ? "text-warning" : undefined}>{formatMs(row.queryMs)}</Num>
      <TableCell>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {!row.reachable && (
            <Badge variant="warning" className="gap-1" title={row.error ?? undefined}>
              <AlertTriangle className="h-3 w-3" />
              Unreachable
            </Badge>
          )}
          {row.maintenancePhase === "active" && (
            <Badge variant="destructive" className="gap-1">
              <Radio className="h-3 w-3" />
              Maintenance
            </Badge>
          )}
          {row.maintenancePhase === "scheduled" && <Badge variant="info">Window set</Badge>}
          {row.reachable && row.alerts.length === 0 && row.maintenancePhase !== "active" && (
            <Badge variant="success" className="gap-1">
              <CheckCircle2 className="h-3 w-3" />
              Healthy
            </Badge>
          )}
          {row.alerts.length > 0 && (
            <Badge variant={row.alerts.some((a) => a.severity === "critical") ? "destructive" : "warning"} title={worst?.detail}>
              {row.alerts.length} alert{row.alerts.length === 1 ? "" : "s"}
            </Badge>
          )}
        </div>
      </TableCell>
      <TableCell className="text-right">
        <Button size="sm" variant="outline" onClick={() => onOpen(row.organizationId)}>
          Inspect
        </Button>
      </TableCell>
    </TableRow>
  );
}

/* ------------------------------------------------------------------------------------------- */
/* The per-workspace panels                                                                     */
/* ------------------------------------------------------------------------------------------- */

function DatabasePanel({ metrics }: { metrics: TenantDatabaseMetrics }) {
  const tables = metrics.schema.largestTables.map((table) => ({
    name: table.name,
    data: Math.round((table.dataBytes / 1024 / 1024) * 10) / 10,
    index: Math.round((table.indexBytes / 1024 / 1024) * 10) / 10
  }));

  return (
    <div className="grid min-w-0 grid-cols-1 gap-4">
      <StatGrid>
        <Stat label="Schema size" value={formatBytes(metrics.schema.totalBytes)} hint={`${formatBytes(metrics.schema.dataBytes)} data + ${formatBytes(metrics.schema.indexBytes)} index`} />
        <Stat label="Tables" value={formatCount(metrics.schema.tableCount)} hint={metrics.databaseName} />
        <Stat label="Rows" value={formatCount(metrics.schema.estimatedRows)} hint="InnoDB estimate, not an exact count" />
        <Stat label="Index share" value={formatPercent(metrics.schema.indexShare === null ? null : metrics.schema.indexShare * 100)} hint="Index bytes over data plus index" />
      </StatGrid>

      {tables.length > 0 && (
        <div className="min-w-0 rounded-lg border border-border p-3">
          <p className="mb-2 text-sm font-semibold text-foreground">Largest tables, data and index (MB)</p>
          {/* Height follows the row count — a fixed 16rem squashes ten tables into hairlines and
              leaves whitespace under three. Inline, because the value is computed. */}
          <div className="w-full min-w-0" style={{ height: Math.max(180, tables.length * 30 + 48) }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={tables} layout="vertical" margin={{ top: 8, right: 12, left: 8, bottom: 4 }} barCategoryGap="20%">
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} />
                <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} />
                <RTooltip contentStyle={CHART_TOOLTIP} formatter={(value: number, key) => [`${value} MB`, key === "data" ? "Data" : "Index"]} />
                <Bar dataKey="data" stackId="size" fill="hsl(var(--accent))" radius={[0, 0, 0, 0]} />
                <Bar dataKey="index" stackId="size" fill="hsl(var(--info))" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      <div className="min-w-0 rounded-lg border border-border p-3">
        <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
          MySQL server
          <Badge variant="muted">server-wide</Badge>
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {metrics.host}
          {metrics.serverVersion ? ` · ${metrics.serverVersion}` : ""} — these counters belong to the server, which other workspaces may share. Read them as the box's health,
          not this workspace's.
        </p>
        <div className="mt-3 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
          <Meter
            label="Connections"
            percent={metrics.server.connectionUsePercent}
            detail={`${formatCount(metrics.server.threadsConnected)} of ${formatCount(metrics.server.maxConnections)} · ${formatCount(metrics.server.threadsRunning)} running`}
            icon={Network}
          />
          {/* `goodHigh`: 99% here is healthy and 60% is the emergency — the opposite way round from
              every other meter on the page. */}
          <Meter label="Buffer pool hit rate" percent={metrics.server.bufferPoolHitRate} detail="Reads served from memory. Below 99% is worth a look." icon={MemoryStick} goodHigh />
        </div>
        <div className="mt-3">
          <StatGrid>
            <Stat label="Server uptime" value={formatUptime(metrics.server.uptimeSec)} />
            <Stat label="Queries" value={formatCount(metrics.server.questions)} hint="Since the server started" />
            <Stat label="Slow queries" value={formatCount(metrics.server.slowQueries)} hint="Over long_query_time" />
            <Stat label="Aborted connects" value={formatCount(metrics.server.abortedConnects)} hint="Failed handshakes" />
          </StatGrid>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        The metadata query itself answered in <span className="font-mono tabular-nums">{metrics.queryMs} ms</span> — a slow answer here is itself a finding.
      </p>
    </div>
  );
}

const SERVICE_TONE: Record<ServiceStatusValue, { badge: "success" | "warning" | "destructive"; bar: string }> = {
  OPERATIONAL: { badge: "success", bar: "bg-success" },
  DEGRADED: { badge: "warning", bar: "bg-warning" },
  DOWN: { badge: "destructive", bar: "bg-destructive" }
};

/** The uptime strip a status page always has: one bar per day, grey where nothing was sampled —
 *  a gap is not an outage, and colouring it green would claim evidence that does not exist. */
function ServiceRow({ service }: { service: StatusPageService }) {
  return (
    <div className="grid min-w-0 grid-cols-1 gap-2 rounded-lg border border-border p-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{service.label}</span>
        {service.current ? <Badge variant={SERVICE_TONE[service.current].badge}>{service.current}</Badge> : <Badge variant="muted">Never probed</Badge>}
        <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
          {service.uptimePct === null ? "—" : `${service.uptimePct.toFixed(2)}% up`} · {formatMs(service.avgLatencyMs)}
        </span>
      </div>
      <div className="flex min-w-0 items-end gap-[2px] overflow-hidden">
        {service.days.map((day) => (
          <span
            key={day.date}
            title={`${day.date} — ${day.status ?? "no samples"}${day.uptimePct === null ? "" : ` · ${day.uptimePct.toFixed(1)}% up`}`}
            className={`h-6 min-w-[3px] flex-1 rounded-sm ${day.status ? SERVICE_TONE[day.status].bar : "bg-muted-foreground/25"}`}
          />
        ))}
      </div>
      {service.currentDetail && <p className="truncate text-xs text-muted-foreground">{service.currentDetail}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------- */
/* The drill-down                                                                               */
/* ------------------------------------------------------------------------------------------- */

const WINDOWS = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" }
] as const;

function TenantView({ orgId, onBack }: { orgId: string; onBack: () => void }) {
  const [days, setDays] = useState<"7" | "30" | "90">("30");
  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["platform-admin", "monitoring", orgId, days],
    queryFn: () => platformOpsApi.tenantHealth(orgId, Number(days)),
    refetchInterval: 60_000
  });

  if (isLoading || !data) {
    return (
      <div className="grid gap-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }

  const { organization, alerts, database, system, status, api, maintenance } = data;
  const critical = alerts.filter((alert) => alert.severity === "critical").length;
  const apiTotals = api.data?.totals;
  const incidents = status.data?.incidents ?? [];
  const openIncidents = incidents.filter((incident) => !incident.endedAt).length;

  const series = (api.data?.series ?? []).map((point) => ({
    t: new Date(point.bucketStart).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit" }),
    total: point.total,
    p95: Math.round(point.p95Ms),
    errors: point.serverErrors
  }));

  return (
    <div className="grid min-w-0 grid-cols-1 gap-6">
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <Button variant="outline" size="sm" className="shrink-0 gap-1.5" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" />
            Fleet
          </Button>
          <div className="min-w-0">
            <p className="truncate text-lg font-black tracking-tight text-foreground">{organization.name}</p>
            <p className="truncate font-mono text-[11px] text-muted-foreground">
              {organization.slug}
              {organization.databaseName ? ` · ${organization.databaseName}` : ""}
            </p>
          </div>
        </div>
        <Toolbar>
          <TierPill tier={organization.planTier} />
          <OrgStatusPill status={organization.status as OrgStatus} />
          {maintenance.data?.enabled && (
            <Badge variant="destructive" className="gap-1">
              <Radio className="h-3 w-3" />
              {maintenance.data.phase === "active" ? "In maintenance" : "Window set"}
            </Badge>
          )}
          <SegmentedControl<"7" | "30" | "90"> ariaLabel="Window" value={days} onChange={setDays} options={WINDOWS.map((w) => ({ value: w.value, label: w.label }))} />
          <Button variant="outline" size="sm" className="gap-1.5" disabled={isFetching} onClick={() => void refetch()}>
            <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </Toolbar>
      </div>

      <KpiGrid>
        <KpiCard
          label="Alerts"
          value={alerts.length}
          icon={AlertTriangle}
          tone={critical ? "destructive" : alerts.length ? "warning" : "success"}
          hint={critical ? `${critical} critical` : alerts.length ? "Nothing critical" : "All clear"}
        />
        <KpiCard label="Database" value={database.data?.schema.totalBytes ?? 0} icon={Database} format={(n) => formatBytes(n)} hint={`${formatCount(database.data?.schema.tableCount)} tables`} delay={0.04} />
        <KpiCard
          label="API error rate"
          value={apiTotals?.errorRate ?? 0}
          icon={Activity}
          format={(n) => `${n.toFixed(1)}%`}
          tone={(apiTotals?.errorRate ?? 0) >= 2 ? "destructive" : "success"}
          hint={`${formatCount(apiTotals?.total)} sampled requests`}
          delay={0.08}
        />
        <KpiCard
          label="API p95"
          value={apiTotals?.p95Ms ?? 0}
          icon={Timer}
          format={(n) => `${Math.round(n)} ms`}
          tone={(apiTotals?.p95Ms ?? 0) >= 1500 ? "warning" : "default"}
          hint={`p50 ${formatMs(apiTotals?.p50Ms)} · p99 ${formatMs(apiTotals?.p99Ms)}`}
          delay={0.12}
        />
      </KpiGrid>

      <Tabs defaultValue="overview" className="min-w-0">
        {/* Scrolls rather than wraps below `sm`: six tabs on a 390px screen either wrap into three
            ragged rows or scroll, and a scrolling strip keeps the selected tab where it was. */}
        <TabsList className="flex w-full min-w-0 justify-start overflow-x-auto">
          <TabsTrigger value="overview" className="gap-1.5">
            <Gauge className="h-4 w-4" />
            Overview
          </TabsTrigger>
          <TabsTrigger value="database" className="gap-1.5">
            <Database className="h-4 w-4" />
            Database
          </TabsTrigger>
          <TabsTrigger value="server" className="gap-1.5">
            <Cpu className="h-4 w-4" />
            Server health
          </TabsTrigger>
          <TabsTrigger value="services" className="gap-1.5">
            <ShieldCheck className="h-4 w-4" />
            Service status
          </TabsTrigger>
          <TabsTrigger value="incidents" className="gap-1.5">
            <TriangleAlert className="h-4 w-4" />
            Incidents
            {openIncidents > 0 && <Badge variant="destructive">{openIncidents}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="api" className="gap-1.5">
            <LineChartIcon className="h-4 w-4" />
            API performance
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4 grid min-w-0 grid-cols-1 gap-4">
          <ConsoleSection title="What needs attention" description="Derived from the numbers on this page. Every threshold is stated in the alert itself.">
            {alerts.length === 0 ? (
              <EmptyState icon={CheckCircle2} title="Nothing is alerting" description="No threshold on this workspace's database, services or API is currently crossed." />
            ) : (
              <div className="grid min-w-0 grid-cols-1 gap-2">
                {alerts.map((alert, index) => (
                  <AlertCard key={`${alert.area}-${index}`} alert={alert} />
                ))}
              </div>
            )}
          </ConsoleSection>

          <ConsoleSection title="Maintenance" description="This workspace's own window — the same row the Maintenance page writes across the fleet.">
            {maintenance.error ? (
              <PanelError message={maintenance.error} />
            ) : (
              <StatGrid>
                <Stat label="State" value={maintenance.data?.phase ?? "off"} />
                <Stat label="Starts" value={maintenance.data?.scheduledStartAt ? shortDateTime(maintenance.data.scheduledStartAt) : "—"} />
                <Stat label="Ends" value={maintenance.data?.scheduledEndAt ? shortDateTime(maintenance.data.scheduledEndAt) : "—"} />
                <Stat label="Message" value={maintenance.data?.message ? "Set" : "None"} hint={maintenance.data?.message ?? undefined} />
              </StatGrid>
            )}
          </ConsoleSection>
        </TabsContent>

        <TabsContent value="database" className="mt-4">
          <ConsoleSection title="Database" description="Read through this workspace's own connection string, per schema.">
            {database.error || !database.data ? <PanelError message={database.error ?? "No metrics."} /> : <DatabasePanel metrics={database.data} />}
          </ConsoleSection>
        </TabsContent>

        <TabsContent value="server" className="mt-4">
          <ConsoleSection
            title="Server health"
            description="Measured on the API instance that answered — one replica's view behind a load balancer, and it says so rather than claiming to speak for the cluster."
          >
            {system.error || !system.data ? (
              <PanelError message={system.error ?? "No snapshot."} />
            ) : (
              <div className="grid min-w-0 grid-cols-1 gap-4">
                <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-3">
                  <Meter label="CPU" percent={system.data.cpu.usagePercent} detail={`${system.data.cpu.cores} cores · ${system.data.cpu.model}`} icon={Cpu} />
                  <Meter
                    label="Memory"
                    percent={system.data.memory.usedPercent}
                    detail={`${formatBytes(system.data.memory.totalBytes - system.data.memory.freeBytes)} of ${formatBytes(system.data.memory.totalBytes)}`}
                    icon={MemoryStick}
                  />
                  <Meter
                    label="Disk"
                    percent={system.data.disk?.usedPercent ?? null}
                    detail={system.data.disk ? `${formatBytes(system.data.disk.freeBytes)} free on ${system.data.disk.path}` : "Not readable on this host"}
                    icon={HardDrive}
                  />
                </div>
                <StatGrid>
                  <Stat label="App version" value={system.data.server.appVersion} hint={`Node ${system.data.server.nodeVersion}`} />
                  <Stat label="Process uptime" value={formatUptime(system.data.server.processUptimeSec)} hint={`Host up ${formatUptime(system.data.server.osUptimeSec)}`} />
                  <Stat label="Tenant DB ping" value={formatMs(system.data.network.tenantDbPingMs)} hint={`Control DB ${formatMs(system.data.network.controlDbPingMs)}`} />
                  <Stat
                    label="Event-loop lag"
                    value={formatMs(system.data.network.eventLoopLagMeanMs)}
                    hint={`peak ${formatMs(system.data.network.eventLoopLagMaxMs)}`}
                  />
                </StatGrid>
                <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
                  {system.data.components.map((component) => (
                    <div key={component.name} className="flex min-w-0 items-start gap-2 rounded-lg border border-border p-3">
                      {component.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" /> : <ServerCrash className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />}
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">{component.name}</p>
                        <p className="truncate text-xs text-muted-foreground">{component.detail}</p>
                      </div>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Sampled {shortDateTime(system.data.sampledAt)} on <span className="font-mono">{system.data.server.hostname}</span> ({system.data.server.platform}/
                  {system.data.server.arch}).
                </p>
              </div>
            )}
          </ConsoleSection>
        </TabsContent>

        <TabsContent value="services" className="mt-4">
          <ConsoleSection
            title="Service status"
            description={`One bar per day over the last ${days} days. Grey means nothing was sampled that day — a gap is not an outage.`}
            actions={
              status.data?.overall ? (
                <Badge variant={SERVICE_TONE[status.data.overall].badge}>{status.data.overall}</Badge>
              ) : (
                <Badge variant="muted">No probe has run</Badge>
              )
            }
          >
            {status.error || !status.data ? (
              <PanelError message={status.error ?? "No status page."} />
            ) : status.data.services.length === 0 ? (
              <EmptyState icon={ShieldCheck} title="No services registered" description="This workspace has never run a service probe." />
            ) : (
              <div className="grid min-w-0 grid-cols-1 gap-3">
                {status.data.services.map((service) => (
                  <ServiceRow key={service.key} service={service} />
                ))}
              </div>
            )}
          </ConsoleSection>
        </TabsContent>

        <TabsContent value="incidents" className="mt-4">
          <ConsoleSection title="Past incidents" description="Every stretch a service spent degraded or down, with how long it lasted." flush>
            {status.error ? (
              <div className="p-4">
                <PanelError message={status.error} />
              </div>
            ) : incidents.length === 0 ? (
              <div className="p-4">
                <EmptyState icon={CheckCircle2} title="No incidents recorded" description={`Nothing went down or degraded in the last ${days} days.`} />
              </div>
            ) : (
              <ConsoleTable minWidth={820}>
                <TableHeader>
                  <TableRow>
                    <TableHead>Service</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead>Started</TableHead>
                    <TableHead>Ended</TableHead>
                    <TableHead className="text-right">Minutes</TableHead>
                    <TableHead>Detail</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {incidents.map((incident) => (
                    <TableRow key={incident.id}>
                      <TableCell className="text-sm font-medium text-foreground">{incident.serviceLabel}</TableCell>
                      <TableCell>
                        <Badge variant={SERVICE_TONE[incident.status].badge}>{incident.status}</Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{shortDateTime(incident.startedAt)}</TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        {incident.endedAt ? shortDateTime(incident.endedAt) : <Badge variant="destructive">Open</Badge>}
                      </TableCell>
                      <Num>{Math.round(incident.durationMinutes)}</Num>
                      <TableCell className="max-w-[18rem]">
                        <p className="truncate text-sm text-muted-foreground" title={incident.detail ?? undefined}>
                          {incident.detail ?? "—"}
                        </p>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </ConsoleTable>
            )}
          </ConsoleSection>
        </TabsContent>

        <TabsContent value="api" className="mt-4 grid min-w-0 grid-cols-1 gap-4">
          {api.error || !api.data ? (
            <ConsoleSection title="API performance">
              <PanelError message={api.error ?? "No samples."} />
            </ConsoleSection>
          ) : !api.data.collection.enabled ? (
            <ConsoleSection title="API performance">
              <EmptyState icon={Activity} title="Recording is off" description="This workspace is not sampling API requests, so an empty chart here means no recording — not no traffic." />
            </ConsoleSection>
          ) : (
            <>
              <ConsoleSection
                title="Requests and latency"
                description={`Sampled at ${(api.data.collection.sampleRate * 100).toFixed(0)}% over the last ${api.data.window.hours} hours, in ${Math.round(api.data.window.bucketSeconds / 60)}-minute buckets.`}
              >
                <div className="h-64 w-full min-w-0 sm:h-72">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                      <defs>
                        <linearGradient id="apiTotalFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="hsl(var(--accent))" stopOpacity={0.35} />
                          <stop offset="100%" stopColor="hsl(var(--accent))" stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                      <XAxis dataKey="t" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} minTickGap={24} />
                      <YAxis yAxisId="left" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} width={44} />
                      <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} width={44} />
                      <RTooltip contentStyle={CHART_TOOLTIP} />
                      {/* Three series in three colours on two axes is unreadable without one. */}
                      <Legend wrapperStyle={{ fontSize: 11 }} iconType="plainline" />
                      <Area yAxisId="left" type="monotone" dataKey="total" name="Requests" stroke="hsl(var(--accent))" fill="url(#apiTotalFill)" strokeWidth={2} />
                      <Area yAxisId="right" type="monotone" dataKey="p95" name="p95 (ms)" stroke="hsl(var(--info))" fill="transparent" strokeWidth={2} />
                      <Area yAxisId="left" type="monotone" dataKey="errors" name="5xx" stroke="hsl(var(--destructive))" fill="transparent" strokeWidth={2} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-4">
                  <StatGrid>
                    <Stat label="Requests" value={formatCount(api.data.totals.total)} hint={`${formatCount(api.data.totals.distinctUsers)} people`} />
                    <Stat label="5xx" value={formatCount(api.data.totals.serverErrors)} hint={`${formatCount(api.data.totals.clientErrors)} 4xx`} />
                    <Stat label="Average" value={formatMs(api.data.totals.avgMs)} hint={`DB ${formatMs(api.data.totals.avgDbMs)}`} />
                    <Stat label="Slowest" value={formatMs(api.data.totals.maxMs)} hint={`p99 ${formatMs(api.data.totals.p99Ms)}`} />
                  </StatGrid>
                </div>
              </ConsoleSection>

              <ConsoleSection title="Slowest endpoints" description="By p95 over the window. The place to look first when latency moves." flush>
                {api.data.endpoints.length === 0 ? (
                  <div className="p-4">
                    <EmptyState icon={Boxes} title="No endpoint samples" description="Nothing was recorded in this window." />
                  </div>
                ) : (
                  <ConsoleTable minWidth={900}>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Endpoint</TableHead>
                        <TableHead className="text-right">Calls</TableHead>
                        <TableHead className="text-right">Errors</TableHead>
                        <TableHead className="text-right">p50</TableHead>
                        <TableHead className="text-right">p95</TableHead>
                        <TableHead className="text-right">p99</TableHead>
                        <TableHead className="text-right">DB</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {api.data.endpoints.slice(0, 15).map((endpoint) => (
                        <TableRow key={`${endpoint.method}-${endpoint.apiPath}`}>
                          <TableCell className="min-w-0">
                            {/* `apiName` is usually already "POST /api/ai/ask", so printing the
                                method and path underneath repeated the row verbatim. The second
                                line appears only when it actually says something new. */}
                            <p className="truncate text-sm font-medium text-foreground">{endpoint.apiName}</p>
                            {endpoint.apiName !== `${endpoint.method} ${endpoint.apiPath}` && (
                              <p className="truncate font-mono text-[11px] text-muted-foreground">
                                {endpoint.method} {endpoint.apiPath}
                              </p>
                            )}
                          </TableCell>
                          <Num>{formatCount(endpoint.total)}</Num>
                          <Num className={endpoint.errorRate >= 2 ? "text-destructive" : undefined}>{formatPercent(endpoint.errorRate)}</Num>
                          <Num>{Math.round(endpoint.p50Ms)}</Num>
                          <Num className={endpoint.p95Ms >= 1500 ? "text-warning" : undefined}>{Math.round(endpoint.p95Ms)}</Num>
                          <Num>{Math.round(endpoint.p99Ms)}</Num>
                          <Num>{endpoint.avgDbMs === null ? "—" : Math.round(endpoint.avgDbMs)}</Num>
                        </TableRow>
                      ))}
                    </TableBody>
                  </ConsoleTable>
                )}
              </ConsoleSection>

              {api.data.hosts.length > 0 && (
                <ConsoleSection title="Hosts answering" description="Which instances served this workspace, and what they looked like while doing it." flush>
                  <ConsoleTable minWidth={820}>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Host</TableHead>
                        <TableHead className="text-right">Requests</TableHead>
                        <TableHead className="text-right">5xx</TableHead>
                        <TableHead className="text-right">p95</TableHead>
                        <TableHead className="text-right">CPU</TableHead>
                        <TableHead className="text-right">Memory</TableHead>
                        <TableHead>Last seen</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {api.data.hosts.map((host) => (
                        <TableRow key={`${host.hostname}-${host.podName ?? ""}`}>
                          <TableCell className="min-w-0">
                            <p className="truncate text-sm font-medium text-foreground">{host.hostname}</p>
                            <p className="truncate font-mono text-[11px] text-muted-foreground">{[host.podName, host.cluster, host.osType].filter(Boolean).join(" · ")}</p>
                          </TableCell>
                          <Num>{formatCount(host.total)}</Num>
                          <Num className={host.serverErrors ? "text-destructive" : undefined}>{formatCount(host.serverErrors)}</Num>
                          <Num>{Math.round(host.p95Ms)}</Num>
                          <Num>{formatPercent(host.avgCpuPercent, 0)}</Num>
                          <Num>{formatPercent(host.avgMemPercent, 0)}</Num>
                          <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{shortDateTime(host.lastSeenAt)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </ConsoleTable>
                </ConsoleSection>
              )}
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------- */

export function PlatformAdminMonitoring() {
  const [orgId, setOrgId] = useState<string | null>(null);

  return (
    <ConsolePage
      eyebrow="Operations"
      title="Workspace monitoring"
      description="Every tenant database's size, load and alerts — then, per workspace, the same server health, service status, incident history and API performance its own administrators see in their Maintenance tab."
      actions={
        <Toolbar>
          <Badge variant="muted" className="gap-1.5">
            <Table2 className="h-3 w-3" />
            Read live per workspace
          </Badge>
        </Toolbar>
      }
    >
      {orgId ? <TenantView orgId={orgId} onBack={() => setOrgId(null)} /> : <FleetView onOpen={setOrgId} />}
    </ConsolePage>
  );
}
