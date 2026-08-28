/**
 * The platform operator's own AI configuration.
 *
 * SEPARATE FROM EVERY WORKSPACE'S, and the card says so where an operator will read it. Borrowing a
 * tenant's provider would spend that customer's money on another customer's problem and route one
 * workspace's operational detail through another workspace's vendor. This is the platform's key,
 * for the platform's screens, and the advisor is off until somebody sets it up.
 *
 * WHAT THE CARD HAS TO BE HONEST ABOUT, because each of these changes what an operator should do:
 *  - a self-hosted OpenAI-compatible endpoint is a first-class choice, not a fallback: an operator
 *    who will not send fleet metrics to a third party can point this at Ollama and lose nothing;
 *  - the key is write-only. The console is told whether one is set, never what it is, and leaving
 *    the field blank on an edit keeps the stored one;
 *  - there is a daily ceiling, and the number used today sits next to it, because an advisor that
 *    can be re-run in a loop is a bill with a user interface.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, Loader2, Save, ShieldCheck, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Progress } from "../../components/ui/progress";
import { Skeleton } from "../../components/ui/skeleton";
import { toast } from "../../components/ui/toaster";
import { platformOpsExtrasApi } from "../../services/platform-admin-api";
import { ConsoleSection, Field, FieldGrid, PRIMARY_BTN, SegmentedControl, SwitchField, shortDateTime } from "./console-ui";

const errorMessageOf = (error: unknown) => (error as { response?: { data?: { message?: string } } })?.response?.data?.message;

type Provider = "ANTHROPIC" | "OPENAI_COMPATIBLE";

export function AiAdvisorCard() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["platform-admin", "ai-settings"], queryFn: platformOpsExtrasApi.aiSettings });

  const [enabled, setEnabled] = useState(false);
  const [provider, setProvider] = useState<Provider>("ANTHROPIC");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("claude-sonnet-5");
  const [apiKey, setApiKey] = useState("");
  const [dailyCallLimit, setDailyCallLimit] = useState(50);

  useEffect(() => {
    if (!data) return;
    setEnabled(data.settings.enabled);
    setProvider((data.settings.provider as Provider) ?? "ANTHROPIC");
    setBaseUrl(data.settings.baseUrl ?? "");
    setModel(data.settings.model);
    setDailyCallLimit(data.settings.dailyCallLimit);
    // The key is deliberately NOT prefilled — there is nothing to prefill it with, and a masked
    // placeholder in a password field is how somebody ends up saving the mask.
  }, [data]);

  const save = useMutation({
    mutationFn: () =>
      platformOpsExtrasApi.saveAiSettings({
        enabled,
        provider,
        baseUrl: provider === "OPENAI_COMPATIBLE" ? baseUrl.trim() || null : null,
        model: model.trim(),
        // Omitted entirely when untouched, so saving an unrelated change never clears the key.
        ...(apiKey ? { apiKey } : {}),
        dailyCallLimit
      }),
    onSuccess: () => {
      toast.success("Advisor settings saved");
      setApiKey("");
      void queryClient.invalidateQueries({ queryKey: ["platform-admin", "ai-settings"] });
    },
    onError: (error) => toast.error("Not saved", { description: errorMessageOf(error) })
  });

  if (isLoading || !data) {
    return (
      <ConsoleSection title="AI advisor" description="The operator's own model configuration.">
        <Skeleton className="h-64 w-full" />
      </ConsoleSection>
    );
  }

  const usedPercent = (data.settings.usedToday / Math.max(1, data.settings.dailyCallLimit)) * 100;

  return (
    <ConsoleSection
      title="AI advisor"
      description="Reads the aggregate metrics on a workspace's monitoring page and ranks what is worth doing about them. It sees no customer data, executes nothing on its own, and every finding is a proposal an operator accepts or rejects in writing."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={data.settings.enabled ? "success" : "muted"} className="gap-1.5">
            <Brain className="h-3 w-3" />
            {data.settings.enabled ? "On" : "Off"}
          </Badge>
          <Badge variant={data.settings.apiKeySet ? "success" : "warning"}>{data.settings.apiKeySet ? "Key set" : "No key"}</Badge>
        </div>
      }
    >
      <div className="grid min-w-0 grid-cols-1 gap-4">
        <SwitchField
          label="Enable the advisor"
          hint="While this is off nothing is sent anywhere, and the Advisor tab on a workspace says so rather than failing."
          checked={enabled}
          onCheckedChange={setEnabled}
          icon={Sparkles}
        />

        <Field
          label="Provider"
          hint={
            provider === "ANTHROPIC"
              ? "Anthropic's API, with the platform's own key."
              : "Any OpenAI-compatible endpoint — including a self-hosted Ollama or LM Studio, which is the choice to make if fleet metrics must not leave your network at all."
          }
        >
          <SegmentedControl<Provider>
            ariaLabel="Advisor provider"
            value={provider}
            onChange={setProvider}
            options={[
              { value: "ANTHROPIC", label: "Anthropic" },
              { value: "OPENAI_COMPATIBLE", label: "OpenAI-compatible" }
            ]}
          />
        </Field>

        <FieldGrid cols={2}>
          <Field label="Model" htmlFor="ai-model" hint="The model id exactly as the provider names it.">
            <Input id="ai-model" value={model} onChange={(event) => setModel(event.target.value)} placeholder="claude-sonnet-5" />
          </Field>
          {provider === "OPENAI_COMPATIBLE" && (
            <Field label="Base URL" htmlFor="ai-base" hint="The whole address the advisor will call, e.g. http://localhost:11434/v1">
              <Input id="ai-base" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://…/v1" />
            </Field>
          )}
          <Field
            label={data.settings.apiKeySet ? "Replace the API key" : "API key"}
            htmlFor="ai-key"
            hint={data.settings.apiKeySet ? "A key is stored. Leave this blank to keep it; type a new one to replace it." : "Stored with AES-256-GCM and never sent back to this screen."}
          >
            <Input id="ai-key" type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={data.settings.apiKeySet ? "•••••••• (unchanged)" : "sk-…"} />
          </Field>
          <Field label="Generations per day" htmlFor="ai-limit" hint="Across the whole console, resetting at midnight UTC.">
            <Input id="ai-limit" type="number" min={1} max={1000} value={dailyCallLimit} onChange={(event) => setDailyCallLimit(Number(event.target.value))} />
          </Field>
        </FieldGrid>

        <div className="grid min-w-0 grid-cols-1 gap-1.5 rounded-lg border border-border p-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground">Used today</span>
            <span className="shrink-0 font-mono text-sm font-bold tabular-nums text-foreground">
              {data.settings.usedToday} / {data.settings.dailyCallLimit}
            </span>
          </div>
          <Progress value={Math.min(100, usedPercent)} className="h-1.5" indicatorClassName={usedPercent >= 90 ? "bg-destructive" : usedPercent >= 75 ? "bg-warning" : "bg-accent"} />
          {data.settings.updatedAt && (
            <p className="truncate text-xs text-muted-foreground">
              Last changed {shortDateTime(data.settings.updatedAt)}
              {data.settings.updatedBy ? ` by ${data.settings.updatedBy}` : ""}
            </p>
          )}
        </div>

        <div className="flex min-w-0 items-start gap-2 rounded-lg border border-border bg-muted/40 p-3">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" />
          <p className="min-w-0 text-xs text-muted-foreground">
            <span className="font-semibold text-foreground">What it is shown:</span> sizes, counts, rates, growth, the thresholds already crossed, and statement shapes with
            every literal stripped. <span className="font-semibold text-foreground">What it is never shown:</span> a row, a column value, a person, an address, or anything a
            workspace's administrator typed. Findings may only name actions from a fixed list, and the two that run anything go through the same guarded endpoint you would
            use by hand — including its refusal to rebuild a table outside a maintenance window.
          </p>
        </div>

        <div>
          <Button className={PRIMARY_BTN} disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            Save advisor settings
          </Button>
        </div>
      </div>
    </ConsoleSection>
  );
}
