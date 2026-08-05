/**
 * WHAT: the status page — every feature's current state, a day-by-day history strip, and the
 * incident log. Modelled on the public status pages people already know how to read.
 *
 * WHY THE DAY STRIP IS THE CENTREPIECE rather than a big green tick: "is it up right now" is
 * already answerable by using the product. The question somebody actually arrives with is "was it
 * down on Tuesday, when I couldn't submit my timesheet" — usually after being told the problem was
 * at their end. A strip of days answers that in one glance and settles the argument.
 *
 * A DAY IS COLOURED BY ITS WORST SAMPLE, not its average, and this is the decision that makes the
 * page honest. Averaging is how a two-hour outage becomes a 96%-green day and disappears; the
 * whole reason for opening this page is to find the bad hour. The uptime percentage next to the
 * strip carries the magnitude, so the two together say both "something happened" and "how much".
 *
 * DAYS WITH NO DATA ARE GREY, NEVER GREEN. Before the monitor has run, or after an outage that
 * took the monitor with it, there is no evidence — and a page that reports absence of data as
 * success is worse than no page, because it will confidently deny an outage that happened.
 *
 * ACCESSIBILITY: colour is never the only channel. Every square carries a title and the summary
 * row states the status in words, because a red/green strip is precisely the pattern that fails
 * the ~8% of men with a colour vision deficiency.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, AlertTriangle, CheckCircle2, HelpCircle, Loader2, RefreshCw } from "lucide-react";

import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Skeleton } from "./ui/skeleton";
import { toast } from "./ui/toaster";
import { statusPageApi, type ServiceStatusValue, type StatusDay } from "../services/api";
import { cn } from "../lib/utils";

const STATUS_TEXT: Record<ServiceStatusValue, string> = {
  OPERATIONAL: "Operational",
  DEGRADED: "Degraded",
  DOWN: "Down"
};

/** Deliberately the semantic tokens rather than raw colours, so this tracks the theme (and dark
 *  mode) like everything else in the product. */
function squareClass(status: ServiceStatusValue | null): string {
  if (status === "DOWN") return "bg-destructive";
  if (status === "DEGRADED") return "bg-warning";
  if (status === "OPERATIONAL") return "bg-success";
  return "bg-muted-foreground/20";
}

function badgeVariant(status: ServiceStatusValue | null) {
  if (status === "DOWN") return "destructive" as const;
  if (status === "DEGRADED") return "warning" as const;
  if (status === "OPERATIONAL") return "success" as const;
  return "muted" as const;
}

function dayTitle(day: StatusDay, label: string): string {
  const date = new Date(`${day.date}T00:00:00`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric"
  });
  if (day.samples === 0) return `${label} — ${date}: no data`;
  if (day.status === "OPERATIONAL") return `${label} — ${date}: no problems (${day.samples} checks)`;
  const parts: string[] = [];
  if (day.downSamples > 0) parts.push(`${day.downSamples} failing`);
  if (day.degradedSamples > 0) parts.push(`${day.degradedSamples} slow`);
  return `${label} — ${date}: ${parts.join(", ")} of ${day.samples} checks (${day.uptimePct}% up)`;
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours}h ${rest}m` : `${hours}h`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function ServiceStatusPage() {
  const [days, setDays] = useState(90);
  const queryClient = useQueryClient();

  const status = useQuery({
    queryKey: ["status-page", days],
    queryFn: () => statusPageApi.get(days),
    refetchInterval: 60_000
  });

  const runNow = useMutation({
    mutationFn: statusPageApi.runNow,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["status-page"] });
      toast.success("Checked every service just now");
    },
    onError: () => toast.error("Couldn't run the checks")
  });

  const overall = status.data?.overall ?? null;
  const openIncidents = (status.data?.incidents ?? []).filter((i) => !i.endedAt);
  const pastIncidents = (status.data?.incidents ?? []).filter((i) => i.endedAt);

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-4 w-4" />
            Service status
          </CardTitle>
          <CardDescription>
            Every feature is probed every five minutes. This is the record of what was working and when.
          </CardDescription>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
            <SelectTrigger className="h-9 w-[8.5rem]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {[30, 60, 90, 180].map((d) => (
                <SelectItem key={d} value={String(d)}>{d} days</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" className="h-9" onClick={() => runNow.mutate()} disabled={runNow.isPending}>
            {runNow.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Check now
          </Button>
        </div>
      </CardHeader>

      <CardContent className="grid gap-5">
        {status.isLoading && <Skeleton className="h-64 w-full" />}

        {!status.isLoading && status.data && (
          <>
            <div
              className={cn(
                "flex items-center gap-3 rounded-lg border p-3",
                overall === "OPERATIONAL" && "border-success/40 bg-success/10",
                overall === "DEGRADED" && "border-warning/40 bg-warning/10",
                overall === "DOWN" && "border-destructive/40 bg-destructive/10",
                overall === null && "border-border bg-muted/30"
              )}
            >
              {overall === "OPERATIONAL" ? (
                <CheckCircle2 className="h-5 w-5 shrink-0 text-success" />
              ) : overall === null ? (
                <HelpCircle className="h-5 w-5 shrink-0 text-muted-foreground" />
              ) : (
                <AlertTriangle
                  className={cn("h-5 w-5 shrink-0", overall === "DOWN" ? "text-destructive" : "text-warning")}
                />
              )}
              <div className="min-w-0">
                <p className="font-semibold">
                  {overall === "OPERATIONAL"
                    ? "All systems operational"
                    : overall === "DEGRADED"
                      ? "Some systems are slow"
                      : overall === "DOWN"
                        ? "Some systems are down"
                        : "No checks have run yet"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {overall === null
                    ? "Use “Check now” to run the first one — nothing is claimed until something has actually been measured."
                    : `${status.data.services.length} services monitored · history from ${status.data.from}`}
                </p>
              </div>
            </div>

            {openIncidents.length > 0 && (
              <div className="grid gap-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Happening now</p>
                {openIncidents.map((incident) => (
                  <div key={incident.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
                    <Badge variant={badgeVariant(incident.status)}>{STATUS_TEXT[incident.status]}</Badge>
                    <span className="font-medium">{incident.serviceLabel}</span>
                    <span className="text-muted-foreground">
                      since {formatWhen(incident.startedAt)} · {formatDuration(incident.durationMinutes)}
                    </span>
                    {incident.detail && <span className="w-full text-xs text-muted-foreground">{incident.detail}</span>}
                  </div>
                ))}
              </div>
            )}

            <div className="grid gap-4">
              {status.data.services.map((service) => (
                <div key={service.key} className="grid gap-1.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="min-w-0">
                      <span className="font-medium">{service.label}</span>
                      <span className="ml-2 text-xs text-muted-foreground">{service.description}</span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2 text-xs">
                      {service.uptimePct !== null && (
                        <span className="tabular-nums text-muted-foreground">{service.uptimePct}% up</span>
                      )}
                      <Badge variant={badgeVariant(service.current)}>
                        {service.current ? STATUS_TEXT[service.current] : "No data"}
                      </Badge>
                    </div>
                  </div>

                  {/* Squares shrink to fit rather than scrolling: a history strip you have to
                      scroll sideways to read defeats the point of a glanceable summary. */}
                  <div className="flex w-full items-stretch gap-[2px]" role="img" aria-label={`${service.label}: ${days}-day history`}>
                    {service.days.map((day) => (
                      <span
                        key={day.date}
                        title={dayTitle(day, service.label)}
                        className={cn("h-7 min-w-0 flex-1 rounded-[2px]", squareClass(day.status))}
                      />
                    ))}
                  </div>

                  <div className="flex justify-between text-[11px] text-muted-foreground">
                    <span>{status.data!.from}</span>
                    <span>
                      {service.currentDetail ??
                        (service.avgLatencyMs !== null ? `avg ${service.avgLatencyMs} ms` : "")}
                    </span>
                    <span>Today</span>
                  </div>
                </div>
              ))}
            </div>

            <div className="grid gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Past incidents</p>
              {pastIncidents.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Nothing recorded in this window.
                </p>
              ) : (
                <div className="divide-y divide-border rounded-lg border border-border">
                  {pastIncidents.slice(0, 25).map((incident) => (
                    <div key={incident.id} className="flex flex-wrap items-center gap-2 p-3 text-sm">
                      <Badge variant={badgeVariant(incident.status)}>{STATUS_TEXT[incident.status]}</Badge>
                      <span className="font-medium">{incident.serviceLabel}</span>
                      <span className="text-muted-foreground">
                        {formatWhen(incident.startedAt)} → {incident.endedAt ? formatWhen(incident.endedAt) : "ongoing"}
                      </span>
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                        {formatDuration(incident.durationMinutes)} · {incident.sampleCount}{" "}
                        {incident.sampleCount === 1 ? "check" : "checks"}
                      </span>
                      {incident.detail && <span className="w-full text-xs text-muted-foreground">{incident.detail}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-4 border-t border-border pt-3 text-xs text-muted-foreground">
              {(["OPERATIONAL", "DEGRADED", "DOWN"] as ServiceStatusValue[]).map((s) => (
                <span key={s} className="flex items-center gap-1.5">
                  <span className={cn("h-3 w-3 rounded-[2px]", squareClass(s))} aria-hidden />
                  {STATUS_TEXT[s]}
                </span>
              ))}
              <span className="flex items-center gap-1.5">
                <span className={cn("h-3 w-3 rounded-[2px]", squareClass(null))} aria-hidden />
                No data
              </span>
              <span className="ml-auto">A day is coloured by its worst check, not its average.</span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
