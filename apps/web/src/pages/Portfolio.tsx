/**
 * The Portfolio page — delivery health for a set of projects at once: schedule, progress, budget
 * burn and forecast.
 *
 * WHY EVERY NUMBER IS DERIVED AND NONE ARE ENTERED: a portfolio here holds a name, a code, an
 * owner and a colour. Its schedule comes from the same solver the timeline uses, and its burn is
 * summed from the rate snapshots taken when timesheets were approved — the same source a Verified
 * Work Attestation reads. A portfolio-level budget maintained alongside the project-level ones is
 * how portfolio tools end up disagreeing with themselves, and the disagreement always surfaces in
 * the meeting where it matters most.
 *
 * WHY A BLANK FORECAST IS SHOWN RATHER THAN A NUMBER: with near-zero progress or zero spend the
 * arithmetic produces a confident figure that is noise — "forecast: $0" reads as "this will cost
 * nothing". The API returns null in those cases and this page says so.
 *
 * WHO renders this: `App.tsx` at `/app/portfolio`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Briefcase, Loader2, Lock, Plus, Target, Trash2, TrendingUp, Wrench } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { permissions } from "@timesheet/shared";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Progress } from "../components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { StatCard } from "../components/ui/stat-card";
import { usePlanningFeatures } from "../lib/use-planning";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { toast } from "../components/ui/toaster";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/utils";
import { useAuthStore } from "../store/auth";
import { copilotApi, goalApi, planningApi, portfolioApi, projectApi, type PortfolioProjectRollup } from "../services/api";

const serverMessage = (err: any, fallback: string) => err?.response?.data?.message ?? fallback;

const money = (value: number | null, currency: string) =>
  value === null
    ? "—"
    : new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 0 }).format(value);

/** RAG for one project row. Deterministic and stated in one place so the table, the tiles and
 *  (from phase 5) the risk agent cannot each decide "at risk" differently. */
function healthOf(p: PortfolioProjectRollup): { band: "green" | "amber" | "red"; reasons: string[] } {
  const reasons: string[] = [];
  if (p.overBudgetRisk) reasons.push("forecast exceeds budget");
  if (p.overrunsPlannedEnd) reasons.push("schedule runs past the planned end date");
  if (p.worstSlipDays > 5) reasons.push(`slipped ${p.worstSlipDays} days against baseline`);
  if (p.violationCount > 0) reasons.push(`${p.violationCount} scheduling conflict(s)`);
  if (p.burnPct !== null && p.budgetAlertPct !== null && p.burnPct >= p.budgetAlertPct) {
    reasons.push(`${p.burnPct}% of budget spent`);
  }
  if (p.overBudgetRisk || p.overrunsPlannedEnd) return { band: "red", reasons };
  if (reasons.length > 0) return { band: "amber", reasons };
  return { band: "green", reasons: ["on plan"] };
}

const BAND_CLASS = {
  green: "bg-risk-green",
  amber: "bg-risk-amber",
  red: "bg-risk-red"
} as const;

export function PortfolioPage() {
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canManage = Boolean(user?.permissions.includes(permissions.PORTFOLIOS_MANAGE));
  const canPlan = Boolean(user?.permissions.includes(permissions.PLAN_WRITE));

  // The producer only ever proposes (its ceiling is SUGGEST) — the toast's Review action is the
  // real next step. "Nothing to propose" comes back with the reason and is worth showing: "the
  // drivers need human decisions" is the honest answer, not a failure.
  const mitigate = useMutation({
    mutationFn: (projectId: string) => copilotApi.riskMitigation(projectId),
    onSuccess: (outcome) => {
      if (!outcome.proposalId) {
        toast.info("Nothing to propose", { description: outcome.reason ?? undefined });
        return;
      }
      toast.success("Mitigation proposed", {
        description: "The committed end date would move to match the schedule — review before anything changes.",
        action: { label: "Review", onClick: () => navigate("/app/proposals") }
      });
    },
    onError: (err: any) => toast.error("Could not assess that project", { description: err?.response?.data?.message ?? "Try again." })
  });

  const [selected, setSelected] = useState<string>("__all__");

  const config = useQuery({ queryKey: ["planning", "settings"], queryFn: planningApi.settings });
  const enabled = Boolean(config.data?.effective.planning);

  const portfolios = useQuery({ queryKey: ["portfolios"], queryFn: portfolioApi.list, enabled });
  const rollup = useQuery({
    queryKey: ["portfolios", "rollup", selected],
    queryFn: () => portfolioApi.rollup(selected === "__all__" ? undefined : selected),
    enabled
  });
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => projectApi.list(), enabled });
  // The nightly worker stores these; a project with no snapshot yet simply has no badge
  // rather than a fabricated one.
  const riskSnapshots = useQuery({ queryKey: ["ai-proposals", "risk"], queryFn: copilotApi.riskSnapshots, enabled });
  const riskByProject = new Map((riskSnapshots.data ?? []).map((r) => [r.projectId, r]));

  const [draft, setDraft] = useState({ name: "", code: "" });
  const create = useMutation({
    mutationFn: () => portfolioApi.create({ name: draft.name.trim(), code: draft.code.trim().toUpperCase() }),
    onSuccess: () => {
      toast.success("Portfolio created");
      setDraft({ name: "", code: "" });
      queryClient.invalidateQueries({ queryKey: ["portfolios"] });
    },
    onError: (err: any) => toast.error("Could not create", { description: serverMessage(err, "Try again.") })
  });
  const remove = useMutation({
    mutationFn: (id: string) => portfolioApi.remove(id),
    onSuccess: () => {
      toast.success("Portfolio removed", { description: "Its projects are still here — they are just ungrouped now." });
      queryClient.invalidateQueries({ queryKey: ["portfolios"] });
      queryClient.invalidateQueries({ queryKey: ["portfolios", "rollup"] });
    },
    onError: (err: any) => toast.error("Could not remove", { description: serverMessage(err, "Try again.") })
  });
  const assign = useMutation({
    mutationFn: ({ portfolioId, projectIds }: { portfolioId: string; projectIds: string[] }) =>
      portfolioApi.setProjects(portfolioId, projectIds),
    onSuccess: () => {
      toast.success("Projects updated");
      queryClient.invalidateQueries({ queryKey: ["portfolios"] });
      queryClient.invalidateQueries({ queryKey: ["portfolios", "rollup"] });
    },
    onError: (err: any) => toast.error("Could not update", { description: serverMessage(err, "Try again.") })
  });

  if (config.isLoading) return <Skeleton className="h-96 w-full" />;

  if (!enabled) {
    return (
      <div className="mx-auto grid w-full max-w-3xl gap-4 p-4 sm:p-6">
        <Card>
          <CardContent className="grid gap-3 p-8 text-center">
            <Briefcase className="mx-auto h-8 w-8 text-muted-foreground" />
            <h1 className="text-lg font-semibold">Portfolios need the planning layer</h1>
            <p className="text-sm text-muted-foreground">
              A super admin can turn it on in Workspace Settings → Planning.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const rows = rollup.data?.projects ?? [];
  const groups = rollup.data?.portfolios ?? [];
  const currency = rows[0]?.currency ?? "USD";
  const totalBudget = rows.reduce((s, r) => s + (r.budget ?? 0), 0);
  const totalBurn = rows.reduce((s, r) => s + r.burn, 0);
  const atRisk = rows.filter((r) => healthOf(r).band === "red").length;
  const weight = rows.reduce((s, r) => s + Math.max(1, r.itemCount), 0);
  const overallProgress = weight > 0 ? Math.round(rows.reduce((s, r) => s + r.progressPct * Math.max(1, r.itemCount), 0) / weight) : 0;

  return (
    <div className="grid min-w-0 gap-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Briefcase className="h-5 w-5 text-primary" />
            Portfolio
          </h1>
          <p className="text-sm text-muted-foreground">
            Delivery health across projects. Every figure is derived from the same plan and the same approved hours the
            rest of the app uses — nothing here is entered twice.
          </p>
        </div>
        <Select value={selected} onValueChange={setSelected}>
          <SelectTrigger className="w-[220px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All projects</SelectItem>
            {(portfolios.data ?? []).map((pf) => (
              <SelectItem key={pf.id} value={pf.id}>
                {pf.code} — {pf.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {rollup.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Projects" value={String(rows.length)} icon={<Briefcase className="h-4 w-4" />} />
            <StatCard label="Overall progress" value={`${overallProgress}%`} icon={<TrendingUp className="h-4 w-4" />} />
            <StatCard
              label="Budget committed"
              value={
                totalBudget > 0 ? (
                  <span className="flex flex-wrap items-baseline gap-1.5">
                    {money(totalBurn, currency)}
                    <span className="text-xs font-normal text-muted-foreground">of {money(totalBudget, currency)}</span>
                  </span>
                ) : (
                  "—"
                )
              }
              icon={<TrendingUp className="h-4 w-4" />}
            />
            <StatCard
              label="At risk"
              value={String(atRisk)}
              tone={atRisk > 0 ? "destructive" : "default"}
              icon={<AlertTriangle className="h-4 w-4" />}
            />
          </div>

          {/* Goals that measure THIS scope. The Portfolio page answers "how is the work going" from
              schedule and money; a goal is the third answer — what the work was FOR — and V8 shipped it
              on a page of its own that nobody had a reason to open from here. Rendered only when a goal
              actually links to something in view, so it never becomes an empty region. */}
          <PortfolioGoals projectIds={rows.map((r) => r.id)} portfolioIds={groups.map((g) => g.id)} />

          {groups.length > 0 && (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {groups.map((g) => (
                <Card key={g.id}>
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center justify-between gap-2 text-base">
                      <span className="flex items-center gap-2">
                        <span className="h-2.5 w-2.5 rounded-full" style={{ background: g.color ?? "hsl(var(--primary))" }} />
                        {g.name}
                      </span>
                      <Badge variant="secondary">{g.projectCount}</Badge>
                    </CardTitle>
                    <CardDescription>
                      {g.openCount} open · {g.itemCount} items{g.scheduleEnd ? ` · ends ${g.scheduleEnd}` : ""}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="grid gap-2">
                    <Progress value={g.progressPct} className="h-2" />
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>{g.progressPct}% complete</span>
                      {g.atRiskProjects > 0 && <Badge variant="warning">{g.atRiskProjects} at risk</Badge>}
                    </div>
                    {canManage && (
                      <Button size="sm" variant="ghost" className="justify-self-start" onClick={() => remove.mutate(g.id)}>
                        <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                        Remove
                      </Button>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Projects</CardTitle>
              <CardDescription>
                Health is deterministic: red means the forecast exceeds the budget or the schedule runs past the planned
                end date. Hover a dot to see exactly why.
              </CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0 sm:p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>Project</TableHead>
                    <TableHead>Schedule</TableHead>
                    <TableHead className="text-right">Progress</TableHead>
                    <TableHead className="text-right">Budget</TableHead>
                    <TableHead className="text-right">Burn</TableHead>
                    <TableHead className="text-right">Forecast</TableHead>
                    <TableHead className="text-right">Slip</TableHead>
                    <TableHead className="text-right">Risk</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((p) => {
                    const health = healthOf(p);
                    return (
                      <TableRow key={p.id} className="cursor-pointer" onClick={() => navigate(`/app/timeline?project=${p.id}`)}>
                        <TableCell>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className={cn("inline-block h-2.5 w-2.5 rounded-full", BAND_CLASS[health.band])} />
                            </TooltipTrigger>
                            <TooltipContent>
                              <span className="text-xs">{health.reasons.join("; ")}</span>
                            </TooltipContent>
                          </Tooltip>
                        </TableCell>
                        <TableCell>
                          <div className="grid gap-0.5">
                            <span className="font-medium">{p.name}</span>
                            <span className="font-mono text-[11px] text-muted-foreground">
                              {p.code}
                              {p.portfolio ? ` · ${p.portfolio.code}` : ""}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="text-xs">
                          {p.scheduleStart ? (
                            <span className={cn(p.overrunsPlannedEnd && "text-destructive")}>
                              {p.scheduleStart} → {p.scheduleEnd}
                              {p.plannedEnd && <span className="block text-[10px] opacity-70">planned end {p.plannedEnd}</span>}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">not scheduled</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-2">
                            <Progress value={p.progressPct} className="h-1.5 w-16" />
                            <span className="text-xs tabular-nums">{p.progressPct}%</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums">{money(p.budget, p.currency)}</TableCell>
                        <TableCell className="text-right text-xs tabular-nums">
                          {money(p.burn, p.currency)}
                          {p.burnPct !== null && <span className="block text-[10px] opacity-70">{p.burnPct}%</span>}
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums">
                          {p.forecastAtCompletion === null ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="text-muted-foreground">—</span>
                              </TooltipTrigger>
                              <TooltipContent>
                                <span className="text-xs">Not enough progress or spend yet for a forecast to mean anything.</span>
                              </TooltipContent>
                            </Tooltip>
                          ) : (
                            <span className={cn(p.overBudgetRisk && "font-medium text-destructive")}>
                              {money(p.forecastAtCompletion, p.currency)}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums">
                          {p.worstSlipDays > 0 ? <Badge variant="warning">+{p.worstSlipDays}d</Badge> : <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums">
                          {(() => {
                            const risk = riskByProject.get(p.id);
                            if (!risk) return <span className="text-muted-foreground">—</span>;
                            return (
                              <span className="inline-flex items-center justify-end gap-1">
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Badge variant={risk.band === "RED" ? "destructive" : risk.band === "AMBER" ? "warning" : "success"}>
                                      {risk.riskScore}
                                    </Badge>
                                  </TooltipTrigger>
                                  <TooltipContent className="max-w-sm">
                                    {/* The narrative is a convenience; the score and its breakdown are the
                                        product, and they are computed arithmetically. */}
                                    <p className="text-xs">{risk.narrative ?? `Computed risk ${risk.riskScore}/100.`}</p>
                                    <p className="mt-1 text-[10px] text-muted-foreground">
                                      Scored {new Date(risk.computedAt).toLocaleString()}
                                    </p>
                                  </TooltipContent>
                                </Tooltip>
                                {/* Only where the score says something is wrong, and only to someone who
                                    could apply the result — a green project has nothing to mitigate. */}
                                {canPlan && risk.band !== "GREEN" && (
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6"
                                    title="Propose a mitigation — realigns the committed end date with the schedule, as a proposal you review"
                                    disabled={mitigate.isPending}
                                    onClick={() => mitigate.mutate(p.id)}
                                  >
                                    {mitigate.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wrench className="h-3 w-3" />}
                                  </Button>
                                )}
                              </span>
                            );
                          })()}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {canManage && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Manage portfolios</CardTitle>
                <CardDescription>
                  Grouping is optional. Removing a portfolio never touches its projects — they simply become ungrouped.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4">
                <div className="grid gap-3 sm:grid-cols-[1fr_140px_auto] sm:items-end">
                  <div className="grid gap-1.5">
                    <Label>Name</Label>
                    <Input value={draft.name} placeholder="Client delivery" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label>Code</Label>
                    <Input value={draft.code} placeholder="DEL" onChange={(e) => setDraft({ ...draft, code: e.target.value.toUpperCase() })} />
                  </div>
                  <Button disabled={create.isPending || !draft.name.trim() || !draft.code.trim()} onClick={() => create.mutate()}>
                    {create.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
                    Add
                  </Button>
                </div>

                {(portfolios.data ?? []).map((pf) => {
                  const memberIds = rows.filter((r) => r.portfolio?.id === pf.id).map((r) => r.id);
                  return (
                    <div key={pf.id} className="grid gap-2 rounded-lg border border-border p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium">
                          {pf.code} — {pf.name}
                        </span>
                        <Badge variant="secondary">{memberIds.length} projects</Badge>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {(projects.data ?? []).map((project: any) => {
                          const isMember = memberIds.includes(project.id);
                          return (
                            <Button
                              key={project.id}
                              size="sm"
                              variant={isMember ? "default" : "outline"}
                              disabled={assign.isPending}
                              onClick={() =>
                                assign.mutate({
                                  portfolioId: pf.id,
                                  projectIds: isMember ? memberIds.filter((id) => id !== project.id) : [...memberIds, project.id]
                                })
                              }
                            >
                              {project.code}
                            </Button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          )}

          {!canManage && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Lock className="h-3 w-3" />
              Creating and editing portfolios needs the portfolio permission.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The goals pointed at anything on this page.
 *
 * WHY IT FILTERS CLIENT-SIDE over the goal list rather than asking the server for "goals for these
 * ids": `GoalLink` is deliberately not a foreign key (three target tables, one column), so a scoped
 * query would have to reimplement the expansion rule — including "a PORTFOLIO link means every project
 * in it" — in a second place. The list is small and already fetched shape-for-shape by the Goals page.
 */
function PortfolioGoals({ projectIds, portfolioIds }: Readonly<{ projectIds: string[]; portfolioIds: string[] }>) {
  const { features } = usePlanningFeatures();
  const goals = useQuery({ queryKey: ["goals", "list"], queryFn: goalApi.list, enabled: Boolean(features.goals), retry: false, staleTime: 60_000 });

  if (!features.goals) return null;
  const inScope = new Set([...projectIds, ...portfolioIds]);
  const rows = (goals.data ?? []).filter(
    (g) => g.status === "ACTIVE" && g.links.some((l) => (l.targetType === "PROJECT" || l.targetType === "PORTFOLIO") && inScope.has(l.targetId))
  );
  if (rows.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Target className="h-4 w-4 text-primary" />
          Goals measuring this work
        </CardTitle>
        <CardDescription className="text-xs">
          Progress is computed from what this workspace already records — the same tables the burn above reads.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-1.5">
        {rows.slice(0, 6).map((goal) => (
          <Link key={goal.id} to="/app/goals" className="flex flex-wrap items-baseline gap-x-2 rounded px-1 py-1 text-xs hover:bg-muted/50">
            <span className="font-medium">{goal.title}</span>
            {goal.measurement.unavailable ? (
              <span className="text-muted-foreground">not measurable yet</span>
            ) : (
              <>
                {goal.measurement.health === "OFF_TRACK" && <Badge variant="destructive" className="text-[10px]">off track</Badge>}
                {goal.measurement.health === "AT_RISK" && <Badge variant="warning" className="text-[10px]">at risk</Badge>}
                <span className="tabular-nums text-muted-foreground">
                  {goal.effectiveProgressPct === null ? "no percentage for this kind of goal" : `${goal.effectiveProgressPct}%`}
                </span>
              </>
            )}
            {goal.owner && <span className="ml-auto text-muted-foreground">{goal.owner.name}</span>}
          </Link>
        ))}
        {rows.length > 6 && <p className="text-[11px] text-muted-foreground">and {rows.length - 6} more on the Goals page.</p>}
      </CardContent>
    </Card>
  );
}
