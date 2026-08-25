/**
 * WHAT: the "what can I actually ask?" panel for the Ask AI page, and the role-aware starter
 * questions that go with it.
 *
 * WHY THE LIST COMES FROM THE SERVER AND IS NOT WRITTEN HERE: the server builds the assistant's
 * prompt from exactly this list, filtered by exactly this person's role. A hand-maintained copy in
 * the UI would be a second source of truth, and the first time a capability shipped without someone
 * remembering to edit this file, the page would be advertising a different assistant than the one
 * answering. `/ai-chat/capabilities` returns what the prompt was built from — the panel and the
 * model cannot disagree.
 *
 * WHY REFUSED CAPABILITIES ARE SHOWN, GREYED, WITH THEIR GATE NAMED: hiding them would make the
 * panel read as the product's entire surface, and somebody without the reports permission would
 * reasonably conclude the workspace has no hours reporting at all. Naming what exists and who it
 * needs turns a dead end into a request they can make of an admin. It leaks nothing: a capability
 * name plus "needs Reports access" is already implied by the permission list on their own profile.
 *
 * WHY THE STARTER QUESTIONS ARE DERIVED FROM THE SAME RESPONSE: a suggestion chip that produces a
 * refusal is worse than no chip. Each question below is keyed to the tool that answers it, and only
 * appears when that tool is one this person's assistant can reach — so an engineer sees questions
 * about their tickets and hours, and an administrator additionally sees the ones about spend,
 * delivery and health.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Eye, Lock, PencilLine, Search, Shield, Sparkles } from "lucide-react";
import { askAiApi, type AiChatCapabilities, type AiChatCapability } from "../../services/api";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "../ui/sheet";
import { Skeleton } from "../ui/skeleton";

/** One question per capability, phrased the way somebody would actually type it. */
const QUESTION_FOR: Record<string, string> = {
  search_tickets: "Summarize the open critical bugs.",
  ticket_metrics: "Break my tickets down by status and priority.",
  list_changes: "Which changes are in flight, and at what risk?",
  change_metrics: "How do our change requests split by state and risk?",
  my_timesheets: "Where did my hours go over the last two weeks?",
  timesheet_stats: "How many of my entries are approved, and how many are still pending?",
  timesheet_report: "Chart approved hours by project for this month.",
  list_projects: "What projects, modules and submodules do we have?",
  find_people: "Who reports to whom around me?",
  list_agents: "What do our AI agents each own?",
  list_workflows: "Which workflows are switched on, and what fires them?",
  log_timesheet_draft: "Log 2 hours on HICS-TS today, 09:00 to 11:00, development on the release notes.",
  ai_spend: "What is AI costing us this month, by feature?",
  ai_quality: "Which AI capability gets rated down the most?",
  email_analytics: "How much email went out last month, and what failed?",
  email_templates: "Which email templates are switched off?",
  service_health: "Has anything been down this week?",
  api_performance: "Which endpoints are slowest by p95?",
  audit_log: "Who approved changes in the last seven days?",
  security_findings: "What security findings are still open?",
  ci_runs: "Is CI green?",
  face_verification_stats: "How many identity checks failed this month, and why?",
  workspace_configuration: "What features are switched on in this workspace?",
  sso_and_auth: "How do people sign in — is SSO on, and can they still use passwords?",
  scheduled_reports: "What reports go out on a schedule, and has any of them failed to send?",
  project_health: "Which projects are at risk right now, and what is driving it?",
  user_stats: "How many people do we have, by role?",
  sla_and_escalations: "What has breached SLA, and how many escalations are unresolved?",
  goals_overview: "How are our goals tracking?",
  automation_activity: "What have the agents and workflows been doing lately?"
};

const capabilitiesQuery = { queryKey: ["ask-ai", "capabilities"], queryFn: () => askAiApi.capabilities() };

/**
 * Starter questions this person's assistant can genuinely answer.
 *
 * Ordered by the group ordering the server returns — everyday work first, operational figures after
 * — so the first few chips are always the ones most people want, whatever their role.
 */
export function useAskAiSuggestions(limit = 5): string[] {
  const { data } = useQuery(capabilitiesQuery);
  return useMemo(() => {
    if (!data) return [];
    const questions = data.groups
      .flatMap((g) => g.tools)
      .filter((t) => t.allowed)
      .map((t) => QUESTION_FOR[t.name])
      .filter((q): q is string => Boolean(q));
    return [...new Set(questions)].slice(0, limit);
  }, [data, limit]);
}

/** The header trigger: how many of the assistant's capabilities this person's role opens. */
export function AskAiCapabilitiesButton() {
  const { data } = useQuery(capabilitiesQuery);
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="ghost" size="sm" title="Everything this assistant can do for your role">
          <Sparkles className="h-3.5 w-3.5" />
          What can it do?
          {data && (
            <Badge variant="muted" className="ml-1 tabular-nums">
              {data.allowedCount}
            </Badge>
          )}
        </Button>
      </SheetTrigger>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-xl">
        <CapabilitiesPanel />
      </SheetContent>
    </Sheet>
  );
}

function CapabilitiesPanel() {
  const { data, isLoading } = useQuery(capabilitiesQuery);
  const [filter, setFilter] = useState("");

  const groups = useMemo(() => filterGroups(data, filter), [data, filter]);

  return (
    <>
      <SheetHeader>
        <SheetTitle className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          What this assistant can do
        </SheetTitle>
        <SheetDescription>
          {data ? (
            <>
              Your role — <span className="font-medium text-foreground">{data.role.replace(/_/g, " ").toLowerCase()}</span> — opens{" "}
              <span className="font-medium tabular-nums text-foreground">
                {data.allowedCount} of {data.totalCount}
              </span>{" "}
              capabilities. The assistant is told about exactly these, and refuses the rest even if asked by name.
            </>
          ) : (
            "Loading the capabilities your role opens…"
          )}
        </SheetDescription>
      </SheetHeader>

      <div className="relative mt-3 shrink-0">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter capabilities…"
          className="h-9 pl-8"
          aria-label="Filter capabilities"
        />
      </div>

      <div className="mt-3 min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
        {isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : groups.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Nothing matches “{filter}”.</p>
        ) : (
          groups.map((group) => (
            <section key={group.group} className="grid gap-1.5">
              <h3 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{group.group}</h3>
              {group.tools.map((tool) => (
                <CapabilityRow key={tool.name} tool={tool} />
              ))}
            </section>
          ))
        )}
      </div>

      <p className="shrink-0 border-t border-border/60 pt-3 text-[10px] leading-relaxed text-muted-foreground">
        Every capability runs as you, against the same rules the pages enforce. Reads never reach past what you could
        open yourself. Anything marked <strong>writes a draft</strong> stops at a draft you review and submit; anything
        marked <strong>publishes</strong> is visible to other people straight away, because the record it writes has no
        draft state. Nothing here can approve anything. Results are scanned for secrets before the model ever sees them,
        and text inside a result is treated as data, never as instructions.
      </p>
    </>
  );
}

function CapabilityRow({ tool }: { tool: AiChatCapability }) {
  const Icon = !tool.allowed ? Lock : tool.acts ? PencilLine : Eye;
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-lg border px-3 py-2",
        tool.allowed ? "border-border/70 bg-card" : "border-dashed border-border/60 bg-muted/30"
      )}
    >
      <Icon
        className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", tool.allowed ? (tool.acts ? "text-warning" : "text-primary") : "text-muted-foreground")}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <code className={cn("font-mono text-xs", tool.allowed ? "text-foreground" : "text-muted-foreground")}>{tool.name}</code>
          {/* The distinction that matters most on this page: reading is not doing — and among the
              things that DO, whether other people see the result immediately. A ticket and a comment
              have no draft state, so labelling them "writes a draft" would promise a review step
              that does not exist. */}
          {tool.acts && (
            <Badge variant={tool.publishes ? "destructive" : "warning"} className="text-[9px]">
              {tool.publishes ? "publishes" : "writes a draft"}
            </Badge>
          )}
          {!tool.allowed && (
            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
              <Shield className="h-3 w-3" aria-hidden />
              needs {tool.requires}
            </span>
          )}
        </div>
        <p className={cn("mt-0.5 text-xs leading-relaxed", tool.allowed ? "text-muted-foreground" : "text-muted-foreground/70")}>
          {tool.description}
        </p>
      </div>
    </div>
  );
}

function filterGroups(data: AiChatCapabilities | undefined, filter: string) {
  if (!data) return [];
  const needle = filter.trim().toLowerCase();
  if (!needle) return data.groups;
  return data.groups
    .map((g) => ({
      ...g,
      tools: g.tools.filter((t) => `${t.name} ${t.description} ${g.group}`.toLowerCase().includes(needle))
    }))
    .filter((g) => g.tools.length > 0);
}
