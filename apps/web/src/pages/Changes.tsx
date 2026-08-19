/**
 * WHAT: the change-management surface — the queue, the metric cards above it, raising a change, and
 * the detail panel where a change is edited, moved through its lifecycle and approved.
 *
 * WHY IT IS ITS OWN PAGE RATHER THAN A TICKET FILTER: a change request IS a ticket underneath (see
 * `ChangeRequest`'s schema comment), but the questions asked of it are different ones — what is the
 * risk, is there a way back, when is the window, who still has to sign off. Those need their own
 * columns and their own actions, and burying them behind a type filter on the Tickets page would
 * have meant a ticket table with eight columns nobody reading tickets wants.
 *
 * WHAT IS DELIBERATELY NOT HERE: comments, attachments, watchers and the activity trail. They live
 * on the ticket half and already have a home in the ticket sheet, which this page links to. Building
 * second copies is how two surfaces start disagreeing about the same conversation.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  changeBands,
  changeKinds,
  changeStateTransitions,
  permissions,
  type ChangeBand,
  type ChangeKind,
  type ChangeState
} from "@timesheet/shared";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  Flame,
  GitPullRequestArrow,
  CalendarDays,
  Download,
  Loader2,
  Plus,
  ShieldCheck,
} from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import {
  CHANGE_KIND_TONE,
  CHANGE_RISK_TONE,
  CHANGE_STATE_TONE,
  humanizeChange
} from "../lib/change-visuals";
import { TONE_ACCENT_CLASS, type Tone } from "../lib/ticket-visuals";
import { cn } from "../lib/utils";
import { changeApi, projectApi, type ChangeMetrics } from "../services/api";
import { useAuthStore } from "../store/auth";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { ChangeAnalytics } from "../components/change/ChangeAnalytics";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { SearchableSelect } from "../components/ui/searchable-select";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { Textarea } from "../components/ui/textarea";
import { toast } from "../components/ui/toaster";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";

const serverMessage = (err: any, fallback: string) => err?.response?.data?.message ?? fallback;

function formatWindow(start?: string | null, end?: string | null): string {
  if (!start) return "Not scheduled";
  const fmt = (v: string) => new Date(v).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return end ? `${fmt(start)} → ${fmt(end)}` : fmt(start);
}

/* ------------------------------------------------------------------ *
 * Metrics
 * ------------------------------------------------------------------ */

const METRIC_TONE_CLASS = {
  default: "text-primary",
  warning: "text-warning",
  destructive: "text-destructive",
  success: "text-success"
} as const;

function MetricTile({
  label,
  value,
  tone,
  icon,
  hint
}: {
  label: string;
  value: number;
  tone: "default" | "warning" | "destructive" | "success";
  icon: React.ReactNode;
  hint?: string;
}) {
  const toneClass = METRIC_TONE_CLASS[tone];
  return (
    <div className="rounded-xl border border-border bg-card p-3.5" title={hint}>
      <div className="flex items-center justify-between gap-2 text-muted-foreground">
        <p className="truncate text-[11px] font-semibold uppercase tracking-wide">{label}</p>
        <span className={cn("shrink-0 opacity-80", toneClass)}>{icon}</span>
      </div>
      <p className={cn("mt-1 text-2xl font-black tabular-nums tracking-tight", toneClass)}>{value}</p>
      {hint && <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">{hint}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Page
 * ------------------------------------------------------------------ */

export function Changes() {
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [filters, setFilters] = useState({ state: "all", changeKind: "all", riskLevel: "all", mine: false });
  const [createOpen, setCreateOpen] = useState(false);

  const canWrite = Boolean(user?.permissions.includes(permissions.CHANGES_WRITE));

  const settings = useQuery({ queryKey: ["changes", "settings"], queryFn: changeApi.settings.get });
  const enabled = Boolean(settings.data?.effective);

  const changes = useQuery({
    queryKey: ["changes", filters],
    queryFn: () =>
      changeApi.list({
        state: filters.state !== "all" ? filters.state : undefined,
        changeKind: filters.changeKind !== "all" ? filters.changeKind : undefined,
        riskLevel: filters.riskLevel !== "all" ? filters.riskLevel : undefined,
        mine: filters.mine || undefined
      }),
    enabled
  });
  const metrics = useQuery({ queryKey: ["changes", "metrics"], queryFn: changeApi.metrics, enabled });

  // A change is a twelve-section record, not a side panel. The sheet was right when it held six
  // fields; at this size it is a full page, and being a real route means a change can be linked to
  // from an approval email.
  function openChange(id: string) {
    navigate(`/app/changes/${id}`);
  }

  // The module is off — say which half is missing, because "ask your admin" and "upgrade your plan"
  // need different people to act. The API draws the same distinction; this mirrors it rather than
  // guessing.
  if (settings.isLoading) return <Skeleton className="h-64 w-full" />;
  if (!enabled) {
    const entitled = settings.data?.entitlements.changeManagementEnabled;
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ClipboardList className="h-4 w-4 text-primary" />
            Change management
          </CardTitle>
          <CardDescription>
            {entitled
              ? "This workspace has not switched change management on yet. A super admin can enable it in Workspace Settings → Change management."
              : "Change management is not included in this plan. Upgrade to Team or Enterprise to request, approve and review changes."}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const rows = changes.data ?? [];
  const m = metrics.data;

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-lg bg-primary/10 text-primary">
            <ClipboardList className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight">Change Management</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Request, assess, approve and review changes before they ship.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => navigate("/app/changes/calendar")}>
            <CalendarDays className="h-3.5 w-3.5" />
            Calendar
          </Button>
          <ExportMenu />
          {canWrite && (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              New change
            </Button>
          )}
        </div>
      </div>

      {m && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          <MetricTile label="In flight" value={m.inFlight} tone="default" icon={<GitPullRequestArrow className="h-4 w-4" />} hint="Submitted, not yet closed" />
          <MetricTile
            label="Waiting on you"
            value={m.awaitingMyDecision}
            tone={m.awaitingMyDecision > 0 ? "warning" : "default"}
            icon={<ShieldCheck className="h-4 w-4" />}
            hint="Approval steps assigned to you"
          />
          <MetricTile label="Awaiting approval" value={m.byState.AWAITING_APPROVAL ?? 0} tone="warning" icon={<AlertTriangle className="h-4 w-4" />} />
          <MetricTile label="High risk" value={m.byRisk.HIGH ?? 0} tone="destructive" icon={<Flame className="h-4 w-4" />} hint="Derived from impact × likelihood" />
          <MetricTile label="Closed" value={m.byState.CLOSED ?? 0} tone="success" icon={<CheckCircle2 className="h-4 w-4" />} />
        </div>
      )}

      {m && m.total > 0 && <ChangeAnalytics metrics={m} />}
      {m && m.total > 0 && <ChangeCharts metrics={m} />}

      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-6">
          <div className="grid w-full gap-1.5 sm:w-auto">
            <Label htmlFor="change-filter-state">State</Label>
            <Select value={filters.state} onValueChange={(v) => setFilters((f) => ({ ...f, state: v }))}>
              <SelectTrigger id="change-filter-state" className="w-full sm:w-[190px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All states</SelectItem>
                {(Object.keys(changeStateTransitions) as ChangeState[]).map((s) => (
                  <SelectItem key={s} value={s}>{humanizeChange(s)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid w-full gap-1.5 sm:w-auto">
            <Label htmlFor="change-filter-kind">Type</Label>
            <Select value={filters.changeKind} onValueChange={(v) => setFilters((f) => ({ ...f, changeKind: v }))}>
              <SelectTrigger id="change-filter-kind" className="w-full sm:w-[160px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                {changeKinds.map((k) => <SelectItem key={k} value={k}>{humanizeChange(k)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="grid w-full gap-1.5 sm:w-auto">
            <Label htmlFor="change-filter-risk">Risk</Label>
            <Select value={filters.riskLevel} onValueChange={(v) => setFilters((f) => ({ ...f, riskLevel: v }))}>
              <SelectTrigger id="change-filter-risk" className="w-full sm:w-[150px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All risk levels</SelectItem>
                {changeBands.map((b) => <SelectItem key={b} value={b}>{humanizeChange(b)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <Button
            variant={filters.mine ? "default" : "outline"}
            size="sm"
            className="h-10"
            onClick={() => setFilters((f) => ({ ...f, mine: !f.mine }))}
          >
            Mine
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {changes.isLoading && <Skeleton className="m-4 h-48" />}
          {!changes.isLoading && rows.length === 0 && (
            <div className="py-14 text-center text-sm text-muted-foreground">
              No changes match these filters.
            </div>
          )}
          {!changes.isLoading && rows.length > 0 && (
            <>
              <div className="hidden overflow-x-auto sm:block">
                <table className="w-full text-sm">
                  <thead className="text-left text-muted-foreground">
                    <tr className="border-b border-border">
                      <th className="p-3 text-[11px] font-semibold uppercase tracking-wide">Change</th>
                      <th className="p-3 text-[11px] font-semibold uppercase tracking-wide">Title</th>
                      <th className="p-3 text-[11px] font-semibold uppercase tracking-wide">Type</th>
                      <th className="p-3 text-[11px] font-semibold uppercase tracking-wide">Risk</th>
                      <th className="p-3 text-[11px] font-semibold uppercase tracking-wide">State</th>
                      <th className="p-3 text-[11px] font-semibold uppercase tracking-wide">Window</th>
                      <th className="p-3 text-[11px] font-semibold uppercase tracking-wide">Implementer</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr
                        key={row.id}
                        onClick={() => openChange(row.id)}
                        className="cursor-pointer border-b border-border transition last:border-b-0 hover:bg-muted/50"
                      >
                        <td className="p-3 font-mono text-xs text-muted-foreground">{row.changeKey}</td>
                        <td className="max-w-[320px] p-3">
                          <span className="block truncate font-medium">{row.ticket.title}</span>
                          <span className="text-xs text-muted-foreground">{row.ticket.project.name}</span>
                        </td>
                        <td className="p-3"><Badge variant={CHANGE_KIND_TONE[row.changeKind]}>{humanizeChange(row.changeKind)}</Badge></td>
                        <td className="p-3">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Badge variant={CHANGE_RISK_TONE[row.riskLevel]}>{humanizeChange(row.riskLevel)}</Badge>
                            </TooltipTrigger>
                            <TooltipContent>
                              Impact {humanizeChange(row.impact).toLowerCase()} × likelihood {humanizeChange(row.likelihood).toLowerCase()}
                            </TooltipContent>
                          </Tooltip>
                        </td>
                        <td className="p-3"><Badge variant={CHANGE_STATE_TONE[row.state]}>{humanizeChange(row.state)}</Badge></td>
                        <td className="p-3 text-xs text-muted-foreground">{formatWindow(row.plannedStart, row.plannedEnd)}</td>
                        <td className="p-3 text-sm">{row.ticket.assignee?.name ?? <span className="text-muted-foreground">Unassigned</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Stacked cards below `sm`, the same dual rendering the ticket list uses rather than
                  a horizontal scroll nobody discovers. */}
              <div className="grid gap-2 p-3 sm:hidden">
                {rows.map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    onClick={() => openChange(row.id)}
                    className="rounded-lg border border-border p-3 text-left transition hover:bg-muted/50"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs text-muted-foreground">{row.changeKey}</span>
                      <Badge variant={CHANGE_STATE_TONE[row.state]}>{humanizeChange(row.state)}</Badge>
                    </div>
                    <p className="mt-1 font-medium">{row.ticket.title}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <Badge variant={CHANGE_KIND_TONE[row.changeKind]}>{humanizeChange(row.changeKind)}</Badge>
                      <Badge variant={CHANGE_RISK_TONE[row.riskLevel]}>{humanizeChange(row.riskLevel)} risk</Badge>
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">{formatWindow(row.plannedStart, row.plannedEnd)}</p>
                  </button>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {createOpen && (
        <CreateChangeDialog
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => {
            queryClient.invalidateQueries({ queryKey: ["changes"] });
            setCreateOpen(false);
            openChange(id);
          }}
        />
      )}

    </div>
  );
}

/**
 * The register, downloaded.
 *
 * Fetched as an authenticated blob rather than linked: the access token lives in memory, so an
 * `<a href>` to the export route arrives with no Authorization header and is refused. The object URL
 * is revoked immediately after the click — leaking one per download keeps the whole file alive in
 * memory for the life of the tab.
 */
function ExportMenu() {
  const [busy, setBusy] = useState<"csv" | "xlsx" | "pdf" | null>(null);

  const run = async (format: "csv" | "xlsx" | "pdf") => {
    setBusy(format);
    try {
      const { blob, truncated, rowsIncluded } = await changeApi.download(format);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `changes-${new Date().toISOString().slice(0, 10)}.${format}`;
      anchor.click();
      URL.revokeObjectURL(url);
      // Warned at the moment of download. A partial export that looks complete is the failure the
      // row-count headers exist to prevent.
      if (truncated) {
        toast.warning("Export is capped", { description: `Only the first ${rowsIncluded} changes are included. Narrow the filters for a complete file.` });
      }
    } catch (err: any) {
      toast.error("Could not export", { description: serverMessage(err, "Try again.") });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex items-center gap-1 rounded-lg border border-border p-0.5">
      {(["csv", "xlsx", "pdf"] as const).map((format) => (
        <Button key={format} variant="ghost" size="sm" disabled={busy !== null} onClick={() => run(format)}>
          {busy === format ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          {format.toUpperCase()}
        </Button>
      ))}
    </div>
  );
}

/**
 * The three breakdowns a change manager reads (spec §30): where work is sitting, how risky it is, and
 * which environments it touches.
 *
 * Horizontal bars rather than pie charts: these are counts across a handful of named buckets, and a
 * pie makes two similar slices impossible to compare while burning far more space. The bars share one
 * scale per chart so the longest is the biggest — a per-bar scale would make every chart look full.
 */
function ChangeCharts({ metrics }: { metrics: ChangeMetrics }) {
  const charts: Array<{ title: string; hint: string; data: Array<{ label: string; value: number; tone: Tone }> }> = [
    {
      title: "By state",
      hint: "Where the register is sitting right now",
      data: (Object.keys(changeStateTransitions) as ChangeState[])
        .map((state) => ({ label: humanizeChange(state), value: metrics.byState[state] ?? 0, tone: CHANGE_STATE_TONE[state] as Tone }))
        .filter((d) => d.value > 0)
    },
    {
      title: "By risk",
      hint: "Derived from impact × likelihood, never typed",
      data: changeBands
        .map((b) => ({ label: humanizeChange(b), value: metrics.byRisk[b] ?? 0, tone: CHANGE_RISK_TONE[b] as Tone }))
        .filter((d) => d.value > 0)
    },
    {
      title: "By environment",
      hint: "Production is the one that carries the rules",
      data: Object.entries(metrics.byEnvironment ?? {})
        .map(([env, value]) => ({
          label: humanizeChange(env),
          value: value ?? 0,
          tone: (env === "PRODUCTION" ? "destructive" : "info") as Tone
        }))
        .filter((d) => d.value > 0)
    }
  ];

  return (
    <div className="grid gap-3 lg:grid-cols-3">
      {charts.map((chart) => {
        const max = Math.max(1, ...chart.data.map((d) => d.value));
        return (
          <Card key={chart.title}>
            <CardContent className="grid gap-2 p-3 sm:p-4">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{chart.title}</p>
                <p className="text-[10px] text-muted-foreground">{chart.hint}</p>
              </div>
              {chart.data.length === 0 ? (
                <p className="py-3 text-xs text-muted-foreground">Nothing yet.</p>
              ) : (
                <div className="grid gap-1.5">
                  {chart.data.map((d) => (
                    <div key={d.label} className="grid grid-cols-[92px_1fr_28px] items-center gap-2">
                      <span className="truncate text-xs text-muted-foreground">{d.label}</span>
                      <div className="h-2 overflow-hidden rounded-full bg-muted">
                        <div className={cn("h-full rounded-full", TONE_ACCENT_CLASS[d.tone])} style={{ width: `${(d.value / max) * 100}%` }} />
                      </div>
                      <span className="text-right text-xs font-semibold tabular-nums">{d.value}</span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Create
 * ------------------------------------------------------------------ */

function CreateChangeDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => projectApi.list() });
  const categories = useQuery({ queryKey: ["changes", "master-data"], queryFn: changeApi.masterData });

  const [form, setForm] = useState({
    title: "",
    projectId: "",
    categoryId: "",
    changeKind: "NORMAL" as ChangeKind,
    impact: "LOW" as ChangeBand,
    likelihood: "LOW" as ChangeBand,
    justification: ""
  });

  const create = useMutation({
    mutationFn: () =>
      changeApi.create({
        title: form.title,
        projectId: form.projectId,
        categoryId: form.categoryId || null,
        changeKind: form.changeKind,
        impact: form.impact,
        likelihood: form.likelihood,
        justification: form.justification
      }),
    onSuccess: (created) => {
      toast.success("Change raised", { description: "It starts as a draft — add the plans, then submit it." });
      onCreated(created.id);
    },
    onError: (err: any) => toast.error("Could not raise the change", { description: serverMessage(err, "Try again.") })
  });

  const blocked = !form.title.trim() || !form.projectId || form.justification.trim().length < 3;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Raise a change</DialogTitle>
        </DialogHeader>

        {/* Deliberately short. A change starts as a DRAFT and the plans are written in the detail
            panel — asking for a backout plan before somebody has even named the change is how a
            form gets abandoned halfway. The rules bite at submit, not here. */}
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="change-title">Title</Label>
            <Input id="change-title" value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} placeholder="Upgrade the payments database to 15.4" />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="change-project">Project</Label>
              <SearchableSelect
                aria-label="Project"
                options={(projects.data ?? []).map((p: any) => ({ id: p.id, name: p.name }))}
                value={form.projectId}
                onChange={(v) => setForm((f) => ({ ...f, projectId: v }))}
                placeholder="Select project"
                searchPlaceholder="Search projects…"
                emptyText="No projects match."
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="change-category">Category</Label>
              <SearchableSelect
                aria-label="Category"
                options={(categories.data?.categories ?? []).map((c) => ({ id: c.id, name: c.name }))}
                value={form.categoryId}
                onChange={(v) => setForm((f) => ({ ...f, categoryId: v }))}
                placeholder="Optional"
                searchPlaceholder="Search categories…"
                emptyText="No categories match."
                clearable
                clearLabel="None"
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <Label htmlFor="change-kind">Type</Label>
              <Select value={form.changeKind} onValueChange={(v) => setForm((f) => ({ ...f, changeKind: v as ChangeKind }))}>
                <SelectTrigger id="change-kind"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {changeKinds.map((k) => <SelectItem key={k} value={k}>{humanizeChange(k)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="change-impact">Impact</Label>
              <Select value={form.impact} onValueChange={(v) => setForm((f) => ({ ...f, impact: v as ChangeBand }))}>
                <SelectTrigger id="change-impact"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {changeBands.map((b) => <SelectItem key={b} value={b}>{humanizeChange(b)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="change-likelihood">Likelihood</Label>
              <Select value={form.likelihood} onValueChange={(v) => setForm((f) => ({ ...f, likelihood: v as ChangeBand }))}>
                <SelectTrigger id="change-likelihood"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {changeBands.map((b) => <SelectItem key={b} value={b}>{humanizeChange(b)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="change-justification">Justification</Label>
            <Textarea
              id="change-justification"
              rows={3}
              value={form.justification}
              onChange={(e) => setForm((f) => ({ ...f, justification: e.target.value }))}
              placeholder="Why now, and what happens if this does not go ahead?"
            />
            <p className="text-xs text-muted-foreground">The first thing an approver reads.</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={blocked || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? "Raising…" : "Raise change"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
