/**
 * Platform emails — the messages the DEPLOYMENT sends (the retention programme, the signup code,
 * the relay test), as opposed to what a workspace sends. Same three-part shape as the workspace
 * Email Templates page so an operator who knows one knows the other: an editor with a live
 * preview and a test send, the delivery analytics, and the log with a resend button.
 *
 * The preview is rendered by the SERVER (`/email-templates/:key/preview`) from the unsaved draft,
 * so what the operator sees is exactly what `{{vars}}` substitution and sanitisation will produce
 * — the client never has a second, drifting renderer.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Eye, History, MailCheck, MailX, Mails, RotateCcw, Save, Send, TestTube2, Variable } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Skeleton } from "../../components/ui/skeleton";
import { Switch } from "../../components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { Textarea } from "../../components/ui/textarea";
import { toast } from "../../components/ui/toaster";
import { cn } from "../../lib/utils";
import { platformAdminConsoleApi, type PlatformEmailLogRow, type PlatformEmailTemplateRow } from "../../services/platform-admin-api";
import { ConsolePage, ConsoleSection, EmptyState, KpiCard, MARKER_LABEL, shortDateTime } from "./console-ui";

const STATUS_VARIANT: Record<PlatformEmailLogRow["status"], "success" | "destructive" | "warning"> = { SENT: "success", FAILED: "destructive", SKIPPED: "warning" };

function errorMessageOf(error: unknown): string | undefined {
  return (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
}

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
    <div className="grid gap-4">
      {groups.map(([group, items]) => (
        <div key={group} className="grid gap-1">
          <p className="px-2 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{group}</p>
          {items.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => onSelect(t.key)}
              className={cn(
                "flex w-full items-start justify-between gap-2 rounded-lg border px-3 py-2 text-left transition-colors",
                selected === t.key ? "border-accent/60 bg-accent/10" : "border-transparent hover:bg-muted"
              )}
            >
              <span className="min-w-0">
                <span className="block truncate font-mono text-xs text-foreground">{t.key}</span>
                <span className="block truncate text-xs text-muted-foreground">{t.description}</span>
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
    <div className="grid gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-sm text-foreground">{template.key}</p>
          <p className="text-sm text-muted-foreground">{template.description}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Switch checked={enabled} onCheckedChange={setEnabled} /> {enabled ? "Override on" : "Override off"}
          </label>
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setTestOpen(true)}>
            <Send className="h-3.5 w-3.5" />Send test
          </Button>
          {template.hasOverride && (
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => revert.mutate()} disabled={revert.isPending}>
              <RotateCcw className="h-3.5 w-3.5" />Revert
            </Button>
          )}
          <Button size="sm" className="gap-1.5 bg-accent text-accent-foreground hover:bg-accent/90" onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
            <Save className="h-3.5 w-3.5" />
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>

      {template.missingVariables.length > 0 && (
        <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2.5 text-xs text-foreground">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
          Your version does not use: {template.missingVariables.map((v) => `{{${v}}}`).join(", ")} — the shipped body does.
        </p>
      )}

      <div className="grid gap-5 xl:grid-cols-2">
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="pt-subject">Subject</Label>
            <Input id="pt-subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="pt-body">Body (HTML)</Label>
            <Textarea id="pt-body" value={body} onChange={(e) => setBody(e.target.value)} className="min-h-[360px] font-mono text-xs leading-relaxed" spellCheck={false} />
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Variable className="h-3.5 w-3.5 text-muted-foreground" />
            {template.variables.map((v) => (
              <button
                key={v}
                type="button"
                className="rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground hover:border-accent"
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
        <div className="grid gap-1.5">
          <Label className="flex items-center gap-1.5">
            <Eye className="h-3.5 w-3.5" />Preview, with sample values
          </Label>
          <div className="overflow-hidden rounded-lg border border-border bg-white">
            <div className="border-b border-border bg-muted/60 px-3 py-2 text-sm text-foreground">
              <span className="text-muted-foreground">Subject: </span>
              {preview?.subject ?? "…"}
            </div>
            {preview ? (
              <iframe title="Email preview" sandbox="" srcDoc={preview.html} className="h-[420px] w-full bg-white" />
            ) : (
              <Skeleton className="h-[420px] w-full" />
            )}
          </div>
        </div>
      </div>

      <div className="grid gap-2">
        <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <History className="h-4 w-4 text-muted-foreground" />Recent sends of this template
        </p>
        {log.data && log.data.length === 0 && <p className="text-sm text-muted-foreground">None yet.</p>}
        {log.data && log.data.length > 0 && <LogTable rows={log.data} compact />}
      </div>

      <Dialog open={testOpen} onOpenChange={setTestOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send a test of {template.key}</DialogTitle>
            <DialogDescription>Rendered with the sample values, through the platform relay. Filed in the log as a test — never counted as a delivery.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="pt-test-to">Send to</Label>
            <Input id="pt-test-to" type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@example.com" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTestOpen(false)}>
              Cancel
            </Button>
            <Button className="gap-1.5 bg-accent text-accent-foreground hover:bg-accent/90" disabled={!testTo.includes("@") || test.isPending} onClick={() => test.mutate()}>
              <TestTube2 className="h-3.5 w-3.5" />
              {test.isPending ? "Sending…" : "Send test"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
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
      <div className="overflow-x-auto rounded-lg border border-border">
        <Table>
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
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{shortDateTime(r.createdAt)}</TableCell>
                {!compact && <TableCell className="font-mono text-xs">{r.templateKey}</TableCell>}
                <TableCell className="max-w-[220px] truncate text-sm">{r.to}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{r.organization ? `${r.organization.name} · ${r.organization.slug}` : "—"}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{r.dayMarker ? (MARKER_LABEL[r.dayMarker] ?? r.dayMarker) : r.isTest ? "test" : "—"}</TableCell>
                <TableCell>
                  <span className="flex flex-col gap-0.5">
                    <Badge variant={STATUS_VARIANT[r.status]}>{r.status}</Badge>
                    {r.errorMessage && <span className="max-w-[260px] truncate text-[11px] text-destructive" title={r.errorMessage}>{r.errorMessage}</span>}
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
        </Table>
      </div>
      <Dialog open={Boolean(viewing)} onOpenChange={(open) => !open && setViewing(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{entry.data?.subject ?? "Email"}</DialogTitle>
            <DialogDescription>
              {entry.data ? `${entry.data.templateKey} → ${entry.data.to} · ${entry.data.status} · ${shortDateTime(entry.data.createdAt)}` : "Loading…"}
            </DialogDescription>
          </DialogHeader>
          {entry.data?.html ? <iframe title="Sent email" sandbox="" srcDoc={entry.data.html} className="h-[520px] w-full rounded-md border border-border bg-white" /> : <Skeleton className="h-[520px] w-full" />}
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
  const analytics = useQuery({ queryKey: ["platform-admin", "email-analytics"], queryFn: platformAdminConsoleApi.emailAnalytics });
  const [status, setStatus] = useState<string>("all");
  const log = useQuery({ queryKey: ["platform-admin", "email-log", status], queryFn: () => platformAdminConsoleApi.emailLog({ status: status === "all" ? undefined : status, limit: 100 }) });
  const [selected, setSelected] = useState<string | null>(null);
  const current = templates.data?.find((t) => t.key === selected) ?? templates.data?.[0] ?? null;

  return (
    <ConsolePage eyebrow="Growth" title="Platform emails" description="What the platform itself sends — the trial retention programme, the signup code, the relay test. Edit the words, preview them with real-looking values, send yourself a test, and see every delivery.">
      <Tabs defaultValue="templates" className="grid gap-4">
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

        <TabsContent value="templates">
          {templates.isLoading && <Skeleton className="h-96 w-full" />}
          {templates.data && (
            <div className="grid gap-5 lg:grid-cols-[300px_minmax(0,1fr)]">
              <div className="rounded-xl border border-border bg-card p-3 shadow-sm">
                <TemplateList rows={templates.data} selected={current?.key ?? null} onSelect={setSelected} />
              </div>
              <div className="rounded-xl border border-border bg-card p-5 shadow-sm">{current ? <TemplateEditor key={current.key} template={current} /> : <EmptyState title="Pick a template" />}</div>
            </div>
          )}
        </TabsContent>

        <TabsContent value="analytics">
          {analytics.isLoading && <Skeleton className="h-96 w-full" />}
          {analytics.data && (
            <div className="grid gap-5">
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <KpiCard label={`Sent, ${analytics.data.windowDays} days`} value={analytics.data.totals.sent} icon={MailCheck} tone="success" />
                <KpiCard label="Failed" value={analytics.data.totals.failed} icon={MailX} tone={analytics.data.totals.failed > 0 ? "destructive" : "default"} delay={0.05} />
                <KpiCard label="Skipped (no relay)" value={analytics.data.totals.skipped} icon={AlertTriangle} tone={analytics.data.totals.skipped > 0 ? "warning" : "default"} delay={0.1} />
                <KpiCard label="Test sends" value={analytics.data.totals.test} icon={TestTube2} delay={0.15} />
              </div>
              <ConsoleSection title="Deliveries per day" description="Sent against failed, every day of the window — a flat line where you expected mail is the signal.">
                <div className="h-56 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={analytics.data.perDay} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                      <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
                      <XAxis dataKey="day" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickFormatter={(d: string) => d.slice(5)} interval={13} axisLine={false} tickLine={false} />
                      <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} />
                      <RTooltip contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12, color: "hsl(var(--popover-foreground))" }} cursor={{ fill: "hsl(var(--muted))" }} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="sent" stackId="a" fill="hsl(var(--success))" radius={[0, 0, 0, 0]} />
                      <Bar dataKey="failed" stackId="a" fill="hsl(var(--destructive))" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </ConsoleSection>
              <div className="grid gap-5 lg:grid-cols-3">
                <ConsoleSection title="Per template" className="lg:col-span-2">
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Template</TableHead>
                          <TableHead className="text-right">Sent</TableHead>
                          <TableHead className="text-right">Failed</TableHead>
                          <TableHead className="text-right">Skipped</TableHead>
                          <TableHead className="text-right">Tests</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {analytics.data.perTemplate.map((t) => (
                          <TableRow key={t.key}>
                            <TableCell>
                              <span className="font-mono text-xs">{t.key}</span>
                              <span className="ml-2 text-[11px] text-muted-foreground">{t.group}</span>
                            </TableCell>
                            <TableCell className="text-right font-mono tabular-nums">{t.sent}</TableCell>
                            <TableCell className={cn("text-right font-mono tabular-nums", t.failed > 0 && "text-destructive")}>{t.failed}</TableCell>
                            <TableCell className={cn("text-right font-mono tabular-nums", t.skipped > 0 && "text-warning")}>{t.skipped}</TableCell>
                            <TableCell className="text-right font-mono tabular-nums text-muted-foreground">{t.test}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </ConsoleSection>
                <ConsoleSection title="Why deliveries failed">
                  {analytics.data.failureReasons.length === 0 ? (
                    <p className="flex items-center gap-2 text-sm text-muted-foreground">
                      <CheckCircle2 className="h-4 w-4 text-success" />No failures in the window.
                    </p>
                  ) : (
                    <ul className="grid gap-2 text-sm">
                      {analytics.data.failureReasons.map((f) => (
                        <li key={f.reason} className="flex items-start justify-between gap-3">
                          <span className="min-w-0 break-words text-foreground">{f.reason}</span>
                          <span className="shrink-0 font-mono tabular-nums text-muted-foreground">{f.count}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </ConsoleSection>
              </div>
            </div>
          )}
        </TabsContent>

        <TabsContent value="log">
          <ConsoleSection
            title="Delivery log"
            description="Every platform email, newest first. View the message as it went, or send it again exactly as it was."
            actions={
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
