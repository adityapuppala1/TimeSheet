/**
 * WHAT: the authenticated tenant-app shell — Sidebar + Topbar + routed page content, guarding
 * every child route behind a valid session.
 * WHY the `hydrated` check before the `user` check: `useAuthStore` starts with no user and
 * asynchronously tries to restore a session on load (access token lives in memory only, see
 * `store/auth.ts`) — redirecting to `/login` before that restore attempt finishes would bounce
 * an already-logged-in user on every page refresh.
 * WHO renders this: `App.tsx`, as the element for every `/app/*` route.
 */
import { Navigate, Outlet } from "react-router-dom";
import { MobileNav, Sidebar } from "../components/Sidebar";
import { Topbar } from "../components/Topbar";
import { useAuthStore } from "../store/auth";

export function AppLayout() {
  const user = useAuthStore((s) => s.user);
  const hydrated = useAuthStore((s) => s.hydrated);
  if (!hydrated) return <div className="grid min-h-screen place-items-center bg-background text-sm text-foreground/60">Loading secure workspace...</div>;
  if (!user) return <Navigate to="/login" replace />;

  return (
    <div className="min-h-screen bg-background">
      <div className="flex min-h-screen">
        <Sidebar />
        <main className="min-w-0 flex-1">
          <Topbar />
          <div className="mx-auto w-full max-w-7xl p-4 lg:p-6">
            <Outlet />
          </div>
          <MobileNav />
        </main>
      </div>
    </div>
  );
}
