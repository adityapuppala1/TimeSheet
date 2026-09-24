import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { askAiApi, type FlowCatalogue, type FlowPayload } from "../services/api";
import { flowDraftPrompt, parseFlowDraft } from "../lib/flow-draft";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { Label } from "./ui/label";

export function FlowDraftAssistant({ catalogue, canApply, onApply }: {
  catalogue: FlowCatalogue;
  canApply: boolean;
  onApply: (draft: FlowPayload) => void;
}) {
  const [request, setRequest] = useState("");
  const queryClient = useQueryClient();
  const draft = useMutation({
    mutationFn: async (outcome: string) => {
      const result = await askAiApi.ask(flowDraftPrompt(outcome, catalogue), { readOnly: true });
      await queryClient.invalidateQueries({ queryKey: ["ask-ai", "history"] });
      if (result.error || !result.answer) throw new Error(result.error || "The AI returned no draft.");
      try {
        return parseFlowDraft(result.answer, catalogue);
      } catch {
        throw new Error("The AI returned an unsupported draft. Try a more specific outcome.");
      }
    }
  });
  const matchesOutcome = draft.variables === request.trim();
  return <section className="grid gap-3 border-b border-border pb-4" aria-label="AI workflow draft">
    <Label htmlFor="flow-outcome">Requested outcome</Label>
    <Textarea id="flow-outcome" maxLength={600} rows={2} value={request} onChange={(event) => setRequest(event.target.value)} />
    <div><Button variant="ai" disabled={draft.isPending || request.trim().length < 3} onClick={() => draft.mutate(request.trim())}><Sparkles className="h-4 w-4" />{draft.isPending ? "Drafting..." : "Draft with AI"}</Button></div>
    {draft.isError && matchesOutcome && <p role="alert" className="text-sm text-destructive">{draft.error.message}</p>}
    {!draft.isIdle && !draft.isPending && !matchesOutcome && <p role="status" className="text-sm text-muted-foreground">The requested outcome changed. Generate a new draft for this outcome.</p>}
    {draft.data && matchesOutcome && !draft.isPending && !draft.isError && <div className="grid gap-2">
      <h3 className="text-sm font-semibold">{draft.data.name}</h3>
      <p className="text-sm text-muted-foreground">{draft.data.description}</p>
      <ol className="list-inside list-decimal text-sm">{draft.data.steps.map((step, index) => <li key={index}>{step.capability || String(step.config?.action || step.config?.field || "Human approval")}{step.kind === "BRANCH" && ` ${step.config?.op === "is_not" ? "is not" : "is"} ${step.config?.value ?? "(choose a value)"}`}</li>)}</ol>
      <p className="text-xs text-muted-foreground">Unsaved draft · Manual trigger · Step configuration required</p>
      <div><Button disabled={!canApply} onClick={() => { onApply(draft.data); draft.reset(); }}>Use draft</Button></div>
      {!canApply && <p role="status" className="text-xs text-muted-foreground">The editor already contains changes. Start a new flow to use this draft.</p>}
    </div>}
  </section>;
}
