import { useQuery } from "@tanstack/react-query";
import { permissions } from "@timesheet/shared";
import {
  ArrowRight,
  BarChart3,
  BrainCircuit,
  CalendarClock,
  CheckCircle2,
  CircleAlert,
  ClipboardList,
  Clock3,
  FileClock,
  Gauge,
  Settings,
  Sparkles,
  Workflow
} from "lucide-react";
import { Link } from "react-router";
import { PageHeader } from "../components/PageHeader";
import { AiReportBuilder } from "../components/AiReportBuilder";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Skeleton } from "../components/ui/skeleton";
import { inboxApi, planApi, copilotApi, settingsApi, askAiApi, type AiAskExchangeRow, type SuggestedProviderOrderEntry } from "../services/api";
import { useAuthStore } from "../store/auth";
import { cn } from "../lib/utils";
import { runInBackground } from "../lib/run-in-background";

const askHref = (prompt: string) => `/app/ask-ai?prompt=${encodeURIComponent(prompt)}`;

function attentionHeading(count: number) {
  if (count === 0) return "The day is clear";
  if (count === 1) return "1 area needs you";
  return `${count} areas need you`;
}

function aiReadiness(aiEnabled: boolean, enabledProviderCount: number, topProvider?: SuggestedProviderOrderEntry) {
  const switchAdvice = aiEnabled ? "AI master switch is on." : "Turn on AI only after a provider or native model is ready.";
  let providerStatus = "No enabled provider is visible; configure one or use the native model runner.";
  if (enabledProviderCount === 1) providerStatus = "1 provider is enabled; no additional provider is available for failover.";
  if (enabledProviderCount > 1) providerStatus = `${enabledProviderCount} providers are enabled for failover.`;

  let providerAdvice: string | null = null;
  if (topProvider?.successRatePct === null) providerAdvice = `${topProvider.label} currently ranks first, with no measured calls yet.`;
  if (topProvider?.successRatePct != null) providerAdvice = `${topProvider.label} currently ranks first at ${topProvider.successRatePct}% success.`;
  return { switchAdvice, providerStatus, providerAdvice };
}

function RetryHint({ error, label, onRetry }: { error: boolean; label: string; onRetry: () => unknown }) {
  if (!error) return null;
  return <Button variant="outline" size="sm" onClick={() => { onRetry(); }}>{label}</Button>;
}

const ASSISTED_ACTIONS = [
  { title: "Build a report", detail: "Describe the result, grouping and period. Ask AI can return a table or chart.", icon: BarChart3, prompt: "Build a concise report of my work this month, grouped by project, with a chart and the three most important observations." },
  { title: "Draft missing time", detail: "Create a private draft from work already recorded. You review before submitting.", icon: FileClock, prompt: "Find my recent work that may be missing from my timesheet and prepare a draft timesheet entry for me to review. Do not submit it." },
  { title: "Explain delivery risk", detail: "Read measured risk signals and explain what changed without altering the score.", icon: Gauge, prompt: "Which projects are most at risk right now, what measured signals drive each score, and what should be investigated first?" },
  { title: "Design a workflow", detail: "Turn an outcome into a reviewable trigger, conditions, actions and human gates.", icon: Workflow, prompt: "Help me design a TimeSphere workflow. Ask me for the outcome, trigger, conditions, actions and required human approvals, then produce a reviewable step-by-step design." }
];

/* ── The three status ladders this page reads from its queries ────────────────────────────────
   Each answers the same question in a different currency: what do we say when the data has not
   arrived, when it failed, and when it is genuinely empty? They are pure and named rather than
   inline, because three `let` + `if` ladders in the component body carried it past the
   cognitive-complexity ceiling — and because "unavailable" and "not measured" mean different
   things to a reader and must not be allowed to drift into each other. */

/** A daily brief that failed to load says so; it never reports a confident zero. */
function attentionStatus(brief: { isError: boolean; isSuccess: boolean }, count: number): string {
  if (brief.isError) return "Daily brief unavailable";
  if (brief.isSuccess) return attentionHeading(count);
  return "Loading daily brief";
}

/**
 * "Unavailable" (we could not ask), "Not measured" (we asked and nothing is scored yet), or the
 * count. The middle case is the one that matters: a risk tile showing 0 because no project has
 * ever been scored is the same picture as one showing 0 because everything is healthy.
 */
function riskStatus(loaded: boolean, rowCount: number, elevated: number): number | string {
  if (!loaded) return "Unavailable";
  return rowCount > 0 ? elevated : "Not measured";
}

/** Configuration is only "needs configuration" once we have actually read the configuration. */
function configurationLabel(failed: boolean, known: boolean, ready: boolean): string {
  if (failed) return "Configuration unavailable";
  if (!known) return "Loading configuration";
  return ready ? "Configured, health not verified" : "Needs configuration";
}

export function IntelligenceCenterPage() {
  const user = useAuthStore((state) => state.user);
  const canSeeRisk = Boolean(user?.permissions.includes(permissions.REPORTS_VIEW));
  const isSuperAdmin = user?.role === "SUPER_ADMIN";
  const canAsk = Boolean(user?.permissions.includes(permissions.TICKETS_VIEW));

  const brief = useQuery({ queryKey: ["inbox", "brief"], queryFn: inboxApi.brief, staleTime: 60_000 });
  const work = useQuery({ queryKey: ["plan", "my-work"], queryFn: planApi.myWork, staleTime: 30_000 });
  const memory = useQuery({ queryKey: ["ask-ai", "history", "intelligence-center", user?.id, user?.role], queryFn: () => askAiApi.history(4), enabled: canAsk, staleTime: 30_000 });
  const risks = useQuery({ queryKey: ["ai-proposals", "risk", "snapshots"], queryFn: copilotApi.riskSnapshots, enabled: canSeeRisk, retry: false });
  const aiSettings = useQuery({ queryKey: ["settings", "ai"], queryFn: settingsApi.getAI, enabled: isSuperAdmin });
  const providers = useQuery({ queryKey: ["settings", "ai", "providers"], queryFn: settingsApi.listAiProviders, enabled: isSuperAdmin });
  const suggestedOrder = useQuery({ queryKey: ["settings", "ai", "providers", "suggested-order"], queryFn: settingsApi.getSuggestedAiProviderOrder, enabled: isSuperAdmin && (providers.data?.length ?? 0) > 1, retry: false });

  const attention = brief.data?.sections.filter((section) => section.tone === "attention" && section.count > 0) ?? [];
  const workCount = work.data?.counts.total ?? 0;
  const blockedCount = work.data?.counts.blocked ?? 0;
  const riskRows = risks.data ?? [];
  const elevatedRisk = riskRows.filter((row) => row.band === "AMBER" || row.band === "RED").length;
  const enabledProviders = (providers.data ?? []).filter((provider) => provider.enabled);
  const aiReady = Boolean(aiSettings.data?.aiEnabled && (aiSettings.data.apiKeyConfigured || enabledProviders.length > 0));
  const attentionTitle = attentionStatus(brief, attention.length);
  const riskValue = riskStatus(risks.isSuccess, riskRows.length, elevatedRisk);
  const riskHref = canSeeRisk ? "/app/portfolio" : "/app/insights";
  const topProvider = suggestedOrder.data?.reasoning.find((provider) => provider.id === suggestedOrder.data?.suggestedOrderIds[0]);
  const readiness = aiReadiness(Boolean(aiSettings.data?.aiEnabled), enabledProviders.length, topProvider);
  const configurationKnown = aiSettings.isSuccess && providers.isSuccess;
  const configurationStatus = configurationLabel(aiSettings.isError || providers.isError, configurationKnown, aiReady);
  const actions = ASSISTED_ACTIONS.filter((action) => action.icon !== Gauge || canSeeRisk);

  return (
    <div className="grid gap-5">
      <PageHeader
        title="Intelligence center"
        icon={BrainCircuit}
        description="One adaptive view of what needs attention, what AI can prepare, and what remains under your control."
        actions={canAsk && <><AiReportBuilder /><Button asChild variant="outline"><Link to="/app/ask-ai"><Sparkles className="h-4 w-4" />Ask anything</Link></Button></>}
      />

      <section className="overflow-hidden rounded-md border border-border bg-card shadow-xs" aria-labelledby="attention-title">
        <div className={cn("grid", canSeeRisk ? "lg:grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,.65fr))]" : "lg:grid-cols-[minmax(0,1.4fr)_repeat(2,minmax(0,.65fr))]")}>
          <div className="relative min-h-[126px] border-b border-border p-5 lg:border-b-0 lg:border-r">
            <span className="absolute inset-y-0 left-0 w-1 bg-primary" aria-hidden />
            <p className="text-xs font-semibold uppercase text-primary">Attention stream</p>
            <h2 id="attention-title" className="mt-1 text-lg font-semibold">
              {attentionTitle}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {brief.isSuccess && (attention[0]?.detail ?? "No overdue brief items are visible in your current scope.")}
              <RetryHint error={brief.isError} label="Retry daily brief" onRetry={brief.refetch} />
              <RetryHint error={work.isError} label="Retry work summary" onRetry={work.refetch} />
              <RetryHint error={risks.isError} label="Retry risk summary" onRetry={risks.refetch} />
            </p>
          </div>
          <Signal label="Open work" value={work.isSuccess ? workCount : "Unavailable"} icon={ClipboardList} href="/app/my-work" />
          <Signal label="Blocked" value={work.isSuccess ? blockedCount : "Unavailable"} icon={CircleAlert} href="/app/my-work" attention={blockedCount > 0} />
          {canSeeRisk && <Signal label="Elevated risk" value={riskValue} icon={Gauge} href={riskHref} attention={elevatedRisk > 0} />}
        </div>
      </section>

      {canAsk && <section aria-labelledby="next-actions-title" className="grid gap-3">
        <div>
          <h2 id="next-actions-title" className="text-base font-semibold">AI-assisted work</h2>
          <p className="text-sm text-muted-foreground">Every action opens as a question or draft. Nothing publishes automatically.</p>
        </div>
        <div className={cn("grid gap-3 sm:grid-cols-2", canSeeRisk ? "xl:grid-cols-4" : "xl:grid-cols-3")}>
          {actions.map((action) => (
            <Card key={action.title} className="group flex h-full flex-col transition hover:border-primary/40 hover:shadow-md">
              <CardHeader className="pb-2">
                <span className="mb-2 flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary"><action.icon className="h-4 w-4" /></span>
                <CardTitle className="text-sm">{action.title}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col justify-between gap-4">
                <p className="text-xs leading-5 text-muted-foreground">{action.detail}</p>
                <Link to={askHref(action.prompt)} aria-label={`Start with AI: ${action.title}`} className="focus-ring flex min-h-[44px] items-center gap-1.5 rounded-md text-xs font-semibold text-primary">
                  Start with AI <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                </Link>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>}

      <div className={cn("grid gap-4", canAsk && "xl:grid-cols-2")}>
        <section aria-labelledby="brief-title" className="rounded-md border border-border bg-card p-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div><h2 id="brief-title" className="font-semibold">Daily brief</h2><p className="text-xs text-muted-foreground">Deterministic counts, linked to their source.</p></div>
            <Button asChild size="sm" variant="outline"><Link to="/app/inbox">Open inbox</Link></Button>
          </div>
          {brief.isLoading ? <Skeleton className="h-32 w-full" /> : (
            <div className="grid gap-2">
              {brief.isError && <p role="status" className="text-sm text-muted-foreground">Daily brief unavailable. Retry from the attention stream above.</p>}
              {(brief.data?.sections ?? []).map((section) => (
                <Link key={section.key} to={section.link ?? "/app/inbox"} className="focus-ring flex min-h-[44px] items-center gap-3 rounded-md px-2 transition hover:bg-muted">
                  {section.tone === "attention" ? <CalendarClock className="h-4 w-4 text-warning-foreground" /> : <CheckCircle2 className="h-4 w-4 text-success" />}
                  <span className="min-w-0 flex-1 truncate text-sm">{section.label}</span>
                  <Badge variant={section.tone === "attention" ? "warning" : "secondary"}>{section.count}</Badge>
                </Link>
              ))}
            </div>
          )}
        </section>

        {canAsk && <section aria-labelledby="memory-title" className="rounded-md border border-border bg-card p-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div><h2 id="memory-title" className="font-semibold">Recent AI context</h2><p className="text-xs text-muted-foreground">Continue questions already in your private history.</p></div>
            <Button asChild size="sm" variant="outline"><Link to="/app/ask-ai">Full history</Link></Button>
          </div>
          {memory.isError ? <Button variant="outline" onClick={() => memory.refetch()}>Retry AI history</Button> : <MemoryRows loading={memory.isLoading} rows={memory.data ?? []} />}
        </section>}
      </div>

      {isSuperAdmin && (
        <section aria-labelledby="readiness-title" className="rounded-md border border-border bg-card p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 id="readiness-title" className="font-semibold">AI readiness advisor</h2>
              <p className="mt-1 text-sm text-muted-foreground">Configuration guidance from current providers, budget controls and measured routing.</p>
            </div>
            <Button asChild size="sm" variant="outline"><Link to="/app/settings?tab=ai"><Settings className="h-4 w-4" />AI settings</Link></Button>
          </div>
          <div className="mt-4 grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <div>
              <div className="grid gap-1 text-sm"><span>Configuration status</span><strong>{configurationStatus}</strong>
                <RetryHint error={aiSettings.isError || providers.isError} label="Retry AI settings" onRetry={() => { runInBackground(aiSettings.refetch()); runInBackground(providers.refetch()); }} />
              </div>
            </div>
            <div className="grid gap-1 text-sm text-muted-foreground">
              {configurationKnown && <><p>{readiness.switchAdvice}</p><p>{readiness.providerStatus}</p></>}
              {readiness.providerAdvice && <p>Routing advisor: {readiness.providerAdvice}</p>}
              {suggestedOrder.isError && <p role="status">Provider routing recommendation unavailable. <button type="button" className="focus-ring rounded-sm text-primary underline" onClick={() => { runInBackground(suggestedOrder.refetch()); }}>Retry</button></p>}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

function MemoryRows({ loading, rows }: { loading: boolean; rows: AiAskExchangeRow[] }) {
  if (loading) return <Skeleton className="h-32 w-full" />;
  if (rows.length === 0) return <p className="py-8 text-center text-sm text-muted-foreground">Your recent questions will appear here.</p>;
  return (
    <div className="grid gap-2">
      {rows.slice(0, 4).map((row) => (
        <Link key={row.id} to={askHref(`Continue this earlier question with the latest workspace data: ${row.prompt}`)} className="focus-ring group flex min-h-[44px] items-center gap-3 rounded-md px-2 transition hover:bg-muted">
          <Clock3 className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-sm">{row.prompt}</span>
          <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
        </Link>
      ))}
    </div>
  );
}

function Signal({ label, value, icon: Icon, href, attention = false }: { label: string; value: number | string; icon: typeof ClipboardList; href: string; attention?: boolean }) {
  return (
    <Link to={href} className="focus-ring group flex min-h-[92px] items-center gap-3 border-b border-border p-4 transition hover:bg-muted/50 last:border-b-0 lg:min-h-[126px] lg:border-b-0 lg:border-r lg:last:border-r-0">
      <span className={cn("flex h-9 w-9 items-center justify-center rounded-md", attention ? "bg-warning/10 text-warning-ink-foreground" : "bg-primary/10 text-primary")}><Icon className="h-4 w-4" /></span>
      <span><strong className="block text-xl tabular-nums">{value}</strong><span className="text-xs text-muted-foreground">{label}</span></span>
      <ArrowRight className="ml-auto h-4 w-4 text-muted-foreground opacity-0 transition group-hover:translate-x-0.5 group-hover:opacity-100 group-focus-visible:opacity-100" />
    </Link>
  );
}
