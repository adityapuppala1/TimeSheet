/**
 * WHAT: the post-login landing page — KPI cards plus a couple of recharts panels summarizing
 * timesheet/ticket activity, fed by `reportApi`/`ticketApi`/`timesheetApi`.
 * WHY it exists separately from Insights.tsx: this is a fast, at-a-glance "how's everything
 * doing right now" view for daily use; Insights.tsx is the deeper analytics/trend-analysis
 * page for periodic review — different jobs, different pages, even though both chart the same
 * underlying data.
 * WHO renders this: `App.tsx`'s `/app` (index) route.
 */
import { useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  CalendarPlus2,
  CheckCircle2,
  Clock,
  Send,
  Ticket as TicketIcon,
  TrendingUp,
  Users2
} from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { DataTable } from "../components/ui/data-table";
import { Progress } from "../components/ui/progress";
import { StatCard, TrendBadge } from "../components/ui/stat-card";
import { computeTrend, type Trend } from "../lib/trend";
import { reportApi, ticketApi, timesheetApi, type TicketRow } from "../services/api";
import { useAuthStore } from "../store/auth";

function startOfWeek(date: Date) {
  const d = new Date(date);
  const day = (d.getDay() + 6) % 7;
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - day);
  return d;
}

const statusVariant: Record<string, "success" | "warning" | "destructive" | "muted"> = {
  APPROVED: "success",
  SUBMITTED: "warning",
  DRAFT: "muted",
  REJECTED: "destructive"
};

const recentActivityColumns: ColumnDef<any, any>[] = [
  { id: "date", accessorFn: (row: any) => row.workDate, header: "Date", cell: ({ row }) => <span className="whitespace-nowrap font-medium">{String(row.original.workDate).slice(0, 10)}</span> },
  { id: "project", accessorFn: (row: any) => row.project?.name, header: "Project" },
  { accessorKey: "activityType", header: "Activity" },
  {
    id: "hours",
    accessorFn: (row: any) => Number(row.totalHours),
    header: () => <span className="block text-right">Hours</span>,
    cell: ({ row }) => <span className="block text-right font-semibold">{Number(row.original.totalHours).toFixed(2)}</span>
  },
  {
    accessorKey: "status",
    header: "Status",
    cell: (info) => <Badge variant={statusVariant[info.getValue() as string] ?? "muted"}>{info.getValue() as string}</Badge>
  }
];

export function Dashboard() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.permissions.includes("reports:view");
  const admin = useQuery({
    queryKey: ["admin-summary"],
    queryFn: reportApi.admin,
    enabled: isAdmin,
    refetchInterval: 30_000
  });
  const security = useQuery({
    queryKey: ["reports", "security-insights"],
    queryFn: reportApi.securityInsights,
    enabled: isAdmin,
    refetchInterval: 60_000
  });
  const timesheets = useQuery({ queryKey: ["timesheets"], queryFn: timesheetApi.list });
  const daily = useQuery({ queryKey: ["daily-status"], queryFn: reportApi.dailyStatus });
  const myTickets = useQuery({
    queryKey: ["tickets", "for-dashboard", user?.id],
    queryFn: () => ticketApi.list({ assigneeId: user!.id, status: "OPEN,IN_PROGRESS,IN_REVIEW,REOPENED" }),
    enabled: Boolean(user?.id && user.permissions.includes("tickets:view"))
  });

  const all: any[] = Array.isArray(timesheets.data) ? timesheets.data : [];
  const recent = all.slice(0, 5);

  const { todayHours, weekHours, monthHours, pendingCount, trend } = useMemo(() => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = startOfWeek(today);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const buckets = new Map<string, number>();
    const dayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    for (const label of dayLabels) buckets.set(label, 0);
    let todayH = 0;
    let weekH = 0;
    let monthH = 0;
    let pending = 0;
    for (const row of all) {
      const hours = Number(row.totalHours ?? 0);
      const work = new Date(String(row.workDate));
      if (Number.isNaN(work.getTime())) continue;
      const workDay = new Date(work.getFullYear(), work.getMonth(), work.getDate());
      if (row.status === "SUBMITTED") pending += 1;
      if (workDay.getTime() === today.getTime()) todayH += hours;
      if (workDay >= weekStart && workDay <= today) {
        weekH += hours;
        const label = dayLabels[(workDay.getDay() + 6) % 7];
        buckets.set(label, (buckets.get(label) ?? 0) + hours);
      }
      if (workDay >= monthStart && workDay <= today) monthH += hours;
    }
    return {
      todayHours: todayH,
      weekHours: weekH,
      monthHours: monthH,
      pendingCount: pending,
      trend: dayLabels.map((day) => ({ day, hours: Number((buckets.get(day) ?? 0).toFixed(2)) }))
    };
  }, [all]);

  const projectTrend = useMemo(() => {
    const rows = admin.data?.byProject ?? [];
    return rows.map((row: any) => ({ name: row.project, value: Number(row._sum?.totalHours ?? 0) }));
  }, [admin.data]);

  const stats: Array<{ label: string; value: string | number; tone?: "success" | "warning" | "destructive"; trend?: Trend | null }> = isAdmin
    ? [
        { label: "Users", value: admin.data?.users ?? 0, trend: computeTrend(admin.data?.users ?? 0, admin.data?.usersYesterday ?? 0, true) },
        {
          label: "Projects",
          value: admin.data?.projects ?? 0,
          trend: computeTrend(admin.data?.projects ?? 0, admin.data?.projectsYesterday ?? 0, true)
        },
        {
          label: "Approved hours",
          value: Number(admin.data?.approvedHours ?? 0),
          tone: "success",
          trend: computeTrend(Number(admin.data?.approvedHours ?? 0), Number(admin.data?.approvedHoursYesterday ?? 0), true)
        },
        {
          label: "Pending approvals",
          value: admin.data?.pendingApprovals ?? 0,
          tone: "warning",
          trend: computeTrend(admin.data?.pendingApprovals ?? 0, admin.data?.pendingApprovalsYesterday ?? 0, false)
        },
        {
          label: "Security risk score",
          value: security.data?.riskScore ?? 0,
          tone: (security.data?.riskScore ?? 0) > 30 ? "destructive" : (security.data?.riskScore ?? 0) > 10 ? "warning" : "success",
          trend: computeTrend(security.data?.riskScore ?? 0, security.data?.riskScoreYesterday ?? 0, false)
        }
      ]
    : [
        { label: "Today", value: todayHours.toFixed(2) },
        { label: "This week", value: weekHours.toFixed(2) },
        { label: "This month", value: monthHours.toFixed(2) },
        { label: "Pending", value: pendingCount, tone: "warning" }
      ];

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight">{isAdmin ? "Admin command center" : "My timesheet dashboard"}</h1>
          <p className="mt-1 text-sm text-muted-foreground">Role-aware productivity, utilization, submissions, and operational signals.</p>
        </div>
        <Button asChild>
          <Link to="/app/timesheet"><CalendarPlus2 className="h-4 w-4" />Log new entry</Link>
        </Button>
      </div>

      {/* Personal daily status hero */}
      <DailyStatusBanner status={daily.data} loading={daily.isLoading} />

      {/* Open tickets assigned to me — any role */}
      <MyTicketsBanner tickets={myTickets.data} loading={myTickets.isLoading} />

      {/* Admin / manager: workforce daily logging snapshot */}
      {isAdmin && <WorkforceSnapshot data={admin.data} loading={admin.isLoading} />}

      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 md:grid-cols-4">
        {stats.map((stat, index) => (
          <motion.div
            key={stat.label}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, delay: index * 0.05 }}
          >
            <StatCard label={stat.label} value={String(stat.value)} tone={stat.tone} trend={stat.trend} trendLabel="vs yesterday" />
          </motion.div>
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.3fr_0.7fr]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <TrendingUp className="h-4 w-4 text-primary" /> Weekly productivity
            </CardTitle>
            <CardDescription>Your logged hours, Mon–Sun.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trend}>
                  <defs>
                    <linearGradient id="primaryGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="day" stroke="hsl(var(--muted-foreground))" fontSize={12} />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} />
                  <Tooltip contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, color: "hsl(var(--popover-foreground))" }} />
                  <Area dataKey="hours" stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#primaryGrad)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Project utilization</CardTitle>
            <CardDescription>{isAdmin ? "Across the workspace." : "Sign in as an admin for full breakdown."}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={projectTrend}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="name" stroke="hsl(var(--muted-foreground))" fontSize={12} />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} />
                  <Tooltip contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, color: "hsl(var(--popover-foreground))" }} />
                  <Bar dataKey="value" fill="hsl(var(--accent))" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent activity</CardTitle>
          <CardDescription>Latest entries across your timesheets.</CardDescription>
        </CardHeader>
        <CardContent className="p-4">
          <DataTable
            columns={recentActivityColumns}
            data={recent}
            enableSearch={false}
            pageSize={5}
            emptyMessage="No timesheets logged yet."
          />
          {!recent.length && (
            <div className="pb-4 text-center">
              <Link to="/app/timesheet" className="text-sm font-semibold text-primary hover:underline">
                Log your first entry →
              </Link>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function DailyStatusBanner({
  status,
  loading
}: {
  status?: { hours: number; entries: number; reminderReceived: boolean; escalated: boolean; date: string };
  loading: boolean;
}) {
  if (loading || !status) return null;

  const logged = status.hours > 0;

  if (status.escalated) {
    return (
      <Alert variant="destructive">
        <AlertTriangle />
        <AlertTitle>Action required — yesterday's log was escalated</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center gap-3">
          <span>You missed yesterday's timesheet and it's now visible to your manager. Catch up and file today's entry before 5 PM to avoid an SLA breach.</span>
          <Button asChild size="sm" variant="destructive">
            <Link to="/app/timesheet"><Send className="h-4 w-4" />Catch up now</Link>
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  if (!logged) {
    return (
      <Alert variant={status.reminderReceived ? "warning" : "info"}>
        <Clock />
        <AlertTitle>
          {status.reminderReceived
            ? "Daily reminder sent — log today's time"
            : `No entry for ${status.date} yet`}
        </AlertTitle>
        <AlertDescription className="flex flex-wrap items-center gap-3">
          <span>
            {status.reminderReceived
              ? "You'll get an escalation tomorrow morning if today stays empty. Two minutes now and it's done."
              : "Capture today's work to keep the chain clean — your manager sees it instantly."}
          </span>
          <Button asChild size="sm">
            <Link to="/app/timesheet"><Send className="h-4 w-4" />Log time</Link>
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert variant="success">
      <CheckCircle2 />
      <AlertTitle>Today's timesheet is logged</AlertTitle>
      <AlertDescription>
        {status.hours.toFixed(2)} hours captured across {status.entries} {status.entries === 1 ? "entry" : "entries"}. Nice.
      </AlertDescription>
    </Alert>
  );
}

function MyTicketsBanner({ tickets, loading }: { tickets?: TicketRow[]; loading: boolean }) {
  if (loading || !tickets || tickets.length === 0) return null;
  const overdue = tickets.filter((t) => t.slaBreachAt).length;

  return (
    <Alert variant={overdue > 0 ? "destructive" : "info"}>
      <TicketIcon />
      <AlertTitle>
        {tickets.length} open ticket{tickets.length === 1 ? "" : "s"} assigned to you
        {overdue > 0 ? ` — ${overdue} overdue` : ""}
      </AlertTitle>
      <AlertDescription className="flex flex-wrap items-center gap-3">
        <span>Bugs and tasks waiting on you.</span>
        <Button asChild size="sm" variant={overdue > 0 ? "destructive" : "default"}>
          <Link to="/app/tickets"><TicketIcon className="h-4 w-4" />View tickets</Link>
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function WorkforceSnapshot({ data, loading }: { data?: any; loading: boolean }) {
  if (loading || !data) return null;
  const active = Number(data.activeWorkforce ?? 0);
  const logged = Number(data.loggedToday ?? 0);
  const notLogged = Number(data.notLoggedToday ?? 0);
  const reminders = Number(data.todayDailyRemindersSent ?? 0);
  const escalations = Number(data.todayEscalationsSent ?? 0);
  const percent = active > 0 ? Math.round((logged / active) * 100) : 0;

  const loggedYesterday = Number(data.loggedYesterday ?? 0);
  const ytdAvgLoggedPerDay = Number(data.ytdAvgLoggedPerDay ?? 0);
  const vsYesterday = computeTrend(logged, loggedYesterday, true);
  const vsYtdAvg = computeTrend(logged, ytdAvgLoggedPerDay, true);
  const notFilledTrend = computeTrend(notLogged, active - loggedYesterday, false);
  const remindersTrend = computeTrend(reminders, Number(data.todayDailyRemindersSentYesterday ?? 0), false);
  const escalationsTrend = computeTrend(escalations, Number(data.todayEscalationsSentYesterday ?? 0), false);

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-3 space-y-0 pb-3">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <Users2 className="h-4 w-4 text-primary" />
            Today across the workforce
          </CardTitle>
          <CardDescription>{logged} of {active} active employees & team leads have logged something today.</CardDescription>
        </div>
        <Badge variant={percent >= 80 ? "success" : percent >= 50 ? "warning" : "destructive"}>{percent}%</Badge>
      </CardHeader>
      <CardContent className="grid gap-4">
        <Progress value={percent} className={percent < 50 ? "[&>div]:bg-destructive" : percent < 80 ? "[&>div]:bg-warning" : ""} />
        {(vsYesterday || vsYtdAvg) && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {vsYesterday && (
              <span className="inline-flex items-center gap-1">
                vs. yesterday ({loggedYesterday}) <TrendBadge trend={vsYesterday} />
              </span>
            )}
            {vsYtdAvg && (
              <span className="inline-flex items-center gap-1">
                vs. YTD daily avg ({ytdAvgLoggedPerDay.toFixed(1)}) <TrendBadge trend={vsYtdAvg} />
              </span>
            )}
          </div>
        )}
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 sm:gap-3">
          <StatCard label="Filled today" value={logged} tone="success" icon={<CheckCircle2 className="h-4 w-4" />} trend={vsYesterday} trendLabel="vs yesterday" />
          <StatCard label="Not filled" value={notLogged} tone={notLogged > 0 ? "warning" : "default"} icon={<Clock className="h-4 w-4" />} trend={notFilledTrend} trendLabel="vs yesterday" />
          <StatCard label="Reminders sent" value={reminders} icon={<Send className="h-4 w-4" />} trend={remindersTrend} trendLabel="vs yesterday" />
          <StatCard label="Escalations sent" value={escalations} tone={escalations > 0 ? "destructive" : "default"} icon={<AlertTriangle className="h-4 w-4" />} trend={escalationsTrend} trendLabel="vs yesterday" />
        </div>
      </CardContent>
    </Card>
  );
}
