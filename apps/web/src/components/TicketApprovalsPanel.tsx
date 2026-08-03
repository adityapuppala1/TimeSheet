/**
 * WHAT: the "Approvals" tab on the ticket detail sheet — the chains open on this work item, who
 * they are waiting on, and the controls to decide or to hand an external reviewer a link.
 *
 * WHY THE PANEL SHOWS WHOSE TURN IT IS RATHER THAN JUST A LIST OF NAMES: a sequential chain's
 * whole point is order, and a flat list of five approvers tells nobody whether anything is
 * blocked on them right now. The active step is marked, and everything after it reads as
 * "waiting" rather than as an outstanding task for that person.
 *
 * WHY A GUEST LINK IS COPIED, NOT EMAILED FROM HERE: the workspace may not have a mail server
 * configured, and an approval that silently failed to send is worse than one the requester
 * knowingly pastes into their own email. Reissuing always mints a fresh token and kills the
 * previous one, which the button says out loud.
 *
 * WHO renders this: the Approvals tab in `pages/Tickets.tsx`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Clock, Copy, Loader2, Plus, ShieldCheck, ThumbsDown, ThumbsUp, Trash2, XCircle } from "lucide-react";
import { useState } from "react";
import { permissions } from "@timesheet/shared";
import { cn } from "../lib/utils";
import { usePlanningFeatures } from "../lib/use-planning";
import { approvalApi, userApi, type ApprovalRequestRow, type ApprovalStepRow } from "../services/api";
import { useAuthStore } from "../store/auth";
import { Avatar, AvatarFallback } from "./ui/avatar";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Skeleton } from "./ui/skeleton";
import { Switch } from "./ui/switch";
import { Textarea } from "./ui/textarea";
import { toast } from "./ui/toaster";

const serverMessage = (err: any, fallback: string) => err?.response?.data?.message ?? fallback;

const initials = (name?: string) =>
  (name ?? "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");

/** Which steps the chain is actually waiting on — mirrors `activeSteps` on the server so the
 *  badge and the API agree about whose turn it is. */
function activeStepIds(request: ApprovalRequestRow): Set<string> {
  const pending = request.steps.filter((s) => s.decision === "PENDING").sort((a, b) => a.order - b.order);
  if (pending.length === 0) return new Set();
  if (!request.isSequential) return new Set(pending.map((s) => s.id));
  const lowest = pending[0].order;
  return new Set(pending.filter((s) => s.order === lowest).map((s) => s.id));
}

export function TicketApprovalsPanel({ ticketId }: { ticketId: string }) {
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();
  const { features } = usePlanningFeatures();
  const canManage = Boolean(user?.permissions.includes(permissions.APPROVALS_MANAGE));

  const [creating, setCreating] = useState(false);
  const [comment, setComment] = useState<Record<string, string>>({});

  const requests = useQuery({
    queryKey: ["approvals", ticketId],
    queryFn: () => approvalApi.forTicket(ticketId),
    enabled: features.approvals
  });

  const decide = useMutation({
    mutationFn: ({ stepId, decision }: { stepId: string; decision: "APPROVED" | "REJECTED" }) =>
      approvalApi.decide(stepId, decision, comment[stepId]),
    onSuccess: (_r, vars) => {
      toast.success(vars.decision === "APPROVED" ? "Approved" : "Changes requested");
      queryClient.invalidateQueries({ queryKey: ["approvals", ticketId] });
    },
    onError: (err: any) => toast.error("Could not record that", { description: serverMessage(err, "Try again.") })
  });

  const cancel = useMutation({
    mutationFn: (id: string) => approvalApi.cancel(id),
    onSuccess: () => {
      toast.success("Approval cancelled");
      queryClient.invalidateQueries({ queryKey: ["approvals", ticketId] });
    },
    onError: (err: any) => toast.error("Could not cancel", { description: serverMessage(err, "Try again.") })
  });

  const reissue = useMutation({
    mutationFn: (stepId: string) => approvalApi.resendGuestLink(stepId),
    onSuccess: (result) => {
      navigator.clipboard?.writeText(result.url);
      toast.success("New link copied", { description: "The previous link stopped working just now." });
      queryClient.invalidateQueries({ queryKey: ["approvals", ticketId] });
    },
    onError: (err: any) => toast.error("Could not create a link", { description: serverMessage(err, "Try again.") })
  });

  if (!features.approvals) {
    return (
      <div className="rounded-lg border border-dashed border-border p-6 text-center">
        <ShieldCheck className="mx-auto h-6 w-6 text-muted-foreground" />
        <p className="mt-2 text-sm font-medium">Approvals aren&apos;t switched on</p>
        <p className="mt-1 text-xs text-muted-foreground">
          A super admin can enable them in Workspace Settings → Planning. Timesheet approval is separate and unaffected.
        </p>
      </div>
    );
  }

  if (requests.isLoading) return <Skeleton className="h-40 w-full" />;
  const rows = requests.data ?? [];

  return (
    <div className="grid gap-4">
      {rows.length === 0 && !creating && (
        <div className="rounded-lg border border-dashed border-border p-6 text-center">
          <ShieldCheck className="mx-auto h-6 w-6 text-muted-foreground" />
          <p className="mt-2 text-sm font-medium">No approvals on this item</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Ask colleagues or people outside the workspace to sign off on it.
          </p>
        </div>
      )}

      {rows.map((request) => {
        const active = activeStepIds(request);
        return (
          <div key={request.id} className="grid gap-2 rounded-lg border border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{request.title}</span>
                {request.status === "PENDING" && <Badge variant="warning">Waiting</Badge>}
                {request.status === "APPROVED" && <Badge variant="success">Approved</Badge>}
                {request.status === "REJECTED" && <Badge variant="destructive">Changes requested</Badge>}
                <Badge variant="outline">{request.isSequential ? "In order" : "All at once"}</Badge>
              </div>
              {canManage && request.status === "PENDING" && (
                <Button size="sm" variant="ghost" className="h-7" disabled={cancel.isPending} onClick={() => cancel.mutate(request.id)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>

            {request.description && <p className="text-xs text-muted-foreground">{request.description}</p>}

            <div className="grid gap-1.5">
              {request.steps.map((step) => (
                <StepRow
                  key={step.id}
                  step={step}
                  isActive={active.has(step.id)}
                  isMine={step.approver?.id === user?.id}
                  canManage={canManage}
                  comment={comment[step.id] ?? ""}
                  onComment={(value) => setComment((c) => ({ ...c, [step.id]: value }))}
                  onDecide={(decision) => decide.mutate({ stepId: step.id, decision })}
                  deciding={decide.isPending}
                  onReissue={() => reissue.mutate(step.id)}
                  reissuing={reissue.isPending}
                />
              ))}
            </div>
          </div>
        );
      })}

      {canManage &&
        (creating ? (
          <NewApprovalForm ticketId={ticketId} onDone={() => setCreating(false)} />
        ) : (
          <Button size="sm" variant="outline" className="justify-self-start" onClick={() => setCreating(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Request approval
          </Button>
        ))}
    </div>
  );
}

function StepRow({
  step,
  isActive,
  isMine,
  canManage,
  comment,
  onComment,
  onDecide,
  deciding,
  onReissue,
  reissuing
}: {
  step: ApprovalStepRow;
  isActive: boolean;
  isMine: boolean;
  canManage: boolean;
  comment: string;
  onComment: (v: string) => void;
  onDecide: (d: "APPROVED" | "REJECTED") => void;
  deciding: boolean;
  onReissue: () => void;
  reissuing: boolean;
}) {
  const label = step.approver?.name ?? step.guestEmail ?? "Unassigned";
  return (
    <div className={cn("grid gap-1.5 rounded border border-border px-2.5 py-2", isActive && "border-warning/50 bg-warning/5")}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Avatar className="h-5 w-5">
          <AvatarFallback className="text-[9px]">{initials(label)}</AvatarFallback>
        </Avatar>
        <span className="font-medium">{label}</span>
        {step.guestEmail && <Badge variant="outline">External</Badge>}

        {step.decision === "APPROVED" && (
          <span className="inline-flex items-center gap-1 text-success">
            <CheckCircle2 className="h-3.5 w-3.5" /> Approved
          </span>
        )}
        {step.decision === "REJECTED" && (
          <span className="inline-flex items-center gap-1 text-destructive">
            <XCircle className="h-3.5 w-3.5" /> Changes requested
          </span>
        )}
        {step.decision === "PENDING" &&
          (isActive ? (
            <Badge variant="warning">Their turn</Badge>
          ) : (
            // Not an outstanding task for this person yet — saying so stops a five-name chain
            // reading as five people who are all late.
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <Clock className="h-3.5 w-3.5" /> Waiting
            </span>
          ))}

        {step.decision === "PENDING" && step.guestEmail && canManage && isActive && (
          <Button size="sm" variant="ghost" className="ml-auto h-6 px-1.5" disabled={reissuing} onClick={onReissue}>
            <Copy className="mr-1 h-3 w-3" />
            {step.hasGuestLink ? "New link" : "Get link"}
          </Button>
        )}
      </div>

      {step.comment && <p className="pl-7 text-xs text-muted-foreground">&ldquo;{step.comment}&rdquo;</p>}

      {isMine && isActive && step.decision === "PENDING" && (
        <div className="grid gap-1.5 pl-7">
          <Textarea rows={2} className="text-xs" value={comment} placeholder="Comment (optional)" onChange={(e) => onComment(e.target.value)} />
          <div className="flex gap-2">
            <Button size="sm" className="h-7" disabled={deciding} onClick={() => onDecide("APPROVED")}>
              <ThumbsUp className="mr-1.5 h-3 w-3" />
              Approve
            </Button>
            <Button size="sm" variant="outline" className="h-7" disabled={deciding} onClick={() => onDecide("REJECTED")}>
              <ThumbsDown className="mr-1.5 h-3 w-3" />
              Request changes
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function NewApprovalForm({ ticketId, onDone }: { ticketId: string; onDone: () => void }) {
  const queryClient = useQueryClient();
  const users = useQuery({ queryKey: ["users"], queryFn: () => userApi.list() });
  const [title, setTitle] = useState("");
  const [isSequential, setIsSequential] = useState(true);
  const [steps, setSteps] = useState<Array<{ approverId?: string; guestEmail?: string }>>([{}]);

  const create = useMutation({
    mutationFn: () =>
      approvalApi.create({
        ticketId,
        title: title.trim(),
        isSequential,
        steps: steps.map((s, i) => ({ approverId: s.approverId ?? null, guestEmail: s.guestEmail?.trim() || null, order: i }))
      }),
    onSuccess: () => {
      toast.success("Approval requested");
      queryClient.invalidateQueries({ queryKey: ["approvals", ticketId] });
      onDone();
    },
    onError: (err: any) => toast.error("Could not request approval", { description: serverMessage(err, "Try again.") })
  });

  // Mirrors the server rule: exactly one approver per step, never both and never neither.
  const invalid = !title.trim() || steps.some((s) => Boolean(s.approverId) === Boolean(s.guestEmail?.trim()));

  return (
    <div className="grid gap-3 rounded-lg border border-dashed border-border p-3">
      <div className="grid gap-1.5">
        <Label className="text-xs">What are they signing off?</Label>
        <Input value={title} placeholder="Sign off the final design" onChange={(e) => setTitle(e.target.value)} />
      </div>

      <label className="flex items-center gap-2 text-xs">
        <Switch checked={isSequential} onCheckedChange={setIsSequential} />
        Ask one at a time, in order
      </label>

      <div className="grid gap-2">
        {steps.map((step, index) => (
          <div key={index} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-center">
            <Select
              value={step.approverId ?? "__none__"}
              onValueChange={(v) =>
                setSteps((current) => current.map((s, i) => (i === index ? { approverId: v === "__none__" ? undefined : v } : s)))
              }
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="A colleague" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">— none —</SelectItem>
                {(users.data ?? []).map((u: any) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              className="h-8 text-xs"
              placeholder="…or an external email"
              value={step.guestEmail ?? ""}
              onChange={(e) => setSteps((current) => current.map((s, i) => (i === index ? { guestEmail: e.target.value } : s)))}
            />
            <Button
              size="sm"
              variant="ghost"
              className="h-8 px-1.5"
              disabled={steps.length === 1}
              onClick={() => setSteps((current) => current.filter((_, i) => i !== index))}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
        <Button size="sm" variant="outline" className="justify-self-start" onClick={() => setSteps([...steps, {}])}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          Add approver
        </Button>
      </div>

      <p className="text-[11px] text-muted-foreground">
        Each step needs exactly one approver — a colleague or an email address, not both. External reviewers get a
        single-use link that needs no account.
      </p>

      <div className="flex gap-2">
        <Button size="sm" disabled={invalid || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
          Request
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
