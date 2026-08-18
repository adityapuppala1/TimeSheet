/**
 * The AI proposal review page — where every change an AI planning feature suggests is accepted or
 * rejected, row by row, by a person.
 *
 * WHY THIS PAGE EXISTS AT ALL, rather than a confirm dialog: the copilots propose MANY changes at
 * once — break this epic into fourteen tasks, shift forty dates. A yes/no over a change set that
 * size is not review, it is a rubber stamp, and there is no undo for "the assistant moved every
 * date in Q3". Each row is its own decision, with the before-state visible.
 *
 * WHY NOTHING IS TICKED BY DEFAULT: a pre-accepted list is a rubber stamp with extra steps. The
 * reviewer opts in to each change; "Accept all" exists as a convenience but is an explicit act,
 * and the count is stated so nobody presses it without seeing how much they just agreed to.
 *
 * WHY A REFUSED ROW IS SHOWN RATHER THAN RETRIED: when a row's underlying value has changed since
 * the proposal was computed, applying it would silently revert whoever changed it. The row is
 * kept with its reason, so a partially-applied proposal explains itself instead of looking
 * broken.
 *
 * WHO renders this: `App.tsx` at `/app/proposals`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock,
  Loader2,
  Sparkles,
  X,
  XCircle
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { permissions } from "@timesheet/shared";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Checkbox } from "../components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { toast } from "../components/ui/toaster";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/utils";
import { usePlanningFeatures } from "../lib/use-planning";
import { useAuthStore } from "../store/auth";
import { copilotApi, type AiProposalChangeRow, type AiProposalRow } from "../services/api";

const serverMessage = (err: any, fallback: string) => err?.response?.data?.message ?? fallback;

const STATUS_VARIANT: Record<AiProposalRow["status"], "warning" | "success" | "destructive" | "secondary"> = {
  PENDING_REVIEW: "warning",
  PARTIALLY_APPLIED: "secondary",
  APPLIED: "success",
  REJECTED: "destructive",
  EXPIRED: "secondary",
  UNDONE: "secondary",
  PARTIALLY_UNDONE: "warning"
};

const STATUS_LABEL: Record<AiProposalRow["status"], string> = {
  PENDING_REVIEW: "Needs review",
  PARTIALLY_APPLIED: "Partly applied",
  APPLIED: "Applied",
  REJECTED: "Rejected",
  EXPIRED: "Expired",
  UNDONE: "Undone",
  PARTIALLY_UNDONE: "Partly undone"
};

/** Renders one row's change as before → after, so a reviewer sees what actually moves. */
function ChangeDiff({ change }: { change: AiProposalChangeRow }) {
  if (change.op === "CREATE" || change.op === "LINK") return null;
  const before = change.before ?? {};
  const after = change.after ?? {};
  const keys = Object.keys(after).filter((k) => k in before);
  if (keys.length === 0) return null;

  return (
    <div className="mt-1 grid gap-0.5 text-[11px]">
      {keys.map((key) => (
        <div key={key} className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted-foreground">{key}</span>
          <span className="rounded bg-destructive/10 px-1 line-through">{String((before as any)[key] ?? "—")}</span>
          <ChevronRight className="h-3 w-3 text-muted-foreground" />
          <span className="rounded bg-success/10 px-1">{String((after as any)[key] ?? "—")}</span>
        </div>
      ))}
    </div>
  );
}

export function ProposalsPage() {
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { features } = usePlanningFeatures();
  const canApply = Boolean(user?.permissions.includes(permissions.PLAN_WRITE));

  /**
   * A deep link from wherever the proposal was PRODUCED — an agent run's trace, a workflow run's step.
   *
   * The status filter is widened to "all" when one is focused, because the commonest reason somebody
   * follows such a link is to see what became of a suggestion that is no longer pending. Filtering it
   * out of its own link would answer "it does not exist", which is both wrong and alarming.
   */
  const [searchParams] = useSearchParams();
  const focusId = searchParams.get("focus");
  const focusRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState(focusId ? "all" : "PENDING_REVIEW");
  const [decisions, setDecisions] = useState<Record<string, Record<string, boolean>>>({});

  const proposals = useQuery({
    queryKey: ["ai-proposals", status],
    queryFn: () => copilotApi.listProposals({ status }),
    enabled: features.planning
  });

  // Runs after the list paints, because the card cannot be scrolled to before it exists. Harmless when
  // nothing is focused.
  useEffect(() => {
    focusRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusId, proposals.data]);

  const apply = useMutation({
    mutationFn: ({ id, map }: { id: string; map: Record<string, boolean> }) => copilotApi.apply(id, map),
    onSuccess: (result) => {
      if (result.failed.length > 0) {
        // Named explicitly rather than summarised: a refusal means someone else's edit was
        // protected, and the reviewer should know which change didn't land and why.
        toast.warning(`Applied ${result.applied}, ${result.failed.length} couldn't be applied`, {
          description: result.failed.map((f) => `${f.summary}: ${f.reason}`).join(" · ").slice(0, 200)
        });
      } else {
        toast.success(`Applied ${result.applied} change${result.applied === 1 ? "" : "s"}`, {
          description: result.skipped > 0 ? `${result.skipped} left unapplied.` : undefined
        });
      }
      queryClient.invalidateQueries({ queryKey: ["ai-proposals"] });
      queryClient.invalidateQueries({ queryKey: ["plan"] });
      queryClient.invalidateQueries({ queryKey: ["tickets"] });
    },
    onError: (err: any) => toast.error("Could not apply", { description: serverMessage(err, "Try again.") })
  });

  const undo = useMutation({
    mutationFn: (id: string) => copilotApi.undo(id),
    onSuccess: (result) => {
      if (result.refused.length > 0) {
        // Named, not summarised — same reason apply does it. A refusal here means somebody's later
        // edit was PROTECTED from being reverted, which is a good outcome the reviewer should see
        // rather than a failure to hide.
        toast.warning(`Put back ${result.undone}, left ${result.refused.length} alone`, {
          description: result.refused.map((r) => `${r.summary}: ${r.reason}`).join(" · ").slice(0, 200)
        });
      } else {
        toast.success(`Put back ${result.undone} change${result.undone === 1 ? "" : "s"}`);
      }
      queryClient.invalidateQueries({ queryKey: ["ai-proposals"] });
      queryClient.invalidateQueries({ queryKey: ["plan"] });
      queryClient.invalidateQueries({ queryKey: ["tickets"] });
    },
    onError: (err: any) => toast.error("Could not undo", { description: serverMessage(err, "Try again.") })
  });

  const reject = useMutation({
    mutationFn: (id: string) => copilotApi.reject(id),
    onSuccess: () => {
      toast.success("Proposal dismissed");
      queryClient.invalidateQueries({ queryKey: ["ai-proposals"] });
    },
    onError: (err: any) => toast.error("Could not dismiss", { description: serverMessage(err, "Try again.") })
  });

  const setRow = (proposalId: string, changeId: string, accepted: boolean) =>
    setDecisions((current) => ({ ...current, [proposalId]: { ...(current[proposalId] ?? {}), [changeId]: accepted } }));

  const setAll = (proposal: AiProposalRow, accepted: boolean) =>
    setDecisions((current) => ({
      ...current,
      [proposal.id]: Object.fromEntries(proposal.changes.map((c) => [c.id, accepted]))
    }));

  const acceptedCount = (proposal: AiProposalRow) =>
    proposal.changes.filter((c) => decisions[proposal.id]?.[c.id] ?? c.accepted ?? false).length;

  if (!features.planning) {
    return (
      <div className="mx-auto grid w-full max-w-3xl gap-4 p-4 sm:p-6">
        <Card>
          <CardContent className="grid gap-3 p-8 text-center">
            <Bot className="mx-auto h-8 w-8 text-muted-foreground" />
            <h1 className="text-lg font-semibold">The planning copilot needs the planning layer</h1>
            <p className="text-sm text-muted-foreground">A super admin can turn it on in Workspace Settings → Planning.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const rows = proposals.data ?? [];

  return (
    <div className="mx-auto grid w-full min-w-0 max-w-5xl gap-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Sparkles className="h-5 w-5 text-primary" />
            AI suggestions
          </h1>
          <p className="text-sm text-muted-foreground">
            Nothing here has been applied. Every change is a suggestion you accept or reject individually — the
            assistant never writes to your plan on its own.
          </p>
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-[170px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="PENDING_REVIEW">Needs review</SelectItem>
            <SelectItem value="APPLIED">Applied</SelectItem>
            <SelectItem value="PARTIALLY_APPLIED">Partly applied</SelectItem>
            <SelectItem value="REJECTED">Rejected</SelectItem>
            <SelectItem value="EXPIRED">Expired</SelectItem>
            <SelectItem value="all">All</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {proposals.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="grid gap-2 p-10 text-center">
            <CheckCircle2 className="mx-auto h-8 w-8 text-success" />
            <p className="text-sm font-medium">Nothing waiting for you</p>
            <p className="text-xs text-muted-foreground">
              Ask for a breakdown from a project&apos;s timeline and the suggestion will appear here for review.
            </p>
          </CardContent>
        </Card>
      ) : (
        rows.map((proposal) => {
          const pending = proposal.status === "PENDING_REVIEW";
          const accepted = acceptedCount(proposal);
          const expiring = proposal.expiresAt ? new Date(proposal.expiresAt).getTime() - Date.now() < 24 * 3_600_000 : false;

          return (
            <Card
              key={proposal.id}
              ref={proposal.id === focusId ? focusRef : undefined}
              className={cn(proposal.id === focusId && "ring-2 ring-primary ring-offset-2 ring-offset-background")}
            >
              <CardHeader className="pb-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="grid gap-1">
                    <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                      {proposal.title}
                      <Badge variant={STATUS_VARIANT[proposal.status]}>{STATUS_LABEL[proposal.status]}</Badge>
                      {proposal.scopeProject && <Badge variant="outline">{proposal.scopeProject.code}</Badge>}
                    </CardTitle>
                    <CardDescription>
                      {proposal.changes.length} suggested change{proposal.changes.length === 1 ? "" : "s"}
                      {proposal.model && ` · ${proposal.model}`}
                      {proposal.requestedBy && ` · asked for by ${proposal.requestedBy.name}`}
                      {pending && proposal.expiresAt && (
                        <>
                          {" · "}
                          <span className={cn(expiring && "text-warning")}>
                            expires {new Date(proposal.expiresAt).toLocaleDateString()}
                          </span>
                        </>
                      )}
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>

              <CardContent className="grid gap-3">
                {proposal.rationale && (
                  <div className="rounded-lg border border-border bg-muted/30 p-2.5">
                    <p className="text-xs text-muted-foreground">{proposal.rationale}</p>
                  </div>
                )}

                {pending && (
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="text-muted-foreground">
                      {accepted} of {proposal.changes.length} selected
                    </span>
                    <Button size="sm" variant="ghost" className="h-6" onClick={() => setAll(proposal, true)}>
                      <Check className="mr-1 h-3 w-3" />
                      Select all
                    </Button>
                    <Button size="sm" variant="ghost" className="h-6" onClick={() => setAll(proposal, false)}>
                      <X className="mr-1 h-3 w-3" />
                      Clear
                    </Button>
                  </div>
                )}

                <div className="grid gap-1.5">
                  {proposal.changes.map((change) => {
                    const isAccepted = decisions[proposal.id]?.[change.id] ?? change.accepted ?? false;
                    return (
                      <div
                        key={change.id}
                        className={cn(
                          "grid gap-0.5 rounded border border-border px-2.5 py-2",
                          change.applyError && "border-warning/50 bg-warning/5",
                          change.appliedAt && "border-success/40 bg-success/5"
                        )}
                      >
                        <div className="flex items-start gap-2">
                          {pending ? (
                            <Checkbox
                              className="mt-0.5"
                              checked={isAccepted}
                              onCheckedChange={(v) => setRow(proposal.id, change.id, Boolean(v))}
                            />
                          ) : change.appliedAt ? (
                            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                          ) : change.applyError ? (
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                          ) : (
                            <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                          )}

                          <div className="grid min-w-0 flex-1 gap-0.5">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <Badge variant="outline" className="text-[10px]">
                                {change.op === "CREATE" ? "new" : change.op === "LINK" ? "dependency" : "change"}
                              </Badge>
                              <span className="text-xs">{change.summary}</span>
                            </div>
                            <ChangeDiff change={change} />
                            {change.applyError && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <p className="text-[11px] text-warning">Not applied — {change.applyError}</p>
                                </TooltipTrigger>
                                <TooltipContent className="max-w-xs">
                                  <span className="text-xs">
                                    The underlying item changed after this was suggested. Applying it would have
                                    reverted somebody else&apos;s edit, so it was left alone.
                                  </span>
                                </TooltipContent>
                              </Tooltip>
                            )}
                          </div>

                          {change.targetId && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 shrink-0 px-1.5"
                              onClick={() => navigate(`/app/tickets?open=${change.targetId}`)}
                            >
                              <ChevronRight className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {pending && canApply && (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      disabled={accepted === 0 || apply.isPending}
                      onClick={() => apply.mutate({ id: proposal.id, map: decisions[proposal.id] ?? {} })}
                    >
                      {apply.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
                      Apply {accepted} change{accepted === 1 ? "" : "s"}
                    </Button>
                    <Button size="sm" variant="outline" disabled={reject.isPending} onClick={() => reject.mutate(proposal.id)}>
                      Dismiss
                    </Button>
                  </div>
                )}

                {!pending && canApply && (proposal.status === "APPLIED" || proposal.status === "PARTIALLY_APPLIED") && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={undo.isPending}
                      onClick={() => undo.mutate(proposal.id)}
                    >
                      {undo.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
                      Undo
                    </Button>
                    {/* Said plainly, because it is the reason undo is safe to offer at all rather
                        than a caveat: anything edited since is left exactly as it is. */}
                    <span className="text-xs text-muted-foreground">
                      Puts these changes back. Anything edited since is left alone.
                    </span>
                  </div>
                )}

                {pending && !canApply && (
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    Applying a suggestion needs the plan permission.
                  </p>
                )}
              </CardContent>
            </Card>
          );
        })
      )}
    </div>
  );
}
