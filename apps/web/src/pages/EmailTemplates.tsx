/**
 * WHAT: SUPER_ADMIN-only editor for this org's transactional email templates — edit subject/
 * body HTML with a live preview, send a single test, run the "test every template" smoke test,
 * and revert a customized template back to the built-in default. The second tab is the send
 * analytics: volume per template, monthly/weekly/daily trends, delivered-vs-failed, and a
 * grouped failure breakdown with the affected recipients.
 * WHY a preview matters here specifically: `{{variable}}` placeholders only make sense
 * rendered with real-looking sample data, and a raw HTML text field alone can't show whether an
 * edit that looked fine in the editor actually renders correctly.
 * WHY the analytics numbers need reading carefully: `EmailLog.template` holds a notification
 * CATEGORY for worker-driven sends and a templateKey for transactional ones, so a few rows are
 * shared between two cards or belong to no card at all. Both cases are labelled in the UI rather
 * than smoothed over — see `services/email-analytics.service.ts`.
 * WHO calls the backing API: `controllers/email-templates.controller.ts`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  BarChart3,
  CheckCircle2,
  ChevronRight,
  Eye,
  History as HistoryIcon,
  Loader2,
  Mail,
  MailX,
  Mails,
  Minus,
  PencilLine,
  AlertTriangle,
  RotateCcw,
  Save,
  Send,
  ServerCog,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Variable
} from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis
} from "recharts";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { ScrollArea } from "../components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Separator } from "../components/ui/separator";
import { Skeleton } from "../components/ui/skeleton";
import { StatCard } from "../components/ui/stat-card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { Textarea } from "../components/ui/textarea";
import { toast } from "../components/ui/toaster";
import {
  emailTemplateApi,
  type EmailAnalytics,
  type EmailFailureReason,
  type EmailLogRow,
  type EmailTemplateRow,
  type EmailTemplateVolumeRow,
  type EmailVolumeBucket
} from "../services/api";
import { BorderGlow } from "../components/ui/border-glow";
import { DateRangePicker, type DateRangeValue } from "../components/ui/date-range-picker";
import { categoriesIn, triageEmailFailure, type EmailFailureTriage } from "../lib/email-failure-triage";
import { safeHtml } from "../lib/safe-html";
import { computeTrend } from "../lib/trend";
import { useAuthStore } from "../store/auth";
import { copyText } from "../lib/clipboard";

const FALLBACK_DEFAULT = `<h2>Title</h2>
<p>Hi {{name}}, your action is required.</p>
<p>You can use any of the listed variables.</p>`;

function renderPreview(template: string, vars: Record<string, string>) {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) =>
    vars[key] !== undefined ? vars[key] : `{{${key}}}`
  );
}

function sampleFor(key: string): Record<string, string> {
  const map: Record<string, Record<string, string>> = {
    welcome: { name: "Aanya Sharma" },
    reset: { resetUrl: "https://timesphere.local/reset?token=demo" },
    "timesheet.submitted": {
      name: "Aanya Sharma",
      hours: "7.50",
      date: "2026-05-27",
      project: "HICS Operations Platform",
      managerName: "Mira Kapoor"
    },
    "timesheet.approved": {
      name: "Aanya Sharma",
      hours: "7.50",
      date: "2026-05-27",
      reviewer: "Mira Kapoor",
      project: "HICS Operations Platform"
    },
    "timesheet.rejected": {
      name: "Aanya Sharma",
      date: "2026-05-27",
      project: "HICS Operations Platform",
      reviewer: "Mira Kapoor",
      reason: "Activity should be 'Bug Fixing'."
    },
    "sla.breach": {
      managerName: "Mira Kapoor",
      employeeName: "Aanya Sharma",
      date: "2026-05-27",
      project: "HICS Operations Platform",
      deadline: "2026-05-29 18:00",
      hoursOverdue: "4.2"
    },
    escalation: {
      targetName: "Avery Stone",
      employeeName: "Aanya Sharma",
      managerName: "Mira Kapoor",
      date: "2026-05-27",
      project: "HICS Operations Platform"
    },
    "deadline.reminder": { name: "Aanya Sharma", daysLeft: "3", deadlineDay: "5" }
  };
  return map[key] ?? {};
}

const STATUS_VARIANT: Record<string, "success" | "warning" | "destructive" | "muted"> = {
  SENT: "success",
  QUEUED: "warning",
  FAILED: "destructive"
};

/* Chart conventions are shared with pages/Insights.tsx verbatim: CSS-variable colors only (so
   both themes work without a JS theme lookup), one shared axis/tooltip/grid style, and a fixed
   categorical order that is never reassigned by rank. */
const AXIS_STYLE = { stroke: "hsl(var(--muted-foreground))", fontSize: 12 };
const TOOLTIP_STYLE = {
  contentStyle: { background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, color: "hsl(var(--popover-foreground))" }
};
const GRID_STYLE = { strokeDasharray: "3 3", stroke: "hsl(var(--border))" };

// Delivery outcome is state, not identity — reserved status colors, never reused as a generic
// categorical hue. Order is fixed: delivered, in flight, failed.
const OUTCOME_COLOR = {
  sent: "hsl(var(--success))",
  queued: "hsl(var(--warning))",
  failed: "hsl(var(--destructive))"
};
const OUTCOME_LABEL = { sent: "Delivered", queued: "In flight", failed: "Failed" };

export function EmailTemplatesPage() {
  const templates = useQuery({ queryKey: ["email-templates"], queryFn: emailTemplateApi.list });
  const transport = useQuery({
    queryKey: ["email-templates", "transport-status"],
    queryFn: emailTemplateApi.transportStatus,
    refetchInterval: 30_000
  });
  // One aggregate fetch feeds both the per-card badges and the analytics tab, so switching tabs
  // never re-queries and the badge can never disagree with the table behind it.
  const analytics = useQuery({ queryKey: ["email-templates", "analytics"], queryFn: emailTemplateApi.analytics });
  const [editing, setEditing] = useState<EmailTemplateRow | null>(null);

  const volumeByKey = useMemo(
    () => new Map((analytics.data?.perTemplate ?? []).map((row) => [row.key, row])),
    [analytics.data]
  );

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-lg bg-primary/10 text-primary">
            <Mail className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight">Email templates</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Edit the subject and body of every transactional email. Variables in {`{{double_braces}}`} are replaced at send time.
            </p>
          </div>
        </div>
        <BulkTestButton />
      </div>

      <TransportStatusBanner status={transport.data} loading={transport.isLoading} />

      <Tabs defaultValue="templates" className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
        <TabsList className="w-full justify-start sm:w-auto">
          <TabsTrigger value="templates" className="gap-1.5"><Mail className="h-3.5 w-3.5" />Templates</TabsTrigger>
          <TabsTrigger value="analytics" className="gap-1.5"><BarChart3 className="h-3.5 w-3.5" />Analytics</TabsTrigger>
        </TabsList>

        <TabsContent value="templates">
          <div data-tour="templates-list" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {templates.isLoading &&
              Array.from({ length: 6 }).map((_, i) => (
                <Card key={`s-${i}`}>
                  <CardContent className="grid gap-2 pt-6">
                    <Skeleton className="h-8 w-8 rounded-md" />
                    <Skeleton className="h-4 w-2/3" />
                    <Skeleton className="h-3 w-full" />
                  </CardContent>
                </Card>
              ))}
            {!templates.isLoading &&
              (templates.data ?? []).map((row) => (
                <button
                  key={row.key}
                  type="button"
                  onClick={() => setEditing(row)}
                  className="grid gap-2.5 rounded-lg border border-border bg-card p-4 text-left shadow-sm transition hover:border-primary/40 hover:shadow-md"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                      <Mail className="h-4 w-4" />
                    </div>
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <p className="truncate font-semibold tracking-tight">{row.key}</p>
                      {!row.enabled && <Badge variant="warning">Disabled</Badge>}
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{row.description}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {row.hasOverride ? (
                      <Badge variant="info" className="gap-1"><PencilLine className="h-3 w-3" />Customized</Badge>
                    ) : (
                      <Badge variant="muted">Defaults</Badge>
                    )}
                    <SendVolumeBadge volume={volumeByKey.get(row.key)} loading={analytics.isLoading} />
                  </div>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {row.variables.map((v) => `{{${v}}}`).join(" · ")}
                  </p>
                </button>
              ))}
          </div>
        </TabsContent>

        <TabsContent value="analytics">
          <AnalyticsTab data={analytics.data} loading={analytics.isLoading} />
        </TabsContent>
      </Tabs>

      <EditorDialog template={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

/**
 * Send count + today-vs-yesterday direction, on the template card itself.
 *
 * Deliberately shows the absolute delta, not a percent: yesterday is zero for most templates on
 * most days, and "+100%" off a base of one send is noise dressed up as a signal.
 */
function SendVolumeBadge({ volume, loading }: { volume?: EmailTemplateVolumeRow; loading: boolean }) {
  if (loading) return <Skeleton className="h-5 w-20 rounded-full" />;
  if (!volume) return null;

  const delta = volume.today - volume.yesterday;
  const Icon = delta > 0 ? TrendingUp : delta < 0 ? TrendingDown : Minus;
  const sharedNote = volume.shared
    ? ` Shared with ${volume.sharedWith.join(", ")}: EmailLog records the notification category (${volume.sources.join(", ")}), which covers both templates, so this total counts them together.`
    : "";

  return (
    <span
      className="inline-flex items-center gap-1.5"
      title={`${volume.total} logged send(s) — ${volume.sent} delivered, ${volume.failed} failed, ${volume.test} test. Today ${volume.today} vs yesterday ${volume.yesterday}.${sharedNote}`}
    >
      <Badge variant="muted" className="gap-1">
        <Send className="h-3 w-3" />
        {volume.total.toLocaleString()} sent
      </Badge>
      <span className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-muted-foreground">
        <Icon className="h-3 w-3 shrink-0" />
        <span className={delta === 0 ? undefined : "text-foreground"}>
          {delta > 0 ? `+${delta}` : delta}
        </span>
      </span>
      {volume.shared && <Badge variant="warning">shared</Badge>}
    </span>
  );
}

/** Buckets arrive as ISO dates; parsed with an explicit time so they land on the local day the
 *  server meant, not UTC midnight shifted backwards by the viewer's offset. */
function formatBucket(bucket: string, granularity: Granularity): string {
  const date = new Date(`${bucket}T00:00:00`);
  return granularity === "monthly"
    ? date.toLocaleDateString(undefined, { month: "short", year: "2-digit" })
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

type Granularity = "monthly" | "weekly" | "daily";

const GRANULARITY_LABEL: Record<Granularity, string> = {
  monthly: "Last 12 months",
  weekly: "Last 12 weeks",
  daily: "Last 30 days"
};

function AnalyticsTab({ data, loading }: { data?: EmailAnalytics; loading: boolean }) {
  const [granularity, setGranularity] = useState<Granularity>("monthly");

  const series: EmailVolumeBucket[] = data ? data[granularity] : [];
  const chartData = useMemo(
    () => series.map((point) => ({ ...point, label: formatBucket(point.bucket, granularity) })),
    [series, granularity]
  );
  // Top 12 only — the full list lives in the table below, and 30+ horizontal bars is a scroll,
  // not a chart.
  const topTemplates = useMemo(
    () => (data?.perTemplate ?? []).filter((row) => row.total > 0).sort((a, b) => b.total - a.total).slice(0, 12),
    [data]
  );

  if (loading) {
    return (
      <div className="grid gap-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }
  if (!data) return null;

  const { totals } = data;
  const deliveredPct = totals.total > 0 ? Math.round((totals.sent / totals.total) * 100) : 0;

  return (
    <div className="grid min-w-0 gap-4">
      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4">
        <StatCard label="Emails logged" value={totals.total.toLocaleString()} icon={<Mail className="h-4 w-4" />} />
        <StatCard
          label="Delivered"
          value={`${totals.sent.toLocaleString()} (${deliveredPct}%)`}
          icon={<CheckCircle2 className="h-4 w-4" />}
          tone="success"
        />
        <StatCard
          label="Failed"
          value={totals.failed.toLocaleString()}
          icon={<MailX className="h-4 w-4" />}
          tone={totals.failed > 0 ? "destructive" : "default"}
          trend={computeTrend(data.today.failed, data.yesterday.failed, false)}
          trendLabel="failures today vs yesterday"
        />
        <StatCard
          label="Sent today"
          value={data.today.total.toLocaleString()}
          icon={<Send className="h-4 w-4" />}
          trend={computeTrend(data.today.total, data.yesterday.total, true)}
          trendLabel={`vs yesterday (${data.yesterday.total})`}
        />
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="grid gap-1">
            <CardTitle className="text-base">Send volume &amp; outcome</CardTitle>
            <CardDescription>
              Every logged send, stacked by what happened to it. {GRANULARITY_LABEL[granularity]}.
            </CardDescription>
          </div>
          <Tabs value={granularity} onValueChange={(value) => setGranularity(value as Granularity)} className="shrink-0">
            <TabsList>
              <TabsTrigger value="monthly">Monthly</TabsTrigger>
              <TabsTrigger value="weekly">Weekly</TabsTrigger>
              <TabsTrigger value="daily">Daily</TabsTrigger>
            </TabsList>
          </Tabs>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <div className="h-72 min-w-[640px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData}>
                  <CartesianGrid {...GRID_STYLE} />
                  <XAxis dataKey="label" {...AXIS_STYLE} />
                  <YAxis {...AXIS_STYLE} allowDecimals={false} />
                  <RTooltip {...TOOLTIP_STYLE} />
                  <Legend wrapperStyle={{ fontSize: 12, color: "hsl(var(--muted-foreground))" }} />
                  <Bar dataKey="sent" name={OUTCOME_LABEL.sent} stackId="outcome" fill={OUTCOME_COLOR.sent} radius={[0, 0, 0, 0]} />
                  <Bar dataKey="queued" name={OUTCOME_LABEL.queued} stackId="outcome" fill={OUTCOME_COLOR.queued} radius={[0, 0, 0, 0]} />
                  <Bar dataKey="failed" name={OUTCOME_LABEL.failed} stackId="outcome" fill={OUTCOME_COLOR.failed} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* min-w-0 on the grid ITEMS, not just the container: a grid item's default min-width is
          auto, which is the other half of the recharts shrink-deadlock documented on the chart
          wrappers below. */}
      <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Delivered vs. failed</CardTitle>
            <CardDescription>All-time outcome mix across every template.</CardDescription>
          </CardHeader>
          <CardContent>
            {/* Same recharts shrink-deadlock guard as the domain chart below. */}
            <div className="h-16 min-w-0 overflow-hidden">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  layout="vertical"
                  data={[{ name: "Emails", sent: totals.sent, queued: totals.queued, failed: totals.failed }]}
                  margin={{ left: 0, right: 0, top: 0, bottom: 0 }}
                >
                  <XAxis type="number" hide />
                  <YAxis type="category" dataKey="name" hide />
                  <RTooltip {...TOOLTIP_STYLE} />
                  <Bar dataKey="sent" name={OUTCOME_LABEL.sent} stackId="mix" fill={OUTCOME_COLOR.sent} radius={[4, 0, 0, 4]} />
                  <Bar dataKey="queued" name={OUTCOME_LABEL.queued} stackId="mix" fill={OUTCOME_COLOR.queued} radius={[0, 0, 0, 0]} />
                  <Bar dataKey="failed" name={OUTCOME_LABEL.failed} stackId="mix" fill={OUTCOME_COLOR.failed} radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
              {(["sent", "queued", "failed"] as const).map((outcome) => (
                <span key={outcome} className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: OUTCOME_COLOR[outcome] }} />
                  {OUTCOME_LABEL[outcome]} ({totals[outcome].toLocaleString()})
                </span>
              ))}
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              {totals.test.toLocaleString()} of these were test sends from this screen.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Today vs. yesterday</CardTitle>
            <CardDescription>Same-hour-of-day comparison isn't possible from the log, so today is still filling up.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {(["today", "yesterday"] as const).map((day) => (
              <div key={day} className="rounded-lg border border-border bg-muted/30 p-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">{day}</p>
                <p className="mt-1 text-2xl font-black tracking-tight">{data[day].total.toLocaleString()}</p>
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span className="text-success">{data[day].sent} delivered</span>
                  <span className="text-warning">{data[day].queued} in flight</span>
                  <span className="text-destructive">{data[day].failed} failed</span>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Template-wise send volume</CardTitle>
          <CardDescription>Top 12 templates by total logged sends — magnitude only, one hue.</CardDescription>
        </CardHeader>
        <CardContent>
          {topTemplates.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No emails have been sent yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <div className="h-[420px] min-w-[560px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={topTemplates} layout="vertical" margin={{ left: 24 }}>
                    <CartesianGrid {...GRID_STYLE} horizontal={false} />
                    <XAxis type="number" {...AXIS_STYLE} allowDecimals={false} />
                    <YAxis type="category" dataKey="key" {...AXIS_STYLE} width={170} />
                    <RTooltip {...TOOLTIP_STYLE} formatter={(value: number) => [value, "Sends"]} />
                    <Bar dataKey="total" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <TemplateBreakdownCard rows={data.perTemplate} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Other / unmapped</CardTitle>
          <CardDescription>
            Logged sends whose <code>template</code> value matches no editable template — categories with a
            code-only email, or values from an older release. Listed rather than dropped so these numbers and the
            {" "}{totals.total.toLocaleString()} total above reconcile.
          </CardDescription>
        </CardHeader>
        <CardContent className={data.unmapped.length === 0 ? undefined : "overflow-x-auto p-0"}>
          {data.unmapped.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing unmapped — every logged send belongs to a template card above.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Log template value</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Delivered</TableHead>
                  <TableHead className="text-right">Failed</TableHead>
                  <TableHead className="text-right">Today</TableHead>
                  <TableHead className="text-right">Yesterday</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.unmapped.map((row) => (
                  <TableRow key={row.template}>
                    <TableCell className="font-mono text-xs">{row.template}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.total.toLocaleString()}</TableCell>
                    <TableCell className="text-right tabular-nums text-success">{row.sent.toLocaleString()}</TableCell>
                    <TableCell className={`text-right tabular-nums ${row.failed > 0 ? "text-destructive" : "text-muted-foreground"}`}>
                      {row.failed.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{row.today.toLocaleString()}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{row.yesterday.toLocaleString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <FailureBreakdownCard />

      <DomainDeliveryCard />
    </div>
  );
}

/**
 * Per-template send analytics as a working table: search, scope filter (traffic / failures),
 * sort, a judged delivery-health bar per row (same idiom as the domain table — in-flight mail is
 * excluded from the rate because it hasn't been decided yet), and a today-vs-yesterday trend
 * arrow so "which template is suddenly loud" is visible without reading two number columns.
 */
function TemplateBreakdownCard({ rows }: { rows: EmailTemplateVolumeRow[] }) {
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState<"all" | "traffic" | "failures">("all");
  const [sort, setSort] = useState<"total" | "failed" | "today" | "name">("total");

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows
      .filter((row) => {
        if (scope === "traffic" && row.total === 0) return false;
        if (scope === "failures" && row.failed === 0) return false;
        if (!needle) return true;
        return row.key.toLowerCase().includes(needle) || row.sources.some((s) => s.toLowerCase().includes(needle));
      })
      .sort((a, b) => {
        if (sort === "name") return a.key.localeCompare(b.key);
        return (b[sort] as number) - (a[sort] as number) || a.key.localeCompare(b.key);
      });
  }, [rows, search, scope, sort]);

  const ratePct = (rate: number | null) => (rate === null ? "—" : `${(rate * 100).toFixed(0)}%`);

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="grid gap-1">
          <CardTitle className="text-base">Per-template breakdown</CardTitle>
          <CardDescription>
            Counts come from <code>EmailLog</code>, reconciled back to these cards. Rows marked{" "}
            <Badge variant="warning">shared</Badge> report a combined total for two templates that the log cannot
            tell apart — don't add those two rows together.
          </CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search template…"
            className="h-9 w-full sm:w-52"
          />
          <Select value={scope} onValueChange={(v) => setScope(v as typeof scope)}>
            <SelectTrigger className="h-9 w-full sm:w-[150px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All templates</SelectItem>
              <SelectItem value="traffic">With traffic</SelectItem>
              <SelectItem value="failures">With failures</SelectItem>
            </SelectContent>
          </Select>
          <Select value={sort} onValueChange={(v) => setSort(v as typeof sort)}>
            <SelectTrigger className="h-9 w-full sm:w-[160px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="total">Most sends</SelectItem>
              <SelectItem value="failed">Most failures</SelectItem>
              <SelectItem value="today">Busiest today</SelectItem>
              <SelectItem value="name">Name A–Z</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        {filtered.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">Nothing matches the current search and filters.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Template</TableHead>
                <TableHead className="w-44">Delivery health</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Delivered</TableHead>
                <TableHead className="text-right">Failed</TableHead>
                <TableHead className="text-right">Test</TableHead>
                <TableHead className="text-right">Today</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((row) => {
                const judged = row.sent + row.failed;
                const rate = judged > 0 ? row.sent / judged : null;
                const TrendIcon = row.today > row.yesterday ? TrendingUp : row.today < row.yesterday ? TrendingDown : Minus;
                return (
                  <TableRow key={row.key} className={row.total === 0 ? "opacity-60" : undefined}>
                    <TableCell className="font-medium">
                      <span className="flex flex-wrap items-center gap-1.5">
                        {row.key}
                        {row.shared && (
                          <Badge variant="warning" title={`Shared with ${row.sharedWith.join(", ")} — logged as ${row.sources.join(", ")}`}>
                            shared
                          </Badge>
                        )}
                      </span>
                    </TableCell>
                    <TableCell>
                      {row.total === 0 ? (
                        <span className="text-xs text-muted-foreground">never sent</span>
                      ) : (
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-full max-w-[6.5rem] overflow-hidden rounded-full bg-muted">
                            <div
                              className={`h-full ${rate !== null && rate < 0.9 ? "bg-destructive" : "bg-success"}`}
                              style={{ width: `${Math.round((rate ?? 0) * 100)}%` }}
                            />
                          </div>
                          <span className="text-xs tabular-nums text-muted-foreground">{ratePct(rate)}</span>
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{row.total.toLocaleString()}</TableCell>
                    <TableCell className="text-right tabular-nums text-success">{row.sent.toLocaleString()}</TableCell>
                    <TableCell className={`text-right tabular-nums ${row.failed > 0 ? "font-semibold text-destructive" : "text-muted-foreground"}`}>
                      {row.failed.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{row.test.toLocaleString()}</TableCell>
                    <TableCell className="text-right">
                      <span
                        className="inline-flex items-center justify-end gap-1 tabular-nums"
                        title={`${row.today} today vs ${row.yesterday} yesterday`}
                      >
                        {row.today.toLocaleString()}
                        <TrendIcon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                      </span>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

const FAILURE_WINDOWS = [7, 30, 90, 365];

const TONE_BADGE: Record<EmailFailureTriage["tone"], "destructive" | "warning" | "muted"> = {
  destructive: "destructive",
  warning: "warning",
  muted: "muted"
};

/**
 * Failure debugging: what broke, how often, and for whom — as a readable table, not raw SMTP.
 *
 * Reasons are grouped server-side on a NORMALISED form of the SMTP message, then classified
 * client-side (lib/email-failure-triage.ts) into a human title + first actions. The verbatim
 * message survives one click away in the detail dialog, alongside the optional AI diagnosis.
 */
function FailureBreakdownCard() {
  const [days, setDays] = useState(30);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [detailId, setDetailId] = useState<string | null>(null);
  const failures = useQuery({
    queryKey: ["email-templates", "analytics", "failures", days],
    queryFn: () => emailTemplateApi.failures(days)
  });

  const data = failures.data;
  const categories = useMemo(() => categoriesIn(data?.reasons ?? []), [data?.reasons]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (data?.reasons ?? []).filter((reason) => {
      const triage = triageEmailFailure(reason.reason);
      if (category !== "all" && triage.key !== category) return false;
      if (!needle) return true;
      return (
        triage.title.toLowerCase().includes(needle) ||
        reason.reason.toLowerCase().includes(needle) ||
        reason.recipients.some((r) => r.to.toLowerCase().includes(needle)) ||
        reason.templates.some((t) => t.template.toLowerCase().includes(needle)) ||
        reason.domains.some((d) => d.domain.toLowerCase().includes(needle))
      );
    });
  }, [data?.reasons, search, category]);

  const detail = filtered.find((r) => r.id === detailId) ?? data?.reasons.find((r) => r.id === detailId) ?? null;

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="grid gap-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <MailX className="h-4 w-4 text-destructive" />Why sends failed
          </CardTitle>
          <CardDescription>
            Identical reasons are grouped and translated into plain language. Open a row for the exact SMTP text,
            the affected recipients, the recommended fix — and an AI diagnosis of that specific case.
          </CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search reason, recipient, domain…"
            className="h-9 w-full sm:w-60"
          />
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger className="h-9 w-full sm:w-[190px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c.key} value={c.key}>{c.title}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={String(days)} onValueChange={(value) => setDays(Number(value))}>
            <SelectTrigger className="h-9 w-full sm:w-[150px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {FAILURE_WINDOWS.map((window) => (
                <SelectItem key={window} value={String(window)}>Last {window} days</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3">
        {failures.isLoading && <Skeleton className="h-24 w-full" />}
        {data && data.reasons.length === 0 && (
          <div className="grid place-items-center gap-2 py-8 text-center text-sm text-muted-foreground">
            <CheckCircle2 className="h-5 w-5 text-success" />
            <p>No failed sends in the last {days} days.</p>
          </div>
        )}
        {data && data.reasons.length > 0 && (
          <>
            {data.sampledFailures < data.totalFailures && (
              <p className="text-xs text-muted-foreground">
                Grouping the {data.sampledFailures.toLocaleString()} most recent of {data.totalFailures.toLocaleString()} failures in this window.
              </p>
            )}
            {filtered.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">Nothing matches the current search and filters.</p>
            )}

            {/* Desktop: a scannable table. */}
            {filtered.length > 0 && (
              <div className="hidden overflow-x-auto sm:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>What went wrong</TableHead>
                      <TableHead>Domains hit</TableHead>
                      <TableHead>Recipients</TableHead>
                      <TableHead>Last seen</TableHead>
                      <TableHead className="text-right">Failures</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.map((reason) => {
                      const triage = triageEmailFailure(reason.reason);
                      return (
                        <TableRow
                          key={reason.id}
                          className="cursor-pointer"
                          onClick={() => setDetailId(reason.id)}
                          title="Open details and actions"
                        >
                          <TableCell className="max-w-[26rem]">
                            <p className="text-sm font-medium">{triage.title}</p>
                            <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                              <Badge variant={TONE_BADGE[triage.tone]} className="px-1.5 py-0 text-[10px]">
                                {triage.transient ? "usually clears itself" : "needs action"}
                              </Badge>
                              <span className="truncate font-mono">{reason.reason.slice(0, 80)}{reason.reason.length > 80 ? "…" : ""}</span>
                            </p>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {reason.domains.slice(0, 3).map((d) => `${d.domain} ×${d.count}`).join(", ")}
                            {reason.domains.length > 3 ? ` +${reason.domains.length - 3}` : ""}
                          </TableCell>
                          <TableCell className="tabular-nums">
                            {reason.recipients.length}{reason.recipientsTruncated ? "+" : ""}
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                            {new Date(reason.lastSeen).toLocaleString()}
                          </TableCell>
                          <TableCell className="text-right">
                            <Badge variant="destructive">{reason.count.toLocaleString()}</Badge>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}

            {/* Phones: the same rows as tappable cards. */}
            <div className="grid gap-2 sm:hidden">
              {filtered.map((reason) => {
                const triage = triageEmailFailure(reason.reason);
                return (
                  <button
                    key={reason.id}
                    type="button"
                    onClick={() => setDetailId(reason.id)}
                    // min-w-0 + overflow-hidden are what make the truncate below actually truncate:
                    // a grid item with visible overflow takes the UNWRAPPED nowrap SMTP line as its
                    // automatic minimum width, which forced the whole page ~1150px wide on phones.
                    className="focus-ring min-w-0 overflow-hidden rounded-lg border border-border p-3 text-left transition hover:bg-muted/40"
                  >
                    <span className="flex items-start justify-between gap-2">
                      <span className="min-w-0 text-sm font-medium">{triage.title}</span>
                      <Badge variant="destructive" className="shrink-0">{reason.count.toLocaleString()}</Badge>
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {reason.recipients.length}{reason.recipientsTruncated ? "+" : ""} recipient(s) · last{" "}
                      {new Date(reason.lastSeen).toLocaleDateString()}
                    </span>
                    <span className="mt-1 block truncate font-mono text-[11px] text-muted-foreground">{reason.reason}</span>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </CardContent>

      {/* Keyed by reason id so switching rows remounts the dialog and resets the AI state. */}
      <FailureDetailDialog key={detail?.id ?? "none"} reason={detail} days={days} onClose={() => setDetailId(null)} />
    </Card>
  );
}

/** One failure group in full: triage advice, AI diagnosis, raw SMTP, and the recipient list. */
function FailureDetailDialog({
  reason,
  days,
  onClose
}: {
  reason: EmailFailureReason | null;
  days: number;
  onClose: () => void;
}) {
  const analyze = useMutation({
    mutationFn: () => emailTemplateApi.analyzeFailure(reason!.id, days),
    onError: (err: any) =>
      toast.error("AI diagnosis unavailable", {
        description: err?.response?.data?.message ?? "Check that AI and the email-failure diagnosis toggle are enabled."
      })
  });
  if (!reason) return null;
  const triage = triageEmailFailure(reason.reason);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="w-[min(95vw,780px)] max-w-none">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MailX className="h-4 w-4 text-destructive" />
            {triage.title}
          </DialogTitle>
          <DialogDescription>
            {reason.count.toLocaleString()} failures · first {new Date(reason.firstSeen).toLocaleDateString()} · last{" "}
            {new Date(reason.lastSeen).toLocaleString()} ·{" "}
            {reason.templates.map((t) => `${t.template} (${t.count})`).join(", ")}
          </DialogDescription>
        </DialogHeader>

        <div className="grid max-h-[65vh] gap-4 overflow-y-auto pr-1">
          <div className="grid gap-1.5 rounded-lg border border-border p-3">
            <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              What this means
              <Badge variant={TONE_BADGE[triage.tone]} className="px-1.5 py-0 text-[10px]">
                {triage.transient ? "usually clears itself" : "needs action"}
              </Badge>
            </p>
            <p className="text-sm">{triage.meaning}</p>
            <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recommended actions</p>
            <ol className="grid list-decimal gap-1 pl-5 text-sm">
              {triage.actions.map((action) => (
                <li key={action}>{action}</li>
              ))}
            </ol>
          </div>

          {/* keyed by whether an answer exists so the sweep replays when the diagnosis lands */}
          <BorderGlow key={analyze.data ? "answered" : "idle"} animated={Boolean(analyze.data)}>
            <div className="grid gap-2 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">AI diagnosis of this case</p>
              {/* `ai` is the variant for a control that SPENDS a model call — see the AI effect
                  layer. The gradient label came off with it: two treatments on one small button
                  competed, and the specular face already says what the gradient was saying. */}
              <Button size="sm" variant="ai" disabled={analyze.isPending} onClick={() => analyze.mutate()}>
                {analyze.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-1.5 h-3.5 w-3.5" />}
                {analyze.data ? "Re-analyze" : "Analyze with AI"}
              </Button>
            </div>
            {analyze.isPending && <Skeleton className="h-16 w-full" />}
            {analyze.data && (
              <div className="grid gap-2 text-sm">
                <p>{analyze.data.diagnosis}</p>
                <p className="text-xs text-muted-foreground">
                  <strong className="text-foreground">Likely cause:</strong> {analyze.data.likelyCause} ·{" "}
                  {analyze.data.transient ? "Expected to clear on its own or on retry." : "Needs an admin to change something."}
                </p>
                <ol className="grid list-decimal gap-1 pl-5">
                  {analyze.data.actions.map((action) => (
                    <li key={action}>{action}</li>
                  ))}
                </ol>
              </div>
            )}
            {!analyze.data && !analyze.isPending && (
              <p className="text-xs text-muted-foreground">
                Sends this group's counts and SMTP text (recipient domains only, never addresses) to your configured AI
                model for a case-specific reading.
              </p>
            )}
            </div>
          </BorderGlow>

          <div className="grid gap-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Raw SMTP message</p>
            <p className="break-words rounded-md bg-muted/50 p-2 font-mono text-xs">{reason.sample}</p>
          </div>

          {reason.domains.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {reason.domains.map((d) => (
                <Badge key={d.domain} variant="muted" className="font-mono text-[11px]">
                  {d.domain} ×{d.count}
                </Badge>
              ))}
            </div>
          )}

          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Recipient</TableHead>
                  <TableHead className="text-right">Failures</TableHead>
                  <TableHead>Last attempt</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {reason.recipients.map((recipient) => (
                  <TableRow key={recipient.to}>
                    <TableCell className="font-mono text-xs" title={recipient.lastMessage}>{recipient.to}</TableCell>
                    <TableCell className="text-right tabular-nums">{recipient.count}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {new Date(recipient.lastAt).toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {reason.recipientsTruncated && (
            <p className="text-xs text-muted-foreground">
              Showing the {reason.recipients.length} most affected recipients — this reason hit more addresses than are listed.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Delivery split by recipient DOMAIN over a chosen date range — which mail systems are failing
 * us, which are still holding mail in flight, and each one's success rate. The success rate
 * excludes in-flight mail: it hasn't been judged yet, and counting it either way would swing
 * the number on every worker tick.
 */
/** "3h" / "2d" ago — for the stuck-in-flight signal, where precision past hours is noise. */
function ageLabel(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins}m`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / (24 * 60))}d`;
}

function DomainDeliveryCard() {
  const [range, setRange] = useState<DateRangeValue>({ from: "", to: "" });
  const [openDomain, setOpenDomain] = useState<string | null>(null);
  const stats = useQuery({
    queryKey: ["email-templates", "analytics", "domains", range.from, range.to],
    queryFn: () => emailTemplateApi.domains(range.from || undefined, range.to || undefined)
  });

  const data = stats.data;
  const ratePct = (rate: number | null) => (rate === null ? "—" : `${(rate * 100).toFixed(1)}%`);

  // The domains that deserve a headline: real domains, really bleeding. The 90% bar matches the
  // success-rate bar's red threshold below so the two views never disagree about "unhealthy".
  const attention = (data?.domains ?? [])
    .filter((row) => !row.domain.startsWith("(") && row.failed > 0 && row.successRate !== null && row.successRate < 0.9)
    .sort((a, b) => b.failed - a.failed)
    .slice(0, 3);

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="grid gap-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <Mails className="h-4 w-4 text-primary" />Delivery by domain
          </CardTitle>
          <CardDescription>
            Where mail is landing, failing, or still in flight — open a domain row for its top failure reasons and what
            to do about them. Defaults to the last 30 days.
          </CardDescription>
        </div>
        <DateRangePicker
          id="email-domain-range"
          value={range}
          onChange={setRange}
          allowAllTime={false}
          placeholder="Last 30 days"
          className="w-full lg:w-auto"
        />
      </CardHeader>
      <CardContent className="grid gap-4">
        {stats.isLoading && <Skeleton className="h-40 w-full" />}
        {data && (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="rounded-lg border border-border p-3">
                <p className="text-xs text-muted-foreground">Delivered</p>
                <p className="text-lg font-bold tabular-nums text-success">{data.totals.sent.toLocaleString()}</p>
              </div>
              <div className="rounded-lg border border-border p-3">
                <p className="text-xs text-muted-foreground">Failed</p>
                <p className="text-lg font-bold tabular-nums text-destructive">{data.totals.failed.toLocaleString()}</p>
              </div>
              <div className="rounded-lg border border-border p-3">
                <p className="text-xs text-muted-foreground">In flight</p>
                <p className="text-lg font-bold tabular-nums text-warning">{data.totals.queued.toLocaleString()}</p>
              </div>
              <div className="rounded-lg border border-border p-3">
                <p className="text-xs text-muted-foreground">Success rate</p>
                <p className="text-lg font-bold tabular-nums">{ratePct(data.totals.successRate)}</p>
              </div>
            </div>

            {data.totals.total === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No mail was sent in this period.</p>
            ) : (
              <>
                {attention.length > 0 && (
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {attention.map((row) => {
                      const triage = row.topFailures[0] ? triageEmailFailure(row.topFailures[0].reason) : null;
                      return (
                        <button
                          key={row.domain}
                          type="button"
                          onClick={() => setOpenDomain((current) => (current === row.domain ? null : row.domain))}
                          className="focus-ring min-w-0 overflow-hidden rounded-lg border border-warning/40 bg-warning/5 p-3 text-left transition hover:bg-warning/10"
                        >
                          <span className="flex items-center justify-between gap-2">
                            <span className="truncate font-mono text-xs font-semibold">{row.domain}</span>
                            <Badge variant="destructive" className="shrink-0">{row.failed} failed</Badge>
                          </span>
                          <span className="mt-1 block text-xs text-muted-foreground">
                            {ratePct(row.successRate)} success rate
                            {triage ? ` · ${triage.title}` : ""}
                          </span>
                          {triage && (
                            <span className="mt-1 block truncate text-[11px] text-muted-foreground">
                              First step: {triage.actions[0]}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
                {/* overflow-hidden is load-bearing: recharts writes an explicit pixel width onto
                    its wrapper/svg, and a grid/flex ancestor with min-width:auto then cannot
                    shrink below it when the viewport narrows — the ResizeObserver never fires
                    again and the page is stuck wider than the screen. Clipping gives this box a
                    min-content of zero, so ancestors can always shrink and the chart re-measures. */}
                <div className="h-56 w-full min-w-0 overflow-hidden">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data.daily} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
                      <CartesianGrid {...GRID_STYLE} vertical={false} />
                      <XAxis
                        dataKey="bucket"
                        tick={AXIS_STYLE}
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={(bucket: string) =>
                          new Date(`${bucket}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" })
                        }
                        minTickGap={28}
                      />
                      <YAxis tick={AXIS_STYLE} tickLine={false} axisLine={false} allowDecimals={false} />
                      <RTooltip {...TOOLTIP_STYLE} />
                      <Legend wrapperStyle={{ fontSize: 12, color: "hsl(var(--muted-foreground))" }} />
                      <Bar dataKey="sent" name={OUTCOME_LABEL.sent} stackId="day" fill={OUTCOME_COLOR.sent} />
                      <Bar dataKey="queued" name={OUTCOME_LABEL.queued} stackId="day" fill={OUTCOME_COLOR.queued} />
                      <Bar dataKey="failed" name={OUTCOME_LABEL.failed} stackId="day" fill={OUTCOME_COLOR.failed} radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Domain</TableHead>
                        <TableHead className="text-right">Delivered</TableHead>
                        <TableHead className="text-right">Failed</TableHead>
                        <TableHead className="text-right">In flight</TableHead>
                        <TableHead className="w-40">Success rate</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.domains.map((row) => {
                        const expandable = row.topFailures.length > 0 || row.oldestQueuedAt !== null;
                        const open = openDomain === row.domain;
                        return (
                          <Fragment key={row.domain}>
                            <TableRow
                              className={expandable ? "cursor-pointer" : undefined}
                              onClick={expandable ? () => setOpenDomain(open ? null : row.domain) : undefined}
                              title={expandable ? "Show this domain's failure reasons" : undefined}
                            >
                              <TableCell className="font-mono text-xs">
                                <span className="flex items-center gap-1">
                                  {expandable && (
                                    <ChevronRight
                                      className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
                                      aria-hidden
                                    />
                                  )}
                                  {row.domain}
                                </span>
                              </TableCell>
                              <TableCell className="text-right tabular-nums text-success">{row.sent.toLocaleString()}</TableCell>
                              <TableCell className="text-right tabular-nums">
                                {row.failed > 0 ? (
                                  <span className="font-semibold text-destructive">{row.failed.toLocaleString()}</span>
                                ) : (
                                  <span className="text-muted-foreground">0</span>
                                )}
                              </TableCell>
                              <TableCell className="text-right tabular-nums text-muted-foreground">{row.queued.toLocaleString()}</TableCell>
                              <TableCell>
                                <div className="flex items-center gap-2">
                                  {/* Not the Progress component: this bar is a judged ratio, and its
                                      color must carry the verdict (healthy vs bleeding), which
                                      Progress's single primary fill can't express. */}
                                  <div className="h-1.5 w-full max-w-[6.5rem] overflow-hidden rounded-full bg-muted">
                                    <div
                                      className={`h-full ${row.successRate !== null && row.successRate < 0.9 ? "bg-destructive" : "bg-success"}`}
                                      style={{ width: `${Math.round((row.successRate ?? 0) * 100)}%` }}
                                    />
                                  </div>
                                  <span className="text-xs tabular-nums text-muted-foreground">{ratePct(row.successRate)}</span>
                                </div>
                              </TableCell>
                            </TableRow>
                            {open && (
                              <TableRow className="bg-muted/30 hover:bg-muted/30">
                                <TableCell colSpan={5} className="p-3">
                                  <div className="grid gap-2 text-sm">
                                    {row.oldestQueuedAt && (
                                      <p className="text-xs text-warning">
                                        Oldest in-flight message has been waiting {ageLabel(row.oldestQueuedAt)} — in-flight mail
                                        normally settles within a minute, so this is stuck, not busy.
                                      </p>
                                    )}
                                    {row.topFailures.map((failure) => {
                                      const triage = triageEmailFailure(failure.reason);
                                      return (
                                        <div key={failure.reason} className="grid gap-0.5">
                                          <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                                            {triage.title}
                                            <Badge variant={TONE_BADGE[triage.tone]} className="px-1.5 py-0 text-[10px]">
                                              {triage.transient ? "usually clears itself" : "needs action"}
                                            </Badge>
                                            <span className="text-xs tabular-nums text-muted-foreground">×{failure.count}</span>
                                          </p>
                                          <p className="text-xs text-muted-foreground">First step: {triage.actions[0]}</p>
                                        </div>
                                      );
                                    })}
                                    <p className="text-[11px] text-muted-foreground">
                                      Full detail — exact SMTP text, every recipient, AI diagnosis — lives in "Why sends failed" above.
                                    </p>
                                  </div>
                                </TableCell>
                              </TableRow>
                            )}
                          </Fragment>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function BulkTestButton() {
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState("");

  useEffect(() => {
    if (open && user?.email) setTo(user.email);
  }, [open, user?.email]);

  const testAll = useMutation({
    mutationFn: () => emailTemplateApi.testAll(to.trim() || undefined),
    onSuccess: (data) => {
      const intro = `${data.sent} / ${data.total} delivered to ${data.recipient}`;
      if (data.failed === 0) {
        toast.success("All templates sent", { description: intro });
      } else {
        const firstError = data.results.find((r) => !r.ok)?.errorMessage ?? "See Recent sends for each template.";
        toast.warning("Bulk send completed with failures", { description: `${intro}. First error: ${firstError}`, duration: 12_000 });
      }
      queryClient.invalidateQueries({ queryKey: ["email-templates"] });
      setOpen(false);
    },
    onError: (err: any) =>
      toast.error("Bulk send failed", { description: err?.response?.data?.message ?? "Try again." })
  });

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Mails className="h-4 w-4" />Send all templates as test
      </Button>
      <Dialog open={open} onOpenChange={(value) => !testAll.isPending && setOpen(value)}>
        <DialogContent className="w-[min(95vw,520px)] max-w-none">
          <DialogHeader>
            <DialogTitle>Bulk send — every template as a test</DialogTitle>
            <DialogDescription>
              Sends one email per template (welcome, reset, all timesheet states, SLA / escalation, daily reminder family — 11 emails total)
              to the address below. Sample variables are used in place of real data. Bulk tests bypass the workspace BCC list,
              so super admins won't receive copies — only the recipient does.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="bulk-to">Recipient</Label>
            <Input
              id="bulk-to"
              type="email"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              placeholder="aditya.puppala@hics.com.sg"
              disabled={testAll.isPending}
            />
            <p className="text-xs text-muted-foreground">
              The recipient will receive ~11 emails. Each one is also written to <code>EmailLog</code> as a <code>.test</code> row, visible in
              Recent sends for the corresponding template.
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={testAll.isPending}>Cancel</Button>
            <Button onClick={() => testAll.mutate()} disabled={testAll.isPending || !to.includes("@")}>
              {testAll.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Send all
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function TransportStatusBanner({
  status,
  loading
}: {
  status?: import("../services/api").MailTransportStatus;
  loading: boolean;
}) {
  if (loading || !status) return null;

  if (!status.configured) {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>SMTP is not configured — test emails will NOT be delivered</AlertTitle>
        <AlertDescription>
          The API server has no <code className="rounded bg-background/40 px-1">SMTP_HOST</code> set. Every "Send test" is logged as <Badge variant="destructive">FAILED</Badge> and never leaves the box.{" "}
          {/* The `{" "}` after each comma is required, not cosmetic. JSX drops whitespace that
              contains a newline, so a `</code>,` followed by a newline and the next `<code>` renders
              the four chips as ONE unbreakable inline run with no line-break opportunity between
              them — ~340px of text that cannot wrap, which widened this page past a 390px phone
              viewport and pushed the header and every card out with it. The chips' own `px-1`
              padding made it LOOK correctly spaced, which is why the missing space stayed invisible
              until the page was actually measured. */}
          Add <code className="rounded bg-background/40 px-1">SMTP_HOST</code>,{" "}
          <code className="rounded bg-background/40 px-1">SMTP_PORT</code>,{" "}
          <code className="rounded bg-background/40 px-1">SMTP_USER</code>,{" "}
          <code className="rounded bg-background/40 px-1">SMTP_PASS</code> to{" "}
          <code className="rounded bg-background/40 px-1">apps/api/.env</code> and restart the API.
        </AlertDescription>
      </Alert>
    );
  }

  if (status.verified === false) {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>SMTP transport reachable but verification failed</AlertTitle>
        <AlertDescription>
          <p>
            Connected to <strong>{status.host}:{status.port}</strong> (secure: {String(status.secure)}, user: {status.user ?? "—"}) but
            authentication or TLS negotiation failed:
          </p>
          <p className="mt-2 rounded-md bg-background/40 p-2 font-mono text-xs">{status.verifyError}</p>
          <p className="mt-2">Most common causes: wrong password, app-password not enabled, or wrong port/secure combo (port 465 needs <code>SMTP_SECURE=true</code>; port 587 needs <code>SMTP_SECURE=false</code>).</p>
        </AlertDescription>
      </Alert>
    );
  }

  // SMTP works but MAIL_FROM has deliverability issues — this is the silent killer.
  // Show as warning, not blocker, because the SMTP transport itself is healthy.
  if (status.fromIssues.length > 0) {
    return (
      <Alert variant="warning">
        <AlertCircle />
        <AlertTitle>SMTP works but MAIL_FROM will likely be dropped or marked as spam</AlertTitle>
        <AlertDescription>
          <p className="mb-2">
            Transport verified ({status.host}:{status.port}) — but the From address has problems that prevent inbox delivery:
          </p>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {status.fromIssues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
          <p className="mt-3 text-xs">
            <strong>Current From:</strong> <code className="rounded bg-background/40 px-1">{status.from}</code> →
            domain <code className="rounded bg-background/40 px-1">{status.fromDomain ?? "?"}</code> ·
            SMTP_USER domain <code className="rounded bg-background/40 px-1">{status.userDomain ?? "?"}</code>
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Symptom: EmailLog shows <Badge variant="success">SENT</Badge> (the SMTP server accepted it), but recipients never see it in
            their inbox or spam.
          </p>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert variant="success">
      <ServerCog />
      <AlertTitle>SMTP transport verified</AlertTitle>
      <AlertDescription>
        Sending via <strong>{status.host}:{status.port}</strong> (secure: {String(status.secure)}, user: {status.user ?? "—"})
        as <strong>{status.from}</strong>.
      </AlertDescription>
    </Alert>
  );
}

function EditorDialog({ template, onClose }: { template: EmailTemplateRow | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const open = Boolean(template);

  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [testTo, setTestTo] = useState("");

  // Re-initialize when the *template being edited* changes (different key),
  // not on every refetch of the same template. Otherwise a polling refresh
  // of the templates list would clobber unsaved edits in the editor.
  useEffect(() => {
    if (!template) return;
    // An un-customised template opens on the REAL email, not on a placeholder. Editing starts from
    // what actually goes out, and pressing Save without meaning to can no longer replace a designed
    // template with a stub.
    setSubject(template.subject ?? defaultSubject(template));
    setBody(template.bodyHtml ?? template.defaultHtml ?? FALLBACK_DEFAULT);
    setEnabled(template.enabled);
    setTestTo("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template?.key]);

  const log = useQuery({
    queryKey: ["email-templates", template?.key, "log"],
    queryFn: () => emailTemplateApi.log(template!.key),
    enabled: Boolean(template)
  });

  const save = useMutation({
    mutationFn: () => emailTemplateApi.save(template!.key, { subject, bodyHtml: body, enabled }),
    onSuccess: () => {
      toast.success("Template saved");
      queryClient.invalidateQueries({ queryKey: ["email-templates"] });
      onClose();
    },
    onError: (err: any) =>
      toast.error("Save failed", { description: err?.response?.data?.message ?? "Try again." })
  });

  const revert = useMutation({
    mutationFn: () => emailTemplateApi.revert(template!.key),
    onSuccess: () => {
      toast.success("Reverted to defaults");
      queryClient.invalidateQueries({ queryKey: ["email-templates"] });
      onClose();
    },
    onError: (err: any) =>
      toast.error("Revert failed", { description: err?.response?.data?.message ?? "Try again." })
  });

  const test = useMutation({
    mutationFn: () => emailTemplateApi.test(template!.key, testTo || undefined),
    onSuccess: (data: any) => {
      const target = data?.to ?? "your inbox";
      toast.success(`Sent to ${target}`, {
        description: "Test sends bypass the workspace BCC list — only this address received it.",
        duration: 6_000
      });
      queryClient.invalidateQueries({ queryKey: ["email-templates", template?.key, "log"] });
      // A test send is a logged send — the volume badge and the analytics tab must move with it.
      queryClient.invalidateQueries({ queryKey: ["email-templates", "analytics"] });
    },
    onError: (err: any) => {
      const status = err?.response?.status;
      const message = err?.response?.data?.message ?? "Try again.";
      if (status === 502) {
        toast.error("Email NOT delivered", { description: message, duration: 10_000 });
      } else if (status === 422) {
        toast.error("Save the template first", { description: message });
      } else {
        toast.error("Test send failed", { description: message });
      }
    }
  });

  const samples = useMemo(() => (template ? sampleFor(template.key) : {}), [template]);
  const previewSubject = useMemo(() => renderPreview(subject, samples), [subject, samples]);
  const previewBody = useMemo(() => renderPreview(body, samples), [body, samples]);

  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      <DialogContent className="max-h-[92vh] w-[min(96vw,1100px)] max-w-none overflow-y-auto sm:rounded-xl">
        {template && (
          <>
            <DialogHeader>
              <DialogTitle className="flex flex-wrap items-center gap-2 text-lg">
                Edit {template.key}
                {!enabled && <Badge variant="warning">Disabled</Badge>}
              </DialogTitle>
              <DialogDescription>{template.description}</DialogDescription>
            </DialogHeader>

            <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
              <div className="grid gap-4">
                <div className="grid gap-1.5">
                  <Label htmlFor="tpl-subject">Subject</Label>
                  <Input id="tpl-subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={255} />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="tpl-body" className="flex items-center justify-between">
                    <span>HTML body</span>
                    <span className="text-xs font-normal text-muted-foreground">
                      Inline styles preserved · scripts always stripped
                    </span>
                  </Label>
                  <Textarea
                    id="tpl-body"
                    rows={16}
                    spellCheck={false}
                    className="font-mono text-xs"
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                  />
                </div>

                <div className="grid gap-2 rounded-lg border border-border bg-muted/30 p-3">
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    <Variable className="h-4 w-4 text-primary" />
                    Available variables
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {template.variables.map((v) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => {
                          void copyText(`{{${v}}}`);
                          toast.success("Copied", { description: `{{${v}}}` });
                        }}
                        className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 font-mono text-xs hover:border-primary/40 hover:text-primary"
                      >
                        {`{{${v}}}`}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Button onClick={() => save.mutate()} disabled={save.isPending || subject.length < 3 || body.length < 20}>
                    {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}Save template
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => setEnabled((value) => !value)}
                    disabled={save.isPending}
                  >
                    {enabled ? "Disable" : "Enable"}
                  </Button>
                  {template.hasOverride && (
                    <Button variant="ghost" onClick={() => revert.mutate()} disabled={revert.isPending}>
                      <RotateCcw className="h-4 w-4" />Revert to defaults
                    </Button>
                  )}
                </div>

                {/* An override wins outright, so a template customised before a field existed keeps
                    sending without it — silently, and forever. This is the only place anybody would
                    find out. Named variables, not a vague warning: the fix is to paste them in or to
                    revert, and both need to know which. */}
                {template.missingVariables.length > 0 && (
                  <p className="flex flex-wrap items-start gap-1.5 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                    <span>
                      Your customised version does not use{" "}
                      {template.missingVariables.map((v) => (
                        <code key={v} className="mx-0.5 rounded bg-muted px-1">{`{{${v}}}`}</code>
                      ))}
                      , which the shipped default now includes. Add them above, or revert to pick up the newer email.
                    </span>
                  </p>
                )}

                <Separator />

                <div className="grid gap-2">
                  <Label htmlFor="tpl-test">Send a test</Label>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      id="tpl-test"
                      type="email"
                      placeholder="Defaults to your own email"
                      value={testTo}
                      onChange={(e) => setTestTo(e.target.value)}
                    />
                    <Button
                      variant="outline"
                      onClick={() => test.mutate()}
                      disabled={test.isPending || !template.hasOverride}
                    >
                      {test.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                      Send test
                    </Button>
                  </div>
                  {!template.hasOverride && (
                    <p className="text-xs text-muted-foreground">Save the template first to enable test sends.</p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Test sends go to the address above only — they bypass the workspace BCC-super-admin setting so you can verify a single recipient.
                  </p>
                </div>
              </div>

              <Tabs defaultValue="preview" className="grid gap-3">
                <TabsList className="w-full justify-start">
                  <TabsTrigger value="preview" className="gap-1">
                    <Eye className="h-3.5 w-3.5" />Preview
                  </TabsTrigger>
                  <TabsTrigger value="log" className="gap-1">
                    <HistoryIcon className="h-3.5 w-3.5" />Recent sends
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="preview" className="grid gap-2">
                  <div className="rounded-lg border border-border bg-card">
                    <div className="border-b border-border bg-muted/40 px-3 py-2 text-xs">
                      <p className="text-muted-foreground">Subject</p>
                      <p className="mt-0.5 font-semibold">{previewSubject || <em className="text-muted-foreground">— empty —</em>}</p>
                    </div>
                    <ScrollArea className="max-h-[420px]">
                      <div
                        className="prose prose-sm max-w-none p-4 dark:prose-invert"
                        dangerouslySetInnerHTML={safeHtml(previewBody)}
                      />
                    </ScrollArea>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Preview uses sample values for each variable. Real sends substitute live data.
                  </p>
                </TabsContent>

                <TabsContent value="log">
                  <Card className="shadow-none">
                    <CardHeader>
                      <CardTitle className="text-sm">Last 30 sends</CardTitle>
                      <CardDescription className="text-xs">
                        Pulled from EmailLog. Failed sends show the SMTP error.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="p-0">
                      <ScrollArea className="max-h-[360px]">
                        {(log.data ?? []).length === 0 && !log.isLoading && (
                          <div className="grid place-items-center gap-2 px-4 py-10 text-center text-sm text-muted-foreground">
                            <Mail className="h-5 w-5" />
                            <p>No sends yet for this template.</p>
                          </div>
                        )}
                        {(log.data ?? []).map((entry: EmailLogRow) => (
                          <div key={entry.id} className="border-b border-border px-4 py-3 last:border-0">
                            <div className="flex items-center justify-between gap-2">
                              <p className="truncate text-sm font-medium">{entry.to}</p>
                              <Badge variant={STATUS_VARIANT[entry.status] ?? "muted"}>{entry.status}</Badge>
                            </div>
                            <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{entry.subject}</p>
                            <p className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                              {new Date(entry.createdAt).toLocaleString()}
                            </p>
                            {entry.metadata?.messageId && (
                              <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground/80">
                                messageId: {entry.metadata.messageId}
                              </p>
                            )}
                            {entry.errorMessage && (
                              <p className="mt-1 text-xs text-destructive">{entry.errorMessage}</p>
                            )}
                          </div>
                        ))}
                      </ScrollArea>
                    </CardContent>
                  </Card>
                </TabsContent>
              </Tabs>
            </div>

            <DialogFooter>
              <Button variant="ghost" onClick={onClose}>Close</Button>
            </DialogFooter>
            {save.isSuccess && <CheckCircle2 className="sr-only" />}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The subject an un-customised template sends with.
 *
 * Comes from the SERVER now. This used to be a hand-kept map of eight keys, so the other
 * twenty-four opened on "TimeSphere — reminder.daily" — a subject nothing has ever sent, presented as
 * if it were the current one. The server reads it from the same place the send does, which is the
 * only way the two cannot disagree.
 */
function defaultSubject(template: EmailTemplateRow): string {
  return template.defaultSubject ?? `TimeSphere — ${template.key}`;
}
