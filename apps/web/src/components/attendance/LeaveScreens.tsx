/**
 * The leave screens (V17 UI v2): Apply, My requests, Holidays — one section under /app/attendance/leave.
 *
 * APPLY asks the server what a request would cost (GET /api/leave/me/preview mirrors the apply rules)
 * and shows exactly that: working days, the days it skipped and why, balance before and after, an
 * overlap with your own leave, and who will decide. An optional reason goes to the approver ONLY
 * (the API returns it solely to whoever may decide the request; never to team views, calendars or
 * email). A document is asked for only when the type's rule says so.
 *
 * Phone: one column with a sticky bottom summary ("3 days · balance 3.5") that expands on tap.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CalendarClock, CalendarPlus, ChevronUp, CircleSlash, Download, FileText, List, Plane, Star, Users } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { NavLink, useNavigate } from "react-router";
import { addDayKeys, buildMonthGrid, monthLabel, monthOf, shiftMonth, WEEKDAY_HEADERS } from "../../lib/attendance-calendar";
import { downloadText } from "../../lib/csv-export";
import {
  balanceChange,
  buildIcs,
  canCancel,
  excludedText,
  FILTER_LABELS,
  fallsOnNote,
  filterRequests,
  formatDays,
  groupByMonth,
  holidayLabel,
  negativeBalanceMessage,
  relativeDay,
  REQUEST_STATUS_META,
  requestRangeText,
  submitLabel,
  summaryLine,
  typeBalanceText,
  type RequestFilter
} from "../../lib/leave-ui";
import { runInBackground } from "../../lib/run-in-background";
import { useMediaQuery } from "../../lib/use-media-query";
import { cn } from "../../lib/utils";
import { applyPayload, leaveApi, type LeaveHalf, type LeaveRequestRow, type LeaveTypeRow } from "../../services/leave-api";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { DatePicker } from "../ui/date-picker";
import { EmptyState } from "../ui/empty-state";
import { FileDropzone } from "../ui/file-dropzone";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { Skeleton } from "../ui/skeleton";
import { toast } from "../ui/toaster";
import { CardError, FilterChip, PersonAvatar, Segmented, SectionCard, todayKey } from "./attendance-ui";
import { leaveColour, useLeaveBalances, useMyHolidays } from "./use-leave";
import { OptionalHolidayControl } from "./OptionalHolidayControl";
import { optionalSummary, optionalTaken } from "../../lib/holiday-opt-in";

const serverMessage = (err: unknown, fallback: string) => (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback;

/* ---------------------------------- sub-navigation ---------------------------------- */

export function LeaveNav() {
  const items = [
    { to: "/app/attendance/leave", label: "Apply", icon: CalendarPlus, end: true },
    { to: "/app/attendance/leave/requests", label: "My requests", icon: List, end: false },
    { to: "/app/attendance/leave/holidays", label: "Holidays", icon: Star, end: false }
  ];
  return (
    <nav aria-label="Leave" className="flex gap-2 overflow-x-auto pb-1">
      {items.map((i) => (
        <NavLink
          key={i.to}
          to={i.to}
          end={i.end}
          className={({ isActive }) =>
            cn(
              "focus-ring inline-flex min-h-[44px] shrink-0 items-center gap-2 rounded-full border px-4 text-sm font-medium transition-colors sm:min-h-9",
              isActive ? "border-primary bg-primary/10 text-primary" : "border-border bg-card text-muted-foreground hover:text-foreground"
            )
          }
        >
          <i.icon className="h-4 w-4" aria-hidden="true" />
          {i.label}
        </NavLink>
      ))}
    </nav>
  );
}

/* ------------------------------------- Apply ------------------------------------- */

const HALF_OPTIONS: Array<{ value: LeaveHalf; label: string }> = [
  { value: "FULL", label: "Full day" },
  { value: "FIRST_HALF", label: "First half" },
  { value: "SECOND_HALF", label: "Second half" }
];

function TypePicker({ types, balances, value, onChange }: Readonly<{ types: LeaveTypeRow[]; balances: Map<string, number>; value: string; onChange: (id: string) => void }>) {
  return (
    <div role="radiogroup" aria-label="Leave type" className="grid gap-2 sm:grid-cols-2">
      {types.map((t) => {
        const left = balances.get(t.id);
        const empty = left !== undefined && left <= 0 && !t.allowNegative;
        const active = value === t.id;
        return (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={active}
            aria-disabled={empty}
            disabled={empty}
            onClick={() => onChange(t.id)}
            className={cn(
              "focus-ring grid min-h-[56px] min-w-0 gap-0.5 rounded-lg border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
              active ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border bg-card hover:bg-muted/50"
            )}
          >
            <span className="flex min-w-0 items-center gap-2 text-sm font-semibold">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: leaveColour(t.colour) }} aria-hidden="true" />
              <span className="truncate">{t.name}</span>
            </span>
            <span className="text-xs text-muted-foreground">
              {typeBalanceText(left, empty)}
              {t.requiresApproval ? "" : " · approved automatically"}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function SummaryBody({ preview, typeName, loading }: Readonly<{ preview: Awaited<ReturnType<typeof leaveApi.preview>> | undefined; typeName: string; loading: boolean }>) {
  if (!preview) {
    return <p className="text-sm text-muted-foreground">{loading ? "Working it out…" : "Choose a type and your dates to see what it costs."}</p>;
  }
  const excluded = excludedText(preview.excluded);
  const change = balanceChange(preview);
  const negative = negativeBalanceMessage(preview, typeName);
  const blocking = preview.problems.filter((p) => p.code !== "LEAVE_INSUFFICIENT_BALANCE" || !negative);
  return (
    <div className="grid gap-3" aria-live="polite">
      {preview.days > 0 && (
        <div>
          <p className="text-3xl font-black tabular-nums leading-none">{formatDays(preview.days)}</p>
          {excluded && <p className="mt-1 text-xs text-muted-foreground">{excluded}</p>}
        </div>
      )}
      {change && <p className="text-sm font-medium tabular-nums">{change}</p>}
      {negative && (
        <p className="flex items-start gap-2 rounded-md bg-warning/10 px-2 py-1.5 text-xs text-warning-ink">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {negative}
        </p>
      )}
      {blocking.map((p) => (
        <p key={p.code} role="alert" className="flex items-start gap-2 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive-ink">
          <CircleSlash className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {p.message}
        </p>
      ))}
      <div className="flex min-w-0 items-center gap-2 text-sm">
        {preview.requiresApproval && preview.approver && (
          <>
            <PersonAvatar name={preview.approver.name} avatarUrl={preview.approver.avatarUrl} className="h-7 w-7" />
            <span className="min-w-0 truncate">
              <span className="text-muted-foreground">Approver </span>
              <span className="font-medium">{preview.approver.name}</span>
            </span>
          </>
        )}
        {preview.requiresApproval && !preview.approver && (
          <>
            <Users className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="text-muted-foreground">An admin will review this request.</span>
          </>
        )}
        {!preview.requiresApproval && <span className="text-muted-foreground">This type is approved automatically.</span>}
      </div>
    </div>
  );
}

function HalfPickers({ single, startHalf, endHalf, setStartHalf, setEndHalf }: Readonly<{ single: boolean; startHalf: LeaveHalf; endHalf: LeaveHalf; setStartHalf: (h: LeaveHalf) => void; setEndHalf: (h: LeaveHalf) => void }>) {
  return (
      single ? (
        <div className="grid gap-1.5">
          <Label>Which part of the day?</Label>
          <Segmented
            label="Part of the day"
            value={startHalf}
            onChange={(v) => {
              setStartHalf(v);
              setEndHalf(v);
            }}
            options={HALF_OPTIONS}
            className="w-full"
          />
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label>First day</Label>
            <Segmented
              label="First day"
              value={startHalf === "SECOND_HALF" ? "SECOND_HALF" : "FULL"}
              onChange={setStartHalf}
              options={[
                { value: "FULL", label: "Full day" },
                { value: "SECOND_HALF", label: "From afternoon" }
              ]}
              className="w-full"
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Last day</Label>
            <Segmented
              label="Last day"
              value={endHalf === "FIRST_HALF" ? "FIRST_HALF" : "FULL"}
              onChange={setEndHalf}
              options={[
                { value: "FULL", label: "Full day" },
                { value: "FIRST_HALF", label: "Until lunch" }
              ]}
              className="w-full"
            />
          </div>
        </div>
      )
  );
}

export function ApplyLeave() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const today = todayKey();
  const types = useQuery({ queryKey: ["leave", "types"], queryFn: leaveApi.types });
  const balances = useLeaveBalances(true);
  const balanceMap = useMemo(() => new Map((balances.data?.balances ?? []).map((b) => [b.leaveType.id, b.available])), [balances.data]);

  const [typeId, setTypeId] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [startHalf, setStartHalf] = useState<LeaveHalf>("FULL");
  const [endHalf, setEndHalf] = useState<LeaveHalf>("FULL");
  const [doc, setDoc] = useState<File | null>(null);
  const [reason, setReason] = useState("");
  const [expanded, setExpanded] = useState(false);

  const typeList = useMemo(() => types.data ?? [], [types.data]);
  useEffect(() => {
    // Pick the first type that still has days, so the form opens ready rather than empty.
    if (!typeId && typeList.length > 0) {
      const usable = typeList.find((t) => (balanceMap.get(t.id) ?? 1) > 0 || t.allowNegative) ?? typeList[0];
      setTypeId(usable.id);
    }
  }, [typeList, balanceMap, typeId]);

  const type = typeList.find((t) => t.id === typeId);
  const single = Boolean(start) && start === end;
  const ready = Boolean(typeId && start && end && end >= start);
  const preview = useQuery({
    queryKey: ["leave", "preview", typeId, start, end, startHalf, endHalf],
    queryFn: () => leaveApi.preview({ typeId, start, end, startHalf, endHalf }),
    enabled: ready,
    placeholderData: keepPreviousData,
    retry: false
  });
  const p = ready ? preview.data : undefined;

  const submit = useMutation({
    mutationFn: () => leaveApi.apply(applyPayload({ leaveTypeId: typeId, startDate: start, endDate: end, startHalf, endHalf, document: doc }, reason)),
    onSuccess: (r) => {
      toast.success(r.autoApproved ? "Leave approved" : "Request sent", { description: r.autoApproved ? "It is on your calendar." : "Your approver has been notified." });
      runInBackground(queryClient.invalidateQueries({ queryKey: ["leave"] }));
      runInBackground(Promise.resolve(navigate("/app/attendance/leave/requests")));
    },
    onError: (err) => toast.error("Could not send the request", { description: serverMessage(err, "Try again.") })
  });

  const needsDoc = Boolean(p?.documentRequired);
  const canSubmit = Boolean(p?.ok) && (!needsDoc || Boolean(doc)) && !submit.isPending;

  const setStartDate = (v: string) => {
    setStart(v);
    if (!end || end < v) setEnd(v);
    if (v && end && v !== end) setStartHalf((h) => (h === "FIRST_HALF" ? "FULL" : h));
  };

  if (types.isLoading) return <Skeleton className="h-96 w-full" aria-busy="true" />;
  if (types.isError) return <CardError message="Leave types could not be loaded." onRetry={() => runInBackground(types.refetch())} />;
  if (typeList.length === 0) return <EmptyState icon={Plane} title="No leave types are available" description="Your admin has not enabled a leave type yet." />;

  return (
    <form
      className="grid min-w-0 gap-4 pb-24 lg:grid-cols-[minmax(0,1fr)_340px] lg:pb-0"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) submit.mutate();
      }}
    >
      <div className="grid min-w-0 gap-4">
        <SectionCard title="Type" headingId="apply-type">
          {balances.isError && <CardError message="Balances could not be loaded, so remaining days are not shown." onRetry={() => runInBackground(balances.refetch())} />}
          <TypePicker types={typeList} balances={balanceMap} value={typeId} onChange={(id) => { setTypeId(id); setStartHalf("FULL"); setEndHalf("FULL"); }} />
        </SectionCard>

        <SectionCard title="Dates" headingId="apply-dates">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="leave-start">From</Label>
              <DatePicker id="leave-start" value={start} onChange={setStartDate} minValue={addDayKeys(today, -60)} className="w-full" placeholder="First day" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="leave-end">To</Label>
              <DatePicker id="leave-end" value={end} onChange={(v) => setEnd(v)} minValue={start || addDayKeys(today, -60)} className="w-full" placeholder="Last day" />
            </div>
          </div>
          {type?.allowHalfDay && start && end && (
            <HalfPickers single={single} startHalf={startHalf} endHalf={endHalf} setStartHalf={setStartHalf} setEndHalf={setEndHalf} />
          )}
          {p?.overlap && (
            <p className="flex items-start gap-2 rounded-md bg-warning/10 px-2 py-1.5 text-xs text-warning-ink">
              <CalendarClock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              You already have leave from {p.overlap.startDate} to {p.overlap.endDate}. Pick other dates, or cancel that request first.
            </p>
          )}
        </SectionCard>

        <SectionCard title="Reason" description="Optional." headingId="apply-reason">
          <div className="grid gap-1.5">
            <Label htmlFor="leave-reason" className="sr-only">
              Reason
            </Label>
            <Textarea id="leave-reason" rows={3} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} aria-describedby="leave-reason-hint" />
            <p id="leave-reason-hint" className="text-xs text-muted-foreground">
              Visible only to your approver
            </p>
          </div>
        </SectionCard>

        {needsDoc && (
          <SectionCard title="Supporting document" description={`${type?.name ?? "This type"} longer than ${type?.requiresDocumentAfterDays} ${type?.requiresDocumentAfterDays === 1 ? "day" : "days"} needs one. Your approver sees it.`} headingId="apply-doc">
            <FileDropzone files={doc ? [doc] : []} onChange={(f) => setDoc(f[0] ?? null)} maxFiles={1} maxSizeMb={10} hint="PDF or an image, up to 10 MB." />
          </SectionCard>
        )}
      </div>

      {/* Desktop: the sticky summary card. */}
      <aside className="hidden lg:block">
        <div className="sticky top-4 grid gap-3 rounded-lg border border-border bg-card p-4 shadow-soft">
          <h3 className="text-sm font-semibold">Summary</h3>
          <SummaryBody preview={p} typeName={type?.name ?? "leave"} loading={preview.isFetching} />
          {needsDoc && !doc && <p className="text-xs text-muted-foreground">Add the document to send this request.</p>}
          <Button type="submit" className="min-h-[44px] w-full" disabled={!canSubmit}>
            {submitLabel(submit.isPending, type?.requiresApproval === false)}
          </Button>
        </div>
      </aside>

      {/* Phone: a sticky bar above the bottom navigation that expands on tap. */}
      <div className="sticky bottom-[68px] z-20 -mx-4 border-t border-border bg-background/95 py-2 pl-4 pr-16 shadow-lg backdrop-blur-xl lg:hidden" role="region" aria-label="Request summary">
        {expanded && (
          <div className="mb-3 max-h-[50dvh] overflow-y-auto">
            <SummaryBody preview={p} typeName={type?.name ?? "leave"} loading={preview.isFetching} />
          </div>
        )}
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            className="focus-ring flex min-h-[44px] min-w-0 flex-1 items-center justify-between gap-2 rounded-md px-2 text-left"
          >
            <span className="min-w-0 truncate text-sm font-semibold tabular-nums">{summaryLine(p)}</span>
            <ChevronUp className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-180")} aria-hidden="true" />
          </button>
          <Button type="submit" className="min-h-[44px] shrink-0" disabled={!canSubmit}>
            {submit.isPending ? "Sending…" : "Send"}
          </Button>
        </div>
      </div>
    </form>
  );
}

/* ---------------------------------- My requests ---------------------------------- */

export function MyLeaveRequests() {
  const queryClient = useQueryClient();
  const today = todayKey();
  const q = useQuery({ queryKey: ["leave", "requests"], queryFn: () => leaveApi.requests() });
  const [filter, setFilter] = useState<RequestFilter>("ALL");
  const [cancelling, setCancelling] = useState<LeaveRequestRow | null>(null);
  const items = useMemo(() => q.data ?? [], [q.data]);
  const shown = filterRequests(items, filter, today);

  const cancel = useMutation({
    mutationFn: (id: string) => leaveApi.cancel(id),
    onSuccess: () => {
      toast.success("Request cancelled");
      setCancelling(null);
      runInBackground(queryClient.invalidateQueries({ queryKey: ["leave"] }));
    },
    onError: (err) => toast.error("Could not cancel", { description: serverMessage(err, "Try again.") })
  });

  return (
    <SectionCard
      title="My requests"
      headingId="my-requests"
      action={
        <Button asChild variant="outline" size="sm" className="min-h-[44px] sm:min-h-8">
          <NavLink to="/app/attendance/leave">New request</NavLink>
        </Button>
      }
    >
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter requests">
        {(["ALL", "PENDING", "PAST"] as const).map((f) => (
          <FilterChip key={f} active={filter === f} onClick={() => setFilter(f)}>
            {FILTER_LABELS[f]}
            <span className="tabular-nums text-muted-foreground">{filterRequests(items, f, today).length}</span>
          </FilterChip>
        ))}
      </div>
      {q.isLoading && <Skeleton className="h-40 w-full" aria-busy="true" />}
      {q.isError && <CardError message="Your requests could not be loaded." onRetry={() => runInBackground(q.refetch())} />}
      {q.data && shown.length === 0 && (
        <EmptyState
          compact
          icon={Plane}
          title={items.length === 0 ? "No leave requests yet" : "Nothing in this view"}
          description={items.length === 0 ? "When you ask for time off it appears here with its status." : "Try another filter."}
        />
      )}
      {shown.length > 0 && (
        <ul className="grid gap-2">
          {shown.map((r) => {
            const meta = REQUEST_STATUS_META[r.status];
            return (
              <li key={r.id} className="grid min-w-0 gap-2 rounded-lg border border-border p-3">
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                  <p className="flex min-w-0 items-center gap-2 text-sm font-semibold">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: leaveColour(r.leaveType.colour) }} aria-hidden="true" />
                    <span className="truncate">{r.leaveType.name}</span>
                  </p>
                  <Badge variant={meta.tone}>{meta.label}</Badge>
                </div>
                <p className="text-sm text-muted-foreground">{requestRangeText(r)}</p>
                {r.status === "REJECTED" && r.decisionNote && (
                  <p className="rounded-md bg-muted/60 px-2 py-1.5 text-xs">
                    <span className="font-medium">Your approver wrote: </span>
                    {r.decisionNote}
                  </p>
                )}
                {canCancel(r, today) && (
                  <Button variant="outline" size="sm" className="min-h-[44px] justify-self-start sm:min-h-8" onClick={() => setCancelling(r)}>
                    Cancel request
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <AlertDialog open={Boolean(cancelling)} onOpenChange={(o) => !o && setCancelling(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this request?</AlertDialogTitle>
            <AlertDialogDescription>
              {cancelling ? `${cancelling.leaveType.name}, ${requestRangeText(cancelling)}.` : ""}{" "}
              {cancelling?.status === "APPROVED" ? "The days go back to your balance." : "Your approver will no longer see it."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction disabled={cancel.isPending} onClick={() => cancelling && cancel.mutate(cancelling.id)}>
              Cancel request
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SectionCard>
  );
}

/* ----------------------------------- Holidays ----------------------------------- */

type HolidayView = "list" | "calendar";

export function HolidayCalendarView() {
  const today = todayKey();
  const year = Number(today.slice(0, 4));
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const q = useMyHolidays(from, to);
  const wide = useMediaQuery("(min-width: 1024px)");
  const [view, setView] = useState<HolidayView | null>(null);
  const mode: HolidayView = view ?? (wide ? "calendar" : "list");
  const [month, setMonth] = useState(monthOf(today));
  const holidays = useMemo(() => q.data?.holidays ?? [], [q.data]);
  const upcoming = holidays.filter((h) => h.date >= today).slice(0, 4);
  const byDate = useMemo(() => new Map(holidays.map((h) => [h.date, h])), [holidays]);
  const cap = q.data?.maxOptionalPerYear ?? null;
  const taken = optionalTaken(q.data?.optionalTakenByYear, String(year));
  const hasOptional = holidays.some((h) => h.isOptional);

  const download = () => {
    const ics = buildIcs(holidays, q.data?.calendar?.name ?? "Holidays");
    downloadText(`holidays-${year}.ics`, ics, "text/calendar;charset=utf-8");
  };

  return (
    <div className="grid min-w-0 gap-4">
      <SectionCard
        title={q.data?.calendar?.name ?? "Holidays"}
        description={q.data?.calendar ? `Your holiday calendar for ${year}` : undefined}
        headingId="holidays-heading"
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              label="Holiday view"
              value={mode}
              onChange={setView}
              options={[
                { value: "list", label: "List" },
                { value: "calendar", label: "Calendar" }
              ]}
            />
            <Button variant="outline" className="min-h-[44px] sm:min-h-8" disabled={holidays.length === 0} onClick={download}>
              <Download className="mr-1.5 h-4 w-4" aria-hidden="true" />
              Add to my calendar
            </Button>
          </div>
        }
      >
        {q.isLoading && <Skeleton className="h-48 w-full" aria-busy="true" />}
        {q.isError && <CardError message="Your holidays could not be loaded." onRetry={() => runInBackground(q.refetch())} />}
        {q.data && holidays.length === 0 && <EmptyState compact icon={Star} title="No holidays on your calendar" description="Your admin has not added any for this year." />}
        {upcoming.length > 0 && (
          <div>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Coming up</h4>
            <ul className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
              {upcoming.map((h) => (
                <li key={h.id} className="w-44 shrink-0 rounded-lg border border-border bg-card p-3">
                  <p className="text-xs text-muted-foreground">{relativeDay(h.date, today)}</p>
                  <p className="truncate text-sm font-semibold">{h.name}</p>
                  <p className="text-xs text-muted-foreground">{new Date(`${h.date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })}</p>
                </li>
              ))}
            </ul>
          </div>
        )}
        {hasOptional && (
          <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground" aria-live="polite">
            {optionalSummary(cap, taken, String(year))}
          </p>
        )}
        {holidays.length > 0 && mode === "list" && (
          <HolidayList holidays={holidays} action={(h) => <OptionalHolidayControl holiday={h} cap={cap} takenThisYear={taken} today={today} />} />
        )}
        {holidays.length > 0 && mode === "calendar" && <HolidayMonth month={month} setMonth={setMonth} byDate={byDate} today={today} />}
      </SectionCard>
    </div>
  );
}

function HolidayBadges({ h }: Readonly<{ h: { date: string; isOptional: boolean; optedIn?: boolean } }>) {
  const note = fallsOnNote(h.date);
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Badge variant={h.isOptional ? "muted" : "info"}>{h.isOptional ? (h.optedIn ? "Optional · taken" : "Optional") : "Public"}</Badge>
      {note && <span className="text-xs text-muted-foreground">{note}</span>}
    </span>
  );
}

type HolidayItem = { id: string; date: string; name: string; isOptional: boolean; optedIn?: boolean };

function HolidayList({ holidays, action }: Readonly<{ holidays: HolidayItem[]; action?: (h: HolidayItem) => ReactNode }>) {
  return (
    <div className="grid gap-4">
      {groupByMonth(holidays).map((g) => (
        <section key={g.month} aria-label={monthLabel(g.month)}>
          <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{monthLabel(g.month)}</h4>
          <ul className="grid gap-1.5">
            {g.items.map((h) => (
              <li key={h.id} className="flex min-w-0 flex-wrap items-center gap-3 rounded-md border border-border px-3 py-2">
                <span className="status-fill status-holiday grid h-10 w-10 shrink-0 place-items-center rounded-md text-center leading-none">
                  <span className="text-sm font-bold tabular-nums">{h.date.slice(8)}</span>
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{h.name}</p>
                  <p className="text-xs text-muted-foreground">{new Date(`${h.date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" })}</p>
                </div>
                <HolidayBadges h={h} />
                {action?.(h)}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function HolidayMonth({ month, setMonth, byDate, today }: Readonly<{ month: string; setMonth: (m: string) => void; byDate: Map<string, { id: string; date: string; name: string; isOptional: boolean }>; today: string }>) {
  const grid = useMemo(() => buildMonthGrid(month, today, (d) => byDate.get(d)), [month, today, byDate]);
  const monthItems = [...byDate.values()].filter((h) => h.date.startsWith(month)).sort((a, b) => a.date.localeCompare(b.date));
  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between gap-2">
        <Button variant="outline" size="icon" aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}>
          <ChevronUp className="h-4 w-4 -rotate-90" aria-hidden="true" />
        </Button>
        <span className="text-sm font-semibold">{monthLabel(month)}</span>
        <Button variant="outline" size="icon" aria-label="Next month" onClick={() => setMonth(shiftMonth(month, 1))}>
          <ChevronUp className="h-4 w-4 rotate-90" aria-hidden="true" />
        </Button>
      </div>
      <div role="grid" aria-label={`${monthLabel(month)} holidays`} className="grid gap-1">
        <div role="row" className="grid grid-cols-7 gap-1 text-center text-[11px] font-medium text-muted-foreground">
          {WEEKDAY_HEADERS.map((w) => (
            <span key={w} role="columnheader" className="py-1">
              {w}
            </span>
          ))}
        </div>
        {grid.map((row) => (
          <div key={row[0].date} role="row" className="grid grid-cols-7 gap-1">
            {row.map((c) => (
              <div
                key={c.date}
                role="gridcell"
                aria-label={c.data ? `${c.day} ${monthLabel(month)}, ${holidayLabel(c.data.name, c.data.isOptional)}` : undefined}
                className={cn(
                  "min-h-[44px] rounded-md p-1 text-[11px] sm:min-h-[56px]",
                  !c.inMonth && "text-muted-foreground/40",
                  c.data ? "status-cell status-holiday" : "text-muted-foreground",
                  c.isToday && "ring-2 ring-primary"
                )}
              >
                <span className="font-semibold tabular-nums">{c.day}</span>
                {c.data && <span className="mt-0.5 hidden truncate text-[10px] font-medium sm:block">{c.data.name}</span>}
                {c.data && <Star className="mt-0.5 h-3 w-3 sm:hidden" aria-hidden="true" />}
              </div>
            ))}
          </div>
        ))}
      </div>
      {monthItems.length > 0 ? (
        <ul className="grid gap-1.5">
          {monthItems.map((h) => (
            <li key={h.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 text-sm">
              <span className="min-w-0 truncate">
                <span className="font-medium">{h.name}</span>
                <span className="text-muted-foreground"> · {Number(h.date.slice(8))} {monthLabel(month).split(" ")[0]}</span>
              </span>
              <HolidayBadges h={h} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <FileText className="h-3.5 w-3.5" aria-hidden="true" />
          No holidays this month.
        </p>
      )}
    </div>
  );
}
