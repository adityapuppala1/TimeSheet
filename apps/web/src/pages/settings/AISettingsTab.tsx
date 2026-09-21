/**
 * The AI tab of Workspace Settings: a board, then ten sections that fold.
 *
 * WHY IT WAS REBUILT. Measured on 2026-09-21 the tab was 13,871 px tall on a laptop and 27,374 px
 * on a phone: ten cards stacked in full — the master switch, providers, the local model runner,
 * spend, feature usage, the autonomy ladder, agent runs, quality, prompts, datasets, evaluations —
 * whichever one the admin came for. Nothing was wrong with any card; the page had no shape.
 *
 * THE SHAPE NOW (the one Single sign-on established, from components/settings/settings-sections):
 * a board of tiles, one per section, each carrying the section's ONE figure ("$0.64 of $20",
 * "12 of 13 on", "3 datasets") and its state, so the question an admin arrives with is answered
 * on the first screen; and the sections below it, folded, each opening in place. Every card
 * component is the same component it was — it renders frameless inside its section — so nothing
 * about what each one does, queries or saves has moved.
 *
 * WHY THE BOARD READS ITS FIGURES FROM THE CARDS' OWN QUERY KEYS: `["settings","ai","providers"]`,
 * `["settings","ai","native","runtime"]`, `["ai","prompts"]`, `["ai","datasets"]` are exactly the
 * keys the cards fetch under, so the board costs no extra request and can never disagree with the
 * section it points at.
 *
 * Split out of WorkspaceSettings.tsx for the reason every other settings domain was: that file
 * had crossed 2,500 lines, a third of it this tab.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import type { GlobalAISettings } from "@timesheet/shared";
import { Activity, Bot, CircleDollarSign, Cpu, Database, Download, FileText, FlaskConical, Gauge, KeyRound, Loader2, Save, ShieldAlert, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { AiFeatureUsagePanel } from "../../components/AiFeatureUsagePanel";
import { SectionBoard, SettingsSection, ToggleRow, useOpenSections, type BoardEntry } from "../../components/settings/settings-sections";
import { aiCapabilitiesVerdict, aiDatasetsVerdict, aiEvalsVerdict, aiFeaturesVerdict, aiPromptsVerdict, aiSpendVerdict, liveOrOff, type TileVerdict } from "../../lib/settings-state";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { DataTable } from "../../components/ui/data-table";
import { DateRangePicker, type DateRangeValue } from "../../components/ui/date-range-picker";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Skeleton } from "../../components/ui/skeleton";
import { Switch } from "../../components/ui/switch";
import { toast } from "../../components/ui/toaster";
import { aiDatasetApi, aiPromptApi, settingsApi, type AIProviderConfigRow, type AIUsageRow } from "../../services/api";
import { AIAutonomyCard } from "./AIAutonomyCard";
import { AIDatasetsCard } from "./AIDatasetsCard";
import { AIEvalsCard } from "./AIEvalsCard";
import { AIPromptsCard } from "./AIPromptsCard";
import { AIProviderListCard } from "./AIProviderListCard";
import { AgentRunsCard } from "./AgentRunsCard";
import { NativeModelRunnerCard } from "./NativeModelRunnerCard";

// Matches the exact chart styling convention used in Insights.tsx (this repo's `dataviz`
// skill): CSS-variable colors only, fixed categorical order never re-cycled by rank.
const AXIS_STYLE = { stroke: "hsl(var(--muted-foreground))", fontSize: 12 };
const TOOLTIP_STYLE = {
  contentStyle: { background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, color: "hsl(var(--popover-foreground))" }
};
const GRID_STYLE = { strokeDasharray: "3 3", stroke: "hsl(var(--border))" };
const MODEL_COLORS = ["hsl(var(--primary))", "hsl(var(--info))", "hsl(var(--accent))", "hsl(var(--warning))", "hsl(var(--success))"];

function formatWeek(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** yyyy-mm-dd in LOCAL time, matching DateRangePicker's own ISO shape — `toISOString()` would
 *  shift near midnight for any timezone ahead of UTC. */
function localIso(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Columns for the AI usage table — one row per provider×model combination actually used in the
 *  picked range. Module-level, matching Tickets.tsx's ticketColumns convention. */
const usageColumns: ColumnDef<AIUsageRow, unknown>[] = [
  { accessorKey: "provider", header: "Provider" },
  { accessorKey: "model", header: "Model" },
  { accessorKey: "calls", header: "Calls", cell: ({ row }) => row.original.calls.toLocaleString() },
  {
    accessorKey: "successRatePct",
    header: "Success rate",
    cell: ({ row }) => {
      const pct = row.original.successRatePct;
      if (pct === null) return <span className="text-muted-foreground">n/a</span>;
      // Amber/red only below a real reliability concern — a single stray timeout in a busy month
      // shouldn't paint an otherwise-solid provider as troubled.
      const tone = pct >= 95 ? "text-success" : pct >= 80 ? "text-warning" : "text-destructive";
      return (
        <span className={tone} title={`${row.original.successCount} succeeded, ${row.original.failureCount} failed`}>
          {pct}%
        </span>
      );
    }
  },
  { accessorKey: "inputTokens", header: "Input tokens", cell: ({ row }) => row.original.inputTokens.toLocaleString() },
  { accessorKey: "outputTokens", header: "Output tokens", cell: ({ row }) => row.original.outputTokens.toLocaleString() },
  { accessorKey: "totalTokens", header: "Total tokens", cell: ({ row }) => row.original.totalTokens.toLocaleString() },
  {
    accessorKey: "avgLatencyMs",
    header: "Avg latency",
    cell: ({ row }) =>
      row.original.avgLatencyMs === null ? (
        <span className="text-muted-foreground">not measured</span>
      ) : (
        <span title={`measured on ${row.original.latencyMeasuredCalls} of ${row.original.calls} calls`}>
          {row.original.avgLatencyMs.toLocaleString()} ms
        </span>
      )
  },
  { accessorKey: "costUsd", header: "Cost", cell: ({ row }) => `$${row.original.costUsd.toFixed(2)}` },
  { accessorKey: "costSharePct", header: "% of total", cell: ({ row }) => `${row.original.costSharePct}%` }
];


/** A single Excel-export button for the AI usage table — one format, not the 3-way CSV/XLSX/PDF
 *  menu Change Management's register export has, since only Excel was asked for here. Downloads
 *  via an authenticated blob GET (settingsApi.downloadAiUsageExcel), never a bare `<a href>` —
 *  this app keeps its access token in memory, so a plain link would 401. Same dance as Changes.tsx's
 *  ExportMenu: createObjectURL, a programmatic click, then revokeObjectURL. */
function AiUsageExportButton({ range, feature }: { range: DateRangeValue; feature: string }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const { blob } = await settingsApi.downloadAiUsageExcel({ from: range.from, to: range.to, feature: feature || undefined });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `ai-usage-${range.from}-to-${range.to}.xlsx`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      toast.error("Could not export", { description: err?.response?.data?.message ?? "Try again." });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button variant="outline" size="sm" disabled={busy} onClick={run}>
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
      Export .xlsx
    </Button>
  );
}

const PREFIX = "ai";
const OPEN_KEY = "ts.settings.ai.open";

/* ── The board's figures, each from the query its section already runs ─────────────────────── */

function providerFigure(rows: AIProviderConfigRow[] | undefined): TileVerdict {
  if (!rows || rows.length === 0) return { value: "None yet", state: "off" };
  const enabled = rows.filter((r) => r.enabled).sort((a, b) => a.priority - b.priority);
  if (enabled.length === 0) return { value: `${rows.length} saved, none enabled`, state: "ready", label: "Saved — none enabled" };
  const top = enabled[0];
  return { value: `${enabled.length} of ${rows.length} enabled · ${top.label ?? top.model} first`, state: "live" };
}

function runtimeFigure(status: { state: string; modelId: string | null } | undefined): TileVerdict {
  if (!status) return { value: "—", state: "off" };
  switch (status.state) {
    case "ready":
      return { value: status.modelId ?? "A model is serving", state: "live", label: "Running" };
    case "starting":
    case "restarting":
      return { value: status.modelId ?? "Starting", state: "live", label: "Starting" };
    case "failed":
      return { value: "The last start failed", state: "attention" };
    case "stopped":
      return { value: "Installed — not running", state: "ready", label: "Ready — not running" };
    default:
      return { value: "Nothing installed", state: "off" };
  }
}

/** The ten tiles, from the figures above and the pure verdicts in lib/settings-state.ts. */
function aiBoard(input: {
  aiOn: boolean;
  keyed: boolean;
  captureOn: boolean;
  providers: AIProviderConfigRow[] | undefined;
  runtime: { state: string; modelId: string | null } | undefined;
  spend: number | undefined;
  budget: number | null | undefined;
  capabilities: Array<{ featureEnabled: boolean }> | undefined;
  autonomyEnabled: boolean;
  prompts: Array<{ customized: boolean }> | undefined;
  datasetCount: number | undefined;
}): BoardEntry[] {
  const caps = input.capabilities ?? [];
  const capsOn = caps.filter((c) => c.featureEnabled).length;
  const customised = (input.prompts ?? []).filter((p) => p.customized).length;
  const tile = (id: string, name: string, blurb: string, Icon: BoardEntry["Icon"], v: TileVerdict): BoardEntry => ({ id, name, blurb, Icon, value: v.value, state: v.state, stateLabel: v.label });
  return [
    tile("features", "AI features", "The master switch, what is kept about each call, the threshold and the budget.", Sparkles, aiFeaturesVerdict(input.aiOn, input.keyed)),
    tile("providers", "Providers", "Ranked; the top enabled one takes every call, the rest are fallbacks.", KeyRound, providerFigure(input.providers)),
    tile("native", "Run a model on this server", "A model on this machine's CPU: no per-call cost, nothing leaves the box.", Cpu, runtimeFigure(input.runtime)),
    tile("usage", "Usage & spend", "Estimated cost, tokens and calls by provider, model and feature.", CircleDollarSign, aiSpendVerdict(input.spend, input.budget, input.aiOn)),
    tile("capabilities", "Capabilities & autonomy", "Each capability: whether it runs, and how much it may do without you.", Bot, aiCapabilitiesVerdict(input.aiOn, capsOn, caps.length, input.autonomyEnabled)),
    tile("runs", "Agent runs", "What ran unattended, as whom, and every step it took.", Activity, liveOrOff(input.aiOn, "Recording", "AI is off")),
    tile("quality", "Quality", "Unusable responses, what people did with suggestions, ratings. Last 30 days.", Gauge, liveOrOff(input.aiOn && input.captureOn, "Measuring", "Capture is off")),
    tile("prompts", "Prompts", "What each capability is told, editable without a release.", FileText, aiPromptsVerdict(customised, input.prompts?.length)),
    tile("datasets", "Golden datasets", "Real examples paired with the answer you say is correct.", Database, aiDatasetsVerdict(input.datasetCount)),
    tile("evals", "Evaluations", "Replay a dataset and score each answer; two runs are the comparison.", FlaskConical, aiEvalsVerdict(input.datasetCount ?? 0))
  ];
}

export function AISettingsTab({ readOnly }: { readOnly: boolean }) {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["settings", "ai"], queryFn: settingsApi.getAI });

  // Defaults to the current calendar month — same window the card always showed before it could
  // be changed at all. `allowAllTime={false}` on the picker below keeps the range bounded: a spend
  // report over "all time" isn't a period anyone can act on.
  const [usageRange, setUsageRange] = useState<DateRangeValue>(() => {
    const now = new Date();
    return { from: localIso(new Date(now.getFullYear(), now.getMonth(), 1)), to: localIso(now) };
  });
  const [usageFeature, setUsageFeature] = useState<string>("");

  const usage = useQuery({
    queryKey: ["settings", "ai", "usage", usageRange.from, usageRange.to, usageFeature],
    queryFn: () => settingsApi.getAIUsageSummary({ from: usageRange.from, to: usageRange.to, feature: usageFeature || undefined }),
    enabled: Boolean(settings.data?.aiEnabled && usageRange.from && usageRange.to)
  });
  const usageTrend = useQuery({
    queryKey: ["settings", "ai", "usage-trend", usageRange.from, usageRange.to],
    queryFn: () => settingsApi.getAIUsageTrend({ from: usageRange.from, to: usageRange.to }),
    enabled: Boolean(settings.data?.aiEnabled && usageRange.from && usageRange.to)
  });

  const update = useMutation({
    mutationFn: (payload: Partial<GlobalAISettings> & { apiKey?: string }) => settingsApi.updateAI(payload),
    onMutate: async (payload) => {
      await queryClient.cancelQueries({ queryKey: ["settings", "ai"] });
      const previous = queryClient.getQueryData<GlobalAISettings>(["settings", "ai"]);
      // apiKey is write-only and not part of the cached settings shape — don't spread it into
      // the optimistic cache update, or GlobalAISettings would gain a field it never actually has.
      // eslint-disable-next-line sonarjs/no-unused-vars -- rest-sibling omit pattern
      const { apiKey: _apiKey, ...optimistic } = payload;
      if (previous) queryClient.setQueryData(["settings", "ai"], { ...previous, ...optimistic });
      return { previous };
    },
    onError: (err: any, _payload, context) => {
      if (context?.previous) queryClient.setQueryData(["settings", "ai"], context.previous);
      toast.error("Could not save", { description: err?.response?.data?.message ?? "Try again." });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings", "ai"] })
  });

  const [budgetDraft, setBudgetDraft] = useState("");
  useEffect(() => {
    if (settings.data) setBudgetDraft(settings.data.monthlyBudgetUsd != null ? String(settings.data.monthlyBudgetUsd) : "");
  }, [settings.data?.monthlyBudgetUsd]);

  const toggles: Array<{ key: keyof GlobalAISettings; label: string; description: string }> = [
    // ONLY the settings that are NOT a capability. Every per-capability switch moved into
    // AIAutonomyCard, where it sits beside that capability's autonomy level — the two answer
    // different questions about the same thing, and listing them separately made this tab look
    // like it held two copies of everything.
    //
    // What is left is data retention, which is genuinely a different subject: it governs what is
    // KEPT about an AI call, not what the call is allowed to do.
    { key: "autoTriageAutoApply", label: "Auto-apply triage suggestions (legacy)", description: "Pre-fills the suggestion instead of showing an accept/dismiss chip. This predates the autonomy ladder and means the same thing as setting Ticket triage to “Apply, reversible” above — leaving it on holds triage at that level. Prefer the capability setting; this stays so workspaces that already use it keep working." },
    { key: "aiCaptureEnabled", label: "Record AI quality metrics", description: "Logs one row per AI call — which feature, which model, whether the response parsed, and how long it took. No prompt text, no user content, just a hash. Without this there is no way to answer \"is our AI actually any good?\" — cost is the only AI signal the system otherwise keeps." },
    { key: "aiCaptureContentEnabled", label: "Also store prompts and responses", description: "Additionally keeps the prompt text, the model's answer, and the inputs it was given. This retains real user content (ticket descriptions, timesheet notes, PR diffs), so it's a deliberate privacy decision — but it's required before you can build a test set from real failures or compare one prompt against another. Face-verification prompts are never stored regardless of this setting." },
  ];

  // ── Board figures: the same keys the sections fetch under, so no extra request and no drift.
  const providers = useQuery({ queryKey: ["settings", "ai", "providers"], queryFn: settingsApi.listAiProviders });
  const runtime = useQuery({ queryKey: ["settings", "ai", "native", "runtime"], queryFn: settingsApi.getNativeAiRuntime });
  const autonomy = useQuery({ queryKey: ["ai-autonomy"], queryFn: settingsApi.getAIAutonomy, enabled: Boolean(settings.data) });
  const prompts = useQuery({ queryKey: ["ai", "prompts"], queryFn: aiPromptApi.list });
  const datasets = useQuery({ queryKey: ["ai", "datasets"], queryFn: aiDatasetApi.list });

  const sections = useOpenSections(OPEN_KEY, ["features"]);
  const aiOn = Boolean(settings.data?.aiEnabled);
  const captureOn = Boolean(settings.data?.aiCaptureEnabled);

  const keyed = Boolean(settings.data?.apiKeyConfigured) || (providers.data ?? []).some((r) => r.enabled);
  const board = useMemo(
    () =>
      aiBoard({
        aiOn,
        keyed,
        captureOn,
        providers: providers.data,
        runtime: runtime.data,
        spend: usage.data?.totalCostUsd,
        budget: settings.data?.monthlyBudgetUsd,
        capabilities: autonomy.data?.capabilities,
        autonomyEnabled: Boolean(autonomy.data?.autonomyEnabled),
        prompts: prompts.data,
        datasetCount: datasets.data?.length
      }),
    [aiOn, keyed, captureOn, providers.data, runtime.data, usage.data?.totalCostUsd, settings.data?.monthlyBudgetUsd, autonomy.data, prompts.data, datasets.data?.length]
  );

  const liveCount = board.filter((b) => b.state === "live").length;
  const byId = (id: string) => board.find((b) => b.id === id)!;
  const section = (id: string) => {
    const entry = byId(id);
    return { id, prefix: PREFIX, name: entry.name, blurb: entry.blurb, state: entry.state, stateLabel: entry.stateLabel, Icon: entry.Icon, open: sections.isOpen(id), onToggle: () => sections.toggle(id) };
  };

  return (
    <div className="grid gap-4">
      <SectionBoard
        title="AI at a glance"
        summary={aiSummary(settings.isLoading, aiOn, liveCount, board.length)}
        entries={board}
        onPick={(id) => sections.reveal(id, PREFIX)}
        columns={4}
        aside={<span className="text-xs font-medium tabular-nums text-muted-foreground">{liveCount} / {board.length}</span>}
      />

      <SettingsSection {...section("features")}>
        {settings.isLoading && <Skeleton className="h-40 w-full" />}
        {!settings.isLoading && settings.data && (
          <>
            {!settings.data.apiKeyConfigured && (
              <Alert variant="warning">
                <ShieldAlert />
                <AlertTitle>No API key configured</AlertTitle>
                <AlertDescription>
                  Set <code className="rounded bg-background/60 px-1">ANTHROPIC_API_KEY</code> in{" "}
                  <code className="rounded bg-background/60 px-1">apps/api/.env</code>, or add a provider under Providers —
                  toggles will save either way, but nothing will actually run until a key is available.
                </AlertDescription>
              </Alert>
            )}
            <ToggleRow
              emphasis
              label="Enable AI features"
              hint="Master switch for everything on this tab. Nothing calls out to a model while it is off."
              checked={settings.data.aiEnabled}
              disabled={readOnly}
              onChange={(v) => update.mutate({ aiEnabled: v })}
            />

            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <div className="divide-y divide-border rounded-lg border border-border">
                {toggles.map((t) => (
                  <div key={t.key} className="flex items-start gap-4 p-4">
                    <div className="min-w-0 flex-1">
                      <Label className={readOnly ? "" : "cursor-pointer"}>{t.label}</Label>
                      <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{t.description}</p>
                    </div>
                    <ToggleSwitch
                      checked={Boolean(settings.data?.[t.key])}
                      disabled={readOnly || !settings.data?.aiEnabled}
                      onChange={(v) => update.mutate({ [t.key]: v } as Partial<GlobalAISettings>)}
                    />
                  </div>
                ))}
              </div>

              <div className="grid content-start gap-4 rounded-lg border border-border p-4">
                <div className="grid gap-1.5">
                  <Label>Confidence threshold</Label>
                  <Input
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={settings.data.confidenceThreshold}
                    disabled={readOnly}
                    onChange={(e) => update.mutate({ confidenceThreshold: Number(e.target.value) })}
                  />
                  <p className="text-xs leading-5 text-muted-foreground">
                    Below this, AI-classified tickets are flagged "needs review" instead of auto-assigned.
                  </p>
                </div>
                <div className="grid gap-1.5">
                  <Label>Monthly budget (USD, optional)</Label>
                  <div className="flex gap-2">
                    <Input
                      type="number"
                      min={0}
                      step={1}
                      placeholder="No cap"
                      value={budgetDraft}
                      disabled={readOnly}
                      onChange={(e) => setBudgetDraft(e.target.value)}
                    />
                    <Button
                      size="sm"
                      className="h-10"
                      disabled={readOnly}
                      onClick={() => update.mutate({ monthlyBudgetUsd: budgetDraft ? Number(budgetDraft) : null })}
                    >
                      <Save className="h-4 w-4" />Save
                    </Button>
                  </div>
                  <p className="text-xs leading-5 text-muted-foreground">
                    AI features pause gracefully once this month's estimated spend hits the cap.
                  </p>
                </div>
              </div>
            </div>
          </>
        )}
      </SettingsSection>

      <SettingsSection {...section("providers")}>
        <AIProviderListCard readOnly={readOnly} />
      </SettingsSection>

      {/* After the provider list on purpose: this section's payoff is the button that puts a
          locally-run model at the TOP of that list. */}
      <SettingsSection {...section("native")}>
        <NativeModelRunnerCard readOnly={readOnly} />
      </SettingsSection>

      <SettingsSection {...section("usage")}>
        {!aiOn && <p className="text-sm text-muted-foreground">Turn AI on to see what it costs and where the tokens go.</p>}
        {aiOn && (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">AI usage</CardTitle>
                <CardDescription>
                  Estimated cost and token consumption{usage.data ? ` from ${usage.data.from} to ${usage.data.to}` : ""}.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-5">
                {usage.isLoading && <Skeleton className="h-20 w-full" />}
                {!usage.isLoading && usage.data && (
                  <>
                    <div className="grid gap-4 grid-cols-2 lg:grid-cols-5">
                      <div className="rounded-lg border border-border bg-muted/30 p-4">
                        <p className="text-xs uppercase text-muted-foreground">Estimated spend</p>
                        <p className="mt-1 text-2xl font-black">${usage.data.totalCostUsd.toFixed(2)}</p>
                      </div>
                      <div className="rounded-lg border border-border bg-muted/30 p-4">
                        <p className="text-xs uppercase text-muted-foreground">AI calls</p>
                        <p className="mt-1 text-2xl font-black">{usage.data.totalCalls}</p>
                      </div>
                      <div className="rounded-lg border border-border bg-muted/30 p-4">
                        <p className="text-xs uppercase text-muted-foreground">Success rate</p>
                        <p className="mt-1 text-2xl font-black">
                          {usage.data.overallSuccessRatePct === null ? (
                            <span className="text-base font-normal text-muted-foreground">n/a</span>
                          ) : (
                            `${usage.data.overallSuccessRatePct}%`
                          )}
                        </p>
                        {usage.data.totalFailures > 0 && (
                          <p className="text-xs text-muted-foreground">{usage.data.totalFailures} failed attempt{usage.data.totalFailures === 1 ? "" : "s"}</p>
                        )}
                      </div>
                      <div className="rounded-lg border border-border bg-muted/30 p-4">
                        <p className="text-xs uppercase text-muted-foreground">Input tokens</p>
                        <p className="mt-1 text-2xl font-black">{usage.data.totalInputTokens.toLocaleString()}</p>
                      </div>
                      <div className="rounded-lg border border-border bg-muted/30 p-4">
                        <p className="text-xs uppercase text-muted-foreground">Output tokens</p>
                        <p className="mt-1 text-2xl font-black">{usage.data.totalOutputTokens.toLocaleString()}</p>
                      </div>
                    </div>

                    {/* The agent-driven share. Shown as "X of the total", never as its own total, because
                        it is a subset — presenting it as a separate figure would invite adding the two. */}
                    <div className="rounded-lg border border-border bg-muted/20 p-4">
                      <p className="text-xs uppercase text-muted-foreground">Driven by AI teammates</p>
                      {usage.data.agentDriven.calls === 0 ? (
                        <p className="mt-1 text-sm text-muted-foreground">
                          None this month — every call above was made by a person using an AI feature directly.
                        </p>
                      ) : (
                        <p className="mt-1 text-sm">
                          <span className="text-2xl font-black">${usage.data.agentDriven.costUsd.toFixed(2)}</span>{" "}
                          <span className="text-muted-foreground">
                            of the ${usage.data.totalCostUsd.toFixed(2)} above, across {usage.data.agentDriven.calls} call
                            {usage.data.agentDriven.calls === 1 ? "" : "s"} and{" "}
                            {(usage.data.agentDriven.inputTokens + usage.data.agentDriven.outputTokens).toLocaleString()} tokens —
                            see <a className="underline" href="/app/agents">Agents</a> for which teammate.
                          </span>
                        </p>
                      )}
                    </div>

                    {/* Per-workflow spend. Read from the agent runs each flow queued rather than from the
                        usage log, which records what was asked of a model and not who composed the
                        question — said on its face, because it is a view from a different table and the
                        two will not add up to the penny. */}
                    {usage.data.byFlow.length > 0 && (
                      <div className="rounded-lg border border-border bg-muted/20 p-4">
                        <p className="text-xs uppercase text-muted-foreground">Spent by workflows</p>
                        <ul className="mt-2 space-y-1">
                          {usage.data.byFlow.map((flow) => (
                            <li key={flow.flowId} className="flex flex-wrap items-baseline gap-2 text-sm">
                              <span aria-hidden>{flow.emoji}</span>
                              <span className="font-medium">{flow.name}</span>
                              <span className="tabular-nums">${flow.costUsd.toFixed(2)}</span>
                              <span className="text-xs text-muted-foreground">
                                across {flow.runs} run{flow.runs === 1 ? "" : "s"}
                              </span>
                            </li>
                          ))}
                        </ul>
                        <p className="mt-2 text-xs text-muted-foreground">
                          Part of the teammate figure above, attributed through the runs each workflow queued — see{" "}
                          <a className="underline" href="/app/studio">
                            Workflows
                          </a>{" "}
                          for what they did.
                        </p>
                      </div>
                    )}

                    {usageTrend.data && usageTrend.data.providerNames.length > 0 && (
                      <div>
                        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Spend trend, by provider</p>
                        <div className="h-48">
                          <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={usageTrend.data.weeks} margin={{ left: -20, right: 8 }}>
                              <CartesianGrid {...GRID_STYLE} vertical={false} />
                              <XAxis dataKey="weekStart" tickFormatter={formatWeek} tick={AXIS_STYLE} axisLine={false} tickLine={false} />
                              <YAxis tick={AXIS_STYLE} axisLine={false} tickLine={false} width={56} tickFormatter={(v) => `$${v}`} />
                              <RTooltip {...TOOLTIP_STYLE} formatter={(v: number, name) => [`$${Number(v).toFixed(2)}`, name]} labelFormatter={formatWeek} />
                              {usageTrend.data.providerNames.map((provider, index) => (
                                <Bar key={provider} dataKey={provider} stackId="cost" fill={MODEL_COLORS[index % MODEL_COLORS.length]} radius={index === usageTrend.data.providerNames.length - 1 ? [4, 4, 0, 0] : undefined} />
                              ))}
                            </BarChart>
                          </ResponsiveContainer>
                        </div>
                      </div>
                    )}

                    <div>
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Provider &amp; model breakdown</p>
                      </div>
                      <DataTable
                        columns={usageColumns}
                        data={usage.data.rows}
                        isLoading={usage.isLoading}
                        searchPlaceholder="Search provider or model..."
                        emptyMessage="No AI calls in this range."
                        toolbar={
                          <div className="flex flex-wrap items-center gap-2">
                            <Select value={usageFeature || "__all"} onValueChange={(v) => setUsageFeature(v === "__all" ? "" : v)}>
                              <SelectTrigger className="w-[180px]"><SelectValue placeholder="All features" /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="__all">All features</SelectItem>
                                {usage.data.features.map((f) => (
                                  <SelectItem key={f.feature} value={f.feature}>
                                    {f.feature} ({f.calls})
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <DateRangePicker value={usageRange} onChange={setUsageRange} allowAllTime={false} className="w-auto" />
                            <AiUsageExportButton range={usageRange} feature={usageFeature} />
                          </div>
                        }
                      />
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
            {/* Directly under the total it explains: that answers "what did we spend", this answers
                "what is spending it". */}
            <div className="border-t border-border pt-4">
              <AiFeatureUsagePanel />
            </div>
          </>
        )}
      </SettingsSection>

      {/* Above quality/prompts/datasets because it answers the question people arrive at this tab
          asking once AI is on: not "how well is it doing" but "what is it allowed to do without me". */}
      <SettingsSection {...section("capabilities")}>
        <AIAutonomyCard
          readOnly={readOnly}
          aiEnabled={aiOn}
          settings={settings.data}
          onToggleFeature={(key, value) => update.mutate({ [key]: value } as never)}
        />
      </SettingsSection>

      {/* Directly under the ladder: you set how much authority a capability holds up there, and watch
          it used down here. The card only mounts when AI is on and the reader may queue a run — with
          the switch off nothing can be queued, and an empty panel would just raise questions. */}
      {!readOnly && (
        <SettingsSection {...section("runs")}>
          {aiOn ? <AgentRunsCard /> : <p className="text-sm text-muted-foreground">Turn AI on to queue a capability and watch it run.</p>}
        </SettingsSection>
      )}

      <SettingsSection {...section("quality")}>
        {aiOn ? (
          <AIQualityCard enabled={aiOn} captureOn={captureOn} />
        ) : (
          <p className="text-sm text-muted-foreground">Turn AI on, and "Record AI quality metrics", to measure how it is doing.</p>
        )}
      </SettingsSection>

      <SettingsSection {...section("prompts")}>
        <AIPromptsCard readOnly={readOnly} />
      </SettingsSection>

      <SettingsSection {...section("datasets")}>
        <AIDatasetsCard readOnly={readOnly} contentCaptureOn={Boolean(settings.data?.aiCaptureContentEnabled)} />
      </SettingsSection>

      <SettingsSection {...section("evals")}>
        <AIEvalsCard />
      </SettingsSection>
    </div>
  );
}

function aiSummary(loading: boolean, aiOn: boolean, live: number, total: number): string {
  if (loading) return "Reading the workspace…";
  if (aiOn) return `AI is on. ${live} of ${total} areas are live — pick one to open it.`;
  return "AI is off. Nothing calls a model until the master switch is on — pick an area to open it.";
}

/** The retention switches keep the shared `Switch` look; a thin alias so the row above reads as
 *  what it is rather than as a bare control. */
function ToggleSwitch({ checked, disabled, onChange }: { checked: boolean; disabled: boolean; onChange: (v: boolean) => void }) {
  return <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />;
}

/** Formats a 0–1 rate as a percentage, or an em dash when there's honestly nothing to report. */
function pct(value: number | null | undefined): string {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

/**
 * AI QUALITY — deliberately separate from the spend card above, because cost and correctness are
 * different questions and this product could previously only answer the first one.
 *
 * The ordering here is the point: parse-failure rate leads because it's objective and covers every
 * structured call, and every human-derived number is shown next to its coverage so nobody reads
 * "80% positive" from eight ratings as if it meant something.
 */
function AIQualityCard({ enabled, captureOn }: { enabled: boolean; captureOn: boolean }) {
  const quality = useQuery({
    queryKey: ["settings", "ai", "quality"],
    queryFn: () => settingsApi.getAIQualitySummary(30),
    enabled: enabled && captureOn
  });

  if (!enabled) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-4 w-4 text-primary" />
          AI quality
        </CardTitle>
        <CardDescription>
          How well the AI is actually performing, as opposed to what it costs. Last 30 days.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {!captureOn && (
          <p className="rounded-md border border-dashed border-border bg-muted/30 p-3 text-sm text-muted-foreground">
            Turn on <strong>Record AI quality metrics</strong> above to start measuring this. Until then the only thing recorded
            about your AI is what it costs.
          </p>
        )}

        {captureOn && quality.isLoading && <Skeleton className="h-32 w-full" />}

        {captureOn && quality.data && (
          <>
            {quality.data.totalInteractions === 0 && (
              <p className="text-sm text-muted-foreground">No AI calls recorded yet in this window.</p>
            )}

            {quality.data.totalInteractions > 0 && (
              <>
                <div className="grid grid-cols-2 gap-2.5 sm:gap-3 md:grid-cols-3">
                  <div className="rounded-lg border border-border bg-muted/30 p-4">
                    <p className="text-xs uppercase text-muted-foreground">Unusable responses</p>
                    <p className="mt-1 text-2xl font-black">{pct(quality.data.overallParseFailureRate)}</p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">Failed to match the expected format</p>
                  </div>
                  <div className="rounded-lg border border-border bg-muted/30 p-4">
                    <p className="text-xs uppercase text-muted-foreground">AI calls</p>
                    <p className="mt-1 text-2xl font-black">{quality.data.totalInteractions}</p>
                  </div>
                  <div className="rounded-lg border border-border bg-muted/30 p-4">
                    <p className="text-xs uppercase text-muted-foreground">Legacy ticket ratings</p>
                    <p className="mt-1 text-2xl font-black">
                      {quality.data.legacyTicketFeedback.up}/{quality.data.legacyTicketFeedback.up + quality.data.legacyTicketFeedback.down}
                    </p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">Older per-ticket thumbs, counted separately</p>
                  </div>
                </div>

                {/*
                  What people did with AI-authored change sets. This is a better signal than the
                  thumbs beside it and worth showing next to them: a rating only happens when
                  somebody chooses to leave one, whereas every reviewed proposal produces a decision
                  on every row as a by-product of ordinary work.

                  Undone is shown apart from rejected on purpose. Rejecting is "I read this and
                  disagreed"; undoing is "I let it happen and then took it back", which is worse and
                  should not be hidden inside the same number.
                */}
                {quality.data.proposalDecisions.length > 0 && (
                  <div className="rounded-lg border border-border p-4">
                    <p className="text-xs uppercase text-muted-foreground">What people did with AI suggestions</p>
                    <p className="mb-3 mt-0.5 text-[11px] text-muted-foreground">
                      Per change row, not per AI call — so these are not comparable with the numbers above. Refused means the
                      row was left alone because somebody had already changed it, which is the safeguard working rather than a
                      bad suggestion.
                    </p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {quality.data.proposalDecisions.map((d) => (
                        <div key={d.kind} className="rounded-md border border-border bg-muted/20 p-3">
                          <p className="text-xs font-medium">{d.kind.replaceAll("_", " ").toLowerCase()}</p>
                          <p className="mt-1 text-sm">
                            <span className="font-semibold text-success">{d.accepted}</span> kept ·{" "}
                            <span className="font-semibold">{d.rejected}</span> rejected ·{" "}
                            <span className="font-semibold text-warning-foreground">{d.undone}</span> undone
                            {d.refused > 0 && <span className="text-muted-foreground"> · {d.refused} refused</span>}
                          </p>
                          <p className="mt-0.5 text-[11px] text-muted-foreground">
                            {d.acceptRate === null
                              ? "Too few decisions to read a rate into yet"
                              : `${Math.round(d.acceptRate * 100)}% of decided rows were kept`}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* The honesty note. Without it, the thumbs column below invites exactly the wrong
                    conclusion. */}
                <p className="rounded-md border border-dashed border-border bg-muted/20 p-3 text-xs text-muted-foreground">
                  <strong>Unusable-response rate is the number to trust.</strong> It's measured automatically on every structured
                  call. Thumbs ratings only come from people who chose to leave one — check the coverage column before reading
                  anything into them, and note that a bad result is far likelier to get rated than a good one.
                </p>

                <div className="grid gap-1.5">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">By feature — worst first</p>
                  {/* Stacked cards below sm, table above — the same fallback DataTable uses. */}
                  <div className="grid gap-1.5 sm:hidden">
                    {quality.data.features.map((f) => (
                      <div key={f.feature} className="grid gap-1 rounded-lg border border-border bg-card p-3 text-sm shadow-sm">
                        <span className="font-medium">{f.feature}</span>
                        <span className="text-xs text-muted-foreground">
                          {f.interactions} calls · unusable {pct(f.parseFailureRate)} · rated {f.rated} ({pct(f.coverage)} coverage)
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="hidden overflow-x-auto rounded-lg border border-border sm:block">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border text-left text-xs uppercase text-muted-foreground">
                          <th className="p-2.5 font-semibold">Feature</th>
                          <th className="p-2.5 font-semibold">Calls</th>
                          <th className="p-2.5 font-semibold">Unusable</th>
                          <th className="p-2.5 font-semibold">Rated (coverage)</th>
                          <th className="p-2.5 font-semibold">Thumbs up</th>
                          <th className="p-2.5 font-semibold">Avg latency</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {quality.data.features.map((f) => (
                          <tr key={f.feature}>
                            <td className="p-2.5 font-medium">{f.feature}</td>
                            <td className="p-2.5 text-muted-foreground">{f.interactions}</td>
                            <td className="p-2.5">
                              {f.parseFailureRate == null ? (
                                <span className="text-muted-foreground">n/a</span>
                              ) : (
                                <span className={f.parseFailureRate > 0.05 ? "font-semibold text-destructive" : "text-success"}>
                                  {pct(f.parseFailureRate)}
                                </span>
                              )}
                            </td>
                            <td className="p-2.5 text-muted-foreground">
                              {f.rated} ({pct(f.coverage)})
                            </td>
                            <td className="p-2.5 text-muted-foreground">
                              {/* Suppressed below 10 ratings rather than shown as a confident-looking
                                  percentage derived from a handful of clicks. */}
                              {f.thumbsUpRate == null ? <span title="Too few ratings to be meaningful">—</span> : pct(f.thumbsUpRate)}
                            </td>
                            <td className="p-2.5 text-muted-foreground">{f.avgLatencyMs != null ? `${f.avgLatencyMs}ms` : "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
