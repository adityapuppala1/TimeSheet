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
import { aiModels, aiProviderPresets, resolveProviderLabel } from "@timesheet/shared";
import { ArrowDown, ArrowUp, KeyRound, Loader2, Pencil, Plus, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { settingsApi, type AIProviderConfigInput, type AIProviderConfigRow, type SuggestedProviderOrderEntry } from "../../services/api";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Skeleton } from "../../components/ui/skeleton";
import { Switch } from "../../components/ui/switch";
import { toast } from "../../components/ui/toaster";

function providerDisplayName(row: Pick<AIProviderConfigRow, "provider" | "baseUrl" | "label">): string {
  return row.label?.trim() || resolveProviderLabel(row.provider, row.baseUrl);
}

function callSuffix(calls: number): string {
  return calls === 1 ? "" : "s";
}

export function AIProviderListCard({ readOnly }: { readOnly: boolean }) {
  const queryClient = useQueryClient();
  const providers = useQuery({ queryKey: ["settings", "ai", "providers"], queryFn: settingsApi.listAiProviders });
  const [editing, setEditing] = useState<AIProviderConfigRow | "new" | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["settings", "ai", "providers"] });

  const remove = useMutation({
    mutationFn: (id: string) => settingsApi.deleteAiProvider(id),
    onSuccess: () => {
      toast.success("Provider removed");
      invalidate();
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

  const rows = providers.data ?? [];

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
        {!providers.isLoading && rows.length === 0 && (
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
                <p className="flex items-center gap-2 truncate text-sm font-medium">
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
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {row.model} · {row.apiKeySet ? "key saved" : "no key"}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
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
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={readOnly} onClick={() => setEditing("new")}>
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
        </div>

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
  const [provider, setProvider] = useState<"ANTHROPIC" | "OPENAI_COMPATIBLE">(config?.provider ?? "ANTHROPIC");
  const [presetKey, setPresetKey] = useState(() => {
    if (!config || config.provider === "ANTHROPIC") return "anthropic";
    return aiProviderPresets.find((p) => p.baseUrl && p.baseUrl === config.baseUrl)?.key ?? "custom";
  });
  const [label, setLabel] = useState(config?.label ?? "");
  const [baseUrl, setBaseUrl] = useState(config?.baseUrl ?? "");
  const [model, setModel] = useState(config?.model ?? "");
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [manualModelEntry, setManualModelEntry] = useState(true);

  function selectPreset(key: string) {
    setPresetKey(key);
    if (key === "anthropic") {
      setProvider("ANTHROPIC");
      setBaseUrl("");
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
    mutationFn: () => {
      const payload: Partial<AIProviderConfigInput> = {
        provider,
        label: label.trim() || null,
        baseUrl: provider === "OPENAI_COMPATIBLE" ? baseUrl : null,
        model
      };
      if (apiKeyDraft) payload.apiKey = apiKeyDraft;
      return isNew ? settingsApi.createAiProvider(payload as AIProviderConfigInput) : settingsApi.updateAiProvider(config!.id, payload);
    },
    onSuccess: () => {
      toast.success(isNew ? "Provider added" : "Provider updated");
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
            base URL, or "Custom endpoint" for anything else that speaks that protocol.
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
            {provider === "ANTHROPIC" ? (
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger>
                  <SelectValue placeholder="Pick a model" />
                </SelectTrigger>
                <SelectContent>
                  {aiModels.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : fetchModels.data?.ok && fetchModels.data.models.length > 0 && !manualModelEntry ? (
              <>
                <Select value={model} onValueChange={setModel}>
                  <SelectTrigger>
                    <SelectValue placeholder="Pick a model" />
                  </SelectTrigger>
                  <SelectContent>
                    {/* Keeps the currently-set model selectable even if the live list doesn't
                        include it (e.g. switched endpoints) — never silently drops what's set. */}
                    {model && !fetchModels.data.models.includes(model) && (
                      <SelectItem value={model}>{model} (current)</SelectItem>
                    )}
                    {fetchModels.data.models.map((m) => (
                      <SelectItem key={m} value={m}>
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <button
                  type="button"
                  className="justify-self-start text-xs text-muted-foreground underline-offset-2 hover:underline"
                  onClick={() => setManualModelEntry(true)}
                >
                  Enter manually instead
                </button>
              </>
            ) : (
              <>
                <Input value={model} placeholder="e.g. llama3.1, mixtral-8x7b, gpt-4o-mini" onChange={(e) => setModel(e.target.value)} />
                <p className="text-xs text-muted-foreground">
                  {fetchModels.data && !fetchModels.data.ok
                    ? `Couldn't fetch a model list (${fetchModels.data.message ?? "unknown error"}) — enter the exact model name.`
                    : 'Exact model name as this provider expects it, or click "Fetch available models" above to pick from a list.'}
                </p>
              </>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!model.trim() || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : isNew ? "Add" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
