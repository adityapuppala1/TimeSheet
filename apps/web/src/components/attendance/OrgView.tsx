/**
 * Organisation (V17 UI v2, admins): at most four KPI cards with a delta against the previous period
 * and a sparkline, a daily trend, a group-by bar chart, integration health, insight cards and a CSV
 * export of the tables you are looking at.
 *
 * Rules the view keeps: a rate the server could not compute is a dash, never 0%; a group under the
 * workspace's k-anonymity floor reads "Not enough data to show (fewer than N people)", never an empty
 * box; every chart has a "View as table" switch and labels its values directly; one hue plus grey;
 * deltas carry an arrow icon and words; nothing ranks or names individuals.
 */
import { PayrollExportCard } from "./PayrollExport";
import { runInBackground } from "../../lib/run-in-background";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowDownRight, ArrowRight, ArrowUpRight, CalendarDays, CheckCircle2, Download, Minus, PauseCircle, Plug, ShieldCheck, Table2, BarChart3 } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { Bar, BarChart, CartesianGrid, LabelList, Line, LineChart, ResponsiveContainer, Tooltip as ChartTip, XAxis, YAxis } from "recharts";
import { pctText, minuteText } from "../../lib/attendance-analytics";
import { toCsv, downloadText } from "../../lib/csv-export";
import { deltaPoints, orgKpis, previousRange, sparklinePoints, type Delta, type Kpi } from "../../lib/org-kpis";
import { usePrefersReducedMotion } from "../../lib/use-motion";
import { useMediaQuery } from "../../lib/use-media-query";
import { cn } from "../../lib/utils";
import { attendanceAnalyticsApi, type OrgAnalytics, type SourceHealth } from "../../services/attendance-api";
import { relativeTime } from "../../lib/attendance-team";
import { Button } from "../ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { EmptyState } from "../ui/empty-state";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import { InsightsList, OvertimeFigure, RangeSelector, SuppressedNote, useRange, HistogramChart } from "./AttendanceAnalytics";
import { CardError, SectionCard, Segmented } from "./attendance-ui";

const TOOLTIP_STYLE = {
  borderRadius: 8,
  border: "1px solid hsl(var(--border))",
  background: "hsl(var(--popover))",
  color: "hsl(var(--popover-foreground))",
  fontSize: 12
};

const shortDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
const suppressedLine = (min: number) => `Not enough data to show (fewer than ${min} people)`;

/* ------------------------------------ KPIs ------------------------------------ */

function DeltaText({ delta, period }: Readonly<{ delta: Delta | null; period: number }>) {
  if (!delta) return <span className="text-xs text-muted-foreground">No earlier period to compare</span>;
  const Icon = { up: ArrowUpRight, down: ArrowDownRight, flat: Minus }[delta.direction];
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <Icon className="h-3.5 w-3.5 text-foreground" aria-hidden="true" />
      <span className="font-medium text-foreground">{delta.text}</span>
      <span>vs previous {period} days</span>
    </span>
  );
}

function Sparkline({ values, label }: Readonly<{ values: number[] | null; label: string }>) {
  const points = values ? sparklinePoints(values, 96, 28) : "";
  if (!points) return null;
  return (
    <svg viewBox="0 0 96 28" className="h-7 w-24 shrink-0" role="img" aria-label={label}>
      <polyline points={points} fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ stroke: "var(--chart-1)" }} />
    </svg>
  );
}

function KpiCard({ kpi, delta, period }: Readonly<{ kpi: Kpi; delta: Delta | null; period: number }>) {
  return (
    <div className="grid min-w-0 gap-2 rounded-lg border border-border bg-card p-3.5" title={kpi.hint}>
      <p className="truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground">{kpi.label}</p>
      <div className="flex min-w-0 items-end justify-between gap-2">
        <p className="text-2xl font-black tracking-tight tabular-nums">{kpi.value}</p>
        <Sparkline values={kpi.series} label={`${kpi.label} over the range`} />
      </div>
      <DeltaText delta={delta} period={period} />
    </div>
  );
}

/* --------------------------------- chart shells --------------------------------- */

function ChartShell({
  title,
  description,
  table,
  chart,
  action,
  hasData,
  empty
}: Readonly<{ title: string; description?: string; table: React.ReactNode; chart: React.ReactNode; action?: React.ReactNode; hasData: boolean; empty: string }>) {
  const [asTable, setAsTable] = useState(false);
  return (
    <SectionCard
      title={title}
      description={description}
      action={
        <div className="flex flex-wrap items-center gap-2">
          {action}
          {hasData && (
            <Button variant="outline" size="sm" className="min-h-[44px] sm:min-h-8" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>
              {asTable ? <BarChart3 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> : <Table2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />}
              {asTable ? "View as chart" : "View as table"}
            </Button>
          )}
        </div>
      }
    >
      {!hasData && <p className="text-xs text-muted-foreground">{empty}</p>}
      {hasData && (asTable ? table : chart)}
    </SectionCard>
  );
}

function DataTable({ headers, rows }: Readonly<{ headers: string[]; rows: Array<Array<string | number>> }>) {
  return (
    <div className="max-h-72 min-w-0 overflow-auto rounded-md border border-border">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-muted text-left">
          <tr>
            {headers.map((h) => (
              <th key={h} scope="col" className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={String(r[0])} className="border-t border-border">
              {r.map((c, i) => (
                <td key={`${String(r[0])}-${i}`} className={cn("px-3 py-1.5", i > 0 && "tabular-nums")}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------ trend ------------------------------------ */

function TrendChart({ data }: Readonly<{ data: NonNullable<OrgAnalytics["trend"]> }>) {
  const reduced = usePrefersReducedMotion();
  const points = data.filter((d) => d.presenceRate != null).map((d) => ({ label: shortDate(d.date), pct: Math.round((d.presenceRate ?? 0) * 100), date: d.date }));
  return (
    <ChartShell
      title="Attendance trend"
      description="Share of judged people present, per day."
      hasData={points.length > 0}
      empty="No judged days in this range yet."
      table={<DataTable headers={["Date", "Attendance", "Present", "Absent"]} rows={data.map((d) => [d.date, pctText(d.presenceRate), d.present, d.absent])} />}
      chart={
        <div className="h-56 w-full min-w-0" role="img" aria-label={`Daily attendance, from ${points[0]?.pct}% to ${points.at(-1)?.pct}%`}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={points} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false} width={40} domain={[0, 100]} tickFormatter={(v: number) => `${v}%`} />
              <ChartTip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => [`${v}%`, "Attendance"]} />
              <Line type="monotone" dataKey="pct" stroke="var(--chart-1)" strokeWidth={2} dot={false} isAnimationActive={!reduced} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      }
    />
  );
}

/* ----------------------------------- group by ----------------------------------- */

type GroupBy = "manager" | "source" | "site";

const GROUP_DESCRIPTION: Record<GroupBy, string> = {
  manager: "Attendance by manager's team.",
  source: "Punch-ins by where they came from.",
  site: "Punch-ins by work-site label. Never a map or a coordinate."
};

function GroupChart({ org }: Readonly<{ org: OrgAnalytics }>) {
  const [by, setBy] = useState<GroupBy>("manager");
  const wide = useMediaQuery("(min-width: 640px)");
  const reduced = usePrefersReducedMotion();
  const { rows, hidden, valueLabel, unit } = useMemo(() => {
    if (by === "manager") {
      const shown = org.byManager.filter((m) => !m.suppressed && m.aggregates?.presenceRate != null).map((m) => ({ name: m.managerName, value: Math.round((m.aggregates!.presenceRate ?? 0) * 100), people: m.people }));
      const hiddenGroups = org.byManager.filter((m) => m.suppressed).length;
      return { rows: shown.sort((a, b) => b.value - a.value), hidden: hiddenGroups, valueLabel: "Attendance", unit: "%" };
    }
    if (by === "site") {
      // 7.0.0: the work-site label of each punch-in ("At Head office", "Outside work sites").
      const sites = org.bySite ?? [];
      const shownSites = sites.filter((s) => !s.suppressed && s.punches).map((s) => ({ name: s.label, value: s.punches ?? 0, people: s.people }));
      return { rows: shownSites.sort((a, b) => b.value - a.value), hidden: sites.filter((s) => s.suppressed).length, valueLabel: "Punch-ins", unit: "" };
    }
    const shown = org.bySource.filter((s) => !s.suppressed && s.punches).map((s) => ({ name: s.source.toLowerCase(), value: s.punches ?? 0, people: s.people }));
    return { rows: shown.sort((a, b) => b.value - a.value), hidden: org.bySource.filter((s) => s.suppressed).length, valueLabel: "Punch-ins", unit: "" };
  }, [by, org]);

  const chartLabel = valueLabel + " by " + by + ": " + rows.map((r) => r.name + " " + r.value + unit).join(", ");

  const selector = wide ? (
    <Segmented
      label="Group by"
      value={by}
      onChange={setBy}
      options={[
        { value: "manager", label: "Manager" },
        { value: "source", label: "Source" },
        { value: "site", label: "Location label" }
      ]}
    />
  ) : (
    <Select value={by} onValueChange={(v) => setBy(v as GroupBy)}>
      <SelectTrigger className="w-40" aria-label="Group by">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="manager">Manager</SelectItem>
        <SelectItem value="source">Source</SelectItem>
        <SelectItem value="site">Location label</SelectItem>
      </SelectContent>
    </Select>
  );

  return (
    <ChartShell
      title="Breakdown"
      description={GROUP_DESCRIPTION[by]}
      action={selector}
      hasData={rows.length > 0 || hidden > 0}
      empty="Nothing to break down in this range."
      table={
        <>
          <DataTable headers={["Group", valueLabel, "People"]} rows={rows.map((r) => [r.name, `${r.value}${unit}`, r.people])} />
          {hidden > 0 && <SuppressedNote min={org.minGroupSize} />}
        </>
      }
      chart={
        <div className="grid gap-2">
          {rows.length > 0 && (
            <div className="w-full min-w-0" style={{ height: Math.max(120, rows.length * 38 + 20) }} role="img" aria-label={chartLabel}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 44, bottom: 0, left: 0 }}>
                  <XAxis type="number" hide domain={[0, by === "manager" ? 100 : "dataMax"]} />
                  <YAxis type="category" dataKey="name" width={wide ? 120 : 84} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                  <ChartTip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => [`${v}${unit}`, valueLabel]} cursor={{ fill: "hsl(var(--muted))" }} />
                  <Bar dataKey="value" fill="var(--chart-1)" radius={[0, 4, 4, 0]} barSize={18} isAnimationActive={!reduced}>
                    <LabelList dataKey="value" position="right" formatter={(v: number) => `${v}${unit}`} style={{ fontSize: 11, fill: "hsl(var(--foreground))" }} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
          {hidden > 0 && (
            <p className="flex items-start gap-2 rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {hidden} {hidden === 1 ? "group" : "groups"}: {suppressedLine(org.minGroupSize)}
            </p>
          )}
        </div>
      }
    />
  );
}

/* ------------------------------- integration health ------------------------------- */

function healthOf(s: SourceHealth): { word: string; icon: typeof CheckCircle2; tone: string; fix: boolean } {
  if (!s.enabled) return { word: "Off", icon: PauseCircle, tone: "text-muted-foreground", fix: false };
  if ((s.silentWorkingDays ?? 0) >= 2) return { word: `Silent for ${s.silentWorkingDays} working days`, icon: AlertTriangle, tone: "text-warning-ink", fix: true };
  if (s.lastEventAt == null) return { word: "Never sent anything", icon: AlertTriangle, tone: "text-warning-ink", fix: true };
  return { word: "Healthy", icon: CheckCircle2, tone: "text-success-ink", fix: false };
}

function IntegrationHealth({ list }: Readonly<{ list: SourceHealth[] }>) {
  return (
    <SectionCard title="Integration health" description="Each connected source, and how long since it last sent a punch.">
      {list.length === 0 ? (
        <EmptyState compact icon={Plug} title="No integrations connected" description="Biometric devices, HRMS and API sources show up here once set up in Settings." />
      ) : (
        <ul className="grid gap-2">
          {list.map((s) => {
            const h = healthOf(s);
            return (
              <li key={s.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border px-3 py-2">
                <h.icon className={cn("h-4 w-4 shrink-0", h.tone)} aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{s.name}</p>
                  <p className="text-xs text-muted-foreground">
                    <span className={cn("font-medium", h.tone)}>{h.word}</span>
                    {s.lastEventAt ? ` · last sync ${relativeTime(s.lastEventAt)}` : ""}
                  </p>
                </div>
                {h.fix && (
                  <Button asChild variant="outline" size="sm" className="min-h-[44px] sm:min-h-8">
                    <Link to="/app/settings">Fix in Settings</Link>
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}

/* --------------------------------------- view --------------------------------------- */

function exportCsv(org: OrgAnalytics, which: "teams" | "trend") {
  if (which === "teams") {
    const rows = org.byManager.map((m) => [m.managerName, m.people, m.suppressed || !m.aggregates ? "Not enough data" : pctText(m.aggregates.presenceRate)]);
    downloadText(`attendance-by-team-${org.range.from}-${org.range.to}.csv`, toCsv(["Team", "People", "Attendance"], rows));
  } else {
    const rows = (org.trend ?? []).map((t) => [t.date, pctText(t.presenceRate), t.present, t.absent]);
    downloadText(`attendance-trend-${org.range.from}-${org.range.to}.csv`, toCsv(["Date", "Attendance", "Present", "Absent"], rows));
  }
}

function OrgSkeleton() {
  return (
    <div className="grid gap-3" aria-busy="true" aria-label="Loading organisation analytics">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-28 w-full" />
        ))}
      </div>
      <Skeleton className="h-64 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

export function OrgAnalyticsView() {
  const range = useRange();
  const prev = previousRange(range.from, range.to);
  const q = useQuery({ queryKey: ["attendance", "analytics", "org", range.from, range.to], queryFn: () => attendanceAnalyticsApi.org(range.from, range.to) });
  const prevQ = useQuery({ queryKey: ["attendance", "analytics", "org", prev.from, prev.to], queryFn: () => attendanceAnalyticsApi.org(prev.from, prev.to), enabled: q.isSuccess });
  const d = q.data;
  const kpis = d ? orgKpis(d) : [];
  const prevKpis = prevQ.data ? orgKpis(prevQ.data) : [];

  return (
    <section aria-label="Organisation analytics" className="grid min-w-0 gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <RangeSelector value={range.days} onChange={range.setDays} />
        {d && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="min-h-[44px] sm:min-h-8">
                <Download className="mr-1.5 h-4 w-4" aria-hidden="true" />
                Export CSV
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => exportCsv(d, "teams")}>By team</DropdownMenuItem>
              <DropdownMenuItem disabled={!d.trend} onSelect={() => exportCsv(d, "trend")}>
                Daily trend
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {q.isLoading && <OrgSkeleton />}
      {q.isError && <CardError message="Organisation analytics could not be loaded." onRetry={() => runInBackground(q.refetch())} />}
      {d && (
        <>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            {kpis.map((k) => (
              <KpiCard key={k.id} kpi={k} delta={deltaPoints(k.raw, prevKpis.find((p) => p.id === k.id)?.raw ?? null)} period={range.days} />
            ))}
          </div>
          {d.overall.suppressed && <SuppressedNote people={d.overall.people} min={d.minGroupSize} />}
          <div className="grid min-w-0 gap-3 lg:grid-cols-2">
            {d.trend ? <TrendChart data={d.trend} /> : <SectionCard title="Attendance trend"><p className="text-xs text-muted-foreground">{suppressedLine(d.minGroupSize)}</p></SectionCard>}
            <GroupChart org={d} />
            <IntegrationHealth list={d.integrations} />
            <OvertimeFigure data={d.overtime} min={d.minGroupSize} />
            <InsightsList audience="org" from={range.from} to={range.to} />
          </div>

          <h2 className="text-sm font-semibold text-muted-foreground">More detail</h2>
          <div className="grid min-w-0 gap-3 lg:grid-cols-2">
            <PayrollExportCard />
            <SectionCard title="Sign-in times" description="Successful sign-ins per hour, in each person's timezone.">
              {d.loginHistogram.hours ? (
                <HistogramChart
                  data={d.loginHistogram.hours.map((count, h) => ({ hour: minuteText(h * 60), count }))}
                  xKey="hour"
                  valueLabel="Sign-ins"
                  ariaLabel={`Sign-ins by hour, ${d.loginHistogram.hours.reduce((a, b) => a + b, 0)} in total`}
                />
              ) : (
                <p className="text-xs text-muted-foreground">{suppressedLine(d.minGroupSize)}</p>
              )}
            </SectionCard>
            <SectionCard title="Face checks at punch-in">
              {d.face.suppressed ? (
                <p className="text-xs text-muted-foreground">{suppressedLine(d.minGroupSize)}</p>
              ) : (
                <dl className="grid grid-cols-3 gap-2 text-center">
                  <Fig label="Checks" value={String(d.face.checks ?? 0)} icon={<ShieldCheck className="mx-auto h-4 w-4 text-muted-foreground" aria-hidden="true" />} />
                  <Fig label="Passed" value={pctText(d.face.passRate)} />
                  <Fig label="Flagged" value={pctText(d.face.flagRate)} />
                </dl>
              )}
            </SectionCard>
            <SectionCard title="Holidays">
              <dl className="grid grid-cols-2 gap-2 text-center">
                <Fig label="Holiday dates" value={String(d.holidays.dates)} icon={<CalendarDays className="mx-auto h-4 w-4 text-muted-foreground" aria-hidden="true" />} />
                <Fig label="Person-days off" value={String(d.holidays.personDays)} />
              </dl>
              {d.upcomingHolidays.length > 0 && <p className="text-xs text-muted-foreground">Next 14 days: {d.upcomingHolidays.map((h) => `${h.name} (${shortDate(h.date)})`).join(", ")}</p>}
            </SectionCard>
          </div>
        </>
      )}
      {!d && !q.isLoading && !q.isError && <EmptyState compact icon={ArrowRight} title="Nothing to show" />}
    </section>
  );
}

function Fig({ label, value, icon }: Readonly<{ label: string; value: string; icon?: React.ReactNode }>) {
  return (
    <div className="rounded-md border border-border p-2">
      {icon}
      <dd className="text-lg font-black tabular-nums">{value}</dd>
      <dt className="text-xs text-muted-foreground">{label}</dt>
    </div>
  );
}
