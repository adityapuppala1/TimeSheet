/**
 * WHAT: the authenticated tenant-app shell — Sidebar + Topbar + routed page content, guarding
 * every child route behind a valid session.
 * WHY the `hydrated` check before the `user` check: `useAuthStore` starts with no user and
 * asynchronously tries to restore a session on load (access token lives in memory only, see
 * `store/auth.ts`) — redirecting to `/login` before that restore attempt finishes would bounce
 * an already-logged-in user on every page refresh.
 * WHO renders this: `App.tsx`, as the element for every `/app/*` route.
 */
import { useEffect } from "react";
import { Navigate, Outlet } from "react-router";
import { MaintenanceBanner } from "../components/MaintenanceBanner";
import { authApi } from "../services/api";
import { PasswordChangeBanner } from "../components/PasswordChangeBanner";
import { OnboardingGate } from "../components/OnboardingGate";
import { FaceModelUpgradePrompt } from "../components/FaceModelUpgradePrompt";
import { SessionEndedDialog } from "../components/SessionEndedDialog";
import { MobileNav, Sidebar } from "../components/Sidebar";
import { Topbar } from "../components/Topbar";
import { useAuthStore } from "../store/auth";

export function AppLayout() {
  const user = useAuthStore((s) => s.user);
  const hydrated = useAuthStore((s) => s.hydrated);
  const setUser = useAuthStore((s) => s.setUser);

  // Timezone backfill: someone who never chose a timezone gets their DEVICE's zone recorded
  // once — detected in the browser, which is the only party that actually knows where the
  // person is. The server's own TZ says where the code runs, not where anyone lives, and using
  // it as a default mislabels every remote user. Silent and once; Profile lets them change it.
  useEffect(() => {
    if (!user || user.timezone) return;
    const deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!deviceTz) return;
    authApi
      .updateProfile({ timezone: deviceTz })
      .then(setUser)
      .catch(() => {
        /* next load retries; a missing timezone is not worth an error in anyone's way */
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps — run once per signed-in user
  }, [user?.id]);
  if (!hydrated) return <div className="grid min-h-screen place-items-center bg-background text-sm text-foreground/60">Loading secure workspace...</div>;
  if (!user) return <Navigate to="/login" replace />;

  return (
    <div className="min-h-screen bg-background">
      <div className="flex min-h-screen">
        <Sidebar />
        <main className="min-w-0 flex-1">
          <Topbar />
          <MaintenanceBanner />
          <PasswordChangeBanner />
          {/* pb-20 reserves clearance for MobileNav below (fixed, ~56-60px tall, <lg only) —
              without it the last ~56px of every page's content renders underneath the fixed
              bar on phone/tablet (e.g. a page-bottom submit button becomes unreachable). */}
          <div className="mx-auto w-full max-w-7xl p-4 pb-20 lg:p-6 lg:pb-6">
            <Outlet />
          </div>
          <MobileNav />
        </main>
      </div>
      {/* Overlays the shell rather than replacing it, for the same reason BackendHealthGate does:
          unmounting the app would destroy in-progress state, and the gate lifts on its own the
          moment the server says the requirements are met. */}
      <OnboardingGate />
      {/* Deliberately BELOW the gate: an unenrolled user is held by OnboardingGate and has no
          thin model to improve, so the two can never stack. Dismissible, never blocking. */}
      <FaceModelUpgradePrompt />
      {/* Heartbeat + "you've been signed out" dialog — how an admin's force-logout reaches
          this tab within seconds rather than on the next hard refresh. */}
      <SessionEndedDialog />
    </div>
  );
}
