import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Bot, CornerDownLeft, ExternalLink, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { askAiApi, type AiAskExchangeRow } from "../services/api";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "./ui/sheet";
import { Textarea } from "./ui/textarea";
import { toast } from "./ui/toaster";
import { AiStrands } from "./ui/ai-strands";
import { runInBackground } from "../lib/run-in-background";

type PageContext = { label: string; prompts: string[] };

const CONTEXTS: Array<{ matches: (path: string) => boolean; context: PageContext }> = [
  { matches: (path) => path === "/app", context: { label: "your day", prompts: ["What needs my attention today?", "Summarize my open work by priority.", "Where did my time go this week?"] } },
  { matches: (path) => path.includes("/intelligence"), context: { label: "your intelligence center", prompts: ["What should I act on first?", "Build a report from the most important signals.", "Explain the biggest delivery risk."] } },
  { matches: (path) => path.includes("/tickets"), context: { label: "tickets", prompts: ["Which open tickets are most at risk?", "Summarize blockers in my tickets.", "Group my open tickets by status."] } },
  { matches: (path) => path.includes("/timesheet") || path.includes("/history"), context: { label: "time", prompts: ["Summarize my hours this week.", "Show gaps in my recent timesheets.", "Break my hours down by project."] } },
  { matches: (path) => path.includes("/changes"), context: { label: "changes", prompts: ["Which changes need attention?", "Summarize high-risk open changes.", "What approvals are waiting?"] } },
  { matches: (path) => path.includes("/workload") || path.includes("/team"), context: { label: "the team", prompts: ["Who may be overloaded?", "Summarize team delivery risks.", "What needs a manager decision?"] } },
  { matches: (path) => path.includes("/insights") || path.includes("/reports"), context: { label: "the numbers", prompts: ["Explain the most important trend.", "What changed from the previous period?", "Where should I investigate first?"] } }
];

function pageContext(path: string): PageContext {
  return CONTEXTS.find((entry) => entry.matches(path))?.context ?? {
    label: "this workspace",
    prompts: ["What needs my attention?", "Summarize my open work.", "What can you help me with here?"]
  };
}

export function ContextualAiPanel() {
  const queryClient = useQueryClient();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<AiAskExchangeRow[]>([]);
  const endRef = useRef<HTMLDivElement>(null);
  const context = useMemo(() => pageContext(location.pathname), [location.pathname]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "auto", block: "nearest" });
  }, [turns.length]);

  const ask = useMutation({
    mutationFn: (prompt: string) => askAiApi.ask(prompt),
    onSuccess: (row, submitted) => {
      setTurns((current) => [...current, row]);
      setQuestion((current) => current === submitted ? "" : current);
      runInBackground(queryClient.invalidateQueries({ queryKey: ["ask-ai", "history"] }));
    },
    onError: (error: any) => toast.error("AI could not answer", { description: error?.response?.data?.message ?? "Check the workspace AI configuration and try again." })
  });

  function submit(prompt = question) {
    const value = prompt.trim();
    if (value.length < 3 || value.length > 2000 || ask.isPending) return;
    setQuestion(value);
    ask.mutate(value);
  }

  return (
    <>
      <div className="fixed bottom-[4.75rem] right-4 z-40 lg:bottom-6 lg:right-6">
      <Button
        type="button"
        variant="ai"
        size="icon"
        className="rounded-full shadow-lg"
        onClick={() => setOpen(true)}
        aria-label={`Ask AI about ${context.label}`}
        title={`Ask AI about ${context.label}`}
      >
        <Sparkles className="h-5 w-5" />
      </Button>
      </div>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-[440px]">
          <SheetHeader className="border-b border-border px-5 py-5 pr-12 text-left">
            <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase text-primary">
              <Bot className="h-4 w-4" /> Context-aware copilot
            </div>
            <SheetTitle>Ask about {context.label}</SheetTitle>
            <SheetDescription>Answers use only workspace data you are allowed to see.</SheetDescription>
          </SheetHeader>

          <ScrollArea className="min-h-0 flex-1">
            <div className="grid gap-4 p-5">
              {turns.length === 0 && (
                <div className="grid gap-2">
                  <p className="text-xs font-semibold uppercase text-muted-foreground">Useful here</p>
                  {context.prompts.map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      className="group flex min-h-[44px] items-center justify-between gap-3 rounded-md border border-border bg-background px-3 py-2.5 text-left text-sm transition hover:border-primary/50 hover:bg-primary/5"
                      onClick={() => setQuestion(prompt)}
                    >
                      <span>{prompt}</span><ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                    </button>
                  ))}
                </div>
              )}
              {turns.map((turn) => (
                <div key={turn.id} className="grid gap-2">
                  <div className="ml-8 rounded-md bg-primary px-3 py-2.5 text-sm text-primary-foreground">{turn.prompt}</div>
                  <div className="rounded-md border border-border bg-muted/40 px-3 py-3 text-sm leading-6">
                    <p className="whitespace-pre-wrap">{turn.answer ?? turn.error ?? "No answer was returned."}</p>
                    <p className="mt-2 text-[11px] text-muted-foreground">{turn.model ? `${turn.model} · ` : ""}{turn.durationMs ? `${turn.durationMs} ms` : "Workspace AI"}</p>
                  </div>
                </div>
              ))}
              {ask.isPending && <AiStrands label={`Reading ${context.label}…`} />}
              <div ref={endRef} />
            </div>
          </ScrollArea>

          <div className="border-t border-border bg-background p-4">
            <div className="relative">
              <Textarea
                aria-label="Question for AI"
                maxLength={2000}
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    submit();
                  }
                }}
                className="min-h-[82px] resize-none pr-12"
                placeholder={`Ask about ${context.label}…`}
              />
              <div className="absolute bottom-2 right-2">
              <Button type="button" size="icon" variant="ai" onClick={() => submit()} disabled={question.trim().length < 3 || ask.isPending} aria-label="Send question">
                <CornerDownLeft className="h-4 w-4" />
              </Button>
              </div>
            </div>
            <Link to="/app/ask-ai" onClick={() => setOpen(false)} className="mt-3 flex items-center justify-center gap-1.5 text-xs font-medium text-primary hover:underline">
              Open full Ask AI history <ExternalLink className="h-3.5 w-3.5" />
            </Link>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
