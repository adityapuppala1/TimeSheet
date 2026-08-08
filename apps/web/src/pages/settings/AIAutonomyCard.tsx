/**
 * WHAT: one row per AI capability, carrying BOTH questions the product asks about it — does it run
 * at all, and how much may it do on its own.
 *
 * WHY ONE ROW AND NOT TWO LISTS: those questions are genuinely orthogonal in the data (turning a
 * feature off and on again must not silently restore its autonomy, which is why the level lives in
 * its own table), but they are questions about the SAME capability. Asking them in two separate
 * lists of twenty-odd rows made this tab look like it held two copies of everything, and left a
 * reader wondering which of the two was the real switch. They are now one control group: a switch
 * for "does it run", a ladder underneath for "how much".
 *
 * WHY THE LOCKED RUNGS ARE RENDERED RATHER THAN HIDDEN: the most valuable thing this screen
 * produces is not the settings it changes, it is the ceiling it lets you point at. "This product
 * will never approve a timesheet without a person" carries far more weight when an auditor can see
 * the option disabled with the reason beneath it than when the option simply is not there — an
 * absent option looks like something nobody considered.
 *
 * WHY THE UI NEVER RE-DERIVES A LEVEL: the server returns both what the workspace asked for and
 * what is in force, having already applied the master latch, the feature toggle and the ceiling.
 * Two implementations of that rule is how a screen ends up confidently disagreeing with the server.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Bot, Lock, Search, ShieldCheck } from "lucide-react";
import { settingsApi, type AutonomyEntry, type AutonomyLevel } from "../../services/api";
import type { GlobalAISettings } from "@timesheet/shared";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Switch } from "../../components/ui/switch";
import { Badge } from "../../components/ui/badge";
import { Skeleton } from "../../components/ui/skeleton";
import { toast } from "../../components/ui/toaster";
import { cn } from "../../lib/utils";

const LADDER: Array<{ level: AutonomyLevel; label: string; blurb: string }> = [
  { level: "SUGGEST", label: "Suggest", blurb: "A person applies each change." },
  { level: "AUTO_APPLY", label: "Apply, reversible", blurb: "Applies its own, you review or undo." },
  { level: "AUTONOMOUS", label: "Act freely", blurb: "Acts on its own, inside its limits." }
];

const RANK: Record<AutonomyLevel, number> = { SUGGEST: 0, AUTO_APPLY: 1, AUTONOMOUS: 2 };

/**
 * Grouped by what a capability DOES, so a long list reads as a few short ones. Twenty-four rows in
 * one column is a list nobody finishes reading — and the grouping carries information of its own,
 * because "reads what people outside send in" is exactly the group whose ceilings are lower.
 */
const GROUPS: Array<{ title: string; hint: string; match: (c: AutonomyEntry) => boolean }> = [
  {
    title: "Changes your plan",
    hint: "Can alter work items, dates and who is assigned.",
    match: (c) =>
      ["plan_breakdown", "assignment_rebalance", "duplicate_detection", "assignee_suggestion_explanation"].includes(c.capability)
  },
  {
    title: "Reads what people outside send in",
    hint: "Email, chat, pull requests, scanner output. Capped below the top rung for that reason.",
    match: (c) => c.actsOnUntrustedInput
  },
  {
    title: "Writes text and answers questions",
    hint: "Never acts — these produce words a person then uses.",
    match: (c) => ["text_refine", "writing_assistant", "ask_ai", "status_report"].includes(c.capability)
  },
  {
    title: "Reports on a schedule",
    hint: "Already unattended: they send a summary and change no records.",
    match: (c) =>
      ["weekly_digest", "security_weekly_digest", "bug_pattern_digest", "project_risk_narrative"].includes(c.capability)
  },
  {
    title: "Identity and measurement",
    hint: "The most constrained things in the product, deliberately.",
    match: () => true
  }
];

export function AIAutonomyCard({
  readOnly,
  aiEnabled,
  settings,
  onToggleFeature
}: {
  readOnly: boolean;
  aiEnabled: boolean;
  settings: GlobalAISettings | undefined;
  /** Flips the capability's own GlobalAISettings switch. Owned by the parent so this card does not
   *  become a second writer of that row. */
  onToggleFeature: (key: string, value: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const catalogue = useQuery({ queryKey: ["ai-autonomy"], queryFn: settingsApi.getAIAutonomy });

  const setLevel = useMutation({
    mutationFn: (vars: { capability: string; level: AutonomyLevel }) => settingsApi.updateAIAutonomy(vars),
    onMutate: (vars) => setPending(vars.capability),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["ai-autonomy"] });
      // The server may have clamped below what was clicked. Say so, rather than letting the row
      // quietly settle on a different value than the one just chosen.
      if (RANK[result.effectiveLevel] < RANK[result.requestedLevel]) {
        toast.info("Saved, but capped", { description: result.clampedReason ?? undefined });
      }
    },
    onError: (err: any) =>
      // The 422 for an over-ceiling level carries the product's own reason — show it verbatim.
      toast.error("Not allowed", { description: err?.response?.data?.message ?? "Could not change that setting." }),
    onSettled: () => setPending(null)
  });

  const toggleLatch = useMutation({
    mutationFn: (aiAutonomyEnabled: boolean) => settingsApi.updateAI({ aiAutonomyEnabled }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["ai-autonomy"] });
      await queryClient.invalidateQueries({ queryKey: ["ai-settings"] });
    }
  });

  const rows = catalogue.data?.capabilities ?? [];
  const elevated = useMemo(() => rows.filter((r) => r.effectiveLevel !== "SUGGEST").length, [rows]);

  const grouped = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const visible = needle ? rows.filter((r) => (r.title + " " + r.description).toLowerCase().includes(needle)) : rows;

    const taken = new Set<string>();
    return GROUPS.map((group) => {
      const items = visible.filter((c) => !taken.has(c.capability) && group.match(c));
      items.forEach((c) => taken.add(c.capability));
      return { ...group, items };
    }).filter((g) => g.items.length > 0);
  }, [rows, filter]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bot className="h-4 w-4" aria-hidden />
          AI capabilities
        </CardTitle>
        <CardDescription>
          Each has two settings: whether it runs, and how much it may do without you. Everything starts at{" "}
          <strong>Suggest</strong>, where a person applies every change. Some can go further; some never can, and say why.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {/*
          The master latch, first and visually apart. Its whole value is being ONE switch: when
          something looks wrong, "stop the assistants acting" must not require auditing which of
          twenty-four capabilities happen to be elevated.
        */}
        <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border bg-muted/40 p-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">Allow AI features to act on their own</p>
            <p className="text-xs text-muted-foreground">
              Off means every capability only suggests, whatever is chosen below. Reach for this first if something looks
              wrong.
            </p>
          </div>
          <Switch
            checked={catalogue.data?.autonomyEnabled ?? false}
            disabled={readOnly || !aiEnabled || toggleLatch.isPending}
            onCheckedChange={(v) => toggleLatch.mutate(v)}
            aria-label="Allow AI features to act on their own"
          />
        </div>

        {!aiEnabled && (
          <p className="text-xs text-muted-foreground">AI is switched off for this workspace, so nothing here applies yet.</p>
        )}

        {catalogue.data?.autonomyEnabled && elevated > 0 && (
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              {elevated} {elevated === 1 ? "capability acts" : "capabilities act"} without waiting for a person. Everything
              they change is recorded against the person they act for.
            </span>
          </p>
        )}

        {rows.length > 8 && (
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              className="pl-8"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Find a capability..."
              aria-label="Filter capabilities"
            />
          </div>
        )}

        {catalogue.isLoading && (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
        )}

        {grouped.map((group) => (
          <section key={group.title} className="space-y-2">
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group.title}</h4>
              <p className="text-[11px] text-muted-foreground">{group.hint}</p>
            </div>
            {/* Two columns from md up: these rows are short, and one column wastes width the
                settings page already has. */}
            <div className="grid gap-2 md:grid-cols-2">
              {group.items.map((row) => (
                <CapabilityRow
                  key={row.capability}
                  row={row}
                  readOnly={readOnly || !aiEnabled}
                  busy={pending === row.capability}
                  featureOn={row.featureToggle ? Boolean(settings?.[row.featureToggle as keyof GlobalAISettings]) : true}
                  onToggleFeature={onToggleFeature}
                  onSelect={(level) => setLevel.mutate({ capability: row.capability, level })}
                />
              ))}
            </div>
          </section>
        ))}

        {!catalogue.isLoading && grouped.length === 0 && (
          <p className="py-4 text-center text-sm text-muted-foreground">Nothing matches that.</p>
        )}
      </CardContent>
    </Card>
  );
}

function CapabilityRow({
  row,
  readOnly,
  busy,
  featureOn,
  onToggleFeature,
  onSelect
}: {
  row: AutonomyEntry;
  readOnly: boolean;
  busy: boolean;
  featureOn: boolean;
  onToggleFeature: (key: string, value: boolean) => void;
  onSelect: (level: AutonomyLevel) => void;
}) {
  return (
    <div className={cn("rounded-lg border p-3 transition", !featureOn && "bg-muted/20")}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
            {row.title}
            {row.actsOnUntrustedInput && (
              <Badge variant="outline" className="gap-1 text-[10px] font-normal">
                <AlertTriangle className="h-2.5 w-2.5" aria-hidden />
                outside text
              </Badge>
            )}
          </p>
          <p className="text-xs text-muted-foreground">{row.description}</p>
        </div>
        {/* "Does it run at all". Absent for a capability with no model behind it — there is no AI
            switch that could be off. */}
        {row.featureToggle ? (
          <Switch
            checked={featureOn}
            disabled={readOnly}
            onCheckedChange={(v) => onToggleFeature(row.featureToggle as string, v)}
            aria-label={"Enable " + row.title}
          />
        ) : (
          <Badge variant="muted" className="shrink-0 text-[10px]">
            no AI
          </Badge>
        )}
      </div>

      {/* "How much authority", dimmed while the capability itself is off — a level that cannot
          apply to anything should not look active. */}
      <div
        className={cn("mt-2.5 grid gap-1 sm:grid-cols-3", !featureOn && "pointer-events-none opacity-50")}
        role="radiogroup"
        aria-label={row.title + " autonomy"}
      >
        {LADDER.map((rung) => {
          const locked = RANK[rung.level] > RANK[row.maxLevel];
          const selected = row.requestedLevel === rung.level;
          const inForce = row.effectiveLevel === rung.level;

          return (
            <button
              key={rung.level}
              type="button"
              role="radio"
              aria-checked={selected}
              // aria-disabled, not disabled, so a locked rung stays in the tab order and its reason
              // is reachable — the reason is the most useful thing on the row.
              aria-disabled={locked || readOnly || busy}
              onClick={() => !locked && !readOnly && !busy && onSelect(rung.level)}
              className={cn(
                "rounded-md border px-2 py-1.5 text-left transition",
                selected && !locked ? "border-primary bg-primary/5" : "border-border",
                locked ? "cursor-not-allowed bg-muted/40" : "hover:border-primary/60"
              )}
            >
              <span className="flex items-center gap-1 text-[11px] font-medium">
                {locked && <Lock className="h-2.5 w-2.5 shrink-0" aria-hidden />}
                {rung.label}
                {inForce && !locked && <span className="ml-auto text-[9px] uppercase text-primary">now</span>}
              </span>
              <span className="mt-0.5 block text-[10px] leading-tight text-muted-foreground">{rung.blurb}</span>
            </button>
          );
        })}
      </div>

      {/* The server's own sentence, never this screen's paraphrase of a rule it does not own. */}
      {row.ceilingReason && RANK[row.maxLevel] < RANK.AUTONOMOUS && (
        <p className="mt-2 flex items-start gap-1.5 text-[10px] leading-snug text-muted-foreground">
          <Lock className="mt-0.5 h-2.5 w-2.5 shrink-0" aria-hidden />
          <span>{row.ceilingReason}</span>
        </p>
      )}
      {row.clampedReason && row.requestedLevel !== row.effectiveLevel && (
        <p className="mt-1.5 text-[10px] leading-snug text-warning-foreground">
          Set to {row.requestedLevel.replace("_", " ").toLowerCase()}, but only suggesting — {row.clampedReason}
        </p>
      )}
    </div>
  );
}
