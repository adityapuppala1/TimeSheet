/**
 * The Blueprints page — saved project structures, previewed against a real start date and stamped
 * out as a change set somebody reviews.
 *
 * WHY THIS PAGE EXISTS NOW: the entire blueprint feature was reachable only through the API. The
 * service, the controller, the expander and the whole client surface (`blueprintApi`) all shipped
 * and nothing in the product ever called them — the same gap `copilotApi.planBreakdown` had before
 * the Timeline grew its button. A feature nobody can reach is a feature nobody has.
 *
 * WHY THE PREVIEW IS THE CENTREPIECE rather than a list of names: a blueprint is relative day
 * offsets ("design runs days 1-5"), which is unreadable as stored and obvious as dates. The
 * preview runs the SAME expander the real instantiation runs and writes nothing, so what you read
 * before choosing is exactly what would be created.
 *
 * WHY TWO WAYS TO USE ONE: "Propose" goes through the AI proposal envelope — every item and
 * dependency becomes a row somebody accepts or rejects, and the whole set is undoable afterwards.
 * "Create directly" is the original all-or-nothing path, kept because stamping a known-good
 * template into an empty project does not need review theatre. The page states the difference at
 * the point of the decision rather than in documentation nobody opens.
 *
 * WHO renders this: `App.tsx` at `/app/blueprints`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, FileStack, GitBranch, Layers, Loader2, Milestone, Plus, Sparkles, Trash2 } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { permissions } from "@timesheet/shared";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from "../components/ui/alert-dialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { toast } from "../components/ui/toaster";
import { cn } from "../lib/utils";
import { useAuthStore } from "../store/auth";
import { blueprintApi, copilotApi, projectApi, type BlueprintRow } from "../services/api";

/** Today as `YYYY-MM-DD` in the viewer's own clock — a start date is a wall-clock choice, and
 *  toISOString() would hand somebody east of Greenwich yesterday. */
function todayLocal(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function BlueprintsPage() {
  const user = useAuthStore((s) => s.user);
  const canUse = Boolean(user?.permissions.includes(permissions.PLAN_WRITE));
  const [openId, setOpenId] = useState<string | null>(null);
  const [deriveOpen, setDeriveOpen] = useState(false);

  const blueprints = useQuery({ queryKey: ["blueprints"], queryFn: blueprintApi.list });
  const rows = blueprints.data ?? [];

  return (
    <div className="grid min-w-0 gap-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <FileStack className="h-5 w-5 text-primary" />
            Blueprints
          </h1>
          <p className="text-sm text-muted-foreground">
            A saved shape of work you can stamp out again. Dates are stored as day offsets, never fixed dates — so a blueprint
            written last quarter is still right this one.
          </p>
        </div>
        {canUse && (
          <Button variant="outline" size="sm" onClick={() => setDeriveOpen(true)}>
            <GitBranch className="mr-2 h-3.5 w-3.5" />
            Learn from a project
          </Button>
        )}
      </div>

      {blueprints.isLoading ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-36 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="grid gap-3 p-10 text-center">
            <Layers className="mx-auto h-8 w-8 text-muted-foreground" />
            <p className="text-sm font-medium">No blueprints yet</p>
            <p className="mx-auto max-w-md text-xs text-muted-foreground">
              The quickest way to make one is to point at a project whose shape already works —
              <strong> Learn from a project</strong> reads its items, hierarchy and dependencies and turns the dates into
              relative offsets.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((blueprint) => (
            <BlueprintCard key={blueprint.id} blueprint={blueprint} canUse={canUse} onUse={() => setOpenId(blueprint.id)} />
          ))}
        </div>
      )}

      <UseBlueprintDialog blueprintId={openId} onClose={() => setOpenId(null)} />
      <DeriveDialog open={deriveOpen} onClose={() => setDeriveOpen(false)} />
    </div>
  );
}

function BlueprintCard({ blueprint, canUse, onUse }: { blueprint: BlueprintRow; canUse: boolean; onUse: () => void }) {
  const queryClient = useQueryClient();
  const items = blueprint.payload?.items ?? [];
  const milestones = items.filter((i) => i.isMilestone).length;
  const dependencies = items.reduce((sum, i) => sum + (i.dependsOn?.length ?? 0), 0);

  const remove = useMutation({
    mutationFn: () => blueprintApi.remove(blueprint.id),
    onSuccess: () => {
      toast.success("Blueprint deleted", { description: "Work already created from it is untouched." });
      queryClient.invalidateQueries({ queryKey: ["blueprints"] });
    },
    onError: (err: any) => toast.error("Could not delete", { description: err?.response?.data?.message ?? "Try again." })
  });

  return (
    <Card className="flex min-w-0 flex-col">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-start justify-between gap-2 text-base">
          <span className="min-w-0 truncate">{blueprint.name}</span>
          {!blueprint.isActive && <Badge variant="muted">inactive</Badge>}
        </CardTitle>
        {blueprint.description && <CardDescription className="line-clamp-2">{blueprint.description}</CardDescription>}
      </CardHeader>
      <CardContent className="mt-auto grid gap-3">
        <div className="flex flex-wrap gap-1.5 text-xs">
          <Badge variant="secondary">{items.length} item{items.length === 1 ? "" : "s"}</Badge>
          {milestones > 0 && (
            <Badge variant="outline" className="gap-1">
              <Milestone className="h-3 w-3" />
              {milestones}
            </Badge>
          )}
          {dependencies > 0 && (
            <Badge variant="outline" className="gap-1">
              <GitBranch className="h-3 w-3" />
              {dependencies}
            </Badge>
          )}
          {(blueprint.payload?.modules?.length ?? 0) > 0 && (
            <Badge variant="outline">{blueprint.payload!.modules!.length} module{blueprint.payload!.modules!.length === 1 ? "" : "s"}</Badge>
          )}
        </div>
        {canUse && (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={onUse}>
              <CalendarDays className="mr-2 h-3.5 w-3.5" />
              Preview &amp; use
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="icon" className="ml-auto h-8 w-8" aria-label={`Delete ${blueprint.name}`}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete &quot;{blueprint.name}&quot;?</AlertDialogTitle>
                  <AlertDialogDescription>
                    The template is removed. Work already created from it stays exactly as it is — this only deletes the shape.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    onClick={() => remove.mutate()}
                  >
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Pick a project and a start date, read exactly what would be created, then choose HOW.
 *
 * The preview refetches on every change to either input, because a preview that lags its inputs is
 * worse than none — somebody would act on the wrong dates.
 */
function UseBlueprintDialog({ blueprintId, onClose }: { blueprintId: string | null; onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [projectId, setProjectId] = useState("");
  const [startDate, setStartDate] = useState(todayLocal());

  const projects = useQuery({ queryKey: ["projects"], queryFn: () => projectApi.list() });
  const blueprint = useQuery({
    queryKey: ["blueprints", blueprintId],
    queryFn: () => blueprintApi.get(blueprintId!),
    enabled: Boolean(blueprintId)
  });
  const preview = useQuery({
    queryKey: ["blueprints", blueprintId, "preview", startDate],
    queryFn: () => blueprintApi.preview(blueprintId!, startDate),
    enabled: Boolean(blueprintId) && Boolean(startDate)
  });

  const done = () => {
    queryClient.invalidateQueries({ queryKey: ["plan"] });
    queryClient.invalidateQueries({ queryKey: ["tickets"] });
    onClose();
  };

  const propose = useMutation({
    mutationFn: () => copilotApi.blueprintInstantiate({ blueprintId: blueprintId!, projectId, startDate }),
    onSuccess: (outcome) => {
      queryClient.invalidateQueries({ queryKey: ["ai-proposals"] });
      toast.success(`${outcome.items} item${outcome.items === 1 ? "" : "s"} proposed`, {
        description: "Nothing has been created yet — accept the rows you want.",
        action: { label: "Review", onClick: () => navigate("/app/proposals") }
      });
      done();
    },
    onError: (err: any) => toast.error("Could not propose that", { description: err?.response?.data?.message ?? "Try again." })
  });

  const createNow = useMutation({
    mutationFn: () => blueprintApi.instantiate(blueprintId!, { projectId, startDate }),
    onSuccess: (result) => {
      toast.success(`Created ${result.count} item${result.count === 1 ? "" : "s"}`);
      done();
    },
    onError: (err: any) => toast.error("Could not create those items", { description: err?.response?.data?.message ?? "Try again." })
  });

  const busy = propose.isPending || createNow.isPending;
  const items = preview.data?.items ?? [];

  return (
    <Dialog open={Boolean(blueprintId)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileStack className="h-4 w-4 text-primary" />
            {blueprint.data?.name ?? "Use blueprint"}
          </DialogTitle>
          <DialogDescription>
            Pick where it lands and when it starts. Everything below is what would be created — the same expander the real
            instantiation runs, writing nothing.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="bp-project">Project</Label>
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger id="bp-project">
                <SelectValue placeholder="Which project" />
              </SelectTrigger>
              <SelectContent>
                {(projects.data ?? []).map((p: any) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.code} — {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="bp-start">Starts on</Label>
            <Input id="bp-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            <p className="text-xs text-muted-foreground">Offsets count working days, so a weekend start rolls forward.</p>
          </div>
        </div>

        {preview.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : items.length > 0 ? (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="secondary">
                {items.length} item{items.length === 1 ? "" : "s"}
              </Badge>
              {preview.data?.start && preview.data?.end && (
                <Badge variant="outline">
                  {preview.data.start} → {preview.data.end}
                </Badge>
              )}
            </div>
            {/* Its own scroll box — a 200-item blueprint must not push the actions off screen. */}
            <div className="max-h-[38vh] overflow-y-auto rounded-lg border border-border">
              <ul className="divide-y divide-border">
                {items.map((item) => (
                  <li key={item.index} className="flex flex-wrap items-center justify-between gap-2 p-2 text-xs">
                    <span className="flex min-w-0 items-center gap-1.5" style={{ paddingLeft: `${(item.depth ?? 0) * 14}px` }}>
                      {item.isMilestone ? (
                        <Milestone className="h-3 w-3 shrink-0 text-primary" />
                      ) : (
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
                      )}
                      <span className="truncate font-medium">{item.title}</span>
                      {(item.dependsOn?.length ?? 0) > 0 && (
                        <span className="shrink-0 text-muted-foreground" title="Waits for an earlier item">
                          <GitBranch className="h-3 w-3" />
                        </span>
                      )}
                    </span>
                    <span className={cn("shrink-0 tabular-nums", item.startDate ? "text-muted-foreground" : "italic text-muted-foreground/70")}>
                      {item.startDate ? `${item.startDate}${item.endDate && item.endDate !== item.startDate ? ` → ${item.endDate}` : ""}` : "no dates"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </>
        ) : (
          <p className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">
            This blueprint expands to nothing.
          </p>
        )}

        {/* The two paths, with the difference stated where the choice is made. */}
        <div className="grid gap-2 rounded-lg border border-border bg-muted/30 p-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Button disabled={!projectId || busy || items.length === 0} onClick={() => propose.mutate()}>
              {propose.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-2 h-3.5 w-3.5" />}
              <span className={!projectId || busy || items.length === 0 ? undefined : "ai-gradient-text"}>Propose for review</span>
            </Button>
            <p className="text-[11px] text-muted-foreground">
              Every item becomes a row you accept or reject, and the whole set can be undone afterwards.
            </p>
          </div>
          <div className="grid gap-1.5">
            <Button variant="outline" disabled={!projectId || busy || items.length === 0} onClick={() => createNow.mutate()}>
              {createNow.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Plus className="mr-2 h-3.5 w-3.5" />}
              Create directly
            </Button>
            <p className="text-[11px] text-muted-foreground">
              All of it, immediately. Best for a known-good template landing in an empty project.
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Turn a project that already works into a reusable shape. */
function DeriveDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [projectId, setProjectId] = useState("");
  const [name, setName] = useState("");
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => projectApi.list(), enabled: open });

  const derive = useMutation({
    mutationFn: () => blueprintApi.derive(projectId, name.trim()),
    onSuccess: (created) => {
      toast.success(`"${created.name}" saved`, { description: "Its dates were converted to relative offsets, so it travels." });
      queryClient.invalidateQueries({ queryKey: ["blueprints"] });
      setName("");
      setProjectId("");
      onClose();
    },
    onError: (err: any) => toast.error("Could not learn from that project", { description: err?.response?.data?.message ?? "Try again." })
  });

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="h-4 w-4 text-primary" />
            Learn from a project
          </DialogTitle>
          <DialogDescription>
            Reads a project&apos;s items, hierarchy and dependencies, and measures every date from the earliest one — so what
            you save is the shape of the work, not last quarter&apos;s calendar.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="derive-project">Project to learn from</Label>
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger id="derive-project">
                <SelectValue placeholder="Pick a project" />
              </SelectTrigger>
              <SelectContent>
                {(projects.data ?? []).map((p: any) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.code} — {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="derive-name">Call it</Label>
            <Input
              id="derive-name"
              value={name}
              maxLength={160}
              placeholder="Standard client onboarding"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!projectId || name.trim().length < 2 || derive.isPending} onClick={() => derive.mutate()}>
            {derive.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
            Save blueprint
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
