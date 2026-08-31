/**
 * The two-person queue (5.0.0): the irreversible console actions somebody has asked for, waiting
 * for a second operator to countersign.
 *
 * EVERY OPERATOR SEES THIS PAGE, not only the owners who can approve. A pending request to delete a
 * customer's workspace is not a secret from the people who work on that customer — hiding it would
 * mean the person best placed to say "wait, that is the wrong org" never learns it was asked. What
 * the role changes is which BUTTONS are here, not what is visible.
 *
 * THE APPROVE BUTTON IS ABSENT ON YOUR OWN REQUEST, and the server refuses it anyway. Both, on
 * purpose: the button's absence explains the rule, and the server's refusal is what enforces it. A
 * client-side check that is the only check is not a two-person rule, it is a suggestion.
 *
 * WHAT THE ROW SHOWS AND WHY IT SHOWS THE REASON PROMINENTLY: an approver is not being asked "is
 * this button safe", they are being asked "should this happen". The only input to that judgement is
 * what the requester said they were doing, so it is the largest text in the row rather than a
 * tooltip.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Clock, ShieldAlert, ThumbsDown } from "lucide-react";
import { useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Skeleton } from "../../components/ui/skeleton";
import { toast } from "../../components/ui/toaster";
import { platformAdminConsoleApi, type PendingPlatformActionRow } from "../../services/platform-admin-api";
import { usePlatformAdminAuthStore } from "../../store/platform-admin-auth";
import { ConsolePage, ConsoleSection, EmptyState, PRIMARY_BTN, shortDateTime } from "./console-ui";

function errorMessageOf(error: unknown): string {
  return (error as { response?: { data?: { message?: string } }; message?: string })?.response?.data?.message ?? (error as Error)?.message ?? "Try again.";
}

const STATUS_VARIANT: Record<PendingPlatformActionRow["status"], "success" | "warning" | "muted" | "destructive"> = {
  PENDING: "warning",
  APPROVED: "success",
  REJECTED: "muted",
  EXPIRED: "muted",
  FAILED: "destructive"
};

export function PlatformAdminApprovals() {
  const queryClient = useQueryClient();
  const me = usePlatformAdminAuthStore((s) => s.admin);
  const isOwner = me?.role === "OWNER";
  // Polled, unlike most of this console: somebody is waiting on the other side of this screen, and
  // a queue you have to reload to see is a queue that adds minutes to every deletion.
  const queue = useQuery({ queryKey: ["platform-admin", "approvals"], queryFn: () => platformAdminConsoleApi.approvals(), refetchInterval: 20_000 });
  const [rejecting, setRejecting] = useState<PendingPlatformActionRow | null>(null);
  const [note, setNote] = useState("");

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["platform-admin"] });

  const approve = useMutation({
    mutationFn: (id: string) => platformAdminConsoleApi.approveRequest(id),
    onSuccess: (result) => {
      invalidate();
      toast.success("Approved and done", { description: `${result.action} ran against the platform as it is now, not as it was when it was asked.` });
    },
    onError: (e) => toast.error("Not approved", { description: errorMessageOf(e) })
  });

  const reject = useMutation({
    mutationFn: (args: { id: string; note: string }) => platformAdminConsoleApi.rejectRequest(args.id, args.note),
    onSuccess: () => {
      setRejecting(null);
      setNote("");
      invalidate();
      toast.success("Refused");
    },
    onError: (e) => toast.error("Not refused", { description: errorMessageOf(e) })
  });

  const rows = queue.data ?? [];
  const pending = rows.filter((r) => r.status === "PENDING" && !r.expired);
  const settled = rows.filter((r) => r.status !== "PENDING" || r.expired);

  const card = (row: PendingPlatformActionRow) => (
    <li key={row.id} className="grid gap-3 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={row.expired && row.status === "PENDING" ? "muted" : STATUS_VARIANT[row.status]}>{row.expired && row.status === "PENDING" ? "EXPIRED" : row.status}</Badge>
        <span className="font-semibold">{row.label}</span>
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
          {row.method} {row.route}
        </code>
      </div>

      {/* The reason, first and largest. It is the only input an approver actually has. */}
      <p className="text-sm leading-6">“{row.reason}”</p>

      <p className="text-xs text-muted-foreground">
        Asked by <span className="font-medium text-foreground">{row.requestedByLabel}</span> · {shortDateTime(row.requestedAt)}
        {row.status === "PENDING" && !row.expired && (
          <>
            {" · "}
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3 w-3" />expires {shortDateTime(row.expiresAt)}
            </span>
          </>
        )}
        {row.approvedByLabel && ` · ${row.status === "REJECTED" ? "refused" : "decided"} by ${row.approvedByLabel}`}
        {row.resolutionNote && ` — ${row.resolutionNote}`}
      </p>

      {row.status === "PENDING" && !row.expired && (
        <div className="flex flex-wrap gap-2">
          {row.isMine ? (
            <p className="text-xs text-muted-foreground">
              You raised this. Somebody else has to approve it — that is the whole point of the second signature. You can withdraw it below.
            </p>
          ) : (
            isOwner && (
              <Button size="sm" className={`gap-1.5 ${PRIMARY_BTN}`} disabled={approve.isPending} onClick={() => approve.mutate(row.id)}>
                <CheckCircle2 className="h-3.5 w-3.5" />Approve and run
              </Button>
            )
          )}
          {(row.isMine || isOwner) && (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={() => {
                setRejecting(row);
                setNote("");
              }}
            >
              <ThumbsDown className="h-3.5 w-3.5" />
              {row.isMine ? "Withdraw" : "Refuse"}
            </Button>
          )}
        </div>
      )}
    </li>
  );

  return (
    <ConsolePage
      eyebrow="Platform"
      title="Approvals"
      description="The console actions that cannot be undone — deleting a workspace, restoring over one, deleting a snapshot, creating an operator, changing a role. Each waits for a second owner, and runs against the platform as it is at the moment of approval, not as it was when it was asked."
    >
      <ConsoleSection title="Waiting" description={isOwner ? "Approve one and it runs immediately, through the same handler and the same guards as a direct request." : "Only an owner can countersign. You can still see everything that is waiting, and withdraw your own."}>
        {queue.isLoading && <Skeleton className="h-32 w-full" />}
        {!queue.isLoading && pending.length === 0 && (
          <EmptyState icon={ShieldAlert} title="Nothing waiting" description="Irreversible actions land here when somebody asks for one." />
        )}
        {pending.length > 0 && <ul className="grid gap-3">{pending.map(card)}</ul>}
      </ConsoleSection>

      {settled.length > 0 && (
        <ConsoleSection title="Decided" description="What was approved, refused, expired unanswered, or failed when it ran.">
          <ul className="grid gap-3">{settled.map(card)}</ul>
        </ConsoleSection>
      )}

      <Dialog open={Boolean(rejecting)} onOpenChange={(open) => !open && setRejecting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{rejecting?.isMine ? "Withdraw this request" : "Refuse this request"}</DialogTitle>
            <DialogDescription>
              Recorded against the request and in the audit trail. Saying no is a decision worth a sentence — the person who asked will read it.
            </DialogDescription>
          </DialogHeader>
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Wrong workspace — they meant acme-staging." />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejecting(null)}>
              Cancel
            </Button>
            <Button className={PRIMARY_BTN} disabled={note.trim().length < 1 || reject.isPending} onClick={() => rejecting && reject.mutate({ id: rejecting.id, note: note.trim() })}>
              {rejecting?.isMine ? "Withdraw" : "Refuse"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConsolePage>
  );
}
