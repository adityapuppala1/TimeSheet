/**
 * 7.0.0 comp-off: working a weekend or holiday earns leave credit, decided like leave.
 *
 * - MyCompOffCard (My attendance rail): pick a day, see what it earns (the server decides — weekend
 *   or holiday per the day resolver, the hours logged against the thresholds), request, and the list.
 * - CompOffDayAction (the day sheet): the same request for the day that is open.
 * - CompOffInbox (Team → approvals): what is waiting on you, approve / reject with a note.
 * - CompOffSettingsSection (Workspace settings → Leave settings): the toggle and its rules.
 * Everything renders nothing while comp-off is off.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarPlus, Inbox } from "lucide-react";
import { useEffect, useState } from "react";
import { runInBackground } from "../../lib/run-in-background";
import { compOffApi, type CompOffRow, type CompOffSettings } from "../../services/leave-api";
import { Button } from "../ui/button";
import { EmptyState } from "../ui/empty-state";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Skeleton } from "../ui/skeleton";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toast } from "../ui/toaster";
import { CardError, SectionCard, todayKey } from "./attendance-ui";
import { useCompOffEnabled } from "./use-leave";

const serverMessage = (err: unknown, fallback: string) => (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback;
const STATUS_TEXT: Record<CompOffRow["status"], string> = { PENDING: "Waiting for approval", APPROVED: "Approved", REJECTED: "Rejected", CANCELLED: "Cancelled" };

/** "1 day" / "0.5 day" — pure, exported for the unit test. */
export function compOffDaysText(days: number): string {
  return `${days} ${days === 1 ? "day" : "days"}`;
}

/** The one-line summary of a row (pure). */
export function compOffLine(r: Pick<CompOffRow, "workDate" | "dayKind" | "days" | "hoursLogged">): string {
  return `${r.dayKind === "HOLIDAY" ? "Holiday" : "Weekend"} ${r.workDate} · ${r.hoursLogged}h logged · ${compOffDaysText(r.days)}`;
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    runInBackground(qc.invalidateQueries({ queryKey: ["leave", "comp-off"] }));
    runInBackground(qc.invalidateQueries({ queryKey: ["leave", "inbox"] }));
    runInBackground(qc.invalidateQueries({ queryKey: ["leave", "balances"] }));
  };
}

function RequestForm({ date, onDone }: Readonly<{ date: string; onDone?: () => void }>) {
  const invalidate = useInvalidate();
  const [reason, setReason] = useState("");
  const elig = useQuery({ queryKey: ["leave", "comp-off", "eligibility", date], queryFn: () => compOffApi.eligibility(date), enabled: Boolean(date), retry: false });
  const send = useMutation({
    mutationFn: () => compOffApi.request(date, reason.trim() || undefined),
    onSuccess: () => {
      toast.success("Comp-off requested", { description: "Your approver has been told." });
      setReason("");
      invalidate();
      onDone?.();
    },
    onError: (err) => toast.error("Could not request comp-off", { description: serverMessage(err, "Try again.") })
  });
  if (!date) return null;
  if (elig.isLoading) return <Skeleton className="h-12 w-full" />;
  if (elig.isError) return <p className="text-sm text-muted-foreground">{serverMessage(elig.error, "Could not check that day.")}</p>;
  const e = elig.data!;
  return (
    <div className="grid gap-2" aria-live="polite">
      {e.eligible ? (
        <p className="text-sm">
          {e.dayKind === "HOLIDAY" ? `Holiday${e.holidayName ? ` (${e.holidayName})` : ""}` : "Weekend"}, {e.hoursLogged}h logged: earns <strong>{compOffDaysText(e.days)}</strong>.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">{e.problem}</p>
      )}
      {e.eligible && (
        <>
          <Label htmlFor={`co-reason-${date}`} className="text-xs">
            Note for your approver (optional)
          </Label>
          <Textarea id={`co-reason-${date}`} rows={2} maxLength={2000} value={reason} onChange={(ev) => setReason(ev.target.value)} />
          <Button className="min-h-[44px] justify-self-start" disabled={send.isPending} onClick={() => send.mutate()}>
            Request comp-off
          </Button>
        </>
      )}
    </div>
  );
}

export function CompOffDayAction({ date, isWorkingDay }: Readonly<{ date: string; isWorkingDay: boolean }>) {
  const on = useCompOffEnabled();
  const [open, setOpen] = useState(false);
  if (!on || isWorkingDay || date > todayKey()) return null;
  return open ? (
    <RequestForm date={date} onDone={() => setOpen(false)} />
  ) : (
    <Button variant="outline" className="min-h-[44px]" onClick={() => setOpen(true)}>
      <CalendarPlus className="mr-2 h-4 w-4" aria-hidden="true" />
      Request comp-off for this day
    </Button>
  );
}

export function MyCompOffCard() {
  const on = useCompOffEnabled();
  const invalidate = useInvalidate();
  const [date, setDate] = useState("");
  const mine = useQuery({ queryKey: ["leave", "comp-off", "mine"], queryFn: compOffApi.mine, enabled: on });
  const cancel = useMutation({
    mutationFn: (id: string) => compOffApi.cancel(id),
    onSuccess: () => {
      toast.success("Comp-off request cancelled");
      invalidate();
    },
    onError: (err) => toast.error("Could not cancel", { description: serverMessage(err, "Try again.") })
  });
  if (!on) return null;
  const rows = (mine.data ?? []).slice(0, 6);
  return (
    <SectionCard title="Comp-off" description="Worked a weekend or holiday? Ask for the time back." headingId="att-comp-off">
      <div className="grid gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="co-date">Day you worked</Label>
          <Input id="co-date" type="date" max={todayKey()} value={date} onChange={(e) => setDate(e.target.value)} className="min-h-[44px]" />
        </div>
        <RequestForm date={date} onDone={() => setDate("")} />
        {mine.isError && <CardError message="Your comp-off requests could not be loaded." onRetry={() => runInBackground(mine.refetch())} />}
        {mine.isLoading && <Skeleton className="h-16 w-full" />}
        {rows.length > 0 && (
          <ul className="grid gap-2" aria-label="Your comp-off requests">
            {rows.map((r) => (
              <li key={r.id} className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-border p-2 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="truncate">{compOffLine(r)}</p>
                  <p className="text-xs text-muted-foreground">
                    {STATUS_TEXT[r.status]}
                    {r.expiresOn && r.status === "APPROVED" ? (r.expiredAt ? " · expired" : ` · use by ${r.expiresOn}`) : ""}
                  </p>
                </div>
                {r.status === "PENDING" && (
                  <Button variant="ghost" size="sm" className="min-h-[44px] sm:min-h-8" disabled={cancel.isPending} onClick={() => cancel.mutate(r.id)}>
                    Cancel
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </SectionCard>
  );
}

export function CompOffInbox() {
  const on = useCompOffEnabled();
  const invalidate = useInvalidate();
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const inbox = useQuery({ queryKey: ["leave", "comp-off", "inbox"], queryFn: compOffApi.inbox, enabled: on });
  const decide = useMutation({
    mutationFn: ({ id, decision, text }: { id: string; decision: "APPROVE" | "REJECT"; text?: string }) => compOffApi.decide(id, decision, text),
    onSuccess: (_r, v) => {
      toast.success(v.decision === "APPROVE" ? "Comp-off approved" : "Comp-off rejected");
      setRejecting(null);
      setNote("");
      invalidate();
    },
    onError: (err) => {
      toast.error("Could not record that decision", { description: serverMessage(err, "Try again.") });
      invalidate();
    }
  });
  if (!on) return null;
  const items = inbox.data?.items ?? [];
  return (
    <SectionCard title="Comp-off requests" description="Credit for working a weekend or holiday. Approving adds the days to their balance." headingId="att-comp-off-inbox">
      {inbox.isLoading && <Skeleton className="h-16 w-full" />}
      {inbox.isError && <CardError message="Comp-off requests could not be loaded." onRetry={() => runInBackground(inbox.refetch())} />}
      {inbox.data && items.length === 0 && <EmptyState compact icon={Inbox} title="Nothing waiting" description="Comp-off requests for you to decide show up here." />}
      {items.length > 0 && (
        <ul className="grid gap-2">
          {items.map((r) => (
            <li key={r.id} className="grid min-w-0 gap-2 rounded-lg border border-border p-3 text-sm">
              <div className="min-w-0">
                <p className="truncate font-medium">{r.user?.name ?? "Someone"}</p>
                <p className="text-xs text-muted-foreground">{compOffLine(r)}</p>
                {r.onBehalfOf && <p className="text-xs text-muted-foreground">You are deciding on behalf of their approver.</p>}
                {r.reason && <p className="mt-1 text-xs">“{r.reason}”</p>}
              </div>
              {rejecting === r.id ? (
                <div className="grid gap-2">
                  <Label htmlFor={`co-reject-${r.id}`} className="text-xs">
                    Why (required)
                  </Label>
                  <Textarea id={`co-reject-${r.id}`} rows={2} value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
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
                  <Button variant="outline" size="sm" className="min-h-[44px] sm:min-h-8" onClick={() => { setRejecting(r.id); setNote(""); }}>
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

/* -------------------------------- settings -------------------------------- */

export function CompOffSettingsSection({ readOnly }: Readonly<{ readOnly: boolean }>) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["leave", "admin", "comp-off"], queryFn: compOffApi.settings });
  const [form, setForm] = useState<CompOffSettings | null>(null);
  useEffect(() => {
    if (q.data) setForm(q.data.settings);
  }, [q.data]);
  const save = useMutation({
    mutationFn: (payload: CompOffSettings) => compOffApi.updateSettings(payload),
    onSuccess: () => {
      toast.success("Comp-off settings saved");
      runInBackground(qc.invalidateQueries({ queryKey: ["leave"] }));
    },
    onError: (err) => toast.error("Could not save comp-off settings", { description: serverMessage(err, "Try again.") })
  });
  if (q.isLoading || !form) return <Skeleton className="h-24 w-full" />;
  if (q.isError) return <CardError message="Comp-off settings could not be loaded." onRetry={() => runInBackground(q.refetch())} />;
  const disabled = readOnly || !q.data?.entitled;
  const set = (patch: Partial<CompOffSettings>) => setForm({ ...form, ...patch });
  return (
    <div className="grid min-w-0 gap-3 rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <Label htmlFor="co-enabled">Comp-off for weekend and holiday work</Label>
          <p className="text-xs text-muted-foreground">
            People who log time on a weekend or holiday can ask for that time back. Their approver decides, and approval adds the days to the {form.compOffLeaveTypeCode} leave type (enable it under Leave types first).
          </p>
        </div>
        <Switch id="co-enabled" checked={form.compOffEnabled} disabled={disabled} onCheckedChange={(v) => set({ compOffEnabled: v })} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="co-half">Hours for half a day</Label>
          <Input id="co-half" type="number" min={0.5} max={24} step={0.5} disabled={disabled} value={form.compOffHalfDayHours} onChange={(e) => set({ compOffHalfDayHours: Number(e.target.value) })} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="co-full">Hours for a full day</Label>
          <Input id="co-full" type="number" min={0.5} max={24} step={0.5} disabled={disabled} value={form.compOffFullDayHours} onChange={(e) => set({ compOffFullDayHours: Number(e.target.value) })} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="co-type">Leave type credited (code)</Label>
          <Input id="co-type" maxLength={20} disabled={disabled} value={form.compOffLeaveTypeCode} onChange={(e) => set({ compOffLeaveTypeCode: e.target.value.toUpperCase() })} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="co-expiry">Expires after (days, empty = never)</Label>
          <Input
            id="co-expiry"
            type="number"
            min={1}
            max={3650}
            disabled={disabled}
            value={form.compOffExpiryDays ?? ""}
            onChange={(e) => set({ compOffExpiryDays: e.target.value === "" ? null : Number(e.target.value) })}
          />
        </div>
      </div>
      <Button className="min-h-[44px] justify-self-start" disabled={disabled || save.isPending} onClick={() => save.mutate(form)}>
        Save comp-off settings
      </Button>
    </div>
  );
}
