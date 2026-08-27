/**
 * WHAT: the top-level router — every page in the app is lazy-loaded here and wrapped in one of
 * two completely separate shells: `AppLayout` (tenant app, requires a tenant session) or
 * `PlatformAdminLayout` (the `/platform-admin` console, requires a platform-admin session).
 * WHY lazy-loaded: keeps the initial bundle small — a first-time visitor to `/login` doesn't
 * pay for the Kanban board or the Insights charts until they actually navigate there.
 * WHY two separate auth bootstraps: `useAuthStore`/`usePlatformAdminAuthStore` are deliberately
 * distinct Zustand stores with zero shared state — see their own file headers for why (a leaked
 * tenant token must never be usable against `/platform-admin`, and vice versa).
 * WHO renders this: `main.tsx`.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { lazy, Suspense, useEffect } from "react";
import { AppLoader } from "./components/ui/app-loader";
import { createBrowserRouter, Navigate, RouterProvider, useLocation, useSearchParams } from "react-router";
import { permissions, type Permission } from "@timesheet/shared";
import { AppLayout } from "./layouts/AppLayout";
import { PlatformAdminLayout } from "./layouts/PlatformAdminLayout";
import { authApi } from "./services/api";
import { platformAdminAuthApi } from "./services/platform-admin-api";
import { useAuthStore } from "./store/auth";
import { loginUrlFor, safeReturnTo } from "./utils/return-to";
import { hasSeenPlatformAdminSession, usePlatformAdminAuthStore } from "./store/platform-admin-auth";
import { Toaster } from "./components/ui/toaster";
import { TooltipProvider } from "./components/ui/tooltip";
import { BackendHealthGate } from "./components/BackendHealthGate";
import { ErrorBoundary } from "./components/ErrorBoundary";

const Landing = lazy(() => import("./pages/Landing").then((m) => ({ default: m.Landing })));
const PitchDeck = lazy(() => import("./pages/PitchDeck").then((m) => ({ default: m.PitchDeck })));
const Login = lazy(() => import("./pages/Login").then((m) => ({ default: m.Login })));
const ForgotPassword = lazy(() => import("./pages/ForgotPassword").then((m) => ({ default: m.ForgotPassword })));
const FindWorkspace = lazy(() => import("./pages/FindWorkspace").then((m) => ({ default: m.FindWorkspace })));
const Signup = lazy(() => import("./pages/Signup").then((m) => ({ default: m.Signup })));
const ResetPassword = lazy(() => import("./pages/ResetPassword").then((m) => ({ default: m.ResetPassword })));
const SharedAttestation = lazy(() => import("./pages/SharedAttestation").then((m) => ({ default: m.SharedAttestation })));
const MaintenancePage = lazy(() => import("./pages/Maintenance").then((m) => ({ default: m.MaintenancePage })));
const PlanLapsedPage = lazy(() => import("./pages/PlanLapsed").then((m) => ({ default: m.PlanLapsedPage })));
const Dashboard = lazy(() => import("./pages/Dashboard").then((m) => ({ default: m.Dashboard })));
const Timesheet = lazy(() => import("./pages/Timesheet").then((m) => ({ default: m.Timesheet })));
const Tickets = lazy(() => import("./pages/Tickets").then((m) => ({ default: m.Tickets })));
const Profile = lazy(() => import("./pages/Profile").then((m) => ({ default: m.Profile })));
const WhatsNewPage = lazy(() => import("./pages/WhatsNew").then((m) => ({ default: m.WhatsNewPage })));
const History = lazy(() => import("./pages/History").then((m) => ({ default: m.History })));
const TimelinePage = lazy(() => import("./pages/Timeline").then((m) => ({ default: m.TimelinePage })));
const MyWorkPage = lazy(() => import("./pages/MyWork").then((m) => ({ default: m.MyWorkPage })));
const PortfolioPage = lazy(() => import("./pages/Portfolio").then((m) => ({ default: m.PortfolioPage })));
const GoalsPage = lazy(() => import("./pages/Goals").then((m) => ({ default: m.GoalsPage })));
const ChangesPage = lazy(() => import("./pages/Changes").then((m) => ({ default: m.Changes })));
const ChangeDetailPage = lazy(() => import("./pages/ChangeDetail").then((m) => ({ default: m.ChangeDetailPage })));
const ChangeCalendarPage = lazy(() => import("./pages/ChangeCalendar").then((m) => ({ default: m.ChangeCalendarPage })));
const InboxPage = lazy(() => import("./pages/Inbox").then((m) => ({ default: m.InboxPage })));
const AgentsPage = lazy(() => import("./pages/Agents").then((m) => ({ default: m.AgentsPage })));
const StudioPage = lazy(() => import("./pages/Studio").then((m) => ({ default: m.StudioPage })));
const BlueprintsPage = lazy(() => import("./pages/Blueprints").then((m) => ({ default: m.BlueprintsPage })));
const RequirementsStudioPage = lazy(() => import("./pages/RequirementsStudio").then((m) => ({ default: m.RequirementsStudioPage })));
const RequirementsDocViewPage = lazy(() => import("./pages/RequirementsDocView").then((m) => ({ default: m.RequirementsDocViewPage })));
const WorkloadPage = lazy(() => import("./pages/Workload").then((m) => ({ default: m.WorkloadPage })));
const RequestsPage = lazy(() => import("./pages/Requests").then((m) => ({ default: m.RequestsPage })));
const ProposalsPage = lazy(() => import("./pages/Proposals").then((m) => ({ default: m.ProposalsPage })));
const AskAi = lazy(() => import("./pages/AskAi").then((m) => ({ default: m.AskAi })));
const AiOverviewPage = lazy(() => import("./pages/AiOverview").then((m) => ({ default: m.AiOverviewPage })));
const DashboardsPage = lazy(() => import("./pages/Dashboards").then((m) => ({ default: m.DashboardsPage })));
const PublicRequestFormPage = lazy(() => import("./pages/PublicRequestForm").then((m) => ({ default: m.PublicRequestFormPage })));
const GuestApprovalPage = lazy(() => import("./pages/GuestApproval").then((m) => ({ default: m.GuestApprovalPage })));
const AuditLog = lazy(() => import("./pages/AuditLog").then((m) => ({ default: m.AuditLog })));
const AIActivityLog = lazy(() => import("./pages/AIActivityLog").then((m) => ({ default: m.AIActivityLog })));
const Insights = lazy(() => import("./pages/Insights").then((m) => ({ default: m.Insights })));
const SecurityInsightsPage = lazy(() => import("./pages/SecurityInsights").then((m) => ({ default: m.SecurityInsightsPage })));
const Team = lazy(() => import("./pages/Team").then((m) => ({ default: m.Team })));
const WorkspaceSettingsPage = lazy(() =>
  import("./pages/WorkspaceSettings").then((m) => ({ default: m.WorkspaceSettingsPage }))
);
const PracticeUpdatePage = lazy(() =>
  import("./pages/PracticeUpdate").then((m) => ({ default: m.PracticeUpdatePage }))
);
const EmailTemplatesPage = lazy(() =>
  import("./pages/EmailTemplates").then((m) => ({ default: m.EmailTemplatesPage }))
);
const adminPages = () => import("./pages/AdminPages");
const ApprovalsPage = lazy(() => adminPages().then((m) => ({ default: m.ApprovalsPage })));
const ProjectsPage = lazy(() => adminPages().then((m) => ({ default: m.ProjectsPage })));
const ReportsPage = lazy(() => adminPages().then((m) => ({ default: m.ReportsPage })));
const UsersPage = lazy(() => adminPages().then((m) => ({ default: m.UsersPage })));

const PlatformAdminLogin = lazy(() => import("./pages/platform-admin/PlatformAdminLogin").then((m) => ({ default: m.PlatformAdminLogin })));
const PlatformAdminOrganizations = lazy(() => import("./pages/platform-admin/Organizations").then((m) => ({ default: m.PlatformAdminOrganizations })));
const PlatformAdminPlanTiers = lazy(() => import("./pages/platform-admin/PlanTiers").then((m) => ({ default: m.PlatformAdminPlanTiers })));
const PlatformAdminAnalytics = lazy(() => import("./pages/platform-admin/PlatformAnalytics").then((m) => ({ default: m.PlatformAdminAnalytics })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      retry: 1
    }
  }
});

const router = createBrowserRouter([
  { path: "/", element: <PageShell><Landing /></PageShell> },
  // The pitch — a public, standalone explanation of the product for prospects and reviewers.
  // Separate from `/` on purpose: the landing page sells the features, this one sells the thesis.
  { path: "/pitch", element: <PageShell><PitchDeck /></PageShell> },
  { path: "/login", element: <PageShell><RedirectIfAuthenticated><Login /></RedirectIfAuthenticated></PageShell> },
  { path: "/forgot-password", element: <PageShell><RedirectIfAuthenticated><ForgotPassword /></RedirectIfAuthenticated></PageShell> },
  // Public and unauthenticated, like the two beside it — a person who cannot remember their
  // workspace address has, by definition, no session anywhere to prove anything with.
  { path: "/find-workspace", element: <PageShell><RedirectIfAuthenticated><FindWorkspace /></RedirectIfAuthenticated></PageShell> },
  { path: "/signup", element: <PageShell><RedirectIfAuthenticated><Signup /></RedirectIfAuthenticated></PageShell> },
  { path: "/reset-password", element: <PageShell><ResetPassword /></PageShell> },
  // Public, no-session attestation viewer. Deliberately OUTSIDE /app: the reader is a client
  // with no account, so it must never hit AppLayout (which assumes an authenticated user) or
  // redirect to /login. See pages/SharedAttestation.tsx.
  { path: "/shared/attestation/:token", element: <PageShell><SharedAttestation /></PageShell> },
  // Two more unauthenticated surfaces, same rule as the attestation viewer above: the people who
  // open these have no account, so they must never touch AppLayout or redirect to /login.
  { path: "/request/:token", element: <PageShell><PublicRequestFormPage /></PageShell> },
  { path: "/shared/approval/:token", element: <PageShell><GuestApprovalPage /></PageShell> },
  // Public lockout screen for maintenance mode. Same outside-/app rule as the attestation
  // viewer: the people sent here have revoked sessions, so it must never assume auth.
  { path: "/maintenance", element: <PageShell><MaintenancePage /></PageShell> },
  // Outside the app shell, like /maintenance beside it: the shell's own queries are exactly
  // what the server is refusing, so rendering this inside it would fill the page with the
  // errors it exists to explain.
  { path: "/plan-lapsed", element: <PageShell><PlanLapsedPage /></PageShell> },
  {
    path: "/app",
    element: <AppLayout />,
    children: [
      { index: true, element: <PageShell><Dashboard /></PageShell> },
      { path: "timesheet", element: <PageShell><Timesheet /></PageShell> },
      { path: "tickets", element: <RequirePermission permission={permissions.TICKETS_VIEW}><PageShell><Tickets /></PageShell></RequirePermission> },
      { path: "history", element: <PageShell><History /></PageShell> },
      // Planning layer (V6). The timeline and portfolio need TICKETS_VIEW to read (editing needs
      // plan:write, checked inside the pages) and each renders its own "planning is off" state
      // rather than 404ing — a nav item that vanishes and a page that explains why are different
      // experiences, and the second is the one that sells the feature.
      { path: "timeline", element: <RequirePermission permission={permissions.TICKETS_VIEW}><PageShell><TimelinePage /></PageShell></RequirePermission> },
      { path: "portfolio", element: <RequirePermission permission={permissions.REPORTS_VIEW}><PageShell><PortfolioPage /></PageShell></RequirePermission> },
      // Goals (V8 phase 1) carry NO permission gate: reading the objectives the workspace is
      // measured against needs no right — a goal nobody can see aligns nobody. goals:manage is
      // checked inside the page for the write affordances, and the page renders its own
      // "goals are off" state for the same reason the planning pages do.
      { path: "goals", element: <PageShell><GoalsPage /></PageShell> },
      // No RequirePermission: READING changes needs no key — a change about to take a service down
      // is not a secret from the people who depend on it. The page renders its own "off" or
      // "not in your plan" state, the same way the planning pages do, so somebody who lands here
      // from a link is told which half is missing rather than bounced.
      { path: "changes", element: <PageShell><ChangesPage /></PageShell> },
      { path: "changes/calendar", element: <PageShell><ChangeCalendarPage /></PageShell> },
      { path: "changes/:id", element: <PageShell><ChangeDetailPage /></PageShell> },
      // The inbox is personal: no permission, no entitlement, no feature flag. Everyone has
      // notifications, so everyone has an inbox — the same reasoning as "my-work" above.
      { path: "inbox", element: <PageShell><InboxPage /></PageShell> },
      // Reading the roster needs tickets:view — anybody working alongside a teammate may ask what
      // it is and what it has been doing. Creating one is SUPER_ADMIN, checked in the page and
      // enforced by the API; the page renders its own "not in this plan" state on a 403.
      { path: "agents", element: <RequirePermission permission={permissions.TICKETS_VIEW}><PageShell><AgentsPage /></PageShell></RequirePermission> },
      // Same gate as the roster: reading is tickets:view, because what automation touches your work is
      // your business; every write is SUPER_ADMIN, checked by the API and reflected in the page.
      { path: "studio", element: <RequirePermission permission={permissions.TICKETS_VIEW}><PageShell><StudioPage /></PageShell></RequirePermission> },
      // The map of the other four AI surfaces. SUPER_ADMIN, unlike the surfaces it links to: it is the
      // orientation screen for the person who configures all of them, and it reports spend.
      { path: "ai", element: <RequireRole role="SUPER_ADMIN"><PageShell><AiOverviewPage /></PageShell></RequireRole> },
      // Readable with tickets:view (the API lists blueprints at that level); using one needs
      // plan:write, checked inside the page so a viewer sees the shapes without dead buttons.
      { path: "blueprints", element: <RequirePermission permission={permissions.TICKETS_VIEW}><PageShell><BlueprintsPage /></PageShell></RequirePermission> },
      // Same read/write split as Blueprints above: listing and reading a document needs
      // tickets:view, every write (interview turns, generate, materialize) needs plan:write,
      // checked inside the page.
      { path: "requirements", element: <RequirePermission permission={permissions.TICKETS_VIEW}><PageShell><RequirementsStudioPage /></PageShell></RequirePermission> },
      { path: "requirements/:id", element: <RequirePermission permission={permissions.TICKETS_VIEW}><PageShell><RequirementsDocViewPage /></PageShell></RequirePermission> },
      // Shows every person's capacity and hours, so it needs the resource right rather than a
      // reporting one — this is people data, not project data.
      { path: "workload", element: <RequirePermission permission={permissions.RESOURCES_MANAGE}><PageShell><WorkloadPage /></PageShell></RequirePermission> },
      // Readable by anyone who can see tickets — the inbox is triage, not configuration. Building
      // and publishing forms needs forms:configure, checked inside the page.
      { path: "requests", element: <RequirePermission permission={permissions.TICKETS_VIEW}><PageShell><RequestsPage /></PageShell></RequirePermission> },
      // Readable by anyone who can see tickets; applying a suggestion needs plan:write, which
      // the page checks itself — seeing what the assistant proposed is not a privilege.
      { path: "ask-ai", element: <RequirePermission permission={permissions.TICKETS_VIEW}><PageShell><AskAi /></PageShell></RequirePermission> },
      { path: "proposals", element: <RequirePermission permission={permissions.TICKETS_VIEW}><PageShell><ProposalsPage /></PageShell></RequirePermission> },
      // No permission gate: a dashboard shows only what its viewer can already see, so building
      // one is not a privilege. Publishing to the workspace needs dashboards:share.
      { path: "dashboards", element: <PageShell><DashboardsPage /></PageShell> },
      // No permission gate: this is the caller's own assigned work, and gating a personal queue
      // would leave most users with an empty nav entry.
      { path: "my-work", element: <PageShell><MyWorkPage /></PageShell> },
      { path: "profile", element: <PageShell><Profile /></PageShell> },
      // Version details + release notes. No permission gate: notes describe features people use,
      // and the page itself hides the admin-only update card from non-admins.
      { path: "whats-new", element: <PageShell><WhatsNewPage /></PageShell> },
      // Open to everyone: the page shows the org chart to all, and reveals the approval queue, SLA
      // metrics and direct-reports roll-up only to an approver (see pages/Team.tsx). One page
      // rather than a second, employee-facing copy of the same chart.
      { path: "team", element: <PageShell><Team /></PageShell> },
      { path: "approvals", element: <RequirePermission permission={permissions.TIMESHEETS_APPROVE}><PageShell><ApprovalsPage /></PageShell></RequirePermission> },
      { path: "users", element: <RequirePermission permission={permissions.USERS_MANAGE}><PageShell><UsersPage /></PageShell></RequirePermission> },
      { path: "projects", element: <RequirePermission permission={permissions.PROJECTS_MANAGE}><PageShell><ProjectsPage /></PageShell></RequirePermission> },
      { path: "reports", element: <RequirePermission permission={permissions.REPORTS_VIEW}><PageShell><ReportsPage /></PageShell></RequirePermission> },
      // Insights and security insights are open to every authenticated member (team leads and
      // employees included), and the matching server endpoints were broadened to match.
      { path: "insights", element: <PageShell><Insights /></PageShell> },
      { path: "security-insights", element: <PageShell><SecurityInsightsPage /></PageShell> },
      { path: "audit", element: <RequirePermission permission={permissions.AUDIT_VIEW}><PageShell><AuditLog /></PageShell></RequirePermission> },
      { path: "ai-activity", element: <RequirePermission permission={permissions.TICKETS_ASSIGN}><PageShell><AIActivityLog /></PageShell></RequirePermission> },
      { path: "settings", element: <RequireRole role="SUPER_ADMIN"><PageShell><WorkspaceSettingsPage /></PageShell></RequireRole> },
      { path: "email-templates", element: <RequireRole role="SUPER_ADMIN"><PageShell><EmailTemplatesPage /></PageShell></RequireRole> },
      { path: "practice-update", element: <RequireRole role="SUPER_ADMIN"><PageShell><PracticeUpdatePage /></PageShell></RequireRole> }
    ]
  },
  { path: "/platform-admin/login", element: <PageShell><RedirectIfPlatformAdmin><PlatformAdminLogin /></RedirectIfPlatformAdmin></PageShell> },
  {
    path: "/platform-admin",
    element: <RequirePlatformAdmin><PlatformAdminLayout /></RequirePlatformAdmin>,
    children: [
      { index: true, element: <PageShell><PlatformAdminOrganizations /></PageShell> },
      { path: "plan-tiers", element: <PageShell><PlatformAdminPlanTiers /></PageShell> },
      { path: "analytics", element: <PageShell><PlatformAdminAnalytics /></PageShell> }
    ]
  }
]);

export function App() {
  return (
    // ErrorBoundary is outermost so it catches a render throw from ANY of the providers or routes
    // below it — inside the QueryClientProvider it would miss failures in the provider tree itself.
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={200}>
          <AuthBootstrap />
          <PlatformAdminAuthBootstrap />
          <ThemeBootstrap />
          {/* Mounted at the app root, not inside AppLayout, so the outage overlay also covers
              /login, the public landing page, and the platform-admin console — all of which are
              equally useless with the API down. */}
          <BackendHealthGate />
          <RouterProvider router={router} />
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

function AuthBootstrap() {
  const setUser = useAuthStore((s) => s.setUser);
  useEffect(() => {
    // There's no token in localStorage to check anymore — the refresh token is an httpOnly
    // cookie invisible to this code, so the only way to know if a session exists is to ask
    // the API. A failure here (no cookie, expired, revoked) just means "not logged in", not
    // an error to surface — it's the expected path for every first visit.
    authApi
      .refresh()
      .then(() => authApi.me())
      .then(setUser)
      .catch(() => setUser(undefined));
  }, [setUser]);
  return null;
}

/** Mirrors AuthBootstrap exactly, but against the platform-admin refresh cookie/endpoint — see
 *  services/platform-admin-api.ts's header comment for why this is a wholly separate path. */
function PlatformAdminAuthBootstrap() {
  const setAdmin = usePlatformAdminAuthStore((s) => s.setAdmin);
  useEffect(() => {
    // Only try to restore a platform-admin session when there is plausibly one to restore: this
    // browser has held one before (the marker), or the visitor deep-linked into the console. A
    // tenant user on /app has neither, so we skip the request entirely rather than firing a
    // guaranteed-401 `POST /platform-admin/auth/refresh` into their console on every load.
    const onConsole = window.location.pathname.startsWith("/platform-admin");
    if (!onConsole && !hasSeenPlatformAdminSession()) {
      setAdmin(undefined);
      return;
    }
    platformAdminAuthApi
      .refresh()
      .then(() => platformAdminAuthApi.me())
      .then(setAdmin)
      .catch(() => setAdmin(undefined));
  }, [setAdmin]);
  return null;
}

function ThemeBootstrap() {
  useEffect(() => {
    const stored = localStorage.getItem("timesheet:theme");
    const prefersDark = typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    const isDark = stored ? stored === "dark" : Boolean(prefersDark);
    document.documentElement.classList.toggle("dark", isDark);
  }, []);
  return null;
}

/**
 * The inverse of `RequirePermission` below: keeps a signed-in person OFF the sign-in pages.
 *
 * The bug this fixes was reported plainly — "even though the session is logged in, the login page
 * still comes and accepts the login again". It did, because nothing was checking. Every guard in
 * this file pointed one way: into protected routes. The public auth pages had none at all, so a
 * person with a perfectly good session was shown a password form and had to use it, and the only
 * way out of the loop was to sign out first.
 *
 * WAITS FOR `hydrated`, for the same reason every guard below does. The session is restored by an
 * async `/auth/refresh` on mount, so acting before it settles would show the login form for a beat
 * to somebody who is signed in — which is the bug, just briefer.
 *
 * `?switch=1` DELIBERATELY BYPASSES IT. Somebody signing in as a different person on a shared
 * machine has a legitimate reason to see the form while holding a session, and a redirect they
 * cannot escape is its own trap. The normal path to it is "Sign out", which clears the store before
 * navigating here; this is the explicit door for the case where they have not.
 */
function RedirectIfAuthenticated({ children }: { children: ReactNode }) {
  const user = useAuthStore((s) => s.user);
  const hydrated = useAuthStore((s) => s.hydrated);
  const [params] = useSearchParams();

  if (!hydrated) return null;
  if (user && params.get("switch") !== "1") {
    return <Navigate to={safeReturnTo(params.get("next"))} replace />;
  }
  return children;
}

function RequirePermission({ permission, children }: { permission: Permission; children: ReactNode }) {
  const user = useAuthStore((s) => s.user);
  const hydrated = useAuthStore((s) => s.hydrated);
  const location = useLocation();
  // Wait for the AuthBootstrap fetch to settle so we don't redirect away
  // from a route the user actually has access to during the first paint.
  if (!hydrated) return null;
  // Carries the destination, so signing in returns them to the link they followed instead of
  // dumping them on the dashboard — see utils/return-to.ts.
  if (!user) return <Navigate to={loginUrlFor(location)} replace />;
  if (!user.permissions.includes(permission)) return <Navigate to="/app" replace />;
  return children;
}

function RequireRole({ role, children }: { role: string; children: ReactNode }) {
  const user = useAuthStore((s) => s.user);
  const hydrated = useAuthStore((s) => s.hydrated);
  const location = useLocation();
  if (!hydrated) return null;
  if (!user) return <Navigate to={loginUrlFor(location)} replace />;
  if (user.role !== role) return <Navigate to="/app" replace />;
  return children;
}

/**
 * `RedirectIfAuthenticated`'s counterpart for the platform console, which had the identical hole:
 * a signed-in platform admin visiting `/platform-admin/login` was shown the form again.
 *
 * A SEPARATE COMPONENT RATHER THAN A PARAMETER, because the two auth planes share no state by
 * design (see the store headers) and the one thing that must never happen is a guard reading the
 * wrong store. Making it generic over "which store" is exactly how that mistake gets made.
 */
function RedirectIfPlatformAdmin({ children }: { children: ReactNode }) {
  const admin = usePlatformAdminAuthStore((s) => s.admin);
  const hydrated = usePlatformAdminAuthStore((s) => s.hydrated);
  const [params] = useSearchParams();

  if (!hydrated) return null;
  if (admin && params.get("switch") !== "1") return <Navigate to="/platform-admin" replace />;
  return children;
}

function RequirePlatformAdmin({ children }: { children: ReactNode }) {
  const admin = usePlatformAdminAuthStore((s) => s.admin);
  const hydrated = usePlatformAdminAuthStore((s) => s.hydrated);
  if (!hydrated) return null;
  if (!admin) return <Navigate to="/platform-admin/login" replace />;
  return children;
}

function PageShell({ children }: { children: ReactNode }) {
  return (
    <Suspense
      // The generic skeleton this replaced was a stack of grey bars matching no page in the app,
      // so every lazy route flashed one layout on its way to a different one. A loader that does
      // not pretend to be the page is more honest than a placeholder shaped like the wrong one.
      // In-card <Skeleton>s are unaffected and still correct — see components/ui/app-loader.tsx.
      fallback={
        <div className="mx-auto w-full max-w-5xl p-4 sm:p-6">
          <AppLoader label="Loading…" />
        </div>
      }
    >
      {children}
    </Suspense>
  );
}
