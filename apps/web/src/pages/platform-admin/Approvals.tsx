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
 *
 * AN APPROVAL THAT ISSUES A PASSWORD SHOWS IT HERE, ONCE (H5). Creating or reactivating an operator
 * returns a generated temporary password to the approver and nobody else; the server keeps only a
 * hash. This page used to show a toast and discard it, so every new operator account was unusable.
 * It is held in component state for the dialog and nowhere else — closing the dialog is the end of it.
 *
 * A RETENTION-POLICY CHANGE SHOWS WHAT IT CHANGES (R1-3): each field old → new, and what it loosens,
 * because a reason is the requester's summary and the values are the decision. See RetentionChange.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Clock, Copy, KeyRound, ShieldAlert, ThumbsDown } from "lucide-react";
import { useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Skeleton } from "../../components/ui/skeleton";
import { toast } from "../../components/ui/toaster";
import { platformAdminConsoleApi, type PendingPlatformActionRow } from "../../services/platform-admin-api";
import { usePlatformAdminAuthStore } from "../../store/platform-admin-auth";
import { issuedCredentialOf, retentionApprovalOf } from "../../lib/platform-console";
import { ConsolePage, ConsoleSection, EmptyState, PRIMARY_BTN, shortDateTime } from "./console-ui";
import { runInBackground } from "../../lib/run-in-background";

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

/** The queued policy change, field by field, then what it loosens — the server's own sentences. */
function RetentionChange({ change }: { change: NonNullable<ReturnType<typeof retentionApprovalOf>> }) {
  return (
    <div className="grid gap-2 rounded-lg border bg-muted/40 p-3 text-sm">
      <ul className="grid gap-1">
        {change.changes.map((c) => (
          <li key={c.label} className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <span className="text-muted-foreground">{c.label}</span>
            <span className="break-all font-mono text-xs">{c.from}</span>
            <span aria-hidden>→</span>
            <span className="sr-only">changes to</span>
            <span className="break-all font-mono text-xs font-semibold">{c.to}</span>
          </li>
        ))}
      </ul>
      {change.risks.length > 0 && (
        <ul className="grid gap-1 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs">
          {change.risks.map((risk) => (
            <li key={risk} className="flex gap-1.5">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
              <span>This {risk}.</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function PlatformAdminApprovals() {
  const queryClient = useQueryClient();
  const me = usePlatformAdminAuthStore((s) => s.admin);
  const isOwner = me?.role === "OWNER";
  // Polled, unlike most of this console: somebody is waiting on the other side of this screen, and
  // a queue you have to reload to see is a queue that adds minutes to every deletion.
  const queue = useQuery({ queryKey: ["platform-admin", "approvals"], queryFn: () => platformAdminConsoleApi.approvals(), refetchInterval: 20_000 });
  const [rejecting, setRejecting] = useState<PendingPlatformActionRow | null>(null);
  const [note, setNote] = useState("");
  const [issued, setIssued] = useState<ReturnType<typeof issuedCredentialOf>>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["platform-admin"] });

  const approve = useMutation({
    mutationFn: (id: string) => platformAdminConsoleApi.approveRequest(id),
    onSuccess: (result) => {
      void invalidate();
      const credential = issuedCredentialOf(result);
      if (credential) setIssued(credential);
      else toast.success("Approved and done", { description: `${result.action} ran against the platform as it is now, not as it was when it was asked.` });
    },
    onError: (e) => toast.error("Not approved", { description: errorMessageOf(e) })
  });

  const reject = useMutation({
    mutationFn: (args: { id: string; note: string }) => platformAdminConsoleApi.rejectRequest(args.id, args.note),
    onSuccess: () => {
      setRejecting(null);
      setNote("");
      void invalidate();
      toast.success("Refused");
    },
    onError: (e) => toast.error("Not refused", { description: errorMessageOf(e) })
  });

  const rows = queue.data ?? [];
  const pending = rows.filter((r) => r.status === "PENDING" && !r.expired);
  const settled = rows.filter((r) => r.status !== "PENDING" || r.expired);

  const card = (row: PendingPlatformActionRow) => {
    const retention = retentionApprovalOf(row);
    return (
      <li key={row.id} className="grid gap-3 rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={row.expired && row.status === "PENDING" ? "muted" : STATUS_VARIANT[row.status]}>{row.expired && row.status === "PENDING" ? "EXPIRED" : row.status}</Badge>
          <span className="font-semibold">{row.label}</span>
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
            {row.method} {row.route}
          </code>
        </div>

        {/* The reason, first and largest — then, for a policy change, the values it is a summary of. */}
        <p className="text-sm leading-6">“{row.reason}”</p>
        {retention && <RetentionChange change={retention} />}

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
  };

  return (
    <ConsolePage
      eyebrow="Platform"
      title="Approvals"
      description="The console actions one person must not take alone — deleting a workspace, restoring over one, deleting a snapshot, loosening the retention policy, creating, promoting or reactivating an operator. Each waits for a second owner, and runs against the platform as it is at the moment of approval, not as it was when it was asked."
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

      <Dialog open={Boolean(issued)} onOpenChange={(open) => !open && setIssued(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-accent" />
              Approved — a one-time password was issued
            </DialogTitle>
            <DialogDescription>
              For <span className="font-medium text-foreground">{issued?.name ? `${issued.name} (${issued.email})` : issued?.email}</span>. This is the only time it is shown: the server keeps a
              hash, not the password.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 select-all break-all rounded-md border border-accent/40 bg-muted px-3 py-2 font-mono text-sm">{issued?.temporaryPassword}</code>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 gap-1.5"
              onClick={() => {
                if (issued) runInBackground(navigator.clipboard?.writeText(issued.temporaryPassword) ?? Promise.resolve());
                toast.success("Copied");
              }}
            >
              <Copy className="h-3.5 w-3.5" />Copy
            </Button>
          </div>
          <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs text-foreground">
            Share it securely — in person, by phone, or through a password manager; never in the same channel as their email address. They will be made to choose their own password at first sign-in,
            and the console stays closed to them until they do.
          </p>
          <DialogFooter>
            <Button className={PRIMARY_BTN} onClick={() => setIssued(null)}>
              I have passed it on
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
