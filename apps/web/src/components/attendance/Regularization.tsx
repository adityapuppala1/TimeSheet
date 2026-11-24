/**
 * 7.0.0 regularisation: ask to add or correct the punch for a past day, decided by the manager.
 *
 * - RegularizationDayAction (My attendance → the day sheet): "Request correction" for a past day in
 *   the allowed window, or the pending request for it with Cancel.
 * - RegularizationInbox (Team → approvals): what is waiting on you, approve / reject with a note.
 * Both render nothing while corrections are off (GET /attendance/me/today has no `regularization`).
 * The reason is shown only here: to the person who asked and to whoever decides.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Inbox, PencilLine } from "lucide-react";
import { useState } from "react";
import { runInBackground } from "../../lib/run-in-background";
import { addDayKeys } from "../../lib/attendance-calendar";
import { clockText } from "../../lib/attendance-status";
import { MY_TODAY_QUERY_KEY, regularizationApi, type RegularizationRow } from "../../services/attendance-api";
import { useMyToday } from "../PunchIn";
import { Button } from "../ui/button";
import { EmptyState } from "../ui/empty-state";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Skeleton } from "../ui/skeleton";
import { Textarea } from "../ui/textarea";
import { toast } from "../ui/toaster";
import { CardError, SectionCard, todayKey } from "./attendance-ui";

const serverMessage = (err: unknown, fallback: string) => (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback;

export const REGULARIZATION_KEY = ["attendance", "regularizations"] as const;

/** The corrections switch as the signed-in person sees it: null while off. */
export function useRegularization(): { maxDaysBack: number } | null {
  const today = useMyToday();
  const r = today.data?.regularization;
  return r?.enabled ? { maxDaysBack: r.maxDaysBack } : null;
}

/** "HH:mm" from an ISO instant, in the browser's zone (pure apart from the zone). */
export function timeOf(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * The instants a person means by "in at 09:00, out at 17:30" on `date`, in the browser's zone. An
 * out time at or before the in time is the next morning (a night shift). Pure apart from the zone.
 */
export function punchInstants(date: string, inTime: string, outTime: string): { punchInAt: string; punchOutAt: string | null } {
  const inAt = new Date(`${date}T${inTime}:00`);
  if (!outTime) return { punchInAt: inAt.toISOString(), punchOutAt: null };
  const outDay = outTime <= inTime ? addDayKeys(date, 1) : date;
  return { punchInAt: inAt.toISOString(), punchOutAt: new Date(`${outDay}T${outTime}:00`).toISOString() };
}

/** May this day be corrected now? Pure. */
export function canRequestCorrection(date: string, today: string, maxDaysBack: number): boolean {
  return date < today && date >= addDayKeys(today, -maxDaysBack);
}

function pair(inAt: string | null, outAt: string | null): string {
  if (!inAt) return "no punch";
  const out = outAt ? " · out " + clockText(outAt) : " · no punch-out";
  return "in " + clockText(inAt) + out;
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    runInBackground(qc.invalidateQueries({ queryKey: REGULARIZATION_KEY }));
    runInBackground(qc.invalidateQueries({ queryKey: ["attendance", "me"] }));
    runInBackground(qc.invalidateQueries({ queryKey: MY_TODAY_QUERY_KEY }));
  };
}

function RequestForm({ date, punchInAt, punchOutAt, onDone }: Readonly<{ date: string; punchInAt: string | null; punchOutAt: string | null; onDone: () => void }>) {
  const invalidate = useInvalidate();
  const [inTime, setIn] = useState(timeOf(punchInAt) || "09:00");
  const [outTime, setOut] = useState(timeOf(punchOutAt));
  const [reason, setReason] = useState("");
  const send = useMutation({
    mutationFn: () => regularizationApi.request({ workDate: date, ...punchInstants(date, inTime, outTime), reason: reason.trim() }),
    onSuccess: () => {
      toast.success("Correction requested", { description: "Your manager has been told." });
      invalidate();
      onDone();
    },
    onError: (err) => toast.error("Could not request the correction", { description: serverMessage(err, "Try again.") })
  });
  return (
    <div className="grid gap-3 rounded-lg border border-border p-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="grid min-w-0 gap-1.5">
          <Label htmlFor={`reg-in-${date}`}>Punch-in</Label>
          <Input id={`reg-in-${date}`} type="time" required value={inTime} onChange={(e) => setIn(e.target.value)} className="min-h-[44px]" />
        </div>
        <div className="grid min-w-0 gap-1.5">
          <Label htmlFor={`reg-out-${date}`}>Punch-out (optional)</Label>
          <Input id={`reg-out-${date}`} type="time" value={outTime} onChange={(e) => setOut(e.target.value)} className="min-h-[44px]" />
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`reg-reason-${date}`}>Reason</Label>
        <Textarea id={`reg-reason-${date}`} rows={2} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: forgot to punch out before leaving" />
        <p className="text-xs text-muted-foreground">Only you and the person who decides see this.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button className="min-h-[44px]" disabled={!inTime || reason.trim().length < 3 || send.isPending} onClick={() => send.mutate()}>
          Send request
        </Button>
        <Button variant="ghost" className="min-h-[44px]" onClick={onDone}>
          Back
        </Button>
      </div>
    </div>
  );
}

export function RegularizationDayAction({ date, punchInAt, punchOutAt }: Readonly<{ date: string; punchInAt: string | null; punchOutAt: string | null }>) {
  const reg = useRegularization();
  const invalidate = useInvalidate();
  const [open, setOpen] = useState(false);
  const mine = useQuery({ queryKey: [...REGULARIZATION_KEY, "mine"], queryFn: regularizationApi.mine, enabled: Boolean(reg) });
  const cancel = useMutation({
    mutationFn: (id: string) => regularizationApi.cancel(id),
    onSuccess: () => {
      toast.success("Correction request cancelled");
      invalidate();
    },
    onError: (err) => toast.error("Could not cancel", { description: serverMessage(err, "Try again.") })
  });
  if (!reg || !canRequestCorrection(date, todayKey(), reg.maxDaysBack)) return null;
  const pending = (mine.data ?? []).find((r) => r.workDate === date && r.status === "PENDING");
  if (pending) {
    return (
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3 text-sm" aria-live="polite">
        <p className="min-w-0">
          Correction waiting for approval: {pair(pending.punchInAt, pending.punchOutAt)}
        </p>
        <Button variant="ghost" size="sm" className="min-h-[44px] sm:min-h-8" disabled={cancel.isPending} onClick={() => cancel.mutate(pending.id)}>
          Cancel
        </Button>
      </div>
    );
  }
  return open ? (
    <RequestForm date={date} punchInAt={punchInAt} punchOutAt={punchOutAt} onDone={() => setOpen(false)} />
  ) : (
    <Button variant="outline" className="min-h-[44px]" onClick={() => setOpen(true)}>
      <PencilLine className="mr-2 h-4 w-4" aria-hidden="true" />
      Request correction
    </Button>
  );
}

/** For the nav badge: corrections waiting on me (0 while off). */
export function useRegularizationPending(enabled: boolean): number {
  const reg = useRegularization();
  const q = useQuery({
    queryKey: [...REGULARIZATION_KEY, "inbox"],
    queryFn: regularizationApi.inbox,
    enabled: enabled && Boolean(reg),
    staleTime: 60_000,
    refetchInterval: 120_000,
    refetchIntervalInBackground: false,
    retry: false
  });
  return enabled && reg ? (q.data?.total ?? 0) : 0;
}

function InboxItem({ r, busy, onDecide }: Readonly<{ r: RegularizationRow; busy: boolean; onDecide: (decision: "APPROVE" | "REJECT", note?: string) => void }>) {
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  return (
    <li className="grid min-w-0 gap-2 rounded-lg border border-border p-3 text-sm">
      <div className="min-w-0">
        <p className="truncate font-medium">{r.user?.name ?? "Someone"}</p>
        <p className="text-xs text-muted-foreground">
          {r.workDate} · asks for {pair(r.punchInAt, r.punchOutAt)}
        </p>
        <p className="text-xs text-muted-foreground">Recorded now: {pair(r.originalPunchInAt, r.originalPunchOutAt)}</p>
        {r.onBehalfOf && <p className="text-xs text-muted-foreground">You are deciding on behalf of their approver.</p>}
        {r.reason && <p className="mt-1 break-words text-xs">“{r.reason}”</p>}
      </div>
      {rejecting ? (
        <div className="grid gap-2">
          <Label htmlFor={`reg-reject-${r.id}`} className="text-xs">
            Why (required)
          </Label>
          <Textarea id={`reg-reject-${r.id}`} rows={2} value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
          <div className="flex flex-wrap gap-2">
            <Button variant="destructive" className="min-h-[44px]" disabled={!note.trim() || busy} onClick={() => onDecide("REJECT", note.trim())}>
              Reject
            </Button>
            <Button variant="ghost" className="min-h-[44px]" onClick={() => setRejecting(false)}>
              Back
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button className="min-h-[44px] sm:min-h-8" size="sm" disabled={busy} onClick={() => onDecide("APPROVE")}>
            Approve
          </Button>
          <Button variant="outline" size="sm" className="min-h-[44px] sm:min-h-8" onClick={() => setRejecting(true)}>
            Reject…
          </Button>
        </div>
      )}
    </li>
  );
}

export function RegularizationInbox() {
  const reg = useRegularization();
  const invalidate = useInvalidate();
  const inbox = useQuery({ queryKey: [...REGULARIZATION_KEY, "inbox"], queryFn: regularizationApi.inbox, enabled: Boolean(reg) });
  const decide = useMutation({
    mutationFn: ({ id, decision, note }: { id: string; decision: "APPROVE" | "REJECT"; note?: string }) => regularizationApi.decide(id, decision, note),
    onSuccess: (_r, v) => {
      toast.success(v.decision === "APPROVE" ? "Correction approved" : "Correction rejected");
      invalidate();
    },
    onError: (err) => {
      toast.error("Could not record that decision", { description: serverMessage(err, "Try again.") });
      invalidate();
    }
  });
  if (!reg) return null;
  const items = inbox.data?.items ?? [];
  return (
    <SectionCard title="Attendance corrections" description="Missed or wrong punches for a past day. Approving replaces that day's punch; the original stays in the history." headingId="att-reg-inbox">
      {inbox.isLoading && <Skeleton className="h-16 w-full" />}
      {inbox.isError && <CardError message="Correction requests could not be loaded." onRetry={() => runInBackground(inbox.refetch())} />}
      {inbox.data && items.length === 0 && <EmptyState compact icon={Inbox} title="Nothing waiting" description="Correction requests for you to decide show up here." />}
      {items.length > 0 && (
        <ul className="grid gap-2">
          {items.map((r) => (
            <InboxItem key={r.id} r={r} busy={decide.isPending} onDecide={(decision, note) => decide.mutate({ id: r.id, decision, note })} />
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
