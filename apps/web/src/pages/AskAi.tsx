/**
 * WHAT: the Ask AI page — a conversation with the workspace assistant, with a memory.
 *
 * WHY IT IS SHAPED LIKE A MESSENGER AND NOT A FORM: the mental model people bring to "ask a
 * question, get an answer, ask a follow-up" is a chat thread, and every departure from that shape
 * costs orientation. So: one centred column, the person's words in bubbles on the right, the
 * assistant's beside its avatar on the left, day separators when the history spans days, and the
 * composer pinned at the bottom where a thumb expects it. The assistant's answers get most of the
 * column's width because they carry tables and charts; the person's questions never need it.
 *
 * WHAT THE ASSISTANT CAN AND CANNOT DO, stated in the UI because it shapes trust: it READS as you —
 * tickets, timesheets, changes, projects, people, agents, workflows — and the one thing it can
 * write is a DRAFT timesheet entry you review and submit yourself. Every answer carries its own
 * receipts: the tools it consulted, the model, the tokens, the cost, the time.
 *
 * WHY FAILED ATTEMPTS RENDER IN THE FEED: "it failed at 14:02, and this is why" is part of the
 * history. A page that silently forgets failures reads as one that never fails, which is how trust
 * in the meta figures dies.
 */
import { Fragment, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Copy, Eraser, Loader2, MessagesSquare, Send, Sparkles, ThumbsDown, ThumbsUp, Wrench } from "lucide-react";
import { askAiApi, type AiAskExchangeRow } from "../services/api";
import { AskAiCapabilitiesButton, useAskAiSuggestions } from "../components/ai/ask-ai-capabilities";
import { SlashMenu, useSlashMenu } from "../components/ai/slash-menu";
import { copyText } from "../lib/clipboard";
import { cn } from "../lib/utils";
import { AiMarkdown } from "../components/ui/ai-markdown";
import { AiLoader } from "../components/ui/strands-gl";
import { Badge } from "../components/ui/badge";
import { BorderGlow } from "../components/ui/border-glow";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { Textarea } from "../components/ui/textarea";
import { toast } from "../components/ui/toaster";

const serverMessage = (err: any, fallback: string) => err?.response?.data?.message ?? fallback;

export function AskAi() {
  const qc = useQueryClient();
  const [prompt, setPrompt] = useState("");
  const feedRef = useRef<HTMLDivElement>(null);

  const history = useQuery({ queryKey: ["ask-ai", "history"], queryFn: () => askAiApi.history() });
  // Role-derived, not hardcoded: every chip is backed by a capability this person's assistant can
  // actually reach, so an administrator is offered the spend and health questions and an engineer
  // is not offered a question that would only come back refused.
  const suggestions = useAskAiSuggestions();
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  /* The same capability list the "What can it do?" dialog shows, and the same one the server builds
     the prompt from — so the menu can never offer something the assistant would refuse. Cached by
     react-query, so opening the menu costs no request. */
  const capabilities = useQuery({ queryKey: ["ask-ai", "capabilities"], queryFn: () => askAiApi.capabilities() });
  const slash = useSlashMenu({
    value: prompt,
    capabilities: capabilities.data,
    onPick: (next) => {
      setPrompt(next);
      // Focus back into the box with the caret at the end, so the pick reads as the START of a
      // sentence somebody keeps typing rather than as a finished command.
      requestAnimationFrame(() => {
        const el = promptRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(next.length, next.length);
      });
    }
  });

  const ask = useMutation({
    mutationFn: (q: string) => askAiApi.ask(q),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ask-ai", "history"] }),
    onError: (err: any, q) => {
      toast.error("Could not ask", { description: serverMessage(err, "Try again.") });
      // The question came out of the composer before the request; a failure puts it back — unless
      // the person has already started typing something else, whose words win.
      setPrompt((current) => current.trim() || q);
    }
  });

  const submit = () => {
    const q = prompt.trim();
    if (q.length < 3 || ask.isPending) return;
    setPrompt("");
    ask.mutate(q);
  };

  // The feed follows the conversation ONLY while the reader is already at the end. Tracked on
  // scroll rather than assumed: yanking someone to the bottom while they re-read Tuesday's answer
  // is the classic chat-feed sin, and an unconditional scrollTo here committed it.
  const nearBottomRef = useRef(true);
  const onFeedScroll = () => {
    const el = feedRef.current;
    if (el) nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
  };
  const count = history.data?.length ?? 0;
  useEffect(() => {
    // A question the person just sent always counts as "reading the end".
    if (ask.isPending) nearBottomRef.current = true;
    if (nearBottomRef.current) {
      feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [count, ask.isPending]);

  const rows = history.data ?? [];
  // Chips stay visible while the conversation is young — the moment somebody has a rhythm going
  // they are noise, so they retire after a few exchanges rather than living in the layout forever.
  const showChips = rows.length <= 2 && !ask.isPending;

  return (
    <div className="flex h-[calc(100vh-7.5rem)] flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 pb-3">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-primary/15 to-info/15 text-primary">
            <MessagesSquare className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-black tracking-tight">Ask AI</h1>
            <p className="text-xs text-muted-foreground">
              Reads this workspace as you. The one thing it writes is a <em>draft</em> timesheet entry — you review and
              submit it.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <AskAiCapabilitiesButton />
          {rows.length > 0 && <ClearHistoryButton />}
        </div>
      </header>

      <div ref={feedRef} onScroll={onFeedScroll} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-1 pb-4">
          {history.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : rows.length === 0 && !ask.isPending ? (
            <EmptyState />
          ) : (
            <div className="grid gap-5">
              {rows.map((row, i) => (
                <Fragment key={row.id}>
                  <DaySeparator current={row.createdAt} previous={rows[i - 1]?.createdAt} />
                  <Exchange row={row} />
                </Fragment>
              ))}
              {ask.isPending && (
                <div className="grid gap-3">
                  <UserBubble text={ask.variables ?? ""} />
                  <AssistantRow>
                    {/* The app's "waiting for the answer" mark, in its large-canvas form — one
                        luminous thread breathing across the bubble. */}
                    <div className="rounded-2xl rounded-tl-md border border-primary/20 bg-card px-4 py-3">
                      <AiLoader label="Consulting the workspace…" />
                    </div>
                  </AssistantRow>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="mx-auto w-full max-w-3xl pt-2">
        {showChips && rows.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {suggestions.slice(0, 3).map((s) => (
              <SuggestionChip key={s} text={s} onPick={(q) => ask.mutate(q)} />
            ))}
          </div>
        )}
        {/* `relative` is what the slash menu anchors to — it opens upward, because the composer is
            pinned to the bottom of the page. */}
        <div className="relative">
        <SlashMenu menu={slash} />
        <BorderGlow>
          <div className="flex items-end gap-2 p-2">
            <Textarea
              ref={promptRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                // The menu gets first refusal on the key: while it is open, Enter picks a
                // capability rather than sending a half-typed "/tick".
                if (slash.handleKey(e)) return;
                if (e.key === "Escape" && slash.open) {
                  setPrompt("");
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder="Ask about your tickets, timesheets or changes… (/ for capabilities, Enter to send)"
              className="max-h-40 min-h-[2.75rem] flex-1 resize-none border-0 bg-transparent focus-visible:ring-0"
              aria-label="Ask AI"
            />
            <Button variant="ai" onClick={submit} disabled={prompt.trim().length < 3 || ask.isPending} aria-label="Ask">
              {ask.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Ask
            </Button>
          </div>
        </BorderGlow>
        </div>
        <p className="mt-1.5 text-center text-[10px] text-muted-foreground">
          Answers show the tools consulted, the model, tokens, cost and time. Ratings feed the workspace's AI quality
          datasets.
        </p>
      </div>
    </div>
  );

  function EmptyState() {
    return (
      <div className="grid gap-5 py-16 text-center">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-primary/15 to-info/15">
          <Sparkles className="h-7 w-7 text-primary" />
        </div>
        <div>
          <p className="text-lg font-semibold">Ask your workspace anything</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Live answers from your tickets, timesheets, changes and people — with tables and charts where the numbers
            deserve them. What it can reach depends on your role; <em>What can it do?</em> above lists every capability
            and names the ones your role does not open.
          </p>
        </div>
        <div className="mx-auto flex max-w-xl flex-wrap justify-center gap-2">
          {suggestions.map((s) => (
            <SuggestionChip key={s} text={s} onPick={(q) => ask.mutate(q)} />
          ))}
        </div>
      </div>
    );
  }
}

function SuggestionChip({ text, onPick }: { text: string; onPick: (q: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onPick(text)}
      className="rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
    >
      {text}
    </button>
  );
}

/** A quiet date chip between messages from different days — the cue that turns a long history from
 *  one endless scroll into a diary. */
function DaySeparator({ current, previous }: { current: string; previous?: string }) {
  const day = new Date(current).toDateString();
  if (previous && new Date(previous).toDateString() === day) return null;
  const label = new Date(current).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
  return (
    <div className="flex items-center gap-3 py-1" aria-hidden>
      <span className="h-px flex-1 bg-border" />
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <p className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm leading-relaxed text-primary-foreground">
        {text}
      </p>
    </div>
  );
}

/** The assistant's gutter: avatar beside the bubble, so the feed reads as a conversation between
 *  two parties rather than a stack of forms. */
function AssistantRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5">
      <div className="mt-1 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-primary/20 to-info/20 text-primary">
        <Sparkles className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function Exchange({ row }: { row: AiAskExchangeRow }) {
  return (
    <div className="grid gap-3">
      <UserBubble text={row.prompt} />
      <AssistantRow>
        <div className={cn("grid gap-2.5 rounded-2xl rounded-tl-md border bg-card px-4 py-3 shadow-sm", row.error ? "border-destructive/30" : "border-border/70")}>
          {row.error ? (
            <p className="flex min-w-0 items-start gap-2 break-words text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {row.error}
            </p>
          ) : (
            <AiMarkdown content={row.answer ?? ""} />
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
        </div>
      </AssistantRow>
    </div>
  );
}

function MetaStrip({ row }: { row: AiAskExchangeRow }) {
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);
  const rate = useMutation({
    // Pressing the active thumb again clears it — "unrated" stays reachable.
    mutationFn: (value: 1 | -1) => askAiApi.feedback(row.id, row.feedback === value ? 0 : value),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ask-ai", "history"] }),
    onError: (err: any) => toast.error("Could not save the rating", { description: serverMessage(err, "Try again.") })
  });

  const copy = async () => {
    // lib/clipboard, not navigator.clipboard directly: the latter is undefined on plain-HTTP LAN
    // installs — the documented on-prem shape of this product — and every click would toast a
    // failure. The util carries the execCommand fallback for exactly that.
    const ok = await copyText(row.answer ?? "");
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } else {
      toast.error("Could not copy");
    }
  };

  const cost = row.costUsd != null ? Number(row.costUsd) : null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] tabular-nums text-muted-foreground">
        {row.model && <span title="Model">{row.model.split("/").pop()}</span>}
        <span title="Response time">{(row.durationMs / 1000).toFixed(1)}s</span>
        <span title="Tokens in / out">
          {row.inputTokens.toLocaleString()}·{row.outputTokens.toLocaleString()} tok
        </span>
        {/* Estimated the same way the AI budget meters it, and absent rather than $0.0000 when the
            attempt never reached the model. */}
        {cost != null && <span title="Estimated cost">${cost.toFixed(4)}</span>}
        <span title="Asked at">{new Date(row.createdAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span>
      </p>
      {!row.error && (
        <div className="flex items-center gap-0.5">
          <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground" onClick={() => void copy()} aria-label="Copy answer" title="Copy the answer as markdown">
            {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cn("h-6 w-6", row.feedback === 1 ? "text-success" : "text-muted-foreground")}
            disabled={rate.isPending}
            onClick={() => rate.mutate(1)}
            title="Good answer — ratings feed the workspace's AI quality loop and its golden datasets"
            aria-label="Good answer"
            aria-pressed={row.feedback === 1}
          >
            <ThumbsUp className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cn("h-6 w-6", row.feedback === -1 ? "text-destructive" : "text-muted-foreground")}
            disabled={rate.isPending}
            onClick={() => rate.mutate(-1)}
            title="Bad answer — a thumbs-down is the strongest negative example the quality datasets get"
            aria-label="Bad answer"
            aria-pressed={row.feedback === -1}
          >
            <ThumbsDown className="h-3 w-3" />
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
      variant={armed ? "destructive" : "ghost"}
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
