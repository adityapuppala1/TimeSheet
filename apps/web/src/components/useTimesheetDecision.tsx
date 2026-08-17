/**
 * WHAT: approving, rejecting and submitting ONE timesheet entry — the mutations, the identity
 * gate, the reject-reason prompt, and the cache invalidation, as a hook plus the dialogs it needs.
 *
 * WHY IT IS A HOOK AND NOT PAGE CODE: deciding used to live entirely inside the approvals page, so
 * the entry dialog could only decide when the approvals page happened to be the thing that opened
 * it. Opening the same entry from the dashboard's day timeline gave you the full record and no way
 * to act on it — you read the entry, agreed with it, and then navigated to a different screen to
 * find the same row and click Approve there.
 *
 * Copying the logic into the second caller was the obvious move and the wrong one: approving is
 * face-gated on some workspaces, freezes a billing rate, and notifies the submitter. Two copies of
 * that is two things to keep in step, and the one that drifts is the one nobody is looking at.
 *
 * WHAT IT DELIBERATELY DOES NOT OWN: the approvals page's BULK decisions. Those have their own
 * per-row-independence semantics and their own single-verification-covers-the-batch rule (see
 * `PATCH /timesheets/decide-bulk`), and folding them in here would make this hook the union of two
 * different problems rather than one shared answer to the smaller one.
 *
 * WHO USES THIS: components/TimesheetEntryDialog.tsx (which any page can render), and through it
 * pages/Dashboard.tsx, pages/History.tsx and pages/AdminPages.tsx.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ShieldX } from "lucide-react";
import { useState } from "react";
import { timesheetApi, type TimesheetEntryDetail } from "../services/api";
import { useAuthStore } from "../store/auth";
import { useFaceStatus } from "../lib/use-face-status";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "./ui/dialog";
import { FaceVerificationDialog } from "./FaceVerificationDialog";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import { toast } from "./ui/toaster";

function serverMessage(err: any, fallback: string): string {
  return err?.response?.data?.message ?? fallback;
}

export interface UseTimesheetDecisionOptions {
  /** Called after a decision or a submit lands — the caller usually closes its detail view, whose
   *  snapshot is about to be stale. */
  onSettled?: () => void;
}

export function useTimesheetDecision({ onSettled }: UseTimesheetDecisionOptions = {}) {
  const queryClient = useQueryClient();
  const currentUser = useAuthStore((s) => s.user);
  const faceStatus = useFaceStatus();

  const [rejectTarget, setRejectTarget] = useState<{ id: string; user: string } | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  /** Parked while an identity check runs — the entry id the check is FOR. */
  const [pendingApproveId, setPendingApproveId] = useState<string | null>(null);
  const [pendingSubmitId, setPendingSubmitId] = useState<string | null>(null);

  /** Every surface that lists entries reads one of these three. */
  const invalidate = (id?: string) => {
    if (id) queryClient.invalidateQueries({ queryKey: ["timesheet", id] });
    queryClient.invalidateQueries({ queryKey: ["timesheets"] });
    queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  };

  const approve = useMutation({
    mutationFn: ({ id, faceVerificationId }: { id: string; faceVerificationId?: string }) =>
      timesheetApi.approve(id, faceVerificationId),
    onSuccess: (_data, { id }) => {
      toast.success("Approved", { description: "The employee gets an in-app and email confirmation." });
      invalidate(id);
      onSettled?.();
    },
    onError: (err: any) => toast.error("Approval failed", { description: serverMessage(err, "Try again.") })
  });

  const reject = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => timesheetApi.reject(id, reason),
    onSuccess: (_data, { id }) => {
      toast.success("Rejected with reason", { description: "The submitter has been notified." });
      setRejectTarget(null);
      setRejectReason("");
      invalidate(id);
      onSettled?.();
    },
    onError: (err: any) => toast.error("Rejection failed", { description: serverMessage(err, "Try again.") })
  });

  const submit = useMutation({
    mutationFn: ({ id, faceVerificationId }: { id: string; faceVerificationId?: string }) =>
      timesheetApi.submitDraft(id, faceVerificationId),
    onSuccess: (_data, { id }) => {
      toast.success("Sent for approval", { description: "Your approver has been notified." });
      invalidate(id);
      onSettled?.();
    },
    onError: (err: any) => toast.error("Could not submit", { description: serverMessage(err, "Try again.") })
  });

  /** Approving is where hours become payable, so it is the action the workspace may gate on a
   *  live identity check. Rejection is deliberately ungated — it moves no money, and demanding a
   *  webcam capture to DECLINE something only discourages review. */
  const requestApprove = (entry: Pick<TimesheetEntryDetail, "id">) => {
    if (faceStatus.data?.requiredForApproval) {
      setPendingApproveId(entry.id);
      return;
    }
    approve.mutate({ id: entry.id });
  };

  const requestReject = (entry: TimesheetEntryDetail) => {
    setRejectTarget({ id: entry.id, user: entry.user?.name ?? "this entry" });
  };

  /** Submitting a draft is gated the same way creating a submitted entry is — the check asserts
   *  who stands behind the hours entering the queue. */
  const requestSubmit = (entry: Pick<TimesheetEntryDetail, "id">) => {
    if (faceStatus.data?.requiredForTimesheet) {
      setPendingSubmitId(entry.id);
      return;
    }
    submit.mutate({ id: entry.id });
  };

  const canDecide = Boolean(currentUser?.permissions.includes("timesheets:approve" as never));

  /**
   * The dialogs this hook needs on screen. Rendered by the caller so they land at the top level of
   * its tree rather than nested inside the entry dialog — two stacked Radix dialogs sharing a
   * focus trap is how a phone ends up with no visible way back.
   */
  const dialogs = (
    <>
      <Dialog
        open={!!rejectTarget}
        onOpenChange={(open) => {
          if (!open) {
            setRejectTarget(null);
            setRejectReason("");
          }
        }}
      >
        <DialogContent className="w-[min(95vw,520px)] max-w-none">
          <DialogHeader>
            <DialogTitle>Reject {rejectTarget?.user}'s timesheet</DialogTitle>
            <DialogDescription>
              Give a clear reason — it is shown to the employee and recorded in the audit log. They cannot rewrite the
              rejected entry, so the reason has to say what a fresh one should do differently.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="decision-reject-reason">Rejection reason</Label>
            <Textarea
              id="decision-reject-reason"
              rows={4}
              value={rejectReason}
              onChange={(event) => setRejectReason(event.target.value)}
              placeholder="e.g. Activity should be 'Bug Fixing' rather than 'Development' for this ticket."
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setRejectTarget(null);
                setRejectReason("");
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={rejectReason.trim().length < 5 || reject.isPending}
              onClick={() => rejectTarget && reject.mutate({ id: rejectTarget.id, reason: rejectReason.trim() })}
            >
              <ShieldX className="h-4 w-4" />Confirm rejection
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <FaceVerificationDialog
        open={pendingApproveId !== null}
        onOpenChange={(open) => !open && setPendingApproveId(null)}
        context="APPROVAL"
        actionLabel="approve this timesheet"
        onVerified={(verificationId) => {
          const id = pendingApproveId;
          setPendingApproveId(null);
          if (id) approve.mutate({ id, faceVerificationId: verificationId });
        }}
      />

      <FaceVerificationDialog
        open={pendingSubmitId !== null}
        onOpenChange={(open) => !open && setPendingSubmitId(null)}
        context="TIMESHEET"
        actionLabel="submit this timesheet"
        onVerified={(verificationId) => {
          const id = pendingSubmitId;
          setPendingSubmitId(null);
          if (id) submit.mutate({ id, faceVerificationId: verificationId });
        }}
      />
    </>
  );

  return {
    canDecide,
    requestApprove,
    requestReject,
    requestSubmit,
    isDeciding: approve.isPending || reject.isPending,
    isSubmitting: submit.isPending,
    dialogs
  };
}

export type TimesheetDecisionState = ReturnType<typeof useTimesheetDecision>;
