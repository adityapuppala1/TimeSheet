/**
 * The Goals page — objectives, their key results, and progress that is MEASURED rather than typed.
 *
 * WHY THE MEASURED SOURCE IS THE HEADLINE OF EVERY CARD: a goal whose number somebody types is a
 * sentence with a percentage attached, and it drifts toward comfortable by quarter-end. Wiring a
 * goal to approved hours, billed spend, tickets closed, on-time rate, SLA breaches or project risk
 * means the number comes from the same tables the portfolio and the client-facing attestation
 * read, so nobody can talk it up in a review.
 *
 * WHY AN OVERRIDE SHOWS BOTH NUMBERS SIDE BY SIDE: the product allows a human to disagree with the
 * measurement (some quarters genuinely need it), but an override that REPLACED the measured figure
 * would be an unrecorded adjustment — exactly what the measured design exists to prevent. So the
 * stated figure is the headline and the measured one sits next to it, with who said so and why.
 *
 * WHY "not measurable" IS RENDERED AS WORDS, NEVER AS 0%: "no data in this period" and "0% done"
 * are opposite messages that look identical as a zero. Same rule the dashboard widgets follow.
 *
 * WHO renders this: `App.tsx` at `/app/goals`, gated on the `goals` feature.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CalendarRange,
  CheckCircle2,
  ChevronDown,
  Clock,
  Coins,
  Gauge,
  Loader2,
  Lock,
  PencilLine,
  Plus,
  ShieldAlert,
  SquareStack,
  Target,
  TicketCheck,
  Timer,
  TrendingUp,
  Trash2
} from "lucide-react";
import { useMemo, useState } from "react";
import { permissions } from "@timesheet/shared";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Progress } from "../components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { StatCard } from "../components/ui/stat-card";
import { Textarea } from "../components/ui/textarea";
import { toast } from "../components/ui/toaster";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/utils";
import { usePlanningFeatures } from "../lib/use-planning";
import { useAuthStore } from "../store/auth";
import {
  goalApi,
  projectApi,
  type GoalPayload,
  type GoalProgressSourceValue,
  type GoalRow,
  type GoalStatusValue
} from "../services/api";

const serverMessage = (err: any, fallback: string) => err?.response?.data?.message ?? fallback;

/** The closed source catalogue, mirrored from goal-progress.service.ts. Each entry states what the
 *  number MEANS, because that is what somebody picking a source needs to know. */
const SOURCES: Array<{
  value: GoalProgressSourceValue;
  label: string;
  unitHint: string;
  icon: typeof Target;
  blurb: string;
}> = [
  { value: "MANUAL", label: "Stated manually", unitHint: "%", icon: PencilLine, blurb: "You type the percentage. Use it when the outcome isn't instrumented." },
  { value: "APPROVED_HOURS", label: "Approved hours", unitHint: "h", icon: Clock, blurb: "Sum of approved timesheet hours in the period." },
  { value: "BUDGET_SPEND", label: "Budget spend", unitHint: "currency", icon: Coins, blurb: "Billed amount from the rate snapshots taken at approval. Stay under the target." },
  { value: "TICKETS_CLOSED", label: "Tickets closed", unitHint: "tickets", icon: TicketCheck, blurb: "Count of tickets closed in the period." },
  { value: "ON_TIME_RATE", label: "On-time rate", unitHint: "%", icon: Timer, blurb: "Share of closed tickets that met their planned date." },
  { value: "SLA_BREACHES", label: "SLA breaches", unitHint: "breaches", icon: ShieldAlert, blurb: "Escalations recorded in the period. Stay under the target." },
  { value: "RISK_SCORE", label: "Project risk", unitHint: "score", icon: Gauge, blurb: "Latest risk score across linked projects. Stay under the target." }
];

const sourceMeta = (value: GoalProgressSourceValue) => SOURCES.find((s) => s.value === value) ?? SOURCES[0];

const HEALTH_STYLE = {
  ON_TRACK: { label: "On track", dot: "bg-risk-green", badge: "success" as const },
  AT_RISK: { label: "At risk", dot: "bg-risk-amber", badge: "warning" as const },
  OFF_TRACK: { label: "Off track", dot: "bg-risk-red", badge: "destructive" as const }
};

const STATUS_LABEL: Record<GoalStatusValue, string> = { ACTIVE: "Active", ACHIEVED: "Achieved", CLOSED: "Closed" };

/** Grouped digits, because a target like 800000 is unreadable at a glance and this is a number
 *  somebody signs off on. The unit is a label the API never does arithmetic with, so it is simply
 *  appended — except "%", which reads wrong with a space. */
const formatValue = (value: number | null, unit: string | null) => {
  if (value === null) return "—";
  const grouped = new Intl.NumberFormat(undefined, {
    maximumFractionDigits: Number.isInteger(value) ? 0 : 2
  }).format(value);
  if (!unit) return grouped;
  return unit === "%" ? `${grouped}%` : `${grouped} ${unit}`;
};

const periodLabel = (start: string | null, end: string | null) => {
  if (!start && !end) return "No period set";
  const fmt = (d: string) => new Date(d).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  if (start && end) return `${fmt(start)} → ${fmt(end)}`;
  return start ? `From ${fmt(start)}` : `Until ${fmt(end!)}`;
};

/**
 * The headline number, and the one place the "never render unavailable as zero" rule lives.
 *
 * Extracted from GoalCard rather than inlined: this is where every honesty decision about the
 * figure is made (no percentage for a ceiling, no "of —" for a manual goal, words when nothing
 * could be measured), and those belong somewhere a reviewer can read end to end.
 */
function GoalNumber({ goal }: Readonly<{ goal: GoalRow }>) {
  const pct = goal.effectiveProgressPct;

  if (goal.measurement.unavailable && !goal.override) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-dashed bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        <span>Not measurable yet — {goal.measurement.unavailableReason}.</span>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-2xl font-semibold tabular-nums">
          {pct === null ? formatValue(goal.measurement.currentValue, goal.unit) : `${pct}%`}
        </span>
        {/* A manual goal has no target by construction (the API refuses one), so there is nothing
            to render "of" — printing "of —" was noise on the very card whose number is already the
            least trustworthy one on the page. */}
        {goal.progressSource !== "MANUAL" && (
          <span className="text-xs text-muted-foreground">
            {goal.direction === "AT_MOST" ? "of a ceiling of " : "of "}
            {formatValue(goal.targetValue, goal.unit)}
            {goal.measurement.currentValue !== null && <> · measured {formatValue(goal.measurement.currentValue, goal.unit)}</>}
            {/* An override can sit on top of a measurement that could not be taken. Saying so is
                the honest version — otherwise the stated number looks corroborated. */}
            {goal.measurement.unavailable && <> · not measurable ({goal.measurement.unavailableReason})</>}
          </span>
        )}
      </div>
      {pct !== null && <Progress value={pct} className="h-2 transition-all duration-500" aria-label={`${goal.title} progress`} />}
    </div>
  );
}

/** One goal, as a card. Objectives render their key results nested inside so the tree is visible
 *  without a second navigation — at two levels deep a tree does not need a tree widget. */
function GoalCard({
  goal,
  canManage,
  depth,
  onEdit,
  onOverride,
  onDelete,
  children
}: Readonly<{
  goal: GoalRow;
  canManage: boolean;
  depth: number;
  onEdit: (goal: GoalRow) => void;
  onOverride: (goal: GoalRow) => void;
  onDelete: (goal: GoalRow) => void;
  children?: React.ReactNode;
}>) {
  const [open, setOpen] = useState(true);
  const meta = sourceMeta(goal.progressSource);
  const Icon = meta.icon;
  const health = goal.measurement.health ? HEALTH_STYLE[goal.measurement.health] : null;
  const hasChildren = goal._count.children > 0;

  return (
    <div className={cn("animate-fade-in", depth > 0 && "ml-0 sm:ml-6")}>
      <Card
        className={cn(
          "overflow-hidden transition-shadow duration-200 hover:shadow-md",
          depth > 0 && "border-dashed",
          goal.status !== "ACTIVE" && "opacity-75"
        )}
      >
        <CardHeader className="gap-2 pb-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="flex min-w-0 items-start gap-2.5">
              <span
                className={cn(
                  "mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg",
                  depth > 0 ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary"
                )}
                aria-hidden
              >
                {depth > 0 ? <SquareStack className="h-4 w-4" /> : <Target className="h-4 w-4" />}
              </span>
              <div className="min-w-0">
                <CardTitle className="text-base leading-snug">{goal.title}</CardTitle>
                <CardDescription className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                  <span className="inline-flex items-center gap-1">
                    <Icon className="h-3 w-3" />
                    {meta.label}
                  </span>
                  <span aria-hidden>·</span>
                  <span className="inline-flex items-center gap-1">
                    <CalendarRange className="h-3 w-3" />
                    {periodLabel(goal.startDate, goal.endDate)}
                  </span>
                  {goal.owner && (
                    <>
                      <span aria-hidden>·</span>
                      <span className="truncate">{goal.owner.name}</span>
                    </>
                  )}
                </CardDescription>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {goal.status !== "ACTIVE" && <Badge variant="secondary">{STATUS_LABEL[goal.status]}</Badge>}
              {health && <Badge variant={health.badge}>{health.label}</Badge>}
              {hasChildren && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-expanded={open}
                  aria-label={open ? "Collapse key results" : "Expand key results"}
                  onClick={() => setOpen((v) => !v)}
                >
                  <ChevronDown className={cn("h-4 w-4 transition-transform duration-200", !open && "-rotate-90")} />
                </Button>
              )}
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-3 pt-0">
          {goal.description && <p className="text-sm text-muted-foreground">{goal.description}</p>}

          <GoalNumber goal={goal} />

          {/* Both numbers, always — an override annotates the measurement, it does not replace it. */}
          {goal.override && (
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
                  <PencilLine className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                  <span className="min-w-0">
                    <span className="font-medium">Stated {goal.override.progressPct}%</span>
                    {goal.override.measuredPct !== null ? (
                      <> · measured {goal.override.measuredPct}% at the time</>
                    ) : (
                      <> · nothing measurable at the time</>
                    )}
                    <span className="block truncate text-muted-foreground">
                      {goal.override.createdBy?.name ?? "Someone"}: {goal.override.note}
                    </span>
                  </span>
                </div>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                Recorded {new Date(goal.override.createdAt).toLocaleString()}. Overrides are append-only — a correction
                adds another entry rather than editing this one. {goal._count.overrides} in total.
              </TooltipContent>
            </Tooltip>
          )}

          {canManage && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              <Button variant="outline" size="sm" onClick={() => onEdit(goal)}>
                <PencilLine className="mr-1.5 h-3.5 w-3.5" />
                Edit
              </Button>
              {goal.progressSource !== "MANUAL" && (
                <Button variant="outline" size="sm" onClick={() => onOverride(goal)}>
                  Override
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={() => onDelete(goal)}>
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                Delete
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Key results, revealed with the same grid animation the rest of the app uses. */}
      {hasChildren && (
        <div
          className={cn(
            "grid transition-all duration-300 ease-out",
            open ? "mt-3 grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
          )}
        >
          <div className="space-y-3 overflow-hidden">{children}</div>
        </div>
      )}
    </div>
  );
}

export function GoalsPage() {
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();
  const { features, isLoading: featuresLoading } = usePlanningFeatures();
  const canManage = Boolean(user?.permissions.includes(permissions.GOALS_MANAGE));

  const [editing, setEditing] = useState<GoalRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [overriding, setOverriding] = useState<GoalRow | null>(null);

  const goals = useQuery({ queryKey: ["goals"], queryFn: goalApi.list, enabled: features.goals });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["goals"] });

  const remove = useMutation({
    mutationFn: (id: string) => goalApi.remove(id),
    onSuccess: () => {
      toast.success("Goal deleted", { description: "Its history is kept — the goal is hidden, not erased." });
      invalidate();
    },
    onError: (err) => toast.error("Could not delete", { description: serverMessage(err, "Try again.") })
  });

  const rows = goals.data ?? [];
  const tree = useMemo(() => {
    const objectives = rows.filter((g) => !g.parentId);
    const byParent = new Map<string, GoalRow[]>();
    for (const g of rows) {
      if (!g.parentId) continue;
      const list = byParent.get(g.parentId) ?? [];
      list.push(g);
      byParent.set(g.parentId, list);
    }
    return { objectives, byParent };
  }, [rows]);

  const stats = useMemo(() => {
    const active = rows.filter((g) => g.status === "ACTIVE");
    const measured = active.filter((g) => g.progressSource !== "MANUAL").length;
    const offTrack = active.filter((g) => g.measurement.health === "OFF_TRACK").length;
    const atRisk = active.filter((g) => g.measurement.health === "AT_RISK").length;
    return { total: active.length, measured, atRisk, offTrack };
  }, [rows]);

  if (featuresLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-56" />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <Skeleton className="h-40" />
      </div>
    );
  }

  if (!features.goals) {
    return (
      <div className="space-y-4">
        <PageTitle />
        <Card className="animate-fade-in">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <span className="grid h-12 w-12 place-items-center rounded-full bg-muted text-muted-foreground" aria-hidden>
              <Lock className="h-5 w-5" />
            </span>
            <div className="space-y-1">
              <p className="font-medium">Goals are off for this workspace</p>
              <p className="max-w-md text-sm text-muted-foreground">
                A super admin can turn them on under <strong>Workspace Settings → Planning</strong>. If the toggle is
                greyed out, goals are not part of this plan yet.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageTitle />
        {canManage && (
          <Button onClick={() => setCreating(true)} className="shrink-0">
            <Plus className="mr-1.5 h-4 w-4" />
            New goal
          </Button>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Active goals" value={String(stats.total)} icon={<Target className="h-4 w-4" />} />
        <StatCard
          label="Measured, not typed"
          value={`${stats.measured} of ${stats.total}`}
          icon={<TrendingUp className="h-4 w-4" />}
        />
        <StatCard label="At risk" value={String(stats.atRisk)} tone={stats.atRisk > 0 ? "warning" : "default"} icon={<AlertTriangle className="h-4 w-4" />} />
        <StatCard label="Off track" value={String(stats.offTrack)} tone={stats.offTrack > 0 ? "destructive" : "default"} icon={<ShieldAlert className="h-4 w-4" />} />
      </div>

      {goals.isLoading && (
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-44" />
          ))}
        </div>
      )}

      {!goals.isLoading && rows.length === 0 && (
        <Card className="animate-fade-in">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <span className="grid h-12 w-12 place-items-center rounded-full bg-primary/10 text-primary" aria-hidden>
              <Target className="h-5 w-5" />
            </span>
            <div className="space-y-1">
              <p className="font-medium">No goals yet</p>
              <p className="max-w-md text-sm text-muted-foreground">
                Wire an objective to a number this workspace already produces — approved hours, budget spend, tickets
                closed, on-time rate — and its progress reports itself.
              </p>
            </div>
            {canManage && (
              <Button onClick={() => setCreating(true)}>
                <Plus className="mr-1.5 h-4 w-4" />
                Create the first goal
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      <div className="space-y-3" data-tour="goals-list">
        {tree.objectives.map((objective) => (
          <GoalCard
            key={objective.id}
            goal={objective}
            canManage={canManage}
            depth={0}
            onEdit={setEditing}
            onOverride={setOverriding}
            onDelete={(g) => remove.mutate(g.id)}
          >
            {(tree.byParent.get(objective.id) ?? []).map((kr) => (
              <GoalCard
                key={kr.id}
                goal={kr}
                canManage={canManage}
                depth={1}
                onEdit={setEditing}
                onOverride={setOverriding}
                onDelete={(g) => remove.mutate(g.id)}
              />
            ))}
          </GoalCard>
        ))}
      </div>

      {!canManage && rows.length > 0 && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Lock className="h-3 w-3" />
          Creating and editing goals needs the goals permission.
        </p>
      )}

      {(creating || editing) && (
        <GoalDialog
          goal={editing}
          objectives={tree.objectives.filter((o) => o.id !== editing?.id)}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={invalidate}
        />
      )}
      {overriding && <OverrideDialog goal={overriding} onClose={() => setOverriding(null)} onSaved={invalidate} />}
    </div>
  );
}

function PageTitle() {
  return (
    <div className="space-y-1">
      <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
        <Target className="h-6 w-6 text-primary" />
        Goals
      </h1>
      <p className="text-sm text-muted-foreground">
        Objectives and key results whose progress is measured from work this workspace already records.
      </p>
    </div>
  );
}

function GoalDialog({
  goal,
  objectives,
  onClose,
  onSaved
}: Readonly<{ goal: GoalRow | null; objectives: GoalRow[]; onClose: () => void; onSaved: () => void }>) {
  const [title, setTitle] = useState(goal?.title ?? "");
  const [description, setDescription] = useState(goal?.description ?? "");
  const [parentId, setParentId] = useState(goal?.parentId ?? "none");
  const [source, setSource] = useState<GoalProgressSourceValue>(goal?.progressSource ?? "MANUAL");
  const [startDate, setStartDate] = useState(goal?.startDate?.slice(0, 10) ?? "");
  const [endDate, setEndDate] = useState(goal?.endDate?.slice(0, 10) ?? "");
  const [targetValue, setTargetValue] = useState(goal?.targetValue != null ? String(goal.targetValue) : "");
  const [unit, setUnit] = useState(goal?.unit ?? "");
  const [manualPct, setManualPct] = useState(goal?.manualProgressPct != null ? String(goal.manualProgressPct) : "");
  const [status, setStatus] = useState<GoalStatusValue>(goal?.status ?? "ACTIVE");

  const projects = useQuery({ queryKey: ["projects", "for-goals"], queryFn: () => projectApi.list() });
  const [projectId, setProjectId] = useState(goal?.links.find((l) => l.targetType === "PROJECT")?.targetId ?? "all");

  const meta = sourceMeta(source);
  const isManual = source === "MANUAL";

  const save = useMutation({
    mutationFn: async () => {
      const payload: GoalPayload = {
        title: title.trim(),
        description: description.trim() || null,
        parentId: parentId === "none" ? null : parentId,
        startDate: startDate || null,
        endDate: endDate || null,
        progressSource: source,
        // A manual goal must not carry a target — the API refuses one, and sending it anyway
        // would surface as a validation error the user did not cause.
        targetValue: isManual ? null : targetValue ? Number(targetValue) : null,
        unit: unit.trim() || null,
        manualProgressPct: isManual ? (manualPct ? Number(manualPct) : null) : null,
        links: projectId === "all" ? [] : [{ targetType: "PROJECT", targetId: projectId }]
      };
      return goal ? goalApi.update(goal.id, { ...payload, status }) : goalApi.create(payload);
    },
    onSuccess: () => {
      toast.success(goal ? "Goal updated" : "Goal created");
      onSaved();
      onClose();
    },
    onError: (err) => toast.error("Could not save", { description: serverMessage(err, "Check the fields and try again.") })
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{goal ? "Edit goal" : "New goal"}</DialogTitle>
          <DialogDescription>
            Pick a measured source and the number reports itself. Choose “Stated manually” only when the outcome is not
            something this workspace records.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="goal-title">Title</Label>
            <Input id="goal-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ship the billing rewrite" />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="goal-desc">Description</Label>
            <Textarea id="goal-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </div>

          <div className="space-y-1.5">
            <Label>Parent objective</Label>
            <Select value={parentId} onValueChange={setParentId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None — this is a top-level objective</SelectItem>
                {objectives.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Goals nest two levels: an objective and its key results.</p>
          </div>

          <div className="space-y-1.5">
            <Label>How progress is measured</Label>
            <Select value={source} onValueChange={(v) => setSource(v as GoalProgressSourceValue)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SOURCES.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <meta.icon className="mt-0.5 h-3 w-3 shrink-0" />
              {meta.blurb}
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="goal-start">Period starts</Label>
              <Input id="goal-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="goal-end">Period ends</Label>
              <Input id="goal-end" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </div>
          </div>

          {isManual ? (
            <div className="space-y-1.5">
              <Label htmlFor="goal-manual">Progress %</Label>
              <Input id="goal-manual" type="number" min={0} max={100} value={manualPct} onChange={(e) => setManualPct(e.target.value)} />
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="goal-target">Target ({meta.unitHint})</Label>
                <Input id="goal-target" type="number" min={0} step="0.01" value={targetValue} onChange={(e) => setTargetValue(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="goal-unit">Unit label</Label>
                <Input id="goal-unit" value={unit} onChange={(e) => setUnit(e.target.value)} placeholder={meta.unitHint} />
              </div>
            </div>
          )}

          {!isManual && (
            <div className="space-y-1.5">
              <Label>Measured over</Label>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">The whole workspace</SelectItem>
                  {(projects.data ?? []).map((p: any) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {goal && (
            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as GoalStatusValue)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["ACTIVE", "ACHIEVED", "CLOSED"] as GoalStatusValue[]).map((s) => (
                    <SelectItem key={s} value={s}>
                      {STATUS_LABEL[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || title.trim().length === 0}>
            {save.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            {goal ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OverrideDialog({ goal, onClose, onSaved }: Readonly<{ goal: GoalRow; onClose: () => void; onSaved: () => void }>) {
  const [progressPct, setProgressPct] = useState(String(goal.measurement.progressPct ?? 0));
  const [note, setNote] = useState("");

  const save = useMutation({
    mutationFn: () => goalApi.override(goal.id, { progressPct: Number(progressPct), note: note.trim() }),
    onSuccess: () => {
      toast.success("Override recorded", { description: "The measurement it disagreed with was recorded alongside it." });
      onSaved();
      onClose();
    },
    onError: (err) => toast.error("Could not record", { description: serverMessage(err, "Try again.") })
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Override measured progress</DialogTitle>
          <DialogDescription>
            The measured figure stays visible next to yours, and this entry records who set it and why. Overrides are
            append-only — a later correction adds another entry rather than editing this one.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
            <span className="text-muted-foreground">Measured right now: </span>
            {goal.measurement.unavailable ? (
              <span className="font-medium">not measurable — {goal.measurement.unavailableReason}</span>
            ) : (
              <span className="font-medium tabular-nums">
                {goal.measurement.progressPct !== null ? `${goal.measurement.progressPct}%` : formatValue(goal.measurement.currentValue, goal.unit)}
              </span>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="override-pct">Stated progress %</Label>
            <Input id="override-pct" type="number" min={0} max={100} value={progressPct} onChange={(e) => setProgressPct(e.target.value)} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="override-note">Why does it differ?</Label>
            <Textarea
              id="override-note"
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Contractor hours land next month, so the measured figure understates delivery."
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || note.trim().length < 3}>
            {save.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-1.5 h-4 w-4" />}
            Record override
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
