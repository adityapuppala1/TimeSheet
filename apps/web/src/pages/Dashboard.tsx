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
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Clock3,
  FolderKanban,
  GitPullRequestArrow,
  Gauge,
  Maximize2,
  PencilLine,
  Send,
  Ticket as TicketIcon,
  TrendingUp,
  Users2,
  X
} from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
// Aliased: `Tooltip` in this module is recharts' chart tooltip, and the rollup table needs the
// UI one. Importing both unaliased would silently shadow whichever came second.
import {
  Tooltip as HoverTip,
  TooltipContent as HoverTipContent,
  TooltipTrigger as HoverTipTrigger
} from "../components/ui/tooltip";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { useDismissed } from "../hooks/use-dismissed";
import { GoalsGlanceCard } from "../components/GoalsGlanceCard";
import { SetupChecklistCard } from "../components/SetupChecklistCard";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Progress } from "../components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { StatCard, TrendBadge } from "../components/ui/stat-card";
import { ProjectUtilizationChart } from "../components/ProjectUtilizationChart";
import { TimesheetEntryDialog } from "../components/TimesheetEntryDialog";
import { computeTrend, type Trend } from "../lib/trend";
import { changeApi, dashboardApi, reportApi, ticketApi, timesheetApi, type MyMonthRollup, type TicketRow } from "../services/api";
import { DateRangePicker, type DateRangeValue } from "../components/ui/date-range-picker";
import type { CalendarDayAnnotations } from "../components/ui/calendar-primitives";
import { useAuthStore } from "../store/auth";
import { DatePicker } from "../components/ui/date-picker";

/** Mon–Fri days in an inclusive range. The week target scales against this rather than staying
 *  pinned to 40h: a one-day range against a 40h bar reads as a 5% week, and a month reads as 400%,
 *  so the bar stops meaning anything the moment the page can show something other than a week. */
function countWorkingDays(from: Date, to: Date): number {
  let count = 0;
  for (const day = new Date(from); day <= to; day.setDate(day.getDate() + 1)) {
    const weekday = day.getDay();
    if (weekday !== 0 && weekday !== 6) count += 1;
  }
  return count;
}

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
  /** Present on the admin/approver view — the list endpoint returns everyone they can see, which
   *  is exactly why the timeline lanes by user rather than piling every person onto one track. */
  user?: { id?: string; name?: string };
  userId?: string;
}

function isoToLocalDate(iso: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

/** Monday-to-today, as ISO. The page's default window — it is what every card showed before there
 *  was anything to choose. */
function thisWeekRange(): DateRangeValue {
  const now = new Date();
  const monday = startOfWeek(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
  return { from: localDateKey(monday), to: localDateKey(now) };
}

/** "today" / "this week" / "1 – 27 Aug" — what the selected window is actually called, so a card can
 *  say what it is showing instead of a hardcoded period it may not be showing at all. */
function describeRange(range: DateRangeValue): string {
  const from = isoToLocalDate(range.from);
  const to = isoToLocalDate(range.to);
  if (!from || !to) return "the selected period";

  if (range.from === range.to) {
    return range.from === localDateKey(new Date())
      ? "today"
      : from.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }

  const week = thisWeekRange();
  if (range.from === week.from && range.to === week.to) return "this week";

  const sameMonth = from.getMonth() === to.getMonth() && from.getFullYear() === to.getFullYear();
  const fmt = (d: Date, withMonth: boolean) =>
    d.toLocaleDateString(undefined, withMonth ? { day: "numeric", month: "short" } : { day: "numeric" });
  return `${fmt(from, !sameMonth)} – ${fmt(to, true)}`;
}

/**
 * The same label with a preposition when it needs one.
 *
 * "logged something this week" reads; "logged something 1 – 27 Aug" does not. Relative labels
 * ("today", "this week") are already adverbial and take nothing; an explicit date range needs "in".
 * Kept separate from `describeRange` because roughly half the call sites want the bare noun for a
 * heading and the other half want the phrase mid-sentence.
 */
function periodPhrase(label: string): string {
  if (/^(today|this )/.test(label)) return label;
  const span = label.split(" – ");
  return span.length === 2 ? `between ${span[0]} and ${span[1]}` : `on ${label}`;
}

export function Dashboard() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.permissions.includes("reports:view");

  /**
   * ONE range drives the whole page. Every card used to hardcode its own window — this week, this
   * month, today — so the page could not answer "what did last month look like" at all.
   *
   * It is a QUERY PARAMETER, not a client-side filter, and that distinction is the important one:
   * `GET /timesheets` is capped at the newest rows, so filtering a range in the browser silently
   * under-reports any period that falls outside them. It looks correct in development, where nobody
   * has that many entries, and is wrong in production.
   */
  const [range, setRange] = useState<DateRangeValue>(thisWeekRange);
  const periodLabel = describeRange(range);
  const rangeParams = { from: range.from, to: range.to };
  /** What the stat deltas are measured against. "vs yesterday" is only true for a single day; over
   *  any span the server compares the equal-length window before it, and the label has to say so. */
  const comparisonLabel = range.from === range.to ? "vs the day before" : "vs the previous period";
  const periodIn = periodPhrase(periodLabel);

  const admin = useQuery({
    queryKey: ["admin-summary", range.from, range.to],
    queryFn: () => reportApi.admin(rangeParams),
    enabled: isAdmin,
    refetchInterval: 30_000
  });
  const security = useQuery({
    queryKey: ["reports", "security-insights"],
    queryFn: reportApi.securityInsights,
    enabled: isAdmin,
    refetchInterval: 60_000
  });
  // The range is in the KEY as well as the request: without it React Query serves the previous
  // window's rows from cache and the page shows one period's numbers under another's label.
  const timesheets = useQuery({ queryKey: ["timesheets", range.from, range.to], queryFn: () => timesheetApi.list(rangeParams) });
  // Counted server-side and UNCAPPED. The list above is capped, which silently dropped projects
  // from the rollup on any busy account — see dashboardApi.myMonth.
  const myMonth = useQuery({ queryKey: ["dashboard", "my-month", range.from, range.to], queryFn: () => dashboardApi.myMonth(rangeParams) });
  const daily = useQuery({ queryKey: ["daily-status", range.from, range.to], queryFn: () => reportApi.dailyStatus(rangeParams) });
  /**
   * The unbounded newest-entries page, used ONLY to annotate the two calendars.
   *
   * Without it the dots would only mark days inside the current range — so opening the picker to
   * choose a different period could not tell you which days outside it have anything on them,
   * which is precisely when you need that. This is the same request the page made before it had a
   * filter, so it restores that reach rather than adding a new cost, and React Query shares the
   * one cache entry with History and Timesheet.
   */
  const recent = useQuery({ queryKey: ["timesheets"], queryFn: () => timesheetApi.list() });
  const myTickets = useQuery({
    queryKey: ["tickets", "for-dashboard", user?.id],
    queryFn: () => ticketApi.list({ assigneeId: user!.id, status: "OPEN,IN_PROGRESS,IN_REVIEW,REOPENED" }),
    enabled: Boolean(user?.id && user.permissions.includes("tickets:view"))
  });
  /**
   * Only for the calendar's hover counts, which is why it asks for `mine` rather than the whole
   * workspace.
   *
   * There is no `changes:view` permission to gate on — change management is a workspace FEATURE
   * that may be off entirely, and the read is authorised by the route itself. So this asks once,
   * does not retry, and a workspace without it simply contributes no change rows to the hover card
   * instead of erroring. A calendar tooltip is not worth a failed request the user can see.
   */
  const changes = useQuery({
    queryKey: ["changes", "for-dashboard", user?.id],
    queryFn: () => changeApi.list({ mine: true }),
    enabled: Boolean(user?.id),
    retry: false
  });

  const all: TimesheetRowLite[] = Array.isArray(timesheets.data) ? timesheets.data : [];
  /** The ranged rows plus the unbounded page, de-duplicated by id. Only the day GROUPING reads
   *  this — every total below still counts rows inside the range, so a wider source cannot inflate
   *  a figure; it only lets the calendars mark days the range does not cover. */
  const allForCalendar: TimesheetRowLite[] = useMemo(() => {
    const byId = new Map<string, TimesheetRowLite>();
    for (const row of all) byId.set(row.id, row);
    for (const row of Array.isArray(recent.data) ? (recent.data as TimesheetRowLite[]) : []) {
      if (!byId.has(row.id)) byId.set(row.id, row);
    }
    return [...byId.values()];
  }, [all, recent.data]);

  /**
   * One pass over the fetched entries feeds every personal surface below.
   *
   * It takes the SELECTED RANGE rather than computing this-week/this-month from the clock, which is
   * what made the whole page filterable from one control. The previous-period comparison is the
   * equal-length window immediately before the range — the only thing a delta can honestly mean for
   * an arbitrary span. That window is not in `all` (the request only asked for the range), so it is
   * computed from whatever of it happens to be loaded and reported as null when none of it is.
   */
  const derived = useMemo(() => {
    const rangeStart = isoToLocalDate(range.from) ?? new Date();
    const rangeEnd = isoToLocalDate(range.to) ?? rangeStart;
    const dayCount = Math.max(1, Math.round((rangeEnd.getTime() - rangeStart.getTime()) / 86_400_000) + 1);
    const prevStart = new Date(rangeStart.getTime() - dayCount * 86_400_000);
    const todayKey = localDateKey(new Date());

    // The rhythm chart's x-axis. Up to a fortnight it is one bucket per day; beyond that the labels
    // collide, so days collapse into buckets — a 90-day range drawn as 90 unreadable ticks is worse
    // than the same shape drawn as twelve.
    const bucketDays = dayCount <= 14 ? 1 : Math.ceil(dayCount / 12);
    const bucketCount = Math.ceil(dayCount / bucketDays);
    const bucketLabel = (index: number) => {
      const day = new Date(rangeStart.getTime() + index * bucketDays * 86_400_000);
      if (dayCount <= 7) return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][(day.getDay() + 6) % 7];
      return day.toLocaleDateString(undefined, { day: "numeric", month: dayCount > 31 ? "short" : undefined });
    };
    const buckets: Array<{ day: string; hours: number }> = Array.from({ length: bucketCount }, (_, i) => ({
      day: bucketLabel(i),
      hours: 0
    }));

    let rangeH = 0;
    let prevH = 0;
    let prevSeen = 0;
    let pendingCount = 0;
    const byStatus = { APPROVED: 0, SUBMITTED: 0, REJECTED: 0, DRAFT: 0 } as Record<string, number>;
    /** Hours per project in the range. Keyed by the DISPLAY LABEL rather than the id, so entries
     *  whose project was removed collapse into one honest "No project" row instead of one row per
     *  orphaned id. */
    const byProjectLabel = new Map<string, number>();
    /** Every loaded entry grouped by calendar day — the timeline's date picker reads this. */
    const entriesByDate = new Map<string, TimesheetRowLite[]>();
    /** Distinct days that carry at least one entry — the denominator for "average per day logged". */
    const daysWithEntries = new Set<string>();

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

    for (const row of allForCalendar) {
      const hours = Number(row.totalHours ?? 0);
      const { key: dateKey, local: workDay } = workDateParts(String(row.workDate));
      if (Number.isNaN(workDay.getTime())) continue;

      const dayList = entriesByDate.get(dateKey) ?? [];
      dayList.push(row);
      entriesByDate.set(dateKey, dayList);

      if (workDay >= rangeStart && workDay <= rangeEnd) {
        // INSIDE the range guard, deliberately. The loop now walks a wider set than the range (see
        // `allForCalendar`), and a card headed "this week" reporting entries awaiting review from
        // three months ago would be counting something it does not claim to be showing.
        if (row.status === "SUBMITTED") pendingCount += 1;
        rangeH += hours;
        daysWithEntries.add(dateKey);
        byStatus[row.status] = (byStatus[row.status] ?? 0) + hours;

        const bucket = buckets[Math.min(bucketCount - 1, Math.floor((workDay.getTime() - rangeStart.getTime()) / 86_400_000 / bucketDays))];
        if (bucket) bucket.hours += hours;

        const projectLabel = row.project?.code ?? row.project?.name ?? "No project";
        byProjectLabel.set(projectLabel, (byProjectLabel.get(projectLabel) ?? 0) + hours);

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
      if (workDay >= prevStart && workDay < rangeStart) {
        prevH += hours;
        prevSeen += 1;
      }
    }

    for (const list of entriesByDate.values()) list.sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));

    return {
      todayKey,
      dayCount,
      /** Weekdays in the range — what a 40h-per-week target scales against. A target pinned to 40
       *  would call a single day a 5% week and a month a 400% one. */
      workingDays: countWorkingDays(rangeStart, rangeEnd),
      daysLogged: daysWithEntries.size,
      rangeHours: rangeH,
      /** Null, not zero, when none of the previous period was fetched: "no comparison available"
       *  and "they logged nothing" are different statements and must not look alike. */
      prevRangeHours: prevSeen > 0 ? prevH : null,
      pendingCount,
      byStatus,
      // Biggest first, so the card can take the top few and total the rest.
      rangeProjects: [...byProjectLabel.entries()]
        .map(([label, hours]) => ({ label, hours }))
        .sort((a, b) => b.hours - a.hours),
      entriesByDate,
      projectRows: [...projects.values()].sort((a, b) => b.monthHours - a.monthHours),
      trend: buckets.map((b) => ({ day: b.day, hours: Number(b.hours.toFixed(2)) }))
    };
  }, [allForCalendar, range.from, range.to]);

  /**
   * Hover counts for the header calendar: a dot on every day that has something on it, and a card
   * grouping the THREE kinds of thing a day can carry — timesheet entries, tickets raised, and
   * change requests raised. They were previously one undifferentiated list of numbers, so "3, 2, 1"
   * read as one total split three ways rather than three separate tallies.
   *
   * The timesheet rows keep their existing per-status breakdown exactly as it was; the separators
   * only add grouping to what is already there.
   */
  const dayAnnotations = useMemo<CalendarDayAnnotations>(() => {
    const map: CalendarDayAnnotations = {};
    const dayOf = (value: unknown) => (typeof value === "string" ? value.slice(0, 10) : null);

    const ticketsByDay = new Map<string, number>();
    for (const ticket of myTickets.data ?? []) {
      const key = dayOf((ticket as { createdAt?: string }).createdAt);
      if (key) ticketsByDay.set(key, (ticketsByDay.get(key) ?? 0) + 1);
    }
    const changesByDay = new Map<string, number>();
    for (const change of changes.data ?? []) {
      const key = dayOf((change as { createdAt?: string }).createdAt);
      if (key) changesByDay.set(key, (changesByDay.get(key) ?? 0) + 1);
    }

    for (const key of new Set([...derived.entriesByDate.keys(), ...ticketsByDay.keys(), ...changesByDay.keys()])) {
      const list = derived.entriesByDate.get(key) ?? [];
      const tickets = ticketsByDay.get(key) ?? 0;
      const changeCount = changesByDay.get(key) ?? 0;
      if (list.length === 0 && tickets === 0 && changeCount === 0) continue;

      const byStatus: Record<string, number> = {};
      for (const entry of list) byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1;

      const logRows = [
        { label: "Log entries", count: list.length, dotClassName: "bg-primary" },
        { label: "Approved", count: byStatus.APPROVED ?? 0, dotClassName: "bg-success" },
        { label: "Submitted", count: byStatus.SUBMITTED ?? 0, dotClassName: "bg-warning" },
        { label: "Draft", count: byStatus.DRAFT ?? 0, dotClassName: "bg-muted-foreground" },
        { label: "Rejected", count: byStatus.REJECTED ?? 0, dotClassName: "bg-destructive" }
      ].filter((row) => row.count > 0);

      const otherRows = [
        { label: "Ticket entries", count: tickets, dotClassName: "bg-info" },
        { label: "Change entries", count: changeCount, dotClassName: "bg-[hsl(262_83%_58%)]" }
      ].filter((row) => row.count > 0);

      map[key] = {
        title: `${list.length + tickets + changeCount} on this day`,
        rows: [
          ...logRows,
          // The rule goes above the FIRST non-timesheet row, so the groups read apart whether or
          // not the day happens to have both tickets and changes.
          ...otherRows.map((row, index) => (index === 0 && logRows.length > 0 ? { ...row, separatorBefore: true } : row))
        ]
      };
    }
    return map;
  }, [derived.entriesByDate, myTickets.data, changes.data]);

  const projectTrend = useMemo(() => {
    const rows = admin.data?.byProject ?? [];
    // The axis shows the project CODE (the identifier people already read in ticket keys) —
    // two full names used to eat the whole axis while every bar between them went unlabeled.
    // The full name stays one hover away in the tooltip.
    return rows.map((row: any) => ({
      name: row.project,
      code: row.projectCode || String(row.project ?? "").slice(0, 10),
      value: Number(row._sum?.totalHours ?? 0)
    }));
  }, [admin.data]);

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
        <div className="flex flex-wrap items-center gap-2">
          {/* Governs EVERY card below, which is why it sits in the page header rather than on one
              of them. The same calendar the day timeline uses, so between-dates selection behaves
              identically in both places. */}
          <DateRangePicker
            value={range}
            onChange={setRange}
            allowAllTime={false}
            className="w-full sm:w-[15rem]"
            dayAnnotations={dayAnnotations}
          />
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
      <GoalsGlanceCard />

      {/* Personal daily status hero */}
      <DailyStatusBanner status={daily.data} loading={daily.isLoading} />

      {/* Open tickets assigned to me — any role */}
      <MyTicketsBanner tickets={myTickets.data} loading={myTickets.isLoading} />

      {/* ---- Hero band: week at a glance / activity / progress ---- */}
      <div data-tour="dashboard-overview" className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <HeroCard delay={0}>
          <WeekAtAGlance
            loading={timesheets.isLoading}
            hours={derived.rangeHours}
            byStatus={derived.byStatus}
            projects={derived.rangeProjects}
            pendingCount={derived.pendingCount}
            daysLogged={derived.daysLogged}
            trend={derived.trend}
            periodLabel={periodLabel}
            periodIn={periodIn}
          />
        </HeroCard>
        <HeroCard delay={0.05}>
          <ActivityCard
            loading={timesheets.isLoading}
            trend={derived.trend}
            hours={derived.rangeHours}
            prevHours={derived.prevRangeHours}
            periodLabel={periodLabel}
          />
        </HeroCard>
        <HeroCard delay={0.1} className="md:col-span-2 xl:col-span-1">
          <ProgressCard
            loading={timesheets.isLoading}
            hours={derived.rangeHours}
            byStatus={derived.byStatus}
            workingDays={derived.workingDays}
            periodLabel={periodIn}
            completion={myMonth.data?.completion}
            totals={myMonth.data?.totals}
          />
        </HeroCard>
      </div>

      {/* ---- Day timeline — real entries on a real clock, any loaded date ---- */}
      <DayTimeline entriesByDate={derived.entriesByDate} todayKey={derived.todayKey} focusKey={range.to} loading={timesheets.isLoading} />

      {/* Admin / manager: workforce daily logging snapshot */}
      {isAdmin && <WorkforceSnapshot data={admin.data} loading={admin.isLoading} periodLabel={periodLabel} periodIn={periodIn} comparisonLabel={comparisonLabel} />}

      {isAdmin && (
        <div className="grid grid-cols-2 gap-2.5 sm:gap-3 md:grid-cols-5">
          {adminStats.map((stat, index) => (
            <motion.div
              key={stat.label}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, delay: index * 0.05 }}
            >
              <StatCard label={stat.label} value={String(stat.value)} tone={stat.tone} trend={stat.trend} trendLabel={comparisonLabel} />
            </motion.div>
          ))}
        </div>
      )}

      {/*
        STACKED, NOT SIDE BY SIDE. These were a 1.3fr/0.7fr split, which gave project utilization
        about a third of the page — and a categorical axis in a third of a page is where the label
        collision came from: eight project codes drawn on top of each other. Both charts read
        left-to-right across their full range, so neither gains anything from sharing a row, and
        the narrower one lost the thing that made it readable.
      */}
      <div className="grid gap-5">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <TrendingUp className="h-4 w-4 text-primary" /> Productivity
            </CardTitle>
            <CardDescription>Your logged hours, {periodLabel}.</CardDescription>
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
            <CardDescription>
              {isAdmin
                ? `Hours logged per project across the workspace ${periodLabel}, largest first.`
                : "Sign in as an admin for the full breakdown."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {/* Changes FORM with the viewport rather than shrinking — horizontal bars where names
                fit in a gutter, a donut plus a numbered legend where they don't. See the
                component's header for why an axis was the wrong instrument here. */}
            <ProjectUtilizationChart rows={projectTrend} />
          </CardContent>
        </Card>
      </div>

      {/* ---- Per-project rollup — the Trackline "Project List", from data already loaded ---- */}
      <ProjectRollup rollup={myMonth.data} loading={myMonth.isLoading} periodLabel={periodLabel} />
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

/**
 * One honest sentence about where the week's hours actually sit — computed, never invented, the
 * same rule the rhythm card's insight strip follows. Extracted from the component so the branching
 * lives in a plain function instead of a nested ternary inside JSX.
 */
function weekNote(hours: number, pendingCount: number, byStatus: Record<string, number>, periodLabel: string): string {
  if (hours === 0) return `No hours logged ${periodLabel} — your entries will show up here as you add them.`;
  if (pendingCount > 0) return `${pendingCount} ${pendingCount === 1 ? "entry is" : "entries are"} waiting on a reviewer.`;
  if ((byStatus.DRAFT ?? 0) === hours) return "Everything so far is still a draft — submit it to start the review clock.";
  const approvedShare = Math.round(((byStatus.APPROVED ?? 0) / hours) * 100);
  if (approvedShare >= 100) return `Every hour ${periodLabel} is approved. Nothing outstanding.`;
  return `${approvedShare}% of these hours are approved.`;
}

/** Trackline's "Overall Tasks" card, for hours: headline number + a segmented STATUS bar.
 *  Every segment also gets a labeled value row below — state is never color-alone (the
 *  green↔amber pair sits in the CVD warn band, which is only acceptable with exactly this
 *  kind of secondary encoding). */
function WeekAtAGlance({
  loading,
  hours,
  byStatus,
  pendingCount,
  daysLogged,
  trend,
  projects,
  periodLabel,
  periodIn
}: {
  loading: boolean;
  hours: number;
  projects: Array<{ label: string; hours: number }>;
  byStatus: Record<string, number>;
  pendingCount: number;
  /** Distinct days in the range that carry an entry — the denominator for the daily average.
   *  Counted over the whole range rather than off `trend`, whose buckets group days once the range
   *  is longer than a fortnight and would otherwise flatter the average. */
  daysLogged: number;
  /** The same series the rhythm chart uses — read here for the insight rows so this card fills its
   *  height with computed facts rather than empty space. Never a second query. */
  trend: Array<{ day: string; hours: number }>;
  periodLabel: string;
  periodIn: string;
}) {
  if (loading) return <Skeleton className="h-full min-h-56 w-full" />;
  const total = hours || 1;
  const segments = WEEK_SEGMENTS.map((s) => ({ ...s, hours: byStatus[s.key] ?? 0 })).filter((s) => s.hours > 0);

  // ── Insights, all derived from data already on this card — nothing invented, nothing fetched.
  // This block exists because the card is the shortest of the three in its row and stretched to a
  // tall empty gap; filling it with real facts is better than padding it with whitespace.
  const busiest = trend.reduce((best, d) => (d.hours > best.hours ? d : best), { day: "—", hours: 0 });
  const dailyAvg = daysLogged > 0 ? hours / daysLogged : 0;
  const note = weekNote(hours, pendingCount, byStatus, periodIn);

  // Three rows keeps the card the same height as its neighbours without scrolling; anything
  // beyond that is summed into one honest "+Nh across M more" line rather than truncated silently.
  const topProjects = projects.slice(0, 3);
  const restProjects = projects.slice(3).reduce((sum, p) => sum + p.hours, 0);
  // Bars are scaled against the BIGGEST project, not against the week total: with one project at
  // 0.5h of a 40h week every bar would round to an invisible sliver and the comparison — which is
  // the only thing a bar is for — would be lost.
  const topShare = topProjects[0]?.hours || 1;

  return (
    <Card className="h-full">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Clock className="h-4 w-4 text-primary" />
          <span className="first-letter:uppercase">{periodLabel}</span>
        </CardTitle>
        <CardDescription>Your logged hours by state, {periodLabel}.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-baseline justify-between">
          <p className="text-3xl font-black tabular-nums tracking-tight">{hours.toFixed(1)}h</p>
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

        {/* Insight band — fills the height the card was padding with blank space, and gives the
            headline number some context (a busiest day and a daily average) it lacked. */}
        <div className="mt-1 grid grid-cols-3 gap-2 border-t border-border pt-4">
          <div>
            <p className="text-lg font-bold tabular-nums leading-none">{daysLogged}<span className="text-sm font-medium text-muted-foreground">/5</span></p>
            <p className="mt-1 text-xs text-muted-foreground">weekdays logged</p>
          </div>
          <div>
            <p className="text-lg font-bold tabular-nums leading-none">{dailyAvg.toFixed(1)}h</p>
            <p className="mt-1 text-xs text-muted-foreground">avg / logged day</p>
          </div>
          <div>
            <p className="text-lg font-bold tabular-nums leading-none">{busiest.hours > 0 ? busiest.day : "—"}</p>
            <p className="mt-1 text-xs text-muted-foreground">busiest{busiest.hours > 0 ? ` · ${busiest.hours.toFixed(1)}h` : ""}</p>
          </div>
        </div>

        {/* WHERE the hours went, which is the question the status split and the rhythm chart next
            to it both leave unanswered — one says what STATE the time is in, the other says WHICH
            DAY it landed on, and neither says what it was spent on. It is also the fact the weekly
            digest email leads with, so the two now agree.

            Deliberately not another chart: the card beside this one is already a chart, and a third
            visual in the same row reads as decoration. Bars-in-a-row is enough to compare four
            numbers, and the labels stay readable at a phone width. */}
        {projects.length > 0 && (
          <div className="grid gap-2 border-t border-border pt-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Where your hours went</p>
            {topProjects.map((p) => (
              <div key={p.label} className="grid gap-1">
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="min-w-0 truncate" title={p.label}>{p.label}</span>
                  <span className="shrink-0 font-semibold tabular-nums">{p.hours.toFixed(1)}h</span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(2, (p.hours / topShare) * 100)}%` }} />
                </div>
              </div>
            ))}
            {restProjects > 0 && (
              <p className="text-xs text-muted-foreground">
                +{restProjects.toFixed(1)}h across {projects.length - topProjects.length} more
              </p>
            )}
          </div>
        )}

        <p className="text-sm text-muted-foreground">{note}</p>

        <Link to="/app/history" className="mt-auto inline-flex items-center gap-1 pt-1 text-sm font-semibold text-primary hover:underline">
          View history <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </CardContent>
    </Card>
  );
}

/** Trackline's "Project Track": a compact single-series chart plus a period-over-period insight
 *  strip. Single series → the title names it, no legend. */
function ActivityCard({
  loading,
  trend,
  hours,
  prevHours,
  periodLabel
}: {
  loading: boolean;
  trend: Array<{ day: string; hours: number }>;
  hours: number;
  /** Null when none of the previous period was loaded. Distinct from 0 on purpose: "nothing to
   *  compare against" and "they logged nothing" must not render as the same claim. */
  prevHours: number | null;
  periodLabel: string;
}) {
  if (loading) return <Skeleton className="h-full min-h-56 w-full" />;
  const comparable = prevHours != null;
  const previous = prevHours ?? 0;
  const delta = comparable ? computeTrend(hours, previous, true) : null;
  const up = hours >= previous;

  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <TrendingUp className="h-4 w-4 text-primary" />
              Daily rhythm
            </CardTitle>
            <CardDescription>Hours logged per day, {periodLabel}.</CardDescription>
          </div>
          {delta && <TrendBadge trend={delta} label="vs the previous period" />}
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
        {comparable && (hours > 0 || previous > 0) && (
          <div
            className={`flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm ${
              up ? "bg-success/10 text-success" : "bg-warning/10 text-warning"
            }`}
          >
            <span>
              {up
                ? previous === 0
                  ? "First hours of a fresh period — nice start!"
                  : `Up ${(hours - previous).toFixed(1)}h on the previous period — great momentum!`
                : `${(previous - hours).toFixed(1)}h behind the previous period's pace so far.`}
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
  hours,
  byStatus,
  workingDays,
  periodLabel,
  completion,
  totals
}: {
  loading: boolean;
  hours: number;
  byStatus: Record<string, number>;
  /** Mon–Fri days in the selected range. The target scales against this rather than a fixed 40h —
   *  a one-day range read as a 5% week and a month as 400%, so the bar stopped meaning anything the
   *  moment the page could show something other than a week. */
  workingDays: number;
  periodLabel: string;
  /** The three completion shares, counted server-side. Undefined while the rollup is in flight. */
  completion?: MyMonthRollup["completion"];
  totals?: MyMonthRollup["totals"];
}) {
  if (loading) return <Skeleton className="h-full min-h-56 w-full" />;
  const target = Math.max(8, workingDays * 8);
  const targetPct = Math.min(100, Math.round((hours / target) * 100));
  const approvedHours = byStatus.APPROVED ?? 0;

  return (
    <Card className="h-full">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Gauge className="h-4 w-4 text-primary" />
          Progress
        </CardTitle>
        <CardDescription>Hours target, then how much of each kind of work is finished.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        <TickMeter
          label={`Target (${target}h · ${workingDays} working ${workingDays === 1 ? "day" : "days"})`}
          percent={targetPct}
          detail={`${hours.toFixed(1)}h logged ${periodLabel}`}
          tone="primary"
        />

        {/* THREE BARS, ONE DEFINITION. Each is "done ÷ total" for its own kind of work, so they can
            be read against each other — hours approved, tickets closed, changes closed. A single
            combined number would hide which of the three is actually stuck. */}
        <TickMeter
          label="Timesheets approved"
          percent={completion?.timesheetPct ?? null}
          detail={`${approvedHours.toFixed(1)}h of ${hours.toFixed(1)}h ${periodLabel}`}
          tone="success"
        />
        <TickMeter
          label="Tickets closed"
          percent={completion?.ticketPct ?? null}
          detail={
            totals ? `${totals.tickets.closed} of ${totals.tickets.total} on your projects` : "Counting…"
          }
          tone="info"
        />
        {/* Absent, not zeroed, when change management is off — a bar reading 0% would claim a
            measurement of something the workspace does not do. */}
        {totals?.changes && (
          <TickMeter
            label="Changes closed"
            percent={completion?.changePct ?? null}
            detail={`${totals.changes.closed} of ${totals.changes.raised} raised on your projects`}
            tone="warning"
          />
        )}

        <p className="text-xs text-muted-foreground">
          Each bar is finished work over total work of that kind. A dash means there is nothing of that kind yet —
          which is not the same as none of it being done.
        </p>
      </CardContent>
    </Card>
  );
}

/** The Trackline dotted meter: ~36 thin ticks, filled left-to-right. Sequential (one hue) —
 *  magnitude, not identity — with the number said in text right beside it. */
function TickMeter({
  label,
  percent,
  detail,
  tone
}: {
  label: string;
  /** Null when there is nothing to divide by. Rendered as a dash, never as 0% — "no tickets yet"
   *  and "no tickets done" are different claims and only one of them is a measurement. */
  percent: number | null;
  detail: string;
  tone: "primary" | "success" | "info" | "warning";
}) {
  const TICKS = 36;
  const filled = percent === null ? 0 : Math.round((percent / 100) * TICKS);
  const fill = { primary: "bg-primary", success: "bg-success", info: "bg-info", warning: "bg-warning" }[tone];

  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-lg font-black tabular-nums">{percent === null ? <span className="text-muted-foreground">—</span> : `${percent}%`}</p>
      </div>
      <div className="flex items-end gap-[3px]" role="img" aria-label={`${label}: ${percent === null ? "not measurable yet" : `${percent}%`}`}>
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
/**
 * Identity hues for the per-user lanes — the validated categorical palette, in its fixed order.
 * The LANE LABEL is the identity channel (every lane is named); the hue is reinforcement, which
 * is why repeating past eight users is acceptable here where it never would be in a legend-keyed
 * chart: two same-hued lanes are still two labeled rows, not one ambiguous series.
 */
const LANE_HUES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];

/** Status is no longer the block's color (the USER is), so it becomes an icon + tooltip — a
 *  channel colorblind-safe by construction. */
const STATUS_GLYPH: Record<string, { Icon: typeof Check; label: string }> = {
  APPROVED: { Icon: Check, label: "Approved" },
  SUBMITTED: { Icon: Clock3, label: "Pending review" },
  REJECTED: { Icon: X, label: "Rejected" },
  DRAFT: { Icon: PencilLine, label: "Draft" }
};

interface DayLane {
  key: string;
  name: string;
  hours: number;
  entries: TimesheetRowLite[];
}

/** One user's clock row. Shared verbatim by the card and the expanded dialog so the two views
 *  can never disagree about what a block means. */
function TimelineLane({
  lane,
  hue,
  windowStart,
  span,
  hourTicks,
  showNow,
  nowMinutes,
  dense,
  onOpenEntry
}: {
  lane: DayLane;
  hue: string;
  windowStart: number;
  span: number;
  hourTicks: number[];
  showNow: boolean;
  nowMinutes: number;
  dense: boolean;
  /** Opens THAT entry. Every block used to be a `<Link to="/app/history">` — you clicked a
   *  specific 3.5h block on a specific person's lane and landed on a list of everything, having
   *  thrown away the one thing your click had said. */
  onOpenEntry: (entry: TimesheetRowLite) => void;
}) {
  const pct = (minutes: number) => ((minutes - windowStart) / span) * 100;
  return (
    <div className="grid grid-cols-[minmax(6rem,8.5rem)_minmax(0,1fr)] items-center gap-2">
      <div className="min-w-0">
        <p className="truncate text-xs font-semibold" title={lane.name}>
          <span className="mr-1.5 inline-block h-2 w-2 rounded-full align-baseline" style={{ background: hue }} aria-hidden />
          {lane.name}
        </p>
        <p className="text-[11px] tabular-nums text-muted-foreground">{lane.hours.toFixed(2)}h</p>
      </div>
      <div className={`relative rounded-lg border border-border bg-muted/20 ${dense ? "h-10" : "h-12"}`}>
        {hourTicks.map((m) => (
          <span key={m} className="absolute inset-y-0 border-l border-dashed border-border/60" style={{ left: `${pct(m)}%` }} aria-hidden />
        ))}
        {showNow && nowMinutes >= windowStart && nowMinutes <= windowStart + span && (
          <span className="absolute inset-y-0 z-10 w-0.5 bg-primary" style={{ left: `${pct(nowMinutes)}%` }} aria-hidden />
        )}
        {lane.entries.map((entry) => {
          const start = toMinutes(entry.startTime);
          const end = toMinutes(entry.endTime);
          const width = Math.max(pct(end) - pct(start), 1.5);
          const glyph = STATUS_GLYPH[entry.status] ?? STATUS_GLYPH.DRAFT;
          const label = `${entry.project?.name ?? entry.activityType ?? "Entry"} · ${Number(entry.totalHours).toFixed(2)}h`;
          return (
            <button
              key={entry.id}
              type="button"
              data-testid="timeline-entry"
              onClick={() => onOpenEntry(entry)}
              className="focus-ring absolute bottom-1 top-1 flex items-center gap-1 overflow-hidden rounded-md border px-1.5 text-left text-[11px] font-medium text-foreground ring-1 ring-background transition-transform hover:z-10 hover:scale-[1.03]"
              style={{ left: `${pct(start)}%`, width: `${width}%`, background: `${hue}26`, borderColor: `${hue}8c` }}
              title={`${lane.name} · ${entry.startTime}–${entry.endTime} · ${label} · ${glyph.label} — open this entry`}
            >
              <glyph.Icon className="h-3 w-3 shrink-0 opacity-70" aria-label={glyph.label} />
              <span className="truncate">{label}</span>
            </button>
          );
        })}
        {lane.entries.length === 0 && <span className="absolute inset-0" aria-hidden />}
      </div>
    </div>
  );
}

function DayTimeline({
  entriesByDate,
  todayKey,
  focusKey,
  loading
}: {
  entriesByDate: Map<string, TimesheetRowLite[]>;
  todayKey: string;
  /** The last day of the page's selected range. The timeline follows it: with the page showing
   *  last month, opening on "today" would show an empty track for a day the request never even
   *  asked about, which reads as "you logged nothing" rather than "you are looking elsewhere". */
  focusKey: string;
  loading: boolean;
}) {
  const initialKey = focusKey && focusKey <= todayKey ? focusKey : todayKey;
  const [selectedKey, setSelectedKey] = useState(initialKey);
  // Re-anchor when the page's range moves. Keyed on the value rather than an effect so there is no
  // frame where the track shows one period's day under another period's heading.
  const [lastFocus, setLastFocus] = useState(initialKey);
  if (lastFocus !== initialKey) {
    setLastFocus(initialKey);
    setSelectedKey(initialKey);
  }
  const [expanded, setExpanded] = useState(false);
  const [laneSearch, setLaneSearch] = useState("");
  const [laneSort, setLaneSort] = useState<"name" | "hours">("name");
  /** The block the user clicked. Opened in place rather than navigated to: the timeline IS the
   *  context — which person, which day, which slot — and a page transition throws all three away
   *  just to show one row. The expanded dialog closes first so the entry doesn't open behind it. */
  const [openEntry, setOpenEntry] = useState<TimesheetRowLite | null>(null);
  const showEntry = (entry: TimesheetRowLite) => {
    setExpanded(false);
    setOpenEntry(entry);
  };
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

  // One lane per person. The approver's list endpoint returns everyone they can see, which is
  // what used to pile every user onto one track; an employee's own list has no `user` and
  // collapses to a single "My entries" lane — same code path, no role branch.
  const laneMap = new Map<string, DayLane>();
  for (const entry of entries) {
    const key = entry.user?.id ?? entry.userId ?? "me";
    let lane = laneMap.get(key);
    if (!lane) {
      lane = { key, name: entry.user?.name ?? "My entries", hours: 0, entries: [] };
      laneMap.set(key, lane);
    }
    lane.hours += Number(entry.totalHours ?? 0);
    lane.entries.push(entry);
  }
  const lanes = [...laneMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  // Hue is assigned from the day's name-sorted order and looked up by lane key, so the dialog's
  // filter/sort can never recolor a person mid-session.
  const laneHue = new Map(lanes.map((lane, i) => [lane.key, LANE_HUES[i % LANE_HUES.length]]));

  const search = laneSearch.trim().toLowerCase();
  const dialogLanes = lanes
    .filter((lane) => !search || lane.name.toLowerCase().includes(search))
    .sort((a, b) => (laneSort === "hours" ? b.hours - a.hours : a.name.localeCompare(b.name)));

  const statusesInDay = Object.keys(STATUS_GLYPH).filter((s) => entries.some((e) => e.status === s));

  // Hover counts for the date picker: a dot on every day that has entries, and a status
  // breakdown card on hover — built from the same map the timeline itself renders from, so the
  // calendar can never advertise a day the track would then show empty.
  const dayAnnotations = useMemo(() => {
    const map: CalendarDayAnnotations = {};
    for (const [key, list] of entriesByDate) {
      if (list.length === 0) continue;
      const byStatus: Record<string, number> = {};
      for (const e of list) byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
      map[key] = {
        title: `${list.length} ${list.length === 1 ? "entry" : "entries"}`,
        rows: [
          { label: "Total", count: list.length, dotClassName: "bg-primary" },
          { label: "Approved", count: byStatus.APPROVED ?? 0, dotClassName: "bg-success" },
          { label: "Submitted", count: byStatus.SUBMITTED ?? 0, dotClassName: "bg-warning" },
          { label: "Draft", count: byStatus.DRAFT ?? 0, dotClassName: "bg-muted-foreground" },
          { label: "Rejected", count: byStatus.REJECTED ?? 0, dotClassName: "bg-destructive" }
        ].filter((row) => row.count > 0)
      };
    }
    return map;
  }, [entriesByDate]);

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
          <CardDescription>One lane per person, one color per person — status is the icon on each block. Covers the latest 100 entries.</CardDescription>
        </div>
        {/* lg:justify-end so that when the controls wrap to a second row on middling widths,
            that row hugs the same right edge as the first instead of dangling at the left. */}
        <div className="flex flex-wrap items-center gap-2 lg:justify-end">
          <Badge variant={dayHours > 0 ? "success" : "muted"} className="whitespace-nowrap">
            {dayHours.toFixed(2)}h {isToday ? "today" : `on ${selectedLabel}`}
          </Badge>
          <div className="flex items-center gap-1 rounded-lg border border-border p-0.5">
            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Previous day" onClick={() => shiftDay(-1)}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            {/* Sits between the prev/next chevrons, so it stays borderless and compact — the
                stepper is the primary control and the calendar is the jump-to. */}
            <DatePicker
              id="dashboard-date"
              value={selectedKey}
              maxValue={todayKey}
              dayAnnotations={dayAnnotations}
              onChange={(iso) => {
                if (iso && iso <= todayKey) setSelectedKey(iso);
              }}
              placeholder="Pick a day"
              className="h-7 w-[9.5rem] border-0 bg-transparent px-1 text-sm tabular-nums hover:bg-muted"
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
          {/* Icon-only: the labeled version was wide enough to wrap onto its own lonely row at
              laptop widths, which read as misplacement rather than a control. */}
          <Button
            size="icon"
            variant="outline"
            className="h-8 w-8"
            onClick={() => setExpanded(true)}
            aria-label="Expand the timeline"
            title="Expand the timeline"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <div className="overflow-x-auto">
            <div className="min-w-[560px]">
              {/* Hour axis, gutter-aligned with the lanes below. Edge labels anchor inward
                  (first left-aligned, last right-aligned) instead of centering on the tick —
                  a centered edge label hangs half outside the container, which manifested as
                  a phantom horizontal scrollbar. */}
              <div className="grid grid-cols-[minmax(6rem,8.5rem)_minmax(0,1fr)] gap-2">
                <div aria-hidden />
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
              </div>

              {/* Capped at ~4 lanes tall; beyond that the card scrolls internally rather than
                  growing — this is the "many users" case the expand dialog exists for. */}
              <div className="max-h-[13.5rem] space-y-2 overflow-y-auto pr-1" data-testid="day-timeline-track">
                {lanes.map((lane) => (
                  <TimelineLane
                    key={lane.key}
                    lane={lane}
                    hue={laneHue.get(lane.key)!}
                    windowStart={windowStart}
                    span={span}
                    hourTicks={hourTicks}
                    showNow={isToday}
                    nowMinutes={nowMinutes}
                    dense
                    onOpenEntry={showEntry}
                  />
                ))}

                {entries.length === 0 && (
                  <div className="flex h-16 items-center justify-center gap-2 rounded-lg border border-border bg-muted/20 px-4 text-center text-sm text-muted-foreground">
                    {isToday ? "Nothing logged yet today." : `Nothing logged on ${selectedLabel}.`}
                    {isToday && (
                      <Link to="/app/timesheet" className="font-semibold text-primary hover:underline">
                        Log your first entry →
                      </Link>
                    )}
                  </div>
                )}
              </div>

              {/* Status key — icons carry status now that color carries identity */}
              {statusesInDay.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
                  {statusesInDay.map((s) => {
                    const glyph = STATUS_GLYPH[s];
                    return (
                      <span key={s} className="inline-flex items-center gap-1.5">
                        <glyph.Icon className="h-3 w-3" aria-hidden />
                        {glyph.label}
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </CardContent>

      {/* Full-width day view. Radix supplies every requested close affordance natively:
          the X in DialogContent, Esc, and click-outside all call onOpenChange(false). */}
      <Dialog
        open={expanded}
        onOpenChange={(open) => {
          setExpanded(open);
          if (!open) setLaneSearch("");
        }}
      >
        <DialogContent className="w-[96vw] max-w-[min(96vw,1400px)]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CalendarClock className="h-4 w-4 text-primary" />
              Day timeline — {selectedLabel}
            </DialogTitle>
            <DialogDescription>
              {lanes.length} {lanes.length === 1 ? "person" : "people"} · {dayHours.toFixed(2)}h logged. Click a block to open that entry in full.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={laneSearch}
              onChange={(e) => setLaneSearch(e.target.value)}
              placeholder="Filter people…"
              className="h-8 w-56"
            />
            <Select value={laneSort} onValueChange={(v) => setLaneSort(v as "name" | "hours")}>
              <SelectTrigger className="h-8 w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="name">Name A–Z</SelectItem>
                <SelectItem value="hours">Most hours</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="overflow-x-auto">
            <div className="min-w-[640px]">
              <div className="grid grid-cols-[minmax(6rem,8.5rem)_minmax(0,1fr)] gap-2">
                <div aria-hidden />
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
              </div>
              <div className="max-h-[62vh] space-y-2.5 overflow-y-auto pr-1">
                {dialogLanes.map((lane) => (
                  <TimelineLane
                    key={lane.key}
                    lane={lane}
                    hue={laneHue.get(lane.key)!}
                    windowStart={windowStart}
                    span={span}
                    hourTicks={hourTicks}
                    showNow={isToday}
                    nowMinutes={nowMinutes}
                    dense={false}
                    onOpenEntry={showEntry}
                  />
                ))}
                {dialogLanes.length === 0 && (
                  <div className="flex h-16 items-center justify-center rounded-lg border border-border bg-muted/20 text-sm text-muted-foreground">
                    {lanes.length === 0 ? `Nothing logged on ${selectedLabel}.` : "No one matches that filter."}
                  </div>
                )}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* The clicked block, in full — task, notes, attachments as downloadable links, and (for a
          manager or super admin, per the server's own rule) an edit form. Rendered here rather
          than behind a navigation so the day, the person and the slot the user clicked are still
          on screen behind it. */}
      <TimesheetEntryDialog
        entryId={openEntry?.id ?? null}
        initialEntry={openEntry}
        onClose={() => setOpenEntry(null)}
      />
    </Card>
  );
}

/* ============================== Project rollup ============================== */

/** Rows per page for the project rollup. Deliberately client-side (unlike the verification log):
 *  this list is bounded by the projects one person logged against in a single month, and the data
 *  is already in memory from the timesheet query — a server round trip per page would be slower
 *  and buy nothing. */
const ROLLUP_PAGE_SIZE = 10;

/**
 * What share of this project's tickets are finished.
 *
 * Null — never 0 — when there is nothing to divide: no tickets at all, or the counts have not arrived
 * yet. "None of your tickets here are done" and "you have no tickets here" are different facts, and a
 * dashboard that renders both as 0% is the kind that gets quoted in a meeting.
 */
function ProjectRollup({ rollup, loading, periodLabel }: { rollup: MyMonthRollup | undefined; loading: boolean; periodLabel: string }) {
  const [page, setPage] = useState(1);
  const rows = rollup?.projects ?? [];
  const showChanges = Boolean(rollup?.totals.changes);
  const pageCount = Math.max(1, Math.ceil(rows.length / ROLLUP_PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageRows = rows.slice((safePage - 1) * ROLLUP_PAGE_SIZE, safePage * ROLLUP_PAGE_SIZE);
  const firstShown = rows.length === 0 ? 0 : (safePage - 1) * ROLLUP_PAGE_SIZE + 1;
  const lastShown = Math.min(safePage * ROLLUP_PAGE_SIZE, rows.length);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <FolderKanban className="h-4 w-4 text-primary" />
          My projects, <span className="lowercase">{periodLabel}</span>
        </CardTitle>
        <CardDescription>
          Every project you are assigned to or have logged against {periodPhrase(periodLabel)} — hours, approval progress, how each
          project&apos;s tickets stand{showChanges ? ", and the changes raised against it" : ""}. Counted server-side over
          the whole period, so a busy one cannot push a project off the list. Ticket
          {showChanges ? " and change" : ""} counts are a snapshot of now, not of the period.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-32 w-full" />
        ) : rows.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No projects assigned, and nothing logged this month.{" "}
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
                    <th className="p-2 text-right font-medium">Open</th>
                    <th className="p-2 text-right font-medium">Closed</th>
                    <th className="p-2 text-right font-medium">Done</th>
                    {showChanges && <th className="p-2 text-right font-medium">Changes</th>}
                    {showChanges && <th className="p-2 text-right font-medium">CM done</th>}
                    <th className="p-2 font-medium">Last entry</th>
                    <th className="w-[20%] p-2 font-medium">Approved</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((row) => {
                    const approvedPct = row.monthHours > 0 ? Math.round((row.approvedHours / row.monthHours) * 100) : null;
                    const ticketTotal = row.tickets.open + row.tickets.closed;
                    const donePct = ticketTotal > 0 ? Math.round((row.tickets.closed / ticketTotal) * 100) : null;
                    const cmDonePct = row.changes && row.changes.raised > 0 ? Math.round((row.changes.closed / row.changes.raised) * 100) : null;
                    return (
                      <tr key={row.id} className="border-t border-border">
                        <td className="p-2">
                          <span className="font-medium">{row.name}</span>
                          {row.code && <span className="ml-2 font-mono text-xs text-muted-foreground">{row.code}</span>}
                          {/* Says why a zero-hour row is here at all — without it an untouched project
                              reads as a bug rather than as something you are responsible for. */}
                          {row.entries === 0 && <Badge variant="muted" className="ml-2">assigned</Badge>}
                        </td>
                        <td className="p-2 text-right font-semibold tabular-nums">{row.monthHours.toFixed(1)}</td>
                        <td className="p-2 text-right tabular-nums text-muted-foreground">{row.entries}</td>
                        <td className="p-2 text-right" data-testid="rollup-open">
                          {row.tickets.open > 0 ? (
                            <HoverTip>
                              <HoverTipTrigger asChild>
                                <Badge variant="info"><TicketIcon className="mr-1 h-3 w-3" />{row.tickets.open}</Badge>
                              </HoverTipTrigger>
                              <HoverTipContent>{row.tickets.mineOpen} of these are assigned to you</HoverTipContent>
                            </HoverTip>
                          ) : (
                            <span className="text-muted-foreground">0</span>
                          )}
                        </td>
                        <td className="p-2 text-right" data-testid="rollup-closed">
                          {row.tickets.closed > 0 ? (
                            <HoverTip>
                              <HoverTipTrigger asChild>
                                <Badge variant="success"><CheckCircle2 className="mr-1 h-3 w-3" />{row.tickets.closed}</Badge>
                              </HoverTipTrigger>
                              <HoverTipContent>{row.tickets.mineClosed} of these are assigned to you</HoverTipContent>
                            </HoverTip>
                          ) : (
                            <span className="text-muted-foreground">0</span>
                          )}
                        </td>
                        {/* An em dash rather than 0% when there is nothing to divide: "none of these
                            tickets are done" and "there are no tickets here" are different facts. */}
                        <td className="p-2 text-right text-xs font-semibold tabular-nums" data-testid="rollup-done">
                          {donePct === null ? <span className="font-normal text-muted-foreground">—</span> : `${donePct}%`}
                        </td>
                        {showChanges && (
                          <td className="p-2 text-right" data-testid="rollup-changes">
                            {row.changes && row.changes.raised > 0 ? (
                              <Badge variant="warning"><GitPullRequestArrow className="mr-1 h-3 w-3" />{row.changes.raised}</Badge>
                            ) : (
                              <span className="text-muted-foreground">0</span>
                            )}
                          </td>
                        )}
                        {showChanges && (
                          <td className="p-2 text-right text-xs font-semibold tabular-nums">
                            {cmDonePct === null ? <span className="font-normal text-muted-foreground">—</span> : `${cmDonePct}%`}
                          </td>
                        )}
                        <td className="p-2 text-muted-foreground">{row.lastDate ?? "—"}</td>
                        <td className="p-2">
                          <div className="flex items-center gap-2">
                            <Progress value={approvedPct ?? 0} className="h-1.5" />
                            <span className="w-9 text-right text-xs font-semibold tabular-nums">
                              {approvedPct === null ? <span className="font-normal text-muted-foreground">—</span> : `${approvedPct}%`}
                            </span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="grid gap-2 sm:hidden">
              {pageRows.map((row) => {
                const approvedPct = row.monthHours > 0 ? Math.round((row.approvedHours / row.monthHours) * 100) : null;
                const ticketTotal = row.tickets.open + row.tickets.closed;
                const donePct = ticketTotal > 0 ? Math.round((row.tickets.closed / ticketTotal) * 100) : null;
                return (
                  <div key={row.id} className="rounded-lg border border-border p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="min-w-0 truncate font-medium">{row.name}</p>
                      <span className="font-semibold tabular-nums">{row.monthHours.toFixed(1)}h</span>
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <Progress value={approvedPct ?? 0} className="h-1.5" />
                      <span className="text-xs font-semibold tabular-nums">{approvedPct === null ? "—" : `${approvedPct}%`}</span>
                    </div>
                    <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                      <span>{row.entries} entries · last {row.lastDate ?? "—"}</span>
                      <span className="flex items-center gap-1.5">
                        {row.tickets.open > 0 && <Badge variant="info">{row.tickets.open} open</Badge>}
                        {row.tickets.closed > 0 && <Badge variant="success">{row.tickets.closed} closed</Badge>}
                        {row.changes && row.changes.raised > 0 && <Badge variant="warning">{row.changes.raised} CM</Badge>}
                        {donePct !== null && <span className="font-semibold tabular-nums">{donePct}% done</span>}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Stated rather than silent — the server caps the list, and a card that quietly drops
                projects is the bug this whole route was written to fix. */}
            {rollup?.truncated && (
              <p className="mt-3 text-xs text-muted-foreground">
                Showing the busiest projects only — this account is on more than the card can list.
              </p>
            )}

            {/* Only surfaces once there's more than one page — a footer under three rows is
                noise. Same visual shape as DataTable's footer for consistency. */}
            {pageCount > 1 && (
              <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs text-muted-foreground">
                  Showing {firstShown}-{lastShown} of {rows.length}
                </p>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" aria-label="Previous page" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={safePage <= 1}>
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </Button>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    Page {safePage} of {pageCount}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label="Next page"
                    onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                    disabled={safePage >= pageCount}
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/* ============================== Banners (unchanged behavior) ============================== */

/** Which of the three things the banner is currently saying — the half of its dismissal
 *  signature that is not the date, so moving between these states brings the banner back. */
function describeDailyState(status?: { hours: number; escalated: boolean }): string {
  if (!status) return "none";
  if (status.escalated) return "escalated";
  return status.hours > 0 ? "logged" : "empty";
}

function DailyStatusBanner({
  status,
  loading
}: {
  status?: { hours: number; entries: number; reminderReceived: boolean; escalated: boolean; date: string };
  loading: boolean;
}) {
  /**
   * The signature is the DAY plus the state being reported, so closing this is consent to hide
   * today's message and nothing more. Miss a different day, or move from "not logged" to
   * "escalated", and the banner returns on its own — which is the whole point, because this is the
   * notice that says an SLA is running.
   *
   * Hooks run before the early returns below, because they must: React requires an unconditional
   * hook order, and `loading` flips on the first render.
   */
  const dailyState = describeDailyState(status);
  const signature = status ? `${status.date}:${dailyState}` : null;
  const { dismissed, dismiss } = useDismissed("dashboard.daily-status", signature);

  if (loading || !status || dismissed) return null;

  const logged = status.hours > 0;

  if (status.escalated) {
    return (
      <Alert variant="destructive" onDismiss={dismiss} dismissLabel="Dismiss this escalation notice for today">
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
      <Alert variant={status.reminderReceived ? "warning" : "info"} onDismiss={dismiss} dismissLabel="Dismiss today's reminder">
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
    <Alert variant="success" onDismiss={dismiss} dismissLabel="Dismiss this confirmation">
      <CheckCircle2 />
      <AlertTitle>Today's timesheet is logged</AlertTitle>
      <AlertDescription>
        {status.hours.toFixed(2)} hours captured across {status.entries} {status.entries === 1 ? "entry" : "entries"}. Nice.
      </AlertDescription>
    </Alert>
  );
}

function MyTicketsBanner({ tickets, loading }: { tickets?: TicketRow[]; loading: boolean }) {
  const overdue = tickets?.filter((t) => t.slaBreachAt).length ?? 0;
  /**
   * Keyed on the COUNTS rather than on the day: a ticket banner that came back every morning would
   * be nagging, but one that stayed hidden after a sixth ticket landed — or after one of them went
   * overdue — would be hiding new information. Counts change, the banner returns.
   */
  const signature = tickets ? `${tickets.length}:${overdue}` : null;
  const { dismissed, dismiss } = useDismissed("dashboard.my-tickets", signature);

  if (loading || !tickets || tickets.length === 0 || dismissed) return null;

  return (
    <Alert variant={overdue > 0 ? "destructive" : "info"} onDismiss={dismiss} dismissLabel="Dismiss this ticket notice">
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

function WorkforceSnapshot({
  data,
  loading,
  periodLabel,
  periodIn,
  comparisonLabel
}: {
  data?: any;
  loading: boolean;
  periodLabel: string;
  periodIn: string;
  comparisonLabel: string;
}) {
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

  const ticketsRaised = Number(data.ticketsRaisedToday ?? 0);
  const ticketsClosed = Number(data.ticketsClosedToday ?? 0);
  // Null passes straight through, so "change management is off" stays distinguishable from "none
  // raised today" — the same rule the rest of this page follows.
  const changesRaised = data.changesRaisedToday ?? null;
  const changesClosed = data.changesClosedToday ?? null;
  // More tickets raised is not good news and not bad news on its own, so it carries no colour;
  // closing more is good, and both change figures follow the same reading.
  const ticketsRaisedTrend = computeTrend(ticketsRaised, Number(data.ticketsRaisedYesterday ?? 0), null);
  const ticketsClosedTrend = computeTrend(ticketsClosed, Number(data.ticketsClosedYesterday ?? 0), true);
  const changesRaisedTrend = computeTrend(Number(changesRaised ?? 0), Number(data.changesRaisedYesterday ?? 0), null);
  const changesClosedTrend = computeTrend(Number(changesClosed ?? 0), Number(data.changesClosedYesterday ?? 0), true);

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0 pb-3">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <Users2 className="h-4 w-4 text-primary" />
            <span className="first-letter:uppercase">{periodLabel}</span> across the workforce
          </CardTitle>
          <CardDescription>
            {logged} of {active} active employees &amp; team leads have logged something {periodIn}.
          </CardDescription>
        </div>
        <Badge variant={percent >= 80 ? "success" : percent >= 50 ? "warning" : "destructive"}>{percent}%</Badge>
      </CardHeader>
      <CardContent className="grid gap-4">
        <Progress value={percent} className={percent < 50 ? "[&>div]:bg-destructive" : percent < 80 ? "[&>div]:bg-warning" : ""} />
        <div className="grid grid-cols-2 gap-2.5 text-sm sm:grid-cols-5">
          <SnapshotStat label="Logged" value={logged} trend={vsYesterday} trendLabel="vs the previous period" />
          <SnapshotStat label="Not yet filled" value={notLogged} trend={notFilledTrend} trendLabel={comparisonLabel} />
          <SnapshotStat label="Reminders sent" value={reminders} trend={remindersTrend} trendLabel={comparisonLabel} />
          <SnapshotStat label="Escalations" value={escalations} trend={escalationsTrend} trendLabel={comparisonLabel} />
          <SnapshotStat label="vs YTD avg/day" value={`${ytdAvgLoggedPerDay.toFixed(1)}`} trend={vsYtdAvg} trendLabel="vs avg" />
        </div>

        {/* The other two kinds of work the workforce did in this period. Same boundary and same
            previous-period comparison as the row above, so the three read as one picture rather
            than three widgets that happen to share a card. */}
        <div className="grid grid-cols-2 gap-2.5 text-sm sm:grid-cols-4">
          <SnapshotStat label="Tickets raised" value={ticketsRaised} trend={ticketsRaisedTrend} trendLabel={comparisonLabel} />
          <SnapshotStat label="Tickets closed" value={ticketsClosed} trend={ticketsClosedTrend} trendLabel={comparisonLabel} />
          {/* Absent, not zeroed, when change management is off. */}
          {changesRaised !== null && (
            <SnapshotStat label="Changes raised" value={changesRaised} trend={changesRaisedTrend} trendLabel={comparisonLabel} />
          )}
          {changesClosed !== null && (
            <SnapshotStat label="Changes closed" value={changesClosed} trend={changesClosedTrend} trendLabel={comparisonLabel} />
          )}
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
