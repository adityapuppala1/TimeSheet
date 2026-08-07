/**
 * WHAT: a manager's "my team" view — direct reports roster, pending approvals, SLA/overdue
 * indicators, open escalations targeted at them.
 * WHY it's manager-scoped rather than a general team directory: it's the operational view for
 * someone who has to act on their reports' timesheets, backed by `controllers/team.controller.ts`'s
 * `managerId`-filtered queries — not a company-wide org chart.
 * WHO calls the backing API: `controllers/team.controller.ts`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import {
  AlarmClock,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Mail,
  Network,
  ShieldCheck,
  ShieldX,
  TrendingUp,
  Users2
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis
} from "recharts";
import { OrgChartTree } from "../components/OrgChartTree";
import { Avatar, AvatarFallback, AvatarImage } from "../components/ui/avatar";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { DataTable } from "../components/ui/data-table";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Skeleton } from "../components/ui/skeleton";
import { StatCard } from "../components/ui/stat-card";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { toast } from "../components/ui/toaster";
import { computeTrend } from "../lib/trend";
import { fileUrl, teamApi, timesheetApi, type OrgChartNode, type TeamReport } from "../services/api";

function initialsFor(name?: string) {
  if (!name) return "?";
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function relativeTime(value: string) {
  const diff = Date.now() - new Date(value).getTime();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "moments ago";
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  return `${Math.floor(diff / day)}d ago`;
}

export function Team() {
  const queryClient = useQueryClient();
  const [trendFor, setTrendFor] = useState<TeamReport | null>(null);
  const reports = useQuery({ queryKey: ["team", "reports"], queryFn: teamApi.reports });
  const summary = useQuery({ queryKey: ["team", "sla-summary"], queryFn: teamApi.slaSummary, refetchInterval: 30_000 });
  const escalations = useQuery({ queryKey: ["team", "escalations"], queryFn: teamApi.escalations });

  const approve = useMutation({
    mutationFn: (id: string) => timesheetApi.approve(id),
    onSuccess: () => {
      toast.success("Approved");
      queryClient.invalidateQueries({ queryKey: ["team"] });
      queryClient.invalidateQueries({ queryKey: ["timesheets"] });
    },
    onError: (err: any) => toast.error("Approval failed", { description: err?.response?.data?.message ?? "Try again." })
  });

  const escalationColumns = useMemo<ColumnDef<any, any>[]>(
    () => [
      {
        id: "employee",
        accessorFn: (row: any) => row.timesheet?.user?.name,
        header: "Employee",
        cell: ({ row }) => {
          const avatarSrc = fileUrl(row.original.timesheet?.user?.avatarUrl);
          return (
            <div className="flex items-center gap-2">
              <Avatar className="h-7 w-7">
                {avatarSrc ? <AvatarImage src={avatarSrc} alt={row.original.timesheet?.user?.name ?? ""} /> : null}
                <AvatarFallback>{initialsFor(row.original.timesheet?.user?.name)}</AvatarFallback>
              </Avatar>
              <span className="font-medium">{row.original.timesheet?.user?.name}</span>
            </div>
          );
        }
      },
      {
        id: "originalReviewer",
        accessorFn: (row: any) => row.escalatedFromUser?.name,
        header: "Original reviewer",
        cell: ({ row }) => <span className="text-muted-foreground">{row.original.escalatedFromUser?.name}</span>
      },
      { id: "project", accessorFn: (row: any) => row.timesheet?.project?.name, header: "Project" },
      {
        id: "workDate",
        accessorFn: (row: any) => row.timesheet?.workDate,
        header: "Work date",
        cell: ({ row }) => <span className="text-muted-foreground">{String(row.original.timesheet?.workDate ?? "").slice(0, 10)}</span>
      },
      {
        id: "hours",
        accessorFn: (row: any) => Number(row.timesheet?.totalHours ?? 0),
        header: "Hours",
        cell: ({ row }) => <span className="font-semibold">{Number(row.original.timesheet?.totalHours ?? 0).toFixed(2)}</span>
      },
      {
        id: "escalated",
        accessorFn: (row: any) => row.createdAt,
        header: "Escalated",
        cell: ({ row }) => <span className="text-xs text-destructive">{relativeTime(row.original.createdAt)}</span>
      },
      {
        id: "action",
        header: () => <span className="block text-right">Action</span>,
        enableSorting: false,
        cell: ({ row }) => (
          <div className="text-right">
            <Button size="sm" variant="success" onClick={() => approve.mutate(row.original.timesheet.id)}>
              <CheckCircle2 className="h-4 w-4" />Approve
            </Button>
          </div>
        )
      }
    ],
    [approve]
  );

  const reportColumns = useMemo<ColumnDef<any, any>[]>(
    () => [
      {
        id: "person",
        accessorFn: (row: any) => row.name,
        header: "Person",
        cell: ({ row }) => {
          const avatarSrc = fileUrl(row.original.avatarUrl);
          return (
            <div className="flex items-center gap-3">
              <Avatar>
                {avatarSrc ? <AvatarImage src={avatarSrc} alt={row.original.name} /> : null}
                <AvatarFallback>{initialsFor(row.original.name)}</AvatarFallback>
              </Avatar>
              <button
                type="button"
                className="focus-ring min-w-0 rounded text-left"
                onClick={() => setTrendFor(row.original)}
              >
                {/* spans, not <p> — a button may only contain phrasing content. */}
                <span className="block truncate font-medium hover:underline">{row.original.name}</span>
                {row.original.bio && <span className="line-clamp-1 block text-xs text-muted-foreground">{row.original.bio}</span>}
              </button>
            </div>
          );
        }
      },
      {
        id: "role",
        accessorFn: (row: any) => row.role,
        header: "Role",
        cell: ({ row }) => <Badge variant="info">{row.original.role.replace("_", " ")}</Badge>
      },
      {
        id: "pending",
        accessorFn: (row: any) => row.stats.pending,
        header: () => <span className="block text-right">Pending</span>,
        cell: ({ row }) => (
          <div className="text-right">
            {row.original.stats.pending > 0 ? <Badge variant="warning">{row.original.stats.pending}</Badge> : <span className="text-muted-foreground">0</span>}
          </div>
        )
      },
      {
        id: "approved",
        accessorFn: (row: any) => row.stats.approved,
        header: () => <span className="block text-right">Approved</span>,
        cell: ({ row }) => <span className="block text-right font-semibold text-success">{row.original.stats.approved}</span>
      },
      {
        id: "rejected",
        accessorFn: (row: any) => row.stats.rejected,
        header: () => <span className="block text-right">Rejected</span>,
        cell: ({ row }) => <span className="block text-right text-muted-foreground">{row.original.stats.rejected}</span>
      },
      {
        id: "slaBreaches",
        accessorFn: (row: any) => row.stats.slaBreached,
        header: () => <span className="block text-right">SLA breaches</span>,
        cell: ({ row }) => (
          <div className="text-right">
            {row.original.stats.slaBreached > 0 ? (
              <Badge variant="destructive">{row.original.stats.slaBreached}</Badge>
            ) : (
              <span className="text-muted-foreground">0</span>
            )}
          </div>
        )
      },
      {
        id: "approvedHours",
        accessorFn: (row: any) => row.stats.approvedHours,
        header: () => <span className="block text-right">Approved hours</span>,
        cell: ({ row }) => <span className="block text-right font-semibold">{row.original.stats.approvedHours.toFixed(2)}</span>
      },
      {
        id: "contact",
        header: "Contact",
        enableSorting: false,
        cell: ({ row }) => (
          <Tooltip>
            <TooltipTrigger asChild>
              <a href={`mailto:${row.original.email}`} className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
                <Mail className="h-3.5 w-3.5" />Email
              </a>
            </TooltipTrigger>
            <TooltipContent>{row.original.email}</TooltipContent>
          </Tooltip>
        )
      }
    ],
    []
  );

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-lg bg-primary/10 text-primary">
            <Users2 className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight">My team</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Direct reports, approval queue, and SLA health — all in one view.
            </p>
          </div>
        </div>
      </div>

      {/* Top stats */}
      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 md:grid-cols-4">
        <StatCard
          label="Awaiting approval"
          value={summary.data?.submitted ?? 0}
          icon={<Clock className="h-4 w-4" />}
          tone={(summary.data?.submitted ?? 0) > 0 ? "warning" : "default"}
          trend={computeTrend(summary.data?.submitted ?? 0, summary.data?.submittedYesterday ?? 0, false)}
          trendLabel="vs yesterday"
        />
        <StatCard
          label="SLA breached"
          value={summary.data?.breached ?? 0}
          icon={<AlertTriangle className="h-4 w-4" />}
          tone={(summary.data?.breached ?? 0) > 0 ? "destructive" : "default"}
          trend={computeTrend(summary.data?.breached ?? 0, summary.data?.breachedYesterday ?? 0, false)}
          trendLabel="vs yesterday"
        />
        <StatCard
          label="Approved this week"
          value={summary.data?.approvedThisWeek ?? 0}
          icon={<CheckCircle2 className="h-4 w-4" />}
          tone="success"
          trend={computeTrend(summary.data?.approvedThisWeek ?? 0, summary.data?.approvedLastWeek ?? 0, true)}
          trendLabel="vs last week"
        />
        <StatCard
          label="Open escalations"
          value={summary.data?.openEscalations ?? 0}
          icon={<ShieldX className="h-4 w-4" />}
          tone={(summary.data?.openEscalations ?? 0) > 0 ? "destructive" : "default"}
          trend={computeTrend(summary.data?.openEscalations ?? 0, summary.data?.openEscalationsYesterday ?? 0, false)}
          trendLabel="vs yesterday"
        />
      </div>

      {/* Escalations to me */}
      {(escalations.data?.length ?? 0) > 0 && (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldX className="h-4 w-4 text-destructive" />
              Escalations awaiting your decision
            </CardTitle>
            <CardDescription>These approvals missed their SLA and were escalated up to you.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {/* Mobile card list — same data as the 7-column table below, self-contained cards
                instead of a sideways scroll (see docs/ROADMAP.md's wide-table backlog note). */}
            <div className="grid gap-2 p-3 sm:hidden">
              {(escalations.data ?? []).map((row: any) => {
                const avatarSrc = fileUrl(row.timesheet?.user?.avatarUrl);
                return (
                  <div key={row.id} className="grid gap-2 rounded-lg border border-border bg-card p-3 text-sm shadow-sm">
                    <div className="flex items-center gap-2">
                      <Avatar className="h-7 w-7">
                        {avatarSrc ? <AvatarImage src={avatarSrc} alt={row.timesheet?.user?.name ?? ""} /> : null}
                        <AvatarFallback>{initialsFor(row.timesheet?.user?.name)}</AvatarFallback>
                      </Avatar>
                      <span className="font-medium">{row.timesheet?.user?.name}</span>
                      <span className="ml-auto text-xs text-destructive">{relativeTime(row.createdAt)}</span>
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span>Original: {row.escalatedFromUser?.name}</span>
                      <span>{row.timesheet?.project?.name}</span>
                      <span>{String(row.timesheet?.workDate ?? "").slice(0, 10)}</span>
                      <span className="font-semibold text-foreground">{Number(row.timesheet?.totalHours ?? 0).toFixed(2)}h</span>
                    </div>
                    <Button size="sm" variant="success" className="justify-self-start" onClick={() => approve.mutate(row.timesheet.id)}>
                      <CheckCircle2 className="h-4 w-4" />Approve
                    </Button>
                  </div>
                );
              })}
            </div>

            <div className="hidden p-3 sm:block">
              <DataTable columns={escalationColumns} data={escalations.data ?? []} enableSearch={false} pageSize={10} />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Direct reports */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <TrendingUp className="h-4 w-4 text-primary" /> Direct reports
          </CardTitle>
          <CardDescription>Roll-up of every report's submissions, approvals, and SLA history.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {/* Mobile card list — same data as the 8-column table below (see docs/ROADMAP.md's
              wide-table backlog note). */}
          <div className="grid gap-2 p-3 sm:hidden">
            {reports.isLoading && Array.from({ length: 3 }).map((_, i) => <Skeleton key={`skel-card-${i}`} className="h-24 w-full" />)}
            {!reports.isLoading &&
              (reports.data ?? []).map((person) => {
                const avatarSrc = fileUrl(person.avatarUrl);
                return (
                  <div key={person.id} className="grid gap-2 rounded-lg border border-border bg-card p-3 text-sm shadow-sm">
                    <div className="flex items-center gap-3">
                      <Avatar>
                        {avatarSrc ? <AvatarImage src={avatarSrc} alt={person.name} /> : null}
                        <AvatarFallback>{initialsFor(person.name)}</AvatarFallback>
                      </Avatar>
                      <button type="button" className="focus-ring min-w-0 flex-1 rounded text-left" onClick={() => setTrendFor(person)}>
                        <span className="block truncate font-medium hover:underline">{person.name}</span>
                        <Badge variant="info" className="mt-0.5">{person.role.replace("_", " ")}</Badge>
                      </button>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <a href={`mailto:${person.email}`} className="shrink-0 text-primary"><Mail className="h-4 w-4" /></a>
                        </TooltipTrigger>
                        <TooltipContent>{person.email}</TooltipContent>
                      </Tooltip>
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span>Pending: {person.stats.pending > 0 ? <Badge variant="warning">{person.stats.pending}</Badge> : "0"}</span>
                      <span>Approved: <span className="font-semibold text-success">{person.stats.approved}</span></span>
                      <span>Rejected: {person.stats.rejected}</span>
                      <span>SLA breaches: {person.stats.slaBreached > 0 ? <Badge variant="destructive">{person.stats.slaBreached}</Badge> : "0"}</span>
                      <span>Approved hours: <span className="font-semibold text-foreground">{person.stats.approvedHours.toFixed(2)}</span></span>
                    </div>
                  </div>
                );
              })}
          </div>

          <div className="hidden p-3 sm:block">
            <DataTable
              columns={reportColumns}
              data={reports.data ?? []}
              isLoading={reports.isLoading}
              searchPlaceholder="Search direct reports..."
              emptyMessage="No direct reports yet. Assign a manager to teammates from Users → Edit → Manager."
              pageSize={10}
            />
          </div>
        </CardContent>
      </Card>

      <AnomaliesCard />
      <OrgChartCard />

      <HoursTrendDialog person={trendFor} onClose={() => setTrendFor(null)} />
    </div>
  );
}

const AXIS_STYLE = { stroke: "hsl(var(--muted-foreground))", fontSize: 12 };
const TOOLTIP_STYLE = {
  contentStyle: { background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, color: "hsl(var(--popover-foreground))" }
};
const GRID_STYLE = { strokeDasharray: "3 3", stroke: "hsl(var(--border))" };
// Fixed categorical order — a color names which window it belongs to, never a rank.
const SERIES_COLOR = { thisMonth: "hsl(var(--primary))", trailingYear: "hsl(var(--info))" };

/** `timeZone: "UTC"` on every bucket label: the API's dates are UTC-midnight day keys, so
 *  rendering them in the viewer's local zone would print the day before for anyone west of UTC. */
function formatWeekRange(start: string, end: string) {
  const from = new Date(start);
  const to = new Date(end);
  const label = from.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  if (start === end) return label;
  return `${label}–${to.toLocaleDateString(undefined, { day: "numeric", timeZone: "UTC" })}`;
}

function formatMonth(monthStart: string) {
  return new Date(monthStart).toLocaleDateString(undefined, { month: "short", year: "2-digit", timeZone: "UTC" });
}

/** Per-report logged-hours trends. The report's id is only ever a hint to the server — it
 *  re-checks the reporting line before returning anything, so this dialog cannot be pointed at
 *  somebody else's team by editing the id. */
function HoursTrendDialog({ person, onClose }: { person: TeamReport | null; onClose: () => void }) {
  const trend = useQuery({
    queryKey: ["team", "hours-trend", person?.id],
    queryFn: () => teamApi.hoursTrend(person!.id),
    enabled: Boolean(person)
  });

  const weeks = trend.data?.currentMonth.weeks ?? [];
  const months = trend.data?.monthly ?? [];
  const monthTotal = weeks.reduce((sum, w) => sum + w.hours, 0);
  const yearTotal = months.reduce((sum, m) => sum + m.hours, 0);
  const avatarSrc = fileUrl(person?.avatarUrl);

  return (
    <Dialog open={Boolean(person)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92vh] w-[min(96vw,860px)] max-w-none overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-6">
            <Avatar className="h-7 w-7">
              {avatarSrc ? <AvatarImage src={avatarSrc} alt={person?.name ?? ""} /> : null}
              <AvatarFallback>{initialsFor(person?.name)}</AvatarFallback>
            </Avatar>
            <span className="truncate">{person?.name}</span>
          </DialogTitle>
          <DialogDescription>
            Hours logged — every entry, whatever its approval state. Approved-only totals are in the table behind this dialog.
          </DialogDescription>
        </DialogHeader>

        {trend.isLoading && (
          <div className="grid gap-4">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-56 w-full" />
            <Skeleton className="h-56 w-full" />
          </div>
        )}

        {trend.isError && <p className="py-6 text-center text-sm text-muted-foreground">Couldn't load this person's hours.</p>}

        {trend.data && (
          <div className="grid gap-4">
            <div className="grid grid-cols-2 gap-2.5">
              <div className="rounded-lg border border-border bg-muted/30 p-3">
                <p className="text-xs uppercase text-muted-foreground">This month</p>
                <p className="mt-1 text-xl font-black tracking-tight">{monthTotal.toFixed(1)}h</p>
              </div>
              <div className="rounded-lg border border-border bg-muted/30 p-3">
                <p className="text-xs uppercase text-muted-foreground">Last 12 months</p>
                <p className="mt-1 text-xl font-black tracking-tight">{yearTotal.toFixed(1)}h</p>
              </div>
            </div>

            <div className="grid gap-1.5">
              <p className="text-sm font-semibold">
                {new Date(trend.data.currentMonth.monthStart).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" })}, week by week
              </p>
              {monthTotal === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">No hours logged this month yet.</p>
              ) : (
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={weeks.map((w) => ({ ...w, label: formatWeekRange(w.weekStart, w.weekEnd) }))}>
                      <CartesianGrid {...GRID_STYLE} />
                      <XAxis dataKey="label" {...AXIS_STYLE} />
                      <YAxis {...AXIS_STYLE} />
                      <RTooltip {...TOOLTIP_STYLE} formatter={(value: number) => [`${value}h`, "Hours"]} />
                      <Bar dataKey="hours" name="Hours" fill={SERIES_COLOR.thisMonth} radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>

            <div className="grid gap-1.5">
              <p className="text-sm font-semibold">Month by month, last 12 months</p>
              {yearTotal === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">Nothing logged in the last 12 months.</p>
              ) : (
                // Twelve labelled buckets need room a phone doesn't have — scroll this chart
                // inside its own box rather than letting the dialog scroll sideways.
                <div className="overflow-x-auto">
                  <div className="h-56 min-w-[520px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={months.map((m) => ({ ...m, label: formatMonth(m.monthStart) }))}>
                        <CartesianGrid {...GRID_STYLE} />
                        <XAxis dataKey="label" {...AXIS_STYLE} />
                        <YAxis {...AXIS_STYLE} />
                        <RTooltip {...TOOLTIP_STYLE} formatter={(value: number) => [`${value}h`, "Hours"]} />
                        <Bar dataKey="hours" name="Hours" fill={SERIES_COLOR.trailingYear} radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Opt-in insight, never a block — sustained-overtime (burnout) and implausible-single-day
 *  (likely data-entry error) flags among direct reports, computed server-side from thresholds
 *  over already-logged hours (no AI call — see team.controller.ts's doc comment on why this is
 *  deterministic arithmetic, not a language-understanding task). Renders nothing when there's
 *  nothing to flag, same "silence on a quiet result" posture the AI weekly digests use. */
function AnomaliesCard() {
  const anomalies = useQuery({ queryKey: ["team", "timesheet-anomalies"], queryFn: teamApi.timesheetAnomalies });
  const hasAny = (anomalies.data?.burnout.length ?? 0) > 0 || (anomalies.data?.implausible.length ?? 0) > 0;

  if (!anomalies.isLoading && !hasAny) return null;

  return (
    <Card className="border-warning/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertTriangle className="h-4 w-4 text-warning" /> Timesheet anomalies
        </CardTitle>
        <CardDescription>
          Unusual hour patterns among your direct reports, last 4 weeks — informational only, nothing is blocked or flagged to them.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {anomalies.isLoading && <Skeleton className="h-16 w-full" />}
        {!anomalies.isLoading && (anomalies.data?.burnout.length ?? 0) > 0 && (
          <div className="grid gap-1.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sustained overtime</p>
            {anomalies.data!.burnout.map((b, i) => (
              <p key={i} className="text-sm">
                <span className="font-medium">{b.name}</span> logged <span className="font-semibold text-warning">{b.hours}h</span> the
                week of {new Date(b.weekStart).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
              </p>
            ))}
          </div>
        )}
        {!anomalies.isLoading && (anomalies.data?.implausible.length ?? 0) > 0 && (
          <div className="grid gap-1.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Implausible daily total</p>
            {anomalies.data!.implausible.map((a, i) => (
              <p key={i} className="text-sm">
                <span className="font-medium">{a.name}</span> logged <span className="font-semibold text-destructive">{a.hours}h</span> on{" "}
                {new Date(a.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
              </p>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Reporting-line tree over the existing User.managerId self-relation — no new data, just a new
 *  view (see docs/ROADMAP.md's "TL/Manager mapping" theme). Privileged roles see the whole
 *  company; a manager sees only their own subtree — same split the backend already enforces.
 *  Rendered as a real pan/zoomable node-link diagram (`OrgChartTree`, d3-hierarchy + d3-zoom) —
 *  see that component's header for why, and for how per-node collapse actually reflows the
 *  layout instead of just hiding DOM. */
function OrgChartCard() {
  const orgChart = useQuery({ queryKey: ["team", "org-chart"], queryFn: teamApi.orgChart });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Network className="h-4 w-4 text-primary" /> Org chart
        </CardTitle>
        <CardDescription>Reporting lines, built from each person's assigned manager.</CardDescription>
      </CardHeader>
      <CardContent>
        {orgChart.isLoading && <Skeleton className="h-32 w-full" />}
        {!orgChart.isLoading && (orgChart.data ?? []).length === 0 && (
          <p className="text-sm text-muted-foreground">No reporting-line data yet.</p>
        )}
        {!orgChart.isLoading && (orgChart.data ?? []).length > 0 && <OrgChartTree roots={orgChart.data ?? []} />}
      </CardContent>
    </Card>
  );
}

export const _unused = ShieldCheck;
