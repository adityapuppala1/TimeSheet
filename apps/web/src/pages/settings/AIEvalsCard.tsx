/**
 * WHAT: the results end of the loop — every evaluation run, and what it scored.
 *
 * THE POINT OF THIS SCREEN is comparison. A single "83%" means very little on its own; "83% on the
 * built-in prompt, 91% on v3" is a decision. So runs are listed newest-first with their prompt
 * version and model right next to the score, because a score without those two facts isn't
 * reproducible and shouldn't be trusted.
 *
 * Runs are queued, not synchronous — a run is N real model calls. The list polls while anything is
 * still in flight and stops as soon as everything settles, so a workspace that isn't evaluating
 * costs nothing.
 */
import { useQuery } from "@tanstack/react-query";
import { FlaskConical } from "lucide-react";
import { useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Skeleton } from "../../components/ui/skeleton";
import { aiEvalApi, type AIEvalRunRow } from "../../services/api";

const IN_FLIGHT = new Set(["QUEUED", "RUNNING"]);

function statusBadge(status: string) {
  if (status === "COMPLETED") return <Badge variant="success">completed</Badge>;
  if (status === "RUNNING") return <Badge variant="info">running</Badge>;
  if (status === "QUEUED") return <Badge variant="muted">queued</Badge>;
  if (status === "PARTIAL") return <Badge variant="warning">stopped early</Badge>;
  return <Badge variant="destructive">failed</Badge>;
}

function pct(value: number | null): string {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

function money(value: number | null): string {
  return value == null ? "—" : `$${value.toFixed(3)}`;
}

export function AIEvalsCard() {
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const runs = useQuery({
    queryKey: ["ai", "evals"],
    queryFn: () => aiEvalApi.list(),
    // Poll only while something is actually in flight — an idle workspace shouldn't be issuing a
    // request every five seconds forever.
    refetchInterval: (query) => ((query.state.data ?? []).some((r: AIEvalRunRow) => IN_FLIGHT.has(r.status)) ? 5000 : false)
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FlaskConical className="h-4 w-4 text-primary" />
          Evaluations
        </CardTitle>
        <CardDescription>
          Replays a golden dataset and scores each answer against the one you said was correct. Run it once on the built-in prompt
          to get a baseline, then again after a prompt change — the two numbers are the comparison.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {runs.isLoading && <Skeleton className="h-20 w-full" />}
        {!runs.isLoading && (runs.data ?? []).length === 0 && (
          <p className="py-2 text-sm text-muted-foreground">
            No evaluations yet. Open a golden dataset above and choose <strong>Run evaluation</strong>.
          </p>
        )}

        {/* Phone: stacked cards. The desktop row is a 6-column grid that would be unreadable
            below ~640px, so it swaps rather than scrolling sideways. */}
        <div className="grid gap-2 sm:hidden">
          {(runs.data ?? []).map((run) => (
            <button
              key={run.id}
              type="button"
              onClick={() => setOpenRunId(run.id)}
              className="grid gap-1 rounded-md border border-border p-3 text-left"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{run.dataset.name}</span>
                {statusBadge(run.status)}
              </div>
              <p className="text-sm">
                {pct(run.avgScore)} average · {run.passCount}/{run.scoredCount} exact
              </p>
              <p className="text-xs text-muted-foreground">
                {run.promptVersionId ? "custom prompt" : "built-in prompt"} · {run.model} · {money(run.actualCostUsd)}
              </p>
            </button>
          ))}
        </div>

        <div className="hidden sm:block">
          <div className="grid grid-cols-[1.4fr_auto_auto_auto_auto_auto] items-center gap-x-4 gap-y-1 text-sm">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Dataset</span>
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Prompt</span>
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</span>
            <span className="text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">Score</span>
            <span className="text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">Exact</span>
            <span className="text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">Cost</span>
            {(runs.data ?? []).map((run) => (
              <button
                key={run.id}
                type="button"
                onClick={() => setOpenRunId(run.id)}
                className="col-span-6 grid grid-cols-subgrid items-center rounded-md border border-transparent px-1 py-2 text-left transition hover:border-border hover:bg-muted/40"
              >
                <span className="truncate font-medium">{run.dataset.name}</span>
                <span className="text-xs text-muted-foreground">{run.promptVersionId ? "custom" : "built-in"}</span>
                <span>{statusBadge(run.status)}</span>
                <span className="text-right tabular-nums">{pct(run.avgScore)}</span>
                <span className="text-right tabular-nums text-muted-foreground">
                  {run.passCount}/{run.scoredCount}
                </span>
                <span className="text-right tabular-nums text-muted-foreground">{money(run.actualCostUsd)}</span>
              </button>
            ))}
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          <strong>Score</strong> is the average across examples — for structured answers it's the share of fields that matched, so
          a near-miss reads differently from a completely wrong answer. <strong>Exact</strong> counts answers that matched
          entirely.
        </p>
      </CardContent>

      <EvalRunDialog runId={openRunId} onClose={() => setOpenRunId(null)} />
    </Card>
  );
}

function EvalRunDialog({ runId, onClose }: { runId: string | null; onClose: () => void }) {
  const run = useQuery({
    queryKey: ["ai", "evals", runId],
    queryFn: () => aiEvalApi.get(runId!),
    enabled: Boolean(runId),
    refetchInterval: (query) => (query.state.data && IN_FLIGHT.has(query.state.data.status) ? 5000 : false)
  });

  return (
    <Dialog open={Boolean(runId)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92vh] w-[min(96vw,900px)] max-w-none overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{run.data?.dataset.name ?? "Evaluation"}</DialogTitle>
          <DialogDescription>
            {run.data
              ? `${run.data.promptVersionId ? "Custom prompt" : "Built-in prompt"} · ${run.data.model} · ${run.data.scoredCount} of ${run.data.itemCount} scored`
              : ""}
          </DialogDescription>
        </DialogHeader>

        {run.isLoading && <Skeleton className="h-40 w-full" />}

        {run.data && (
          <div className="grid gap-4">
            {run.data.error && (
              <p className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">{run.data.error}</p>
            )}

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { label: "Average score", value: pct(run.data.avgScore) },
                { label: "Exact matches", value: `${run.data.passCount}/${run.data.scoredCount}` },
                { label: "Estimated cost", value: money(run.data.estimatedCostUsd) },
                { label: "Actual cost", value: money(run.data.actualCostUsd) }
              ].map((stat) => (
                <div key={stat.label} className="rounded-md border border-border p-3">
                  <p className="text-xs text-muted-foreground">{stat.label}</p>
                  <p className="text-lg font-semibold tabular-nums">{stat.value}</p>
                </div>
              ))}
            </div>

            <div className="grid gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Results — failures first, since those are the ones worth reading
              </p>
              {[...run.data.results]
                .sort((a, b) => a.score - b.score)
                .map((result) => (
                  <div key={result.id} className="grid gap-1.5 rounded-md border border-border p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      {result.error ? (
                        <Badge variant="muted">not replayed</Badge>
                      ) : result.passed ? (
                        <Badge variant="success">exact</Badge>
                      ) : (
                        <Badge variant="warning">{pct(result.score)}</Badge>
                      )}
                      {result.notes && <span className="text-xs text-muted-foreground">{result.notes}</span>}
                    </div>
                    {result.error && <p className="text-xs text-muted-foreground">{result.error}</p>}
                    {result.detail && (
                      <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 font-mono text-xs">
                        {result.detail}
                      </pre>
                    )}
                    {!result.passed && result.output && (
                      <div className="grid gap-1 sm:grid-cols-2">
                        <div className="grid gap-1">
                          <p className="text-xs text-muted-foreground">Expected</p>
                          <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 font-mono text-xs">
                            {result.expectedOutput ?? "—"}
                          </pre>
                        </div>
                        <div className="grid gap-1">
                          <p className="text-xs text-muted-foreground">Got</p>
                          <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 font-mono text-xs">
                            {result.output}
                          </pre>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              {run.data.results.length === 0 && (
                <p className="py-2 text-sm text-muted-foreground">
                  {IN_FLIGHT.has(run.data.status) ? "Waiting for the first result…" : "No results were produced."}
                </p>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
