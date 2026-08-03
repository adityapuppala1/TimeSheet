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
import { AlertTriangle, Briefcase, Loader2, Lock, Plus, Trash2, TrendingUp } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { toast } from "../components/ui/toaster";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/utils";
import { useAuthStore } from "../store/auth";
import { planningApi, portfolioApi, projectApi, type PortfolioProjectRollup } from "../services/api";

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

  const [selected, setSelected] = useState<string>("__all__");

  const config = useQuery({ queryKey: ["planning", "settings"], queryFn: planningApi.settings });
  const enabled = Boolean(config.data?.effective.planning);

  const portfolios = useQuery({ queryKey: ["portfolios"], queryFn: portfolioApi.list, enabled });
  const rollup = useQuery({
    queryKey: ["portfolios", "rollup", selected],
    queryFn: () => portfolioApi.rollup(selected === "__all__" ? undefined : selected),
    enabled
  });
  const projects = useQuery({ queryKey: ["projects"], queryFn: projectApi.list, enabled });

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
