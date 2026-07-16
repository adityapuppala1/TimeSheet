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
import { createBrowserRouter, Navigate, RouterProvider } from "react-router-dom";
import { permissions, type Permission } from "@timesheet/shared";
import { AppLayout } from "./layouts/AppLayout";
import { PlatformAdminLayout } from "./layouts/PlatformAdminLayout";
import { authApi } from "./services/api";
import { platformAdminAuthApi } from "./services/platform-admin-api";
import { useAuthStore } from "./store/auth";
import { usePlatformAdminAuthStore } from "./store/platform-admin-auth";
import { Toaster } from "./components/ui/toaster";
import { TooltipProvider } from "./components/ui/tooltip";
import { Skeleton } from "./components/ui/skeleton";

const Landing = lazy(() => import("./pages/Landing").then((m) => ({ default: m.Landing })));
const Login = lazy(() => import("./pages/Login").then((m) => ({ default: m.Login })));
const ForgotPassword = lazy(() => import("./pages/ForgotPassword").then((m) => ({ default: m.ForgotPassword })));
const ResetPassword = lazy(() => import("./pages/ResetPassword").then((m) => ({ default: m.ResetPassword })));
const Dashboard = lazy(() => import("./pages/Dashboard").then((m) => ({ default: m.Dashboard })));
const Timesheet = lazy(() => import("./pages/Timesheet").then((m) => ({ default: m.Timesheet })));
const Tickets = lazy(() => import("./pages/Tickets").then((m) => ({ default: m.Tickets })));
const Profile = lazy(() => import("./pages/Profile").then((m) => ({ default: m.Profile })));
const History = lazy(() => import("./pages/History").then((m) => ({ default: m.History })));
const AuditLog = lazy(() => import("./pages/AuditLog").then((m) => ({ default: m.AuditLog })));
const AIActivityLog = lazy(() => import("./pages/AIActivityLog").then((m) => ({ default: m.AIActivityLog })));
const Insights = lazy(() => import("./pages/Insights").then((m) => ({ default: m.Insights })));
const SecurityInsightsPage = lazy(() => import("./pages/SecurityInsights").then((m) => ({ default: m.SecurityInsightsPage })));
const Team = lazy(() => import("./pages/Team").then((m) => ({ default: m.Team })));
const WorkspaceSettingsPage = lazy(() =>
  import("./pages/WorkspaceSettings").then((m) => ({ default: m.WorkspaceSettingsPage }))
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
  { path: "/login", element: <PageShell><Login /></PageShell> },
  { path: "/forgot-password", element: <PageShell><ForgotPassword /></PageShell> },
  { path: "/reset-password", element: <PageShell><ResetPassword /></PageShell> },
  {
    path: "/app",
    element: <AppLayout />,
    children: [
      { index: true, element: <PageShell><Dashboard /></PageShell> },
      { path: "timesheet", element: <PageShell><Timesheet /></PageShell> },
      { path: "tickets", element: <RequirePermission permission={permissions.TICKETS_VIEW}><PageShell><Tickets /></PageShell></RequirePermission> },
      { path: "history", element: <PageShell><History /></PageShell> },
      { path: "profile", element: <PageShell><Profile /></PageShell> },
      { path: "team", element: <RequirePermission permission={permissions.TIMESHEETS_APPROVE}><PageShell><Team /></PageShell></RequirePermission> },
      { path: "approvals", element: <RequirePermission permission={permissions.TIMESHEETS_APPROVE}><PageShell><ApprovalsPage /></PageShell></RequirePermission> },
      { path: "users", element: <RequirePermission permission={permissions.USERS_MANAGE}><PageShell><UsersPage /></PageShell></RequirePermission> },
      { path: "projects", element: <RequirePermission permission={permissions.PROJECTS_MANAGE}><PageShell><ProjectsPage /></PageShell></RequirePermission> },
      { path: "reports", element: <RequirePermission permission={permissions.REPORTS_VIEW}><PageShell><ReportsPage /></PageShell></RequirePermission> },
      { path: "insights", element: <RequirePermission permission={permissions.REPORTS_VIEW}><PageShell><Insights /></PageShell></RequirePermission> },
      { path: "security-insights", element: <RequirePermission permission={permissions.REPORTS_VIEW}><PageShell><SecurityInsightsPage /></PageShell></RequirePermission> },
      { path: "audit", element: <RequirePermission permission={permissions.AUDIT_VIEW}><PageShell><AuditLog /></PageShell></RequirePermission> },
      { path: "ai-activity", element: <RequirePermission permission={permissions.TICKETS_ASSIGN}><PageShell><AIActivityLog /></PageShell></RequirePermission> },
      { path: "settings", element: <PageShell><WorkspaceSettingsPage /></PageShell> },
      { path: "email-templates", element: <RequireRole role="SUPER_ADMIN"><PageShell><EmailTemplatesPage /></PageShell></RequireRole> }
    ]
  },
  { path: "/platform-admin/login", element: <PageShell><PlatformAdminLogin /></PageShell> },
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
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={200}>
        <AuthBootstrap />
        <PlatformAdminAuthBootstrap />
        <ThemeBootstrap />
        <RouterProvider router={router} />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
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

function RequirePermission({ permission, children }: { permission: Permission; children: ReactNode }) {
  const user = useAuthStore((s) => s.user);
  const hydrated = useAuthStore((s) => s.hydrated);
  // Wait for the AuthBootstrap fetch to settle so we don't redirect away
  // from a route the user actually has access to during the first paint.
  if (!hydrated) return null;
  if (!user) return <Navigate to="/login" replace />;
  if (!user.permissions.includes(permission)) return <Navigate to="/app" replace />;
  return children;
}

function RequireRole({ role, children }: { role: string; children: ReactNode }) {
  const user = useAuthStore((s) => s.user);
  const hydrated = useAuthStore((s) => s.hydrated);
  if (!hydrated) return null;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== role) return <Navigate to="/app" replace />;
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
      fallback={
        <div className="mx-auto grid w-full max-w-5xl gap-4 p-4 sm:p-6">
          <Skeleton className="h-8 w-1/3" />
          <Skeleton className="h-4 w-1/2" />
          <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
          </div>
          <Skeleton className="h-64" />
        </div>
      }
    >
      {children}
    </Suspense>
  );
}
