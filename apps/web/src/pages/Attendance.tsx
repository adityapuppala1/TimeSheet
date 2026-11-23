/**
 * Attendance (V17 UI v2): the shell for My attendance, Team, Organisation and Leave.
 *
 * Routes: /app/attendance (mine), /team, /org, and /leave (+ /requests, /holidays) when leave is on.
 * The screens themselves live in components/attendance/*; this file only decides which one to show.
 *
 * VISIBILITY: Team shows only for the roles the server's teamScopeFor accepts, Organisation only for
 * admins; the server still decides per request (a manager sees direct reports, an admin everyone), so
 * a tab is a convenience, not the control. Locations arrive as coarse labels, never coordinates.
 *
 * MOTION: opacity/transform only, behind `motion-safe:`.
 */
import { CalendarCheck, Fingerprint, Plane, Users2 } from "lucide-react";
import { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router";
import { PageHeader } from "../components/PageHeader";
import { MyAnalyticsSection, TeamInsightsView } from "../components/attendance/AttendanceAnalytics";
import { ApprovalsInbox } from "../components/attendance/ApprovalsInbox";
import { ApplyLeave, HolidayCalendarView, LeaveNav, MyLeaveRequests } from "../components/attendance/LeaveScreens";
import { MyAttendanceView } from "../components/attendance/MyAttendanceView";
import { OrgAnalyticsView } from "../components/attendance/OrgView";
import { Segmented } from "../components/attendance/attendance-ui";
import { TeamLeaveCalendar, WhosInBoard } from "../components/attendance/TeamViews";
import { useLeaveEnabled } from "../components/attendance/use-leave";
import { useMyToday } from "../components/PunchIn";
import { EmptyState } from "../components/ui/empty-state";
import { ORG_VIEW_ROLES } from "../lib/attendance-analytics";
import { TEAM_VIEW_ROLES } from "../lib/attendance-team";
import { useMediaQuery } from "../lib/use-media-query";
import { cn } from "../lib/utils";
import { useAuthStore } from "../store/auth";

export function AttendancePage() {
  const role = useAuthStore((s) => s.user?.role ?? "");
  const { pathname } = useLocation();
  const leaveOn = useLeaveEnabled();
  const canSeeTeam = TEAM_VIEW_ROLES.has(role);
  const canSeeOrg = ORG_VIEW_ROLES.has(role);
  const onTeam = pathname.startsWith("/app/attendance/team");
  const onOrg = pathname.startsWith("/app/attendance/org");
  const onLeave = pathname.startsWith("/app/attendance/leave");
  const tabs = [
    { to: "/app/attendance", label: "My attendance", end: true },
    ...(canSeeTeam ? [{ to: "/app/attendance/team", label: "Team", end: false }] : []),
    ...(canSeeOrg ? [{ to: "/app/attendance/org", label: "Organisation", end: false }] : []),
    ...(leaveOn ? [{ to: "/app/attendance/leave", label: "Leave", end: false }] : [])
  ];

  return (
    <div className="grid min-w-0 gap-5">
      <PageHeader title={onLeave ? "Leave" : "Attendance"} description={onLeave ? "Request time off, track your requests and see your holidays." : "Punch-ins, day status and timesheet activity."} icon={onLeave ? Plane : Fingerprint} />
      {tabs.length > 1 && (
        <nav aria-label="Attendance views" className="flex gap-1 overflow-x-auto border-b border-border">
          {tabs.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={tab.end}
              className={({ isActive }) =>
                cn(
                  "focus-ring -mb-px inline-flex min-h-[44px] shrink-0 items-center border-b-2 px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground",
                  isActive ? "border-primary text-foreground" : "border-transparent"
                )
              }
            >
              {tab.label}
            </NavLink>
          ))}
        </nav>
      )}

      {onTeam && canSeeTeam && <TeamPanel leaveOn={leaveOn} />}
      {onTeam && !canSeeTeam && <EmptyState icon={Users2} title="Team attendance is for managers" description="Ask an admin if you need to see your team's attendance." />}
      {onOrg && canSeeOrg && <OrgAnalyticsView />}
      {onOrg && !canSeeOrg && <EmptyState icon={Users2} title="Organisation analytics are for admins" description="Ask an admin if you need workspace-wide attendance figures." />}
      {onLeave && <LeavePanel leaveOn={leaveOn} />}
      {!onTeam && !onOrg && !onLeave && (
        <div className="grid min-w-0 gap-6">
          <MyAttendanceView />
          <MyAnalyticsSection />
        </div>
      )}
    </div>
  );
}

function LeavePanel({ leaveOn }: Readonly<{ leaveOn: boolean }>) {
  const { pathname } = useLocation();
  if (!leaveOn) {
    return <EmptyState icon={CalendarCheck} title="Leave is not switched on" description="Your workspace has not turned leave on. Ask an admin if you expected to see it." />;
  }
  return (
    <div className="grid min-w-0 gap-4">
      <LeaveNav />
      {pathname.startsWith("/app/attendance/leave/requests") && <MyLeaveRequests />}
      {pathname.startsWith("/app/attendance/leave/holidays") && <HolidayCalendarView />}
      {!pathname.startsWith("/app/attendance/leave/requests") && !pathname.startsWith("/app/attendance/leave/holidays") && <ApplyLeave />}
    </div>
  );
}

type TeamTab = "board" | "approvals" | "calendar" | "insights";

/** Wide screens: the board with Approvals as a 320px rail. Phones: a segmented control between panels. */
function TeamPanel({ leaveOn }: Readonly<{ leaveOn: boolean }>) {
  const wide = useMediaQuery("(min-width: 1024px)");
  const [tab, setTab] = useState<TeamTab>("board");
  const today = useMyToday();
  const lateness = today.data?.latenessEnabled ? { enabled: true, expectedStartMinute: today.data.expectedStartMinute ?? 570 } : null;

  // The Approvals panel only exists as a tab on a phone; widening the window puts it back in the rail.
  useEffect(() => {
    if (wide && tab === "approvals") setTab("board");
  }, [wide, tab]);

  const options = [
    { value: "board" as const, label: "Who's in" },
    ...(leaveOn && !wide ? [{ value: "approvals" as const, label: "Approvals" }] : []),
    ...(leaveOn ? [{ value: "calendar" as const, label: wide ? "Leave calendar" : "Calendar" }] : []),
    { value: "insights" as const, label: "Insights" }
  ];

  return (
    <div className="grid min-w-0 gap-4">
      <Segmented label="Team view" value={tab} onChange={setTab} options={options} className="w-full sm:w-fit" />
      {tab === "board" && (
        <div className={cn("grid min-w-0 gap-4", leaveOn && "lg:grid-cols-[minmax(0,1fr)_320px]")}>
          <WhosInBoard leaveOn={leaveOn} lateness={lateness} />
          {leaveOn && wide && <ApprovalsInbox />}
        </div>
      )}
      {tab === "approvals" && leaveOn && <ApprovalsInbox />}
      {tab === "calendar" && leaveOn && <TeamLeaveCalendar />}
      {tab === "insights" && <TeamInsightsView />}
    </div>
  );
}
