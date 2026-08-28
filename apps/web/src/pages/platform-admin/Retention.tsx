/**
 * The trial retention programme, as a platform admin runs it: the policy (what goes out when, and
 * whether the deletion at the end is armed), the queue (every workspace that was ever a trial and
 * where it is in the sequence), and the controls — send a stage now, hold a deletion, delete now
 * with the slug typed, and run the daily pass by hand as a dry run, against a simulated date, or
 * for real.
 *
 * Every row says WHY a deletion is or is not going to happen, in words. A queue that shows a date
 * without the reason is how an operator finds out on the day.
 *
 * LAYOUT. This was the console's most ragged page, and every fix is a `console-ui` primitive rather
 * than a local class, so it cannot drift away from the other seven pages again:
 *   - the policy mixed two switch boxes with four input boxes in one grid and no two cells were the
 *     same height. `SwitchField` (which has a height floor) and `Field` in one `FieldGrid` make each
 *     row of the grid a row again; every field carries a hint so the heights stay honest.
 *   - the run controls sat on one baseline-ragged line — a floating label, a date input and three
 *     buttons. The date is a `Field` on the left and the buttons a right-aligned `Toolbar`, the two
 *     bottom-aligned so the input and the buttons share an edge.
 *   - the queue had no minimum width, so below ~1150px the browser "resolved" the overflow by
 *     wrapping every cell to three lines instead of scrolling. `ConsoleTable` gives it an honest
 *     minimum width and its own scroll container; each cell is now at most two lines, the workspace
 *     identity (name · slug · owner) lives in one truncating cell, and the dates are `Num` so they
 *     line up. A row is a row, not a paragraph.
 *   - five loose filter buttons read as five unrelated actions; they are one `SegmentedControl`,
 *     which also carries the per-stage counts an operator was otherwise counting by eye.
 *
 * The dry-run result is the one bespoke piece: a monospace sentence list is unreadable at twenty
 * lines, so it is an aligned verb / workspace / detail row with a status dot instead.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CalendarClock, HeartHandshake, MoreHorizontal, Pause, Play, Send, ShieldAlert, Trash2, Users } from "lucide-react";
import { useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "../../components/ui/dropdown-menu";
import { Input } from "../../components/ui/input";
import { Skeleton } from "../../components/ui/skeleton";
import { Switch } from "../../components/ui/switch";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { toast } from "../../components/ui/toaster";
import { cn } from "../../lib/utils";
import { platformAdminConsoleApi, type RetentionQueueRow, type RetentionSettings, type RetentionTickResult } from "../../services/platform-admin-api";
import {
  BLOCKER_LABEL,
  ConsolePage,
  ConsoleSection,
  ConsoleTable,
  EmptyState,
  Field,
  FieldGrid,
  KpiCard,
  KpiGrid,
  MARKER_LABEL,
  MarkerTimeline,
  Num,
  OrgStatusPill,
  PRIMARY_BTN,
  SegmentedControl,
  SwitchField,
  TierPill,
  Toolbar,
  relativeDay,
  shortDate,
  shortDateTime
} from "./console-ui";

const errorMessageOf = (error: unknown) => (error as { response?: { data?: { message?: string } } })?.response?.data?.message;

type QueueStage = RetentionQueueRow["plan"]["stage"];
type QueueFilter = "all" | "trial" | "lapsed" | "converted" | "deleted";

const STAGE_VARIANT: Record<QueueStage, "info" | "warning" | "success" | "muted"> = { none: "muted", trial: "info", lapsed: "warning", converted: "success", deleted: "muted" };

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
        <Button size="sm" className={PRIMARY_BTN} onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save policy"}
        </Button>
      }
    >
      {/* Two switches then four inputs, in that order, so the 3-up grid is exactly two full rows at
          xl and two-up rows below it — no orphan cell to make the card look unfinished. */}
      <FieldGrid cols={3}>
        <SwitchField
          label="Programme on"
          hint="Off means nothing is sent or deleted; the workspace-side trial emails carry on alone."
          checked={form.enabled}
          onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v }))}
        />
        <SwitchField
          label="Auto-delete after the window"
          hint="The kill switch. Off: reminders still go, nothing is ever dropped automatically."
          icon={ShieldAlert}
          tone="danger"
          checked={form.autoDeleteEnabled}
          onCheckedChange={(v) => setForm((f) => ({ ...f, autoDeleteEnabled: v }))}
        />
        <Field label="Check-in on trial day" htmlFor="rp-feedback" hint="The day the feedback-form check-in goes out.">
          <Input id="rp-feedback" type="number" min={1} max={60} value={form.feedbackDay} onChange={(e) => setForm((f) => ({ ...f, feedbackDay: e.target.value }))} />
        </Field>
        <Field label="Reminder days after the trial ends" htmlFor="rp-reminders" hint="The last one is the final notice.">
          <Input id="rp-reminders" value={form.reminderDays} onChange={(e) => setForm((f) => ({ ...f, reminderDays: e.target.value }))} placeholder="30, 60, 80, 90" />
        </Field>
        <Field label="Retention window (days)" htmlFor="rp-retention" hint="Deletion runs on the tick after the final notice, once this many days have passed.">
          <Input id="rp-retention" type="number" min={7} value={form.retentionDays} onChange={(e) => setForm((f) => ({ ...f, retentionDays: e.target.value }))} />
        </Field>
        <Field label="Snapshot directory (optional)" htmlFor="rp-snapshot" hint="A best-effort mysqldump before every drop. Needs mysqldump on the API host.">
          <Input id="rp-snapshot" value={form.snapshotDir} onChange={(e) => setForm((f) => ({ ...f, snapshotDir: e.target.value }))} placeholder="/var/backups/timesphere-retention" />
        </Field>
      </FieldGrid>
    </ConsoleSection>
  );
}

/* ----------------------------------------------------------------------------------------- */
/* Run controls                                                                              */
/* ----------------------------------------------------------------------------------------- */

type ResultTone = "info" | "success" | "warning" | "destructive" | "muted";
/** One outcome of a pass, split into columns so twenty of them read as a table, not as prose. */
type ResultLine = { tone: ResultTone; action: string; org: string; detail?: string };

const RESULT_DOT: Record<ResultTone, string> = {
  info: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
  muted: "bg-muted-foreground/40"
};
const RESULT_TEXT: Record<ResultTone, string> = {
  info: "text-info",
  success: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
  muted: "text-muted-foreground"
};

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
  const lines: ResultLine[] = result
    ? [
        ...result.wouldSend.map((x) => ({ tone: "info" as const, action: "Would send", org: x.org, detail: MARKER_LABEL[x.marker] ?? x.marker })),
        ...result.wouldDelete.map((x) => ({ tone: "destructive" as const, action: "Would DELETE", org: x.org })),
        ...result.sent.map((x) => ({ tone: "success" as const, action: "Sent", org: x.org, detail: `${MARKER_LABEL[x.marker] ?? x.marker} → ${x.to ?? "no recipient"}` })),
        ...result.failed.map((x) => ({ tone: "destructive" as const, action: "Failed", org: x.org, detail: `${MARKER_LABEL[x.marker] ?? x.marker}: ${x.error}` })),
        ...result.deleted.map((x) => ({ tone: "destructive" as const, action: "Deleted", org: x.org, detail: x.databaseName ?? undefined })),
        ...result.held.map((x) => ({ tone: "warning" as const, action: "Held", org: x.org, detail: x.blockedBy ? BLOCKER_LABEL[x.blockedBy] : "held" })),
        ...result.superseded.map((x) => ({ tone: "muted" as const, action: "Superseded", org: x.org, detail: MARKER_LABEL[x.marker] ?? x.marker }))
      ]
    : [];
  return (
    <ConsoleSection
      title="Run the daily pass"
      description="It runs itself at 09:30 every day. Run it here to see what it would do — a simulated date is always a dry run."
      bodyClassName="grid gap-4"
    >
      {/* `items-end` is what puts the date input and the buttons on one edge: the field is taller by
          its label, so aligning the bottoms — not the centres — is the only way they share a line. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
        <Field label="As if today were" htmlFor="rp-sim" className="w-full sm:w-44">
          <Input id="rp-sim" type="date" value={simulate} onChange={(e) => setSimulate(e.target.value)} className="h-9" />
        </Field>
        <Toolbar>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => run.mutate({ dryRun: true })} disabled={run.isPending}>
            <Play className="h-3.5 w-3.5" />Dry run now
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5" disabled={!simulate || run.isPending} onClick={() => run.mutate({ simulateNow: new Date(`${simulate}T09:30:00`).toISOString() })}>
            <CalendarClock className="h-3.5 w-3.5" />Simulate
          </Button>
          <Button size="sm" className={cn("gap-1.5", PRIMARY_BTN)} onClick={() => setConfirmOpen(true)} disabled={run.isPending}>
            <Send className="h-3.5 w-3.5" />Run for real
          </Button>
        </Toolbar>
      </div>
      {result && (
        <div className="min-w-0 overflow-hidden rounded-lg border border-border bg-muted/40">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-3 py-2 text-xs text-muted-foreground">
            <Badge variant={result.dryRun ? "info" : "warning"}>{result.dryRun ? "Dry run" : "Real pass"}</Badge>
            <span>as of {shortDateTime(result.now)}</span>
            <span aria-hidden>·</span>
            <span className={cn(!result.enabled && "font-semibold text-warning")}>{result.enabled ? "programme on" : "programme OFF — nothing would happen"}</span>
          </p>
          {lines.length === 0 ? (
            <p className="px-3 py-4 text-sm text-muted-foreground">Nothing due.</p>
          ) : (
            <ul className="divide-y divide-border">
              {lines.map((l, i) => (
                <li key={`${l.action}-${l.org}-${i}`} className="flex min-w-0 items-center gap-2.5 px-3 py-1.5 text-xs">
                  <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", RESULT_DOT[l.tone])} aria-hidden />
                  <span className={cn("w-24 shrink-0 font-semibold", RESULT_TEXT[l.tone])}>{l.action}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">{l.org}</span>
                  {l.detail && <span className="min-w-0 max-w-[45%] truncate text-muted-foreground">{l.detail}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
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
  const deletionNote = p.deletionDue ? "DUE on the next pass" : p.deletionBlockedBy ? BLOCKER_LABEL[p.deletionBlockedBy] : "";
  return (
    <TableRow className={cn(deleted && "opacity-60")}>
      {/* Identity in ONE cell and at most two lines: the name truncates, the pills never do, and the
          slug and owner share the second line. Three stacked lines per row turned six workspaces
          into a page of scrolling. */}
      <TableCell>
        <div className="grid min-w-0 max-w-[22rem] gap-0.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-medium text-foreground" title={row.name}>
              {row.name}
            </span>
            <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
              <OrgStatusPill status={row.status} />
              <TierPill tier={row.trialTier ? `${row.trialTier} trial` : row.planTier} />
            </span>
          </div>
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="shrink-0 font-mono text-[11px]">{row.slug}</span>
            <span aria-hidden>·</span>
            <span className="truncate" title={row.ownerEmail ?? undefined}>
              {row.ownerEmail ?? "no owner email recorded"}
            </span>
          </div>
        </div>
      </TableCell>
      <TableCell>
        <span className="flex items-center gap-1.5 whitespace-nowrap">
          <Badge variant={STAGE_VARIANT[p.stage]}>{p.stage}</Badge>
          {p.stage === "trial" && p.daysIntoTrial !== null && <span className="text-xs text-muted-foreground">day {p.daysIntoTrial}</span>}
          {p.stage === "lapsed" && p.daysSinceTrialEnd !== null && <span className="text-xs text-muted-foreground">+{p.daysSinceTrialEnd}d</span>}
        </span>
      </TableCell>
      <Num className="whitespace-nowrap text-xs">
        <span className="block text-foreground">{shortDate(row.trialEndsAt)}</span>
        <span className="block font-sans text-muted-foreground">{relativeDay(row.trialEndsAt)}</span>
      </Num>
      <TableCell className="whitespace-nowrap">
        <div className="grid gap-1">
          <MarkerTimeline markers={markers} sent={p.sent} next={p.nextMarker?.marker} due={p.due} />
          <span className="block text-[11px] text-muted-foreground">
            {p.nextMarker ? `next: ${MARKER_LABEL[p.nextMarker.marker] ?? p.nextMarker.marker} ${relativeDay(p.nextMarker.at)}` : row.lastEmail ? `last: ${row.lastEmail.templateKey} · ${row.lastEmail.status}` : "nothing scheduled"}
          </span>
        </div>
      </TableCell>
      {/* The date is a number, so it right-aligns with the rest; the reason under it is a sentence,
          so it drops back to the body font rather than inheriting `Num`'s monospace. */}
      <Num className="whitespace-nowrap text-xs">
        {deleted ? (
          <span className="font-sans text-muted-foreground">deleted {shortDate(row.retentionDeletedAt)}</span>
        ) : p.deleteAt ? (
          <div className="grid justify-items-end gap-0.5">
            <span className={cn("font-medium", p.deletionDue ? "text-destructive" : "text-foreground")}>
              {shortDate(p.deleteAt)} <span className="font-normal text-muted-foreground">({relativeDay(p.deleteAt)})</span>
            </span>
            {deletionNote && <span className={cn("font-sans text-[11px]", p.deletionDue ? "text-destructive" : "text-muted-foreground")}>{deletionNote}</span>}
          </div>
        ) : (
          "—"
        )}
      </Num>
      {/* No icon beside the switch: a second glyph that only ever repeats the switch's own state
          made the cell look off-centre. The state lives in the switch's title instead. */}
      <TableCell className="text-center">
        {!deleted && !p.converted && (
          <span className="flex items-center justify-center">
            <Switch
              checked={row.retentionHold}
              onCheckedChange={(v) => hold.mutate(v)}
              disabled={hold.isPending}
              aria-label={`Hold ${row.slug}`}
              title={row.retentionHold ? "On hold: reminders still go, the deletion does not." : "Hold: reminders still go, the deletion does not."}
            />
          </span>
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
  const [filter, setFilter] = useState<QueueFilter>("all");
  const d = retention.data;
  const queue = d?.queue ?? [];
  const rows = queue.filter((r) => filter === "all" || r.plan.stage === filter);
  const countOf = (stage: QueueStage) => queue.filter((r) => r.plan.stage === stage).length;
  const lapsed = countOf("lapsed");
  const dueSoon = queue.filter((r) => r.plan.stage === "lapsed" && r.plan.daysUntilDeletion !== null && r.plan.daysUntilDeletion <= 14).length;
  const held = queue.filter((r) => r.retentionHold && !r.retentionDeletedAt).length;
  /* Counts on the filters: an operator's next question after "how many lapsed?" was always "of
     which how many are still in the queue" — the segment answers it without a click. */
  const filters = [
    { value: "all" as const, count: queue.length },
    { value: "trial" as const, count: countOf("trial") },
    { value: "lapsed" as const, count: lapsed },
    { value: "converted" as const, count: countOf("converted") },
    { value: "deleted" as const, count: countOf("deleted") }
  ];

  return (
    <ConsolePage eyebrow="Growth" title="Trial retention" description="Every workspace that started as a trial, where it is in the sequence, what goes out next, and whether the deletion at the end is going to happen — and why or why not.">
      {retention.isLoading && <Skeleton className="h-96 w-full" />}
      {d && (
        <>
          <KpiGrid>
            <KpiCard label="In the programme" value={queue.filter((r) => r.plan.inProgramme).length} icon={HeartHandshake} tone="accent" />
            <KpiCard label="Lapsed, unconverted" value={lapsed} icon={Users} tone={lapsed > 0 ? "warning" : "default"} delay={0.05} />
            <KpiCard label="Within 14 days of deletion" value={dueSoon} icon={AlertTriangle} tone={dueSoon > 0 ? "destructive" : "default"} delay={0.1} />
            <KpiCard label="On hold" value={held} icon={Pause} delay={0.15} />
          </KpiGrid>
          <PolicyCard key={d.settings.updatedAt ?? "initial"} settings={d.settings} />
          <RunCard />
          <ConsoleSection
            title="The queue"
            description="Six dots per workspace: filled = sent, hollow = skipped as stale, pulsing = due on the next pass, ringed = next."
            actions={
              <Toolbar>
                <SegmentedControl options={filters} value={filter} onChange={setFilter} ariaLabel="Filter the queue by stage" />
              </Toolbar>
            }
            /* Full-bleed only when there is a table: an empty state needs the body padding. */
            flush={rows.length > 0}
          >
            {rows.length === 0 ? (
              <EmptyState title="No workspaces here" description="Self-serve trials appear the moment they sign up." />
            ) : (
              <ConsoleTable minWidth={1040} className="rounded-none border-x-0 border-b-0">
                <TableHeader>
                  <TableRow>
                    <TableHead>Workspace</TableHead>
                    <TableHead>Stage</TableHead>
                    <TableHead className="text-right">Trial Ends</TableHead>
                    <TableHead>Sequence</TableHead>
                    <TableHead className="text-right">Deletion</TableHead>
                    <TableHead className="text-center">Hold</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <QueueRow key={row.id} row={row} markers={d.markers} />
                  ))}
                </TableBody>
              </ConsoleTable>
            )}
          </ConsoleSection>
        </>
      )}
    </ConsolePage>
  );
}
