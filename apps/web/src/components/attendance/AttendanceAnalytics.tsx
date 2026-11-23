/**
 * Attendance analytics (V17 A6): the "Analytics" section under My attendance, the Team "Insights"
 * tab and the admin "Organisation" tab.
 *
 * DATA RULES THE UI KEEPS: a rate the server could not compute is "—", never 0%; a group aggregate
 * the server suppressed (fewer than the workspace's minimum group size) is shown as an explicit
 * "hidden to protect individuals" note, not as an empty chart that reads as "nobody". No
 * coordinates, notes or face images exist in these responses — the API never sends them.
 *
 * CHARTS: recharts with the categorical tokens (`var(--chart-1)`), so both themes resolve without
 * JS; every chart has an aria-label and the figures it draws are also printed as text.
 *
 * INSIGHTS: Sparkles marks an AI suggestion, Lightbulb a rule-based one. Rule suggestions are
 * always present; AI ones only when the workspace switched them on for this audience.
 */
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, BarChart3, CalendarDays, Clock, EyeOff, Hourglass, Lightbulb, Plug, ShieldCheck, Sparkles, TrendingUp, Users2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip as ChartTip, XAxis, YAxis } from "recharts";
import {
  countRows,
  driftText,
  minuteText,
  pctText,
  RANGE_OPTIONS,
  rangeFor,
  WEEKDAY_SHORT,
  type RangeDays
} from "../../lib/attendance-analytics";
import { usePrefersReducedMotion } from "../../lib/use-motion";
import { cn } from "../../lib/utils";
import {
  attendanceAnalyticsApi,
  type AnalyticsAudience,
  type AttendanceInsight,
  type GroupSummary,
  type OrgAnalytics,
  type TeamAnalytics
} from "../../services/attendance-api";
import { Badge } from "../ui/badge";
import { Card, CardContent } from "../ui/card";
import { EmptyState } from "../ui/empty-state";
import { Skeleton } from "../ui/skeleton";
import { StatCard } from "../ui/stat-card";

function todayKey(): string {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

const TOOLTIP_STYLE = {
  borderRadius: 8,
  border: "1px solid hsl(var(--border))",
  background: "hsl(var(--popover))",
  color: "hsl(var(--popover-foreground))",
  fontSize: 12
};

const shortDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });

/* --------------------------------- shared pieces --------------------------------- */

export function RangeSelector({ value, onChange }: Readonly<{ value: RangeDays; onChange: (d: RangeDays) => void }>) {
  return (
    <div role="group" aria-label="Date range" className="inline-flex rounded-lg border border-border bg-card p-0.5">
      {RANGE_OPTIONS.map((d) => (
        <button
          key={d}
          type="button"
          aria-pressed={value === d}
          onClick={() => onChange(d)}
          className={cn(
            "focus-ring rounded-md px-3 py-1 text-xs font-medium transition-colors",
            value === d ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
          )}
        >
          {d} days
        </button>
      ))}
    </div>
  );
}

function useRange(initial: RangeDays = 30) {
  const [days, setDays] = useState<RangeDays>(initial);
  return { days, setDays, ...rangeFor(days, todayKey()) };
}

function SectionCard({ title, description, children, className }: Readonly<{ title: string; description?: string; children: ReactNode; className?: string }>) {
  return (
    <Card className={cn("min-w-0", className)}>
      <CardContent className="grid min-w-0 gap-3 p-4">
        <header>
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
        </header>
        {children}
      </CardContent>
    </Card>
  );
}

function suppressedText(people: number | undefined, min: number): string {
  if (people === undefined) return `Hidden to protect individuals: fewer than ${min} people are behind this figure.`;
  const who = people === 1 ? "1 person is" : `${people} people are`;
  return `Hidden to protect individuals: ${who} in this group, and figures are only shown for ${min} or more.`;
}

function SuppressedNote({ people, min }: Readonly<{ people?: number; min: number }>) {
  return (
    <p className="flex items-start gap-2 rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
      <EyeOff className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {suppressedText(people, min)}
    </p>
  );
}

/** A labelled bar list — readable as text, no chart needed for a handful of categories. */
function CountBars({ rows, empty }: Readonly<{ rows: Array<{ key: string; label: string; count: number }>; empty: string }>) {
  if (rows.length === 0) return <p className="text-xs text-muted-foreground">{empty}</p>;
  const max = Math.max(...rows.map((r) => r.count));
  return (
    <ul className="grid gap-2">
      {rows.map((r) => (
        <li key={r.key} className="grid min-w-0 gap-1">
          <div className="flex min-w-0 justify-between gap-2 text-xs">
            <span className="truncate">{r.label}</span>
            <span className="tabular-nums text-muted-foreground">{r.count}</span>
          </div>
          <div className="h-1.5 rounded-full bg-muted" aria-hidden="true">
            <div className="h-1.5 rounded-full" style={{ width: `${(r.count / max) * 100}%`, background: "var(--chart-1)" }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function AnalyticsSkeleton() {
  return (
    <div className="grid gap-3" aria-busy="true" aria-label="Loading analytics">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </div>
      <Skeleton className="h-56 w-full" />
    </div>
  );
}

function LoadError() {
  return <EmptyState compact icon={AlertTriangle} title="Analytics aren't available" description="The module may be off, or this view is not open to your role." />;
}

/* ------------------------------------ insights ------------------------------------ */

export function InsightsList({ audience, from, to }: Readonly<{ audience: AnalyticsAudience; from: string; to: string }>) {
  const q = useQuery({ queryKey: ["attendance", "insights", audience, from, to], queryFn: () => attendanceAnalyticsApi.insights(audience, from, to) });
  return (
    <SectionCard title="Suggestions" description="Built from the figures above. AI suggestions are marked with a sparkle.">
      {q.isLoading && <Skeleton className="h-24 w-full" />}
      {q.isError && <p className="text-xs text-muted-foreground">Suggestions aren't available right now.</p>}
      {q.data && q.data.insights.length === 0 && <p className="text-xs text-muted-foreground">Nothing stands out in this range.</p>}
      {q.data && q.data.insights.length > 0 && (
        <ul className="grid gap-2">
          {q.data.insights.map((i) => (
            <InsightItem key={i.id} insight={i} />
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function insightTone(insight: AttendanceInsight): string {
  if (insight.source === "ai") return "text-primary";
  return insight.severity === "warn" ? "text-warning" : "text-muted-foreground";
}

function InsightItem({ insight }: Readonly<{ insight: AttendanceInsight }>) {
  const Icon = insight.source === "ai" ? Sparkles : Lightbulb;
  return (
    <li className="flex min-w-0 gap-3 rounded-lg border border-border p-3 motion-safe:animate-in motion-safe:fade-in">
      <Icon
        className={cn("mt-0.5 h-4 w-4 shrink-0", insightTone(insight))}
        aria-label={insight.source === "ai" ? "AI suggestion" : "Rule-based suggestion"}
      />
      <div className="min-w-0">
        <p className="text-sm font-medium">{insight.title}</p>
        {insight.detail && <p className="text-xs text-muted-foreground">{insight.detail}</p>}
      </div>
    </li>
  );
}

/* --------------------------------- My attendance --------------------------------- */

export function MyAnalyticsSection() {
  const range = useRange();
  const reduced = usePrefersReducedMotion();
  const q = useQuery({ queryKey: ["attendance", "analytics", "me", range.from, range.to], queryFn: () => attendanceAnalyticsApi.me(range.from, range.to) });

  return (
    <section aria-label="Analytics" className="grid min-w-0 gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-muted-foreground">Analytics</h2>
        <RangeSelector value={range.days} onChange={range.setDays} />
      </div>
      {q.isLoading && <AnalyticsSkeleton />}
      {q.isError && <LoadError />}
      {q.data && (() => {
        const s = q.data.summary;
        const trend = s.punchTrend.map((p) => ({ ...p, label: shortDate(p.date) }));
        return (
          <>
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              <StatCard label="Presence" value={pctText(s.presenceRate)} icon={<CalendarDays className="h-4 w-4" />} hint="Present ÷ (present + absent). Holidays and weekends don't count." />
              {q.data.lateness.enabled ? (
                <StatCard label="On time" value={pctText(s.onTimeRate)} icon={<Clock className="h-4 w-4" />} hint={`Punch-ins by ${minuteText(q.data.lateness.expectedStartMinute)}.`} />
              ) : (
                <StatCard label="Usual punch-in" value={minuteText(s.medianPunchMinute)} icon={<Clock className="h-4 w-4" />} hint="Your median time in this range." />
              )}
              <StatCard label="Trend" value={driftText(s.driftMinutesPerWeek)} icon={<TrendingUp className="h-4 w-4" />} hint="How your punch-in time is moving, from at least five days." />
              <StatCard label="Hours" value={`${s.hours.logged} / ${s.hours.expected}h`} icon={<Hourglass className="h-4 w-4" />} hint="Logged against expected for the working days so far." />
            </div>
            <div className="grid min-w-0 gap-3 lg:grid-cols-[1.6fr_1fr]">
              <SectionCard title="Punch-in time" description="Each working day's punch-in, in your timezone.">
                {trend.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No punch-ins in this range.</p>
                ) : (
                  <div className="h-52 w-full min-w-0" role="img" aria-label={`Punch-in times over ${trend.length} days, median ${minuteText(s.medianPunchMinute)}`}>
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={trend} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
                        <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                        <XAxis dataKey="label" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                        <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false} width={44} domain={["dataMin - 30", "dataMax + 30"]} tickFormatter={(v: number) => minuteText(v)} />
                        <ChartTip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => [minuteText(v), "Punch-in"]} />
                        <Line type="monotone" dataKey="minute" stroke="var(--chart-1)" strokeWidth={2} dot={{ r: 2 }} isAnimationActive={!reduced} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </SectionCard>
              <div className="grid min-w-0 gap-3">
                <SectionCard title="Missed-day reasons">
                  <CountBars rows={countRows(s.missedReasons)} empty="No reasons given in this range." />
                </SectionCard>
                <SectionCard title="Sources">
                  <CountBars rows={countRows(s.sources)} empty="No punch-ins in this range." />
                </SectionCard>
              </div>
            </div>
            <InsightsList audience="me" from={range.from} to={range.to} />
          </>
        );
      })()}
    </section>
  );
}

/* ------------------------------------- group ------------------------------------- */

function HistogramChart({ data, ariaLabel, xKey, valueLabel }: Readonly<{ data: Array<Record<string, string | number>>; ariaLabel: string; xKey: string; valueLabel: string }>) {
  const reduced = usePrefersReducedMotion();
  return (
    <div className="h-52 w-full min-w-0" role="img" aria-label={ariaLabel}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
          <XAxis dataKey={xKey} tick={{ fontSize: 10 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
          <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false} allowDecimals={false} width={34} />
          <ChartTip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => [v, valueLabel]} />
          <Bar dataKey="count" fill="var(--chart-1)" radius={[3, 3, 0, 0]} isAnimationActive={!reduced} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function GroupFigures({ group, min, drifting }: Readonly<{ group: GroupSummary; min: number; drifting?: number }>) {
  if (group.suppressed || !group.aggregates) return <SuppressedNote people={group.people} min={min} />;
  const a = group.aggregates;
  const weekdays = a.absencesByWeekday.map((count, i) => ({ key: String(i), label: WEEKDAY_SHORT[i], count })).filter((r) => r.count > 0);
  return (
    <>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <StatCard label="Presence" value={pctText(a.presenceRate)} icon={<CalendarDays className="h-4 w-4" />} hint={`${group.people} people. Present ÷ (present + absent).`} />
        <StatCard label="Absence" value={pctText(a.absenceRate)} icon={<AlertTriangle className="h-4 w-4" />} hint="Working days nobody punched in on, once the day was over." />
        <StatCard label="No timesheet" value={a.presentNoTimesheet.days} icon={<Hourglass className="h-4 w-4" />} hint={`Present days with no time logged (${pctText(a.presentNoTimesheet.rate)}).`} />
        {drifting !== undefined && <StatCard label="Drifting later" value={drifting} icon={<TrendingUp className="h-4 w-4" />} hint="People whose punch-in moves 10+ minutes later a week." />}
      </div>
      <div className="grid min-w-0 gap-3 lg:grid-cols-[1.6fr_1fr]">
        <SectionCard title="Punch-in times" description="Punch-ins per half hour, in each person's own timezone.">
          {a.punchHistogram.length === 0 ? (
            <p className="text-xs text-muted-foreground">No punch-ins in this range.</p>
          ) : (
            <HistogramChart data={a.punchHistogram} xKey="bucket" valueLabel="Punch-ins" ariaLabel={"Punch-in distribution: " + a.punchHistogram.map((b) => `${b.bucket} ${b.count}`).join(", ")} />
          )}
        </SectionCard>
        <div className="grid min-w-0 gap-3">
          <SectionCard title="Missed-day reasons">
            <CountBars rows={countRows(a.missedReasons)} empty="No reasons given in this range." />
          </SectionCard>
          <SectionCard title="Absences by weekday">
            <CountBars rows={weekdays} empty="No absences in this range." />
          </SectionCard>
        </div>
      </div>
    </>
  );
}

function PeopleTable({ data }: Readonly<{ data: TeamAnalytics }>) {
  if (data.people.length === 0) return null;
  return (
    <SectionCard title="People" description="Each person's own trend. You can already open any of these days in Team Activity.">
      <ul className="grid min-w-0 gap-2">
        {data.people.map((p) => (
          <li key={p.userId} className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-md border border-border px-3 py-2">
            <span className="min-w-0 truncate text-sm font-medium">{p.name}</span>
            <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>Presence {pctText(p.presenceRate)}</span>
              <span>Usual {minuteText(p.medianPunchMinute)}</span>
              {p.drifting ? <Badge variant="warning">{driftText(p.driftMinutesPerWeek)}</Badge> : <span>{driftText(p.driftMinutesPerWeek)}</span>}
            </span>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

export function TeamInsightsView() {
  const range = useRange();
  const q = useQuery({ queryKey: ["attendance", "analytics", "team", range.from, range.to], queryFn: () => attendanceAnalyticsApi.team(range.from, range.to) });
  return (
    <section aria-label="Team insights" className="grid min-w-0 gap-3">
      <div className="flex justify-end">
        <RangeSelector value={range.days} onChange={range.setDays} />
      </div>
      {q.isLoading && <AnalyticsSkeleton />}
      {q.isError && <LoadError />}
      {q.data && q.data.people.length === 0 && <EmptyState compact icon={Users2} title="No one reports to you yet" />}
      {q.data && q.data.people.length > 0 && (
        <>
          <GroupFigures group={q.data.group} min={q.data.minGroupSize} drifting={q.data.people.filter((p) => p.drifting).length} />
          <PeopleTable data={q.data} />
          <InsightsList audience="team" from={range.from} to={range.to} />
        </>
      )}
    </section>
  );
}

/* ---------------------------------- organisation ---------------------------------- */

function HealthBadge({ enabled, silent, days }: Readonly<{ enabled: boolean; silent: boolean; days: number | null }>) {
  if (!enabled) return <Badge variant="muted">Off</Badge>;
  if (silent) return <Badge variant="warning">Silent {days}d</Badge>;
  return <Badge variant="success">Healthy</Badge>;
}

function IntegrationHealth({ data }: Readonly<{ data: OrgAnalytics }>) {
  if (data.integrations.length === 0) return <p className="text-xs text-muted-foreground">No integrations configured.</p>;
  return (
    <ul className="grid min-w-0 gap-2">
      {data.integrations.map((s) => {
        const silent = s.enabled && (s.silentWorkingDays ?? 0) >= 2;
        return (
          <li key={s.id} className="grid min-w-0 gap-1 rounded-md border border-border px-3 py-2">
            <div className="flex min-w-0 items-center justify-between gap-2">
              <span className="truncate text-sm font-medium">{s.name}</span>
              <HealthBadge enabled={s.enabled} silent={silent} days={s.silentWorkingDays} />
            </div>
            <p className="text-xs text-muted-foreground">
              {Object.entries(s.counts).map(([k, n]) => `${n} ${k.toLowerCase()}`).join(" · ") || "No events in range"}
              {s.lastEventAt ? ` · last ${new Date(s.lastEventAt).toLocaleString()}` : " · never sent"}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

function ByManager({ data }: Readonly<{ data: OrgAnalytics }>) {
  return (
    <ul className="grid min-w-0 gap-2">
      {data.byManager.map((t) => (
        <li key={t.managerId ?? "none"} className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-md border border-border px-3 py-2">
          <span className="min-w-0 truncate text-sm font-medium">{t.managerName}</span>
          <span className="text-xs text-muted-foreground">
            {t.people} people ·{" "}
            {t.suppressed || !t.aggregates ? "hidden (small group)" : `presence ${pctText(t.aggregates.presenceRate)} · no timesheet ${t.aggregates.presentNoTimesheet.days}`}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function OrgAnalyticsView() {
  const range = useRange();
  const q = useQuery({ queryKey: ["attendance", "analytics", "org", range.from, range.to], queryFn: () => attendanceAnalyticsApi.org(range.from, range.to) });
  const d = q.data;
  return (
    <section aria-label="Organisation analytics" className="grid min-w-0 gap-3">
      <div className="flex justify-end">
        <RangeSelector value={range.days} onChange={range.setDays} />
      </div>
      {q.isLoading && <AnalyticsSkeleton />}
      {q.isError && <LoadError />}
      {d && (
        <>
          <GroupFigures group={d.overall} min={d.minGroupSize} />
          <div className="grid min-w-0 gap-3 lg:grid-cols-2">
            <SectionCard title="By team" description="Grouped by manager. Small teams are hidden.">
              <ByManager data={d} />
            </SectionCard>
            <SectionCard title="Sign-in times" description="Successful sign-ins per hour, in each person's timezone.">
              {d.loginHistogram.hours ? (
                <HistogramChart
                  data={d.loginHistogram.hours.map((count, h) => ({ hour: minuteText(h * 60), count }))}
                  xKey="hour"
                  valueLabel="Sign-ins"
                  ariaLabel={`Sign-ins by hour, ${d.loginHistogram.hours.reduce((a, b) => a + b, 0)} in total`}
                />
              ) : (
                <SuppressedNote min={d.minGroupSize} />
              )}
            </SectionCard>
            <SectionCard title="Sources" description="Punch-ins by where they came from.">
              <CountBars
                rows={d.bySource.filter((s) => !s.suppressed && s.punches).map((s) => ({ key: s.source, label: s.source.toLowerCase(), count: s.punches ?? 0 }))}
                empty="No source is used by enough people to show."
              />
            </SectionCard>
            <SectionCard title="Face checks at punch-in">
              {d.face.suppressed ? (
                <SuppressedNote min={d.minGroupSize} />
              ) : (
                <div className="grid grid-cols-3 gap-2">
                  <StatCard label="Checks" value={d.face.checks ?? 0} icon={<ShieldCheck className="h-4 w-4" />} />
                  <StatCard label="Passed" value={pctText(d.face.passRate)} />
                  <StatCard label="Flagged" value={pctText(d.face.flagRate)} />
                </div>
              )}
            </SectionCard>
            <SectionCard title="Integration health" description="Events per source in this range, and how long since each last sent.">
              <IntegrationHealth data={d} />
            </SectionCard>
            <SectionCard title="Holidays">
              <div className="grid grid-cols-2 gap-2">
                <StatCard label="Holiday dates" value={d.holidays.dates} icon={<CalendarDays className="h-4 w-4" />} />
                <StatCard label="Person-days off" value={d.holidays.personDays} icon={<BarChart3 className="h-4 w-4" />} />
              </div>
              {d.upcomingHolidays.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  Next 14 days: {d.upcomingHolidays.map((h) => `${h.name} (${shortDate(h.date)})`).join(", ")}
                </p>
              )}
            </SectionCard>
          </div>
          <InsightsList audience="org" from={range.from} to={range.to} />
        </>
      )}
      {!d && !q.isLoading && !q.isError && <EmptyState compact icon={Plug} title="Nothing to show" />}
    </section>
  );
}
