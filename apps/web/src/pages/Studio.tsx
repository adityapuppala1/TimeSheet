/**
 * The Workflow Studio — flows as a readable list of steps, with the authority they resolve to stated
 * above them and a replay before anything is switched on.
 *
 * WHY A VERTICAL LIST AND NOT A CANVAS: a canvas is what demos well; a list is what somebody can read
 * in a review, and every flow here is short by design (twenty steps is the cap, and that is already
 * past the point anyone checks one). The interesting information about a flow is not its shape — it is
 * what each step is allowed to do, which is text.
 *
 * WHY THE AUTHORITY BANNER IS THE FIRST THING ON EVERY FLOW: the three rules
 * (docs/AGENTIC_WORK_MANAGEMENT.md §5 phase 4) mean a flow's real authority is often lower than its
 * steps suggest — the minimum of its capabilities, then clamped if anything reads outside text. An
 * author who cannot see that will build a flow that quietly proposes when they expected it to act, and
 * conclude the feature is broken.
 *
 * WHY SIMULATION IS OFFERED BEFORE ACTIVATION AND NOT AFTER: "what would this have done to my
 * workspace last week" is the question, and it has to be answerable without consequences. The replay
 * calls no model and writes nothing, and says so on its own face so nobody reads it as an execution.
 *
 * WHO renders this: `App.tsx` at `/app/studio`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowDown,
  Ban,
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleSlash,
  GitBranch,
  Hand,
  Loader2,
  Lock,
  PlayCircle,
  Plus,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  Workflow,
  Zap
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { StatCard } from "../components/ui/stat-card";
import { Textarea } from "../components/ui/textarea";
import { toast } from "../components/ui/toaster";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/utils";
import { useAuthStore } from "../store/auth";
import {
  agentRosterApi,
  flowApi,
  type FlowPayload,
  type FlowRow,
  type FlowSimulation,
  type FlowStepKind,
  type FlowTriggerKind
} from "../services/api";

const serverMessage = (err: any, fallback: string) => err?.response?.data?.message ?? fallback;

const STEP_META: Record<FlowStepKind, { label: string; icon: typeof Zap; blurb: string }> = {
  CAPABILITY: { label: "AI step", icon: Sparkles, blurb: "Calls a capability at whatever level it resolves to." },
  ACTION: { label: "Action", icon: Zap, blurb: "Deterministic — assign, label, notify. No model." },
  HUMAN_GATE: { label: "Ask a person", icon: Hand, blurb: "Blocks. Everything below waits for approval." },
  BRANCH: { label: "Only if", icon: GitBranch, blurb: "Skips the rest when the condition fails." }
};

const TRIGGERS: Array<{ value: FlowTriggerKind; label: string; hint: string }> = [
  { value: "MANUAL", label: "By hand", hint: "Only ever when somebody runs it. The safe default." },
  { value: "EVENT", label: "When something happens", hint: "A domain event — a ticket assigned, a build failing." },
  { value: "SCHEDULE", label: "On a schedule", hint: "A cron expression." },
  { value: "FORM_SUBMISSION", label: "When a form is submitted", hint: "A public request form." }
];

const LEVEL_COPY: Record<string, { label: string; tone: "secondary" | "warning" | "destructive" }> = {
  SUGGEST: { label: "Proposes only", tone: "secondary" },
  AUTO_APPLY: { label: "Applies its own changes", tone: "warning" },
  AUTONOMOUS: { label: "Runs unattended", tone: "destructive" }
};

const OUTCOME_COPY: Record<string, { label: string; className: string }> = {
  "would-run": { label: "would run", className: "text-success" },
  "would-propose": { label: "would propose", className: "text-primary" },
  "waits-for-approval": { label: "waits for a person", className: "text-warning-foreground" },
  "not-reached": { label: "not reached", className: "text-muted-foreground" },
  "skipped-by-branch": { label: "skipped", className: "text-muted-foreground" }
};

export function StudioPage() {
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();
  const isSuperAdmin = user?.role === "SUPER_ADMIN";
  const [editing, setEditing] = useState<FlowRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [simulating, setSimulating] = useState<FlowRow | null>(null);

  const flows = useQuery({ queryKey: ["flows"], queryFn: flowApi.list, retry: false });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["flows"] });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => flowApi.setEnabled(id, enabled),
    onSuccess: (flow) => {
      toast.success(flow.enabled ? `${flow.name} is live` : `${flow.name} is off`, {
        description: flow.enabled
          ? flow.authority.proposalOnly
            ? "It will propose changes for somebody to accept — it applies nothing itself."
            : "It will apply its own changes, within the guardrails, and every one is undoable."
          : "It will not fire again until switched back on."
      });
      invalidate();
    },
    onError: (err) => toast.error("Could not change that", { description: serverMessage(err, "Try again.") })
  });

  const retire = useMutation({
    mutationFn: (id: string) => flowApi.retire(id),
    onSuccess: () => {
      toast.success("Flow retired", { description: "Its steps stay readable for anyone asking what it used to do." });
      invalidate();
    },
    onError: (err) => toast.error("Could not retire", { description: serverMessage(err, "Try again.") })
  });

  const gateMessage = (flows.error as any)?.response?.status === 403 ? serverMessage(flows.error, "") : null;
  const rows = flows.data ?? [];
  const live = rows.filter((f) => f.enabled).length;
  const proposalOnly = rows.filter((f) => f.enabled && f.authority.proposalOnly).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Workflow className="h-6 w-6 text-primary" />
            Workflow Studio
          </h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            A trigger, then steps. Each flow shows the authority it actually resolves to, and can be replayed against real
            recent triggers before it is switched on.
          </p>
        </div>
        {isSuperAdmin && !gateMessage && (
          <Button onClick={() => setCreating(true)} className="shrink-0">
            <Plus className="mr-1.5 h-4 w-4" />
            New flow
          </Button>
        )}
      </div>

      {gateMessage && (
        <Card className="animate-fade-in">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <span className="grid h-12 w-12 place-items-center rounded-full bg-muted text-muted-foreground" aria-hidden>
              <Lock className="h-5 w-5" />
            </span>
            <div className="space-y-1">
              <p className="font-medium">The Studio is not part of this plan</p>
              <p className="max-w-md text-sm text-muted-foreground">{gateMessage}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {flows.isLoading && (
        <div className="space-y-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-48" />
        </div>
      )}

      {!gateMessage && !flows.isLoading && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <StatCard label="Flows" value={`${live} of ${rows.length} live`} icon={<Workflow className="h-4 w-4" />} />
            <StatCard label="Propose-only" value={String(proposalOnly)} icon={<ShieldCheck className="h-4 w-4" />} />
            <StatCard
              label="Applying directly"
              value={String(live - proposalOnly)}
              tone={live - proposalOnly > 0 ? "warning" : "default"}
              icon={<Zap className="h-4 w-4" />}
            />
          </div>

          {rows.length === 0 ? (
            <Card className="animate-fade-in">
              <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
                <span className="grid h-12 w-12 place-items-center rounded-full bg-primary/10 text-primary" aria-hidden>
                  <Workflow className="h-5 w-5" />
                </span>
                <div className="space-y-1">
                  <p className="font-medium">No flows yet</p>
                  <p className="max-w-md text-sm text-muted-foreground">
                    A flow joins a trigger to steps you already have — capabilities, deterministic actions, and a point where
                    a person is asked. Nothing runs until you replay it and switch it on.
                  </p>
                </div>
                {isSuperAdmin && (
                  <Button onClick={() => setCreating(true)}>
                    <Plus className="mr-1.5 h-4 w-4" />
                    Build the first one
                  </Button>
                )}
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {rows.map((flow) => (
                <FlowCard
                  key={flow.id}
                  flow={flow}
                  canManage={isSuperAdmin}
                  busy={toggle.isPending || retire.isPending}
                  onToggle={(enabled) => toggle.mutate({ id: flow.id, enabled })}
                  onEdit={() => setEditing(flow)}
                  onSimulate={() => setSimulating(flow)}
                  onRetire={() => retire.mutate(flow.id)}
                />
              ))}
            </div>
          )}
        </>
      )}

      {(creating || editing) && (
        <FlowDialog
          flow={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={invalidate}
        />
      )}
      {simulating && <SimulationDialog flow={simulating} onClose={() => setSimulating(null)} />}
    </div>
  );
}

function AuthorityBanner({ flow }: Readonly<{ flow: FlowRow }>) {
  const copy = LEVEL_COPY[flow.authority.effectiveLevel] ?? LEVEL_COPY.SUGGEST;
  return (
    <div
      className={cn(
        "space-y-1.5 rounded-lg border p-3 text-xs",
        flow.authority.proposalOnly ? "border-border bg-muted/30" : "border-warning/40 bg-warning/5"
      )}
    >
      <p className="flex flex-wrap items-center gap-1.5 font-medium">
        {flow.authority.proposalOnly ? <ShieldCheck className="h-3.5 w-3.5" /> : <Zap className="h-3.5 w-3.5 text-warning-foreground" />}
        This flow {copy.label.toLowerCase()}
        <Badge variant={copy.tone} className="text-[10px]">
          {flow.authority.effectiveLevel}
        </Badge>
        {flow.authority.gatedBeforeWrites && (
          <Badge variant="secondary" className="gap-1 text-[10px]">
            <Hand className="h-2.5 w-2.5" />
            gated
          </Badge>
        )}
      </p>
      {/* The two clamps say different things and need different fixes, so they are never merged. */}
      {flow.authority.limitedBy && (
        <p className="text-muted-foreground">
          Limited by step {flow.authority.limitedBy.order} ({flow.authority.limitedBy.capability}), which resolves to{" "}
          {flow.authority.limitedBy.level} — a flow can never do more than its most restricted step.
        </p>
      )}
      {flow.authority.taintedFrom && (
        <p className="text-muted-foreground">
          Step {flow.authority.taintedFrom.order} ({flow.authority.taintedFrom.capability}) reads text from outside this
          workspace, so every change after it becomes a proposal. Moving it later changes that.
        </p>
      )}
    </div>
  );
}

function FlowCard({
  flow,
  canManage,
  busy,
  onToggle,
  onEdit,
  onSimulate,
  onRetire
}: Readonly<{
  flow: FlowRow;
  canManage: boolean;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onSimulate: () => void;
  onRetire: () => void;
}>) {
  const trigger = TRIGGERS.find((t) => t.value === flow.trigger);
  const errors = flow.issues.filter((i) => i.severity === "error");
  const warnings = flow.issues.filter((i) => i.severity === "warning");

  return (
    <Card className={cn("animate-fade-in transition-shadow duration-200 hover:shadow-md", !flow.enabled && "opacity-90")}>
      <CardHeader className="gap-2 pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 items-start gap-2.5">
            <span
              className={cn("grid h-10 w-10 shrink-0 place-items-center rounded-lg text-xl", flow.enabled ? "bg-primary/10" : "bg-muted")}
              aria-hidden
            >
              {flow.emoji}
            </span>
            <div className="min-w-0">
              <CardTitle className="flex flex-wrap items-center gap-1.5 text-base">
                {flow.name}
                <Badge variant={flow.enabled ? "success" : "secondary"} className="text-[10px]">
                  {flow.enabled ? "Live" : "Draft"}
                </Badge>
                {flow.agentProfile && (
                  <Badge variant="outline" className="gap-1 text-[10px]">
                    <Bot className="h-2.5 w-2.5" />
                    {flow.agentProfile.emoji} {flow.agentProfile.name}
                  </Badge>
                )}
              </CardTitle>
              <CardDescription className="mt-0.5 text-xs">
                {trigger?.label}
                {flow.trigger === "EVENT" && flow.triggerConfig.event ? ` — ${String(flow.triggerConfig.event)}` : ""}
                {flow.trigger === "SCHEDULE" && flow.triggerConfig.cron ? ` — ${String(flow.triggerConfig.cron)}` : ""}
                {" · "}
                {flow.steps.length} step{flow.steps.length === 1 ? "" : "s"}
              </CardDescription>
            </div>
          </div>
          {canManage && (
            <div className="flex shrink-0 items-center gap-1.5">
              <Button variant="outline" size="sm" onClick={onSimulate}>
                <PlayCircle className="mr-1.5 h-3.5 w-3.5" />
                Replay
              </Button>
              <Button
                variant={flow.enabled ? "ghost" : "default"}
                size="sm"
                disabled={busy || (!flow.enabled && !flow.activatable)}
                onClick={() => onToggle(!flow.enabled)}
              >
                {flow.enabled ? "Switch off" : "Switch on"}
              </Button>
            </div>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-3 pt-0">
        {flow.description && <p className="text-sm text-muted-foreground">{flow.description}</p>}

        <AuthorityBanner flow={flow} />

        {/* Errors block activation and are quoted verbatim, because each one describes a flow that
            would do something other than what it reads as doing. */}
        {errors.length > 0 && (
          <ul className="space-y-1">
            {errors.map((issue) => (
              <li key={issue.message} className="flex items-start gap-1.5 text-xs text-destructive">
                <CircleSlash className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  {issue.order ? <strong>Step {issue.order}: </strong> : null}
                  {issue.message}
                </span>
              </li>
            ))}
          </ul>
        )}
        {warnings.length > 0 && (
          <ul className="space-y-1">
            {warnings.map((issue) => (
              <li key={issue.message} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning-foreground" />
                <span>{issue.message}</span>
              </li>
            ))}
          </ul>
        )}

        {/* The flow itself: a list, read top to bottom, each step carrying what it may do HERE. */}
        <ol className="space-y-1.5">
          {flow.steps.map((step, index) => {
            const meta = STEP_META[step.kind];
            const Icon = meta.icon;
            const authority = flow.authority.steps.find((s) => s.order === step.order);
            return (
              <li key={step.id}>
                <div className="flex items-start gap-2.5 rounded-md border bg-card px-3 py-2">
                  <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded bg-muted text-[11px] font-medium tabular-nums">
                    {step.order}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5 text-sm">
                      <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                      <span className="font-medium">{step.title ?? meta.label}</span>
                      {/* The badge names the KIND, so it is redundant when the step has no title of
                          its own and the heading is already the kind's name — "Action / Action". */}
                      {step.kind !== "CAPABILITY" && step.title && (
                        <Badge variant="secondary" className="text-[10px]">
                          {meta.label}
                        </Badge>
                      )}
                      {authority && step.kind === "CAPABILITY" && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Badge
                              variant={authority.effectiveLevel === "SUGGEST" ? "secondary" : "warning"}
                              className="cursor-help text-[10px]"
                            >
                              {authority.effectiveLevel}
                            </Badge>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs">
                            {authority.clampedReason
                              ? `On its own this step is ${authority.ownLevel}; here it is ${authority.effectiveLevel} — ${authority.clampedReason}.`
                              : `Runs at ${authority.effectiveLevel}, the same level it has on its own.`}
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </span>
                    {authority?.clampedReason && (
                      <span className="mt-0.5 block text-[11px] text-warning-foreground">{authority.clampedReason}</span>
                    )}
                  </span>
                </div>
                {index < flow.steps.length - 1 && (
                  <div className="flex justify-center py-0.5" aria-hidden>
                    <ArrowDown className="h-3 w-3 text-muted-foreground/50" />
                  </div>
                )}
              </li>
            );
          })}
        </ol>

        {canManage && (
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <Button variant="outline" size="sm" onClick={onEdit} className="h-7 px-2 text-xs">
              <Settings2 className="mr-1 h-3 w-3" />
              Edit
            </Button>
            {!flow.enabled && !flow.activatable && (
              <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                <Ban className="h-3 w-3" />
                Fix the errors above to switch it on
              </span>
            )}
            <Button variant="ghost" size="sm" className="ml-auto h-7 px-2 text-xs" onClick={onRetire}>
              <Trash2 className="mr-1 h-3 w-3" />
              Retire
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function FlowDialog({ flow, onClose, onSaved }: Readonly<{ flow: FlowRow | null; onClose: () => void; onSaved: () => void }>) {
  const [name, setName] = useState(flow?.name ?? "");
  const [description, setDescription] = useState(flow?.description ?? "");
  const [emoji, setEmoji] = useState(flow?.emoji ?? "⚙️");
  const [trigger, setTrigger] = useState<FlowTriggerKind>(flow?.trigger ?? "MANUAL");
  const [event, setEvent] = useState(String(flow?.triggerConfig?.event ?? ""));
  const [cron, setCron] = useState(String(flow?.triggerConfig?.cron ?? ""));
  const [agentProfileId, setAgentProfileId] = useState(flow?.agentProfile?.id ?? "none");
  const [steps, setSteps] = useState<FlowPayload["steps"]>(
    flow?.steps.map((s) => ({ kind: s.kind, capability: s.capability, config: s.config })) ?? []
  );

  const catalogue = useQuery({ queryKey: ["flows", "catalogue"], queryFn: flowApi.catalogue });
  const roster = useQuery({ queryKey: ["agents"], queryFn: agentRosterApi.list, retry: false });

  const save = useMutation({
    mutationFn: async () => {
      const triggerConfig =
        trigger === "EVENT" ? { event } : trigger === "SCHEDULE" ? { cron } : {};
      const payload: FlowPayload = {
        name: name.trim(),
        description: description.trim() || null,
        emoji,
        trigger,
        triggerConfig,
        agentProfileId: agentProfileId === "none" ? null : agentProfileId,
        steps
      };
      return flow ? flowApi.update(flow.id, payload) : flowApi.create(payload);
    },
    onSuccess: () => {
      toast.success(flow ? "Flow saved" : "Flow created", {
        description: flow ? undefined : "It is a draft. Replay it, then switch it on."
      });
      onSaved();
      onClose();
    },
    onError: (err) => toast.error("Could not save", { description: serverMessage(err, "Check the steps and try again.") })
  });

  const addStep = (kind: FlowStepKind) => setSteps((prev) => [...prev, { kind, capability: kind === "CAPABILITY" ? "" : null, config: {} }]);
  const removeStep = (index: number) => setSteps((prev) => prev.filter((_, i) => i !== index));
  const move = (index: number, delta: number) =>
    setSteps((prev) => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{flow ? "Edit flow" : "New flow"}</DialogTitle>
          <DialogDescription>
            Order matters: a step that reads text from outside the workspace makes everything after it a proposal. The
            authority is recomputed as you save.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-[5rem_minmax(0,1fr)]">
            <div className="space-y-1.5">
              <Label htmlFor="flow-emoji">Icon</Label>
              <Input id="flow-emoji" value={emoji} onChange={(e) => setEmoji(e.target.value)} maxLength={4} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="flow-name">Name</Label>
              <Input id="flow-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Triage what arrives by email" />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="flow-desc">What it is for</Label>
            <Textarea id="flow-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>

          <div className="space-y-1.5">
            <Label>Trigger</Label>
            <Select value={trigger} onValueChange={(v) => setTrigger(v as FlowTriggerKind)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TRIGGERS.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{TRIGGERS.find((t) => t.value === trigger)?.hint}</p>
          </div>

          {trigger === "EVENT" && (
            <div className="space-y-1.5">
              <Label>Event</Label>
              <Select value={event} onValueChange={setEvent}>
                <SelectTrigger>
                  <SelectValue placeholder="Pick an event" />
                </SelectTrigger>
                <SelectContent>
                  {(catalogue.data?.events ?? []).map((e) => (
                    <SelectItem key={e} value={e}>
                      {e}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {trigger === "SCHEDULE" && (
            <div className="space-y-1.5">
              <Label htmlFor="flow-cron">Cron</Label>
              <Input id="flow-cron" value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 9 * * 1" />
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Runs as</Label>
            <Select value={agentProfileId} onValueChange={setAgentProfileId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Nobody in particular (deterministic steps only)</SelectItem>
                {(roster.data ?? []).map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.emoji} {a.name}
                    {a.enabled ? "" : " (off)"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              A flow bound to a teammate may only use capabilities that teammate owns — which is what keeps one capability to
              one owner.
            </p>
          </div>

          {/* The steps, as a list you reorder. */}
          <div className="space-y-2">
            <Label>Steps</Label>
            {steps.length === 0 && (
              <p className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
                No steps yet. Add one below.
              </p>
            )}
            {steps.map((step, index) => {
              const meta = STEP_META[step.kind];
              const Icon = meta.icon;
              return (
                <div key={index} className="flex items-start gap-2 rounded-md border p-2">
                  <span className="mt-1.5 grid h-6 w-6 shrink-0 place-items-center rounded bg-muted text-[11px] tabular-nums">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <p className="flex items-center gap-1.5 text-sm font-medium">
                      <Icon className="h-3.5 w-3.5" aria-hidden />
                      {meta.label}
                    </p>
                    {step.kind === "CAPABILITY" && (
                      <Select
                        value={step.capability ?? ""}
                        onValueChange={(v) => setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, capability: v } : s)))}
                      >
                        <SelectTrigger className="h-8">
                          <SelectValue placeholder="Pick a capability" />
                        </SelectTrigger>
                        <SelectContent>
                          {(catalogue.data?.capabilities ?? []).map((c) => (
                            <SelectItem key={c.id} value={c.id}>
                              {c.title}
                              {c.actsOnUntrustedInput ? " — reads outside text" : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    {step.kind !== "CAPABILITY" && <p className="text-xs text-muted-foreground">{meta.blurb}</p>}
                  </div>
                  <div className="flex shrink-0 flex-col gap-0.5">
                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => move(index, -1)} aria-label="Move up">
                      <ChevronRight className="h-3 w-3 -rotate-90" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => move(index, 1)} aria-label="Move down">
                      <ChevronRight className="h-3 w-3 rotate-90" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => removeStep(index)} aria-label="Remove step">
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              );
            })}
            <div className="flex flex-wrap gap-1.5">
              {(Object.keys(STEP_META) as FlowStepKind[]).map((kind) => (
                <Button key={kind} variant="outline" size="sm" onClick={() => addStep(kind)} className="h-7 text-xs">
                  <Plus className="mr-1 h-3 w-3" />
                  {STEP_META[kind].label}
                </Button>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || name.trim().length === 0}>
            {save.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            {flow ? "Save" : "Create as draft"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SimulationDialog({ flow, onClose }: Readonly<{ flow: FlowRow; onClose: () => void }>) {
  const sim = useQuery<FlowSimulation>({ queryKey: ["flows", flow.id, "simulate"], queryFn: () => flowApi.simulate(flow.id) });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {flow.emoji} {flow.name} — replay
          </DialogTitle>
          <DialogDescription>{sim.data?.disclaimer ?? "Replaying against real recent triggers…"}</DialogDescription>
        </DialogHeader>

        {sim.isLoading && <Skeleton className="h-48" />}

        {sim.data && (
          <div className="space-y-3">
            <AuthorityBanner flow={flow} />

            {sim.data.sampleCount === 0 ? (
              <p className="flex items-start gap-2 rounded-md border border-dashed px-3 py-3 text-xs text-muted-foreground">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {sim.data.noSamplesReason ?? "Nothing recent matched this trigger."}
              </p>
            ) : (
              sim.data.samples.slice(0, 3).map((sample) => (
                <div key={sample.subject} className="space-y-1.5 rounded-lg border p-3">
                  <p className="text-xs font-medium">{sample.subject}</p>
                  <ol className="space-y-1">
                    {sample.steps.map((step) => {
                      const outcome = OUTCOME_COPY[step.outcome] ?? OUTCOME_COPY["would-run"];
                      return (
                        <li key={step.order} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                          <span className="tabular-nums text-muted-foreground">{step.order}.</span>
                          <span className="font-medium">{step.title ?? STEP_META[step.kind].label}</span>
                          <span className={cn("font-medium", outcome.className)}>{outcome.label}</span>
                          {step.level && <Badge variant="secondary" className="text-[9px]">{step.level}</Badge>}
                          <span className="w-full text-muted-foreground">{step.detail}</span>
                        </li>
                      );
                    })}
                  </ol>
                </div>
              ))
            )}

            <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
              <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0" />
              Nothing above happened. This replay wrote nothing and called no model.
            </p>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          {!flow.enabled && flow.activatable && (
            <Button asChild>
              <Link to="/app/studio">Looks right — switch it on from the card</Link>
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
