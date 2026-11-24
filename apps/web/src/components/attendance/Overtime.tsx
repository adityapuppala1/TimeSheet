/**
 * 7.0.0 overtime: timesheet hours above the expected day (the shift, else the workspace day) and week.
 *
 * - MyOvertimeCard (My attendance rail): the last weeks' overtime; with approval on, Claim / Cancel.
 * - OvertimeInbox (Team → approvals): claims waiting on you, approve / reject with a note.
 * - useOvertime: the switch as the signed-in person sees it (GET /attendance/me/today `overtime`).
 * Everything renders nothing while overtime is off. Claims carry no free-text reason, and nothing
 * here ranks people.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Inbox } from "lucide-react";
import { useState } from "react";
import { addDayKeys } from "../../lib/attendance-calendar";
import { runInBackground } from "../../lib/run-in-background";
import { overtimeApi, type OvertimeClaimRow, type OvertimeWeekRow } from "../../services/attendance-api";
import { useMyToday } from "../PunchIn";
import { Button } from "../ui/button";
import { EmptyState } from "../ui/empty-state";
import { Label } from "../ui/label";
import { Skeleton } from "../ui/skeleton";
import { Textarea } from "../ui/textarea";
import { toast } from "../ui/toaster";
import { CardError, SectionCard, todayKey } from "./attendance-ui";

const serverMessage = (err: unknown, fallback: string) => (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback;
export const OVERTIME_KEY = ["attendance", "overtime"] as const;
const STATUS_TEXT: Record<OvertimeClaimRow["status"], string> = { PENDING: "Waiting for approval", APPROVED: "Approved", REJECTED: "Rejected", CANCELLED: "Cancelled" };

/** The overtime switch as the signed-in person sees it: null while off. */
export function useOvertime(): { requireApproval: boolean } | null {
  const today = useMyToday();
  const o = today.data?.overtime;
  return o?.enabled ? { requireApproval: o.requireApproval } : null;
}

/** "2.5h" (pure). */
export function hoursText(h: number): string {
  return `${Math.round(h * 100) / 100}h`;
}

/** "Week of 2026-11-16 · 42h of 40h · 2h overtime" (pure). */
export function overtimeWeekLine(w: Pick<OvertimeWeekRow, "weekStart" | "workedHours" | "expectedHours" | "overtimeHours">): string {
  return `Week of ${w.weekStart} · ${hoursText(w.workedHours)} of ${hoursText(w.expectedHours)} · ${hoursText(w.overtimeHours)} overtime`;
}

/** May this week be claimed today? Over, overtime in it, and no open claim. Pure. */
export function canClaimWeek(w: Pick<OvertimeWeekRow, "weekStart" | "overtimeHours" | "claim">, today: string): boolean {
  return addDayKeys(w.weekStart, 6) < today && w.overtimeHours > 0 && !w.claim;
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => runInBackground(qc.invalidateQueries({ queryKey: OVERTIME_KEY }));
}

export function MyOvertimeCard() {
  const on = useOvertime();
  const invalidate = useInvalidate();
  const today = todayKey();
  const from = addDayKeys(today, -55);
  const mine = useQuery({ queryKey: [...OVERTIME_KEY, "mine", from, today], queryFn: () => overtimeApi.mine(from, today), enabled: Boolean(on) });
  const claim = useMutation({
    mutationFn: (weekStart: string) => overtimeApi.claim(weekStart),
    onSuccess: () => {
      toast.success("Overtime claimed", { description: "Your approver has been told." });
      invalidate();
    },
    onError: (err) => toast.error("Could not claim overtime", { description: serverMessage(err, "Try again.") })
  });
  const cancel = useMutation({
    mutationFn: (id: string) => overtimeApi.cancel(id),
    onSuccess: () => {
      toast.success("Claim cancelled");
      invalidate();
    },
    onError: (err) => toast.error("Could not cancel", { description: serverMessage(err, "Try again.") })
  });
  if (!on) return null;
  const weeks = [...(mine.data?.weeks ?? [])].reverse();
  return (
    <SectionCard title="Overtime" description="Hours above your expected day and week, from your timesheets." headingId="att-overtime">
      {mine.isLoading && <Skeleton className="h-16 w-full" />}
      {mine.isError && <CardError message="Your overtime could not be loaded." onRetry={() => runInBackground(mine.refetch())} />}
      {mine.data && (
        <div className="grid gap-2">
          <p className="text-sm">
            Last 8 weeks: <strong>{hoursText(mine.data.totalHours)}</strong>
          </p>
          <ul className="grid gap-2" aria-label="Overtime by week">
            {weeks.map((w) => (
              <li key={w.weekStart} className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-border p-2 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="break-words">{overtimeWeekLine(w)}</p>
                  {w.claim && <p className="text-xs text-muted-foreground">{STATUS_TEXT[w.claim.status]}</p>}
                </div>
                {mine.data.requireApproval && canClaimWeek(w, today) && (
                  <Button size="sm" className="min-h-[44px] sm:min-h-8" disabled={claim.isPending} onClick={() => claim.mutate(w.weekStart)}>
                    Claim
                  </Button>
                )}
                {w.claim?.status === "PENDING" && (
                  <Button variant="ghost" size="sm" className="min-h-[44px] sm:min-h-8" disabled={cancel.isPending} onClick={() => cancel.mutate(w.claim!.id)}>
                    Cancel
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </SectionCard>
  );
}

/** For the nav badge: claims waiting on me (0 while off or approval is off). */
export function useOvertimeInboxCount(enabled: boolean, canApprove: boolean): number {
  const on = useOvertime();
  const q = useQuery({
    queryKey: [...OVERTIME_KEY, "inbox"],
    queryFn: overtimeApi.inbox,
    enabled: enabled && canApprove && Boolean(on?.requireApproval),
    staleTime: 60_000,
    refetchInterval: 120_000,
    refetchIntervalInBackground: false,
    retry: false
  });
  return enabled && on?.requireApproval ? (q.data?.total ?? 0) : 0;
}

export function OvertimeInbox() {
  const on = useOvertime();
  const invalidate = useInvalidate();
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const inbox = useQuery({ queryKey: [...OVERTIME_KEY, "inbox"], queryFn: overtimeApi.inbox, enabled: Boolean(on?.requireApproval) });
  const decide = useMutation({
    mutationFn: ({ id, decision, text }: { id: string; decision: "APPROVE" | "REJECT"; text?: string }) => overtimeApi.decide(id, decision, text),
    onSuccess: (_r, v) => {
      toast.success(v.decision === "APPROVE" ? "Overtime approved" : "Overtime rejected");
      setRejecting(null);
      setNote("");
      invalidate();
    },
    onError: (err) => {
      toast.error("Could not record that decision", { description: serverMessage(err, "Try again.") });
      invalidate();
    }
  });
  if (!on?.requireApproval) return null;
  const items = inbox.data?.items ?? [];
  return (
    <SectionCard title="Overtime claims" description="Hours above the expected week. Approved hours go to the payroll export." headingId="att-overtime-inbox">
      {inbox.isLoading && <Skeleton className="h-16 w-full" />}
      {inbox.isError && <CardError message="Overtime claims could not be loaded." onRetry={() => runInBackground(inbox.refetch())} />}
      {inbox.data && items.length === 0 && <EmptyState compact icon={Inbox} title="Nothing waiting" description="Overtime claims for you to decide show up here." />}
      {items.length > 0 && (
        <ul className="grid gap-2">
          {items.map((r) => (
            <li key={r.id} className="grid min-w-0 gap-2 rounded-lg border border-border p-3 text-sm">
              <div className="min-w-0">
                <p className="truncate font-medium">{r.user?.name ?? "Someone"}</p>
                <p className="text-xs text-muted-foreground">{overtimeWeekLine({ ...r, overtimeHours: r.hours })}</p>
                {r.onBehalfOf && <p className="text-xs text-muted-foreground">You are deciding on behalf of their approver.</p>}
              </div>
              {rejecting === r.id ? (
                <div className="grid gap-2">
                  <Label htmlFor={`ot-reject-${r.id}`} className="text-xs">
                    Why (required)
                  </Label>
                  <Textarea id={`ot-reject-${r.id}`} rows={2} value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
                  <div className="flex flex-wrap gap-2">
                    <Button variant="destructive" className="min-h-[44px]" disabled={!note.trim() || decide.isPending} onClick={() => decide.mutate({ id: r.id, decision: "REJECT", text: note.trim() })}>
                      Reject
                    </Button>
                    <Button variant="ghost" className="min-h-[44px]" onClick={() => setRejecting(null)}>
                      Back
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button className="min-h-[44px] sm:min-h-8" size="sm" disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, decision: "APPROVE" })}>
                    Approve
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="min-h-[44px] sm:min-h-8"
                    onClick={() => {
                      setRejecting(r.id);
                      setNote("");
                    }}
                  >
                    Reject…
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
