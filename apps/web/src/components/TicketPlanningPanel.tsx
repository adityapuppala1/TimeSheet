/**
 * WHAT: the "Plan" tab on the ticket detail sheet — schedule, hierarchy, baseline and scheduling
 * dependencies for one work item.
 *
 * WHY THIS EXISTS ALONGSIDE THE TIMELINE: the timeline can only move a bar that already has
 * dates. Something has to give an item its FIRST date, and dragging a hatched "not scheduled"
 * placeholder would mean the act of looking at a plan quietly commits to one. So the timeline
 * edits existing schedules and this panel creates them — the same split as a map that lets you
 * drag a pin but needs an address to place one.
 *
 * WHY DEPENDENCIES LIVE HERE AND NOT ON THE "LINKED" TAB: `TicketLink` carries both kinds of
 * relationship, but they answer different questions. "Duplicate of" is about what a ticket IS;
 * "must finish before" is about WHEN it happens, and only the second moves dates. Mixing them in
 * one list would make a scheduling constraint look like a cross-reference.
 *
 * WHO renders this: the Plan tab in `pages/Tickets.tsx`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarRange, Diamond, Flag, Link2, Loader2, Lock, Plus, Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { permissions } from "@timesheet/shared";
import { cn } from "../lib/utils";
import { usePlanningFeatures } from "../lib/use-planning";
import { planApi, ticketApi, type PlanDependencyType, type TicketDetail } from "../services/api";
import { useAuthStore } from "../store/auth";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Progress } from "./ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Switch } from "./ui/switch";
import { toast } from "./ui/toaster";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

const serverMessage = (err: any, fallback: string) => err?.response?.data?.message ?? fallback;

/** The five scheduling relationships, labelled the way a person would say them. BLOCKS is listed
 *  first and described as finish-to-start because that is what it has always meant here, and what
 *  the solver treats it as. */
const DEPENDENCY_TYPES: Array<{ value: PlanDependencyType; label: string; hint: string }> = [
  { value: "FINISH_TO_START", label: "must finish before this starts", hint: "The classic dependency." },
  { value: "START_TO_START", label: "must start before this starts", hint: "Both run together, one leads." },
  { value: "FINISH_TO_FINISH", label: "must finish before this finishes", hint: "They land together." },
  { value: "START_TO_FINISH", label: "must start before this finishes", hint: "Rare — usually a handover." }
];

const dayOnly = (value?: string | null) => (value ? value.slice(0, 10) : "");

export function TicketPlanningPanel({ ticket }: { ticket: TicketDetail }) {
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();
  const { features } = usePlanningFeatures();
  const canEdit = Boolean(user?.permissions.includes(permissions.PLAN_WRITE));

  const [start, setStart] = useState(dayOnly(ticket.startDate));
  const [end, setEnd] = useState(dayOnly(ticket.endDate));
  const [hours, setHours] = useState(ticket.estimatedHours != null ? String(ticket.estimatedHours) : "");
  const [progress, setProgress] = useState(ticket.progressPct != null ? String(ticket.progressPct) : "");

  useEffect(() => {
    setStart(dayOnly(ticket.startDate));
    setEnd(dayOnly(ticket.endDate));
    setHours(ticket.estimatedHours != null ? String(ticket.estimatedHours) : "");
    setProgress(ticket.progressPct != null ? String(ticket.progressPct) : "");
  }, [ticket.id, ticket.startDate, ticket.endDate, ticket.estimatedHours, ticket.progressPct]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["ticket", ticket.id] });
    queryClient.invalidateQueries({ queryKey: ["tickets"] });
    queryClient.invalidateQueries({ queryKey: ["plan"] });
  };

  const update = useMutation({
    mutationFn: (patch: Record<string, unknown>) => planApi.updateItem(ticket.id, patch),
    onSuccess: () => {
      toast.success("Plan updated");
      invalidate();
    },
    onError: (err: any) => toast.error("Could not save", { description: serverMessage(err, "Try again.") })
  });

  const baseline = useMutation({
    mutationFn: (clear: boolean) => planApi.setBaseline(ticket.id, clear),
    onSuccess: (_data, clear) => {
      toast.success(clear ? "Baseline cleared" : "Baseline set", {
        description: clear ? undefined : "Slip is now measured against these dates until you set it again."
      });
      invalidate();
    },
    onError: (err: any) => toast.error("Could not set baseline", { description: serverMessage(err, "Try again.") })
  });

  // Candidate parents/predecessors: other open tickets in the same project. Scoped to the project
  // because the API refuses a cross-project parent — offering one would be an error waiting to
  // be clicked.
  const siblings = useQuery({
    queryKey: ["tickets", "plan-candidates", ticket.project.id],
    queryFn: () => ticketApi.list({ projectId: ticket.project.id, pageSize: 200 } as any),
    enabled: canEdit
  });
  const candidates = ((siblings.data as any)?.rows ?? (siblings.data as any) ?? []).filter(
    (t: any) => t.id !== ticket.id
  );

  const dependencies = useQuery({
    queryKey: ["plan", "dependencies", ticket.project.id],
    queryFn: () => planApi.dependencies([ticket.project.id]),
    enabled: features.timeline
  });
  const mine = (dependencies.data ?? []).filter((d) => d.fromId === ticket.id || d.toId === ticket.id);

  const [newDep, setNewDep] = useState<{ otherId: string; type: PlanDependencyType; lag: string }>({
    otherId: "",
    type: "FINISH_TO_START",
    lag: "0"
  });

  const addDep = useMutation({
    mutationFn: () =>
      planApi.addDependency({
        // The picker reads "X must finish before this starts", so the CHOSEN ticket is the
        // predecessor and this one is the successor.
        fromId: newDep.otherId,
        toId: ticket.id,
        type: newDep.type,
        lagDays: Number(newDep.lag) || 0
      }),
    onSuccess: () => {
      toast.success("Dependency added");
      setNewDep({ otherId: "", type: "FINISH_TO_START", lag: "0" });
      invalidate();
      queryClient.invalidateQueries({ queryKey: ["plan", "dependencies"] });
    },
    onError: (err: any) =>
      toast.error("Could not add dependency", { description: serverMessage(err, "Try again.") })
  });

  const removeDep = useMutation({
    mutationFn: (id: string) => planApi.removeDependency(id),
    onSuccess: () => {
      toast.success("Dependency removed");
      invalidate();
      queryClient.invalidateQueries({ queryKey: ["plan", "dependencies"] });
    },
    onError: (err: any) => toast.error("Could not remove", { description: serverMessage(err, "Try again.") })
  });

  if (!features.planning) {
    return (
      <div className="rounded-lg border border-dashed border-border p-6 text-center">
        <CalendarRange className="mx-auto h-6 w-6 text-muted-foreground" />
        <p className="mt-2 text-sm font-medium">Planning is off for this workspace</p>
        <p className="mt-1 text-xs text-muted-foreground">
          A super admin can turn it on in Workspace Settings → Planning. Nothing about this ticket changes when they do.
        </p>
      </div>
    );
  }

  const datesDirty = start !== dayOnly(ticket.startDate) || end !== dayOnly(ticket.endDate);
  const endBeforeStart = Boolean(start && end && end < start);
  const hasBaseline = Boolean(ticket.baselineStartDate && ticket.baselineEndDate);

  return (
    <div className="grid gap-5">
      {/* Schedule */}
      <div className="grid gap-3">
        <div className="flex items-center justify-between gap-2">
          <Label className="text-xs uppercase text-muted-foreground">Schedule</Label>
          {!canEdit && (
            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
              <Lock className="h-3 w-3" /> read-only
            </span>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label className="text-xs">Start</Label>
            <Input type="date" value={start} disabled={!canEdit} onChange={(e) => setStart(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs">{ticket.isMilestone ? "Date" : "End"}</Label>
            <Input
              type="date"
              value={ticket.isMilestone ? start : end}
              disabled={!canEdit || ticket.isMilestone}
              onChange={(e) => setEnd(e.target.value)}
            />
          </div>
        </div>
        {endBeforeStart && (
          <p className="flex items-center gap-1.5 text-xs text-destructive">
            <TriangleAlert className="h-3 w-3" />
            The end date is before the start date.
          </p>
        )}
        <p className="text-[11px] text-muted-foreground">
          Separate from the SLA due date, which is derived from priority. This is when the work is scheduled to happen;
          that is when a response becomes overdue.
        </p>

        {canEdit && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={!datesDirty || endBeforeStart || update.isPending}
              onClick={() => update.mutate({ startDate: start || null, endDate: end || null })}
            >
              {update.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
              Save dates
            </Button>
            {(ticket.startDate || ticket.endDate) && (
              <Button
                size="sm"
                variant="ghost"
                disabled={update.isPending}
                onClick={() => {
                  setStart("");
                  setEnd("");
                  update.mutate({ startDate: null, endDate: null });
                }}
              >
                Unschedule
              </Button>
            )}
            <label className="ml-auto flex items-center gap-2 text-xs">
              <Switch
                checked={Boolean(ticket.isMilestone)}
                onCheckedChange={(v) => update.mutate({ isMilestone: v })}
              />
              <span className="inline-flex items-center gap-1">
                <Diamond className="h-3 w-3 text-plan-today" /> Milestone
              </span>
            </label>
          </div>
        )}
      </div>

      {/* Effort & progress */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label className="text-xs">Estimated hours</Label>
          <div className="flex gap-2">
            <Input
              type="number"
              min={0}
              step="0.5"
              value={hours}
              disabled={!canEdit}
              onChange={(e) => setHours(e.target.value)}
            />
            {canEdit && (
              <Button
                size="sm"
                variant="outline"
                disabled={update.isPending}
                onClick={() => update.mutate({ estimatedHours: hours === "" ? null : Number(hours) })}
              >
                Save
              </Button>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">
            Drives the effort-weighted roll-up on parents, so a big task counts for more than a small one.
          </p>
        </div>
        <div className="grid gap-1.5">
          <Label className="text-xs">Progress override</Label>
          <div className="flex gap-2">
            <Input
              type="number"
              min={0}
              max={100}
              placeholder="auto"
              value={progress}
              disabled={!canEdit}
              onChange={(e) => setProgress(e.target.value)}
            />
            {canEdit && (
              <Button
                size="sm"
                variant="outline"
                disabled={update.isPending}
                onClick={() => update.mutate({ progressPct: progress === "" ? null : Number(progress) })}
              >
                Save
              </Button>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">
            Leave blank to derive it from status and logged-vs-estimated hours.
          </p>
        </div>
      </div>

      {/* Baseline */}
      <div className="grid gap-2 rounded-lg border border-border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label className="text-xs uppercase text-muted-foreground">Baseline</Label>
          {hasBaseline ? (
            <Badge variant="secondary">
              {dayOnly(ticket.baselineStartDate)} → {dayOnly(ticket.baselineEndDate)}
            </Badge>
          ) : (
            <Badge variant="outline">Not set</Badge>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">
          Freezes today&apos;s dates as &ldquo;the agreed plan&rdquo;. Slip is measured against them and never refreshes
          on its own — a baseline that moved with the plan would make everything look permanently on time.
        </p>
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={baseline.isPending || (!ticket.startDate && !ticket.endDate)}
              onClick={() => baseline.mutate(false)}
            >
              <Flag className="mr-1.5 h-3.5 w-3.5" />
              {hasBaseline ? "Re-baseline" : "Set baseline"}
            </Button>
            {hasBaseline && (
              <Button size="sm" variant="ghost" disabled={baseline.isPending} onClick={() => baseline.mutate(true)}>
                Clear
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Hierarchy */}
      <div className="grid gap-2">
        <Label className="text-xs uppercase text-muted-foreground">Hierarchy</Label>
        {ticket.parent ? (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Child of</span>
            <Badge variant="secondary">
              {ticket.parent.key} — {ticket.parent.title}
            </Badge>
            {canEdit && (
              <Button size="sm" variant="ghost" onClick={() => update.mutate({ parentId: null })}>
                Detach
              </Button>
            )}
          </div>
        ) : canEdit ? (
          <Select value="" onValueChange={(v) => update.mutate({ parentId: v })}>
            <SelectTrigger className="h-8 w-full max-w-sm text-xs">
              <SelectValue placeholder="Make this a child of…" />
            </SelectTrigger>
            <SelectContent>
              {candidates.slice(0, 100).map((t: any) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.key} — {t.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <p className="text-xs text-muted-foreground">Top-level item.</p>
        )}

        {(ticket.children?.length ?? 0) > 0 && (
          <div className="grid gap-1.5">
            <p className="text-xs text-muted-foreground">{ticket.children!.length} child item(s)</p>
            {ticket.children!.map((child) => (
              <div key={child.id} className="flex items-center gap-2 rounded border border-border px-2 py-1.5 text-xs">
                {child.isMilestone && <Diamond className="h-3 w-3 text-plan-today" />}
                <span className="font-mono text-muted-foreground">{child.key}</span>
                <span className="truncate">{child.title}</span>
                {child.progressPct !== null && <Progress value={child.progressPct} className="ml-auto h-1 w-16" />}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Dependencies */}
      <div className="grid gap-2">
        <Label className="text-xs uppercase text-muted-foreground">Scheduling dependencies</Label>
        {mine.length === 0 ? (
          <p className="text-xs text-muted-foreground">None. This item can start whenever it is scheduled to.</p>
        ) : (
          <div className="grid gap-1.5">
            {mine.map((dep) => {
              const isSuccessor = dep.toId === ticket.id;
              const otherId = isSuccessor ? dep.fromId : dep.toId;
              const other = candidates.find((c: any) => c.id === otherId);
              const label = DEPENDENCY_TYPES.find((t) => t.value === dep.type)?.label ?? dep.type;
              return (
                <div key={dep.id} className="flex items-center gap-2 rounded border border-border px-2 py-1.5 text-xs">
                  <Link2 className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <span className="truncate">
                    {isSuccessor ? (
                      <>
                        <span className="font-mono">{other?.key ?? otherId.slice(0, 8)}</span> {label}
                      </>
                    ) : (
                      <>
                        This {label.replace("this", "")} <span className="font-mono">{other?.key ?? otherId.slice(0, 8)}</span>
                      </>
                    )}
                  </span>
                  {dep.lagDays !== 0 && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge variant="outline">
                          {dep.lagDays > 0 ? `+${dep.lagDays}d` : `${dep.lagDays}d`}
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent>
                        <span className="text-xs">
                          {dep.lagDays > 0 ? "Waiting time after the predecessor" : "Overlap — starts before it finishes"}
                        </span>
                      </TooltipContent>
                    </Tooltip>
                  )}
                  {canEdit && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-auto h-6 px-1.5"
                      disabled={removeDep.isPending}
                      onClick={() => removeDep.mutate(dep.id)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {canEdit && (
          <div className="grid gap-2 rounded-lg border border-dashed border-border p-2.5 sm:grid-cols-[1fr_auto_70px_auto] sm:items-end">
            <div className="grid gap-1">
              <Label className="text-[11px]">Predecessor</Label>
              <Select value={newDep.otherId} onValueChange={(v) => setNewDep({ ...newDep, otherId: v })}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Pick a work item" />
                </SelectTrigger>
                <SelectContent>
                  {candidates.slice(0, 100).map((t: any) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.key} — {t.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1">
              <Label className="text-[11px]">Relationship</Label>
              <Select value={newDep.type} onValueChange={(v) => setNewDep({ ...newDep, type: v as PlanDependencyType })}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DEPENDENCY_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1">
              <Label className="text-[11px]">Lag</Label>
              <Input
                className="h-8 text-xs"
                type="number"
                value={newDep.lag}
                onChange={(e) => setNewDep({ ...newDep, lag: e.target.value })}
              />
            </div>
            <Button size="sm" disabled={!newDep.otherId || addDep.isPending} onClick={() => addDep.mutate()}>
              {addDep.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            </Button>
          </div>
        )}
        <p className={cn("text-[11px] text-muted-foreground", !canEdit && "hidden")}>
          A dependency that would create a loop is refused when you add it, naming the items involved — the timeline
          never silently ignores one.
        </p>
      </div>
    </div>
  );
}
