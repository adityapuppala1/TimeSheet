/**
 * WHAT: one project's money and estimate accuracy — budget, burn, forecast at completion, and
 * how far its finished work ran over or under its estimates.
 *
 * WHY THE FORECAST IS OFTEN BLANK: forecast-at-completion is burn scaled by remaining work. Below
 * 5% progress the denominator is noise, and with zero spend the arithmetic produces a confident
 * "$0" that reads as "this project will cost nothing" — the most misleading figure it is possible
 * to show. The API returns null in both cases and this panel says why rather than printing a
 * number nobody should act on.
 *
 * WHY VARIANCE ONLY COVERS FINISHED WORK: a half-done task is under its estimate by definition.
 * Including in-flight items would make every project look like it consistently beats its
 * estimates, which is the opposite of useful when the whole point is to estimate better next time.
 *
 * WHO renders this: the Budget tab on the Projects admin page.
 */
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Clock, TrendingDown, TrendingUp, Wallet } from "lucide-react";
import { Badge } from "./ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Progress } from "./ui/progress";
import { Skeleton } from "./ui/skeleton";
import { StatCard } from "./ui/stat-card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { cn } from "../lib/utils";
import { resourceApi } from "../services/api";

const money = (value: number | null, currency: string) =>
  value === null
    ? "—"
    : new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 0 }).format(value);

export function ProjectBudgetPanel({ projectId }: { projectId: string }) {
  const panel = useQuery({
    queryKey: ["resources", "budget", projectId],
    queryFn: () => resourceApi.budget(projectId),
    enabled: Boolean(projectId)
  });

  if (panel.isLoading) return <Skeleton className="h-64 w-full" />;
  if (!panel.data) return null;

  const { budget, variance, progressPct, schedule } = panel.data;
  const currency = budget?.currency ?? "USD";

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Budget"
          value={money(budget?.budget ?? null, currency)}
          icon={<Wallet className="h-4 w-4" />}
        />
        <StatCard
          label="Spent"
          value={money(budget?.burn ?? 0, currency)}
          tone={budget?.alerting ? "warning" : "default"}
          icon={<TrendingUp className="h-4 w-4" />}
        />
        <StatCard
          label="Forecast at completion"
          value={
            budget?.forecastAtCompletion === null || budget?.forecastAtCompletion === undefined ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-muted-foreground">—</span>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  <span className="text-xs">
                    Not enough progress or spend yet. A forecast from a near-zero base is noise, and a confident
                    &ldquo;{money(0, currency)}&rdquo; would read as &ldquo;this will cost nothing&rdquo;.
                  </span>
                </TooltipContent>
              </Tooltip>
            ) : (
              money(budget.forecastAtCompletion, currency)
            )
          }
          tone={budget?.overBudgetRisk ? "destructive" : "default"}
          icon={<TrendingDown className="h-4 w-4" />}
        />
        <StatCard label="Progress" value={`${progressPct}%`} icon={<Clock className="h-4 w-4" />} />
      </div>

      {budget?.budget ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Burn</CardTitle>
            <CardDescription>
              Approved, billable hours priced at the rate frozen onto each timesheet when it was approved — the same
              source a Verified Work Attestation reads, so these two can never disagree.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div className="grid gap-1.5">
              <Progress value={Math.min(100, budget.burnPct ?? 0)} className="h-2.5" />
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>
                  {money(budget.burn, currency)} of {money(budget.budget, currency)}
                  {budget.burnPct !== null && ` · ${budget.burnPct}%`}
                </span>
                {budget.alerting && <Badge variant="warning">past the {budget.budgetAlertPct}% alert</Badge>}
                {budget.overBudgetRisk && <Badge variant="destructive">forecast exceeds budget</Badge>}
              </div>
            </div>

            <div className="grid gap-2 text-xs sm:grid-cols-3">
              <div className="rounded border border-border p-2">
                <p className="text-muted-foreground">Billable hours</p>
                <p className="text-sm font-medium tabular-nums">{budget.billableHours}h</p>
              </div>
              <div className="rounded border border-border p-2">
                <p className="text-muted-foreground">Non-billable</p>
                <p className="text-sm font-medium tabular-nums">{budget.nonBillableHours}h</p>
              </div>
              <div className="rounded border border-border p-2">
                <p className="flex items-center gap-1 text-muted-foreground">
                  Unrated
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <AlertTriangle className="h-3 w-3" />
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      <span className="text-xs">
                        Approved hours with no rate on record. Counted separately, never priced as zero — pretending
                        unrated work was free is how a budget looks healthy right up until it isn&apos;t.
                      </span>
                    </TooltipContent>
                  </Tooltip>
                </p>
                <p className={cn("text-sm font-medium tabular-nums", budget.unratedHours > 0 && "text-warning")}>
                  {budget.unratedHours}h
                </p>
              </div>
            </div>

            {schedule.overrunsPlannedEnd && (
              <p className="flex items-center gap-1.5 text-xs text-destructive">
                <AlertTriangle className="h-3 w-3" />
                The current schedule ends {schedule.end}, past the planned end of {panel.data.project.plannedEnd}.
              </p>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-6 text-center text-sm text-muted-foreground">
            No budget set for this project yet. Add one in the project&apos;s settings to see burn and a forecast.
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Estimate accuracy</CardTitle>
          <CardDescription>
            Finished work only, comparing the estimate against the hours actually approved against it.
            {variance.medianVariancePct !== null && (
              <>
                {" "}
                Typical item runs{" "}
                <span className="font-medium">
                  {variance.medianVariancePct > 0 ? `${variance.medianVariancePct}% over` : `${Math.abs(variance.medianVariancePct)}% under`}
                </span>
                {variance.overrunRate !== null && ` · ${variance.overrunRate}% of items overran`}. The median, not the
                mean — one task that took 12× its estimate would drag a mean into uselessness.
              </>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0 sm:p-0">
          {variance.rows.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">
              Nothing to compare yet — this needs finished items that had an estimate and logged hours.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Item</TableHead>
                    <TableHead className="text-right">Estimated</TableHead>
                    <TableHead className="text-right">Actual</TableHead>
                    <TableHead className="text-right">Variance</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {variance.rows.map((row) => (
                    <TableRow key={row.ticketId}>
                      <TableCell>
                        <span className="font-mono text-[11px] text-muted-foreground">{row.key}</span>{" "}
                        <span className="truncate">{row.title}</span>
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">{row.estimatedHours}h</TableCell>
                      <TableCell className="text-right text-xs tabular-nums">{row.actualHours}h</TableCell>
                      <TableCell className="text-right">
                        <Badge variant={row.varianceHours > 0 ? "warning" : "success"}>
                          {row.varianceHours > 0 ? "+" : ""}
                          {row.variancePct}%
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
