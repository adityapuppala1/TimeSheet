/**
 * The trial retention programme, as a platform admin runs it: the policy (what goes out when, and
 * whether the deletion at the end is armed), the queue (every workspace that was ever a trial and
 * where it is in the sequence), and the controls — send a stage now, hold a deletion, delete now
 * with the slug typed, and run the daily pass by hand as a dry run, against a simulated date, or
 * for real.
 *
 * Every row says WHY a deletion is or is not going to happen, in words. A queue that shows a date
 * without the reason is how an operator finds out on the day.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CalendarClock, HeartHandshake, MoreHorizontal, Pause, Play, Send, ShieldAlert, Trash2, Users } from "lucide-react";
import { useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "../../components/ui/dropdown-menu";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Skeleton } from "../../components/ui/skeleton";
import { Switch } from "../../components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { toast } from "../../components/ui/toaster";
import { cn } from "../../lib/utils";
import { platformAdminConsoleApi, type RetentionQueueRow, type RetentionSettings, type RetentionTickResult } from "../../services/platform-admin-api";
import { BLOCKER_LABEL, ConsolePage, ConsoleSection, EmptyState, KpiCard, MARKER_LABEL, MarkerTimeline, OrgStatusPill, TierPill, relativeDay, shortDate, shortDateTime } from "./console-ui";

const errorMessageOf = (error: unknown) => (error as { response?: { data?: { message?: string } } })?.response?.data?.message;

const STAGE_VARIANT: Record<RetentionQueueRow["plan"]["stage"], "info" | "warning" | "success" | "muted"> = { none: "muted", trial: "info", lapsed: "warning", converted: "success", deleted: "muted" };

/* ----------------------------------------------------------------------------------------- */
/* Policy                                                                                    */
/* ----------------------------------------------------------------------------------------- */

function PolicyCard({ settings }: { settings: RetentionSettings }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    enabled: settings.enabled,
    feedbackDay: String(settings.feedbackDay),
    reminderDays: settings.reminderDays.join(", "),
    retentionDays: String(settings.retentionDays),
    autoDeleteEnabled: settings.autoDeleteEnabled,
    snapshotDir: settings.snapshotDir ?? ""
  });
  const save = useMutation({
    mutationFn: () =>
      platformAdminConsoleApi.updateRetentionSettings({
        enabled: form.enabled,
        feedbackDay: Number(form.feedbackDay),
        reminderDays: form.reminderDays.split(/[,\s]+/).map(Number).filter((n) => Number.isInteger(n) && n > 0),
        retentionDays: Number(form.retentionDays),
        autoDeleteEnabled: form.autoDeleteEnabled,
        snapshotDir: form.snapshotDir.trim() || null
      }),
    onSuccess: () => {
      toast.success("Policy saved");
      queryClient.invalidateQueries({ queryKey: ["platform-admin"] });
    },
    onError: (e) => toast.error("Could not save", { description: errorMessageOf(e) })
  });
  return (
    <ConsoleSection
      title="The policy"
      description="Day 10 of the trial: a check-in with the feedback form. The day it ends: your data is safe. Then reminders, and after the window, deletion — unless converted, restored or held."
      actions={
        <Button size="sm" className="bg-accent text-accent-foreground hover:bg-accent/90" onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save policy"}
        </Button>
      }
    >
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <label className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
          <span>
            <span className="block text-sm font-medium">Programme on</span>
            <span className="block text-xs text-muted-foreground">Off means nothing is sent or deleted; the workspace-side trial emails carry on alone.</span>
          </span>
          <Switch checked={form.enabled} onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v }))} />
        </label>
        <label className={cn("flex items-center justify-between gap-3 rounded-lg border p-3", form.autoDeleteEnabled ? "border-destructive/40 bg-destructive/5" : "border-border")}>
          <span>
            <span className="flex items-center gap-1.5 text-sm font-medium">
              <ShieldAlert className={cn("h-4 w-4", form.autoDeleteEnabled ? "text-destructive" : "text-muted-foreground")} />
              Auto-delete after the window
            </span>
            <span className="block text-xs text-muted-foreground">The kill switch. Off: reminders still go, nothing is ever dropped automatically.</span>
          </span>
          <Switch checked={form.autoDeleteEnabled} onCheckedChange={(v) => setForm((f) => ({ ...f, autoDeleteEnabled: v }))} />
        </label>
        <div className="grid gap-1.5 rounded-lg border border-border p-3">
          <Label htmlFor="rp-feedback">Check-in on trial day</Label>
          <Input id="rp-feedback" type="number" min={1} max={60} value={form.feedbackDay} onChange={(e) => setForm((f) => ({ ...f, feedbackDay: e.target.value }))} />
        </div>
        <div className="grid gap-1.5 rounded-lg border border-border p-3">
          <Label htmlFor="rp-reminders">Reminder days after the trial ends</Label>
          <Input id="rp-reminders" value={form.reminderDays} onChange={(e) => setForm((f) => ({ ...f, reminderDays: e.target.value }))} placeholder="30, 60, 80, 90" />
          <span className="text-xs text-muted-foreground">The last one is the final notice.</span>
        </div>
        <div className="grid gap-1.5 rounded-lg border border-border p-3">
          <Label htmlFor="rp-retention">Retention window (days)</Label>
          <Input id="rp-retention" type="number" min={7} value={form.retentionDays} onChange={(e) => setForm((f) => ({ ...f, retentionDays: e.target.value }))} />
          <span className="text-xs text-muted-foreground">Deletion runs on the tick after the final notice, once this many days have passed.</span>
        </div>
        <div className="grid gap-1.5 rounded-lg border border-border p-3">
          <Label htmlFor="rp-snapshot">Snapshot directory (optional)</Label>
          <Input id="rp-snapshot" value={form.snapshotDir} onChange={(e) => setForm((f) => ({ ...f, snapshotDir: e.target.value }))} placeholder="/var/backups/timesphere-retention" />
          <span className="text-xs text-muted-foreground">A best-effort mysqldump before every drop. Needs mysqldump on the API host.</span>
        </div>
      </div>
    </ConsoleSection>
  );
}

/* ----------------------------------------------------------------------------------------- */
/* Run controls                                                                              */
/* ----------------------------------------------------------------------------------------- */

function RunCard() {
  const queryClient = useQueryClient();
  const [simulate, setSimulate] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [result, setResult] = useState<RetentionTickResult | null>(null);
  const run = useMutation({
    mutationFn: (body: { dryRun?: boolean; simulateNow?: string }) => platformAdminConsoleApi.runRetention(body),
    onSuccess: (r) => {
      setResult(r);
      setConfirmOpen(false);
      if (!r.dryRun) queryClient.invalidateQueries({ queryKey: ["platform-admin"] });
      toast.success(r.dryRun ? "Dry run complete" : `Pass complete — ${r.sent.length} sent, ${r.deleted.length} deleted`);
    },
    onError: (e) => toast.error("Pass failed", { description: errorMessageOf(e) })
  });
  const lines = result
    ? [
        ...result.wouldSend.map((x) => ({ tone: "info", text: `would send ${MARKER_LABEL[x.marker] ?? x.marker} → ${x.org}` })),
        ...result.wouldDelete.map((x) => ({ tone: "destructive", text: `would DELETE ${x.org}` })),
        ...result.sent.map((x) => ({ tone: "success", text: `sent ${MARKER_LABEL[x.marker] ?? x.marker} → ${x.org} (${x.to ?? "no recipient"})` })),
        ...result.failed.map((x) => ({ tone: "destructive", text: `failed ${x.marker} → ${x.org}: ${x.error}` })),
        ...result.deleted.map((x) => ({ tone: "destructive", text: `deleted ${x.org}${x.databaseName ? ` (${x.databaseName})` : ""}` })),
        ...result.held.map((x) => ({ tone: "warning", text: `held ${x.org}: ${x.blockedBy ? BLOCKER_LABEL[x.blockedBy] : "held"}` })),
        ...result.superseded.map((x) => ({ tone: "muted", text: `superseded ${MARKER_LABEL[x.marker] ?? x.marker} for ${x.org}` }))
      ]
    : [];
  return (
    <ConsoleSection title="Run the daily pass" description="It runs itself at 09:30 every day. Run it here to see what it would do — a simulated date is always a dry run.">
      <div className="grid gap-3">
        <div className="flex flex-wrap items-end gap-2">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => run.mutate({ dryRun: true })} disabled={run.isPending}>
            <Play className="h-3.5 w-3.5" />Dry run now
          </Button>
          <div className="flex items-end gap-1.5">
            <div className="grid gap-1">
              <Label htmlFor="rp-sim" className="text-xs">
                As if today were
              </Label>
              <Input id="rp-sim" type="date" value={simulate} onChange={(e) => setSimulate(e.target.value)} className="h-9 w-40" />
            </div>
            <Button variant="outline" size="sm" className="gap-1.5" disabled={!simulate || run.isPending} onClick={() => run.mutate({ simulateNow: new Date(`${simulate}T09:30:00`).toISOString() })}>
              <CalendarClock className="h-3.5 w-3.5" />Simulate
            </Button>
          </div>
          <Button size="sm" className="gap-1.5 bg-accent text-accent-foreground hover:bg-accent/90" onClick={() => setConfirmOpen(true)} disabled={run.isPending}>
            <Send className="h-3.5 w-3.5" />Run for real
          </Button>
        </div>
        {result && (
          <div className="rounded-lg border border-border bg-muted/40 p-3">
            <p className="mb-2 font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
              {result.dryRun ? "Dry run" : "Real pass"} · as of {shortDateTime(result.now)} · {result.enabled ? "programme on" : "programme OFF — nothing would happen"}
            </p>
            {lines.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing due.</p>
            ) : (
              <ul className="grid gap-1 font-mono text-xs">
                {lines.map((l, i) => (
                  <li key={i} className={cn(l.tone === "destructive" && "text-destructive", l.tone === "success" && "text-success", l.tone === "warning" && "text-warning", l.tone === "info" && "text-info", l.tone === "muted" && "text-muted-foreground")}>
                    {l.text}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Run the retention pass now?</DialogTitle>
            <DialogDescription>Every due reminder is sent and every workspace whose deletion is due is deleted, exactly as the 09:30 run would. Do a dry run first if you are not sure.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => run.mutate({ dryRun: false })} disabled={run.isPending}>
              {run.isPending ? "Running…" : "Run for real"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConsoleSection>
  );
}

/* ----------------------------------------------------------------------------------------- */
/* Queue                                                                                     */
/* ----------------------------------------------------------------------------------------- */

function QueueRow({ row, markers }: { row: RetentionQueueRow; markers: string[] }) {
  const queryClient = useQueryClient();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmSlug, setConfirmSlug] = useState("");
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["platform-admin"] });
  const hold = useMutation({
    mutationFn: (v: boolean) => platformAdminConsoleApi.setRetentionHold(row.id, v),
    onSuccess: (r) => {
      toast.success(r.retentionHold ? `${row.slug} held — it will not be deleted` : `${row.slug} released`);
      invalidate();
    }
  });
  const send = useMutation({
    mutationFn: (marker: string) => platformAdminConsoleApi.sendRetentionMarker(row.id, marker),
    onSuccess: (r) => {
      toast.success(`Sent ${MARKER_LABEL[r.marker] ?? r.marker} to ${r.to}`, { description: r.subject });
      invalidate();
    },
    onError: (e) => toast.error("Not sent", { description: errorMessageOf(e) })
  });
  const del = useMutation({
    mutationFn: () => platformAdminConsoleApi.deleteUnderPolicy(row.id, confirmSlug),
    onSuccess: (r) => {
      toast.success(`${row.slug} deleted`, { description: r.snapshot?.taken ? `Snapshot: ${r.snapshot.path}` : `No snapshot (${r.snapshot?.reason ?? "disabled"})` });
      setDeleteOpen(false);
      invalidate();
    },
    onError: (e) => toast.error("Not deleted", { description: errorMessageOf(e) })
  });
  const p = row.plan;
  const deleted = Boolean(row.retentionDeletedAt);
  return (
    <TableRow className={cn(deleted && "opacity-60")}>
      <TableCell>
        <div className="grid gap-0.5">
          <span className="font-medium text-foreground">{row.name}</span>
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[11px] text-muted-foreground">{row.slug}</span>
            <OrgStatusPill status={row.status} />
            <TierPill tier={row.trialTier ? `${row.trialTier} trial` : row.planTier} />
          </span>
          <span className="truncate text-xs text-muted-foreground">{row.ownerEmail ?? "no owner email recorded"}</span>
        </div>
      </TableCell>
      <TableCell>
        <Badge variant={STAGE_VARIANT[p.stage]}>{p.stage}</Badge>
        {p.stage === "trial" && p.daysIntoTrial !== null && <span className="ml-1.5 text-xs text-muted-foreground">day {p.daysIntoTrial}</span>}
        {p.stage === "lapsed" && p.daysSinceTrialEnd !== null && <span className="ml-1.5 text-xs text-muted-foreground">+{p.daysSinceTrialEnd}d</span>}
      </TableCell>
      <TableCell className="whitespace-nowrap text-xs">
        <span className="block">{shortDate(row.trialEndsAt)}</span>
        <span className="text-muted-foreground">{relativeDay(row.trialEndsAt)}</span>
      </TableCell>
      <TableCell>
        <MarkerTimeline markers={markers} sent={p.sent} next={p.nextMarker?.marker} due={p.due} />
        <span className="mt-1 block text-[11px] text-muted-foreground">
          {p.nextMarker ? `next: ${MARKER_LABEL[p.nextMarker.marker] ?? p.nextMarker.marker} ${relativeDay(p.nextMarker.at)}` : row.lastEmail ? `last: ${row.lastEmail.templateKey} · ${row.lastEmail.status}` : "nothing scheduled"}
        </span>
      </TableCell>
      <TableCell className="text-xs">
        {deleted ? (
          <span className="text-muted-foreground">deleted {shortDate(row.retentionDeletedAt)}</span>
        ) : p.deleteAt ? (
          <span className="grid gap-0.5">
            <span className={cn("font-medium", p.deletionDue ? "text-destructive" : "text-foreground")}>
              {shortDate(p.deleteAt)} <span className="font-normal text-muted-foreground">({relativeDay(p.deleteAt)})</span>
            </span>
            <span className={cn("text-[11px]", p.deletionDue ? "text-destructive" : "text-muted-foreground")}>{p.deletionDue ? "DUE on the next pass" : p.deletionBlockedBy ? BLOCKER_LABEL[p.deletionBlockedBy] : ""}</span>
          </span>
        ) : (
          "—"
        )}
      </TableCell>
      <TableCell>
        {!deleted && !p.converted && (
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title="Hold: reminders still go, the deletion does not.">
            <Switch checked={row.retentionHold} onCheckedChange={(v) => hold.mutate(v)} disabled={hold.isPending} />
            {row.retentionHold ? <Pause className="h-3.5 w-3.5 text-warning" /> : null}
          </label>
        )}
      </TableCell>
      <TableCell className="text-right">
        {!deleted && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" className="h-7 px-2" aria-label="Actions">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>Send a stage now</DropdownMenuLabel>
              {markers.map((m) => (
                <DropdownMenuItem key={m} onSelect={() => send.mutate(m)} disabled={p.converted}>
                  <Send className="mr-2 h-3.5 w-3.5" />
                  {MARKER_LABEL[m] ?? m}
                  {p.sent[m] && <span className="ml-auto text-[10px] text-muted-foreground">{p.sent[m] === "superseded" ? "skipped" : "sent"}</span>}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setDeleteOpen(true)} disabled={p.converted || (row.status !== "GRACE" && row.status !== "SUSPENDED")}>
                <Trash2 className="mr-2 h-3.5 w-3.5" />Delete under the policy now…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-5 w-5" />Delete {row.name} permanently
              </DialogTitle>
              <DialogDescription>
                Drops the workspace's database, removes its domains and finder entries, archives the organization, and emails the owner a confirmation. There is no undo. Type <span className="font-mono text-foreground">{row.slug}</span> to confirm.
              </DialogDescription>
            </DialogHeader>
            <Input value={confirmSlug} onChange={(e) => setConfirmSlug(e.target.value)} placeholder={row.slug} autoComplete="off" />
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeleteOpen(false)}>
                Cancel
              </Button>
              <Button className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={confirmSlug.trim().toLowerCase() !== row.slug || del.isPending} onClick={() => del.mutate()}>
                {del.isPending ? "Deleting…" : "Delete permanently"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </TableCell>
    </TableRow>
  );
}

export function PlatformAdminRetention() {
  const retention = useQuery({ queryKey: ["platform-admin", "retention"], queryFn: platformAdminConsoleApi.retention });
  const [filter, setFilter] = useState<"all" | "trial" | "lapsed" | "converted" | "deleted">("all");
  const d = retention.data;
  const rows = d?.queue.filter((r) => filter === "all" || r.plan.stage === filter) ?? [];
  const lapsed = d?.queue.filter((r) => r.plan.stage === "lapsed").length ?? 0;
  const dueSoon = d?.queue.filter((r) => r.plan.stage === "lapsed" && r.plan.daysUntilDeletion !== null && r.plan.daysUntilDeletion <= 14).length ?? 0;
  const held = d?.queue.filter((r) => r.retentionHold && !r.retentionDeletedAt).length ?? 0;

  return (
    <ConsolePage eyebrow="Growth" title="Trial retention" description="Every workspace that started as a trial, where it is in the sequence, what goes out next, and whether the deletion at the end is going to happen — and why or why not.">
      {retention.isLoading && <Skeleton className="h-96 w-full" />}
      {d && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="In the programme" value={d.queue.filter((r) => r.plan.inProgramme).length} icon={HeartHandshake} tone="accent" />
            <KpiCard label="Lapsed, unconverted" value={lapsed} icon={Users} tone={lapsed > 0 ? "warning" : "default"} delay={0.05} />
            <KpiCard label="Within 14 days of deletion" value={dueSoon} icon={AlertTriangle} tone={dueSoon > 0 ? "destructive" : "default"} delay={0.1} />
            <KpiCard label="On hold" value={held} icon={Pause} delay={0.15} />
          </div>
          <PolicyCard key={d.settings.updatedAt ?? "initial"} settings={d.settings} />
          <RunCard />
          <ConsoleSection
            title="The queue"
            description="Six dots per workspace: filled = sent, hollow = skipped as stale, pulsing = due on the next pass, ringed = next."
            actions={
              <div className="flex flex-wrap gap-1">
                {(["all", "trial", "lapsed", "converted", "deleted"] as const).map((f) => (
                  <Button key={f} size="sm" variant={filter === f ? "default" : "outline"} className={cn("h-7 capitalize", filter === f && "bg-accent text-accent-foreground hover:bg-accent/90")} onClick={() => setFilter(f)}>
                    {f}
                  </Button>
                ))}
              </div>
            }
          >
            {rows.length === 0 ? (
              <EmptyState title="No workspaces here" description="Self-serve trials appear the moment they sign up." />
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Workspace</TableHead>
                      <TableHead>Stage</TableHead>
                      <TableHead>Trial ends</TableHead>
                      <TableHead>Sequence</TableHead>
                      <TableHead>Deletion</TableHead>
                      <TableHead>Hold</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => (
                      <QueueRow key={row.id} row={row} markers={d.markers} />
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </ConsoleSection>
        </>
      )}
    </ConsolePage>
  );
}
