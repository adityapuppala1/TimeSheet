/**
 * WHAT: the post-login landing page — a Trackline-style overview built from four bands:
 * three hero cards (week-at-a-glance segmented bar, weekday activity chart, progress meters),
 * a "today" timeline of the user's actual logged entries, the role-aware operational banners,
 * and a per-project rollup table.
 * WHY this shape: everything on it answers "how am I doing right now" from data the app
 * already returns (the timesheet list, daily status, ticket list, admin summary) — no
 * dashboard-only endpoints. The timeline is the one genuinely novel surface, and it exists
 * because timesheet entries carry real start/end times AND the server forbids overlaps, which
 * guarantees a clean single-track day view with zero collision handling.
 * WHY it exists separately from Insights.tsx: this is a fast, at-a-glance "how's everything
 * doing right now" view for daily use; Insights.tsx is the deeper analytics/trend-analysis
 * page for periodic review — different jobs, different pages.
 * Chart conventions (see the dataviz notes in the PR that introduced this layout): every chart
 * here is single-series (titled, so no legend); the only adjacent color trio is the
 * approved/pending/rejected STATUS bar, which always ships with labeled value rows and 2px
 * segment gaps so state is never encoded by color alone.
 * WHO renders this: `App.tsx`'s `/app` (index) route.
 */
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  CalendarPlus2,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  FolderKanban,
  Gauge,
  Send,
  Ticket as TicketIcon,
  TrendingUp,
  Users2
} from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { SetupChecklistCard } from "../components/SetupChecklistCard";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Progress } from "../components/ui/progress";
import { Skeleton } from "../components/ui/skeleton";
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

/** Minutes since midnight from an "HH:MM" time string. */
function toMinutes(time: string): number {
  const [h, m] = String(time).split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/**
 * "YYYY-MM-DD" from a Date's LOCAL calendar components. Never use toISOString() for day
 * equality: local midnight in any UTC+N timezone converts to the PREVIOUS UTC day, which is
 * exactly the bug that made "today's timeline" render empty in IST while the (server-computed)
 * daily banner correctly said hours were logged.
 */
function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The stored workDate is UTC midnight of the intended CALENDAR day, so the day is the first 10
 *  chars of the ISO string — and range comparisons must use a LOCAL date built from those parts
 *  (parsing the ISO directly lands on the wrong local day in UTC-negative timezones). */
function workDateParts(workDate: string): { key: string; local: Date } {
  const key = String(workDate).slice(0, 10);
  const [y, m, d] = key.split("-").map(Number);
  return { key, local: new Date(y, (m || 1) - 1, d || 1) };
}

interface TimesheetRowLite {
  id: string;
  workDate: string;
  startTime: string;
  endTime: string;
  totalHours: number | string;
  status: string;
  activityType?: string;
  identityVerified?: boolean;
  project?: { id?: string; name?: string; code?: string };
}

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

  const all: TimesheetRowLite[] = Array.isArray(timesheets.data) ? timesheets.data : [];

  /** One pass over the (max 100-row) timesheet list feeds every personal surface below. */
  const derived = useMemo(() => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayKey = localDateKey(today);
    const weekStart = startOfWeek(today);
    const lastWeekStart = new Date(weekStart.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const dayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const buckets = new Map<string, number>(dayLabels.map((l) => [l, 0]));

    let weekH = 0;
    let lastWeekH = 0;
    let monthH = 0;
    let pendingCount = 0;
    const weekByStatus = { APPROVED: 0, SUBMITTED: 0, REJECTED: 0, DRAFT: 0 } as Record<string, number>;
    const monthByStatus = { APPROVED: 0, SUBMITTED: 0, REJECTED: 0, DRAFT: 0 } as Record<string, number>;
    /** Every loaded entry grouped by calendar day — the timeline's date picker reads this. */
    const entriesByDate = new Map<string, TimesheetRowLite[]>();

    interface ProjectRoll {
      id: string;
      name: string;
      code?: string;
      monthHours: number;
      approvedHours: number;
      entries: number;
      lastDate: string;
    }
    const projects = new Map<string, ProjectRoll>();

    for (const row of all) {
      const hours = Number(row.totalHours ?? 0);
      const { key: dateKey, local: workDay } = workDateParts(String(row.workDate));
      if (Number.isNaN(workDay.getTime())) continue;

      if (row.status === "SUBMITTED") pendingCount += 1;

      const dayList = entriesByDate.get(dateKey) ?? [];
      dayList.push(row);
      entriesByDate.set(dateKey, dayList);

      if (workDay >= weekStart && workDay <= today) {
        weekH += hours;
        weekByStatus[row.status] = (weekByStatus[row.status] ?? 0) + hours;
        const label = dayLabels[(workDay.getDay() + 6) % 7];
        buckets.set(label, (buckets.get(label) ?? 0) + hours);
      }
      if (workDay >= lastWeekStart && workDay < weekStart) lastWeekH += hours;
      if (workDay >= monthStart && workDay <= today) {
        monthH += hours;
        monthByStatus[row.status] = (monthByStatus[row.status] ?? 0) + hours;

        const key = row.project?.id ?? row.project?.name ?? "unknown";
        const roll = projects.get(key) ?? {
          id: key,
          name: row.project?.name ?? "—",
          code: row.project?.code,
          monthHours: 0,
          approvedHours: 0,
          entries: 0,
          lastDate: dateKey
        };
        roll.monthHours += hours;
        if (row.status === "APPROVED") roll.approvedHours += hours;
        roll.entries += 1;
        if (dateKey > roll.lastDate) roll.lastDate = dateKey;
        projects.set(key, roll);
      }
    }

    for (const list of entriesByDate.values()) list.sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));

    const todayEntries = entriesByDate.get(todayKey) ?? [];
    return {
      todayKey,
      todayHours: todayEntries.reduce((sum, e) => sum + Number(e.totalHours ?? 0), 0),
      weekHours: weekH,
      lastWeekHours: lastWeekH,
      monthHours: monthH,
      pendingCount,
      weekByStatus,
      monthByStatus,
      entriesByDate,
      projectRows: [...projects.values()].sort((a, b) => b.monthHours - a.monthHours),
      trend: dayLabels.map((day) => ({ day, hours: Number((buckets.get(day) ?? 0).toFixed(2)) }))
    };
  }, [all]);

  const projectTrend = useMemo(() => {
    const rows = admin.data?.byProject ?? [];
    return rows.map((row: any) => ({ name: row.project, value: Number(row._sum?.totalHours ?? 0) }));
  }, [admin.data]);

  const openTicketsByProject = useMemo(() => {
    const counts = new Map<string, number>();
    for (const ticket of myTickets.data ?? []) {
      const key = (ticket as TicketRow & { project?: { id?: string } }).project?.id;
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [myTickets.data]);

  const adminStats: Array<{ label: string; value: string | number; tone?: "success" | "warning" | "destructive"; trend?: Trend | null }> = [
    { label: "Users", value: admin.data?.users ?? 0, trend: computeTrend(admin.data?.users ?? 0, admin.data?.usersYesterday ?? 0, true) },
    { label: "Projects", value: admin.data?.projects ?? 0, trend: computeTrend(admin.data?.projects ?? 0, admin.data?.projectsYesterday ?? 0, true) },
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
  ];

  const todayLabel = new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
  const firstName = user?.name?.split(" ")[0] ?? "there";

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight">{isAdmin ? "Admin command center" : `Good day, ${firstName}`}</h1>
          <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
            <CalendarClock className="h-3.5 w-3.5" />
            {todayLabel} — role-aware productivity, submissions, and operational signals.
          </p>
        </div>
        <div className="flex gap-2">
          {isAdmin && (
            <Button asChild variant="outline">
              <Link to="/app/approvals"><CheckCircle2 className="h-4 w-4" />Approvals</Link>
            </Button>
          )}
          <Button asChild>
            <Link to="/app/timesheet"><CalendarPlus2 className="h-4 w-4" />Log new entry</Link>
          </Button>
        </div>
      </div>

      {/* First-run checklist — self-hides once complete (or dismissed, unless a REQUIRED face
          enrollment is pending, which blocks real submissions and so stays visible). */}
      <SetupChecklistCard />

      {/* Personal daily status hero */}
      <DailyStatusBanner status={daily.data} loading={daily.isLoading} />

      {/* Open tickets assigned to me — any role */}
      <MyTicketsBanner tickets={myTickets.data} loading={myTickets.isLoading} />

      {/* ---- Hero band: week at a glance / activity / progress ---- */}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <HeroCard delay={0}>
          <WeekAtAGlance
            loading={timesheets.isLoading}
            weekHours={derived.weekHours}
            byStatus={derived.weekByStatus}
            pendingCount={derived.pendingCount}
          />
        </HeroCard>
        <HeroCard delay={0.05}>
          <ActivityCard loading={timesheets.isLoading} trend={derived.trend} weekHours={derived.weekHours} lastWeekHours={derived.lastWeekHours} />
        </HeroCard>
        <HeroCard delay={0.1} className="md:col-span-2 xl:col-span-1">
          <ProgressCard
            loading={timesheets.isLoading}
            weekHours={derived.weekHours}
            monthByStatus={derived.monthByStatus}
            monthHours={derived.monthHours}
          />
        </HeroCard>
      </div>

      {/* ---- Day timeline — real entries on a real clock, any loaded date ---- */}
      <DayTimeline entriesByDate={derived.entriesByDate} todayKey={derived.todayKey} loading={timesheets.isLoading} />

      {/* Admin / manager: workforce daily logging snapshot */}
      {isAdmin && <WorkforceSnapshot data={admin.data} loading={admin.isLoading} />}

      {isAdmin && (
        <div className="grid grid-cols-2 gap-2.5 sm:gap-3 md:grid-cols-5">
          {adminStats.map((stat, index) => (
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
      )}

      <div className="grid gap-5 lg:grid-cols-[1.3fr_0.7fr]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <TrendingUp className="h-4 w-4 text-primary" /> Weekly productivity
            </CardTitle>
            <CardDescription>Your logged hours, Mon–Sun.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={derived.trend}>
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
            <div className="h-64">
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

      {/* ---- Per-project rollup — the Trackline "Project List", from data already loaded ---- */}
      <ProjectRollup rows={derived.projectRows} openTicketsByProject={openTicketsByProject} loading={timesheets.isLoading} />
    </div>
  );
}

/* ================================ Hero band ================================ */

function HeroCard({ children, delay, className }: { children: React.ReactNode; delay: number; className?: string }) {
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, delay }} className={className}>
      {children}
    </motion.div>
  );
}

const WEEK_SEGMENTS = [
  { key: "APPROVED", label: "Approved", bar: "bg-success", dot: "bg-success" },
  { key: "SUBMITTED", label: "Pending review", bar: "bg-warning", dot: "bg-warning" },
  { key: "REJECTED", label: "Rejected", bar: "bg-destructive", dot: "bg-destructive" },
  { key: "DRAFT", label: "Draft", bar: "bg-muted-foreground/40", dot: "bg-muted-foreground/40" }
] as const;

/** Trackline's "Overall Tasks" card, for hours: headline number + a segmented STATUS bar.
 *  Every segment also gets a labeled value row below — state is never color-alone (the
 *  green↔amber pair sits in the CVD warn band, which is only acceptable with exactly this
 *  kind of secondary encoding). */
function WeekAtAGlance({
  loading,
  weekHours,
  byStatus,
  pendingCount
}: {
  loading: boolean;
  weekHours: number;
  byStatus: Record<string, number>;
  pendingCount: number;
}) {
  if (loading) return <Skeleton className="h-full min-h-56 w-full" />;
  const total = weekHours || 1;
  const segments = WEEK_SEGMENTS.map((s) => ({ ...s, hours: byStatus[s.key] ?? 0 })).filter((s) => s.hours > 0);

  return (
    <Card className="h-full">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Clock className="h-4 w-4 text-primary" />
          This week
        </CardTitle>
        <CardDescription>Your logged hours by state, Monday to today.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex items-baseline justify-between">
          <p className="text-3xl font-black tabular-nums tracking-tight">{weekHours.toFixed(1)}h</p>
          {pendingCount > 0 && <Badge variant="warning">{pendingCount} awaiting review</Badge>}
        </div>

        {/* 2px gaps between segments are part of the encoding, not decoration. */}
        {segments.length > 0 ? (
          <div className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full">
            {segments.map((s) => (
              <div key={s.key} className={`${s.bar} rounded-sm`} style={{ width: `${(s.hours / total) * 100}%` }} title={`${s.label}: ${s.hours.toFixed(1)}h`} />
            ))}
          </div>
        ) : (
          <div className="h-2.5 w-full rounded-full bg-muted" />
        )}

        <div className="grid gap-1.5">
          {WEEK_SEGMENTS.map((s) => (
            <div key={s.key} className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${s.dot}`} aria-hidden />
                {s.label}
              </span>
              <span className="font-semibold tabular-nums">{(byStatus[s.key] ?? 0).toFixed(1)}h</span>
            </div>
          ))}
        </div>

        <Link to="/app/history" className="mt-auto inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline">
          View history <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </CardContent>
    </Card>
  );
}

/** Trackline's "Project Track": a compact single-series weekday chart + the week-over-week
 *  insight strip. Single series → the title names it, no legend. */
function ActivityCard({
  loading,
  trend,
  weekHours,
  lastWeekHours
}: {
  loading: boolean;
  trend: Array<{ day: string; hours: number }>;
  weekHours: number;
  lastWeekHours: number;
}) {
  if (loading) return <Skeleton className="h-full min-h-56 w-full" />;
  const delta = computeTrend(weekHours, lastWeekHours, true);
  const up = weekHours >= lastWeekHours;

  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <TrendingUp className="h-4 w-4 text-primary" />
              Daily rhythm
            </CardTitle>
            <CardDescription>Hours logged per weekday, this week.</CardDescription>
          </div>
          {delta && <TrendBadge trend={delta} label="vs last week" />}
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        <div className="h-36 flex-1">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={trend} margin={{ top: 4, right: 0, bottom: 0, left: -28 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="day" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
              <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
              <Tooltip
                cursor={{ fill: "hsl(var(--muted) / 0.5)" }}
                contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, color: "hsl(var(--popover-foreground))" }}
              />
              <Bar dataKey="hours" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} maxBarSize={22} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* The Trackline-style insight strip — computed, never invented. */}
        {(weekHours > 0 || lastWeekHours > 0) && (
          <div
            className={`flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm ${
              up ? "bg-success/10 text-success" : "bg-warning/10 text-warning"
            }`}
          >
            <span>
              {up
                ? lastWeekHours === 0
                  ? "First hours of a fresh week — nice start!"
                  : `Up ${(weekHours - lastWeekHours).toFixed(1)}h on last week — great momentum!`
                : `${(lastWeekHours - weekHours).toFixed(1)}h behind last week's pace so far.`}
            </span>
            <ArrowRight className="h-4 w-4 shrink-0" />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Trackline's "Project Progress" tick-meters, on the two rates that matter here: progress
 *  toward a 40h logged week, and how much of this month's logged time has been approved. */
function ProgressCard({
  loading,
  weekHours,
  monthByStatus,
  monthHours
}: {
  loading: boolean;
  weekHours: number;
  monthByStatus: Record<string, number>;
  monthHours: number;
}) {
  if (loading) return <Skeleton className="h-full min-h-56 w-full" />;
  const weekTarget = 40;
  const weekPct = Math.min(100, Math.round((weekHours / weekTarget) * 100));
  const approvalPct = monthHours > 0 ? Math.round(((monthByStatus.APPROVED ?? 0) / monthHours) * 100) : 0;

  return (
    <Card className="h-full">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Gauge className="h-4 w-4 text-primary" />
          Progress
        </CardTitle>
        <CardDescription>Week target and month approval rate.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        <TickMeter label={`Week target (${weekTarget}h)`} percent={weekPct} detail={`${weekHours.toFixed(1)}h logged`} tone="primary" />
        <TickMeter
          label="Approved this month"
          percent={approvalPct}
          detail={`${(monthByStatus.APPROVED ?? 0).toFixed(1)}h of ${monthHours.toFixed(1)}h`}
          tone="success"
        />
        <p className="text-xs text-muted-foreground">
          Approval rate counts hours a manager has signed off. Pending hours move here once reviewed.
        </p>
      </CardContent>
    </Card>
  );
}

/** The Trackline dotted meter: ~36 thin ticks, filled left-to-right. Sequential (one hue) —
 *  magnitude, not identity — with the number said in text right beside it. */
function TickMeter({ label, percent, detail, tone }: { label: string; percent: number; detail: string; tone: "primary" | "success" }) {
  const TICKS = 36;
  const filled = Math.round((percent / 100) * TICKS);
  const fill = tone === "primary" ? "bg-primary" : "bg-success";

  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-lg font-black tabular-nums">{percent}%</p>
      </div>
      <div className="flex items-end gap-[3px]" role="img" aria-label={`${label}: ${percent}%`}>
        {Array.from({ length: TICKS }, (_, i) => (
          <span key={i} className={`h-4 w-1 rounded-full ${i < filled ? fill : "bg-muted"}`} />
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

/* ============================== Day timeline ============================== */

/**
 * The user's actual day on an actual clock — possible only because entries carry real
 * start/end times and the server rejects overlapping ranges, so this is guaranteed to be a
 * clean single track. Blocks are colored by STATUS and always carry their text label.
 * The date picker walks any day present in the loaded list (the API returns the latest 100
 * entries, so recent weeks are all navigable).
 */
function DayTimeline({
  entriesByDate,
  todayKey,
  loading
}: {
  entriesByDate: Map<string, TimesheetRowLite[]>;
  todayKey: string;
  loading: boolean;
}) {
  const [selectedKey, setSelectedKey] = useState(todayKey);
  const isToday = selectedKey === todayKey;
  const entries = entriesByDate.get(selectedKey) ?? [];
  const dayHours = entries.reduce((sum, e) => sum + Number(e.totalHours ?? 0), 0);

  const shiftDay = (delta: number) => {
    const [y, m, d] = selectedKey.split("-").map(Number);
    const next = new Date(y, (m || 1) - 1, (d || 1) + delta);
    const nextKey = localDateKey(next);
    if (nextKey > todayKey) return; // no future days
    setSelectedKey(nextKey);
  };

  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  // Window defaults to the 07:00–19:00 working day and stretches to fit early/late entries.
  let windowStart = 7 * 60;
  let windowEnd = 19 * 60;
  for (const entry of entries) {
    windowStart = Math.min(windowStart, Math.floor(toMinutes(entry.startTime) / 60) * 60);
    windowEnd = Math.max(windowEnd, Math.ceil(toMinutes(entry.endTime) / 60) * 60);
  }
  const span = windowEnd - windowStart;
  const pct = (minutes: number) => ((minutes - windowStart) / span) * 100;

  const hourTicks: number[] = [];
  for (let m = windowStart; m <= windowEnd; m += 120) hourTicks.push(m);

  const blockTone: Record<string, string> = {
    APPROVED: "border-success/50 bg-success/15 text-success",
    SUBMITTED: "border-warning/50 bg-warning/15 text-warning",
    REJECTED: "border-destructive/50 bg-destructive/15 text-destructive",
    DRAFT: "border-border bg-muted text-muted-foreground"
  };

  const [sy, sm, sd] = selectedKey.split("-").map(Number);
  const selectedLabel = new Date(sy, (sm || 1) - 1, sd || 1).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short"
  });

  return (
    <Card>
      {/* Stacks title-over-controls on phones, splits left/right from lg up. Explicit flex-row
          on the wide branch — CardHeader's base is flex-col, and `flex` alone inherits that
          direction, which is what previously centered the whole header. */}
      <CardHeader className="flex flex-col gap-3 space-y-0 pb-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarClock className="h-4 w-4 text-primary" />
            Day timeline
          </CardTitle>
          <CardDescription>Your logged entries on the clock — colors follow entry status. Covers your latest 100 entries.</CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={dayHours > 0 ? "success" : "muted"} className="whitespace-nowrap">
            {dayHours.toFixed(2)}h {isToday ? "today" : `on ${selectedLabel}`}
          </Badge>
          <div className="flex items-center gap-1 rounded-lg border border-border p-0.5">
            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Previous day" onClick={() => shiftDay(-1)}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <input
              type="date"
              aria-label="Timeline date"
              value={selectedKey}
              max={todayKey}
              onChange={(e) => {
                if (e.target.value && e.target.value <= todayKey) setSelectedKey(e.target.value);
              }}
              className="h-7 w-[8.5rem] rounded-md border-0 bg-transparent px-1 text-sm tabular-nums text-foreground outline-none [color-scheme:light] dark:[color-scheme:dark]"
            />
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              aria-label="Next day"
              disabled={isToday}
              onClick={() => shiftDay(1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
          {!isToday && (
            <Button variant="outline" size="sm" onClick={() => setSelectedKey(todayKey)}>
              Today
            </Button>
          )}
          <Button asChild size="sm" variant="outline">
            <Link to="/app/timesheet"><CalendarPlus2 className="h-3.5 w-3.5" />Add</Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <div className="overflow-x-auto">
            <div className="min-w-[560px]">
              {/* Hour axis. Edge labels anchor inward (first left-aligned, last right-aligned)
                  instead of centering on the tick — a centered edge label hangs half outside
                  the container, which manifested as a phantom horizontal scrollbar. */}
              <div className="relative h-5 text-[11px] text-muted-foreground">
                {hourTicks.map((m, i) => (
                  <span
                    key={m}
                    className={`absolute tabular-nums ${i === 0 ? "" : i === hourTicks.length - 1 ? "-translate-x-full" : "-translate-x-1/2"}`}
                    style={{ left: `${pct(m)}%` }}
                  >
                    {String(Math.floor(m / 60)).padStart(2, "0")}:00
                  </span>
                ))}
              </div>

              <div className="relative h-16 rounded-lg border border-border bg-muted/20" data-testid="day-timeline-track">
                {/* Grid lines every 2h, recessive */}
                {hourTicks.map((m) => (
                  <span key={m} className="absolute inset-y-0 border-l border-dashed border-border/60" style={{ left: `${pct(m)}%` }} aria-hidden />
                ))}

                {/* "Now" marker — only meaningful on today's view */}
                {isToday && nowMinutes >= windowStart && nowMinutes <= windowEnd && (
                  <span className="absolute inset-y-0 z-10 w-0.5 bg-primary" style={{ left: `${pct(nowMinutes)}%` }} title="Now" aria-label="Current time" />
                )}

                {entries.map((entry) => {
                  const start = toMinutes(entry.startTime);
                  const end = toMinutes(entry.endTime);
                  const width = Math.max(pct(end) - pct(start), 2);
                  const label = `${entry.project?.name ?? entry.activityType ?? "Entry"} · ${Number(entry.totalHours).toFixed(2)}h`;
                  return (
                    <Link
                      key={entry.id}
                      to="/app/history"
                      data-testid="timeline-entry"
                      className={`absolute top-2 bottom-2 flex items-center overflow-hidden rounded-md border px-2 text-xs font-medium ring-2 ring-background transition-transform hover:scale-[1.02] ${blockTone[entry.status] ?? blockTone.DRAFT}`}
                      style={{ left: `${pct(start)}%`, width: `${width}%` }}
                      title={`${entry.startTime}–${entry.endTime} · ${label} · ${entry.status}`}
                    >
                      <span className="truncate">{label}</span>
                    </Link>
                  );
                })}

                {entries.length === 0 && (
                  <div className="absolute inset-0 flex items-center justify-center gap-2 px-4 text-center text-sm text-muted-foreground">
                    {isToday ? "Nothing logged yet today." : `Nothing logged on ${selectedLabel}.`}
                    {isToday && (
                      <Link to="/app/timesheet" className="font-semibold text-primary hover:underline">
                        Log your first entry →
                      </Link>
                    )}
                  </div>
                )}
              </div>

              {/* Status key — labels, not color-alone */}
              {entries.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
                  {WEEK_SEGMENTS.map((s) => (
                    <span key={s.key} className="inline-flex items-center gap-1.5">
                      <span className={`h-2 w-2 rounded-full ${s.dot}`} aria-hidden />
                      {s.label}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ============================== Project rollup ============================== */

function ProjectRollup({
  rows,
  openTicketsByProject,
  loading
}: {
  rows: Array<{ id: string; name: string; code?: string; monthHours: number; approvedHours: number; entries: number; lastDate: string }>;
  openTicketsByProject: Map<string, number>;
  loading: boolean;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <FolderKanban className="h-4 w-4 text-primary" />
          My projects this month
        </CardTitle>
        <CardDescription>Hours, approval progress, and open tickets per project you've logged against.</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-32 w-full" />
        ) : rows.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No entries this month yet.{" "}
            <Link to="/app/timesheet" className="font-semibold text-primary hover:underline">
              Log your first entry →
            </Link>
          </div>
        ) : (
          <>
            {/* Desktop table / mobile cards — same dual rendering the Tickets page uses. */}
            <div className="hidden overflow-x-auto sm:block">
              <table className="w-full text-sm">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="p-2 font-medium">Project</th>
                    <th className="p-2 text-right font-medium">Hours</th>
                    <th className="p-2 text-right font-medium">Entries</th>
                    <th className="p-2 text-right font-medium">Open tickets</th>
                    <th className="p-2 font-medium">Last entry</th>
                    <th className="w-[26%] p-2 font-medium">Approved</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const approvedPct = row.monthHours > 0 ? Math.round((row.approvedHours / row.monthHours) * 100) : 0;
                    const open = openTicketsByProject.get(row.id) ?? 0;
                    return (
                      <tr key={row.id} className="border-t border-border">
                        <td className="p-2">
                          <span className="font-medium">{row.name}</span>
                          {row.code && <span className="ml-2 font-mono text-xs text-muted-foreground">{row.code}</span>}
                        </td>
                        <td className="p-2 text-right font-semibold tabular-nums">{row.monthHours.toFixed(1)}</td>
                        <td className="p-2 text-right tabular-nums text-muted-foreground">{row.entries}</td>
                        <td className="p-2 text-right">
                          {open > 0 ? (
                            <Badge variant="info"><TicketIcon className="mr-1 h-3 w-3" />{open}</Badge>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="p-2 text-muted-foreground">{row.lastDate}</td>
                        <td className="p-2">
                          <div className="flex items-center gap-2">
                            <Progress value={approvedPct} className="h-1.5" />
                            <span className="w-9 text-right text-xs font-semibold tabular-nums">{approvedPct}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="grid gap-2 sm:hidden">
              {rows.map((row) => {
                const approvedPct = row.monthHours > 0 ? Math.round((row.approvedHours / row.monthHours) * 100) : 0;
                const open = openTicketsByProject.get(row.id) ?? 0;
                return (
                  <div key={row.id} className="rounded-lg border border-border p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="min-w-0 truncate font-medium">{row.name}</p>
                      <span className="font-semibold tabular-nums">{row.monthHours.toFixed(1)}h</span>
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <Progress value={approvedPct} className="h-1.5" />
                      <span className="text-xs font-semibold tabular-nums">{approvedPct}%</span>
                    </div>
                    <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                      <span>{row.entries} entries · last {row.lastDate}</span>
                      {open > 0 && <Badge variant="info">{open} open</Badge>}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/* ============================== Banners (unchanged behavior) ============================== */

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
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0 pb-3">
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
        <div className="grid grid-cols-2 gap-2.5 text-sm sm:grid-cols-5">
          <SnapshotStat label="Logged today" value={logged} trend={vsYesterday} trendLabel="vs yesterday" />
          <SnapshotStat label="Not yet filled" value={notLogged} trend={notFilledTrend} trendLabel="vs yesterday" />
          <SnapshotStat label="Reminders sent" value={reminders} trend={remindersTrend} trendLabel="vs yesterday" />
          <SnapshotStat label="Escalations" value={escalations} trend={escalationsTrend} trendLabel="vs yesterday" />
          <SnapshotStat label="vs YTD avg/day" value={`${ytdAvgLoggedPerDay.toFixed(1)}`} trend={vsYtdAvg} trendLabel="today vs avg" />
        </div>
      </CardContent>
    </Card>
  );
}

function SnapshotStat({ label, value, trend, trendLabel }: { label: string; value: string | number; trend: Trend | null; trendLabel: string }) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-2.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-1 flex items-center justify-between gap-1">
        <p className="text-lg font-bold tabular-nums">{value}</p>
        {trend && <TrendBadge trend={trend} label={trendLabel} />}
      </div>
    </div>
  );
}
