/**
 * WHAT: the inline "Refine with AI" affordance offered next to free-text fields a colleague will
 * read — timesheet task description and notes, ticket title/description, ticket comments.
 *
 * ── THE RULE THIS COMPONENT EXISTS TO ENFORCE ────────────────────────────────────────────────
 *
 * AI NEVER SILENTLY REPLACES WHAT SOMEONE WROTE. The suggestion is shown next to the original,
 * accepting it is a separate click, and the value it replaced is kept so "Undo" is real. That
 * matters most on a timesheet: the description is a record of work that an approver signs off and
 * an auditor may later read, so a rewrite the author never actually looked at would be a
 * compliance problem, not a convenience. The matching half of that promise lives in the prompt
 * (`text_refine` in ai-prompt.service.ts), which forbids inventing, padding or strengthening
 * anything; this half makes sure a human still chose the words.
 *
 * WHY a hook plus two components rather than one wrapper: the trigger belongs up in the field's
 * label row and the result belongs under the field, and the fields in question are a plain
 * `<Input>` in one place and a Tiptap `RichTextEditor` in the others. A wrapper would have to own
 * the field's layout to place both; this way the caller keeps its layout and just drops the two
 * pieces where they go.
 *
 * SANITIZATION: rich-text suggestions arrive as HTML the server already put through
 * `sanitizeRichText` (the same allow-list every stored value passes), built from text that was
 * HTML-escaped first. This file re-sanitizes once more with `safeHtml` before rendering the
 * preview, so model output never reaches `dangerouslySetInnerHTML` on the strength of one check.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Sparkles, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "./ui/button";
import { safeHtml } from "../lib/safe-html";
import { cn } from "../lib/utils";
import { aiApi, type AIRefineAvailability, type AIRefineField, type AIRefineResult } from "../services/api";

const AVAILABILITY_KEY = ["ai", "refine", "availability"] as const;

/** Reads the OS-level motion preference and keeps up if it changes mid-session (macOS and Windows
 *  both let you toggle it without a reload). */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

function plainLengthOf(value: string): number {
  return value.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").trim().length;
}

/** Honest failure text. A timeout, a dead provider and an exhausted budget are three different
 *  things and the user can act on exactly one of them, so they must not collapse into "try again". */
function failureMessage(error: any): string {
  if (error?.code === "ECONNABORTED" || error?.code === "ETIMEDOUT") {
    return "The AI didn't answer in time. Your text hasn't been changed — try again, or just carry on.";
  }
  const status = error?.response?.status;
  const fromServer = error?.response?.data?.message;
  if (status === 429) return "That's a lot of AI requests at once. Wait a moment and try again.";
  if (fromServer) return fromServer;
  return "The AI service couldn't be reached. Your text hasn't been changed.";
}

type Phase = "idle" | "loading" | "ready" | "error" | "applied";

export interface UseAiRefineOptions {
  field: AIRefineField;
  /** The field's current value — HTML for a rich-text field, plain text for an input. */
  value: string;
  /** Called only on an explicit accept or undo. Never called on its own. */
  onChange: (next: string) => void;
  /** How the field is named to a person, lower case: "task description", "title", "comment". */
  label: string;
  /** Set when the field itself is unusable (read-only, saving, no permission). */
  disabled?: boolean;
}

export function useAiRefine({ field, value, onChange, label, disabled }: UseAiRefineOptions) {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<AIRefineResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** What Undo would restore, and what it was replaced with — the second half is what tells us the
   *  user has since edited the field, at which point offering Undo would throw that work away. */
  const [applied, setApplied] = useState<{ from: string; to: string } | null>(null);
  const reasonId = useId();

  // Shared across every field on the page: one answer to "is AI available", cached long enough
  // that a form with three refinable fields asks once rather than three times.
  const availability = useQuery<AIRefineAvailability>({
    queryKey: AVAILABILITY_KEY,
    queryFn: aiApi.refineAvailability,
    staleTime: 5 * 60_000,
    retry: false
  });

  const refine = useMutation({
    mutationFn: () => aiApi.refineText({ text: value, field }),
    onSuccess: (data) => {
      setResult(data);
      setPhase("ready");
    },
    onError: (err: any) => {
      // A 403/402 means the workspace-level answer changed under us — write it into the shared
      // cache so every other trigger on the page disables itself with the real reason instead of
      // waiting for its own failed click.
      const status = err?.response?.status;
      if (status === 403 || status === 402) {
        queryClient.setQueryData(AVAILABILITY_KEY, {
          available: false,
          reason: status === 402 ? "budget" : "disabled",
          message: err?.response?.data?.message ?? "AI writing help is unavailable."
        } satisfies AIRefineAvailability);
      }
      setError(failureMessage(err));
      setPhase("error");
    }
  });

  const isEmpty = plainLengthOf(value) === 0;
  const blockedReason =
    disabled ? `The ${label} can't be edited right now.`
    : isEmpty ? `Write your ${label} first — AI tidies up what's there, it doesn't write it for you.`
    : availability.data && !availability.data.available ? availability.data.message
    : null;

  const run = useCallback(() => {
    if (blockedReason || refine.isPending) return;
    setError(null);
    setResult(null);
    setPhase("loading");
    refine.mutate();
  }, [blockedReason, refine]);

  const accept = useCallback(() => {
    if (!result) return;
    const next = result.format === "html" ? (result.refinedHtml ?? "") : result.refined;
    setApplied({ from: value, to: next });
    onChange(next);
    setPhase("applied");
  }, [result, value, onChange]);

  const undo = useCallback(() => {
    if (!applied) return;
    onChange(applied.from);
    setApplied(null);
    setResult(null);
    setPhase("idle");
  }, [applied, onChange]);

  // Two ways a panel goes stale under the user. Kept typing after accepting: "Undo" would now
  // discard their own edits along with the refinement. Field emptied (they cleared it, or a dialog
  // reset the draft after saving): the suggestion is about text that no longer exists.
  useEffect(() => {
    const staleUndo = phase === "applied" && applied !== null && value !== applied.to;
    const staleSuggestion = isEmpty && phase !== "idle" && phase !== "loading";
    if (!staleUndo && !staleSuggestion) return;
    setApplied(null);
    setResult(null);
    setError(null);
    setPhase("idle");
  }, [phase, applied, value, isEmpty]);

  const dismiss = useCallback(() => {
    setResult(null);
    setError(null);
    setPhase("idle");
  }, []);

  return { field, label, phase, result, error, blockedReason, reasonId, run, accept, undo, dismiss };
}

export type AiRefineState = ReturnType<typeof useAiRefine>;

/**
 * The trigger. `aria-disabled` rather than `disabled` when it's blocked: a `disabled` button drops
 * out of the tab order, taking the reason it's unavailable with it — which is precisely the
 * information a keyboard or screen-reader user needs at that moment.
 */
export function AiRefineTrigger({ state, className }: { state: AiRefineState; className?: string }) {
  const reduced = useReducedMotion();
  const blocked = state.blockedReason !== null;
  const busy = state.phase === "loading";

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-disabled={blocked || busy}
        aria-busy={busy}
        aria-describedby={blocked ? state.reasonId : undefined}
        title={state.blockedReason ?? `Have AI tidy up your ${state.label} — you'll see it before anything changes`}
        onClick={state.run}
        className={cn(
          // Fixed label through the whole cycle: a button that re-words itself to "Refining…"
          // resizes, and this one sits in a label row where that nudges the field's header around.
          "h-7 shrink-0 gap-1.5 whitespace-nowrap px-2 text-xs font-medium text-primary hover:text-primary",
          (blocked || busy) && "cursor-not-allowed opacity-60",
          className
        )}
      >
        <Sparkles className={cn("h-3.5 w-3.5", busy && !reduced && "animate-pulse")} aria-hidden="true" />
        {/* Gradient only while usable: a transparent-fill label fights the opacity-60 blocked
            treatment, and a blocked button shouldn't advertise. */}
        <span className={cn(!blocked && "ai-gradient-text")}>Refine with AI</span>
      </Button>
      {blocked && (
        <span id={state.reasonId} className="sr-only">
          {state.blockedReason}
        </span>
      )}
    </>
  );
}

/**
 * The result surface, rendered directly under the field. Mounts once when a refinement starts and
 * stays mounted through loading -> result -> accepted, so the form shifts a single time on a
 * deliberate click rather than twitching as each state arrives.
 */
export function AiRefinePanel({ state, className }: { state: AiRefineState; className?: string }) {
  const reduced = useReducedMotion();
  const acceptRef = useRef<HTMLButtonElement>(null);

  // Land the keyboard on the primary action once there's something to decide about — the user
  // asked for this, so the suggestion is where they're already looking.
  useEffect(() => {
    if (state.phase === "ready") acceptRef.current?.focus();
  }, [state.phase]);

  if (state.phase === "idle") return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "grid gap-3 rounded-md border border-primary/30 bg-primary/5 p-3 text-sm",
        !reduced && "animate-fade-in",
        // The orbiting ring marks "the model is working on this box right now" — it comes off the
        // moment there is a result, so glow means in-flight, never merely AI-related.
        state.phase === "loading" && "ai-glow",
        className
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-primary">
          <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
          AI refinement
        </span>
        {state.phase !== "loading" && (
          <button
            type="button"
            onClick={state.dismiss}
            aria-label="Dismiss the AI refinement"
            className="rounded-sm p-0.5 text-muted-foreground transition hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>

      {state.phase === "loading" && <RefiningLines label={state.label} reduced={reduced} />}

      {state.phase === "ready" && state.result && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Comparison title="Yours">
              <p className="whitespace-pre-wrap break-words">{state.result.original}</p>
            </Comparison>
            <Comparison title="AI suggestion" highlight>
              {state.result.format === "html" && state.result.refinedHtml ? (
                // `.prose-sm` is the app's rendered-rich-text class (index.css), so the preview
                // reads exactly the way the content will once accepted — including code blocks.
                // `.tiptap` itself can't be reused here; it carries the editor's own min-height
                // and padding.
                <div className="prose-sm break-words" dangerouslySetInnerHTML={safeHtml(state.result.refinedHtml)} />
              ) : (
                <p className="whitespace-pre-wrap break-words">{state.result.refined}</p>
              )}
            </Comparison>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button ref={acceptRef} type="button" size="sm" onClick={state.accept}>
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
              Use this
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={state.dismiss}>
              Keep mine
            </Button>
            <span className="text-xs text-muted-foreground">Nothing changes until you choose.</span>
          </div>
        </>
      )}

      {state.phase === "applied" && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1.5 font-medium text-primary">
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
            Applied to your {state.label}.
          </span>
          <Button type="button" size="sm" variant="outline" onClick={state.undo}>
            <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
            Undo
          </Button>
        </div>
      )}

      {state.phase === "error" && (
        <div className="grid gap-2">
          <p className="text-destructive">{state.error}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" onClick={state.run}>
              Try again
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={state.dismiss}>
              Dismiss
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Comparison({ title, highlight, children }: { title: string; highlight?: boolean; children: React.ReactNode }) {
  return (
    <section className="grid gap-1">
      <h4 className={cn("text-[11px] font-semibold uppercase tracking-wide", highlight ? "text-primary" : "text-muted-foreground")}>
        {title}
      </h4>
      <div
        className={cn(
          "max-h-44 overflow-y-auto rounded-md border p-2 text-sm",
          highlight ? "border-primary/30 bg-background" : "border-border bg-background/60 text-muted-foreground"
        )}
      >
        {children}
      </div>
    </section>
  );
}

/**
 * The waiting state: three lines "writing themselves" with staggered sweeps. Under
 * `prefers-reduced-motion` the sweep is simply not rendered — the bars and the sentence below
 * still say what's happening, so nothing is lost but the movement.
 */
function RefiningLines({ label, reduced }: { label: string; reduced: boolean }) {
  return (
    <div className="grid gap-2">
      <div className="grid gap-1.5" aria-hidden="true">
        {["w-full", "w-11/12", "w-2/3"].map((width, index) => (
          <div key={width} className={cn("relative h-2.5 overflow-hidden rounded-full bg-muted", width)}>
            {!reduced && (
              <span
                className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-primary/40 to-transparent"
                style={{ animationDelay: `${index * 0.18}s` }}
              />
            )}
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">Refining your {label} — your text is untouched until you accept.</p>
    </div>
  );
}
