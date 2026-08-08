/**
 * WHAT: golden datasets — the "here's what the right answer looks like" sets that make prompt
 * changes measurable instead of a matter of opinion.
 *
 * THE UX RULE — correct, don't author. You never type a test case from scratch here. You pick a
 * real interaction that went wrong, see exactly what the AI was given and what it said, and edit
 * that answer into the right one. Hand-invented examples drift toward what someone imagines users
 * do, and a prompt tuned against fiction gets worse in production while the numbers look better.
 *
 * Requires content capture: without the recorded inputs there's nothing to replay, so the card
 * says that up front rather than letting someone write out a correction and then hit an error.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Database, Play, Plus, ThumbsDown, ThumbsUp, Trash2 } from "lucide-react";
import { useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Skeleton } from "../../components/ui/skeleton";
import { Textarea } from "../../components/ui/textarea";
import { toast } from "../../components/ui/toaster";
import { aiDatasetApi, aiEvalApi, type AIPromotableInteraction } from "../../services/api";

/** The capabilities worth building a golden set for. Structured ones first — they're scorable
 *  deterministically, so evals on them cost nothing beyond the replay itself. */
const FEATURES = [
  { value: "triage", label: "Ticket triage" },
  { value: "chat_triage", label: "Chat-to-ticket triage" },
  { value: "ci_failure_triage", label: "CI failure triage" },
  { value: "security_finding_triage", label: "Security finding triage" },
  { value: "duplicate_detection", label: "Duplicate detection" },
  { value: "pr_review_summary", label: "PR review summary" },
  { value: "comment_summary", label: "Comment summary" },
  { value: "writing_assistant", label: "Writing assistant" },
  { value: "text_refine", label: "Refine text" },
  { value: "ask_ai", label: "Ask AI" }
];

function featureLabel(value: string): string {
  return FEATURES.find((f) => f.value === value)?.label ?? value;
}

export function AIDatasetsCard({ readOnly, contentCaptureOn }: { readOnly: boolean; contentCaptureOn: boolean }) {
  const queryClient = useQueryClient();
  const datasets = useQuery({ queryKey: ["ai", "datasets"], queryFn: aiDatasetApi.list });

  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ name: "", feature: "triage", description: "" });
  const [openDatasetId, setOpenDatasetId] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => aiDatasetApi.create({ name: draft.name.trim(), feature: draft.feature, description: draft.description.trim() || undefined }),
    onSuccess: () => {
      toast.success("Dataset created");
      setCreating(false);
      setDraft({ name: "", feature: "triage", description: "" });
      queryClient.invalidateQueries({ queryKey: ["ai", "datasets"] });
    },
    onError: (err: any) => toast.error("Could not create", { description: err?.response?.data?.message ?? "Try again." })
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Database className="h-4 w-4 text-primary" />
          Golden datasets
        </CardTitle>
        <CardDescription>
          Real examples paired with the answer you say is correct. These are what a prompt change gets measured against — without
          them, "the new prompt seems better" is a guess.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {!contentCaptureOn && (
          <p className="rounded-md border border-dashed border-border bg-muted/30 p-3 text-sm text-muted-foreground">
            Turn on <strong>Also store prompts and responses</strong> above first. A dataset replays the exact inputs the AI was
            given, so without them recorded there's nothing to build a set from.
          </p>
        )}

        {datasets.isLoading && <Skeleton className="h-16 w-full" />}

        {!datasets.isLoading && (datasets.data ?? []).length === 0 && (
          <p className="py-2 text-sm text-muted-foreground">No datasets yet.</p>
        )}

        <div className="grid gap-1.5">
          {(datasets.data ?? []).map((ds) => (
            <button
              key={ds.id}
              type="button"
              onClick={() => setOpenDatasetId(ds.id)}
              className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2.5 text-left text-sm transition hover:border-primary/50 hover:bg-muted/40"
            >
              <span className="font-medium">{ds.name}</span>
              <Badge variant="muted">{featureLabel(ds.feature)}</Badge>
              <span className="text-xs text-muted-foreground">
                {ds.itemCount} example{ds.itemCount === 1 ? "" : "s"}
              </span>
              {ds.description && <span className="w-full text-xs text-muted-foreground">{ds.description}</span>}
            </button>
          ))}
        </div>

        {!readOnly && !creating && (
          <Button size="sm" variant="outline" className="justify-self-start" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" />New dataset
          </Button>
        )}

        {!readOnly && creating && (
          <div className="grid gap-3 rounded-md border border-dashed border-border p-3">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="ds-name">Name</Label>
                <Input id="ds-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Triage regressions" />
              </div>
              <div className="grid gap-1.5">
                <Label>Feature</Label>
                <Select value={draft.feature} onValueChange={(v) => setDraft({ ...draft, feature: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {FEATURES.map((f) => (
                      <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              A dataset covers one capability — its examples are replayed against that capability, so they can't be mixed.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={!draft.name.trim() || create.isPending} onClick={() => create.mutate()}>
                <Check className="h-4 w-4" />Create
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
            </div>
          </div>
        )}
      </CardContent>

      <DatasetDetailDialog
        datasetId={openDatasetId}
        readOnly={readOnly}
        contentCaptureOn={contentCaptureOn}
        onClose={() => setOpenDatasetId(null)}
      />
    </Card>
  );
}

function DatasetDetailDialog({
  datasetId,
  readOnly,
  contentCaptureOn,
  onClose
}: {
  datasetId: string | null;
  readOnly: boolean;
  contentCaptureOn: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [promoting, setPromoting] = useState<AIPromotableInteraction | null>(null);

  const dataset = useQuery({
    queryKey: ["ai", "datasets", datasetId],
    queryFn: () => aiDatasetApi.get(datasetId!),
    enabled: Boolean(datasetId)
  });

  const candidates = useQuery({
    queryKey: ["ai", "datasets", datasetId, "candidates"],
    queryFn: () => aiDatasetApi.candidates(datasetId!),
    enabled: Boolean(datasetId) && contentCaptureOn
  });

  // The rating the promotion filter reads. Toggling "down" is how an admin browsing candidates
  // marks "this answer was wrong" without correcting it yet — the row then stays on the problems
  // list for whoever does the correcting. Same endpoint the activity log's thumbs never used.
  const rate = useMutation({
    mutationFn: ({ id, feedback }: { id: string; feedback: "up" | "down" | null }) =>
      aiDatasetApi.setInteractionFeedback(id, feedback),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["ai", "datasets", datasetId, "candidates"] }),
    onError: (err: any) => toast.error("Could not save the rating", { description: err?.response?.data?.message ?? "Try again." })
  });

  const runEval = useMutation({
    mutationFn: () => aiEvalApi.enqueue({ datasetId: datasetId! }),
    onSuccess: (run) => {
      toast.success("Evaluation queued", {
        description: `${run.itemCount} example${run.itemCount === 1 ? "" : "s"}, estimated ${
          run.estimatedCostUsd == null ? "cost unknown" : `$${run.estimatedCostUsd.toFixed(3)}`
        }. Results appear in the Evaluations card.`
      });
      queryClient.invalidateQueries({ queryKey: ["ai", "evals"] });
    },
    // The refusals here are informative — budget exceeded, one already running, no examples —
    // so the server's message is shown rather than a generic failure.
    onError: (err: any) => toast.error("Could not start", { description: err?.response?.data?.message ?? "Try again." })
  });

  const removeItem = useMutation({
    mutationFn: (itemId: string) => aiDatasetApi.removeItem(datasetId!, itemId),
    onSuccess: () => {
      toast.success("Example removed");
      queryClient.invalidateQueries({ queryKey: ["ai", "datasets", datasetId] });
      queryClient.invalidateQueries({ queryKey: ["ai", "datasets"] });
    },
    onError: (err: any) => toast.error("Could not remove", { description: err?.response?.data?.message ?? "Try again." })
  });

  return (
    <>
      <Dialog open={Boolean(datasetId)} onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="max-h-[92vh] w-[min(96vw,860px)] max-w-none overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{dataset.data?.name ?? "Dataset"}</DialogTitle>
            <DialogDescription>
              {dataset.data ? featureLabel(dataset.data.feature) : ""} — examples replayed whenever you test a prompt change.
            </DialogDescription>
          </DialogHeader>

          {dataset.isLoading && <Skeleton className="h-40 w-full" />}

          {dataset.data && (
            <div className="grid gap-5">
              {!readOnly && (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    disabled={runEval.isPending || dataset.data.items.length === 0 || !dataset.data.replayable}
                    onClick={() => runEval.mutate()}
                  >
                    <Play className="h-4 w-4" />Run evaluation
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    {!dataset.data.replayable
                      ? "This capability can't be replayed automatically yet."
                      : dataset.data.items.length === 0
                        ? "Add at least one example first."
                        : "Replays every example and scores it. Costs real model calls."}
                  </span>
                </div>
              )}

              <div className="grid gap-1.5">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Examples ({dataset.data.items.length})
                </p>
                {dataset.data.items.length === 0 && (
                  <p className="py-2 text-sm text-muted-foreground">
                    Nothing here yet. Pick a real failure below and correct it — that's what makes the set trustworthy.
                  </p>
                )}
                {dataset.data.items.map((item) => (
                  <div key={item.id} className="grid gap-1 rounded-md border border-border p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="muted">{item.expectedKind}</Badge>
                      <span className="text-xs text-muted-foreground">{new Date(item.createdAt).toLocaleDateString()}</span>
                      {!readOnly && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="ml-auto h-7 text-destructive hover:bg-destructive/10 hover:text-destructive"
                          disabled={removeItem.isPending}
                          onClick={() => removeItem.mutate(item.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">Expected</p>
                    <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 font-mono text-xs">{item.expectedOutput}</pre>
                    {item.notes && <p className="text-xs text-muted-foreground">Note: {item.notes}</p>}
                  </div>
                ))}
              </div>

              {!readOnly && contentCaptureOn && (
                <div className="grid gap-1.5">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Recent problems — pick one to correct
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Responses that failed to parse, or that someone rated down. These are where a golden set earns its keep.
                  </p>
                  {candidates.isLoading && <Skeleton className="h-16 w-full" />}
                  {!candidates.isLoading && (candidates.data ?? []).length === 0 && (
                    <p className="py-2 text-sm text-muted-foreground">
                      No recorded problems for this capability — nothing to correct right now.
                    </p>
                  )}
                  {(candidates.data ?? []).map((c) => (
                    <div key={c.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
                      {c.parseOk === false && <Badge variant="destructive">unusable</Badge>}
                      {c.feedback === "down" && <Badge variant="warning">rated down</Badge>}
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                        {c.outputText ? c.outputText.slice(0, 90) : "(no output recorded)"}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">{new Date(c.createdAt).toLocaleDateString()}</span>
                      {!readOnly && (
                        <span className="flex shrink-0 items-center gap-0.5">
                          <Button
                            size="icon"
                            variant={c.feedback === "up" ? "default" : "ghost"}
                            className="h-7 w-7"
                            title="This answer was right — clears it off the problems list"
                            disabled={rate.isPending}
                            onClick={() => rate.mutate({ id: c.id, feedback: c.feedback === "up" ? null : "up" })}
                          >
                            <ThumbsUp className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant={c.feedback === "down" ? "destructive" : "ghost"}
                            className="h-7 w-7"
                            title="This answer was wrong — keeps it on the problems list for correcting"
                            disabled={rate.isPending}
                            onClick={() => rate.mutate({ id: c.id, feedback: c.feedback === "down" ? null : "down" })}
                          >
                            <ThumbsDown className="h-3.5 w-3.5" />
                          </Button>
                        </span>
                      )}
                      <Button size="sm" variant="outline" className="h-7 shrink-0" disabled={!c.replayable} onClick={() => setPromoting(c)}>
                        {c.replayable ? "Correct it" : "Inputs not kept"}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PromoteDialog
        datasetId={datasetId}
        interaction={promoting}
        onClose={() => setPromoting(null)}
        onSaved={() => {
          setPromoting(null);
          queryClient.invalidateQueries({ queryKey: ["ai", "datasets", datasetId] });
          queryClient.invalidateQueries({ queryKey: ["ai", "datasets"] });
        }}
      />
    </>
  );
}

/** The "correct, don't author" editor: inputs shown read-only, the AI's actual answer pre-filled
 *  and editable. The reviewer's job is to fix what's wrong, not invent a scenario. */
function PromoteDialog({
  datasetId,
  interaction,
  onClose,
  onSaved
}: {
  datasetId: string | null;
  interaction: AIPromotableInteraction | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [expected, setExpected] = useState("");
  const [notes, setNotes] = useState("");
  const [seededFor, setSeededFor] = useState<string | null>(null);

  // Seed from the actual output the first time this interaction is opened, then leave the
  // reviewer's edits alone.
  if (interaction && seededFor !== interaction.id) {
    setSeededFor(interaction.id);
    setExpected(interaction.outputText ?? "");
    setNotes("");
  }

  const save = useMutation({
    mutationFn: () =>
      aiDatasetApi.addItem(datasetId!, {
        interactionId: interaction!.id,
        expectedOutput: expected,
        notes: notes.trim() || undefined
      }),
    onSuccess: () => {
      toast.success("Added to the golden set");
      onSaved();
    },
    onError: (err: any) => toast.error("Could not add", { description: err?.response?.data?.message ?? "Try again." })
  });

  return (
    <Dialog open={Boolean(interaction)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92vh] w-[min(96vw,720px)] max-w-none overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Correct this answer</DialogTitle>
          <DialogDescription>
            Edit what the AI said into what it should have said. This becomes the expected answer whenever these inputs are
            replayed.
          </DialogDescription>
        </DialogHeader>

        {interaction && (
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label>What the AI was given</Label>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-3 font-mono text-xs">
                {JSON.stringify(interaction.paramsJson ?? {}, null, 2)}
              </pre>
              <p className="text-xs text-muted-foreground">Read-only — this is the real input, and changing it would break the comparison.</p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="expected">The correct answer</Label>
              <Textarea id="expected" rows={8} value={expected} onChange={(e) => setExpected(e.target.value)} className="font-mono text-xs" />
              <p className="text-xs text-muted-foreground">Pre-filled with what the AI actually returned, so you're correcting rather than starting from nothing.</p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ds-notes">Why was it wrong? (optional)</Label>
              <Input id="ds-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Picked CRITICAL for a cosmetic bug" />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={!expected.trim() || save.isPending} onClick={() => save.mutate()}>
            <Check className="h-4 w-4" />Add to set
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
