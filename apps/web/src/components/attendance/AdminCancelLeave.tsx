/**
 * 7.0.0 — an administrator (ADMIN or SUPER_ADMIN) cancels someone else's approved leave, with a REQUIRED comment.
 *
 * The API (POST /leave/me/requests/:id/cancel with { comment }) answers 422
 * LEAVE_CANCEL_COMMENT_REQUIRED without one; the comment is told to the person and audited. The
 * button stays disabled until the comment has text, so the 422 is the backstop, not the UX.
 *
 * Only an ADMIN or SUPER_ADMIN can list every approved request (inbox scope=all), so only they see this card.
 * No reason or document is shown here: the list is name, type and dates.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarX2 } from "lucide-react";
import { useMemo, useState } from "react";
import { requestRangeText } from "../../lib/leave-ui";
import { runInBackground } from "../../lib/run-in-background";
import { leaveApi, type LeaveRequestRow } from "../../services/leave-api";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { EmptyState } from "../ui/empty-state";
import { Skeleton } from "../ui/skeleton";
import { Textarea } from "../ui/textarea";
import { toast } from "../ui/toaster";
import { CardError, SectionCard, todayKey } from "./attendance-ui";

const serverMessage = (err: unknown, fallback: string) => (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback;

/** Approved leave that has not yet ended (pure; exported for the unit test). */
export function cancellableByAdmin(rows: readonly LeaveRequestRow[], today: string): LeaveRequestRow[] {
  return rows.filter((r) => r.status === "APPROVED" && r.endDate.slice(0, 10) >= today).sort((a, b) => a.startDate.localeCompare(b.startDate));
}

export function AdminCancelLeave() {
  const queryClient = useQueryClient();
  const today = todayKey();
  const approved = useQuery({ queryKey: ["leave", "inbox", "approved-all"], queryFn: () => leaveApi.approvedAll(), staleTime: 30_000 });
  const rows = useMemo(() => cancellableByAdmin(approved.data?.items ?? [], today), [approved.data, today]);
  const [target, setTarget] = useState<LeaveRequestRow | null>(null);
  const [comment, setComment] = useState("");

  const cancel = useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) => leaveApi.cancelAsAdmin(id, text),
    onSuccess: () => {
      toast.success("Leave cancelled", { description: "The person is told, with your comment, and the days go back to their balance." });
      setTarget(null);
      setComment("");
      runInBackground(queryClient.invalidateQueries({ queryKey: ["leave"] }));
    },
    onError: (err) => toast.error("Could not cancel", { description: serverMessage(err, "Try again.") })
  });

  return (
    <SectionCard
      title="Cancel someone's approved leave"
      description="Administrators only. A comment is now required: it is sent to the person and kept in the audit log."
    >
      {approved.isLoading && <Skeleton className="h-20 w-full" />}
      {approved.isError && <CardError message="Approved leave could not be loaded." onRetry={() => runInBackground(approved.refetch())} />}
      {approved.data && rows.length === 0 && <EmptyState compact icon={CalendarX2} title="No upcoming approved leave" description="Approved leave that has not ended shows up here." />}
      {rows.length > 0 && (
        <ul className="grid gap-2">
          {rows.map((r) => (
            <li key={r.id} className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-border p-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{r.user?.name ?? "Someone"}</p>
                <p className="text-xs text-muted-foreground">
                  {r.leaveType.name} ({r.leaveType.code}), {requestRangeText(r)}
                </p>
              </div>
              <Button variant="outline" size="sm" className="min-h-[44px] sm:min-h-8" onClick={() => { setTarget(r); setComment(""); }}>
                Cancel leave…
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={Boolean(target)} onOpenChange={(o) => !o && setTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel {target?.user?.name ?? "this person"}'s leave?</DialogTitle>
            <DialogDescription>
              {target ? `${target.leaveType.name}, ${requestRangeText(target)}. ` : ""}The days go back to their balance. Leave that has already started can be cancelled too.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <label htmlFor="admin-cancel-comment" className="text-sm font-medium">
              Comment (required)
            </label>
            <Textarea
              id="admin-cancel-comment"
              rows={3}
              maxLength={500}
              autoFocus
              value={comment}
              aria-describedby="admin-cancel-hint"
              onChange={(e) => setComment(e.target.value)}
            />
            <p id="admin-cancel-hint" className="text-xs text-muted-foreground">
              Say why. The person sees this comment.
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" className="min-h-[44px]" onClick={() => setTarget(null)}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              className="min-h-[44px]"
              disabled={!comment.trim() || cancel.isPending}
              onClick={() => target && cancel.mutate({ id: target.id, text: comment.trim() })}
            >
              Cancel leave
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionCard>
  );
}
