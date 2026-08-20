/**
 * WHAT: the Ask AI page — a full-width conversation with the workspace assistant, with a memory.
 *
 * WHY A PAGE WHEN THE PALETTE ALREADY ASKS: the palette answers one question and forgets it. This
 * keeps the history — every prompt, every answer, what each cost (model, tokens, dollars, seconds),
 * which tools it consulted, and a thumbs rating — and hands recent exchanges back to the model so
 * follow-ups work. The palette stays for the quick one-off and links here.
 *
 * WHAT THE ASSISTANT CAN AND CANNOT DO, stated in the UI because it shapes trust: it READS —
 * tickets, timesheets, changes, metrics, agents, workflows, always as you, never wider than your
 * own access — and it acts on nothing. Where an answer leads to an action, it names the page where
 * a person does it. Answers render as markdown (tables included) and may carry one real chart drawn
 * from tool-returned numbers.
 *
 * WHY FAILED ATTEMPTS RENDER IN THE FEED: "it failed at 14:02, and this is why" is part of the
 * history. A page that silently forgets failures reads as one that never fails, which is how trust
 * in the meta figures dies.
 */
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Eraser, Loader2, MessagesSquare, Send, Sparkles, ThumbsDown, ThumbsUp, Wrench } from "lucide-react";
import { askAiApi, type AiAskExchangeRow } from "../services/api";
import { cn } from "../lib/utils";
import { AiMarkdown } from "../components/ui/ai-markdown";
import { AiStrands } from "../components/ui/ai-strands";
import { Badge } from "../components/ui/badge";
import { BorderGlow } from "../components/ui/border-glow";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Skeleton } from "../components/ui/skeleton";
import { Textarea } from "../components/ui/textarea";
import { toast } from "../components/ui/toaster";

const serverMessage = (err: any, fallback: string) => err?.response?.data?.message ?? fallback;

const SUGGESTIONS = [
  "Summarize open critical bugs.",
  "How many changes are in flight, and at what risk?",
  "How many hours did I log this week, and where?",
  "Which workflows are switched on, and what triggers them?"
];

export function AskAi() {
  const qc = useQueryClient();
  const [prompt, setPrompt] = useState("");
  const feedRef = useRef<HTMLDivElement>(null);

  const history = useQuery({ queryKey: ["ask-ai", "history"], queryFn: () => askAiApi.history() });

  const ask = useMutation({
    mutationFn: (q: string) => askAiApi.ask(q),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ask-ai", "history"] }),
    onError: (err: any) => toast.error("Could not ask", { description: serverMessage(err, "Try again.") })
  });

  const submit = () => {
    const q = prompt.trim();
    if (q.length < 3 || ask.isPending) return;
    setPrompt("");
    ask.mutate(q);
  };

  // The feed follows the conversation — on new answers it scrolls to the latest, the way a person
  // reading a chat expects, without hijacking the scroll while they are reading older history.
  const count = history.data?.length ?? 0;
  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" });
  }, [count, ask.isPending]);

  const rows = history.data ?? [];

  return (
    <div className="flex h-[calc(100vh-8.5rem)] flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-lg bg-primary/10 text-primary">
            <MessagesSquare className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight">Ask AI</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Answers only from this workspace — tickets, timesheets, changes, projects, agents and workflows. It reads
              as you and acts on nothing; every answer shows what it consulted and what it cost.
            </p>
          </div>
        </div>
        {rows.length > 0 && <ClearHistoryButton />}
      </div>

      <div ref={feedRef} className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border bg-muted/20 p-3 sm:p-4">
        {history.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : rows.length === 0 && !ask.isPending ? (
          <EmptyState onPick={(q) => ask.mutate(q)} />
        ) : (
          <div className="mx-auto grid w-full max-w-4xl gap-4">
            {rows.map((row) => (
              <Exchange key={row.id} row={row} />
            ))}
            {ask.isPending && (
              <div className="grid gap-2">
                <UserBubble text={ask.variables ?? ""} />
                <Card>
                  <CardContent className="p-4">
                    <AiStrands label="Consulting the workspace…" />
                  </CardContent>
                </Card>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="mx-auto w-full max-w-4xl">
        <BorderGlow>
          <div className="flex items-end gap-2 p-2">
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder="Ask about your tickets, timesheets or changes… (Enter to send, Shift+Enter for a new line)"
              className="min-h-[2.75rem] max-h-40 flex-1 resize-none border-0 bg-transparent focus-visible:ring-0"
              aria-label="Ask AI"
            />
            <Button variant="ai" onClick={submit} disabled={prompt.trim().length < 3 || ask.isPending} aria-label="Ask">
              {ask.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Ask
            </Button>
          </div>
        </BorderGlow>
      </div>
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (q: string) => void }) {
  return (
    <div className="mx-auto grid max-w-xl gap-4 py-14 text-center">
      <Sparkles className="mx-auto h-8 w-8 text-primary" />
      <div>
        <p className="font-semibold">Ask your first question</p>
        <p className="mt-1 text-sm text-muted-foreground">
          The assistant consults live workspace data and shows its working — the tools it used, the model, the tokens,
          the cost and the time, on every answer.
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onPick(s)}
            className="rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-4 py-2 text-sm text-primary-foreground">{text}</p>
    </div>
  );
}

function Exchange({ row }: { row: AiAskExchangeRow }) {
  return (
    <div className="grid gap-2">
      <UserBubble text={row.prompt} />
      <Card>
        <CardContent className="grid gap-3 p-4">
          {row.error ? (
            <p className="flex items-start gap-2 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {row.error}
            </p>
          ) : (
            <AiMarkdown markdown={row.answer ?? ""} />
          )}

          {row.toolCalls.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <Wrench className="h-3 w-3 text-muted-foreground" aria-hidden />
              {/* What the answer actually consulted — the strip that separates "it looked" from
                  "it made that up". */}
              {row.toolCalls.map((t, i) => (
                <Badge key={i} variant="muted" className="font-mono text-[10px]">
                  {t.tool}
                </Badge>
              ))}
            </div>
          )}

          <MetaStrip row={row} />
        </CardContent>
      </Card>
    </div>
  );
}

function MetaStrip({ row }: { row: AiAskExchangeRow }) {
  const qc = useQueryClient();
  const rate = useMutation({
    // Pressing the active thumb again clears it — "unrated" stays reachable.
    mutationFn: (value: 1 | -1) => askAiApi.feedback(row.id, row.feedback === value ? 0 : value),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ask-ai", "history"] }),
    onError: (err: any) => toast.error("Could not save the rating", { description: serverMessage(err, "Try again.") })
  });

  const cost = row.costUsd != null ? Number(row.costUsd) : null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] tabular-nums text-muted-foreground">
        {row.model && <span title="Model">{row.model}</span>}
        <span title="Response time">{(row.durationMs / 1000).toFixed(1)}s</span>
        <span title="Tokens in / out">
          {row.inputTokens.toLocaleString()} in · {row.outputTokens.toLocaleString()} out
        </span>
        {/* Estimated the same way the AI budget meters it, and absent rather than $0.0000 when the
            attempt never reached the model. */}
        {cost != null && <span title="Estimated cost">${cost.toFixed(4)}</span>}
        <span title="Asked at">{new Date(row.createdAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span>
      </p>
      {!row.error && (
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className={cn("h-7 w-7", row.feedback === 1 ? "text-success" : "text-muted-foreground")}
            onClick={() => rate.mutate(1)}
            aria-label="Good answer"
            aria-pressed={row.feedback === 1}
          >
            <ThumbsUp className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cn("h-7 w-7", row.feedback === -1 ? "text-destructive" : "text-muted-foreground")}
            onClick={() => rate.mutate(-1)}
            aria-label="Bad answer"
            aria-pressed={row.feedback === -1}
          >
            <ThumbsDown className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
}

/** Two clicks, not a dialog: the first arms it for a moment, the second deletes. Enough friction
 *  for an action that erases history, without a modal for something only the asker can see. */
function ClearHistoryButton() {
  const qc = useQueryClient();
  const [armed, setArmed] = useState(false);
  const clear = useMutation({
    mutationFn: () => askAiApi.clear(),
    onSuccess: (r) => {
      toast.success(`Cleared ${r.deleted} exchange${r.deleted === 1 ? "" : "s"}`);
      qc.invalidateQueries({ queryKey: ["ask-ai", "history"] });
    },
    onError: (err: any) => toast.error("Could not clear", { description: serverMessage(err, "Try again.") })
  });

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 3500);
    return () => clearTimeout(timer);
  }, [armed]);

  return (
    <Button
      variant={armed ? "destructive" : "outline"}
      size="sm"
      disabled={clear.isPending}
      onClick={() => {
        if (armed) clear.mutate();
        else setArmed(true);
      }}
    >
      <Eraser className="h-3.5 w-3.5" />
      {armed ? "Really clear everything?" : "Clear history"}
    </Button>
  );
}
