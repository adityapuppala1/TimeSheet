/**
 * WHAT: the three editable tables that make up a change's runbook — implementation steps, test cases
 * and dependencies.
 *
 * WHY ONE FILE FOR THREE TABLES: they are the same interaction three times. Each is a list of child
 * rows, added inline, edited in place, and deleted; each writes through `changeApi` and invalidates
 * the same detail query. Writing them as one shell with three column definitions is what stops the
 * third one drifting from the first — and the "add row" affordance, the empty state and the saving
 * behaviour stay identical for free.
 *
 * WHY EDITING STAYS OPEN AFTER APPROVAL: the rest of the change freezes once it is approved, because
 * scope and risk are what got approved. The runbook is the opposite — recording that step 4 failed,
 * or that a regression test passed, is exactly the work that happens during implementation. The API
 * agrees (see `loadChangeForRunbook`), so this section takes `disabled` only from whether the viewer
 * may edit at all, never from the state.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { GripVertical, Loader2, Plus, ShieldAlert, Trash2 } from "lucide-react";
import type {
  ChangeDependency,
  ChangeDependencyStatus,
  ChangeDependencyType,
  ChangeStep,
  ChangeStepStatus,
  ChangeTest,
  ChangeTestStatus
} from "../../services/api";
import { changeApi } from "../../services/api";
import { cn } from "../../lib/utils";
import { Badge, type BadgeProps } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { toast } from "../ui/toaster";

const serverMessage = (err: any, fallback: string) => err?.response?.data?.message ?? fallback;
type Tone = NonNullable<BadgeProps["variant"]>;

/** Status colour follows what the status means for the reader: anything that stopped the work is
 *  red, anything running is amber, anything finished well is green, anything untouched is quiet. */
const STEP_TONE: Record<ChangeStepStatus, Tone> = {
  NOT_STARTED: "muted",
  IN_PROGRESS: "warning",
  COMPLETED: "success",
  FAILED: "destructive",
  SKIPPED: "muted"
};
const TEST_TONE: Record<ChangeTestStatus, Tone> = {
  NOT_STARTED: "muted",
  PASSED: "success",
  FAILED: "destructive",
  BLOCKED: "warning"
};
const DEPENDENCY_TONE: Record<ChangeDependencyStatus, Tone> = {
  OPEN: "warning",
  COMPLETED: "success",
  WAIVED: "info"
};

const STEP_STATUSES: ChangeStepStatus[] = ["NOT_STARTED", "IN_PROGRESS", "COMPLETED", "FAILED", "SKIPPED"];
const TEST_STATUSES: ChangeTestStatus[] = ["NOT_STARTED", "PASSED", "FAILED", "BLOCKED"];
const DEPENDENCY_STATUSES: ChangeDependencyStatus[] = ["OPEN", "COMPLETED", "WAIVED"];
const DEPENDENCY_TYPES: ChangeDependencyType[] = ["PREDECESSOR", "BLOCKS", "SUCCESSOR", "RELATED"];

const humanize = (value: string) => {
  const spaced = value.replace(/_/g, " ").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

/* ------------------------------------------------------------------ *
 * Shell
 * ------------------------------------------------------------------ */

interface SectionProps {
  title: string;
  hint: string;
  /** Placeholder for the inline add box. Phrased as the thing being added, so the empty table still
   *  tells the reader what belongs in it. */
  addLabel: string;
  disabled: boolean;
  count: number;
  onAdd: (description: string) => Promise<unknown>;
  children: React.ReactNode;
}

function RunbookSection({ title, hint, addLabel, disabled, count, onAdd, children }: SectionProps) {
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const text = draft.trim();
    if (!text || saving) return;
    setSaving(true);
    try {
      await onAdd(text);
      // Cleared only on success, so a failed add does not also lose what was typed.
      setDraft("");
    } catch (err: any) {
      toast.error("Could not add", { description: serverMessage(err, "Try again.") });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="grid gap-3">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <Badge variant="muted">{count}</Badge>
        </div>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </header>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[44rem] text-sm">{children}</table>
      </div>

      {!disabled && (
        <div className="flex items-center gap-2">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder={addLabel}
            aria-label={addLabel}
          />
          <Button size="sm" onClick={() => void submit()} disabled={!draft.trim() || saving}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            Add
          </Button>
        </div>
      )}
    </section>
  );
}

/** A row that saves the moment it loses focus, so nothing needs a per-row Save button. */
function CellInput({
  value,
  disabled,
  placeholder,
  onSave
}: {
  value: string | null;
  disabled: boolean;
  placeholder?: string;
  onSave: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value ?? "");
  const [dirty, setDirty] = useState(false);

  return (
    <input
      className="w-full rounded border border-transparent bg-transparent px-1.5 py-1 text-sm outline-none transition-colors hover:border-border focus:border-ring focus:bg-background disabled:cursor-default disabled:hover:border-transparent"
      value={draft}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => {
        setDraft(e.target.value);
        setDirty(true);
      }}
      onBlur={() => {
        // Only when it actually changed: a blur with no edit would otherwise fire a write on every
        // tab through the table.
        if (dirty && draft !== (value ?? "")) onSave(draft);
        setDirty(false);
      }}
    />
  );
}

function StatusPicker<T extends string>({
  value,
  options,
  tone,
  disabled,
  onSave
}: {
  value: T;
  options: T[];
  tone: Record<T, Tone>;
  disabled: boolean;
  onSave: (next: T) => void;
}) {
  if (disabled) return <Badge variant={tone[value]}>{humanize(value)}</Badge>;
  return (
    <Select value={value} onValueChange={(v) => onSave(v as T)}>
      <SelectTrigger className="h-7 w-full border-transparent px-1.5 hover:border-border" aria-label="Status">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o} value={o}>
            <span className="flex items-center gap-2">
              <span className={cn("h-1.5 w-1.5 rounded-full", TONE_DOT[tone[o]])} />
              {humanize(o)}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** The dot in the status dropdown. Kept beside the tones it mirrors so a new tone cannot be added
 *  without a colour for it. */
const TONE_DOT: Record<Tone, string> = {
  muted: "bg-muted-foreground/50",
  info: "bg-sky-500",
  warning: "bg-amber-500",
  success: "bg-emerald-500",
  destructive: "bg-destructive",
  default: "bg-primary",
  outline: "bg-muted-foreground/50",
  secondary: "bg-muted-foreground/50"
};

function RowActions({ disabled, onDelete }: { disabled: boolean; onDelete: () => void }) {
  if (disabled) return null;
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-7 w-7 text-muted-foreground hover:text-destructive"
      onClick={onDelete}
      aria-label="Remove row"
    >
      <Trash2 className="h-3.5 w-3.5" />
    </Button>
  );
}

function EmptyRow({ colSpan, children }: { colSpan: number; children: React.ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-6 text-center text-sm text-muted-foreground">
        {children}
      </td>
    </tr>
  );
}

/* ------------------------------------------------------------------ *
 * The three tables
 * ------------------------------------------------------------------ */

export function ChangeRunbook({
  changeId,
  steps,
  tests,
  dependencies,
  disabled
}: {
  changeId: string;
  steps: ChangeStep[];
  tests: ChangeTest[];
  dependencies: ChangeDependency[];
  disabled: boolean;
}) {
  const qc = useQueryClient();
  // One invalidation for all nine mutations: every write returns a child row, but the page reads
  // them off the change detail, so that is the query that has to be refetched.
  const refresh = () => qc.invalidateQueries({ queryKey: ["change", changeId] });
  const fail = (err: any) => toast.error("Could not save", { description: serverMessage(err, "Try again.") });

  const stepMutation = useMutation({ mutationFn: (v: { id: string; body: any }) => changeApi.updateStep(changeId, v.id, v.body), onSuccess: refresh, onError: fail });
  const stepDelete = useMutation({ mutationFn: (id: string) => changeApi.removeStep(changeId, id), onSuccess: refresh, onError: fail });
  const testMutation = useMutation({ mutationFn: (v: { id: string; body: any }) => changeApi.updateTest(changeId, v.id, v.body), onSuccess: refresh, onError: fail });
  const testDelete = useMutation({ mutationFn: (id: string) => changeApi.removeTest(changeId, id), onSuccess: refresh, onError: fail });
  const depMutation = useMutation({ mutationFn: (v: { id: string; body: any }) => changeApi.updateDependency(changeId, v.id, v.body), onSuccess: refresh, onError: fail });
  const depDelete = useMutation({ mutationFn: (id: string) => changeApi.removeDependency(changeId, id), onSuccess: refresh, onError: fail });

  const openBlockers = dependencies.filter((d) => d.status === "OPEN" && (d.dependencyType === "PREDECESSOR" || d.dependencyType === "BLOCKS"));
  const done = steps.filter((s) => s.status === "COMPLETED").length;
  const passed = tests.filter((t) => t.status === "PASSED").length;

  return (
    <div className="grid gap-8">
      <RunbookSection
        title="Implementation steps"
        hint={steps.length === 0 ? "Numbered in the order they will be run." : `${done} of ${steps.length} complete`}
        addLabel="Describe the next step, then press Enter"
        disabled={disabled}
        count={steps.length}
        onAdd={async (description) => {
          await changeApi.addStep(changeId, { description } as any);
          await refresh();
        }}
      >
        <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="w-10 px-3 py-2 font-medium">#</th>
            <th className="px-3 py-2 font-medium">Step</th>
            <th className="w-40 px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Notes</th>
            <th className="w-10 px-3 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {steps.length === 0 && <EmptyRow colSpan={5}>No steps yet. A runbook is what makes a change repeatable.</EmptyRow>}
          {steps.map((step) => (
            <tr key={step.id} className="align-middle">
              <td className="px-3 py-1.5 text-xs tabular-nums text-muted-foreground">
                <span className="flex items-center gap-1">
                  <GripVertical className="h-3 w-3 opacity-40" />
                  {step.stepNumber}
                </span>
              </td>
              <td className="px-2 py-1.5">
                <CellInput value={step.description} disabled={disabled} onSave={(description) => stepMutation.mutate({ id: step.id, body: { description } })} />
              </td>
              <td className="px-2 py-1.5">
                <StatusPicker value={step.status} options={STEP_STATUSES} tone={STEP_TONE} disabled={disabled} onSave={(status) => stepMutation.mutate({ id: step.id, body: { status } })} />
              </td>
              <td className="px-2 py-1.5">
                <CellInput value={step.comments} disabled={disabled} placeholder="—" onSave={(comments) => stepMutation.mutate({ id: step.id, body: { comments } })} />
              </td>
              <td className="px-2 py-1.5">
                <RowActions disabled={disabled} onDelete={() => stepDelete.mutate(step.id)} />
              </td>
            </tr>
          ))}
        </tbody>
      </RunbookSection>

      <RunbookSection
        title="Test cases"
        hint={tests.length === 0 ? "How anyone will know the change worked." : `${passed} of ${tests.length} passing`}
        addLabel="Describe what has to be true afterwards, then press Enter"
        disabled={disabled}
        count={tests.length}
        onAdd={async (description) => {
          await changeApi.addTest(changeId, { description } as any);
          await refresh();
        }}
      >
        <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="w-20 px-3 py-2 font-medium">Ref</th>
            <th className="px-3 py-2 font-medium">Assertion</th>
            <th className="px-3 py-2 font-medium">Expected</th>
            <th className="px-3 py-2 font-medium">Actual</th>
            <th className="w-36 px-3 py-2 font-medium">Result</th>
            <th className="w-10 px-3 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {tests.length === 0 && <EmptyRow colSpan={6}>No test cases yet. Above low risk, a test plan is required to submit.</EmptyRow>}
          {tests.map((test) => (
            <tr key={test.id} className="align-middle">
              <td className="px-3 py-1.5 text-xs font-medium tabular-nums text-muted-foreground">{test.reference}</td>
              <td className="px-2 py-1.5">
                <CellInput value={test.description} disabled={disabled} onSave={(description) => testMutation.mutate({ id: test.id, body: { description } })} />
              </td>
              <td className="px-2 py-1.5">
                <CellInput value={test.expectedResult} disabled={disabled} placeholder="—" onSave={(expectedResult) => testMutation.mutate({ id: test.id, body: { expectedResult } })} />
              </td>
              <td className="px-2 py-1.5">
                <CellInput value={test.actualResult} disabled={disabled} placeholder="—" onSave={(actualResult) => testMutation.mutate({ id: test.id, body: { actualResult } })} />
              </td>
              <td className="px-2 py-1.5">
                <StatusPicker value={test.status} options={TEST_STATUSES} tone={TEST_TONE} disabled={disabled} onSave={(status) => testMutation.mutate({ id: test.id, body: { status } })} />
              </td>
              <td className="px-2 py-1.5">
                <RowActions disabled={disabled} onDelete={() => testDelete.mutate(test.id)} />
              </td>
            </tr>
          ))}
        </tbody>
      </RunbookSection>

      <div className="grid gap-3">
        {/* Stated above the table, not inside it: this is the reason the Implement button will refuse,
            and somebody reading the page needs it before they go looking for the button. */}
        {openBlockers.length > 0 && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-foreground">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-500" />
            <p>
              Implementation is blocked while {openBlockers.length === 1 ? "this stays" : "these stay"} open. Mark{" "}
              {openBlockers.length === 1 ? "it" : "them"} complete, or waive with a reason.
            </p>
          </div>
        )}

        <RunbookSection
          title="Dependencies"
          hint="Predecessors and blockers must be cleared before implementing. Successors and related work do not block."
          addLabel="What does this change wait on? Press Enter"
          disabled={disabled}
          count={dependencies.length}
          onAdd={async (description) => {
            await changeApi.addDependency(changeId, { description, dependencyType: "PREDECESSOR" } as any);
            await refresh();
          }}
        >
          <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="w-40 px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 font-medium">What it is</th>
              <th className="px-3 py-2 font-medium">Team</th>
              <th className="w-36 px-3 py-2 font-medium">Status</th>
              <th className="w-10 px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {dependencies.length === 0 && <EmptyRow colSpan={5}>Nothing recorded. If this change waits on another team, say so here.</EmptyRow>}
            {dependencies.map((dep) => {
              const blocking = dep.status === "OPEN" && (dep.dependencyType === "PREDECESSOR" || dep.dependencyType === "BLOCKS");
              return (
                <tr key={dep.id} className={cn("align-middle", blocking && "bg-amber-500/5")}>
                  <td className="px-2 py-1.5">
                    <StatusPicker
                      value={dep.dependencyType}
                      options={DEPENDENCY_TYPES}
                      tone={{ PREDECESSOR: "warning", BLOCKS: "destructive", SUCCESSOR: "info", RELATED: "muted" }}
                      disabled={disabled}
                      onSave={(dependencyType) => depMutation.mutate({ id: dep.id, body: { dependencyType } })}
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <CellInput value={dep.description} disabled={disabled} onSave={(description) => depMutation.mutate({ id: dep.id, body: { description } })} />
                  </td>
                  <td className="px-2 py-1.5">
                    <CellInput value={dep.team} disabled={disabled} placeholder="—" onSave={(team) => depMutation.mutate({ id: dep.id, body: { team } })} />
                  </td>
                  <td className="px-2 py-1.5">
                    <StatusPicker value={dep.status} options={DEPENDENCY_STATUSES} tone={DEPENDENCY_TONE} disabled={disabled} onSave={(status) => depMutation.mutate({ id: dep.id, body: { status } })} />
                  </td>
                  <td className="px-2 py-1.5">
                    <RowActions disabled={disabled} onDelete={() => depDelete.mutate(dep.id)} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </RunbookSection>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * SLA ladder
 * ------------------------------------------------------------------ */

const SLA_TONE: Record<string, { bar: string; text: string; label: string }> = {
  BREACHED: { bar: "bg-destructive", text: "text-destructive", label: "Breached" },
  WARNING: { bar: "bg-amber-500", text: "text-amber-600 dark:text-amber-500", label: "Due soon" },
  ON_TRACK: { bar: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-500", label: "On track" },
  MET: { bar: "bg-emerald-500/60", text: "text-muted-foreground", label: "Met" },
  NOT_STARTED: { bar: "bg-muted-foreground/25", text: "text-muted-foreground", label: "Not started" }
};

const STAGE_LABEL: Record<string, string> = {
  APPROVAL: "Approval",
  IMPLEMENTATION: "Implementation",
  VALIDATION: "Validation",
  CLOSURE: "Closure"
};

/**
 * Every stage clock, as a ladder rather than one number.
 *
 * The full ladder is shown even where a stage has not started, because "approval met, implementation
 * running, validation not started" is a more useful thing to read at a glance than three rows that
 * appear one at a time and leave the reader guessing what is missing.
 */
export function ChangeSlaLadder({ sla }: { sla: Record<string, { state: string; hoursRemaining: number; pctElapsed: number; dueAt: string | null }> }) {
  const stages = ["APPROVAL", "IMPLEMENTATION", "VALIDATION", "CLOSURE"].filter((s) => sla[s]);
  if (stages.length === 0) return null;

  return (
    <div className="grid gap-2.5">
      {stages.map((stage) => {
        const verdict = sla[stage];
        const tone = SLA_TONE[verdict.state] ?? SLA_TONE.NOT_STARTED;
        const over = verdict.hoursRemaining < 0;
        return (
          <div key={stage} className="grid gap-1">
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="font-medium text-foreground">{STAGE_LABEL[stage] ?? stage}</span>
              <span className={cn("tabular-nums", tone.text)}>
                {verdict.state === "NOT_STARTED"
                  ? "Not started"
                  : verdict.state === "MET"
                    ? "Met"
                    : over
                      ? `${Math.abs(verdict.hoursRemaining)}h over`
                      : `${verdict.hoursRemaining}h left`}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className={cn("h-full rounded-full transition-[width] duration-700 ease-out", tone.bar)}
                style={{ width: `${Math.max(2, verdict.pctElapsed)}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
