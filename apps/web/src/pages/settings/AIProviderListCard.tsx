/**
 * WHAT: the ranked BYOK provider list (V9, provider-priority) — replaces the single provider/
 * baseUrl/apiKey/model form that used to live directly on the AI settings card. `callChat`
 * (ai.service.ts) tries every ENABLED row here in ascending priority order, falling through to
 * the next one on an availability failure (a rejected key, a rate limit, an empty answer) —
 * never on a real bug in the request, which would fail identically against every provider.
 *
 * WHY A SEPARATE CARD FILE: same reason AIAutonomyCard/AIDatasetsCard/AIEvalsCard are their own
 * files rather than more JSX on AISettingsCard — this is a complete, self-contained concern (its
 * own query, its own mutations, its own dialog) that would otherwise keep growing an already very
 * large function.
 *
 * WHY EDIT IS A DIALOG, NOT AN INLINE ROW FORM: each row can carry the full BYOK form (provider,
 * label, key, base URL, model — with the same "fetch available models" flow the old single-form
 * card had). Doing that inline per row would mean N independent copies of that state machine
 * mounted at once; a dialog keeps exactly one active.
 *
 * WHY ONLY THE TOP ROW'S MODEL MATTERS TO A CALLER: a fallback row was chosen for a DIFFERENT
 * vendor's catalogue and is unlikely to serve a model by the primary's name at all, so
 * `callChat` uses each fallback's own configured model instead (see ai.service.ts's header on the
 * function). Nothing in this UI needs to know that — it just lets an admin set each row's model.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { aiModels, aiProviderPresets, findNativeModel, resolveProviderLabel, type AIProvider, type NativeKvCacheType } from "@timesheet/shared";
import { AlertTriangle, ArrowDown, ArrowUp, Bolt, KeyRound, Loader2, Pencil, Plus, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import {
  settingsApi,
  type AIProviderConfigInput,
  type AIProviderConfigRow,
  type ProviderHealthStatus,
  type SuggestedProviderOrderEntry
} from "../../services/api";
import { Badge } from "../../components/ui/badge";
import { AI_PROVIDER_MARKS } from "../../components/ui/connector-marks";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { SearchableSelect } from "../../components/ui/searchable-select";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Skeleton } from "../../components/ui/skeleton";
import { Switch } from "../../components/ui/switch";
import { toast } from "../../components/ui/toaster";
import { cn } from "../../lib/utils";
import { NativeRuntimeTuningControls } from "./NativeModelRunnerCard";
import { nativeProviderRowPlan } from "../../utils/native-model-panel";

function providerDisplayName(row: Pick<AIProviderConfigRow, "provider" | "baseUrl" | "label">): string {
  return row.label?.trim() || resolveProviderLabel(row.provider, row.baseUrl);
}

function callSuffix(calls: number): string {
  return calls === 1 ? "" : "s";
}

/** "Is it working right now" — derived from the last 15 minutes of real traffic
 *  (computeRecentStatusByLabel, ai-provider-config.service.ts), refreshed every time this list
 *  loads. `unknown` isn't a problem: a freshly-added row, or one low enough in priority not to
 *  have been tried recently. */
const STATUS_CONFIG: Record<ProviderHealthStatus, { label: string; dotClassName: string }> = {
  healthy: { label: "Healthy", dotClassName: "bg-success" },
  degraded: { label: "Degraded", dotClassName: "bg-warning" },
  down: { label: "Down", dotClassName: "bg-destructive" },
  unknown: { label: "No recent data", dotClassName: "bg-muted-foreground/40" }
};

function StatusDot({ status }: { status: ProviderHealthStatus }) {
  const config = STATUS_CONFIG[status];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", config.dotClassName)} aria-hidden />
      {config.label}
    </span>
  );
}

export function AIProviderListCard({ readOnly }: { readOnly: boolean }) {
  const queryClient = useQueryClient();
  const providers = useQuery({ queryKey: ["settings", "ai", "providers"], queryFn: settingsApi.listAiProviders });
  // Same query key WorkspaceSettings.tsx's own AI tab already fetches under — shares its cache
  // rather than re-fetching, and this card is only ever mounted inside that tab.
  const globalSettings = useQuery({ queryKey: ["settings", "ai"], queryFn: settingsApi.getAI });
  const [editing, setEditing] = useState<AIProviderConfigRow | "new" | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["settings", "ai", "providers"] });

  const remove = useMutation({
    mutationFn: (id: string) => settingsApi.deleteAiProvider(id),
    onSuccess: () => {
      toast.success("Provider removed");
      void invalidate();
    },
    onError: (err: any) => toast.error("Could not remove", { description: err?.response?.data?.message ?? "Try again." })
  });
  const toggleEnabled = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => settingsApi.updateAiProvider(id, { enabled }),
    onSuccess: invalidate,
    onError: (err: any) => toast.error("Could not update", { description: err?.response?.data?.message ?? "Try again." })
  });
  const reorder = useMutation({
    mutationFn: (orderedIds: string[]) => settingsApi.reorderAiProviders(orderedIds),
    onSuccess: invalidate,
    onError: (err: any) => toast.error("Could not reorder", { description: err?.response?.data?.message ?? "Try again." })
  });
  // A RECOMMENDATION over real 30-day history, never applied on its own — the admin reviews it
  // and explicitly presses Apply, which just calls the same `reorder` mutation above with the
  // suggested id order. See ai-provider-config.service.ts#getSuggestedProviderOrder's own header
  // for why this stays a suggestion rather than something the app reorders by itself.
  const suggestion = useMutation({
    mutationFn: () => settingsApi.getSuggestedAiProviderOrder(),
    onError: (err: any) => toast.error("Could not compute a suggestion", { description: err?.response?.data?.message ?? "Try again." })
  });
  // A real, on-demand test of the row's OWN configured model — not just reachability, a tiny real
  // completion — separate from the passive status dot. Never writes consecutiveFailures/
  // autoDemotedAt, that's the circuit breaker's own concern reacting to real feature calls, not a
  // manual check run out of curiosity.
  const testProvider = useMutation({
    mutationFn: (id: string) => settingsApi.testAiProvider(id),
    onMutate: (id) => setTestingId(id),
    onSuccess: (result, id) => {
      const label = providerDisplayName(rows.find((r) => r.id === id) ?? { provider: "ANTHROPIC", baseUrl: null, label: null });
      if (result.ok) toast.success(`${label} answered`, { description: `${result.message} (${result.latencyMs}ms)` });
      else toast.error(`${label} did not answer`, { description: result.message });
    },
    onError: (err: any) => toast.error("Could not test the provider", { description: err?.response?.data?.message ?? "Try again." }),
    onSettled: () => setTestingId(null)
  });
  const autoFailover = useMutation({
    mutationFn: (enabled: boolean) => settingsApi.updateAI({ aiAutoFailoverEnabled: enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings", "ai"] }),
    onError: (err: any) => toast.error("Could not update", { description: err?.response?.data?.message ?? "Try again." })
  });

  const rows = providers.data ?? [];
  const providersUnavailable = providers.isError && !providers.data;

  /* WHY THE LIST ITSELF ASKS ABOUT THE RUNTIME. A `LLAMA_CPP` row's health is not a property of the
     row: it depends on whether a process is serving on this host right now, which no amount of
     request history explains. Without this, the list could only ever say "Down" — true, useless, and
     exactly what the screenshot showed. Fetched ONLY when such a row exists, so a workspace with no
     native provider pays nothing, and under the same cache key the runner card uses. */
  const hasNativeRow = rows.some((row) => row.provider === "LLAMA_CPP");
  const nativeRuntime = useQuery({
    queryKey: ["settings", "ai", "native", "runtime"],
    queryFn: settingsApi.getNativeAiRuntime,
    enabled: hasNativeRow
  });
  const nativeRuntimeReady = nativeRuntime.data?.state === "ready";

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= rows.length) return;
    const next = [...rows];
    [next[index], next[target]] = [next[target], next[index]];
    reorder.mutate(next.map((r) => r.id));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="h-4 w-4 text-primary" />
          AI providers
        </CardTitle>
        <CardDescription>
          Every AI feature calls the top ENABLED provider below. On a rejected key, a rate limit, or an
          empty answer, it falls through to the next one — reorder to change which is tried first.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {providers.isLoading && <Skeleton className="h-24 w-full" />}
        {providersUnavailable && (
          <Alert variant="warning">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Provider configuration could not be loaded</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center gap-2">
              <span>Retry before adding or changing a provider.</span>
              <Button size="sm" variant="outline" onClick={() => providers.refetch()}>Retry</Button>
            </AlertDescription>
          </Alert>
        )}
        {!providers.isLoading && !providers.isError && rows.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No provider configured yet — AI features use Anthropic via the server's own key, if one is set.
            Add a provider to use your own key, a different vendor, or a local model.
          </p>
        )}
        {rows.map((row, index) => (
          <div key={row.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex flex-col items-center gap-0.5">
                <button
                  type="button"
                  className="rounded p-0.5 text-muted-foreground hover:bg-muted disabled:opacity-30"
                  disabled={readOnly || index === 0 || reorder.isPending}
                  onClick={() => move(index, -1)}
                  aria-label={`Move ${providerDisplayName(row)} up in priority`}
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
                <span className="text-xs tabular-nums text-muted-foreground">{index + 1}</span>
                <button
                  type="button"
                  className="rounded p-0.5 text-muted-foreground hover:bg-muted disabled:opacity-30"
                  disabled={readOnly || index === rows.length - 1 || reorder.isPending}
                  onClick={() => move(index, 1)}
                  aria-label={`Move ${providerDisplayName(row)} down in priority`}
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 truncate text-sm font-medium">
                  {/* Which vendor this row calls, at a glance. The list is ordered by priority and
                      every row otherwise looks the same, so with a workspace running Anthropic
                      first and three OpenAI-compatible endpoints behind it, the mark is what makes
                      the order readable without parsing four hostnames. */}
                  {(() => {
                    const Mark = AI_PROVIDER_MARKS[row.provider];
                    return <Mark className="h-4 w-4 shrink-0" />;
                  })()}
                  {providerDisplayName(row)}
                  {index === 0 && row.enabled && (
                    <Badge variant="outline" className="text-xs">
                      Primary
                    </Badge>
                  )}
                  {!row.enabled && (
                    <Badge variant="outline" className="text-xs text-muted-foreground">
                      Disabled
                    </Badge>
                  )}
                  {row.autoDemotedAt && (
                    <Badge
                      variant="outline"
                      className="text-xs text-muted-foreground"
                      title="The circuit breaker moved this to the back of the line after repeated failures — reorder it yourself to clear this."
                    >
                      Auto-demoted
                    </Badge>
                  )}
                  {/* A NATIVE ROW WITH NOTHING BEHIND IT, NAMED. "Down" (from request history) says
                      calls failed; this says WHY, which is a different and far more useful fact —
                      there is no process on this host serving them. Shown whether the row is enabled
                      or not: on an enabled one it explains the failures, and on a disabled one it
                      explains why it is still off. */}
                  {row.provider === "LLAMA_CPP" && nativeRuntime.data && !nativeRuntimeReady && (
                    <Badge variant="warning" className="text-xs font-normal" title={nativeRuntime.data.detail}>
                      No local runtime
                    </Badge>
                  )}
                </p>
                <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 truncate text-xs text-muted-foreground">
                  <span>
                    {row.model} · {row.apiKeySet ? "key saved" : "no key"}
                  </span>
                  <StatusDot status={row.status} />
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={testingId === row.id}
                onClick={() => testProvider.mutate(row.id)}
                aria-label={`Test ${providerDisplayName(row)}`}
                title="Send this model a real, tiny test request right now"
              >
                {testingId === row.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Bolt className="h-3.5 w-3.5" />}
              </Button>
              <Switch
                checked={row.enabled}
                disabled={readOnly || toggleEnabled.isPending}
                onCheckedChange={(checked) => toggleEnabled.mutate({ id: row.id, enabled: checked })}
                aria-label={row.enabled ? `Disable ${providerDisplayName(row)}` : `Enable ${providerDisplayName(row)}`}
              />
              <Button
                size="sm"
                variant="ghost"
                disabled={readOnly}
                onClick={() => setEditing(row)}
                aria-label={`Edit ${providerDisplayName(row)}`}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={readOnly || remove.isPending}
                aria-label={`Remove ${providerDisplayName(row)}`}
                onClick={() => {
                  if (confirm(`Remove ${providerDisplayName(row)}? AI calls will stop trying it.`)) remove.mutate(row.id);
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        ))}
        {!providersUnavailable && <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={readOnly || providers.isLoading} onClick={() => setEditing("new")}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            Add provider
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={readOnly || rows.length < 2 || suggestion.isPending}
            onClick={() => suggestion.mutate()}
          >
            {suggestion.isPending ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="mr-1 h-3.5 w-3.5" />
            )}
            Suggest order
          </Button>
        </div>}

        {globalSettings.data && (
          <div className="flex items-start justify-between gap-3 rounded-lg border border-border p-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">Automatically move a failing provider to the back of the line</p>
              <p className="text-xs text-muted-foreground">
                After 3 failed calls in a row, that provider drops to the bottom of the list on its own — no downtime waiting
                for someone to notice and reorder it by hand. Never promotes one back up automatically; that stays a manual
                reorder (or a fresh Suggest order).
              </p>
            </div>
            <Switch
              checked={globalSettings.data.aiAutoFailoverEnabled}
              disabled={readOnly || autoFailover.isPending}
              onCheckedChange={(checked) => autoFailover.mutate(checked)}
              aria-label="Automatically move a failing provider to the back of the line"
            />
          </div>
        )}

        {suggestion.data && (
          <SuggestedOrderPanel
            data={suggestion.data}
            currentOrder={rows.map((r) => r.id)}
            applying={reorder.isPending}
            onApply={() => {
              reorder.mutate(suggestion.data!.suggestedOrderIds);
              suggestion.reset();
            }}
            onDismiss={() => suggestion.reset()}
          />
        )}
      </CardContent>
      {editing !== null && (
        <ProviderConfigDialog config={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={invalidate} />
      )}
    </Card>
  );
}

/** The reasoning behind "Suggest order" laid out plainly — ranked list, each row's real numbers,
 *  an explicit Apply. Never a single blended score: success rate, then latency, then cost is
 *  legible in a way "82.4" is not. */
function SuggestedOrderPanel({
  data,
  currentOrder,
  applying,
  onApply,
  onDismiss
}: {
  data: { suggestedOrderIds: string[]; reasoning: SuggestedProviderOrderEntry[] };
  currentOrder: string[];
  applying: boolean;
  onApply: () => void;
  onDismiss: () => void;
}) {
  const byId = new Map(data.reasoning.map((r) => [r.id, r]));
  const alreadyInOrder = data.suggestedOrderIds.length === currentOrder.length && data.suggestedOrderIds.every((id, i) => id === currentOrder[i]);

  return (
    <div className="rounded-lg border border-primary/30 bg-primary/[0.03] p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Suggested order — last 30 days</p>
      <ol className="mt-2 space-y-1.5">
        {data.suggestedOrderIds.map((id, index) => {
          const entry = byId.get(id);
          if (!entry) return null;
          return (
            <li key={id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-sm">
              <span className="font-medium">
                {index + 1}. {entry.label}
              </span>
              <span className="text-xs text-muted-foreground">
                {entry.successRatePct === null ? "no calls yet" : `${entry.successRatePct}% success · ${entry.calls} call${callSuffix(entry.calls)}`}
                {entry.avgLatencyMs !== null && ` · ${entry.avgLatencyMs.toLocaleString()} ms avg`}
                {entry.avgCostUsd !== null && ` · $${entry.avgCostUsd.toFixed(4)}/call`}
              </span>
            </li>
          );
        })}
      </ol>
      {alreadyInOrder ? (
        <p className="mt-3 text-xs text-muted-foreground">Already ranked this way.</p>
      ) : (
        <div className="mt-3 flex gap-2">
          <Button size="sm" disabled={applying} onClick={onApply}>
            {applying ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
            Apply suggested order
          </Button>
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      )}
    </div>
  );
}

/** Keeps the currently-set model selectable even if the live fetched list doesn't include it
 *  (e.g. switched endpoints since it was saved) — never silently drops what's set. */
function fetchedModelOptions(models: string[], currentModel: string): Array<{ id: string; name: string }> {
  const current = currentModel && !models.includes(currentModel) ? [{ id: currentModel, name: `${currentModel} (current)` }] : [];
  return [...current, ...models.map((m) => ({ id: m, name: m }))];
}

/**
 * Everything the native kind adds to this dialog, kept in one hook.
 *
 * WHY A HOOK RATHER THAN MORE STATE IN THE DIALOG: that function already runs one state machine
 * (preset, base URL, key, fetched-model list); a second one interleaved with it is how a component
 * stops being readable. Both queries stay OFF until the native preset is actually chosen, and both
 * use the exact cache keys NativeModelRunnerCard uses — so opening this dialog on the AI tab reads
 * what that card already fetched instead of re-probing the host.
 *
 * The "override, or the recommendation" shape is the runner card's, for the runner card's reason:
 * `?? recommended` fills the controls the instant the capability report lands, with no effect that
 * would fight an operator mid-edit on a refetch.
 */
function useNativeProviderDraft(active: boolean, config: AIProviderConfigRow | null) {
  const [context, setContext] = useState<number | null>(config?.contextWindow ?? null);
  const [threads, setThreads] = useState<string | null>(null);
  const [kvCacheType, setKvCacheType] = useState<NativeKvCacheType>("f16");

  const capability = useQuery({
    queryKey: ["settings", "ai", "native", "capability"],
    queryFn: settingsApi.getNativeAiCapability,
    enabled: active
  });
  const downloads = useQuery({
    queryKey: ["settings", "ai", "native", "downloads"],
    queryFn: settingsApi.listNativeAiDownloads,
    enabled: active
  });
  // WHETHER ANYTHING IS ACTUALLY SERVING REQUESTS, which is the question this dialog never used to
  // ask. Same cache key the runner card polls, so opening this on the AI tab reads what that card
  // already fetched rather than re-probing the host.
  const runtime = useQuery({
    queryKey: ["settings", "ai", "native", "runtime"],
    queryFn: settingsApi.getNativeAiRuntime,
    enabled: active
  });

  const estimate = capability.data?.models[0]?.estimate ?? null;
  const suggested = capability.data?.models.find((row) => row.modelId === capability.data?.suggestedModelId)?.estimate ?? null;
  const recommendedContext = suggested?.recommended.contextTokens ?? 8192;
  const recommendedThreads = estimate?.recommended.threads ?? null;

  return {
    hardware: capability.data?.hardware ?? null,
    runtime: runtime.data ?? null,
    estimate,
    recommendedContext,
    recommendedThreads,
    // Only what is actually on this machine's disk. A row naming a model nobody downloaded is a
    // provider every AI feature tries first and every one of them fails on.
    readyModels: (downloads.data ?? []).filter((row) => row.status === "ready"),
    loadingModels: downloads.isLoading,
    contextTokens: context ?? recommendedContext,
    setContext,
    threadsField: threads ?? (recommendedThreads === null ? "" : String(recommendedThreads)),
    setThreads,
    kvCacheType,
    setKvCacheType
  };
}

/**
 * Hands the three launch knobs to the runtime once a native row has been saved, and returns the
 * sentence to show for it. NEVER THROWS.
 *
 * A FAILED START MUST NOT FAIL THE SAVE. The row is already written by the time this runs, and
 * "saved, but the runtime did not start, because …" is worth more to an operator than rolling back
 * a perfectly good provider row. In `external`/`off` mode the API starts nothing and returns the
 * status unchanged — which is correct, and its own `detail` says so in words.
 */
async function applyNativeLaunch(input: {
  modelId: string;
  contextTokens: number;
  threads?: number;
  kvCacheType: NativeKvCacheType;
  parallelSlots: number;
}): Promise<string> {
  try {
    const status = await settingsApi.startNativeAiRuntime(input);
    return status.detail;
  } catch (error: any) {
    return `Saved, but the local runtime did not start: ${error?.response?.data?.message ?? "no reason given"}`;
  }
}

/**
 * The model control, which is four different controls depending on the kind: Anthropic's own
 * catalogue, the models on this machine's disk, a fetched list, or a typed name.
 *
 * ITS OWN COMPONENT WITH EARLY RETURNS rather than a four-deep ternary in the dialog's JSX — the
 * chain was already at the edge of legible with three branches, and the native kind's own empty
 * state (nothing downloaded yet) makes a fifth.
 */
function ProviderModelField({
  provider,
  model,
  onModelChange,
  fetched,
  manualEntry,
  onManualEntry,
  nativeReadyModels,
  nativeLoading
}: {
  provider: AIProvider;
  model: string;
  onModelChange: (value: string) => void;
  fetched: { ok: boolean; models: string[]; message?: string } | undefined;
  manualEntry: boolean;
  onManualEntry: () => void;
  nativeReadyModels: Array<{ modelId: string }>;
  nativeLoading: boolean;
}) {
  if (provider === "ANTHROPIC") {
    return (
      <SearchableSelect
        options={aiModels.map((m) => ({ id: m.id, name: m.label }))}
        value={model}
        onChange={onModelChange}
        placeholder="Pick a model"
        searchPlaceholder="Search models…"
        aria-label="Model"
      />
    );
  }

  if (provider === "LLAMA_CPP") {
    // An empty store is the ordinary first state, and it says what to do about it rather than
    // rendering a picker with nothing in it.
    if (nativeReadyModels.length === 0) {
      return (
        <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
          {nativeLoading
            ? "Checking what is on this machine's disk…"
            : 'No model has been downloaded on this server yet. Close this dialog and use "Run a model on this server" below the list — it shows which models fit this machine, and why.'}
        </p>
      );
    }
    return (
      <Select value={model} onValueChange={onModelChange}>
        <SelectTrigger aria-label="Model">
          <SelectValue placeholder="Pick a downloaded model" />
        </SelectTrigger>
        <SelectContent>
          {nativeReadyModels.map((row) => (
            <SelectItem key={row.modelId} value={row.modelId}>
              {findNativeModel(row.modelId)?.displayName ?? row.modelId}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  if (fetched?.ok && fetched.models.length > 0 && !manualEntry) {
    return (
      <>
        <SearchableSelect
          // A provider like OpenRouter can list hundreds of models — the plain dropdown this
          // replaced made every one of them a scroll-and-squint exercise with no way to type a name.
          options={fetchedModelOptions(fetched.models, model)}
          value={model}
          onChange={onModelChange}
          placeholder="Pick a model"
          searchPlaceholder="Search models…"
          aria-label="Model"
        />
        <button
          type="button"
          className="justify-self-start text-xs text-muted-foreground underline-offset-2 hover:underline"
          onClick={onManualEntry}
        >
          Enter manually instead
        </button>
      </>
    );
  }

  return (
    <>
      <Input value={model} placeholder="e.g. llama3.1, mixtral-8x7b, gpt-4o-mini" onChange={(e) => onModelChange(e.target.value)} />
      <p className="text-xs text-muted-foreground">
        {fetched && !fetched.ok
          ? `Couldn't fetch a model list (${fetched.message ?? "unknown error"}) — enter the exact model name.`
          : 'Exact model name as this provider expects it, or click "Fetch available models" above to pick from a list.'}
      </p>
    </>
  );
}

function ProviderConfigDialog({
  config,
  onClose,
  onSaved
}: {
  config: AIProviderConfigRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = config === null;
  // The full shared union, so an existing LLAMA_CPP row opens and saves without its kind being
  // coerced — and, since the supervisor, catalogue and downloader now exist behind it, so one can
  // be CREATED here too. The three knobs that kind needs (threads, context, KV precision) are the
  // very same component the "Run a model on this server" card renders, imported rather than copied:
  // two controls that looked alike while writing different values would be worse than one.
  const [provider, setProvider] = useState<AIProvider>(config?.provider ?? "ANTHROPIC");
  const [presetKey, setPresetKey] = useState(() => {
    if (!config || config.provider === "ANTHROPIC") return "anthropic";
    if (config.provider === "LLAMA_CPP") return "native";
    return aiProviderPresets.find((p) => p.baseUrl && p.baseUrl === config.baseUrl)?.key ?? "custom";
  });
  const [label, setLabel] = useState(config?.label ?? "");
  const [baseUrl, setBaseUrl] = useState(config?.baseUrl ?? "");
  const [model, setModel] = useState(config?.model ?? "");
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [maxConcurrent, setMaxConcurrent] = useState(String(config?.maxConcurrent ?? 2));
  const [manualModelEntry, setManualModelEntry] = useState(true);

  const isNative = provider === "LLAMA_CPP";
  const native = useNativeProviderDraft(isNative, config);

  /**
   * WHAT THIS CLICK WILL ACTUALLY DO TO THE ROW'S `enabled`, decided before the click and stated
   * beside the button.
   *
   * THE BUG THIS CLOSES: the runner card's promote button is disabled until something is serving
   * requests; this dialog had no such check, so a `LLAMA_CPP` row could be created with no runtime
   * behind it. A native row belongs at the TOP of the priority order, so it landed there and became
   * the first provider every AI feature tried and the first one every AI feature failed on —
   * "Native (llama.cpp) · Primary · Down", with the fallback quietly doing the work.
   *
   * The decision itself lives in `nativeProviderRowPlan` (utils/native-model-panel.ts), shared with
   * the runner card so the two surfaces cannot come to describe this differently, and tested there.
   */
  const nativePlan = nativeProviderRowPlan({
    isNew,
    requestedEnabled: config?.enabled ?? true,
    runtime: native.runtime
  });

  /* THE BUTTON SAYS WHAT IT WILL DO. "Add it disabled" rather than "Add", because the label is the
     last thing read before the click and a button that says one word while doing another is exactly
     the silent behaviour change this fix exists to remove. Written as a statement rather than a
     ternary chain in the JSX — three outcomes deep is where a chain stops being readable. */
  let saveButtonLabel = isNew ? "Add" : "Save";
  if (isNative && nativePlan.heldBack) saveButtonLabel = "Add it disabled";

  function selectPreset(key: string) {
    setPresetKey(key);
    if (key === "anthropic") {
      setProvider("ANTHROPIC");
      setBaseUrl("");
    } else if (key === "native") {
      // The endpoint here is NOT the admin's to give — config/native-ai.ts derives it and the write
      // path discards whatever arrives — so the field is not rendered at all rather than rendered
      // and quietly ignored. Same for the key: a process on loopback has none.
      setProvider("LLAMA_CPP");
      setBaseUrl("");
      setModel("");
      // llama.cpp serves one request per slot; a higher ceiling just recreates the unbounded
      // queueing `maxConcurrent` exists to prevent.
      setMaxConcurrent("1");
    } else {
      setProvider("OPENAI_COMPATIBLE");
      setBaseUrl(aiProviderPresets.find((p) => p.key === key)?.baseUrl ?? "");
    }
    setManualModelEntry(true);
  }

  const fetchModels = useMutation({
    mutationFn: () => settingsApi.fetchAvailableAiModels({ baseUrl: baseUrl || undefined, apiKey: apiKeyDraft || undefined }),
    onSuccess: (result) => {
      if (!result.ok || result.models.length === 0) {
        toast.error("Could not fetch models", { description: result.message ?? "Enter the model name manually instead." });
        setManualModelEntry(true);
      } else {
        setManualModelEntry(false);
      }
    },
    onError: (err: any) => {
      toast.error("Could not fetch models", { description: err?.response?.data?.message ?? "Try again, or enter the model name manually." });
      setManualModelEntry(true);
    }
  });

  const save = useMutation({
    mutationFn: async () => {
      const slots = Math.min(64, Math.max(1, Number(maxConcurrent) || 2));
      const payload: Partial<AIProviderConfigInput> = {
        provider,
        label: label.trim() || null,
        baseUrl: provider === "OPENAI_COMPATIBLE" ? baseUrl : null,
        model,
        // Clamped to the same 1-64 the API enforces, so a typo can't send an obviously-wrong
        // ceiling and get a 422 back instead of a saved provider.
        maxConcurrent: slots
      };
      // The context an operator picked below is what the row DECLARES, so the dispatcher's demand
      // filter and the process actually serving the call agree about the window.
      if (isNative) {
        payload.contextWindow = native.contextTokens;
        // CREATED DISABLED WHEN THERE IS NO RUNTIME. Only ever on creation, and only ever after the
        // dialog has said so in words — see `nativePlan` above. An existing row's enabled state is
        // an administrator's earlier explicit decision and this dialog does not overrule it.
        if (nativePlan.heldBack) payload.enabled = false;
      }
      if (apiKeyDraft) payload.apiKey = apiKeyDraft;
      const saved = isNew
        ? await settingsApi.createAiProvider(payload as AIProviderConfigInput)
        : await settingsApi.updateAiProvider(config!.id, payload);

      // THE THREE KNOBS ARE APPLIED, NOT MERELY COLLECTED. Threads and KV precision are launch
      // arguments for `llama-server` and live nowhere on a provider row, so a dialog that showed all
      // three and stored only the context would be three controls where one works.
      const threadCount = Number(native.threadsField);
      let runtimeNote: string | null = null;
      if (isNative) {
        runtimeNote = await applyNativeLaunch({
          modelId: model,
          contextTokens: native.contextTokens,
          threads: threadCount > 0 ? threadCount : undefined,
          kvCacheType: native.kvCacheType,
          parallelSlots: slots
        });
      }
      return { saved, runtimeNote };
    },
    onSuccess: ({ runtimeNote }) => {
      // THE SAME SENTENCE AFTER THE CLICK AS BEFORE IT. A row that was quietly created disabled is
      // exactly the silent behaviour change this fix exists to avoid, so the plan's warning outranks
      // the runtime note in the toast — the operator's next question is "why is it off?", not "what
      // did the launch say".
      const description = nativePlan.warning ?? runtimeNote;
      toast.success(isNew ? "Provider added" : "Provider updated", description ? { description } : undefined);
      onSaved();
      onClose();
    },
    onError: (err: any) => toast.error("Could not save", { description: err?.response?.data?.message ?? "Try again." })
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isNew ? "Add provider" : "Edit provider"}</DialogTitle>
          <DialogDescription>
            Every non-Anthropic option talks to the same OpenAI-compatible chat API — pick a preset to fill in its
            base URL, or "Custom endpoint" for anything else that speaks that protocol. "Local model on this server" is
            the one kind with no endpoint and no key: it points at a model running on this machine's own CPU.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label>Provider</Label>
            <Select value={presetKey} onValueChange={selectPreset}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="anthropic">Anthropic</SelectItem>
                <SelectItem value="native">Local model on this server (llama.cpp)</SelectItem>
                {aiProviderPresets.map((p) => (
                  <SelectItem key={p.key} value={p.key}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>Label (optional)</Label>
            <Input value={label} placeholder="e.g. Groq (fast, cheap)" onChange={(e) => setLabel(e.target.value)} />
          </div>
          {provider === "OPENAI_COMPATIBLE" && (
            <div className="grid gap-1.5">
              <Label>Base URL</Label>
              <Input value={baseUrl} placeholder="https://api.example.com/v1" onChange={(e) => setBaseUrl(e.target.value)} />
            </div>
          )}
          {/* No key field for the native kind, and not merely as tidiness: the process is on this
              host's loopback, there is nothing to authenticate to, and an empty password box would
              read as a setting somebody forgot rather than one that does not exist. */}
          {!isNative && (
            <div className="grid gap-1.5">
              <Label>
                API key{" "}
                {config?.apiKeySet && <span className="font-normal text-muted-foreground">(saved — leave blank to keep it)</span>}
              </Label>
              <Input
                type="password"
                placeholder={config?.apiKeySet ? "•••••••••••••••• (unchanged)" : "Not set"}
                value={apiKeyDraft}
                onChange={(e) => setApiKeyDraft(e.target.value)}
              />
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="provider-max-concurrent">Concurrent calls</Label>
            <Input
              id="provider-max-concurrent"
              type="number"
              min={1}
              max={64}
              value={maxConcurrent}
              onChange={(e) => setMaxConcurrent(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              How many requests may run against this provider at once. Anything beyond it waits briefly, then falls over to the next
              provider — which is what stops a busy provider from silently queueing everyone.{" "}
              {isNative ? (
                <>
                  For a local model, 1 is almost always right: llama.cpp serves one request per slot, and every extra slot divides
                  the same CPU and adds its own KV cache to the memory bill. This number is also what the runtime is started with.
                </>
              ) : (
                <>
                  For a self-hosted Ollama, match <code className="rounded bg-muted px-1 py-0.5 text-[11px]">OLLAMA_NUM_PARALLEL</code>;
                  a hosted API can go much higher.
                </>
              )}
            </p>
          </div>
          <div className="grid gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label>Model</Label>
              {provider === "OPENAI_COMPATIBLE" && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  disabled={fetchModels.isPending || !baseUrl.trim()}
                  onClick={() => fetchModels.mutate()}
                >
                  <RefreshCw className={`mr-1 h-3 w-3 ${fetchModels.isPending ? "animate-spin" : ""}`} />
                  {fetchModels.isPending ? "Fetching…" : "Fetch available models"}
                </Button>
              )}
            </div>
            <ProviderModelField
              provider={provider}
              model={model}
              onModelChange={setModel}
              fetched={fetchModels.data}
              manualEntry={manualModelEntry}
              onManualEntry={() => setManualModelEntry(true)}
              nativeReadyModels={native.readyModels}
              nativeLoading={native.loadingModels}
            />
          </div>

          {/* The same three controls the runner card renders, from the same component. Saving
              applies them: the context is stored on the row, and all three are handed to the
              runtime as launch arguments. */}
          {isNative && native.hardware && (
            <div className="grid gap-4 rounded-lg border border-border p-3">
              <p className="text-xs text-muted-foreground">
                Saving also (re)starts the local runtime with these settings. In <code className="rounded bg-muted px-1 py-0.5 text-[11px]">external</code>{" "}
                mode a sidecar owns that process, so they are recorded and nothing here is restarted.
              </p>
              <NativeRuntimeTuningControls
                idPrefix="provider-native"
                disabled={false}
                hardware={native.hardware}
                recommendedThreads={native.recommendedThreads}
                threadsBasis={native.estimate?.recommended.threadsBasis ?? null}
                threads={native.threadsField}
                onThreadsChange={native.setThreads}
                contextTokens={native.contextTokens}
                recommendedContext={native.recommendedContext}
                onContextChange={native.setContext}
                kvCacheType={native.kvCacheType}
                onKvCacheTypeChange={native.setKvCacheType}
                model={findNativeModel(model) ?? null}
              />
            </div>
          )}

          {/* AT THE MOMENT OF THE CLICK, not in a toast afterwards. This sits directly above the
              button so an operator reads what the button is about to do while their pointer is on
              the way to it — a native row with nothing behind it going in enabled is the failure
              being prevented, and doing it silently would be the same failure in a quieter coat. */}
          {isNative && nativePlan.warning && (
            <div className="rounded-lg border border-warning/40 bg-warning/10 p-3">
              <p className="text-xs text-foreground">{nativePlan.warning}</p>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!model.trim() || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : saveButtonLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
