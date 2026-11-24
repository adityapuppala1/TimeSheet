/**
 * My attendance (V17 UI v2): the Today card, the week's hours against what is expected, a month
 * heat-map you can open day by day, the days that still need time logged, and (on a wide screen) a
 * right rail with leave balances, the next holidays and a Request leave button.
 *
 * Every card loads and fails on its own: a failed history never blanks the balances. Status is
 * always colour + icon + letter + text (lib/attendance-status.ts). There is deliberately no
 * "correct this day" request here, only the reason a person already gave and a link to log time.
 *
 * Mobile order: today, week, balances, calendar, needs attention, holidays, insights.
 */
import { runInBackground } from "../../lib/run-in-background";
import { useQuery } from "@tanstack/react-query";
import { CalendarCheck, CalendarDays, ChevronLeft, ChevronRight, Clock, Plane, Star } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { buildMonthGrid, addDayKeys, monthBounds, monthLabel, monthOf, shiftMonth, weekDays, WEEKDAY_HEADERS } from "../../lib/attendance-calendar";
import { humanCode } from "../../lib/attendance-analytics";
import { clockText, dayAriaLabel, punchLine, durationText, legendFor, shortDay, statusMetaFor, type StatusMeta } from "../../lib/attendance-status";
import { halfNote, relativeDay } from "../../lib/leave-ui";
import { useMediaQuery } from "../../lib/use-media-query";
import { cn } from "../../lib/utils";
import { attendanceAnalyticsApi, attendanceTeamApi, type MyHistoryDay, type MyToday } from "../../services/attendance-api";
import { leaveApi, type LeaveBalance } from "../../services/leave-api";
import { PunchedInPanel, useMyToday } from "../PunchIn";
import { usePunchInGate } from "../../lib/punch-in-gate";
import { Button } from "../ui/button";
import { EmptyState } from "../ui/empty-state";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../ui/sheet";
import { Skeleton } from "../ui/skeleton";
import { AttendanceStatusBadge } from "./AttendanceStatusBadge";
import { CompOffDayAction, MyCompOffCard } from "./CompOff";
import { CardError, SectionCard, todayKey } from "./attendance-ui";
import { leaveColour, useLeaveBalances, useLeaveEnabled, useMyHolidays } from "./use-leave";

/* --------------------------------- Today --------------------------------- */

function TodayCard({ today, lateness }: Readonly<{ today: MyToday; lateness: { enabled: boolean; expectedStartMinute: number } | null }>) {
  const requestReopen = usePunchInGate((s) => s.requestReopen);
  const status = today.status ?? "PENDING";
  const meta = statusMetaFor({
    status,
    punchInAt: today.record?.punchInAt,
    latenessEnabled: lateness?.enabled,
    expectedStartMinute: lateness?.expectedStartMinute
  });
  const date = new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
  const canPunch = !today.record && today.isWorkingDay && today.punchInMode && today.punchInMode !== "OFF" && status !== "LEAVE";
  return (
    <SectionCard title="Today" description={date} action={<AttendanceStatusBadge statusKey={meta.key} />} headingId="att-today">
      {today.record ? (
        <PunchedInPanel record={today.record} />
      ) : (
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <p className="min-w-0 text-sm text-muted-foreground">{notPunchedText(today)}</p>
          {canPunch && (
            <Button className="min-h-[44px]" onClick={() => requestReopen(true)}>
              <Clock className="mr-2 h-4 w-4" aria-hidden="true" />
              Punch in
            </Button>
          )}
        </div>
      )}
    </SectionCard>
  );
}

function notPunchedText(today: MyToday): string {
  if (today.status === "HOLIDAY") return today.holidayName ? `Holiday: ${today.holidayName}.` : "Today is a holiday.";
  if (today.status === "WEEKEND" || today.isWorkingDay === false) return "Today is not a working day.";
  if (today.status === "LEAVE") return "You are on approved leave today.";
  if (today.punchInMode === "OFF") return "Punching in from the web is off. Your punch arrives from a connected source.";
  return "You have not punched in yet.";
}

/* ---------------------------------- Week --------------------------------- */

function WeekBar({ logged, expected }: Readonly<{ logged: number; expected: number }>) {
  const scale = Math.max(expected, logged, 1);
  const left = Math.max(0, expected - logged);
  const label = `${round1(logged)}h logged of ${round1(expected)}h expected this week`;
  return (
    <SectionCard title="This week" description="Hours logged against what is expected, after holidays and approved leave." headingId="att-week">
      <div className="grid gap-2">
        <div className="relative h-3 rounded-full bg-muted" role="img" aria-label={label}>
          <div className="h-3 rounded-full bg-primary/80" style={{ width: `${Math.min(100, (logged / scale) * 100)}%` }} />
          {expected > 0 && (
            <span className="absolute -top-1 h-5 w-0.5 rounded bg-foreground" style={{ left: `calc(${Math.min(100, (expected / scale) * 100)}% - 1px)` }} aria-hidden="true" />
          )}
        </div>
        <p className="flex flex-wrap justify-between gap-x-3 text-sm">
          <span>
            <span className="font-semibold tabular-nums">{round1(logged)}h</span>
            <span className="text-muted-foreground"> of {round1(expected)}h</span>
          </span>
          <span className="text-muted-foreground">{left > 0 ? `${round1(left)}h to go` : "Target reached"}</span>
        </p>
      </div>
    </SectionCard>
  );
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/* -------------------------------- Calendar -------------------------------- */

function Legend({ leaveOn, latenessOn }: Readonly<{ leaveOn: boolean; latenessOn: boolean }>) {
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Legend">
      {legendFor({ latenessEnabled: latenessOn, leaveEnabled: leaveOn }).map((m) => (
        <li key={m.key}>
          <AttendanceStatusBadge statusKey={m.key} />
        </li>
      ))}
    </ul>
  );
}

interface CellData {
  day: MyHistoryDay;
  meta: StatusMeta;
  future: boolean;
}

function MonthCalendar({
  today,
  lateness,
  leaveOn,
  month,
  setMonth,
  days,
  loading,
  error,
  onRetry,
  onOpen
}: Readonly<{
  today: string;
  lateness: { enabled: boolean; expectedStartMinute: number } | null;
  leaveOn: boolean;
  month: string;
  setMonth: (m: string) => void;
  days: Map<string, MyHistoryDay>;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  onOpen: (d: CellData) => void;
}>) {
  const grid = useMemo(
    () =>
      buildMonthGrid<CellData>(month, today, (d) => {
        const day = days.get(d);
        if (!day) return null;
        const future = d > today;
        return { day, future, meta: statusMetaFor({ status: day.status, punchInAt: day.punchInAt, latenessEnabled: lateness?.enabled, expectedStartMinute: lateness?.expectedStartMinute }) };
      }),
    [month, today, days, lateness]
  );
  const next = shiftMonth(month, 1);
  return (
    <SectionCard
      title="Month"
      headingId="att-month"
      action={
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}>
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </Button>
          <span className="min-w-[8.5rem] text-center text-sm font-semibold" aria-live="polite">
            {monthLabel(month)}
          </span>
          <Button variant="outline" size="icon" aria-label="Next month" disabled={next > monthOf(addDayKeys(today, 62))} onClick={() => setMonth(next)}>
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      }
    >
      {error && <CardError message="Your days could not be loaded." onRetry={onRetry} />}
      {!error && loading && <Skeleton className="h-72 w-full" />}
      {!error && !loading && (
        <div role="grid" aria-label={`${monthLabel(month)} attendance`} className="grid gap-1">
          <div role="row" className="grid grid-cols-7 gap-1 text-center text-[11px] font-medium text-muted-foreground">
            {WEEKDAY_HEADERS.map((w) => (
              <span key={w} role="columnheader" className="py-1">
                {w}
              </span>
            ))}
          </div>
          {grid.map((row) => (
            <div key={row[0].date} role="row" className="grid grid-cols-7 gap-1">
              {row.map((cell) => (
                <CalendarCell key={cell.date} cell={cell} onOpen={onOpen} />
              ))}
            </div>
          ))}
        </div>
      )}
      <Legend leaveOn={leaveOn} latenessOn={Boolean(lateness?.enabled)} />
    </SectionCard>
  );
}

function CalendarCell({ cell, onOpen }: Readonly<{ cell: { date: string; day: number; inMonth: boolean; isToday: boolean; data: CellData | null }; onOpen: (d: CellData) => void }>) {
  if (!cell.inMonth || !cell.data) {
    return (
      <div role="gridcell" aria-hidden={!cell.inMonth} className={cn("min-h-[44px] rounded-md p-1 text-[11px] sm:min-h-[52px]", cell.inMonth ? "text-muted-foreground" : "text-muted-foreground/40")}>
        {cell.day}
      </div>
    );
  }
  const { day, meta, future } = cell.data;
  // A future working day with nothing known yet stays blank: "Not yet in" would read as a verdict.
  const blank = future && day.status === "PENDING";
  return (
    <div role="gridcell">
      <button
        type="button"
        onClick={() => onOpen(cell.data!)}
        aria-label={blank ? `${shortDay(day.date)}, upcoming` : dayAriaLabel({ ...day, leaveName: day.leave?.type }, meta)}
        aria-current={cell.isToday ? "date" : undefined}
        className={cn(
          "focus-ring flex min-h-[44px] w-full min-w-0 flex-col justify-between rounded-md p-1 text-left transition-colors sm:min-h-[52px] sm:p-1.5",
          blank ? "border border-border/60 bg-transparent text-muted-foreground" : cn("status-cell", meta.className),
          cell.isToday && "ring-2 ring-primary ring-offset-1 ring-offset-background"
        )}
      >
        <span className="text-[11px] font-semibold leading-none tabular-nums">{cell.day}</span>
        {!blank && (
          <span className="flex items-center gap-0.5 text-[11px] font-bold leading-none" aria-hidden="true">
            <meta.icon className="hidden h-3 w-3 sm:block" />
            {meta.letter}
          </span>
        )}
      </button>
    </div>
  );
}

/* ---------------------------------- Day sheet ---------------------------------- */

function DaySheet({ data, onClose, today }: Readonly<{ data: CellData | null; onClose: () => void; today: string }>) {
  const phone = !useMediaQuery("(min-width: 640px)");
  const day = data?.day;
  return (
    <Sheet open={Boolean(data)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side={phone ? "bottom" : "right"} className={cn("overflow-y-auto", phone ? "max-h-[85dvh] rounded-t-2xl pb-[max(1.5rem,env(safe-area-inset-bottom))]" : "w-full max-w-md")}>
        {data && day && (
          <>
            <SheetHeader className="text-left">
              <SheetTitle>{new Date(`${day.date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })}</SheetTitle>
              <SheetDescription>{day.date === today ? "Today" : relativeDay(day.date, today)}</SheetDescription>
            </SheetHeader>
            <div className="mt-4 grid gap-4">
              <AttendanceStatusBadge statusKey={data.meta.key} className="justify-self-start" />
              <dl className="grid gap-3 text-sm">
                <Row label="Punch-in" value={punchLine(day.punchInAt, day.sourceLabel)} />
                {day.punchInAt && (
                  <Row
                    label="Punch-out"
                    value={
                      day.punchOutAt
                        ? `${clockText(day.punchOutAt)} · ${durationText(Math.round((new Date(day.punchOutAt).getTime() - new Date(day.punchInAt).getTime()) / 60_000))}`
                        : "Not recorded"
                    }
                  />
                )}
                {day.face && day.face !== "NONE" && <Row label="Face check" value={day.face === "PASSED" ? "Verified" : "Flagged for review"} />}
                <Row label="Timesheet" value={day.hours == null ? "No time logged" : `${round1(day.hours)}h logged`} />
                {day.holidayName && <Row label="Holiday" value={day.holidayName} />}
                {day.leave && <Row label="Leave" value={day.leave.type + halfNote(day.leave.half)} />}
                {day.reasonCode && <Row label="Reason you gave" value={humanCode(day.reasonCode)} />}
              </dl>
              {day.isWorkingDay && day.date <= today && day.hours == null && (
                <Button asChild variant="outline" className="min-h-[44px]">
                  <Link to="/app/timesheet">Log time</Link>
                </Button>
              )}
              <CompOffDayAction date={day.date} isWorkingDay={day.isWorkingDay} />
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Row({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div className="flex min-w-0 justify-between gap-4 border-b border-border/60 pb-2">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right font-medium">{value}</dd>
    </div>
  );
}

/* ------------------------------ Needs attention ------------------------------ */

function NeedsAttention({ days, today }: Readonly<{ days: MyHistoryDay[]; today: string }>) {
  const missing = days
    .filter((d) => d.isWorkingDay && d.date < today && d.hours == null && (d.status === "PRESENT" || d.status === "ABSENT"))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 5);
  return (
    <SectionCard title="Needs attention" description="Past working days with no time logged." headingId="att-attention">
      {missing.length === 0 ? (
        <EmptyState compact icon={CalendarCheck} title="You are all caught up" description="Every recent working day has time logged." />
      ) : (
        <ul className="grid gap-2">
          {missing.map((d) => (
            <li key={d.date} className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
              <span className="min-w-0 text-sm">
                <span className="font-medium">{shortDay(d.date)}</span>
                <span className="text-muted-foreground"> · {d.status === "PRESENT" ? "punched in, no time logged" : "no punch, no time logged"}</span>
              </span>
              <Button asChild size="sm" variant="outline" className="min-h-[44px] shrink-0 sm:min-h-8">
                <Link to="/app/timesheet">Log time</Link>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

/* ----------------------------------- Rail ----------------------------------- */

function Ring({ balance }: Readonly<{ balance: LeaveBalance }>) {
  const total = Math.max(balance.accrued + balance.carriedForward + balance.adjusted, balance.available, 1);
  const pct = Math.max(0, Math.min(1, balance.available / total));
  const r = 22;
  const c = 2 * Math.PI * r;
  return (
    <div className="grid w-[88px] shrink-0 justify-items-center gap-1 text-center" role="img" aria-label={`${balance.leaveType.name}: ${round1(balance.available)} of ${round1(total)} days left`}>
      <svg viewBox="0 0 56 56" className="h-14 w-14 -rotate-90" aria-hidden="true">
        <circle cx="28" cy="28" r={r} fill="none" strokeWidth="6" style={{ stroke: "hsl(var(--muted))" }} />
        <circle cx="28" cy="28" r={r} fill="none" strokeWidth="6" strokeLinecap="round" strokeDasharray={`${c * pct} ${c}`} style={{ stroke: leaveColour(balance.leaveType.colour) }} />
      </svg>
      <p className="-mt-1 text-sm font-bold tabular-nums">
        {round1(balance.available)}
        <span className="text-[11px] font-normal text-muted-foreground"> of {round1(total)}</span>
      </p>
      <p className="w-full truncate text-xs text-muted-foreground">{balance.leaveType.name}</p>
    </div>
  );
}

function BalancesCard() {
  const q = useLeaveBalances(true);
  return (
    <SectionCard title="Leave balance" description={q.data ? `Leave year ${q.data.leaveYear}` : undefined} headingId="att-balances">
      {q.isLoading && <Skeleton className="h-24 w-full" />}
      {q.isError && <CardError message="Balances could not be loaded." onRetry={() => runInBackground(q.refetch())} />}
      {q.data && q.data.balances.length === 0 && <EmptyState compact icon={Plane} title="No leave types yet" description="Your admin has not enabled one." />}
      {q.data && q.data.balances.length > 0 && (
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 lg:flex-wrap lg:overflow-visible">
          {q.data.balances.map((b) => (
            <Ring key={b.leaveType.id} balance={b} />
          ))}
        </div>
      )}
      <Button asChild className="min-h-[44px] w-full">
        <Link to="/app/attendance/leave">
          <Plane className="mr-2 h-4 w-4" aria-hidden="true" />
          Request leave
        </Link>
      </Button>
    </SectionCard>
  );
}

function NextHolidays({ today }: Readonly<{ today: string }>) {
  const q = useMyHolidays(today, addDayKeys(today, 365));
  const next = (q.data?.holidays ?? []).slice(0, 3);
  return (
    <SectionCard
      title="Next holidays"
      headingId="att-holidays"
      action={
        <Button asChild variant="ghost" size="sm" className="min-h-[44px] sm:min-h-8">
          <Link to="/app/attendance/leave/holidays">All</Link>
        </Button>
      }
    >
      {q.isLoading && <Skeleton className="h-16 w-full" />}
      {q.isError && <CardError message="Holidays could not be loaded." onRetry={() => runInBackground(q.refetch())} />}
      {q.data && next.length === 0 && <EmptyState compact icon={Star} title="No upcoming holidays" />}
      <ul className="grid gap-2">
        {next.map((h) => (
          <li key={h.id} className="flex min-w-0 items-center justify-between gap-3 text-sm">
            <span className="min-w-0 truncate">
              <span className="font-medium">{h.name}</span>
              <span className="text-muted-foreground"> · {shortDay(h.date)}</span>
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">{relativeDay(h.date, today)}</span>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

/* ---------------------------------- the view ---------------------------------- */

export function MyAttendanceView() {
  const today = todayKey();
  const leaveOn = useLeaveEnabled();
  const todayQ = useMyToday();
  const [month, setMonth] = useState(monthOf(today));
  const [open, setOpen] = useState<CellData | null>(null);
  const bounds = monthBounds(month);
  // A week either side, so the week bar and the needs-attention list work from the same read.
  const from = addDayKeys(bounds.from, -7);
  const to = addDayKeys(bounds.to, 7);
  const history = useQuery({ queryKey: ["attendance", "me", "history", from, to], queryFn: () => attendanceTeamApi.myHistory(from, to) });
  const week = weekDays(today);
  const weekQ = useQuery({ queryKey: ["attendance", "analytics", "me", week[0], week[6]], queryFn: () => attendanceAnalyticsApi.me(week[0], week[6]) });
  const expectedQ = useQuery({ queryKey: ["leave", "expected-hours", week[0], week[6]], queryFn: () => leaveApi.expectedHours(week[0], week[6]), enabled: leaveOn });
  const days = useMemo(() => new Map((history.data?.days ?? []).map((d) => [d.date, d])), [history.data]);
  const lateness = weekQ.data?.lateness ?? null;

  if (todayQ.isLoading) return <MySkeleton />;
  if (todayQ.data && !todayQ.data.enabled) {
    return <EmptyState icon={CalendarDays} title="Attendance is not switched on" description="Your workspace has not turned attendance on. Ask an admin if you expected to see it." />;
  }

  const expected = expectedQ.data?.expectedHours ?? weekQ.data?.summary.hours.expected ?? 0;
  const logged = weekQ.data?.summary.hours.logged ?? 0;

  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="order-1 min-w-0 lg:col-start-1">
        {todayQ.isError || !todayQ.data ? <CardError message="Today could not be loaded." onRetry={() => runInBackground(todayQ.refetch())} /> : <TodayCard today={todayQ.data} lateness={lateness} />}
      </div>
      <div className="order-2 min-w-0 lg:col-start-1">
        {weekQ.isError && <CardError message="Your week could not be loaded." onRetry={() => runInBackground(weekQ.refetch())} />}
        {!weekQ.isError && weekQ.isLoading && <Skeleton className="h-28 w-full" />}
        {!weekQ.isError && !weekQ.isLoading && <WeekBar logged={logged} expected={expected} />}
      </div>
      <div className="contents lg:col-start-2 lg:row-span-4 lg:row-start-1 lg:grid lg:content-start lg:gap-4">
        {leaveOn && (
          <div className="order-3 min-w-0">
            <BalancesCard />
          </div>
        )}
        {leaveOn && (
          <div className="order-3 min-w-0">
            <MyCompOffCard />
          </div>
        )}
        <div className="order-6 min-w-0">
          <NextHolidays today={today} />
        </div>
      </div>
      <div className="order-4 min-w-0 lg:col-start-1">
        <MonthCalendar
          today={today}
          lateness={lateness}
          leaveOn={leaveOn}
          month={month}
          setMonth={setMonth}
          days={days}
          loading={history.isLoading}
          error={history.isError}
          onRetry={() => runInBackground(history.refetch())}
          onOpen={setOpen}
        />
      </div>
      <div className="order-5 min-w-0 lg:col-start-1">
        {history.isError ? <CardError message="Your days could not be loaded." onRetry={() => runInBackground(history.refetch())} /> : <NeedsAttention days={history.data?.days ?? []} today={today} />}
      </div>
      <DaySheet data={open} onClose={() => setOpen(null)} today={today} />
    </div>
  );
}

function MySkeleton() {
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]" aria-busy="true" aria-label="Loading your attendance">
      <div className="grid gap-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-80 w-full" />
      </div>
      <div className="grid content-start gap-4">
        <Skeleton className="h-44 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    </div>
  );
}
