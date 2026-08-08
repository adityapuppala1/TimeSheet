/**
 * The Timeline page — a project's whole plan on one Gantt, with the toolbar that drives it.
 *
 * WHY IT IS SCOPED TO ONE PROJECT BY DEFAULT rather than showing everything: a cross-project
 * Gantt is a portfolio question, and the Portfolio page answers it properly with roll-ups. A
 * timeline mixing forty projects' bars is unreadable, and the "All projects" option here exists
 * only for workspaces small enough that it genuinely is one plan.
 *
 * WHO renders this: `App.tsx` at `/app/timeline`, gated on `plan:write` for editing but readable
 * by anyone with `tickets:view` — reading the schedule is not a privilege.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarRange, Flag, Loader2, Lock, Wrench } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { permissions } from "@timesheet/shared";
import { PlanTimeline, TimelineLegend, scheduledItemIds, type TimelineZoom } from "../components/PlanTimeline";
import { PlanBreakdownDialog } from "../components/PlanBreakdownDialog";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { Switch } from "../components/ui/switch";
import { toast } from "../components/ui/toaster";
import { useAuthStore } from "../store/auth";
import { copilotApi, planApi, planningApi, projectApi } from "../services/api";

export function TimelinePage() {
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const canEdit = Boolean(user?.permissions.includes(permissions.PLAN_WRITE));

  const [projectId, setProjectId] = useState<string>("__all__");
  const [zoom, setZoom] = useState<TimelineZoom>("week");
  const [showBaseline, setShowBaseline] = useState(true);
  const [showCriticalOnly, setShowCriticalOnly] = useState(false);
  const [includeClosed, setIncludeClosed] = useState(false);
  // Default OFF: a workspace that just turned planning on has hundreds of unscheduled tickets,
  // and showing them all stacks identical one-day stubs on today until the real plan is invisible.
  const [showUnscheduled, setShowUnscheduled] = useState(false);

  const config = useQuery({ queryKey: ["planning", "settings"], queryFn: planningApi.settings });
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => projectApi.list() });

  const projectIds = projectId === "__all__" ? undefined : [projectId];
  const enabled = Boolean(config.data?.effective.timeline);

  const queryClient = useQueryClient();
  const timeline = useQuery({
    queryKey: ["plan", "timeline", projectId, includeClosed],
    queryFn: () => planApi.timeline({ projectIds, includeClosed }),
    enabled
  });

  // The producer never applies anything itself — it emits a proposal whose rows are reviewed on
  // /app/proposals, so the toast's Review action is the actual next step, not decoration.
  const fixConflicts = useMutation({
    mutationFn: () => copilotApi.scheduleAdjust(projectId),
    onSuccess: (outcome) => {
      if (!outcome.proposalId) {
        toast.info("Nothing to fix", { description: outcome.reason ?? undefined });
        return;
      }
      queryClient.invalidateQueries({ queryKey: ["ai-proposals"] });
      toast.success(`${outcome.corrections} correction${outcome.corrections === 1 ? "" : "s"} suggested`, {
        description: "Nothing has moved yet — review and apply the ones you want.",
        action: { label: "Review", onClick: () => navigate("/app/proposals") }
      });
    },
    onError: (err: any) => toast.error("Could not compute corrections", { description: err?.response?.data?.message ?? "Try again." })
  });
  const dependencies = useQuery({
    queryKey: ["plan", "dependencies", projectId],
    queryFn: () => planApi.dependencies(projectIds),
    enabled
  });

  if (config.isLoading) return <Skeleton className="h-96 w-full" />;

  // The two "off" states are deliberately different messages: one is a setting an admin here can
  // change, the other is a commercial conversation. A single generic notice would send both
  // audiences to the wrong place.
  if (!config.data?.effective.timeline) {
    const blockedByPlan = config.data?.settings.enablePlanning && !config.data?.entitlements.ganttEnabled;
    return (
      <div className="mx-auto grid w-full max-w-3xl gap-4 p-4 sm:p-6">
        <Card>
          <CardContent className="grid gap-3 p-8 text-center">
            {blockedByPlan ? <Lock className="mx-auto h-8 w-8 text-muted-foreground" /> : <CalendarRange className="mx-auto h-8 w-8 text-muted-foreground" />}
            <h1 className="text-lg font-semibold">Timeline isn&apos;t switched on</h1>
            <p className="text-sm text-muted-foreground">
              {blockedByPlan
                ? "Timelines, dependencies and baselines are included from the Team plan upwards."
                : "A super admin can turn on the planning layer in Workspace Settings → Planning. Nothing about your existing tickets changes when they do."}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const data = timeline.data;

  return (
    <div className="grid min-w-0 gap-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <CalendarRange className="h-5 w-5 text-primary" />
            Timeline
          </h1>
          <p className="text-sm text-muted-foreground">
            {canEdit
              ? "Drag a bar to move it, drag its edge to change its length. Dependencies and the critical path update as you go."
              : "Read-only. Ask an admin for the plan permission to reschedule work here."}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Select value={projectId} onValueChange={setProjectId}>
            <SelectTrigger className="w-[220px]">
              <SelectValue placeholder="Project" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All projects</SelectItem>
              {(projects.data ?? []).map((p: any) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.code} — {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch checked={includeClosed} onCheckedChange={setIncludeClosed} />
            Closed items
          </label>
          {/* The entry point the Proposals page's empty state has always promised. Only offered to
              someone who could apply the result — suggesting a plan to a person who cannot act on
              it is a dead end dressed up as a feature. */}
          {canEdit && (
            <PlanBreakdownDialog
              projectId={projectId === "__all__" ? null : projectId}
              projectName={(projects.data ?? []).find((p: any) => p.id === projectId)?.name ?? null}
            />
          )}
          {/* Only rendered when the legend is already showing a conflict badge — the button IS
              the answer to that badge. One project at a time: the proposal needs a scope. */}
          {canEdit && projectId !== "__all__" && (data?.violations.length ?? 0) > 0 && (
            <Button variant="outline" size="sm" disabled={fixConflicts.isPending} onClick={() => fixConflicts.mutate()}>
              {fixConflicts.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Wrench className="mr-2 h-3.5 w-3.5" />}
              Fix {data!.violations.length} conflict{data!.violations.length === 1 ? "" : "s"}
            </Button>
          )}
        </div>
      </div>

      <TimelineLegend
        zoom={zoom}
        onZoom={setZoom}
        showBaseline={showBaseline}
        onToggleBaseline={() => setShowBaseline((v) => !v)}
        showCriticalOnly={showCriticalOnly}
        onToggleCritical={() => setShowCriticalOnly((v) => !v)}
        showUnscheduled={showUnscheduled}
        onToggleUnscheduled={() => setShowUnscheduled((v) => !v)}
        unscheduledCount={data ? data.items.length - scheduledItemIds(data.items).size : 0}
        violationCount={data?.violations.length ?? 0}
      />

      {timeline.isLoading || dependencies.isLoading ? (
        <div className="grid gap-2">
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : data ? (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {data.start && data.end && (
              <Badge variant="secondary">
                {data.start} → {data.end}
              </Badge>
            )}
            <span>{data.items.length} work items</span>
            <span>·</span>
            <span>{data.criticalPath.length} on the critical path</span>
            {timeline.isFetching && <Loader2 className="h-3 w-3 animate-spin" />}
          </div>
          <PlanTimeline
            data={data}
            dependencies={dependencies.data ?? []}
            zoom={zoom}
            canEdit={canEdit}
            showBaseline={showBaseline}
            showCriticalOnly={showCriticalOnly}
            showUnscheduled={showUnscheduled}
            onOpenItem={(id) => navigate(`/app/tickets?open=${id}`)}
          />
        </>
      ) : (
        <div className="rounded-xl border border-dashed border-border p-10 text-center">
          <Flag className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-3 text-sm text-muted-foreground">Nothing to show for this project yet.</p>
        </div>
      )}
    </div>
  );
}
