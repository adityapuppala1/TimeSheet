/**
 * The Sprints page — a project's time-boxed iterations, and the burndown for the one you pick.
 *
 * WHY PER PROJECT AND NOT ONE LIST: a sprint is project-scoped on the server because every
 * visibility rule in this app is, and "one active sprint per project" is the rule the API
 * enforces. A cross-project list would show the same person three "active" sprints and no way to
 * tell which project each burndown belongs to.
 *
 * WHY THE BURNDOWN IS THE CENTREPIECE: it is the one question a sprint answers that a ticket list
 * does not — are we on track? Its points come from `GET /sprints/:id/burndown`, which replays the
 * audited status changes on the server, so the headline percentage and the line are the same data.
 * Days that have not happened are gaps, not guesses; the ideal line is the only forecast drawn.
 *
 * WHY THE OFF STATE MIRRORS GOALS: same toggle family, same message shape. The sidebar hides the
 * item when the feature is off, but a bookmark still lands here and deserves the same explanation.
 *
 * WHO renders this: `App.tsx` at `/app/sprints`, gated on the `sprints` feature.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { CheckCircle2, Loader2, Lock, Plus, Timer, Trash2 } from "lucide-react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { permissions } from "@timesheet/shared";
import { PageHeader } from "../components/PageHeader";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { EmptyState } from "../components/ui/empty-state";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { Textarea } from "../components/ui/textarea";
import { toast } from "../components/ui/toaster";
import { nextSprintAction, SPRINT_STATUS_LABEL, sprintProgress, sprintRange } from "../lib/sprints";
import { usePlanningFeatures } from "../lib/use-planning";
import { cn } from "../lib/utils";
import { projectApi, sprintApi, type SprintRow } from "../services/api";
import { useAuthStore } from "../store/auth";
import { runInBackground } from "../lib/run-in-background";

const serverMessage = (err: any, fallback: string) => err?.response?.data?.message ?? fallback;
// Same values Insights uses — copied rather than imported because that page keeps them private.
const TOOLTIP_STYLE = {
  contentStyle: { background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, color: "hsl(var(--popover-foreground))" }
};
const GRID_STYLE = { strokeDasharray: "3 3", stroke: "hsl(var(--border))" };
const AXIS_STYLE = { stroke: "hsl(var(--muted-foreground))", fontSize: 12 };
const STATUS_VARIANT: Record<SprintRow["status"], "outline" | "default" | "secondary"> = { PLANNED: "outline", ACTIVE: "default", COMPLETED: "secondary" };

/** The one sentence over the chart. Counts-only says so, because "0 points" would read as done. */
function burndownHeadline(progress: ReturnType<typeof sprintProgress> | null): string {
  if (!progress) return "Pick a sprint to see how it is burning down.";
  if (progress.countsOnly) return `${progress.remaining} of ${progress.total} tickets still open · ${progress.percentDone}% done (no estimates yet, so this reads tickets, not points)`;
  return `${progress.remaining} of ${progress.total} points still open · ${progress.percentDone}% done`;
}

function PageTitle() {
  return <PageHeader title="Sprints" description="Time-boxed iterations per project, with a burndown that is replayed from what actually happened." icon={Timer} />;
}

function carryOverSummary(count: number, to: string | undefined, rows: SprintRow[]): string {
  if (count === 0) return "Every ticket in it was finished.";
  const where = !to || to === "backlog" ? "the backlog" : (rows.find((r) => r.id === to)?.name ?? "the next sprint");
  return `${count} unfinished ticket${count === 1 ? "" : "s"} moved to ${where}.`;
}

export function SprintsPage() {
  const { features } = usePlanningFeatures();
  const user = useAuthStore((s) => s.user);
  const canManage = Boolean(user?.permissions.includes(permissions.PLAN_WRITE));
  const queryClient = useQueryClient();
  const [projectId, setProjectId] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<SprintRow | "new" | null>(null);

  const projects = useQuery({ queryKey: ["projects"], queryFn: () => projectApi.list(), enabled: features.sprints });
  const effectiveProjectId = projectId || (projects.data?.[0]?.id as string | undefined) || "";
  const sprints = useQuery({
    queryKey: ["sprints", effectiveProjectId],
    queryFn: () => sprintApi.list(effectiveProjectId),
    enabled: features.sprints && Boolean(effectiveProjectId)
  });
  const rows = useMemo(() => sprints.data ?? [], [sprints.data]);
  /** The sprint whose completion is being reviewed, and where its unfinished tickets go. */
  const [completing, setCompleting] = useState<SprintRow | null>(null);
  const [carryTo, setCarryTo] = useState("backlog");
  // The active sprint is the natural selection; otherwise the most recent.
  const selected = useMemo(() => rows.find((s) => s.id === selectedId) ?? rows.find((s) => s.status === "ACTIVE") ?? rows[0] ?? null, [rows, selectedId]);
  const burndown = useQuery({
    queryKey: ["sprints", selected?.id, "burndown"],
    queryFn: () => sprintApi.burndown(selected!.id),
    enabled: Boolean(selected)
  });

  const invalidate = () => {
    runInBackground(queryClient.invalidateQueries({ queryKey: ["sprints"] }));
    runInBackground(queryClient.invalidateQueries({ queryKey: ["tickets"] }));
  };
  const transition = useMutation({
    mutationFn: ({ id, to, carryOverTo }: { id: string; to: SprintRow["status"]; carryOverTo?: string }) =>
      sprintApi.update(id, { status: to, ...(carryOverTo ? { carryOverTo } : {}) }),
    onSuccess: (s) => {
      setCompleting(null);
      if (s.status === "ACTIVE") toast.success("Sprint started");
      else toast.success("Sprint completed", { description: carryOverSummary(s.carriedOver ?? 0, s.carriedOverTo, rows) });
      invalidate();
    },
    onError: (err) => toast.error("Could not change the sprint", { description: serverMessage(err, "Try again.") })
  });
  const remove = useMutation({
    mutationFn: (id: string) => sprintApi.remove(id),
    onSuccess: () => {
      toast.success("Sprint deleted", { description: "Its tickets are un-planned, not deleted." });
      setSelectedId(null);
      invalidate();
    },
    onError: (err) => toast.error("Could not delete", { description: serverMessage(err, "Try again.") })
  });

  if (!features.sprints) {
    return (
      <div className="space-y-4">
        <PageTitle />
        <Card className="animate-fade-in">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <span className="grid h-12 w-12 place-items-center rounded-full bg-muted text-muted-foreground" aria-hidden>
              <Lock className="h-5 w-5" />
            </span>
            <div className="space-y-1">
              <p className="font-medium">Sprints are off for this workspace</p>
              <p className="max-w-md text-sm text-muted-foreground">
                A super admin can turn them on under <strong>Workspace Settings → Planning</strong>. Sprints need the planning layer on
                as well.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const progress = burndown.data ? sprintProgress(burndown.data) : null;
  const chartData = (burndown.data?.points ?? []).map((p) => ({
    date: p.date.slice(5),
    remaining: progress?.countsOnly ? p.remainingCount : p.remainingPoints,
    ideal: progress?.countsOnly ? null : p.idealPoints
  }));

  const carryTargets = completing ? rows.filter((r) => r.id !== completing.id && r.status !== "COMPLETED") : [];

  return (
    <div className="space-y-4">
      <Dialog open={completing !== null} onOpenChange={(open) => !open && setCompleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Complete {completing?.name}?</DialogTitle>
            <DialogDescription>
              A completed sprint can't be reopened. Its tickets that aren't resolved or closed move to the place you pick here.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="carry-to">Move unfinished tickets to</Label>
            <Select value={carryTo} onValueChange={setCarryTo}>
              <SelectTrigger id="carry-to">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="backlog">The backlog (no sprint)</SelectItem>
                {carryTargets.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name} ({SPRINT_STATUS_LABEL[r.status].toLowerCase()})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCompleting(null)}>
              Keep it running
            </Button>
            <Button
              disabled={transition.isPending || !completing}
              onClick={() => completing && transition.mutate({ id: completing.id, to: "COMPLETED", carryOverTo: carryTo })}
            >
              {transition.isPending ? "Completing…" : "Complete sprint"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <PageHeader
        title="Sprints"
        description="Time-boxed iterations per project, with a burndown that is replayed from what actually happened."
        icon={Timer}
        actions={
          <>
            <div className="grid gap-1.5">
              <Label htmlFor="sprint-project" className="sr-only">Project</Label>
              <Select value={effectiveProjectId} onValueChange={(v) => { setProjectId(v); setSelectedId(null); }}>
                <SelectTrigger id="sprint-project" className="w-[220px]"><SelectValue placeholder="Choose a project" /></SelectTrigger>
                <SelectContent>
                  {(projects.data ?? []).map((p: any) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {canManage && effectiveProjectId && (
              <Button onClick={() => setEditing("new")}>
                <Plus className="h-4 w-4" /> New sprint
              </Button>
            )}
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Iterations</CardTitle>
            <CardDescription>Newest first. One sprint is active per project at a time.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            {sprints.isLoading && <Skeleton className="h-24 w-full" />}
            {!sprints.isLoading && rows.length === 0 && (
              <EmptyState
                compact
                icon={Timer}
                title="No sprints yet"
                description={canManage ? "Create the first iteration for this project." : "Nobody has planned an iteration for this project yet."}
                action={canManage && effectiveProjectId ? <Button variant="outline" size="sm" className="h-[44px]" onClick={() => setEditing("new")}>New sprint</Button> : undefined}
              />
            )}
            {rows.map((s) => {
              const isSelected = selected?.id === s.id;
              const action = nextSprintAction(s.status);
              return (
                <div key={s.id} data-sprint-row className={cn("rounded-lg border bg-card p-3 transition-colors", isSelected ? "border-primary/60 shadow-xs" : "hover:border-primary/30")}>
                  <button type="button" className="w-full text-left" onClick={() => setSelectedId(s.id)} aria-pressed={isSelected}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold">{s.name}</span>
                      <Badge variant={STATUS_VARIANT[s.status]}>{SPRINT_STATUS_LABEL[s.status]}</Badge>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {sprintRange(s.startDate, s.endDate)} · {s.ticketCount} ticket{s.ticketCount === 1 ? "" : "s"} · {s.totalPoints} pt
                    </p>
                    {s.goal && <p className="mt-1 text-sm text-muted-foreground">{s.goal}</p>}
                  </button>
                  {canManage && (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {action && (
                        <Button
                          size="sm"
                          variant={s.status === "PLANNED" ? "default" : "outline"}
                          className="h-[44px]"
                          disabled={transition.isPending}
                          onClick={() => {
                            // Completing is final and moves tickets, so it is reviewed first; starting is not.
                            if (action.to === "COMPLETED") {
                              setCarryTo("backlog");
                              setCompleting(s);
                            } else transition.mutate({ id: s.id, to: action.to });
                          }}
                        >
                          {s.status === "ACTIVE" && <CheckCircle2 className="h-3.5 w-3.5" />}
                          {action.label}
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" className="h-[44px]" onClick={() => setEditing(s)}>Edit</Button>
                      <Button size="sm" variant="ghost" className="h-[44px] text-muted-foreground hover:text-destructive" aria-label={`Delete ${s.name}`} disabled={remove.isPending} onClick={() => remove.mutate(s.id)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{selected ? `Burndown — ${selected.name}` : "Burndown"}</CardTitle>
            <CardDescription>{burndownHeadline(progress)}</CardDescription>
          </CardHeader>
          <CardContent>
            {burndown.isLoading && <Skeleton className="h-72 w-full" />}
            {!burndown.isLoading && !selected && <EmptyState compact icon={Timer} title="No sprint selected" />}
            {!burndown.isLoading && selected && chartData.length > 0 && (
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData}>
                    <CartesianGrid {...GRID_STYLE} />
                    <XAxis dataKey="date" {...AXIS_STYLE} />
                    <YAxis {...AXIS_STYLE} allowDecimals={!progress?.countsOnly} />
                    <RTooltip {...TOOLTIP_STYLE} />
                    <Legend wrapperStyle={{ fontSize: 12, color: "hsl(var(--muted-foreground))" }} />
                    <Line type="monotone" dataKey="remaining" name={progress?.countsOnly ? "Open tickets" : "Remaining points"} stroke="hsl(var(--primary))" strokeWidth={2} dot={{ r: 3 }} connectNulls={false} />
                    {!progress?.countsOnly && <Line type="linear" dataKey="ideal" name="Ideal" stroke="hsl(var(--muted-foreground))" strokeDasharray="4 4" strokeWidth={1.5} dot={false} />}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {editing && effectiveProjectId && (
        <SprintDialog projectId={effectiveProjectId} sprint={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={invalidate} />
      )}
    </div>
  );
}

function todayLocal(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function SprintDialog({ projectId, sprint, onClose, onSaved }: Readonly<{ projectId: string; sprint: SprintRow | null; onClose: () => void; onSaved: () => void }>) {
  const [name, setName] = useState(sprint?.name ?? "");
  const [goal, setGoal] = useState(sprint?.goal ?? "");
  const [startDate, setStartDate] = useState(sprint ? sprint.startDate.slice(0, 10) : todayLocal());
  const [endDate, setEndDate] = useState(sprint ? sprint.endDate.slice(0, 10) : todayLocal(13));
  const save = useMutation({
    mutationFn: () =>
      sprint
        ? sprintApi.update(sprint.id, { name: name.trim(), goal: goal.trim() || null, startDate, endDate })
        : sprintApi.create({ projectId, name: name.trim(), goal: goal.trim() || null, startDate, endDate }),
    onSuccess: () => {
      toast.success(sprint ? "Sprint updated" : "Sprint created");
      onSaved();
      onClose();
    },
    onError: (err) => toast.error("Could not save the sprint", { description: serverMessage(err, "Try again.") })
  });
  const invalid = !name.trim() || endDate < startDate;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{sprint ? "Edit sprint" : "New sprint"}</DialogTitle>
          <DialogDescription>Two weeks is the usual length. Dates are calendar days; the sprint ends at the end of its last day.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="sprint-name">Name</Label>
            <Input id="sprint-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Sprint 12" maxLength={120} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="sprint-goal">Goal (optional)</Label>
            <Textarea id="sprint-goal" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="What done looks like at the end of this sprint." maxLength={600} rows={2} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="sprint-start">Starts</Label>
              <Input id="sprint-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="sprint-end">Ends</Label>
              <Input id="sprint-end" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </div>
          </div>
          {endDate < startDate && <p className="text-xs text-destructive">A sprint cannot end before it starts.</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={invalid || save.isPending} onClick={() => save.mutate()}>
            {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {sprint ? "Save" : "Create sprint"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
