/**
 * WHAT: the live "Server health" panel on the Maintenance tab — CPU, memory, disk, network
 * latency and a per-component health checklist, refreshed every 10 seconds.
 * WHY it sits on the Maintenance tab: the person deciding "is it safe to open/close the
 * maintenance window?" needs the box's vitals on the same screen as the switch.
 * HONESTY NOTE, mirrored from api/src/services/system-health.service.ts: every number is
 * measured on the API instance that answered the poll. Behind a load balancer or K8s
 * replica set that is ONE replica's view — the header names the host so nobody mistakes it
 * for a cluster-wide aggregate.
 * WHO renders this: MaintenanceSettingsCard, below the schedule/online cards.
 */
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  CircuitBoard,
  Clock,
  Cpu,
  Database,
  HardDrive,
  Hexagon,
  MemoryStick,
  Monitor,
  Network,
  Power,
  RefreshCw,
  ServerCog,
  Tag,
  Timer
} from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Progress } from "../../components/ui/progress";
import { Skeleton } from "../../components/ui/skeleton";
import { maintenanceApi } from "../../services/api";

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.max(0, Math.round(bytes / 1024))} KB`;
}

function formatUptime(totalSec: number): string {
  const days = Math.floor(totalSec / 86_400);
  const hours = Math.floor((totalSec % 86_400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** Bar turns amber past 80% and red past 92% — the glanceable "should I worry" signal. */
function usageBarClass(percent: number): string {
  if (percent >= 92) return "[&>div]:bg-destructive";
  if (percent >= 80) return "[&>div]:bg-warning";
  return "";
}

function MetricTile({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border p-4">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {icon} {label}
      </p>
      {children}
    </div>
  );
}

export function ServerHealthCard() {
  const health = useQuery({
    queryKey: ["maintenance", "health"],
    queryFn: maintenanceApi.health,
    // 10s keeps the panel live while staying well inside the /api/maintenance 30/min limiter
    // alongside the admin view's own 30s poll. A failed poll keeps the last snapshot on screen.
    refetchInterval: 10_000,
    retry: false
  });

  const snapshot = health.data;

  if (health.isLoading) {
    return <Skeleton className="h-72 w-full" />;
  }

  if (!snapshot) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ServerCog className="h-5 w-5 text-primary" /> Server health
          </CardTitle>
          <CardDescription>Couldn't reach the health endpoint — it will retry automatically.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const allOk = snapshot.components.every((component) => component.ok);
  const memoryUsed = snapshot.memory.totalBytes - snapshot.memory.freeBytes;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            <ServerCog className="h-5 w-5 text-primary" /> Server health
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant={allOk ? "success" : "destructive"}>{allOk ? "All systems go" : "Attention needed"}</Badge>
            <Button
              variant="outline"
              size="sm"
              onClick={() => health.refetch()}
              disabled={health.isFetching}
              aria-label="Refresh server health"
            >
              <RefreshCw className={`h-4 w-4 ${health.isFetching ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>
        <CardDescription>
          Live vitals of <span className="font-medium text-foreground">{snapshot.server.hostname}</span> (pid{" "}
          {snapshot.server.pid}) — the API instance answering this page. Refreshes every 10 seconds.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <MetricTile icon={<Cpu className="h-3.5 w-3.5" />} label="CPU">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-2xl font-bold tabular-nums">
                {snapshot.cpu.usagePercent === null ? "—" : `${snapshot.cpu.usagePercent}%`}
              </span>
              <span className="text-xs text-muted-foreground">{snapshot.cpu.cores} cores</span>
            </div>
            <Progress value={snapshot.cpu.usagePercent ?? 0} className={`mt-2 ${usageBarClass(snapshot.cpu.usagePercent ?? 0)}`} />
            <p className="mt-2 truncate text-xs text-muted-foreground" title={snapshot.cpu.model}>
              {snapshot.cpu.model}
              {snapshot.cpu.loadAvg && ` · load ${snapshot.cpu.loadAvg.map((n) => n.toFixed(2)).join(" / ")}`}
            </p>
          </MetricTile>

          <MetricTile icon={<MemoryStick className="h-3.5 w-3.5" />} label="Memory">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-2xl font-bold tabular-nums">{snapshot.memory.usedPercent}%</span>
              <span className="text-xs text-muted-foreground">
                {formatBytes(memoryUsed)} / {formatBytes(snapshot.memory.totalBytes)}
              </span>
            </div>
            <Progress value={snapshot.memory.usedPercent} className={`mt-2 ${usageBarClass(snapshot.memory.usedPercent)}`} />
            <p className="mt-2 text-xs text-muted-foreground">API process: {formatBytes(snapshot.memory.processRssBytes)} resident</p>
          </MetricTile>

          <MetricTile icon={<HardDrive className="h-3.5 w-3.5" />} label="Disk">
            {snapshot.disk ? (
              <>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-2xl font-bold tabular-nums">{snapshot.disk.usedPercent}%</span>
                  <span className="text-xs text-muted-foreground">{formatBytes(snapshot.disk.freeBytes)} free</span>
                </div>
                <Progress value={snapshot.disk.usedPercent} className={`mt-2 ${usageBarClass(snapshot.disk.usedPercent)}`} />
                <p className="mt-2 truncate text-xs text-muted-foreground" title={snapshot.disk.path}>
                  {formatBytes(snapshot.disk.totalBytes)} volume · {snapshot.disk.path}
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Not available on this platform.</p>
            )}
          </MetricTile>

          <MetricTile icon={<Network className="h-3.5 w-3.5" />} label="Network & latency">
            <dl className="grid gap-1 text-sm">
              <div className="flex items-center justify-between gap-2">
                <dt className="flex items-center gap-1.5 text-muted-foreground">
                  <Database className="h-3.5 w-3.5" /> Tenant DB ping
                </dt>
                <dd className="font-medium tabular-nums">
                  {snapshot.network.tenantDbPingMs === null ? "unreachable" : `${snapshot.network.tenantDbPingMs} ms`}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="flex items-center gap-1.5 text-muted-foreground">
                  <Database className="h-3.5 w-3.5" /> Control DB ping
                </dt>
                <dd className="font-medium tabular-nums">
                  {snapshot.network.controlDbPingMs === null ? "unreachable" : `${snapshot.network.controlDbPingMs} ms`}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="flex items-center gap-1.5 text-muted-foreground">
                  <Activity className="h-3.5 w-3.5" /> Event-loop lag
                </dt>
                <dd className="font-medium tabular-nums">
                  {snapshot.network.eventLoopLagMeanMs} ms <span className="text-xs text-muted-foreground">(max {snapshot.network.eventLoopLagMaxMs})</span>
                </dd>
              </div>
            </dl>
            {snapshot.network.interfaces.length > 0 && (
              <p className="mt-2 truncate text-xs text-muted-foreground">
                {snapshot.network.interfaces.map((iface) => `${iface.name} ${iface.address}`).join(" · ")}
              </p>
            )}
          </MetricTile>
        </div>

        {/* The "cluster health" checklist — every dependency this instance needs, probed live. */}
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Component status</p>
          <ul className="divide-y rounded-lg border">
            {snapshot.components.map((component) => (
              <li key={component.name} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                <span className="flex items-center gap-2">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${component.ok ? "bg-success" : "bg-destructive"}`} aria-hidden />
                  {component.name}
                </span>
                <span className={`text-xs ${component.ok ? "text-muted-foreground" : "font-medium text-destructive"}`}>
                  {component.detail}
                </span>
              </li>
            ))}
          </ul>
        </div>

        {/* Same visual grammar as the vitals tiles above — the environment facts were one
            unscannable text line before, which is exactly what a status panel must not be. */}
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Server details</p>
          {/* 2-up even on a phone — these are single-fact tiles, and one per row made eight facts
              a full screen of scrolling. Back to 2-up at 2xl because the card shares a row with
              the status page there and four columns don't fit half the width. */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 2xl:grid-cols-2">
            <DetailTile icon={<Monitor className="h-4 w-4" />} label="Operating system" value={snapshot.server.platform} />
            <DetailTile icon={<CircuitBoard className="h-4 w-4" />} label="Architecture" value={snapshot.server.arch} />
            <DetailTile icon={<Hexagon className="h-4 w-4" />} label="Node.js" value={snapshot.server.nodeVersion} />
            <DetailTile icon={<Tag className="h-4 w-4" />} label="App version" value={`v${snapshot.server.appVersion}`} />
            <DetailTile icon={<Power className="h-4 w-4" />} label="OS uptime" value={formatUptime(snapshot.server.osUptimeSec)} />
            <DetailTile icon={<Timer className="h-4 w-4" />} label="API uptime" value={formatUptime(snapshot.server.processUptimeSec)} />
            <DetailTile
              icon={<Clock className="h-4 w-4" />}
              label="Last sampled"
              value={new Date(snapshot.sampledAt).toLocaleTimeString()}
            />
            <DetailTile icon={<ServerCog className="h-4 w-4" />} label="Process" value={`pid ${snapshot.server.pid}`} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/** Small labeled fact tile — the compact sibling of MetricTile for single-value facts. */
function DetailTile({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">{icon}</span>
      <span className="min-w-0">
        <span className="block text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
        <span className="block truncate text-sm font-semibold" title={value}>
          {value}
        </span>
      </span>
    </div>
  );
}
