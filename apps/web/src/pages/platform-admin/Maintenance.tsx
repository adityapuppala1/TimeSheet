/**
 * ONE maintenance window, across every workspace on the deployment.
 *
 * WHAT IT IS REUSING, AND WHY THAT MATTERS HERE. Nothing on this page is a new lockout mechanism.
 * A workspace already has a `MaintenanceSettings` row, `middleware/auth.ts` already answers
 * `503 { code: "MAINTENANCE" }` to everyone below super admin while a window is live, the SPA's
 * interceptor already redirects that code to `/maintenance`, the 15-second heartbeat already turns
 * an open tab into a redirect without anybody refreshing, and `notifyUsersOfMaintenance` already
 * writes the in-app notice. Arming from here writes the SAME row into N tenant databases. So the
 * behaviour a customer sees is the behaviour their own admin would have produced — redirection,
 * popup, heartbeat, notification — and there is exactly one thing to debug when it misbehaves.
 *
 * WHAT THE PAGE MUST BE HONEST ABOUT: a broadcast is N independent writes and some of them can
 * fail. A workspace whose database is unreachable does not stop the other thirty-nine, and it is
 * named — with its error — rather than folded into a success count. The header figures count
 * states, not intentions.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, BellRing, CalendarClock, CheckCircle2, Clock, Lock, Mail, PlayCircle, Radio, ShieldCheck, StopCircle, XCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Skeleton } from "../../components/ui/skeleton";
import { Textarea } from "../../components/ui/textarea";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { toast } from "../../components/ui/toaster";
import { platformOpsApi, type MaintenanceBroadcastRow, type WorkspaceMaintenanceState } from "../../services/platform-admin-api";
import { ConsolePage, ConsoleSection, ConsoleTable, EmptyState, Field, FieldGrid, KpiCard, KpiGrid, Num, PRIMARY_BTN, SegmentedControl, SwitchField, Toolbar, shortDateTime } from "./console-ui";

const errorMessageOf = (error: unknown) => (error as { response?: { data?: { message?: string } } })?.response?.data?.message;

/** The four states a window can be in, exactly as the tenant's own `phaseOf` computes them. */
const PHASE: Record<string, { label: string; variant: "success" | "warning" | "destructive" | "muted" | "info"; icon: typeof Clock }> = {
  off: { label: "Open", variant: "success", icon: CheckCircle2 },
  scheduled: { label: "Scheduled", variant: "info", icon: CalendarClock },
  active: { label: "In maintenance", variant: "destructive", icon: StopCircle },
  expired: { label: "Window passed", variant: "warning", icon: Clock }
};

function PhasePill({ state }: { state: WorkspaceMaintenanceState }) {
  if (state.error) {
    return (
      <Badge variant="warning" className="gap-1.5" title={state.error}>
        <AlertTriangle className="h-3 w-3" />
        Unreachable
      </Badge>
    );
  }
  const phase = PHASE[state.settings?.phase ?? "off"] ?? PHASE.off;
  const Icon = phase.icon;
  return (
    <Badge variant={phase.variant} className="gap-1.5">
      <Icon className="h-3 w-3" />
      {phase.label}
    </Badge>
  );
}

/** `datetime-local` wants `YYYY-MM-DDTHH:mm` in LOCAL time; `toISOString` would shift it by the
 *  UTC offset and quietly schedule the window in the wrong hour. */
const toLocalInput = (date: Date) => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

function BroadcastDialog({
  open,
  onOpenChange,
  workspaces,
  preselected
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaces: WorkspaceMaintenanceState[];
  preselected: string[];
}) {
  const queryClient = useQueryClient();
  const [ids, setIds] = useState<string[]>(preselected);
  const [start, setStart] = useState(() => toLocalInput(new Date(Date.now() + 60 * 60_000)));
  const [end, setEnd] = useState(() => toLocalInput(new Date(Date.now() + 150 * 60_000)));
  const [message, setMessage] = useState("");
  const [notifyUsers, setNotifyUsers] = useState(true);
  const [emailSuperAdmins, setEmailSuperAdmins] = useState(true);

  const everyone = ids.length === 0;
  const targetCount = everyone ? workspaces.length : ids.length;

  const arm = useMutation({
    mutationFn: () =>
      platformOpsApi.broadcast({
        organizationIds: ids,
        enabled: true,
        scheduledStartAt: new Date(start).toISOString(),
        scheduledEndAt: new Date(end).toISOString(),
        message: message.trim() || null,
        notifyUsers,
        emailSuperAdmins
      }),
    onSuccess: (result) => {
      const failed = result.outcomes.filter((o) => !o.ok);
      if (failed.length) {
        toast.warning(`${result.outcomes.length - failed.length} of ${result.outcomes.length} workspaces armed`, {
          description: `Did not take: ${failed.map((f) => f.slug).join(", ")}`
        });
      } else {
        toast.success(`Maintenance armed on ${result.outcomes.length} workspace${result.outcomes.length === 1 ? "" : "s"}`, {
          description: `${result.outcomes.reduce((sum, o) => sum + o.notified, 0)} people notified · ${result.outcomes.filter((o) => o.emailed).length} emailed`
        });
      }
      onOpenChange(false);
      void queryClient.invalidateQueries({ queryKey: ["platform-admin"] });
    },
    onError: (error) => toast.error("Not armed", { description: errorMessageOf(error) })
  });

  const invalidWindow = !start || !end || new Date(end) <= new Date(start);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Arm a maintenance window</DialogTitle>
          <DialogDescription>
            Everyone below super administrator is signed out of the chosen workspaces for the window and sees the maintenance page. Open tabs redirect within about fifteen
            seconds — the app's own heartbeat does it, nobody has to refresh. While it holds, the workspace's own administrators can see the window but cannot move or cancel
            it: a deployment-wide window any one tenant could switch off is not a window.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <FieldGrid cols={2}>
            <Field label="Starts" htmlFor="mw-start" hint="Your local time. Every notice quotes it in UTC.">
              <Input id="mw-start" type="datetime-local" value={start} onChange={(event) => setStart(event.target.value)} />
            </Field>
            <Field label="Ends" htmlFor="mw-end" error={invalidWindow ? "The window must end after it starts." : undefined}>
              <Input id="mw-end" type="datetime-local" value={end} onChange={(event) => setEnd(event.target.value)} />
            </Field>
          </FieldGrid>

          <Field
            label="What people will read"
            htmlFor="mw-message"
            hint="Shown on the maintenance page, in the in-app notice and in the email. Leave blank for the default wording."
          >
            <Textarea
              id="mw-message"
              rows={3}
              maxLength={500}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Database maintenance. Timesheets already submitted are unaffected."
            />
          </Field>

          <FieldGrid cols={2}>
            <SwitchField
              label="Notify people in-app"
              hint="Writes the notification everyone online in each workspace already receives."
              checked={notifyUsers}
              onCheckedChange={setNotifyUsers}
              icon={BellRing}
            />
            <SwitchField
              label="Email each workspace's super admins"
              hint="Sent by the platform relay, not the workspace's — a workspace going down may take its own mail with it."
              checked={emailSuperAdmins}
              onCheckedChange={setEmailSuperAdmins}
              icon={Mail}
            />
          </FieldGrid>

          <Field
            label={`Workspaces — ${everyone ? `all ${workspaces.length}` : `${targetCount} selected`}`}
            hint="Leave every box clear to reach every workspace that can be signed into."
          >
            <div className="grid max-h-56 min-w-0 grid-cols-1 gap-1 overflow-y-auto rounded-lg border border-border p-2 sm:grid-cols-2">
              {workspaces.map((workspace) => (
                <label key={workspace.organizationId} className="flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted">
                  <Checkbox
                    checked={ids.includes(workspace.organizationId)}
                    onCheckedChange={(checked) =>
                      setIds((prev) => (checked ? [...prev, workspace.organizationId] : prev.filter((id) => id !== workspace.organizationId)))
                    }
                  />
                  <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{workspace.slug}</span>
                </label>
              ))}
            </div>
          </Field>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button className={PRIMARY_BTN} disabled={invalidWindow || arm.isPending} onClick={() => arm.mutate()}>
            {arm.isPending ? "Arming…" : `Arm on ${everyone ? `all ${workspaces.length}` : targetCount} workspace${targetCount === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BroadcastRow({ row }: { row: MaintenanceBroadcastRow }) {
  const [open, setOpen] = useState(false);
  const outcomes = row.outcomes ?? [];
  return (
    <>
      <TableRow className="cursor-pointer" onClick={() => setOpen((value) => !value)}>
        <TableCell>
          <Badge variant={row.enabled ? "destructive" : "success"} className="gap-1.5">
            {row.enabled ? <StopCircle className="h-3 w-3" /> : <CheckCircle2 className="h-3 w-3" />}
            {row.enabled ? "Armed" : "Cleared"}
          </Badge>
        </TableCell>
        <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{shortDateTime(row.createdAt)}</TableCell>
        <TableCell className="max-w-[18rem]">
          <p className="truncate text-sm text-foreground">{row.message || <span className="text-muted-foreground">No message</span>}</p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">{row.actorLabel}</p>
        </TableCell>
        <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
          {row.scheduledStartAt ? `${shortDateTime(row.scheduledStartAt)} → ${shortDateTime(row.scheduledEndAt)}` : "—"}
        </TableCell>
        <Num>{row.appliedCount}</Num>
        <Num className={row.failedCount ? "text-destructive" : undefined}>{row.failedCount}</Num>
        <Num>{row.notifiedCount}</Num>
        <Num>{row.emailedCount}</Num>
      </TableRow>
      {open && (
        <TableRow>
          <TableCell colSpan={8} className="bg-muted/40">
            <div className="grid gap-1.5 py-1">
              {outcomes.map((outcome) => (
                <div key={outcome.organizationId} className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
                  {outcome.ok ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" /> : <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />}
                  <span className="font-mono font-semibold text-foreground">{outcome.slug}</span>
                  {outcome.ok ? (
                    <span className="text-muted-foreground">
                      {outcome.notified} notified{outcome.emailed ? " · super admins emailed" : ""}
                    </span>
                  ) : (
                    <span className="min-w-0 text-destructive">{outcome.error}</span>
                  )}
                </div>
              ))}
              {outcomes.length === 0 && <p className="text-xs text-muted-foreground">No per-workspace detail recorded for this broadcast.</p>}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

type Filter = "all" | "active" | "scheduled" | "open" | "unreachable";

const phaseOfState = (workspace: WorkspaceMaintenanceState) => (workspace.error ? "unreachable" : (workspace.settings?.phase ?? "off"));

export function PlatformAdminMaintenance() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filter>("all");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);

  // Twenty seconds: an operator sitting on this screen during a change window wants it to move on
  // its own, but each pass is one query per tenant database — so it polls, gently.
  const { data, isLoading } = useQuery({
    queryKey: ["platform-admin", "maintenance-fleet"],
    queryFn: platformOpsApi.fleetMaintenance,
    refetchInterval: 20_000
  });

  const workspaces = useMemo(() => data?.workspaces ?? [], [data]);
  const counts = useMemo(
    () => ({
      total: workspaces.length,
      active: workspaces.filter((w) => phaseOfState(w) === "active").length,
      scheduled: workspaces.filter((w) => phaseOfState(w) === "scheduled").length,
      open: workspaces.filter((w) => phaseOfState(w) === "off" || phaseOfState(w) === "expired").length,
      unreachable: workspaces.filter((w) => phaseOfState(w) === "unreachable").length
    }),
    [workspaces]
  );

  const shown = useMemo(() => {
    if (filter === "all") return workspaces;
    return workspaces.filter((workspace) => {
      const phase = phaseOfState(workspace);
      if (filter === "open") return phase === "off" || phase === "expired";
      return phase === filter;
    });
  }, [workspaces, filter]);

  const clear = useMutation({
    mutationFn: (ids: string[]) => platformOpsApi.broadcast({ organizationIds: ids, enabled: false, emailSuperAdmins: true }),
    onSuccess: (result) => {
      const failed = result.outcomes.filter((o) => !o.ok);
      const lifted = result.outcomes.length - failed.length;
      toast[failed.length ? "warning" : "success"](`Window lifted on ${lifted} workspace${lifted === 1 ? "" : "s"}`, {
        description: failed.length ? `Did not take: ${failed.map((f) => f.slug).join(", ")}` : "Everyone is back in."
      });
      void queryClient.invalidateQueries({ queryKey: ["platform-admin"] });
    },
    onError: (error) => toast.error("Not cleared", { description: errorMessageOf(error) })
  });

  const armedIds = workspaces.filter((workspace) => workspace.settings?.enabled).map((workspace) => workspace.organizationId);

  return (
    <ConsolePage
      eyebrow="Operations"
      title="Maintenance windows"
      description="One window, applied across the fleet. It writes each workspace's own maintenance row — so customers get exactly the lockout, redirect, notice and heartbeat their own administrator would have produced, and cannot switch it off from inside."
      actions={
        <Toolbar>
          {armedIds.length > 0 && (
            <Button variant="outline" className="gap-1.5" disabled={clear.isPending} onClick={() => clear.mutate(armedIds)}>
              <PlayCircle className="h-4 w-4" />
              {clear.isPending ? "Lifting…" : `Lift on ${armedIds.length}`}
            </Button>
          )}
          <Button
            className={`${PRIMARY_BTN} gap-1.5`}
            onClick={() => {
              setSelected([]);
              setDialogOpen(true);
            }}
          >
            <Radio className="h-4 w-4" />
            Arm a window
          </Button>
        </Toolbar>
      }
    >
      <KpiGrid>
        <KpiCard label="Workspaces" value={counts.total} icon={ShieldCheck} hint="Reachable and sign-in-able" />
        <KpiCard
          label="In maintenance"
          value={counts.active}
          icon={StopCircle}
          tone={counts.active ? "destructive" : "default"}
          hint="Locked to super admins right now"
          delay={0.04}
        />
        <KpiCard
          label="Scheduled"
          value={counts.scheduled}
          icon={CalendarClock}
          tone={counts.scheduled ? "warning" : "default"}
          hint="Window armed, not yet started"
          delay={0.08}
        />
        <KpiCard
          label="Unreachable"
          value={counts.unreachable}
          icon={AlertTriangle}
          tone={counts.unreachable ? "warning" : "default"}
          hint="Database did not answer"
          delay={0.12}
        />
      </KpiGrid>

      <ConsoleSection
        title="Every workspace"
        description="Read live from each tenant database — never cached, because a stale answer to “is everyone in maintenance yet?” is worse than a slow one."
        actions={
          <Toolbar>
            <SegmentedControl<Filter>
              ariaLabel="Filter workspaces by maintenance state"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "All", count: counts.total },
                { value: "active", label: "In maintenance", count: counts.active },
                { value: "scheduled", label: "Scheduled", count: counts.scheduled },
                { value: "open", label: "Open", count: counts.open },
                { value: "unreachable", label: "Unreachable", count: counts.unreachable }
              ]}
            />
            {selected.length > 0 && (
              <Button size="sm" className={`${PRIMARY_BTN} gap-1.5`} onClick={() => setDialogOpen(true)}>
                <Radio className="h-4 w-4" />
                Arm on {selected.length}
              </Button>
            )}
          </Toolbar>
        }
        flush
      >
        {isLoading ? (
          <div className="grid gap-2 p-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-12 w-full" />
            ))}
          </div>
        ) : shown.length === 0 ? (
          <div className="p-4">
            <EmptyState icon={ShieldCheck} title="Nothing here" description="No workspace is in that state." />
          </div>
        ) : (
          <ConsoleTable minWidth={880}>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10" />
                <TableHead>Workspace</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Window</TableHead>
                <TableHead>Message</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((workspace) => (
                <TableRow key={workspace.organizationId}>
                  <TableCell>
                    <Checkbox
                      aria-label={`Select ${workspace.name}`}
                      checked={selected.includes(workspace.organizationId)}
                      onCheckedChange={(checked) =>
                        setSelected((prev) => (checked ? [...prev, workspace.organizationId] : prev.filter((id) => id !== workspace.organizationId)))
                      }
                    />
                  </TableCell>
                  <TableCell className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{workspace.name}</p>
                    <p className="truncate font-mono text-[11px] text-muted-foreground">{workspace.slug}</p>
                  </TableCell>
                  <TableCell>
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <PhasePill state={workspace} />
                      {workspace.settings?.managedByPlatform && (
                        <Badge variant="info" className="gap-1" title="Read-only inside the workspace until the platform clears it.">
                          <Lock className="h-3 w-3" />
                          Platform-held
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                    {workspace.settings?.scheduledStartAt
                      ? `${shortDateTime(workspace.settings.scheduledStartAt)} → ${shortDateTime(workspace.settings.scheduledEndAt)}`
                      : "—"}
                  </TableCell>
                  <TableCell className="max-w-[16rem]">
                    <p className="truncate text-sm text-muted-foreground" title={workspace.settings?.message ?? workspace.error ?? undefined}>
                      {workspace.settings?.message || workspace.error || "—"}
                    </p>
                  </TableCell>
                  <TableCell className="text-right">
                    {workspace.settings?.enabled ? (
                      <Button size="sm" variant="outline" className="gap-1.5" disabled={clear.isPending} onClick={() => clear.mutate([workspace.organizationId])}>
                        <PlayCircle className="h-3.5 w-3.5" />
                        Lift
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1.5"
                        disabled={Boolean(workspace.error)}
                        onClick={() => {
                          setSelected([workspace.organizationId]);
                          setDialogOpen(true);
                        }}
                      >
                        <Radio className="h-3.5 w-3.5" />
                        Arm
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </ConsoleTable>
        )}
      </ConsoleSection>

      <ConsoleSection
        title="Broadcast history"
        description="Who armed what, over how many workspaces, and which ones did not take it. Open a row for the per-workspace detail."
        flush
      >
        {!data?.broadcasts.length ? (
          <div className="p-4">
            <EmptyState icon={Radio} title="No broadcasts yet" description="Arming a window from this page records it here." />
          </div>
        ) : (
          <ConsoleTable minWidth={1000}>
            <TableHeader>
              <TableRow>
                <TableHead>Action</TableHead>
                <TableHead>Sent</TableHead>
                <TableHead>Message / by</TableHead>
                <TableHead>Window</TableHead>
                <TableHead className="text-right">Applied</TableHead>
                <TableHead className="text-right">Failed</TableHead>
                <TableHead className="text-right">Notified</TableHead>
                <TableHead className="text-right">Emailed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.broadcasts.map((row) => (
                <BroadcastRow key={row.id} row={row} />
              ))}
            </TableBody>
          </ConsoleTable>
        )}
      </ConsoleSection>

      {/* Keyed on the selection so the dialog's initial state follows the row that opened it —
          a dialog that keeps last time's targets is how the wrong workspace gets taken down. */}
      {dialogOpen && <BroadcastDialog key={selected.join(",")} open={dialogOpen} onOpenChange={setDialogOpen} workspaces={workspaces} preselected={selected} />}
    </ConsolePage>
  );
}
