/**
 * WHAT: one screen showing how much authority every AI capability holds — and, just as
 * deliberately, what this product will never do unattended.
 *
 * WHY THE LOCKED RUNGS ARE RENDERED RATHER THAN HIDDEN: the most valuable thing this screen
 * produces is not the settings it lets you change, it is the ceiling it lets you point at. "This
 * product will never approve a timesheet without a person" is worth far more when an auditor can
 * see the option greyed out with the reason underneath than when the option simply isn't there —
 * an absent option looks like something nobody thought about.
 *
 * WHY THE UI NEVER RE-DERIVES THE LEVEL: the server returns `requestedLevel` AND `effectiveLevel`,
 * having already applied the master latch, the capability's own feature toggle and the product's
 * ceiling. Recomputing any of that here would be a second implementation of the rule, and two
 * implementations is how a screen ends up confidently showing an administrator a level the server
 * does not agree with.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Bot, Lock, ShieldCheck } from "lucide-react";
import { settingsApi, type AutonomyEntry, type AutonomyLevel } from "../../services/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Switch } from "../../components/ui/switch";
import { Badge } from "../../components/ui/badge";
import { Skeleton } from "../../components/ui/skeleton";
import { toast } from "../../components/ui/toaster";
import { cn } from "../../lib/utils";

const LADDER: Array<{ level: AutonomyLevel; label: string; blurb: string }> = [
  { level: "SUGGEST", label: "Suggest", blurb: "Proposes changes. A person applies them, row by row." },
  { level: "AUTO_APPLY", label: "Apply, reversible", blurb: "Applies its own changes. You review or undo them afterwards." },
  { level: "AUTONOMOUS", label: "Act freely", blurb: "Acts repeatedly on its own, inside its cost and scope limits." }
];

const RANK: Record<AutonomyLevel, number> = { SUGGEST: 0, AUTO_APPLY: 1, AUTONOMOUS: 2 };

export function AIAutonomyCard({ readOnly, aiEnabled }: { readOnly: boolean; aiEnabled: boolean }) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<string | null>(null);

  const catalogue = useQuery({ queryKey: ["ai-autonomy"], queryFn: settingsApi.getAIAutonomy });

  const setLevel = useMutation({
    mutationFn: (vars: { capability: string; level: AutonomyLevel }) => settingsApi.updateAIAutonomy(vars),
    onMutate: (vars) => setPending(vars.capability),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["ai-autonomy"] });
      // The server may have clamped below what was clicked. Say so rather than letting the row
      // quietly settle on a different value than the one just chosen.
      if (RANK[result.effectiveLevel] < RANK[result.requestedLevel]) {
        toast.info("Saved, but capped", { description: result.clampedReason ?? undefined });
      }
    },
    onError: (error: unknown) => {
      const message =
        (error as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        "Could not change that setting.";
      // The 422 from an over-ceiling level carries the product's own reason — show it verbatim.
      toast.error("Not allowed", { description: message });
    },
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

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bot className="h-4 w-4" aria-hidden />
          Autonomy
        </CardTitle>
        <CardDescription>
          How much each AI feature may do on its own. Everything starts at <strong>Suggest</strong>, where a person
          applies every change. Some features can go further; some never can, and say why.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        {/*
          The master latch, first and visually separate. Its whole value is being one switch: when
          something is behaving badly, "stop the assistants acting" should not require auditing
          which of twenty-two features happen to be elevated.
        */}
        <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border bg-muted/40 p-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">Allow AI features to act on their own</p>
            <p className="text-xs text-muted-foreground">
              Off means every feature only suggests, whatever is chosen below. This is the switch to reach for first if
              something looks wrong.
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
              {elevated} {elevated === 1 ? "feature acts" : "features act"} without waiting for a person. Everything they
              change is recorded against the person they act for.
            </span>
          </p>
        )}

        {catalogue.isLoading && (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        )}

        <div className="space-y-3">
          {rows.map((row) => (
            <CapabilityRow
              key={row.capability}
              row={row}
              readOnly={readOnly || !aiEnabled}
              busy={pending === row.capability}
              onSelect={(level) => setLevel.mutate({ capability: row.capability, level })}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function CapabilityRow({
  row,
  readOnly,
  busy,
  onSelect
}: {
  row: AutonomyEntry;
  readOnly: boolean;
  busy: boolean;
  onSelect: (level: AutonomyLevel) => void;
}) {
  return (
    <div className={cn("rounded-lg border p-3", !row.featureEnabled && "opacity-60")}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">{row.title}</p>
          <p className="text-xs text-muted-foreground">{row.description}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {row.actsOnUntrustedInput && (
            <Badge variant="outline" className="gap-1 text-[11px]">
              <AlertTriangle className="h-3 w-3" aria-hidden />
              Reads outside text
            </Badge>
          )}
          {!row.featureEnabled && <Badge variant="outline" className="text-[11px]">Feature off</Badge>}
        </div>
      </div>

      {/* Radio semantics, because these are mutually exclusive. A locked rung stays in the tab
          order (aria-disabled, not disabled) so its reason is reachable by a screen reader —
          the reason is the most useful thing on the row. */}
      <div className="mt-3 grid gap-1.5 sm:grid-cols-3" role="radiogroup" aria-label={`${row.title} autonomy`}>
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
              aria-disabled={locked || readOnly || busy}
              onClick={() => !locked && !readOnly && !busy && onSelect(rung.level)}
              className={cn(
                "rounded-md border p-2 text-left transition",
                selected && !locked ? "border-primary bg-primary/5" : "border-border",
                locked ? "cursor-not-allowed bg-muted/40" : "hover:border-primary/60",
                readOnly && "cursor-not-allowed"
              )}
            >
              <span className="flex items-center gap-1.5 text-xs font-medium">
                {locked && <Lock className="h-3 w-3 shrink-0" aria-hidden />}
                {rung.label}
                {inForce && !locked && (
                  <Badge variant="secondary" className="ml-auto text-[10px]">
                    in force
                  </Badge>
                )}
              </span>
              <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{rung.blurb}</span>
            </button>
          );
        })}
      </div>

      {/* Why a rung is locked, or why what is chosen is not what is in force. Both are the
          server's own sentence — this screen never writes its own explanation of a rule it does
          not own. */}
      {row.ceilingReason && RANK[row.maxLevel] < RANK.AUTONOMOUS && (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-snug text-muted-foreground">
          <Lock className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          <span>{row.ceilingReason}</span>
        </p>
      )}
      {row.clampedReason && row.requestedLevel !== row.effectiveLevel && (
        <p className="mt-1.5 text-[11px] leading-snug text-warning-foreground">
          Set to {row.requestedLevel.replace("_", " ").toLowerCase()}, but only suggesting — {row.clampedReason}
        </p>
      )}
    </div>
  );
}
