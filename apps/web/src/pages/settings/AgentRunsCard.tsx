/**
 * WHAT: the face of the agent runtime — start a run, watch it work, read exactly what it did, stop
 * it mid-flight.
 *
 * WHY THE TRACE IS THE POINT, not the status: a run's outcome badge answers "did it work". The
 * question anyone actually arrives with is "what did it DO", and for something that acted while
 * nobody was watching that question has to be answerable without a database client. So every step
 * is listed in order with its tool, its arguments and its result, and the two moments that narrow a
 * run's authority — the taint clamp and a refused tool — are rendered as their own marked events
 * rather than buried in prose.
 *
 * WHY IT POLLS ONLY WHILE SOMETHING IS IN FLIGHT: same rule as AIEvalsCard. An idle workspace
 * should not be issuing a request every three seconds forever.
 *
 * WHO RENDERS THIS: WorkspaceSettings' AI tab, below the autonomy ladder — you set how much
 * authority a capability holds up there, and watch it used down here.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Ban,
  Bot,
  CheckCircle2,
  ChevronRight,
  Clock,
  Loader2,
  Play,
  ShieldAlert,
  Wrench,
  XCircle
} from "lucide-react";
import { useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Skeleton } from "../../components/ui/skeleton";
import { AiStrands } from "../../components/ui/ai-strands";
import { toast } from "../../components/ui/toaster";
import { cn } from "../../lib/utils";
import { agentRunApi, projectApi, type AgentRunRow, type AgentRunStepRow } from "../../services/api";

const IN_FLIGHT = new Set(["QUEUED", "RUNNING"]);

/**
 * Status → badge. PARTIAL and BLOCKED are deliberately NOT failures, and the wording says so:
 * PARTIAL means a bound stopped it and the work already done is real; BLOCKED means it produced
 * something its autonomy level does not let it apply, which is degradation to propose-only.
 */
function statusBadge(status: string) {
  switch (status) {
    case "COMPLETED":
      return <Badge variant="success">completed</Badge>;
    case "RUNNING":
      return <Badge variant="info">running</Badge>;
    case "QUEUED":
      return <Badge variant="muted">queued</Badge>;
    case "PARTIAL":
      return <Badge variant="warning">stopped at a limit</Badge>;
    case "BLOCKED":
      return <Badge variant="warning">held for review</Badge>;
    case "ABORTED":
      return <Badge variant="muted">stopped by a person</Badge>;
    default:
      return <Badge variant="destructive">failed</Badge>;
  }
}

/** One glyph per step kind, so a long trace is scannable before it is readable. */
function stepIcon(kind: string) {
  switch (kind) {
    case "tool":
      return <Wrench className="h-3.5 w-3.5 text-primary" />;
    case "refusal":
      return <Ban className="h-3.5 w-3.5 text-warning" />;
    case "error":
      return <XCircle className="h-3.5 w-3.5 text-destructive" />;
    case "finish":
      return <CheckCircle2 className="h-3.5 w-3.5 text-success" />;
    case "note":
      return <ShieldAlert className="h-3.5 w-3.5 text-warning" />;
    default:
      return <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />;
  }
}

function money(value: string | number | null): string {
  if (value === null) return "—";
  const n = Number(value);
  return Number.isFinite(n) ? `$${n.toFixed(4)}` : "—";
}

export function AgentRunsCard() {
  const queryClient = useQueryClient();
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [capability, setCapability] = useState("");
  const [goal, setGoal] = useState("");
  const [projectId, setProjectId] = useState("");

  const capabilities = useQuery({ queryKey: ["agent-runs", "capabilities"], queryFn: agentRunApi.capabilities });
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => projectApi.list() });
  const runs = useQuery({
    queryKey: ["agent-runs"],
    queryFn: () => agentRunApi.list(25),
    // The worker ticks every minute, but a run's steps land continuously — 3s while anything is in
    // flight makes the trace feel live without polling an idle workspace forever.
    refetchInterval: (query) => ((query.state.data ?? []).some((r: AgentRunRow) => IN_FLIGHT.has(r.status)) ? 3000 : false)
  });

  const selected = capabilities.data?.find((c) => c.id === capability);

  const queue = useMutation({
    mutationFn: () =>
      agentRunApi.queue({
        capability,
        goal: goal.trim() || undefined,
        projectId: projectId || undefined
      }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["agent-runs"] });
      // "Already queued" is success, not an error — the triggerKey collapsing a double-click is
      // the constraint doing its job, and saying so is friendlier than a silent no-op.
      toast.success(result.created ? "Run queued" : "That run was already queued", {
        description: result.created ? "The worker picks it up within a minute. Its steps appear below as it goes." : undefined
      });
      setGoal("");
    },
    onError: (err: any) =>
      toast.error("Could not queue that run", { description: err?.response?.data?.message ?? "Try again." })
  });

  const abort = useMutation({
    mutationFn: (id: string) => agentRunApi.abort(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agent-runs"] });
      toast.success("Stop requested", { description: "The current step finishes; the next one never starts." });
    },
    onError: (err: any) => toast.error("Could not stop that run", { description: err?.response?.data?.message ?? "Try again." })
  });

  const rows = runs.data ?? [];
  const active = rows.filter((r) => IN_FLIGHT.has(r.status));

  return (
    <Card className={cn(active.length > 0 && "ai-glow")}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Bot className="h-4 w-4 text-primary" />
          Agent runs
        </CardTitle>
        <CardDescription>
          A capability working unattended, inside a bound it cannot exceed. Every run acts as a named person, carries the
          autonomy level it was queued with, and records each step it took — including the moment it read something from
          outside the workspace and lost the right to write.
        </CardDescription>
      </CardHeader>

      <CardContent className="grid gap-4">
        {/* ------------------------------- Start a run ------------------------------- */}
        <div className="grid gap-3 rounded-lg border border-border bg-muted/30 p-4">
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="grid gap-1.5">
              <Label htmlFor="agent-capability">Capability</Label>
              <Select value={capability} onValueChange={setCapability}>
                <SelectTrigger id="agent-capability">
                  <SelectValue placeholder="Pick what should run" />
                </SelectTrigger>
                <SelectContent>
                  {(capabilities.data ?? []).map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selected && <p className="text-xs text-muted-foreground">{selected.description}</p>}
            </div>

            {selected?.needsProject ? (
              <div className="grid gap-1.5">
                <Label htmlFor="agent-project">Project</Label>
                <Select value={projectId} onValueChange={setProjectId}>
                  <SelectTrigger id="agent-project">
                    <SelectValue placeholder="Which project" />
                  </SelectTrigger>
                  <SelectContent>
                    {(projects.data ?? []).map((p: any) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.code} — {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">This capability changes a plan, so it needs one to act on.</p>
              </div>
            ) : (
              <div className="grid gap-1.5">
                <Label htmlFor="agent-goal">Goal (optional)</Label>
                <Input
                  id="agent-goal"
                  value={goal}
                  maxLength={2000}
                  placeholder="e.g. Summarise what moved on Apollo this week"
                  onChange={(e) => setGoal(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  What the run is for. Leave blank to use the capability&apos;s own description.
                </p>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              Runs act as <strong>you</strong> — every permission check is yours, and nothing it proposes escapes review.
            </p>
            <Button
              size="sm"
              disabled={!capability || (selected?.needsProject && !projectId) || queue.isPending}
              onClick={() => queue.mutate()}
            >
              {queue.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-2 h-3.5 w-3.5" />}
              <span className={!capability || (selected?.needsProject && !projectId) ? undefined : "ai-gradient-text"}>Start run</span>
            </Button>
          </div>
        </div>

        {active.length > 0 && (
          <AiStrands
            label={`${active.length} run${active.length === 1 ? "" : "s"} in flight — steps appear below as they happen.`}
          />
        )}

        <RunOutcomeStats rows={rows} />

        {/* --------------------------------- The runs --------------------------------- */}
        {runs.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : rows.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            Nothing has run yet. Queue one above — it will appear here with everything it did.
          </p>
        ) : (
          <ul className="grid gap-2">
            {rows.map((run) => (
              <li key={run.id}>
                <button
                  type="button"
                  onClick={() => setOpenRunId(run.id)}
                  className="focus-ring grid w-full gap-1.5 rounded-lg border border-border p-3 text-left transition-colors hover:bg-muted/40"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-medium">{run.capability.replaceAll("_", " ")}</span>
                      {statusBadge(run.status)}
                      {/* The clamp, said out loud: this is the single most important fact about a
                          run that touched outside text, and it must not be a tooltip. */}
                      {run.taintedAt && (
                        <Badge variant="warning" className="gap-1">
                          <ShieldAlert className="h-3 w-3" />
                          read outside text — cannot write
                        </Badge>
                      )}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {new Date(run.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>
                      step {run.stepCount} of {run.maxSteps}
                    </span>
                    <span>
                      {money(run.costUsd)}
                      {run.maxCostUsd !== null && ` of ${money(run.maxCostUsd)}`}
                    </span>
                    <span>level {run.level.replaceAll("_", " ").toLowerCase()}</span>
                    <span>via {run.trigger}</span>
                    {run.onBehalfOf && <span>as {run.onBehalfOf.name}</span>}
                  </div>
                  {run.error && <p className="text-xs text-destructive">{run.error}</p>}
                </button>
                {IN_FLIGHT.has(run.status) && (
                  <div className="mt-1 flex justify-end">
                    <Button variant="ghost" size="sm" className="h-7" disabled={abort.isPending} onClick={() => abort.mutate(run.id)}>
                      <Ban className="mr-1.5 h-3 w-3" />
                      Stop
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <RunTraceDialog runId={openRunId} onClose={() => setOpenRunId(null)} />
    </Card>
  );
}

/**
 * The loop's health at a glance, from the runs already fetched.
 *
 * "Answered" is the headline on purpose: the first live pilot runs proved a run can burn its whole
 * budget and end silent, and every bound added since exists to push this number up. The others are
 * outcomes, not failures — held-for-review is the autonomy ceiling working, stopped-at-a-limit is
 * a bound working. Only "failed" is red. Computed client-side over the visible window and labelled
 * as such, because a number that quietly means "the last 25" while looking like "all time" is how
 * a dashboard loses trust.
 */
function RunOutcomeStats({ rows }: { rows: AgentRunRow[] }) {
  const done = rows.filter((r) => !IN_FLIGHT.has(r.status));
  if (done.length < 2) return null;

  const count = (statuses: string[]) => done.filter((r) => statuses.includes(r.status)).length;
  const answered = count(["COMPLETED"]);
  const totalCost = done.reduce((sum, r) => sum + (Number(r.costUsd) || 0), 0);
  const avgSteps = done.reduce((sum, r) => sum + r.stepCount, 0) / done.length;

  const tiles: Array<{ label: string; value: string; tone?: string; hint: string }> = [
    {
      label: "Answered",
      value: `${answered} of ${done.length}`,
      tone: answered === done.length ? "text-success" : undefined,
      hint: "Runs that finished with a summary. A run that spends its budget and ends silent wasted every step it took."
    },
    {
      label: "Held for review",
      value: String(count(["BLOCKED"])),
      hint: "Produced something its autonomy level may not apply — the ceiling working, not a failure."
    },
    {
      label: "Stopped at a limit",
      value: String(count(["PARTIAL", "ABORTED"])),
      hint: "A step/cost bound or a person ended it early. The work already recorded is real."
    },
    {
      label: "Failed",
      value: String(count(["FAILED"])),
      tone: count(["FAILED"]) > 0 ? "text-destructive" : undefined,
      hint: "Died on an error or an unparseable decision — the only column that is actually bad news."
    }
  ];

  return (
    <div className="grid gap-2">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {tiles.map((tile) => (
          <div key={tile.label} className="rounded-lg border border-border bg-muted/30 p-3 text-center" title={tile.hint}>
            <p className={cn("text-lg font-bold tabular-nums", tile.tone)}>{tile.value}</p>
            <p className="text-xs text-muted-foreground">{tile.label}</p>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">
        Last {done.length} finished run{done.length === 1 ? "" : "s"} shown here · {avgSteps.toFixed(1)} steps and{" "}
        {money(totalCost / done.length)} per run on average. Each step is captured — promote the interesting ones into a golden
        dataset (AI tab → Datasets, feature <code className="rounded bg-muted px-1">agent_step</code>) and the eval runner can
        replay them against any change.
      </p>
    </div>
  );
}

/** The audit answer to "what did it actually do", one row per step in the order they happened. */
function RunTraceDialog({ runId, onClose }: { runId: string | null; onClose: () => void }) {
  const run = useQuery({
    queryKey: ["agent-runs", runId],
    queryFn: () => agentRunApi.get(runId!),
    enabled: Boolean(runId),
    refetchInterval: (query) => (query.state.data && IN_FLIGHT.has(query.state.data.status) ? 3000 : false)
  });

  return (
    <Dialog open={Boolean(runId)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            <Bot className="h-4 w-4 text-primary" />
            {run.data?.capability.replaceAll("_", " ") ?? "Run"}
            {run.data && statusBadge(run.data.status)}
          </DialogTitle>
          <DialogDescription>
            {run.data?.goal ?? "Every step this run took, in order — what it called, with what, and what came back."}
          </DialogDescription>
        </DialogHeader>

        {run.isLoading && <Skeleton className="h-40 w-full" />}

        {run.data && (
          <div className="grid gap-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                ["Steps", `${run.data.stepCount} / ${run.data.maxSteps}`],
                ["Cost", money(run.data.costUsd)],
                ["Level", run.data.level.replaceAll("_", " ").toLowerCase()],
                ["Acting as", run.data.onBehalfOf?.name ?? "—"]
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border border-border bg-muted/30 p-2 text-center">
                  <p className="truncate text-sm font-semibold">{value}</p>
                  <p className="text-[11px] text-muted-foreground">{label}</p>
                </div>
              ))}
            </div>

            {run.data.taintedAt && (
              <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/5 p-2.5 text-xs">
                <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                <span>
                  This run read text authored outside the workspace, so from that step onward it could not apply anything —
                  whatever its level said. Stranger-authored text buys the least authority possible.
                </span>
              </p>
            )}

            {run.data.proposalId && (
              <p className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 p-2.5 text-xs">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-primary" />
                This run produced a proposal — review it on the AI suggestions page.
              </p>
            )}

            {/* Own scroll box: a tool result can be thousands of characters and must never make
                the dialog grow past the viewport. */}
            <div className="max-h-[45vh] overflow-y-auto rounded-lg border border-border">
              {(run.data.steps ?? []).length === 0 ? (
                <p className="p-6 text-center text-xs text-muted-foreground">
                  {IN_FLIGHT.has(run.data.status) ? "Waiting for the first step…" : "This run recorded no steps."}
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {(run.data.steps ?? []).map((step) => (
                    <TraceStep key={step.id} step={step} />
                  ))}
                </ul>
              )}
            </div>

            {run.data.error && (
              <p className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-2.5 text-xs text-destructive">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {run.data.error}
              </p>
            )}

            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Clock className="h-3 w-3" />
              Queued {new Date(run.data.createdAt).toLocaleString()}
              {run.data.finishedAt && ` · finished ${new Date(run.data.finishedAt).toLocaleString()}`}
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function TraceStep({ step }: { step: AgentRunStepRow }) {
  const [open, setOpen] = useState(false);
  const body = step.error ?? step.resultText;

  return (
    <li className="grid gap-1 p-2.5 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="shrink-0">{stepIcon(step.kind)}</span>
        <span className="font-medium">
          {step.index}. {step.toolName ?? step.kind}
        </span>
        <span className="text-muted-foreground">{step.kind}</span>
      </div>

      {step.argsJson !== null && step.argsJson !== undefined && (
        // Monospace and pre-wrapped: arguments are code, and rendering them as prose is how a
        // trace becomes unreadable exactly when somebody needs it.
        <pre className="overflow-x-auto rounded bg-muted/60 p-2 font-mono text-[11px] leading-relaxed">
          {JSON.stringify(step.argsJson, null, 2)}
        </pre>
      )}

      {body && (
        <>
          <div className={cn("overflow-x-auto rounded bg-muted/40 p-2 font-mono text-[11px] leading-relaxed", !open && "max-h-24 overflow-hidden")}>
            <pre className="whitespace-pre-wrap break-words">{body}</pre>
          </div>
          {body.length > 200 && (
            <button type="button" onClick={() => setOpen((v) => !v)} className="focus-ring w-fit rounded text-[11px] font-medium text-primary hover:underline">
              {open ? "Show less" : "Show everything"}
            </button>
          )}
        </>
      )}
    </li>
  );
}
