import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { lazy, Suspense, useEffect } from "react";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router-dom";
import { permissions, type Permission } from "@timesheet/shared";
import { AppLayout } from "./layouts/AppLayout";
import { authApi } from "./services/api";
import { useAuthStore } from "./store/auth";
import { Toaster } from "./components/ui/toaster";
import { TooltipProvider } from "./components/ui/tooltip";
import { Skeleton } from "./components/ui/skeleton";

const Landing = lazy(() => import("./pages/Landing").then((m) => ({ default: m.Landing })));
const Login = lazy(() => import("./pages/Login").then((m) => ({ default: m.Login })));
const ForgotPassword = lazy(() => import("./pages/ForgotPassword").then((m) => ({ default: m.ForgotPassword })));
const Dashboard = lazy(() => import("./pages/Dashboard").then((m) => ({ default: m.Dashboard })));
const Timesheet = lazy(() => import("./pages/Timesheet").then((m) => ({ default: m.Timesheet })));
const Profile = lazy(() => import("./pages/Profile").then((m) => ({ default: m.Profile })));
const History = lazy(() => import("./pages/History").then((m) => ({ default: m.History })));
const AuditLog = lazy(() => import("./pages/AuditLog").then((m) => ({ default: m.AuditLog })));
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
  {
    path: "/app",
    element: <AppLayout />,
    children: [
      { index: true, element: <PageShell><Dashboard /></PageShell> },
      { path: "timesheet", element: <PageShell><Timesheet /></PageShell> },
      { path: "history", element: <PageShell><History /></PageShell> },
      { path: "profile", element: <PageShell><Profile /></PageShell> },
      { path: "team", element: <RequirePermission permission={permissions.TIMESHEETS_APPROVE}><PageShell><Team /></PageShell></RequirePermission> },
      { path: "approvals", element: <RequirePermission permission={permissions.TIMESHEETS_APPROVE}><PageShell><ApprovalsPage /></PageShell></RequirePermission> },
      { path: "users", element: <RequirePermission permission={permissions.USERS_MANAGE}><PageShell><UsersPage /></PageShell></RequirePermission> },
      { path: "projects", element: <RequirePermission permission={permissions.PROJECTS_MANAGE}><PageShell><ProjectsPage /></PageShell></RequirePermission> },
      { path: "reports", element: <RequirePermission permission={permissions.REPORTS_VIEW}><PageShell><ReportsPage /></PageShell></RequirePermission> },
      { path: "audit", element: <RequirePermission permission={permissions.AUDIT_VIEW}><PageShell><AuditLog /></PageShell></RequirePermission> },
      { path: "settings", element: <PageShell><WorkspaceSettingsPage /></PageShell> },
      { path: "email-templates", element: <RequireRole role="SUPER_ADMIN"><PageShell><EmailTemplatesPage /></PageShell></RequireRole> }
    ]
  }
]);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={200}>
        <AuthBootstrap />
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
    if (!localStorage.getItem("accessToken")) {
      setUser(undefined);
      return;
    }
    authApi.me().then(setUser).catch(() => {
      localStorage.removeItem("accessToken");
      localStorage.removeItem("refreshToken");
      setUser(undefined);
    });
  }, [setUser]);
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
