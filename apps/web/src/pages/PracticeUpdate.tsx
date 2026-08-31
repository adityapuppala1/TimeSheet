/**
 * WHAT: the Weekly AI/ML Practice Update — generate it, read it, correct it, send it.
 *
 * WHY THE REVIEW STEP EXISTS AND IS NOT OPTIONAL: this document goes to a CEO. The figures in it
 * are counted from the database and cannot be edited here at all; the four narrative sections are
 * model-written from those figures and are entirely editable. A leadership audience is the wrong
 * place to discover that a model mis-read a week, and the send posts the REVIEWED prose back so an
 * edit can never be silently discarded.
 *
 * WHY IT IS A SUPER_ADMIN PAGE: it aggregates every project, everyone's hours and every open
 * security finding into one document and then mails it to an arbitrary address list. The recipient
 * list in particular is the requirement's own line — only a super admin decides who this reaches.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Mail, Plus, Send, Settings2, Sparkles, Trash2, Users } from "lucide-react";

import {
  practiceUpdateApi,
  type AIRefineField,
  type PracticeDraft,
  type PracticeInitiative,
  type PracticeNarrative
} from "../services/api";
import { AiRefinePanel, AiRefineTrigger, useAiRefine } from "../components/AiRefine";
import { RichTextEditor } from "../components/ui/rich-text-editor";
import { PracticeUpdateHistory } from "../components/PracticeUpdateHistory";
import { AiStrands } from "../components/ui/ai-strands";
import { Badge } from "../components/ui/badge";
import { BorderGlow } from "../components/ui/border-glow";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Skeleton } from "../components/ui/skeleton";
import { Switch } from "../components/ui/switch";
import { toast } from "../components/ui/toaster";
import { cn } from "../lib/utils";

/** The server's own message when it has one. A generated feature like this fails for reasons the
 *  API states precisely — "no recipients", "the email is switched off" — and swallowing those for a
 *  generic string would hide the only thing that tells the user what to do next. */
function serverMessage(error: unknown, fallback: string): string {
  const response = (error as { response?: { data?: { message?: unknown } } })?.response;
  return typeof response?.data?.message === "string" ? response.data.message : fallback;
}

const CATEGORY_LABELS: Record<PracticeInitiative["category"], string> = {
  PRODUCT: "Products / Features",
  POC: "POCs / Innovation",
  BUGS: "Bugs / Stability",
  SECURITY: "Security",
  TRAINING: "Training / Capability Building"
};

const RAG: Record<PracticeInitiative["status"], { emoji: string; className: string }> = {
  GREEN: { emoji: "🟢", className: "text-success" },
  AMBER: { emoji: "🟡", className: "text-warning" },
  RED: { emoji: "🔴", className: "text-destructive" }
};

/**
 * A textarea with "Refine with AI" beside its label — the same affordance, hook and promise as the
 * timesheet fields: the suggestion is shown next to the original, accepting it is a separate click,
 * and Undo restores what was there. Nothing is ever silently replaced.
 *
 * Its own component because `useAiRefine` is a hook and several of these are rendered from a list;
 * calling the hook inside a `.map()` callback would break the rules of hooks the moment a bullet is
 * added or removed.
 */
function RefinableText({
  label,
  refineField,
  refineLabel,
  value,
  onChange,
  rows = 3,
  placeholder,
  id,
  variant = "full"
}: {
  label?: React.ReactNode;
  refineField: AIRefineField;
  refineLabel: string;
  value: string;
  onChange: (next: string) => void;
  rows?: number;
  placeholder?: string;
  id?: string;
  /** "full" for the executive summary — a document. "inline" for a single item in a bulleted
   *  list, where headings and nested lists are not a formatting choice. */
  variant?: "full" | "inline";
}) {
  const refine = useAiRefine({ field: refineField, value, onChange, label: refineLabel });

  return (
    <div className="grid flex-1 gap-1.5">
      {/* The trigger sits BESIDE the label, never inside it: a button inside a `<label>` is a click
          that can activate the labelled control instead of itself. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        {label ? <Label htmlFor={id}>{label}</Label> : <span />}
        <AiRefineTrigger state={refine} />
      </div>
      {/*
        RICH TEXT, not a textarea. This is a document read by people who will open nothing else, and
        a plain textarea could only produce a wall of prose — which is where a weekly update stops
        being read. `variant` decides how much of the toolbar is offered, and the two cases are
        genuinely different: the summary is a document, a risk is one line inside a list this email
        builds, and a heading inside a bullet point is a broken document rather than a formatting
        choice. The AI Refine guidance for each field says the same thing, so the model and the
        toolbar cannot disagree about what belongs there.
      */}
      <RichTextEditor
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        ariaLabel={refineLabel}
        toolbar={variant}
        minHeight={variant === "inline" ? "min-h-[2.75rem]" : `min-h-${Math.max(rows, 3) * 8}`}
        maxHeight={variant === "inline" ? "max-h-32" : "max-h-96"}
      />
      <AiRefinePanel state={refine} />
    </div>
  );
}

/** A list the reviewer can edit line by line. One textarea per bullet would be unusable at ten
 *  bullets, and one textarea for the whole list re-introduces the newline-parsing the API
 *  deliberately got rid of. */
function BulletEditor({
  label,
  items,
  onChange,
  refineField,
  refineLabel
}: {
  label: string;
  items: string[];
  onChange: (next: string[]) => void;
  refineField: AIRefineField;
  refineLabel: string;
}) {
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        <Button variant="ghost" size="sm" onClick={() => onChange([...items, ""])}>
          <Plus className="h-3.5 w-3.5" />
          Add
        </Button>
      </div>
      {items.length === 0 && (
        <p className="rounded-md border border-dashed border-border bg-muted/30 p-2.5 text-xs text-muted-foreground">
          Empty. The email will fall back to the underlying figures for this section rather than
          leaving it blank.
        </p>
      )}
      {items.map((item, index) => (
        // Keyed by POSITION on purpose. The value is what the user is editing, so a value-based key
        // would remount the field on every keystroke and lose the caret; the list is only ever
        // appended to or spliced, never reordered.
        <div key={index} className="flex items-start gap-2">
          <RefinableText
            refineField={refineField}
            refineLabel={refineLabel}
            value={item}
            rows={2}
            variant="inline"
            onChange={(next) => onChange(items.map((v, i) => (i === index ? next : v)))}
          />
          <Button
            variant="ghost"
            size="icon"
            className="mt-7"
            aria-label={`Remove item ${index + 1}`}
            onClick={() => onChange(items.filter((_, i) => i !== index))}
          >
            <Trash2 className="h-4 w-4 text-muted-foreground" />
          </Button>
        </div>
      ))}
    </div>
  );
}

function InitiativeTable({ rows, nextStepFor }: { rows: PracticeInitiative[]; nextStepFor: (id: string) => string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[46rem] text-sm">
        <thead>
          <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
            <th className="py-1.5 pr-3 font-semibold">Initiative</th>
            <th className="py-1.5 pr-3 font-semibold">Owner</th>
            <th className="py-1.5 pr-3 font-semibold">Status</th>
            <th className="py-1.5 pr-3 font-semibold">This period</th>
            <th className="py-1.5 pr-3 font-semibold">Next steps</th>
            <th className="py-1.5 font-semibold">Risks / dependencies</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-b border-border/60 align-top">
              <td className="py-2 pr-3">
                <div className="font-medium">{row.name}</div>
                {row.code && <div className="text-[11px] text-muted-foreground">{row.code}</div>}
              </td>
              <td className="py-2 pr-3 text-muted-foreground">{row.owner ?? "—"}</td>
              <td className={cn("py-2 pr-3", RAG[row.status].className)}>{RAG[row.status].emoji}</td>
              <td className="py-2 pr-3 text-muted-foreground">{row.progress}</td>
              <td className="py-2 pr-3 text-muted-foreground">{nextStepFor(row.id) || "—"}</td>
              <td className="py-2 text-muted-foreground">{row.risks || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RecipientsCard() {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["practice-update", "settings"], queryFn: practiceUpdateApi.settings });
  const [draftList, setDraftList] = useState<string[] | null>(null);
  const [entry, setEntry] = useState("");

  const list = draftList ?? settings.data?.recipients ?? [];

  const save = useMutation({
    mutationFn: (payload: { recipients: string[]; weekly?: boolean }) => practiceUpdateApi.saveSettings(payload),
    onSuccess: () => {
      setDraftList(null);
      void queryClient.invalidateQueries({ queryKey: ["practice-update", "settings"] });
      toast.success("Distribution list saved");
    },
    onError: (error: unknown) => toast.error("Couldn't save", { description: serverMessage(error, "Try again.") })
  });

  const add = () => {
    const value = entry.trim().toLowerCase();
    if (!value) return;
    if (list.includes(value)) {
      toast.error("Already on the list");
      return;
    }
    setDraftList([...list, value]);
    setEntry("");
  };

  if (settings.isLoading) return <Skeleton className="h-56 w-full" />;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Users className="h-4 w-4 text-primary" />
          Who receives it
        </CardTitle>
        <CardDescription>
          Only a super admin can change this list. Addresses do not need a TimeSphere account — the
          people who most need this update often do not have one.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid flex-1 gap-1.5">
            <Label htmlFor="practice-recipient">Add an email address</Label>
            <Input
              id="practice-recipient"
              value={entry}
              placeholder="name@company.com"
              onChange={(event) => setEntry(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  add();
                }
              }}
            />
          </div>
          <Button variant="outline" onClick={add}>
            <Plus className="h-4 w-4" />
            Add
          </Button>
        </div>

        {list.length === 0 ? (
          <p className="rounded-md border border-dashed border-border bg-muted/30 p-3 text-sm text-muted-foreground">
            Nobody is on the list yet. The update cannot be sent until at least one address is added.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {list.map((address) => (
              <Badge key={address} variant="muted" className="gap-1.5 py-1 pl-2.5 pr-1">
                {address}
                <button
                  type="button"
                  aria-label={`Remove ${address}`}
                  className="rounded p-0.5 hover:bg-muted"
                  onClick={() => setDraftList(list.filter((value) => value !== address))}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between rounded-lg border border-border p-3">
          <div className="pr-4">
            <p className="text-sm font-medium">Send automatically every Monday</p>
            <p className="text-xs text-muted-foreground">
              07:30, covering the last complete week. Off by default — with it on, the update goes
              out without the review step below.
            </p>
          </div>
          <Switch
            checked={settings.data?.weekly ?? false}
            onCheckedChange={(checked) => save.mutate({ recipients: list, weekly: checked })}
          />
        </div>

        {draftList && (
          <div className="flex items-center gap-2">
            <Button disabled={save.isPending} onClick={() => save.mutate({ recipients: list })}>
              {save.isPending ? "Saving…" : "Save list"}
            </Button>
            <Button variant="ghost" onClick={() => setDraftList(null)}>
              Cancel
            </Button>
          </div>
        )}

        {/* Both gates, named. "Nothing happened when I clicked send" has two causes and the page
            should be able to say which — see the controller's /settings handler. */}
        {settings.data && !settings.data.emailEnabled && (
          <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2.5 text-xs">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
            <span>
              The practice-update email is switched off for this workspace. Turn it on under Workspace
              Settings → Email channels → Digests, or sending will be refused.
            </span>
          </p>
        )}
        {settings.data && !settings.data.aiNarrativeEnabled && (
          <p className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-2.5 text-xs text-muted-foreground">
            <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              AI drafting is off, so the written sections will start empty and the email falls back to
              the underlying figures. Turn it on under Workspace Settings → AI features.
            </span>
          </p>
        )}
      </CardContent>
    </Card>
  );
}

const EMPTY_NARRATIVE: PracticeNarrative = {
  executiveSummary: "",
  risks: [],
  nextWeekPriorities: [],
  decisionsRequired: [],
  nextSteps: []
};

export function PracticeUpdatePage() {
  const [draft, setDraft] = useState<PracticeDraft | null>(null);
  const [narrative, setNarrative] = useState<PracticeNarrative | null>(null);
  const [period, setPeriod] = useState<{ from: string; to: string } | null>(null);
  const queryClient = useQueryClient();

  /*
   * RESTORE, DON'T REGENERATE. This document costs a full model run, and it used to live only in
   * component state — so a refresh, a tab close, or a walk to another screen threw it away and the
   * only way back was to spend those tokens again.
   *
   * A GET on mount, never a POST: the page must not be able to bill somebody a model run just by
   * being opened. Generating is always an explicit act, from Generate or Regenerate.
   */
  const stored = useQuery({
    queryKey: ["practice-update", "draft"],
    queryFn: practiceUpdateApi.storedDraft,
    staleTime: 0
  });

  useEffect(() => {
    const restored = stored.data?.draft;
    if (!restored) return;
    // Only seeds an EMPTY editor. Once a reviewer is editing, a refetch must not overwrite what
    // they have typed — the server copy is behind by design, since it is saved on a debounce.
    setDraft((current) => current ?? restored);
    setNarrative((current) => current ?? restored.narrative ?? EMPTY_NARRATIVE);
  }, [stored.data]);

  const generate = useMutation({
    mutationFn: () => practiceUpdateApi.draft(period ?? undefined),
    onSuccess: (data) => {
      setDraft(data);
      // Seeded from the model, then owned by the reviewer. Every later edit lives here, and this is
      // what `send` posts back — regenerating on send would throw the review away.
      setNarrative(data.narrative ?? EMPTY_NARRATIVE);
      void queryClient.invalidateQueries({ queryKey: ["practice-update", "draft"] });
    },
    onError: (error: unknown) => toast.error("Couldn't build the update", { description: serverMessage(error, "Try again.") })
  });

  const discard = useMutation({
    mutationFn: () => practiceUpdateApi.discardDraft(),
    onSuccess: () => {
      setDraft(null);
      setNarrative(null);
      void queryClient.invalidateQueries({ queryKey: ["practice-update", "draft"] });
      toast.success("Draft discarded");
    },
    onError: (error: unknown) => toast.error("Couldn't discard", { description: serverMessage(error, "Try again.") })
  });

  /*
   * AUTOSAVE, DEBOUNCED. Without it the persistence above would only cover the model's own words —
   * a reviewer's edits would still evaporate on refresh, which is most of what is worth keeping.
   *
   * Debounced at 1.5s rather than saved per keystroke: this writes a JSON column, and a PATCH per
   * character would be both wasteful and a worse experience than the one it replaces. Failures are
   * deliberately silent — the draft is still in the editor, and a toast on every transient network
   * blip while somebody is typing is its own problem.
   */
  useEffect(() => {
    if (!draft || !narrative) return;
    const timer = setTimeout(() => {
      void practiceUpdateApi.saveDraft(narrative).catch(() => undefined);
    }, 1500);
    return () => clearTimeout(timer);
  }, [narrative, draft]);

  const send = useMutation({
    mutationFn: () => practiceUpdateApi.send({ ...(period ?? {}), narrative: narrative ?? undefined }),
    onSuccess: (result) => {
      toast.success(`Sent to ${result.recipients} recipient${result.recipients === 1 ? "" : "s"}`, {
        description: result.subject
      });
      // The draft is now an archive entry, not work in progress. Clearing it locally matches what
      // the server did, so a refresh does not restore a document that has already gone out.
      setDraft(null);
      setNarrative(null);
      void queryClient.invalidateQueries({ queryKey: ["practice-update", "draft"] });
      void queryClient.invalidateQueries({ queryKey: ["practice-update", "history"] });
    },
    onError: (error: unknown) => toast.error("Couldn't send", { description: serverMessage(error, "Try again.") })
  });

  const nextStepFor = (id: string) => narrative?.nextSteps.find((step) => step.id === id)?.text ?? "";
  const patch = (change: Partial<PracticeNarrative>) =>
    setNarrative((current) =>
      current ? { ...current, ...change } : { executiveSummary: "", risks: [], nextWeekPriorities: [], decisionsRequired: [], ...change, nextSteps: [] }
    );

  const grouped = (["PRODUCT", "POC", "BUGS", "SECURITY", "TRAINING"] as const)
    .map((key) => ({ key, label: CATEGORY_LABELS[key], rows: (draft?.data.initiatives ?? []).filter((i) => i.category === key) }))
    .filter((group) => group.rows.length > 0);

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-black tracking-tight">Weekly AI/ML Practice Update</h1>
          <p className="text-sm text-muted-foreground">
            One consolidated view of products, POCs, bugs, security and training — the figures are
            counted from this workspace, the written sections are drafted for you to review.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* The label changes with the consequence. With nothing in progress this is free; with a
              draft open it REPLACES it and spends another model run, and a button that says the
              same thing in both cases is how somebody loses an hour of edits. */}
          <Button variant="ai" disabled={generate.isPending} onClick={() => generate.mutate()}>
            <Sparkles className="mr-1.5 h-4 w-4" />
            {generate.isPending ? "Generating…" : draft ? "Regenerate" : "Generate update"}
          </Button>
          {draft && (
            <Button
              variant="ghost"
              disabled={discard.isPending}
              onClick={() => discard.mutate()}
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="h-4 w-4" />
              Discard
            </Button>
          )}
          <Button disabled={!draft || send.isPending} onClick={() => send.mutate()}>
            <Send className="h-4 w-4" />
            {send.isPending ? "Sending…" : "Send"}
          </Button>
        </div>
      </div>

      {/* HOW OLD IS THIS? The first question anybody asks about a document that was already on
          screen when they arrived. Only shown for a RESTORED draft — `generatedAt` is absent on the
          response to a fresh generate, where the answer is obviously "just now". */}
      {draft?.generatedAt && !generate.isPending && (
        <p className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <Sparkles className="h-3.5 w-3.5 text-primary" />
          Picked up where you left off — generated {new Date(draft.generatedAt).toLocaleString()}
          {draft.generatedByName ? ` by ${draft.generatedByName}` : ""}. Your edits are saved as you type.
          Regenerate replaces it; Discard clears it.
        </p>
      )}

      <RecipientsCard />

      {/* The period. Defaults to the last complete Monday-to-Sunday week, which is what the CEO
          asked for; an explicit range is here because the first one people want to send is
          almost always "the week we just finished discussing", not necessarily last week. */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Settings2 className="h-4 w-4 text-primary" />
            Period
          </CardTitle>
          <CardDescription>Leave both blank for the last complete week (Monday to Sunday).</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-2.5">
          <div className="grid gap-1.5">
            <Label htmlFor="practice-from">From</Label>
            <Input
              id="practice-from"
              type="date"
              className="w-44"
              value={period?.from ?? ""}
              onChange={(event) => setPeriod({ from: event.target.value, to: period?.to ?? event.target.value })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="practice-to">To</Label>
            <Input
              id="practice-to"
              type="date"
              className="w-44"
              value={period?.to ?? ""}
              onChange={(event) => setPeriod({ from: period?.from ?? event.target.value, to: event.target.value })}
            />
          </div>
          {period && (
            <Button variant="ghost" onClick={() => setPeriod(null)}>
              Use last complete week
            </Button>
          )}
        </CardContent>
      </Card>

      {generate.isPending && <AiStrands label="Counting the week's tickets, hours, changes and findings…" />}

      {draft && (
        <BorderGlow key={draft.data.period.label} animated>
          <div className="grid gap-5 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-primary">{draft.data.period.label}</p>
                <p className="text-sm text-muted-foreground">{draft.preview.subject}</p>
              </div>
              {draft.data.isEmpty && <Badge variant="warning">Nothing was recorded in this period</Badge>}
            </div>

            {draft.aiFailed && (
              <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2.5 text-xs">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                <span>{draft.aiFailed}</span>
              </p>
            )}

            {/* ---- The counted half. Deliberately read-only: these numbers are the reason anyone
                    trusts the document, and a document whose figures can be typed over is not a
                    record of anything. ---- */}
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              {[
                ["Tickets closed", String(draft.data.metrics.ticketsClosed)],
                ["Hours logged", `${draft.data.metrics.hours}`],
                ["Overdue", String(draft.data.metrics.overdue)],
                ["SLA breaches", String(draft.data.metrics.slaBreaches)]
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border border-border p-2.5">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
                  <p className="text-lg font-black tabular-nums">{value}</p>
                </div>
              ))}
            </div>

            {grouped.map((group) => (
              <div key={group.key} className="grid gap-2">
                <p className="text-sm font-semibold">{group.label}</p>
                <InitiativeTable rows={group.rows} nextStepFor={nextStepFor} />
              </div>
            ))}

            {/* ---- The written half. Every field here is editable and is what gets sent. ---- */}
            <div className="grid gap-4 rounded-lg border border-border p-3.5">
              <p className="flex items-center gap-1.5 text-sm font-semibold">
                <Mail className="h-4 w-4 text-primary" />
                Written sections — edit before sending
              </p>

              <RefinableText
                id="practice-summary"
                label="Executive summary"
                refineField="practice_summary"
                refineLabel="executive summary"
                rows={4}
                value={narrative?.executiveSummary ?? ""}
                placeholder="Left blank, the email falls back to the counted figures."
                onChange={(executiveSummary) => patch({ executiveSummary })}
              />

              <BulletEditor
                label="Risks / blockers"
                refineField="practice_risk"
                refineLabel="risk"
                items={narrative?.risks ?? []}
                onChange={(risks) => patch({ risks })}
              />
              <BulletEditor
                label="Next week priorities"
                refineField="practice_priority"
                refineLabel="priority"
                items={narrative?.nextWeekPriorities ?? []}
                onChange={(nextWeekPriorities) => patch({ nextWeekPriorities })}
              />
              <BulletEditor
                label="Decisions / support required"
                refineField="practice_decision"
                refineLabel="decision"
                items={narrative?.decisionsRequired ?? []}
                onChange={(decisionsRequired) => patch({ decisionsRequired })}
              />
            </div>

            {send.isSuccess && (
              <p className="flex items-center gap-2 rounded-md border border-success/40 bg-success/10 p-2.5 text-sm">
                <CheckCircle2 className="h-4 w-4 text-success" />
                Sent. It will appear in Email templates → Analytics like every other send.
              </p>
            )}
          </div>
        </BorderGlow>
      )}
      <PracticeUpdateHistory />
    </div>
  );
}

export default PracticeUpdatePage;
