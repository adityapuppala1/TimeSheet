/**
 * Team (V17 UI v2): who is in today as tiles that double as filters, an avatar board or a table
 * (remembered per person), the person timeline drawer, and the team leave calendar.
 *
 * A phone shows a segmented control [Who's in | Approvals | Calendar | Insights]; a wide screen shows
 * the board with the Approvals inbox as a 320px rail. The table exists from 768px up only: below
 * that the same people read as two-line rows, never a dense grid.
 *
 * Locations are coarse labels (the API never sends coordinates), a person's leave is shown by type
 * only, and nothing here ranks people by punctuality.
 */
import { runInBackground } from "../../lib/run-in-background";
import { useQuery } from "@tanstack/react-query";
import { CalendarRange, ChevronLeft, ChevronRight, Clock, FileEdit, FilePlus2, Fingerprint, LogIn, Mail, MessageSquareText, Plane, Search, Send, ShieldCheck, Users2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { addDayKeys, monthBounds, monthLabel, monthOf, shiftMonth, weekDays } from "../../lib/attendance-calendar";
import { groupTimelineByDay, relativeTime, type TimelineDay } from "../../lib/attendance-team";
import { clockText, minutesLate, STATUS_META, type StatusKey } from "../../lib/attendance-status";
import { dayLoads, leaveCellTitle, portionOn, teamMatrix } from "../../lib/leave-ui";
import { cn } from "../../lib/utils";
import { attendanceTeamApi, type PunchSourceKind, type TeamDayRow, type TeamDayStatus, type TimelineEvent, type TimelineKind } from "../../services/attendance-api";
import { leaveApi, type TeamLeaveItem } from "../../services/leave-api";
import { useAuthStore } from "../../store/auth";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { DatePicker } from "../ui/date-picker";
import { EmptyState } from "../ui/empty-state";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../ui/sheet";
import { Skeleton } from "../ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { AttendanceStatusBadge } from "./AttendanceStatusBadge";
import { CardError, PersonAvatar, Segmented, SectionCard, todayKey } from "./attendance-ui";
import { CelebrationsStrip } from "./Celebrations";

const ALL = "ALL";
const PAGE_SIZE = 100;
type View = "cards" | "table";

/* ------------------------------ remembered view ------------------------------ */

function useRememberedView(userId: string | undefined): [View, (v: View) => void] {
  const key = `attendance.team.view.${userId ?? "anon"}`;
  const [view, setView] = useState<View>("cards");
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(key);
      if (stored === "cards" || stored === "table") setView(stored);
    } catch {
      /* storage blocked: the default is fine */
    }
  }, [key]);
  return [
    view,
    (v) => {
      setView(v);
      try {
        window.localStorage.setItem(key, v);
      } catch {
        /* a preference we could not save is not worth an error */
      }
    }
  ];
}

/* ----------------------------------- helpers ----------------------------------- */

function rowKey(row: TeamDayRow, lateness: { enabled: boolean; expectedStartMinute: number } | null): StatusKey {
  if (row.status === "PRESENT" && lateness?.enabled && row.punch && minutesLate(row.punch.punchInAt, lateness.expectedStartMinute) > 0) return "LATE";
  return row.status;
}

function matchesStatus(r: TeamDayRow, status: string, lateness: { enabled: boolean; expectedStartMinute: number } | null): boolean {
  if (status === ALL) return true;
  if (status === "LATE") return rowKey(r, lateness) === "LATE";
  return r.status === status;
}

function punchText(row: TeamDayRow): string {
  if (!row.punch) {
    if (row.status === "LEAVE" && row.leave) return `On leave (${row.leave.type})`;
    return row.holidayName ?? "No punch yet";
  }
  return `${clockText(row.punch.punchInAt)} · ${row.punch.sourceLabel}`;
}

function timesheetText(row: TeamDayRow): string {
  if (row.timesheet.state === "NONE") return "None";
  return `${row.timesheet.hours}h · ${row.timesheet.state === "SUBMITTED" ? "Submitted" : "Draft"}`;
}

interface Tile {
  key: StatusKey;
  filter: TeamDayStatus | "LATE";
  count: number;
}

/* ------------------------------------ Who's in ------------------------------------ */

export function WhosInBoard({ leaveOn, lateness }: Readonly<{ leaveOn: boolean; lateness: { enabled: boolean; expectedStartMinute: number } | null }>) {
  const userId = useAuthStore((s) => s.user?.id);
  const [view, setView] = useRememberedView(userId);
  const [date, setDate] = useState(todayKey);
  const [status, setStatus] = useState<TeamDayStatus | "LATE" | typeof ALL>(ALL);
  const [source, setSource] = useState<PunchSourceKind | typeof ALL>(ALL);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<TeamDayRow | null>(null);

  // One read of the whole (≤100) team: the tiles' counts, the filter and the board all come from it,
  // so a tile's number always equals what clicking it shows.
  const params = { date, search: search.trim() || undefined, source: source === ALL ? undefined : source, page: 1, pageSize: PAGE_SIZE };
  const team = useQuery({ queryKey: ["attendance", "team", params], queryFn: () => attendanceTeamApi.teamDay(params) });
  const rows = useMemo(() => team.data?.rows ?? [], [team.data]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { PRESENT: 0, PENDING: 0, ABSENT: 0, LEAVE: 0, HOLIDAY: 0, LATE: 0 };
    for (const r of rows) {
      if (r.status in c) c[r.status] += 1;
      if (rowKey(r, lateness) === "LATE") c.LATE += 1;
    }
    // The page holds at most PAGE_SIZE people; Late is counted by the server over everyone in scope.
    if (typeof team.data?.late === "number") c.LATE = team.data.late;
    return c;
  }, [rows, lateness, team.data]);

  const tiles: Tile[] = [
    { key: "PRESENT", filter: "PRESENT", count: counts.PRESENT },
    ...(lateness?.enabled ? [{ key: "LATE" as const, filter: "LATE" as const, count: counts.LATE }] : []),
    { key: "PENDING", filter: "PENDING", count: counts.PENDING },
    { key: "ABSENT", filter: "ABSENT", count: counts.ABSENT },
    ...(leaveOn ? [{ key: "LEAVE" as const, filter: "LEAVE" as const, count: counts.LEAVE }] : []),
    { key: "HOLIDAY", filter: "HOLIDAY", count: counts.HOLIDAY }
  ];

  const visible = rows.filter((r) => matchesStatus(r, status, lateness));

  return (
    <div className="grid min-w-0 gap-4">
      <div role="group" aria-label="Filter by status" className="grid grid-cols-2 gap-2 sm:grid-cols-3 2xl:grid-cols-6">
        {tiles.map((t) => {
          const active = status === t.filter;
          const meta = STATUS_META[t.key];
          return (
            <button
              key={t.key}
              type="button"
              aria-pressed={active}
              onClick={() => setStatus(active ? ALL : t.filter)}
              className={cn(
                "focus-ring flex min-h-[64px] min-w-0 items-center gap-2.5 rounded-lg border bg-card p-2.5 text-left transition-colors",
                active ? "border-primary ring-2 ring-primary" : "border-border hover:bg-muted/50"
              )}
            >
              <span className={cn("status-fill grid h-8 w-8 shrink-0 place-items-center rounded-full", meta.className)}>
                <meta.icon className="h-4 w-4" aria-hidden="true" />
              </span>
              <span className="min-w-0">
                <span className="block text-lg font-black leading-none tabular-nums">{team.isLoading ? "–" : t.count}</span>
                <span className="block truncate text-xs text-muted-foreground">{meta.label}</span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <DatePicker value={date} onChange={setDate} className="w-full sm:w-44" />
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search people" aria-label="Search people" className="pl-8" />
        </div>
        <Select value={source} onValueChange={(v) => setSource(v as PunchSourceKind | typeof ALL)}>
          <SelectTrigger className="w-full sm:w-40" aria-label="Filter by source">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All sources</SelectItem>
            <SelectItem value="WEB">Web</SelectItem>
            <SelectItem value="API">API</SelectItem>
            <SelectItem value="WEBHOOK">Integration</SelectItem>
            <SelectItem value="MCP">AI assistant</SelectItem>
            <SelectItem value="CSV">Import</SelectItem>
          </SelectContent>
        </Select>
        <Segmented
          label="View"
          value={view}
          onChange={setView}
          className="ml-auto"
          options={[
            { value: "cards", label: "Cards" },
            { value: "table", label: "Table" }
          ]}
        />
      </div>

      {team.isLoading && <Skeleton className="h-64 w-full" aria-busy="true" />}
      {team.isError && <CardError message="Team attendance could not be loaded. The module may be off, or this view is not open to your role." onRetry={() => runInBackground(team.refetch())} />}
      {team.data && visible.length === 0 && (
        <EmptyState icon={Users2} title="Nobody to show" description={status === ALL ? "No one in your team matches these filters for this day." : "No one has this status. Pick the tile again to clear it."} />
      )}
      {team.data && visible.length > 0 && (view === "cards" ? <AvatarBoard rows={visible} lateness={lateness} onOpen={setSelected} /> : <TeamTable rows={visible} lateness={lateness} onOpen={setSelected} />)}
      {team.data && team.data.total > PAGE_SIZE && <p className="text-xs text-muted-foreground">Showing the first {PAGE_SIZE} of {team.data.total}. Narrow the search to find someone else.</p>}

      <TimelineSheet row={selected} date={date} onClose={() => setSelected(null)} />
    </div>
  );
}

function AvatarBoard({ rows, lateness, onOpen }: Readonly<{ rows: TeamDayRow[]; lateness: { enabled: boolean; expectedStartMinute: number } | null; onOpen: (r: TeamDayRow) => void }>) {
  return (
    <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
      {rows.map((row) => {
        const key = rowKey(row, lateness);
        const meta = STATUS_META[key];
        return (
          <li key={row.user.id} className="min-w-0">
            <button
              type="button"
              onClick={() => onOpen(row)}
              aria-label={`${row.user.name}, ${meta.label}. Open timeline`}
              className="focus-ring grid min-h-[44px] w-full min-w-0 justify-items-center gap-1.5 rounded-lg border border-border bg-card p-3 text-center transition-colors hover:bg-muted/50"
            >
              <span className="relative">
                <PersonAvatar name={row.user.name} avatarUrl={row.user.avatarUrl} className="h-12 w-12" />
                <AttendanceStatusBadge statusKey={key} compact className="absolute -bottom-1 -right-1 h-5 w-5 ring-2 ring-card" />
              </span>
              <span className="w-full truncate text-sm font-medium">{row.user.name}</span>
              <span className="w-full truncate text-xs text-muted-foreground">{punchText(row)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function PersonCell({ row }: Readonly<{ row: TeamDayRow }>) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <PersonAvatar name={row.user.name} avatarUrl={row.user.avatarUrl} />
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{row.user.name}</p>
        <p className="truncate text-xs text-muted-foreground">{row.user.title.replaceAll("_", " ").toLowerCase()}</p>
      </div>
    </div>
  );
}

function FaceBadge({ face }: Readonly<{ face: "PASSED" | "FLAGGED" | "NONE" | undefined }>) {
  if (face === "PASSED") return <Badge variant="success"><ShieldCheck className="mr-1 h-3 w-3" aria-hidden="true" />Verified</Badge>;
  if (face === "FLAGGED") return <Badge variant="warning">Flagged</Badge>;
  return <span className="text-xs text-muted-foreground">—</span>;
}

function RowNotes({ row }: Readonly<{ row: TeamDayRow }>) {
  return (
    <div className="flex flex-wrap gap-1">
      {row.missedReason && <Badge variant="info">Reason: {row.missedReason.code.replaceAll("_", " ").toLowerCase()}</Badge>}
      {row.reminderSent && <Badge variant="muted"><Mail className="mr-1 h-3 w-3" aria-hidden="true" />Reminded</Badge>}
    </div>
  );
}

function TeamTable({ rows, lateness, onOpen }: Readonly<{ rows: TeamDayRow[]; lateness: { enabled: boolean; expectedStartMinute: number } | null; onOpen: (r: TeamDayRow) => void }>) {
  return (
    <>
      <div className="hidden rounded-lg border border-border md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Person</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Punch-in</TableHead>
              <TableHead>Location</TableHead>
              <TableHead>Face</TableHead>
              <TableHead>Timesheet</TableHead>
              <TableHead>Notes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow
                key={row.user.id}
                tabIndex={0}
                onClick={() => onOpen(row)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onOpen(row);
                  }
                }}
                className="cursor-pointer"
                aria-label={`Open ${row.user.name}'s timeline`}
              >
                <TableCell className="max-w-[16rem]"><PersonCell row={row} /></TableCell>
                <TableCell><AttendanceStatusBadge statusKey={rowKey(row, lateness)} /></TableCell>
                <TableCell className="whitespace-nowrap text-sm">{punchText(row)}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{row.punch?.location ?? "—"}</TableCell>
                <TableCell><FaceBadge face={row.punch?.face} /></TableCell>
                <TableCell className="whitespace-nowrap text-sm">{timesheetText(row)}</TableCell>
                <TableCell className="text-xs text-muted-foreground"><RowNotes row={row} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul className="grid min-w-0 gap-2 md:hidden">
        {rows.map((row) => (
          <li key={row.user.id} className="min-w-0">
            <button type="button" onClick={() => onOpen(row)} className="focus-ring grid min-h-[44px] w-full min-w-0 gap-1.5 rounded-lg border border-border bg-card p-3 text-left">
              <span className="flex min-w-0 items-center justify-between gap-2">
                <PersonCell row={row} />
                <AttendanceStatusBadge statusKey={rowKey(row, lateness)} />
              </span>
              <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>{punchText(row)}</span>
                <span>Timesheet: {timesheetText(row)}</span>
                <FaceBadge face={row.punch?.face} />
              </span>
              <RowNotes row={row} />
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

/* ----------------------------------- Timeline ----------------------------------- */

const KIND_ICONS: Record<TimelineKind, typeof LogIn> = {
  LOGIN: LogIn,
  PUNCH_IN: Fingerprint,
  TIMESHEET_CREATED: FilePlus2,
  TIMESHEET_SUBMITTED: Send,
  TIMESHEET_UPDATED: FileEdit,
  MISSED_REASON: MessageSquareText,
  REMINDER_EMAIL: Mail,
  LEAVE: Plane
};

function TimelineSheet({ row, date, onClose }: Readonly<{ row: TeamDayRow | null; date: string; onClose: () => void }>) {
  const from = addDayKeys(date, -6);
  const timeline = useQuery({
    queryKey: ["attendance", "timeline", row?.user.id, from, date],
    queryFn: () => attendanceTeamApi.timeline(row!.user.id, from, date),
    enabled: Boolean(row)
  });
  const days = useMemo(() => groupTimelineByDay(timeline.data?.events ?? []), [timeline.data]);
  return (
    <Sheet open={Boolean(row)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="flex w-full max-w-md flex-col overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex min-w-0 items-center gap-2">
            {row && <PersonAvatar name={row.user.name} avatarUrl={row.user.avatarUrl} className="h-8 w-8" />}
            <span className="min-w-0 truncate">{row?.user.name ?? "Timeline"}</span>
          </SheetTitle>
          <SheetDescription>Activity for the 7 days up to {date}, in your timezone.</SheetDescription>
        </SheetHeader>
        {timeline.isLoading && <Skeleton className="mt-4 h-48 w-full" />}
        {timeline.isError && <div className="mt-4"><CardError message="This timeline could not be loaded." onRetry={() => runInBackground(timeline.refetch())} /></div>}
        {timeline.data && days.length === 0 && <EmptyState compact icon={Clock} title="No activity in this window" />}
        {timeline.data && days.length > 0 && <TimelineDays days={days} />}
      </SheetContent>
    </Sheet>
  );
}

function TimelineDays({ days }: Readonly<{ days: Array<TimelineDay<TimelineEvent>> }>) {
  return (
    <div className="mt-4 grid gap-5">
      {days.map((day) => (
        <section key={day.dateKey} aria-label={day.dateKey} className="grid gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {new Date(`${day.dateKey}T12:00:00Z`).toLocaleDateString([], { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" })}
          </h3>
          <ol className="relative grid gap-3 border-l border-border pl-5">
            {day.events.map((event, i) => {
              const Icon = KIND_ICONS[event.kind];
              return (
                <li key={`${event.at}-${i}`} className="relative motion-safe:animate-in motion-safe:fade-in">
                  <span className="absolute -left-[1.85rem] grid h-6 w-6 place-items-center rounded-full border border-border bg-card">
                    <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                  </span>
                  <p className="text-sm font-medium">{event.label}</p>
                  <p className="text-xs text-muted-foreground">
                    <time dateTime={event.at} title={new Date(event.at).toLocaleString()}>
                      {clockText(event.at)} · {relativeTime(event.at)}
                    </time>
                    {event.detail ? ` · ${event.detail}` : ""}
                  </p>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}

/* ------------------------------- Team leave calendar ------------------------------- */

type CalendarSpan = "week" | "month";

export function TeamLeaveCalendar() {
  const today = todayKey();
  const [span, setSpan] = useState<CalendarSpan>("week");
  const [anchor, setAnchor] = useState(today);
  const days = useMemo(() => {
    if (span === "week") return weekDays(anchor);
    const { from, to } = monthBounds(monthOf(anchor));
    const out: string[] = [];
    for (let d = from; d <= to; d = addDayKeys(d, 1)) out.push(d);
    return out;
  }, [span, anchor]);
  const from = days[0];
  const to = days[days.length - 1];

  const leave = useQuery({ queryKey: ["leave", "team", from, to], queryFn: () => leaveApi.team(from, to) });
  const people = useQuery({ queryKey: ["attendance", "team", "people", today], queryFn: () => attendanceTeamApi.teamDay({ date: today, pageSize: 100, page: 1 }), staleTime: 60_000 });
  const peopleRows = useMemo(() => (people.data?.rows ?? []).map((r) => ({ id: r.user.id, name: r.user.name, avatarUrl: r.user.avatarUrl })), [people.data]);
  const items = useMemo(() => leave.data ?? [], [leave.data]);
  const matrix = useMemo(() => teamMatrix(peopleRows, items), [peopleRows, items]);
  const loads = useMemo(() => dayLoads(days, items, Math.max(matrix.rows.length, people.data?.total ?? 0), 0.25), [days, items, matrix.rows.length, people.data]);

  const step = (dir: -1 | 1) => setAnchor(span === "week" ? addDayKeys(anchor, dir * 7) : `${shiftMonth(monthOf(anchor), dir)}-01`);
  const title = span === "week" ? `${shortLabel(days[0])} – ${shortLabel(days[6])}` : monthLabel(monthOf(anchor));
  const compact = days.length > 10;

  return (
    <>
    <CelebrationsStrip />
    <SectionCard
      title="Leave calendar"
      description="Who is off, by day. Pending requests are dashed. Busy days are hatched."
      headingId="team-leave-calendar"
      action={
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            label="Calendar range"
            value={span}
            onChange={(v) => {
              setSpan(v);
              setAnchor(today);
            }}
            options={[
              { value: "week", label: "Week" },
              { value: "month", label: "Month" }
            ]}
          />
          <div className="flex items-center gap-1">
            <Button variant="outline" size="icon" aria-label={`Previous ${span}`} onClick={() => step(-1)}>
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            </Button>
            <span className="min-w-[8rem] text-center text-sm font-semibold" aria-live="polite">{title}</span>
            <Button variant="outline" size="icon" aria-label={`Next ${span}`} onClick={() => step(1)}>
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
      }
    >
      {(leave.isLoading || people.isLoading) && <Skeleton className="h-56 w-full" aria-busy="true" />}
      {leave.isError && <CardError message="The leave calendar could not be loaded." onRetry={() => runInBackground(leave.refetch())} />}
      {leave.data && matrix.rows.length === 0 && <EmptyState compact icon={CalendarRange} title="No one to show" description="People who report to you appear here." />}
      {leave.data && matrix.rows.length > 0 && (
        <div className="min-w-0 overflow-x-auto rounded-md border border-border">
          <table className="w-full border-collapse text-xs" aria-label={`Team leave, ${title}`}>
            <thead>
              <tr>
                <th scope="col" className="sticky left-0 z-10 min-w-[8.5rem] bg-card px-2 py-2 text-left font-medium text-muted-foreground">Person</th>
                {days.map((d, i) => {
                  const load = loads[i];
                  const weekend = isWeekend(d);
                  return (
                    <th
                      key={d}
                      scope="col"
                      aria-label={shortLabel(d) + (load.busy ? ", busy: " + load.off + " people off" : "")}
                      className={cn("px-0.5 py-1 text-center font-medium", compact ? "min-w-[1.75rem]" : "min-w-[3.25rem]", weekend && "bg-muted/50 text-muted-foreground", load.busy && "busy-hatch")}
                    >
                      <span className="block">{compact ? d.slice(8) : new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" })}</span>
                      {!compact && <span className="block text-[11px] font-normal">{d.slice(8)}</span>}
                      {load.busy && <span className="block text-[10px] font-bold text-warning-ink">{compact ? "!" : "Busy"}</span>}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {matrix.rows.map((p) => (
                <tr key={p.id} className="border-t border-border">
                  <th scope="row" className="sticky left-0 z-10 bg-card px-2 py-1.5 text-left font-medium">
                    <span className="flex min-w-0 items-center gap-2">
                      <PersonAvatar name={p.name} avatarUrl={p.avatarUrl} className="h-6 w-6" />
                      <span className="min-w-0 truncate">{p.name}</span>
                    </span>
                  </th>
                  {days.map((d, i) => (
                    <LeaveCell key={d} item={matrix.cell(p.id, d)} date={d} busy={loads[i].busy} weekend={isWeekend(d)} />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Calendar legend">
        <li className="flex items-center gap-1.5"><AttendanceStatusBadge statusKey="LEAVE" label="Approved" /></li>
        <li className="flex items-center gap-1.5"><span className="status-cell status-leave inline-flex h-5 w-8 items-center justify-center rounded border-dashed text-[10px] font-bold">PL</span>Pending</li>
        <li className="flex items-center gap-1.5"><span className="busy-hatch inline-block h-5 w-8 rounded border border-border" aria-hidden="true" />Busy day, a quarter or more of the team off</li>
      </ul>
    </SectionCard>
    </>
  );
}

const isWeekend = (key: string) => [0, 6].includes(new Date(`${key}T12:00:00Z`).getUTCDay());
const shortLabel = (key: string) => new Date(`${key}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

function LeaveCell({ item, date, busy, weekend }: Readonly<{ item: TeamLeaveItem | null; date: string; busy: boolean; weekend: boolean }>) {
  if (!item) return <td className={cn("h-9 border-l border-border/40", weekend && "bg-muted/50", busy && "busy-hatch")} />;
  const pending = item.status === "PENDING";
  const half = portionOn(item, date);
  return (
    <td className={cn("h-9 border-l border-border/40 p-0.5", weekend && "bg-muted/50", busy && "busy-hatch")}>
      <span
        className={cn("status-cell status-leave flex h-7 items-center justify-center rounded text-[10px] font-bold", pending && "border-dashed")}
        title={leaveCellTitle(item.leaveType.name, half, pending)}
        aria-label={`${item.user.name}, ${item.leaveType.name}${pending ? ", pending approval" : ""}, ${shortLabel(date)}`}
      >
        {item.leaveType.code}
        {half !== "FULL" && <span aria-hidden="true">½</span>}
      </span>
    </td>
  );
}
