/**
 * Attendance (V17 A5): "My attendance" (your own days) and "Team" (who is in today, and each
 * person's day as a timeline). One page with two sub-routes rather than two pages, so the sidebar
 * carries one entry and A6's analytics can join as a third tab.
 *
 * V17 A6 adds analytics: an Analytics section under My attendance, an "Insights" tab inside Team,
 * and an "Organisation" tab for admins (components/attendance/AttendanceAnalytics.tsx).
 *
 * VISIBILITY: the Team tab shows only for the roles the server's teamScopeFor accepts; the server
 * still decides per request (a manager sees direct reports only, an admin everyone), so the tab is
 * convenience, not the control. Locations arrive as coarse labels — the API never sends coordinates.
 *
 * MOTION: opacity/transform only, behind `motion-safe:` so reduced-motion gets none.
 */
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CalendarCheck,
  Clock,
  FileEdit,
  FilePlus2,
  Fingerprint,
  LogIn,
  Mail,
  MessageSquareText,
  Plane,
  Search,
  Send,
  ShieldCheck,
  Users2
} from "lucide-react";
import { useMemo, useState } from "react";
import { NavLink, useLocation } from "react-router";
import { PageHeader } from "../components/PageHeader";
import { MyAnalyticsSection, OrgAnalyticsView, TeamInsightsView } from "../components/attendance/AttendanceAnalytics";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { ORG_VIEW_ROLES } from "../lib/attendance-analytics";
import { initialsFor } from "../components/AccountMenu";
import { Avatar, AvatarFallback, AvatarImage } from "../components/ui/avatar";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { DatePicker } from "../components/ui/date-picker";
import { EmptyState } from "../components/ui/empty-state";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../components/ui/sheet";
import { Skeleton } from "../components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import {
  groupTimelineByDay,
  type TimelineDay,
  relativeTime,
  STATUS_LABELS,
  STATUS_TONES,
  SUMMARY_CHIPS,
  TEAM_VIEW_ROLES
} from "../lib/attendance-team";
import { cn } from "../lib/utils";
import {
  attendanceTeamApi,
  type PunchSourceKind,
  type TeamDayRow,
  type TeamDayStatus,
  type TimelineEvent,
  type TimelineKind
} from "../services/attendance-api";
import { fileUrl } from "../services/api";
import { useAuthStore } from "../store/auth";

const PAGE_SIZE = 25;
const ALL = "ALL";

function todayKey(): string {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function shiftKey(key: string, days: number): string {
  return new Date(new Date(`${key}T12:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function StatusBadge({ status }: Readonly<{ status: TeamDayStatus }>) {
  return <Badge variant={STATUS_TONES[status]}>{STATUS_LABELS[status]}</Badge>;
}

export function AttendancePage() {
  const role = useAuthStore((s) => s.user?.role ?? "");
  const { pathname } = useLocation();
  const canSeeTeam = TEAM_VIEW_ROLES.has(role);
  const canSeeOrg = ORG_VIEW_ROLES.has(role);
  const onTeam = pathname.startsWith("/app/attendance/team");
  const onOrg = pathname.startsWith("/app/attendance/org");
  const tabs = [
    { to: "/app/attendance", label: "My attendance", end: true },
    { to: "/app/attendance/team", label: "Team", end: false },
    ...(canSeeOrg ? [{ to: "/app/attendance/org", label: "Organisation", end: false }] : [])
  ];

  return (
    <div className="grid min-w-0 gap-5">
      <PageHeader title="Attendance" description="Punch-ins, day status and timesheet activity." icon={Fingerprint} />
      {canSeeTeam && (
        <nav aria-label="Attendance views" className="flex gap-1 border-b border-border">
          {tabs.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={tab.end}
              className={({ isActive }) =>
                cn(
                  "focus-ring -mb-px border-b-2 px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground",
                  isActive ? "border-primary text-foreground" : "border-transparent"
                )
              }
            >
              {tab.label}
            </NavLink>
          ))}
        </nav>
      )}
      {onTeam && canSeeTeam && (
        <Tabs defaultValue="today" className="grid min-w-0 gap-4">
          <TabsList className="w-fit">
            <TabsTrigger value="today">Today</TabsTrigger>
            <TabsTrigger value="insights">Insights</TabsTrigger>
          </TabsList>
          <TabsContent value="today" className="min-w-0">
            <TeamView />
          </TabsContent>
          <TabsContent value="insights" className="min-w-0">
            <TeamInsightsView />
          </TabsContent>
        </Tabs>
      )}
      {onTeam && !canSeeTeam && (
        <EmptyState icon={Users2} title="Team attendance is for managers" description="Ask an admin if you need to see your team's attendance." />
      )}
      {onOrg && canSeeOrg && <OrgAnalyticsView />}
      {onOrg && !canSeeOrg && (
        <EmptyState icon={Users2} title="Organisation analytics are for admins" description="Ask an admin if you need workspace-wide attendance figures." />
      )}
      {!onTeam && !onOrg && (
        <div className="grid min-w-0 gap-6">
          <MyAttendanceView />
          <MyAnalyticsSection />
        </div>
      )}
    </div>
  );
}

/* --------------------------------- My attendance --------------------------------- */

function MyAttendanceView() {
  const to = todayKey();
  const from = shiftKey(to, -29);
  const history = useQuery({ queryKey: ["attendance", "me", "history", from, to], queryFn: () => attendanceTeamApi.myHistory(from, to) });

  if (history.isLoading) return <Skeleton className="h-64 w-full" />;
  if (history.isError) return <EmptyState icon={AlertTriangle} title="Attendance isn't available" description="The module may be switched off for this workspace." />;
  const days = [...(history.data?.days ?? [])].reverse();
  if (days.length === 0) return <EmptyState icon={CalendarCheck} title="No days yet" />;

  return (
    <section aria-label="Last 30 days" className="grid gap-2">
      <h2 className="text-sm font-semibold text-muted-foreground">Last 30 days</h2>
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {days.map((day) => (
          <li key={day.date} className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2.5">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {new Date(`${day.date}T12:00:00Z`).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {day.punchInAt ? `${timeOf(day.punchInAt)} · ${day.sourceLabel ?? ""}` : (day.holidayName ?? "No punch")}
              </p>
            </div>
            <StatusBadge status={day.status} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ------------------------------------- Team ------------------------------------- */

function TeamView() {
  const [date, setDate] = useState(todayKey);
  const [status, setStatus] = useState<TeamDayStatus | typeof ALL>(ALL);
  const [source, setSource] = useState<PunchSourceKind | typeof ALL>(ALL);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<TeamDayRow | null>(null);

  const params = {
    date,
    search: search.trim() || undefined,
    status: status === ALL ? undefined : status,
    source: source === ALL ? undefined : source,
    page,
    pageSize: PAGE_SIZE
  };
  const team = useQuery({ queryKey: ["attendance", "team", params], queryFn: () => attendanceTeamApi.teamDay(params) });
  const pages = Math.max(1, Math.ceil((team.data?.total ?? 0) / PAGE_SIZE));

  const resetPage = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPage(1);
  };

  return (
    <div className="grid min-w-0 gap-4">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <DatePicker value={date} onChange={resetPage(setDate)} className="w-full sm:w-44" />
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input value={search} onChange={(e) => resetPage(setSearch)(e.target.value)} placeholder="Search people" aria-label="Search people" className="pl-8" />
        </div>
        <Select value={source} onValueChange={(v) => resetPage(setSource)(v as PunchSourceKind | typeof ALL)}>
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
      </div>

      <div className="flex min-w-0 flex-wrap gap-2" role="group" aria-label="Filter by status">
        {SUMMARY_CHIPS.map((chip) => {
          const active = status === chip.status;
          return (
            <button
              key={chip.status}
              type="button"
              aria-pressed={active}
              onClick={() => resetPage(setStatus)(active ? ALL : chip.status)}
              className={cn(
                "focus-ring inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                active ? "border-primary bg-primary/10 text-primary" : "border-border bg-card text-muted-foreground hover:text-foreground"
              )}
            >
              {chip.label}
              <span className="tabular-nums text-foreground">{team.data?.summary[chip.status] ?? "–"}</span>
            </button>
          );
        })}
      </div>

      <TeamBody
        loading={team.isLoading}
        error={team.isError}
        rows={team.data?.rows ?? []}
        page={page}
        pages={pages}
        setPage={setPage}
        onOpen={setSelected}
      />

      <TimelineSheet row={selected} date={date} onClose={() => setSelected(null)} />
    </div>
  );
}

function TeamBody({
  loading,
  error,
  rows,
  page,
  pages,
  setPage,
  onOpen
}: Readonly<{
  loading: boolean;
  error: boolean;
  rows: TeamDayRow[];
  page: number;
  pages: number;
  setPage: (update: (p: number) => number) => void;
  onOpen: (row: TeamDayRow) => void;
}>) {
  if (loading) return <Skeleton className="h-64 w-full" />;
  if (error) {
    return <EmptyState icon={AlertTriangle} title="Team attendance isn't available" description="The module may be off, or this view is not open to your role." />;
  }
  if (rows.length === 0) return <EmptyState icon={Users2} title="Nobody to show" description="No one in your team matches these filters for this day." />;
  return (
    <>
      <TeamTable rows={rows} onOpen={onOpen} />
      <TeamCards rows={rows} onOpen={onOpen} />
      {pages > 1 && (
        <div className="flex items-center justify-end gap-2 text-sm">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
          <span className="tabular-nums text-muted-foreground">{page} / {pages}</span>
          <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
        </div>
      )}
    </>
  );
}

function PersonCell({ row }: Readonly<{ row: TeamDayRow }>) {
  const src = fileUrl(row.user.avatarUrl);
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <Avatar className="h-8 w-8 shrink-0">
        {src ? <AvatarImage src={src} alt="" /> : null}
        <AvatarFallback>{initialsFor(row.user.name)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{row.user.name}</p>
        <p className="truncate text-xs text-muted-foreground">{row.user.title.replaceAll("_", " ").toLowerCase()}</p>
      </div>
    </div>
  );
}

function punchText(row: TeamDayRow): string {
  if (!row.punch) return row.holidayName ?? "—";
  return `${timeOf(row.punch.punchInAt)} · ${row.punch.sourceLabel}`;
}

function FaceBadge({ face }: Readonly<{ face: "PASSED" | "FLAGGED" | "NONE" | undefined }>) {
  if (face === "PASSED") return <Badge variant="success"><ShieldCheck className="mr-1 h-3 w-3" aria-hidden="true" />Verified</Badge>;
  if (face === "FLAGGED") return <Badge variant="warning">Flagged</Badge>;
  return <span className="text-xs text-muted-foreground">—</span>;
}

function timesheetText(row: TeamDayRow): string {
  if (row.timesheet.state === "NONE") return "None";
  return `${row.timesheet.hours}h · ${row.timesheet.state === "SUBMITTED" ? "Submitted" : "Draft"}`;
}

function TeamTable({ rows, onOpen }: Readonly<{ rows: TeamDayRow[]; onOpen: (row: TeamDayRow) => void }>) {
  return (
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
              <TableCell><StatusBadge status={row.status} /></TableCell>
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
  );
}

function RowNotes({ row }: Readonly<{ row: TeamDayRow }>) {
  return (
    <div className="flex flex-wrap gap-1">
      {row.missedReason && <Badge variant="info">Reason: {row.missedReason.code.replaceAll("_", " ").toLowerCase()}</Badge>}
      {row.reminderSent && <Badge variant="muted"><Mail className="mr-1 h-3 w-3" aria-hidden="true" />Reminded</Badge>}
    </div>
  );
}

function TeamCards({ rows, onOpen }: Readonly<{ rows: TeamDayRow[]; onOpen: (row: TeamDayRow) => void }>) {
  return (
    <ul className="grid min-w-0 gap-2 md:hidden">
      {rows.map((row) => (
        <li key={row.user.id} className="min-w-0">
          <button
            type="button"
            onClick={() => onOpen(row)}
            className="focus-ring grid w-full min-w-0 gap-2 rounded-lg border border-border bg-card p-3 text-left"
          >
            <div className="flex min-w-0 items-center justify-between gap-2">
              <PersonCell row={row} />
              <StatusBadge status={row.status} />
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>{punchText(row)}</span>
              {row.punch && <span>{row.punch.location}</span>}
              <span>Timesheet: {timesheetText(row)}</span>
              <FaceBadge face={row.punch?.face} />
            </div>
            <RowNotes row={row} />
          </button>
        </li>
      ))}
    </ul>
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
  const from = shiftKey(date, -6);
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
          <SheetTitle>{row?.user.name ?? "Timeline"}</SheetTitle>
          <SheetDescription>Activity for the 7 days up to {date}, in your timezone.</SheetDescription>
        </SheetHeader>
        <TimelineBody loading={timeline.isLoading} error={timeline.isError} days={days} />
      </SheetContent>
    </Sheet>
  );
}

function TimelineBody({
  loading,
  error,
  days
}: Readonly<{ loading: boolean; error: boolean; days: Array<TimelineDay<TimelineEvent>> }>) {
  if (loading) return <Skeleton className="mt-4 h-48 w-full" />;
  if (error) return <EmptyState compact icon={AlertTriangle} title="Couldn't load this timeline" />;
  if (days.length === 0) return <EmptyState compact icon={Clock} title="No activity in this window" />;
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
                <li
                  key={`${event.at}-${i}`}
                  className="relative motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1"
                >
                  <span className="absolute -left-[1.85rem] grid h-6 w-6 place-items-center rounded-full border border-border bg-card">
                    <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                  </span>
                  <p className="text-sm font-medium">{event.label}</p>
                  <p className="text-xs text-muted-foreground">
                    <time dateTime={event.at} title={new Date(event.at).toLocaleString()}>
                      {timeOf(event.at)} · {relativeTime(event.at)}
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
