/**
 * The map of the AI in this workspace — the one screen that says how the other four relate.
 *
 * WHY IT EXISTS: AI suggestions, Agents, Workflows and the AI settings tab each grew coherent on their
 * own, and together they were four siblings with no statement of the relationship between them. The
 * commonest consequence is a workspace where capabilities are enabled, a teammate owns them, a flow
 * composes them, and nothing has been switched on — because each screen assumed another had said so.
 *
 * WHY IT IS A MAP AND NOT A DASHBOARD: the numbers here exist to make each card's link worth following,
 * not to be watched. So each one is a COUNT that can be checked against the screen it came from — no
 * score, no gauge, no health percentage, because a score needs a rule for what healthy is and the honest
 * answer is that it depends on what this workspace wants.
 *
 * WHY ONE "NEXT STEP" AND NOT A CHECKLIST: a list of five suggestions is a list nobody acts on. The
 * server picks the single most blocking thing, ordered by what blocks what.
 *
 * WHO renders this: `App.tsx` at `/app/ai`, super-admin only — it is the orientation surface for the
 * person who configures all four, and it reports spend.
 */
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Bot, Lightbulb, PowerOff, Scale, Settings2, Sparkles, Workflow } from "lucide-react";
import { Link } from "react-router";
import { Badge } from "../components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Skeleton } from "../components/ui/skeleton";
import { StatCard } from "../components/ui/stat-card";
import { cn } from "../lib/utils";
import { aiOverviewApi, type AiOverview } from "../services/api";

const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * The four surfaces, in the order the work actually flows: a capability is switched on, a teammate owns
 * it, a workflow composes it, and what comes out is reviewed. Written as a sequence because that is the
 * relationship nobody could see.
 */
function surfaces(data: AiOverview) {
  return [
    {
      key: "settings",
      to: "/app/settings?tab=ai",
      icon: Settings2,
      title: "1. What the AI may do",
      blurb:
        "Every capability, and how much authority each one has: propose only, apply its own changes, or run unattended. The ceiling is in code and an administrator may only lower it.",
      facts: [
        `${data.capabilities.total} capabilities`,
        `${data.capabilities.aboveSuggest} may change things without asking`,
        `${usd(data.spend.monthToDateUsd)} spent this month`
      ]
    },
    {
      key: "agents",
      to: "/app/agents",
      icon: Bot,
      title: "2. Who does it",
      blurb:
        "AI teammates own capabilities — one capability, one owner, so two of them can never quietly do the same job. A teammate holds no seat, cannot sign in, and has no mailbox.",
      facts: [
        `${data.agents.enabled} of ${data.agents.total} switched on`,
        data.capabilities.unowned > 0 ? `${data.capabilities.unowned} capabilities nobody owns` : "every capability has an owner",
        `${usd(data.spend.agentDrivenUsd)} of this month's spend was theirs`
      ]
    },
    {
      key: "flows",
      to: "/app/studio",
      icon: Workflow,
      title: "3. When it happens",
      blurb:
        "Workflows join a trigger to steps. A flow can never do more than its most restricted step, and anything that reads text from outside the workspace makes every later change a proposal.",
      facts: [
        `${data.flows.live} of ${data.flows.total} live`,
        `${data.flows.runsLastWeek} run${data.flows.runsLastWeek === 1 ? "" : "s"} in the last week`,
        data.flows.waiting > 0 ? `${data.flows.waiting} waiting for a person` : "none waiting for a person"
      ]
    },
    {
      key: "proposals",
      to: "/app/proposals",
      icon: Sparkles,
      title: "4. What you accept",
      blurb:
        "Anything the AI is not allowed to apply arrives here as a suggestion, change by change, checked against the state it was computed from — and every applied change is undoable.",
      facts: [
        `${data.proposals.pending} waiting for review`,
        `${data.proposals.appliedLastWeek} applied in the last week`,
        `${data.flows.proposalOnly} live workflow${data.flows.proposalOnly === 1 ? "" : "s"} can only propose`
      ]
    }
  ];
}

export function AiOverviewPage() {
  const overview = useQuery({ queryKey: ["ai", "overview"], queryFn: aiOverviewApi.get, retry: false });
  const data = overview.data;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Sparkles className="h-6 w-6 text-primary" />
          AI in this workspace
        </h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Four screens, one arrangement: what the AI may do, who does it, when it happens, and what you accept. Every number
          below is a count you can check against the screen it came from.
        </p>
      </div>

      {overview.isLoading && (
        <div className="space-y-3">
          <Skeleton className="h-20" />
          <Skeleton className="h-64" />
        </div>
      )}

      {data && !data.aiEnabled && (
        <Card className="border-warning/40 bg-warning/5 animate-fade-in">
          <CardContent className="flex items-start gap-2.5 py-4 text-sm">
            <PowerOff className="mt-0.5 h-4 w-4 shrink-0 text-warning-foreground" aria-hidden />
            <span>
              <strong className="font-medium">AI is switched off for this workspace.</strong> Everything below is configured
              and inert — nothing calls a model and nothing changes anybody&apos;s work until it is switched on in{" "}
              <Link className="underline" to="/app/settings?tab=ai">
                Workspace Settings → AI
              </Link>
              .
            </span>
          </CardContent>
        </Card>
      )}

      {data?.nextStep && data.aiEnabled && (
        <Card className="animate-fade-in">
          <CardContent className="flex items-start gap-2.5 py-4 text-sm">
            <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
            <span>
              <strong className="font-medium">Worth doing next: </strong>
              {data.nextStep}
            </span>
          </CardContent>
        </Card>
      )}

      {data && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Spent this month" value={usd(data.spend.monthToDateUsd)} icon={<Sparkles className="h-4 w-4" />} />
            <StatCard label="Of that, AI teammates" value={usd(data.spend.agentDrivenUsd)} icon={<Bot className="h-4 w-4" />} />
            <StatCard label="Of that, workflows" value={usd(data.spend.byFlowUsd)} icon={<Workflow className="h-4 w-4" />} />
            {/* Displacement is the one figure here that is often unknowable, so it says so rather than
                showing a zero — "no comparable history" and "displaced nothing" are opposite claims. */}
            <StatCard
              label="Human time displaced"
              value={data.ledger.entries === 0 ? "—" : `${data.ledger.displacedHours}h`}
              hint={
                data.ledger.entries === 0
                  ? "nothing on the ledger yet"
                  : data.ledger.unmeasurableEntries > 0
                    ? `${data.ledger.unmeasurableEntries} of ${data.ledger.entries} runs not measurable`
                    : `measured across ${data.ledger.entries} runs`
              }
              icon={<Scale className="h-4 w-4" />}
            />
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            {surfaces(data).map((surface) => {
              const Icon = surface.icon;
              return (
                <Card key={surface.key} className="animate-fade-in transition-shadow duration-200 hover:shadow-md">
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary" aria-hidden>
                        <Icon className="h-4 w-4" />
                      </span>
                      {surface.title}
                    </CardTitle>
                    <CardDescription className="text-xs">{surface.blurb}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-2 pt-0">
                    <div className="flex flex-wrap gap-1.5">
                      {surface.facts.map((fact) => (
                        <Badge key={fact} variant="secondary" className="text-[11px] font-normal">
                          {fact}
                        </Badge>
                      ))}
                    </div>
                    <Link
                      to={surface.to}
                      /* A 14px-tall link is a link people miss. The row it sits in is otherwise empty,
                         so the target grows downward without moving anything. */
                      className={cn("inline-flex min-h-[44px] items-center gap-1 text-xs font-medium text-primary hover:underline sm:min-h-0")}
                    >
                      Open it
                      <ArrowRight className="h-3 w-3" />
                    </Link>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          <Card className="animate-fade-in">
            <CardContent className="space-y-2 py-4 text-xs text-muted-foreground">
              <p>
                <strong className="font-medium text-foreground">The guarantee that ties the four together:</strong> nothing the
                AI does here reaches your data by a path of its own. Whatever it is allowed to apply goes through the same
                per-change review, staleness check, audit trail and undo as every other AI write in this product — and
                whatever it is not allowed to apply becomes a suggestion instead of an action.
              </p>
              <p>
                {data.captureEnabled
                  ? "This workspace keeps what was asked of the model, so a run's transcript can be read afterwards and promoted into an evaluation set."
                  : "This workspace does not keep what was asked of the model, so run transcripts are recorded without content. That is a setting, not a fault — turn on AI content capture if you want them."}
              </p>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
