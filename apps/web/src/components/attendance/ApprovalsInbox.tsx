/**
 * The approvals inbox (V17 UI v2): the requests waiting on you, one ApprovalCard each, with a bulk
 * mode and a sticky action bar. Single approve and reject act at once; a bulk approve asks first
 * (the API cannot undo a decision, so an Undo toast would be a promise we cannot keep). The bulk
 * endpoint answers 207 with one result per request, and a partial failure is reported by name,
 * leaving the failures selected and annotated so they can be retried or read.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCheck, Inbox, ListChecks } from "lucide-react";
import { useMemo, useState } from "react";
import { overlapLine } from "../../lib/leave-ui";
import { addDayKeys } from "../../lib/attendance-calendar";
import { runInBackground } from "../../lib/run-in-background";
import { leaveApi, type BulkResult } from "../../services/leave-api";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { EmptyState } from "../ui/empty-state";
import { Skeleton } from "../ui/skeleton";
import { Textarea } from "../ui/textarea";
import { toast } from "../ui/toaster";
import { ApprovalCard } from "./ApprovalCard";
import { CardError, SectionCard, todayKey } from "./attendance-ui";

const INBOX_KEY = ["leave", "inbox", "PENDING"] as const;
const serverMessage = (err: unknown, fallback: string) => (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback;

export function ApprovalsInbox() {
  const queryClient = useQueryClient();
  const today = todayKey();
  const inbox = useQuery({ queryKey: INBOX_KEY, queryFn: () => leaveApi.inbox("PENDING") });
  const horizon = addDayKeys(today, 92);
  const team = useQuery({ queryKey: ["leave", "team", today, horizon], queryFn: () => leaveApi.team(today, horizon), staleTime: 30_000 });

  const [bulk, setBulk] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [confirmApprove, setConfirmApprove] = useState(false);
  const [rejectNote, setRejectNote] = useState<string | null>(null);

  const refresh = () => {
    runInBackground(queryClient.invalidateQueries({ queryKey: ["leave", "inbox"] }));
    runInBackground(queryClient.invalidateQueries({ queryKey: ["leave", "team"] }));
  };

  const single = useMutation({
    mutationFn: ({ id, decision, note }: { id: string; decision: "APPROVE" | "REJECT"; note?: string }) => leaveApi.decide(id, decision, note),
    onSuccess: (_r, v) => {
      toast.success(v.decision === "APPROVE" ? "Approved" : "Rejected");
      refresh();
    },
    onError: (err) => {
      toast.error("Could not record that decision", { description: serverMessage(err, "Try again.") });
      refresh();
    }
  });

  const many = useMutation({
    mutationFn: ({ ids, decision, note }: { ids: string[]; decision: "APPROVE" | "REJECT"; note?: string }) => leaveApi.bulkDecide(ids, decision, note),
    onSuccess: (results: BulkResult[], v) => {
      const failed = results.filter((r) => !r.ok);
      const ok = results.length - failed.length;
      const word = v.decision === "APPROVE" ? "approved" : "rejected";
      if (failed.length === 0) toast.success(`${ok} ${word}`);
      else toast.warning(`${ok} ${word}, ${failed.length} could not be`, { description: failed.map((f) => f.error).filter(Boolean).slice(0, 2).join(" ") });
      setFailures(Object.fromEntries(failed.map((f) => [f.id, f.error ?? "Could not be decided."])));
      setSelected(new Set(failed.map((f) => f.id)));
      setRejectNote(null);
      if (failed.length === 0) setBulk(false);
      refresh();
    },
    onError: (err) => toast.error("Bulk decision failed", { description: serverMessage(err, "Try again.") })
  });

  const items = useMemo(() => inbox.data?.items ?? [], [inbox.data]);
  const busy = single.isPending || many.isPending;

  const toggleBulk = () => {
    setBulk((b) => !b);
    setSelected(new Set());
    setFailures({});
    setRejectNote(null);
  };

  return (
    <SectionCard
      title="Approvals"
      description={items.length > 0 ? `${items.length} waiting on you` : "Leave requests waiting on you"}
      headingId="approvals-heading"
      action={
        items.length > 1 ? (
          <Button variant={bulk ? "secondary" : "outline"} size="sm" className="min-h-[44px] sm:min-h-8" onClick={toggleBulk} aria-pressed={bulk}>
            <ListChecks className="mr-1.5 h-4 w-4" aria-hidden="true" />
            {bulk ? "Done" : "Select"}
          </Button>
        ) : undefined
      }
    >
      {inbox.isLoading && (
        <div className="grid gap-2" aria-busy="true" aria-label="Loading approvals">
          <Skeleton className="h-36 w-full" />
          <Skeleton className="h-36 w-full" />
        </div>
      )}
      {inbox.isError && <CardError message="Approvals could not be loaded." onRetry={() => runInBackground(inbox.refetch())} />}
      {inbox.data && items.length === 0 && <EmptyState compact icon={Inbox} title="Nothing waiting" description="New leave requests from your team show up here." />}
      {items.length > 0 && (
        <ul className={`grid gap-2 ${bulk ? "pb-24" : ""}`}>
          {items.map((r) => (
            <ApprovalCard
              key={r.id}
              request={r}
              overlap={overlapLine(r, team.data ?? [])}
              busy={busy}
              selectable={bulk}
              selected={selected.has(r.id)}
              onSelect={(v) =>
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (v) next.add(r.id);
                  else next.delete(r.id);
                  return next;
                })
              }
              error={failures[r.id]}
              onApprove={() => single.mutate({ id: r.id, decision: "APPROVE" })}
              onReject={(note) => single.mutate({ id: r.id, decision: "REJECT", note })}
            />
          ))}
        </ul>
      )}

      {bulk && (
        <div className="sticky bottom-[calc(env(safe-area-inset-bottom)+4.5rem)] z-20 -mx-1 grid gap-2 rounded-lg border border-border bg-card p-3 shadow-lg lg:bottom-4" role="region" aria-label="Bulk actions">
          {rejectNote === null ? (
            <div className="flex flex-wrap items-center gap-2">
              <p className="mr-auto text-sm tabular-nums" aria-live="polite">
                {selected.size} selected
              </p>
              <Button variant="outline" className="min-h-[44px]" disabled={selected.size === 0 || busy} onClick={() => setRejectNote("")}>
                Reject {selected.size > 0 ? selected.size : ""}…
              </Button>
              <Button className="min-h-[44px]" disabled={selected.size === 0 || busy} onClick={() => setConfirmApprove(true)}>
                <CheckCheck className="mr-1.5 h-4 w-4" aria-hidden="true" />
                Approve {selected.size > 0 ? selected.size : ""}
              </Button>
            </div>
          ) : (
            <div className="grid gap-2">
              <label htmlFor="bulk-reject-note" className="text-xs font-medium">
                Comment for the {selected.size} people you are declining
              </label>
              <Textarea id="bulk-reject-note" rows={2} maxLength={500} autoFocus value={rejectNote} onChange={(e) => setRejectNote(e.target.value)} />
              <div className="flex gap-2">
                <Button variant="destructive" className="min-h-[44px] flex-1" disabled={!rejectNote.trim() || busy} onClick={() => many.mutate({ ids: [...selected], decision: "REJECT", note: rejectNote.trim() })}>
                  Reject {selected.size}
                </Button>
                <Button variant="ghost" className="min-h-[44px]" onClick={() => setRejectNote(null)}>
                  Back
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      <AlertDialog open={confirmApprove} onOpenChange={setConfirmApprove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Approve {selected.size} requests?</AlertDialogTitle>
            <AlertDialogDescription>Each person is notified and their balance is debited. A decision cannot be undone from here, so check the selection first.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Not yet</AlertDialogCancel>
            <AlertDialogAction onClick={() => many.mutate({ ids: [...selected], decision: "APPROVE" })}>Approve {selected.size}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SectionCard>
  );
}
