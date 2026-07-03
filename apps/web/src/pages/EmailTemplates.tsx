import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Eye,
  History as HistoryIcon,
  Loader2,
  Mail,
  Mails,
  PencilLine,
  RotateCcw,
  Save,
  Send,
  ServerCog,
  Variable
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
import { Separator } from "../components/ui/separator";
import { Skeleton } from "../components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { Textarea } from "../components/ui/textarea";
import { toast } from "../components/ui/toaster";
import { emailTemplateApi, type EmailLogRow, type EmailTemplateRow } from "../services/api";
import { safeHtml } from "../lib/safe-html";
import { useAuthStore } from "../store/auth";

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

export function EmailTemplatesPage() {
  const templates = useQuery({ queryKey: ["email-templates"], queryFn: emailTemplateApi.list });
  const transport = useQuery({
    queryKey: ["email-templates", "transport-status"],
    queryFn: emailTemplateApi.transportStatus,
    refetchInterval: 30_000
  });
  const [editing, setEditing] = useState<EmailTemplateRow | null>(null);

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

      <Card>
        <CardContent className="p-0">
          {templates.isLoading &&
            Array.from({ length: 5 }).map((_, i) => (
              <div key={`s-${i}`} className="flex items-center gap-3 border-b border-border p-4 last:border-0">
                <Skeleton className="h-8 w-8 rounded-md" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-1/3" />
                  <Skeleton className="h-3 w-2/3" />
                </div>
                <Skeleton className="h-6 w-16" />
              </div>
            ))}
          {!templates.isLoading &&
            (templates.data ?? []).map((row) => (
              <button
                key={row.key}
                type="button"
                onClick={() => setEditing(row)}
                className="flex w-full items-center gap-4 border-b border-border p-4 text-left transition hover:bg-muted/40 last:border-0"
              >
                <div className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                  <Mail className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold tracking-tight">{row.key}</p>
                    {row.hasOverride ? (
                      <Badge variant="info" className="gap-1"><PencilLine className="h-3 w-3" />Customized</Badge>
                    ) : (
                      <Badge variant="muted">Defaults</Badge>
                    )}
                    {!row.enabled && <Badge variant="warning">Disabled</Badge>}
                  </div>
                  <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{row.description}</p>
                  <p className="mt-1 hidden text-xs text-muted-foreground sm:block">
                    Variables: {row.variables.map((v) => `{{${v}}}`).join(" · ")}
                  </p>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              </button>
            ))}
        </CardContent>
      </Card>

      <EditorDialog template={editing} onClose={() => setEditing(null)} />
    </div>
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
          The API server has no <code className="rounded bg-background/40 px-1">SMTP_HOST</code> set. Every "Send test" is logged as <Badge variant="destructive">FAILED</Badge> and never leaves the box. Add
          <code className="rounded bg-background/40 px-1">SMTP_HOST</code>,
          <code className="rounded bg-background/40 px-1">SMTP_PORT</code>,
          <code className="rounded bg-background/40 px-1">SMTP_USER</code>,
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
    setSubject(template.subject ?? defaultSubject(template));
    setBody(template.bodyHtml ?? FALLBACK_DEFAULT);
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
                          navigator.clipboard?.writeText(`{{${v}}}`);
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

function defaultSubject(template: EmailTemplateRow): string {
  const map: Record<string, string> = {
    welcome: "Welcome to TimeSphere",
    reset: "Reset your TimeSphere password",
    "timesheet.submitted": "Timesheet submitted",
    "timesheet.approved": "Your timesheet was approved",
    "timesheet.rejected": "Timesheet rejected — action required",
    "sla.breach": "[SLA breach] Approve {{employeeName}}'s timesheet",
    escalation: "[Escalation] Approve {{employeeName}}'s timesheet",
    "deadline.reminder": "{{daysLeft}} day(s) left to submit timesheets"
  };
  return map[template.key] ?? `TimeSphere — ${template.key}`;
}
