/**
 * WHAT: the dashboard's one-line answer to "where do my goals stand".
 *
 * WHY IT IS ON THE DASHBOARD AT ALL: V8 shipped Goals as a page you have to decide to visit, and the
 * ordinary failure of OKRs is not wrong numbers — it is that nobody opens the page again after the
 * quarter starts. The weekly digest is the push; this is the pull, on the screen everybody already
 * opens. Between them a goal has to be actively ignored rather than merely forgotten.
 *
 * WHY IT SHOWS ONLY WHAT NEEDS A LOOK: a card listing every goal on track is furniture, and furniture
 * on a dashboard trains people to skip the region it sits in. Nothing to say means nothing rendered —
 * the same rule the digest follows, for the same reason.
 *
 * WHY IT IS SCOPED TO GOALS THIS PERSON OWNS: a goal is somebody's commitment. Everyone can read every
 * goal on the Goals page; being *shown* one unprompted on your own dashboard should mean it is yours.
 *
 * WHO renders this: pages/Dashboard.tsx, under the setup checklist.
 */
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Target } from "lucide-react";
import { Link } from "react-router";
import { goalApi } from "../services/api";
import { useAuthStore } from "../store/auth";
import { usePlanningFeatures } from "../lib/use-planning";
import { Badge } from "./ui/badge";
import { Card, CardContent } from "./ui/card";
import { cn } from "../lib/utils";

const HEALTH: Record<string, { label: string; variant: "secondary" | "warning" | "destructive" }> = {
  AT_RISK: { label: "at risk", variant: "warning" },
  OFF_TRACK: { label: "off track", variant: "destructive" }
};

export function GoalsGlanceCard() {
  const user = useAuthStore((s) => s.user);
  const { features } = usePlanningFeatures();
  const goals = useQuery({
    queryKey: ["goals", "list"],
    queryFn: goalApi.list,
    enabled: Boolean(features.goals && user),
    retry: false,
    staleTime: 60_000
  });

  if (!features.goals || !user) return null;

  const mine = (goals.data ?? []).filter((g) => g.ownerId === user.id && g.status === "ACTIVE");
  // Unmeasurable counts as needing a look: "we cannot tell yet" is usually fixed by linking the goal
  // to something, and it is invisible until somebody says so.
  const needsLook = mine.filter((g) => g.measurement.unavailable || g.measurement.health === "AT_RISK" || g.measurement.health === "OFF_TRACK");
  if (needsLook.length === 0) return null;

  return (
    <Card className="animate-fade-in">
      <CardContent className="space-y-2 py-3">
        <p className="flex items-center gap-2 text-sm font-medium">
          <Target className="h-4 w-4 text-primary" aria-hidden />
          {needsLook.length === 1 ? "One of your goals needs a look" : `${needsLook.length} of your goals need a look`}
          <Link to="/app/goals" className="ml-auto inline-flex min-h-[44px] items-center gap-1 text-xs text-primary hover:underline sm:min-h-0">
            Open Goals
            <ArrowRight className="h-3 w-3" />
          </Link>
        </p>
        <ul className="space-y-1">
          {needsLook.slice(0, 4).map((goal) => {
            const health = goal.measurement.health ? HEALTH[goal.measurement.health] : undefined;
            return (
              <li key={goal.id} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                <span className="font-medium">{goal.title}</span>
                {goal.measurement.unavailable ? (
                  <span className="text-muted-foreground">
                    not measurable yet{goal.measurement.unavailableReason ? ` — ${goal.measurement.unavailableReason}` : ""}
                  </span>
                ) : (
                  <>
                    {health && (
                      <Badge variant={health.variant} className="text-[10px]">
                        {health.label}
                      </Badge>
                    )}
                    <span className={cn("text-muted-foreground")}>
                      {goal.effectiveProgressPct === null ? "no percentage for this kind of goal" : `${goal.effectiveProgressPct}%`}
                    </span>
                  </>
                )}
              </li>
            );
          })}
        </ul>
        {needsLook.length > 4 && <p className="text-[11px] text-muted-foreground">and {needsLook.length - 4} more.</p>}
      </CardContent>
    </Card>
  );
}
