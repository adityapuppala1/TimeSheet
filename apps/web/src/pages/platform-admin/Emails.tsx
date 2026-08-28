/**
 * Platform emails — the messages the DEPLOYMENT sends (the retention programme, the signup code,
 * the relay test), as opposed to what a workspace sends. Same three-part shape as the workspace
 * Email Templates page so an operator who knows one knows the other: an editor with a live
 * preview and a test send, the delivery analytics, and the log with a resend button.
 *
 * The preview is rendered by the SERVER (`/email-templates/:key/preview`) from the unsaved draft,
 * so what the operator sees is exactly what `{{vars}}` substitution and sanitisation will produce
 * — the client never has a second, drifting renderer.
 *
 * LAYOUT (3.12.x, console kit pass). The list/editor split starts at `xl`, not `lg`: at 1024 the
 * console's 220px rail leaves ~740px for the page, and a 300px list beside a full-width editor did
 * not fit — the grid overflowed the viewport, so the list was clipped and its descriptions ran
 * underneath the editor card. Both tracks are `minmax(0,…)` and every string inside them is allowed
 * to clip (truncate for a key, a two-line clamp for a description), because a narrow track only
 * holds if its contents may shrink; `min-w-0` on the flex/grid ancestors alone did not survive here.
 *
 * The rest is the shared kit rather than this page's own geometry: `ConsoleTable` so the delivery
 * log scrolls inside its own box (at 1024 the un-minimum-width table wrapped WORKSPACE and STAGE to
 * three lines each instead), `Field`/`Toolbar` for the editor's controls, `Num` for every count
 * column, `KpiGrid` for the analytics tiles.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Eye, History, MailCheck, MailX, Mails, RotateCcw, Save, Send, TestTube2, Variable } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Skeleton } from "../../components/ui/skeleton";
import { Switch } from "../../components/ui/switch";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { Textarea } from "../../components/ui/textarea";
import { toast } from "../../components/ui/toaster";
import { cn } from "../../lib/utils";
import { platformAdminConsoleApi, type PlatformEmailLogRow, type PlatformEmailTemplateRow } from "../../services/platform-admin-api";
import {
  ConsolePage,
  ConsoleSection,
  ConsoleTable,
  EmptyState,
  Field,
  KpiCard,
  KpiGrid,
  MARKER_LABEL,
  Num,
  OrgStatusPill,
  PRIMARY_BTN,
  SegmentedControl,
  shortDate,
  shortDateTime,
  Toolbar
} from "./console-ui";

const STATUS_VARIANT: Record<PlatformEmailLogRow["status"], "success" | "destructive" | "warning"> = { SENT: "success", FAILED: "destructive", SKIPPED: "warning" };

/**
 * One chip style for every `{{variable}}`, fixed height included. The variables differ wildly in
 * length ({{name}} against {{workspaceUrl}}), so without a shared height and gap the row read as a
 * ragged block of loose words rather than one palette of tokens.
 */
const VAR_CHIP =
  "focus-ring inline-flex h-6 shrink-0 items-center rounded-md border border-border bg-muted px-2 font-mono text-[11px] leading-none text-foreground transition-colors hover:border-accent hover:text-accent";

/**
 * The preview frame's height, stepped by BREAKPOINT rather than in `vh`. A viewport-relative height
 * is the wrong measure twice over: it leaves a tall white void under a short email on a phone (the
 * defect this replaces), and it grows with the window while what actually changes across these
 * breakpoints is how WIDE this column is.
 */
const PREVIEW_FRAME = "h-[300px] sm:h-[380px] xl:h-[460px] w-full";

/** Recharts' tooltip needs inline styles; one object so every chart in this file matches. */
const TOOLTIP_STYLE = {
  background: "hsl(var(--popover))",
  border: "1px solid hsl(var(--border))",
  borderRadius: 8,
  fontSize: 12,
  color: "hsl(var(--popover-foreground))"
} as const;

/** The window presets, as day counts. A custom range is not offered here on purpose — the question
 *  this screen answers ("is mail getting through lately?") has three useful answers, and a date
 *  picker for it is chrome nobody uses. */
const PRESET_DAYS: Record<string, number> = { "7": 7, "30": 30, "90": 90 };

function rangeForPreset(preset: string): { from?: string; to?: string } {
  const days = PRESET_DAYS[preset] ?? 90;
  const to = new Date();
  const from = new Date(to.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

/** Which preset the current range corresponds to, so the control shows the right segment after a
 *  reload — the state is a date pair, not a preset, because that is what the API takes. */
function presetOf(range: { from?: string; to?: string }): string {
  if (!range.from || !range.to) return "90";
  const span = Math.round((new Date(range.to).getTime() - new Date(range.from).getTime()) / (24 * 60 * 60 * 1000)) + 1;
  return String(Object.entries(PRESET_DAYS).find(([, d]) => Math.abs(d - span) <= 1)?.[0] ?? "90");
}

const rateHint = (rate: number | null) => (rate === null ? "Nothing has settled yet" : `${Math.round(rate * 100)}% of attempts got through`);

/**
 * A delivery rate as a badge. Coloured against thresholds rather than shown as a bare number,
 * because the number alone does not say whether it is bad: 92% looks fine and is a relay in
 * trouble. Null renders as an em dash — no attempt has been judged, which is not 0%.
 */
function RateBadge({ rate }: { rate: number | null }) {
  if (rate === null) return <span className="text-muted-foreground">—</span>;
  const pct = Math.round(rate * 100);
  const variant = pct >= 98 ? "success" : pct >= 90 ? "warning" : "destructive";
  return <Badge variant={variant}>{pct}%</Badge>;
}

const errorMessageOf = (error: unknown): string | undefined =>
  (error as { response?: { data?: { message?: string } } })?.response?.data?.message;

/* ----------------------------------------------------------------------------------------- */
/* Templates                                                                                  */
/* ----------------------------------------------------------------------------------------- */

function TemplateList({ rows, selected, onSelect }: { rows: PlatformEmailTemplateRow[]; selected: string | null; onSelect: (key: string) => void }) {
  const groups = useMemo(() => {
    const map = new Map<string, PlatformEmailTemplateRow[]>();
    for (const r of rows) map.set(r.group, [...(map.get(r.group) ?? []), r]);
    return [...map.entries()];
  }, [rows]);
  return (
    <div className="grid min-w-0 gap-4">
      {groups.map(([group, items]) => (
        <div key={group} className="grid min-w-0 gap-1">
          <p className="px-2 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{group}</p>
          {items.map((t) => (
            /* A grid, not a flex row: `minmax(0,1fr)` is what actually caps the text column at the
               card's width. As a flex item the same block sized to its longest description and the
               sentence escaped the card, `min-w-0` or not. The `min-h` keeps a one-line description
               the same height as a two-line one so the list reads as a list. */
            <button
              key={t.key}
              type="button"
              onClick={() => onSelect(t.key)}
              className={cn(
                "focus-ring grid w-full min-h-[3.75rem] grid-cols-[minmax(0,1fr)_auto] items-start gap-2 rounded-lg border px-3 py-2 text-left transition-colors",
                selected === t.key ? "border-accent/60 bg-accent/10" : "border-transparent hover:bg-muted"
              )}
            >
              <span className="grid min-w-0 gap-0.5">
                <span className="truncate font-mono text-xs text-foreground">{t.key}</span>
                <span className="line-clamp-2 text-xs leading-snug text-muted-foreground">{t.description}</span>
              </span>
              <span className="flex shrink-0 flex-col items-end gap-1">
                {t.hasOverride && <Badge variant="info">edited</Badge>}
                <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                  {t.sent30}
                  {t.failed30 > 0 && <span className="text-destructive"> / {t.failed30}✕</span>}
                </span>
              </span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

function TemplateEditor({ template }: { template: PlatformEmailTemplateRow }) {
  const queryClient = useQueryClient();
  const [subject, setSubject] = useState(template.subject ?? template.defaultSubject);
  const [body, setBody] = useState(template.bodyHtml ?? template.defaultHtml);
  const [enabled, setEnabled] = useState(template.enabled);
  const [preview, setPreview] = useState<{ subject: string; html: string } | null>(null);
  const [testOpen, setTestOpen] = useState(false);
  const [testTo, setTestTo] = useState("");

  useEffect(() => {
    setSubject(template.subject ?? template.defaultSubject);
    setBody(template.bodyHtml ?? template.defaultHtml);
    setEnabled(template.enabled);
  }, [template]);

  // Server-rendered preview of the DRAFT, debounced — the same substitution and sanitiser as a real send.
  useEffect(() => {
    const handle = setTimeout(() => {
      platformAdminConsoleApi
        .previewEmailTemplate(template.key, { subject, bodyHtml: body })
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 350);
    return () => clearTimeout(handle);
  }, [template.key, subject, body]);

  const dirty = subject !== (template.subject ?? template.defaultSubject) || body !== (template.bodyHtml ?? template.defaultHtml) || enabled !== template.enabled;
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["platform-admin", "email-templates"] });

  const save = useMutation({
    mutationFn: () => platformAdminConsoleApi.saveEmailTemplate(template.key, { subject, bodyHtml: body, enabled }),
    onSuccess: () => {
      toast.success("Template saved");
      invalidate();
    },
    onError: (e) => toast.error("Could not save", { description: errorMessageOf(e) })
  });
  const revert = useMutation({
    mutationFn: () => platformAdminConsoleApi.revertEmailTemplate(template.key),
    onSuccess: () => {
      toast.success("Reverted to the shipped version");
      invalidate();
    }
  });
  const test = useMutation({
    mutationFn: () => platformAdminConsoleApi.testEmailTemplate(template.key, testTo),
    onSuccess: (r) => {
      toast.success(`Test sent to ${r.to}`, { description: r.subject });
      setTestOpen(false);
      queryClient.invalidateQueries({ queryKey: ["platform-admin", "email-template-log", template.key] });
    },
    onError: (e) => toast.error("Test NOT delivered", { description: errorMessageOf(e) })
  });
  const log = useQuery({ queryKey: ["platform-admin", "email-template-log", template.key], queryFn: () => platformAdminConsoleApi.emailTemplateLog(template.key) });

  return (
    <>
      {/* The editor's identity and its controls are the section header, so the override switch,
          Send test, Revert and Save wrap as one cluster instead of colliding with the key. */}
      <ConsoleSection
        className="min-w-0"
        bodyClassName="grid min-w-0 gap-5"
        title={<span className="block truncate font-mono text-sm">{template.key}</span>}
        description={template.description}
        actions={
          <Toolbar>
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <Switch checked={enabled} onCheckedChange={setEnabled} />
              <span className="whitespace-nowrap">{enabled ? "Override on" : "Override off"}</span>
            </label>
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setTestOpen(true)}>
              <Send className="h-3.5 w-3.5" />Send test
            </Button>
            {template.hasOverride && (
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => revert.mutate()} disabled={revert.isPending}>
                <RotateCcw className="h-3.5 w-3.5" />Revert
              </Button>
            )}
            <Button size="sm" className={cn("gap-1.5", PRIMARY_BTN)} onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
              <Save className="h-3.5 w-3.5" />
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </Toolbar>
        }
      >
        {template.missingVariables.length > 0 && (
          <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2.5 text-xs text-foreground">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
            <span className="min-w-0">Your version does not use: {template.missingVariables.map((v) => `{{${v}}}`).join(", ")} — the shipped body does.</span>
          </p>
        )}

        <div className="grid min-w-0 gap-5 xl:grid-cols-2">
          <div className="grid min-w-0 gap-4">
            <Field label="Subject" htmlFor="pt-subject">
              <Input id="pt-subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
            </Field>
            <Field label="Body (HTML)" htmlFor="pt-body">
              <Textarea id="pt-body" value={body} onChange={(e) => setBody(e.target.value)} className="min-h-[360px] font-mono text-xs leading-relaxed" spellCheck={false} />
            </Field>
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <Variable className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              {template.variables.map((v) => (
                <button
                  key={v}
                  type="button"
                  className={VAR_CHIP}
                  title="Copy"
                  onClick={() => {
                    navigator.clipboard?.writeText(`{{${v}}}`).catch(() => undefined);
                    toast.success(`{{${v}}} copied`);
                  }}
                >
                  {`{{${v}}}`}
                </button>
              ))}
            </div>
          </div>
          <Field
            label={
              <span className="flex items-center gap-1.5">
                <Eye className="h-3.5 w-3.5" />Preview, with sample values
              </span>
            }
          >
            {/* The Subject strip and the frame share one bordered, clipped box: the strip is part of
                the rendered message, not a caption floating above it. */}
            <div className="min-w-0 overflow-hidden rounded-lg border border-border bg-card">
              <div className="truncate border-b border-border bg-muted/60 px-3 py-2 text-sm text-foreground">
                <span className="text-muted-foreground">Subject: </span>
                {preview?.subject ?? "…"}
              </div>
              {/* `bg-white` is deliberate and the one hard-coded colour here: this is an EMAIL, and
                  every client renders it on white — a themed backdrop would misreport the design. */}
              {preview ? <iframe title="Email preview" sandbox="" srcDoc={preview.html} className={cn(PREVIEW_FRAME, "block bg-white")} /> : <Skeleton className={cn(PREVIEW_FRAME, "rounded-none")} />}
            </div>
          </Field>
        </div>

        <div className="grid min-w-0 gap-2">
          <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <History className="h-4 w-4 shrink-0 text-muted-foreground" />Recent sends of this template
          </p>
          {log.data && log.data.length === 0 && <p className="text-sm text-muted-foreground">None yet.</p>}
          {log.data && log.data.length > 0 && <LogTable rows={log.data} compact />}
        </div>
      </ConsoleSection>

      <Dialog open={testOpen} onOpenChange={setTestOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send a test of {template.key}</DialogTitle>
            <DialogDescription>Rendered with the sample values, through the platform relay. Filed in the log as a test — never counted as a delivery.</DialogDescription>
          </DialogHeader>
          <Field label="Send to" htmlFor="pt-test-to">
            <Input id="pt-test-to" type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@example.com" />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTestOpen(false)}>
              Cancel
            </Button>
            <Button className={cn("gap-1.5", PRIMARY_BTN)} disabled={!testTo.includes("@") || test.isPending} onClick={() => test.mutate()}>
              <TestTube2 className="h-3.5 w-3.5" />
              {test.isPending ? "Sending…" : "Send test"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/* ----------------------------------------------------------------------------------------- */
/* Log                                                                                       */
/* ----------------------------------------------------------------------------------------- */

function LogTable({ rows, compact = false }: { rows: PlatformEmailLogRow[]; compact?: boolean }) {
  const queryClient = useQueryClient();
  const [viewing, setViewing] = useState<string | null>(null);
  const entry = useQuery({ queryKey: ["platform-admin", "email-log-entry", viewing], queryFn: () => platformAdminConsoleApi.emailLogEntry(viewing!), enabled: Boolean(viewing) });
  const resend = useMutation({
    mutationFn: (id: string) => platformAdminConsoleApi.resendEmail(id),
    onSuccess: () => {
      toast.success("Resent");
      queryClient.invalidateQueries({ queryKey: ["platform-admin"] });
    },
    onError: (e) => toast.error("Resend NOT delivered", { description: errorMessageOf(e) })
  });
  return (
    <>
      {/* Honest minimums: six real columns compact, seven with the template key. Below them the
          table scrolls inside its own box — the alternative the browser picks is wrapping the
          workspace and stage cells to three lines each, which is what this replaces. */}
      <ConsoleTable minWidth={compact ? 820 : 980}>
        <TableHeader>
          <TableRow>
            <TableHead>When</TableHead>
            {!compact && <TableHead>Template</TableHead>}
            <TableHead>To</TableHead>
            <TableHead>Workspace</TableHead>
            <TableHead>Stage</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id}>
              <TableCell className="whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground">{shortDateTime(r.createdAt)}</TableCell>
              {!compact && <TableCell className="whitespace-nowrap font-mono text-xs">{r.templateKey}</TableCell>}
              <TableCell className="max-w-[220px] truncate text-sm">{r.to}</TableCell>
              <TableCell className="max-w-[260px] truncate whitespace-nowrap text-xs text-muted-foreground" title={r.organization ? `${r.organization.name} · ${r.organization.slug}` : undefined}>
                {r.organization ? `${r.organization.name} · ${r.organization.slug}` : "—"}
              </TableCell>
              <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{r.dayMarker ? (MARKER_LABEL[r.dayMarker] ?? r.dayMarker) : r.isTest ? "test" : "—"}</TableCell>
              <TableCell>
                <span className="flex flex-col gap-0.5">
                  <Badge variant={STATUS_VARIANT[r.status]}>{r.status}</Badge>
                  {r.errorMessage && (
                    <span className="max-w-[260px] truncate text-[11px] text-destructive" title={r.errorMessage}>
                      {r.errorMessage}
                    </span>
                  )}
                </span>
              </TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-1.5">
                  <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setViewing(r.id)} aria-label="View">
                    <Eye className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => resend.mutate(r.id)} disabled={resend.isPending} aria-label="Resend">
                    <RotateCcw className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </ConsoleTable>
      <Dialog open={Boolean(viewing)} onOpenChange={(open) => !open && setViewing(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{entry.data?.subject ?? "Email"}</DialogTitle>
            <DialogDescription>
              {entry.data ? `${entry.data.templateKey} → ${entry.data.to} · ${entry.data.status} · ${shortDateTime(entry.data.createdAt)}` : "Loading…"}
            </DialogDescription>
          </DialogHeader>
          {entry.data?.html ? (
            <iframe title="Sent email" sandbox="" srcDoc={entry.data.html} className="h-[380px] w-full rounded-md border border-border bg-white sm:h-[520px]" />
          ) : (
            <Skeleton className="h-[380px] w-full sm:h-[520px]" />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

/* ----------------------------------------------------------------------------------------- */
/* Page                                                                                      */
/* ----------------------------------------------------------------------------------------- */

export function PlatformAdminEmails() {
  const templates = useQuery({ queryKey: ["platform-admin", "email-templates"], queryFn: platformAdminConsoleApi.emailTemplates });
  // The window is state, so the picker can move it. The query key carries it, so React Query
  // caches each window separately instead of showing the previous one while the new one loads.
  const [range, setRange] = useState<{ from?: string; to?: string }>({});
  const analytics = useQuery({
    queryKey: ["platform-admin", "email-analytics", range.from ?? "", range.to ?? ""],
    queryFn: () => platformAdminConsoleApi.emailAnalytics(range)
  });
  const [status, setStatus] = useState<string>("all");
  const log = useQuery({ queryKey: ["platform-admin", "email-log", status], queryFn: () => platformAdminConsoleApi.emailLog({ status: status === "all" ? undefined : status, limit: 100 }) });
  const [selected, setSelected] = useState<string | null>(null);
  const current = templates.data?.find((t) => t.key === selected) ?? templates.data?.[0] ?? null;

  return (
    <ConsolePage eyebrow="Growth" title="Platform emails" description="What the platform itself sends — the trial retention programme, the signup code, the relay test. Edit the words, preview them with real-looking values, send yourself a test, and see every delivery.">
      {/* `min-w-0` all the way down: a grid item defaults to `min-width:auto`, so one wide table or
          a long mono string inside a panel would push the whole page sideways instead of scrolling. */}
      <Tabs defaultValue="templates" className="grid min-w-0 gap-4">
        <TabsList className="w-fit">
          <TabsTrigger value="templates" className="gap-1.5">
            <Mails className="h-3.5 w-3.5" />Templates
          </TabsTrigger>
          <TabsTrigger value="analytics" className="gap-1.5">
            <MailCheck className="h-3.5 w-3.5" />Analytics
          </TabsTrigger>
          <TabsTrigger value="log" className="gap-1.5">
            <History className="h-3.5 w-3.5" />Delivery log
          </TabsTrigger>
        </TabsList>

        <TabsContent value="templates" className="min-w-0">
          {templates.isLoading && <Skeleton className="h-96 w-full" />}
          {templates.data && (
            <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
              <ConsoleSection title="Templates" className="min-w-0">
                <TemplateList rows={templates.data} selected={current?.key ?? null} onSelect={setSelected} />
              </ConsoleSection>
              {current ? (
                <TemplateEditor key={current.key} template={current} />
              ) : (
                <ConsoleSection title="Template" className="min-w-0">
                  <EmptyState title="Pick a template" />
                </ConsoleSection>
              )}
            </div>
          )}
        </TabsContent>

        <TabsContent value="analytics" className="min-w-0">
          {analytics.isLoading && <Skeleton className="h-96 w-full" />}
          {analytics.data && (
            <div className="grid min-w-0 gap-6">
              <ConsoleSection
                title="The window"
                description={`Measuring ${shortDate(analytics.data.from)} to ${shortDate(analytics.data.to)} — ${analytics.data.windowDays} days. Test sends are counted separately and never move a rate.`}
                actions={
                  <Toolbar>
                    <SegmentedControl
                      ariaLabel="Analytics window"
                      value={presetOf(range)}
                      onChange={(v) => setRange(rangeForPreset(v))}
                      options={[
                        { value: "7", label: "7 days" },
                        { value: "30", label: "30 days" },
                        { value: "90", label: "90 days" }
                      ]}
                    />
                  </Toolbar>
                }
                bodyClassName="grid gap-4"
              >
                <KpiGrid>
                  <KpiCard label="Delivered" value={analytics.data.totals.sent} icon={MailCheck} tone="success" hint={rateHint(analytics.data.totals.successRate)} />
                  <KpiCard label="Failed" value={analytics.data.totals.failed} icon={MailX} tone={analytics.data.totals.failed > 0 ? "destructive" : "default"} delay={0.05} />
                  <KpiCard label="Skipped (no relay)" value={analytics.data.totals.skipped} icon={AlertTriangle} tone={analytics.data.totals.skipped > 0 ? "warning" : "default"} delay={0.1} hint="Never counted as a failure — nothing tried to deliver them." />
                  <KpiCard label="Test sends" value={analytics.data.totals.test} icon={TestTube2} delay={0.15} hint="Excluded from every rate and chart below." />
                </KpiGrid>
              </ConsoleSection>

              <ConsoleSection title="Deliveries per day" description="Delivered against failed, every day of the window — a flat line where you expected mail is the signal.">
                <div className="h-56 w-full min-w-0">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={analytics.data.perDay} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                      <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
                      <XAxis
                        dataKey="day"
                        tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                        tickFormatter={(d: string) => d.slice(5)}
                        interval={Math.max(0, Math.floor(analytics.data.perDay.length / 7) - 1)}
                        axisLine={false}
                        tickLine={false}
                      />
                      <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} />
                      <RTooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: "hsl(var(--muted))" }} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="sent" name="Delivered" stackId="a" fill="hsl(var(--success))" />
                      <Bar dataKey="failed" name="Failed" stackId="a" fill="hsl(var(--destructive))" />
                      <Bar dataKey="skipped" name="Skipped" stackId="a" fill="hsl(var(--muted-foreground))" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </ConsoleSection>

              <ConsoleSection
                title="Per template"
                description="Which message this was, and whether it is getting through. A template with a rate below the platform's own is a wording or a sender problem, not a recipient one."
                flush
              >
                <ConsoleTable minWidth={760} className="rounded-none border-x-0 border-b-0">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Template</TableHead>
                      <TableHead>Group</TableHead>
                      <TableHead className="text-right">Delivered</TableHead>
                      <TableHead className="text-right">Failed</TableHead>
                      <TableHead className="text-right">Skipped</TableHead>
                      <TableHead className="text-right">Rate</TableHead>
                      <TableHead className="text-right">Last sent</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {analytics.data.perTemplate.map((t) => (
                      <TableRow key={t.key}>
                        <TableCell className="whitespace-nowrap font-mono text-xs">{t.key}</TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{t.group}</TableCell>
                        <Num>{t.sent}</Num>
                        <Num className={cn(t.failed > 0 && "text-destructive")}>{t.failed}</Num>
                        <Num className={cn(t.skipped > 0 && "text-warning")}>{t.skipped}</Num>
                        <Num>
                          <RateBadge rate={t.successRate} />
                        </Num>
                        <Num className="text-muted-foreground">{t.lastSentAt ? shortDate(t.lastSentAt) : "—"}</Num>
                      </TableRow>
                    ))}
                  </TableBody>
                </ConsoleTable>
              </ConsoleSection>

              <ConsoleSection
                title="Per recipient domain"
                description={
                  analytics.data.domainsTruncated
                    ? "The busiest 25 domains in the window. A domain that fails as a block is throttling or rejecting us, not receiving badly-addressed mail."
                    : "Every domain in the window. A domain that fails as a block is throttling or rejecting us, not receiving badly-addressed mail."
                }
                flush
              >
                {analytics.data.perDomain.length === 0 ? (
                  <div className="p-5">
                    <EmptyState title="No mail in this window" description="Widen the window, or send a test from Platform settings." />
                  </div>
                ) : (
                  <ConsoleTable minWidth={720} className="rounded-none border-x-0 border-b-0">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Domain</TableHead>
                        <TableHead className="text-right">Delivered</TableHead>
                        <TableHead className="text-right">Failed</TableHead>
                        <TableHead className="text-right">Rate</TableHead>
                        <TableHead>Top reason it failed</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {analytics.data.perDomain.map((d) => (
                        <TableRow key={d.domain}>
                          <TableCell className="whitespace-nowrap font-mono text-xs">{d.domain}</TableCell>
                          <Num>{d.sent}</Num>
                          <Num className={cn(d.failed > 0 && "text-destructive")}>{d.failed}</Num>
                          <Num>
                            <RateBadge rate={d.successRate} />
                          </Num>
                          <TableCell className="max-w-[22rem] text-xs text-muted-foreground">
                            {d.topFailures.length === 0 ? "—" : <span className="line-clamp-2 break-words">{d.topFailures[0].reason}{d.topFailures[0].count > 1 && ` (×${d.topFailures[0].count})`}</span>}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </ConsoleTable>
                )}
              </ConsoleSection>

              <ConsoleSection
                title="Per workspace"
                description="What each tenant has actually been sent, and which retention stages have reached them. A workspace with failures here is one that will not have heard the notice before its deletion date."
                flush
              >
                {analytics.data.perTenant.length === 0 ? (
                  <div className="p-5">
                    <EmptyState title="No workspace mail in this window" />
                  </div>
                ) : (
                  <ConsoleTable minWidth={820} className="rounded-none border-x-0 border-b-0">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Workspace</TableHead>
                        <TableHead>Stages reached</TableHead>
                        <TableHead className="text-right">Delivered</TableHead>
                        <TableHead className="text-right">Failed</TableHead>
                        <TableHead className="text-right">Rate</TableHead>
                        <TableHead className="text-right">Last sent</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {analytics.data.perTenant.map((t) => (
                        <TableRow key={t.organizationId ?? t.name}>
                          <TableCell className="max-w-[18rem]">
                            <span className="block truncate font-medium text-foreground">{t.name}</span>
                            <span className="flex flex-wrap items-center gap-1.5">
                              {t.slug && <span className="truncate font-mono text-[11px] text-muted-foreground">{t.slug}</span>}
                              {t.status && <OrgStatusPill status={t.status} />}
                            </span>
                          </TableCell>
                          <TableCell className="max-w-[16rem]">
                            {t.markers.length === 0 ? (
                              <span className="text-xs text-muted-foreground">—</span>
                            ) : (
                              <span className="flex flex-wrap gap-1">
                                {t.markers.map((m) => (
                                  <Badge key={m} variant="muted" className="font-normal">
                                    {MARKER_LABEL[m] ?? m}
                                  </Badge>
                                ))}
                              </span>
                            )}
                          </TableCell>
                          <Num>{t.sent}</Num>
                          <Num className={cn(t.failed > 0 && "text-destructive")}>{t.failed}</Num>
                          <Num>
                            <RateBadge rate={t.successRate} />
                          </Num>
                          <Num className="text-muted-foreground">{t.lastSentAt ? shortDate(t.lastSentAt) : "—"}</Num>
                        </TableRow>
                      ))}
                    </TableBody>
                  </ConsoleTable>
                )}
              </ConsoleSection>

              <ConsoleSection title="Why deliveries failed" description="Grouped by the shape of the error, newest occurrence first — twelve bounces from one cause are one line.">
                {analytics.data.failureReasons.length === 0 ? (
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />No failures in this window.
                  </p>
                ) : (
                  <ul className="grid min-w-0 gap-2.5 text-sm">
                    {analytics.data.failureReasons.map((f) => (
                      <li key={f.reason} className="flex items-start justify-between gap-3 border-b border-border pb-2.5 last:border-0 last:pb-0">
                        <span className="min-w-0 break-words text-foreground">
                          {f.reason}
                          <span className="mt-0.5 block text-xs text-muted-foreground">last {shortDateTime(f.lastAt)}</span>
                        </span>
                        <span className="shrink-0 font-mono tabular-nums text-muted-foreground">{f.count}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </ConsoleSection>
            </div>
          )}
        </TabsContent>

        <TabsContent value="log" className="min-w-0">
          <ConsoleSection
            title="Delivery log"
            description="Every platform email, newest first. View the message as it went, or send it again exactly as it was."
            actions={
              <Toolbar>
                <Select value={status} onValueChange={setStatus}>
                  <SelectTrigger className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    <SelectItem value="SENT">Sent</SelectItem>
                    <SelectItem value="FAILED">Failed</SelectItem>
                    <SelectItem value="SKIPPED">Skipped</SelectItem>
                  </SelectContent>
                </Select>
              </Toolbar>
            }
          >
            {log.isLoading && <Skeleton className="h-64 w-full" />}
            {log.data && log.data.length === 0 && <EmptyState title="Nothing in the log" description="Retention emails, signup codes and test sends will appear here." />}
            {log.data && log.data.length > 0 && <LogTable rows={log.data} />}
          </ConsoleSection>
        </TabsContent>
      </Tabs>
    </ConsolePage>
  );
}
