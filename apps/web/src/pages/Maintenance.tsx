/**
 * WHAT: the full-page lockout screen users land on while the workspace is in an active
 * maintenance window — branded, calm, and honest about when they can come back.
 * WHY a PUBLIC page (outside /app): the people sent here have just had their sessions revoked
 * and their logins refused — routing them into AppLayout (which assumes a working session)
 * would bounce them straight back to /login in a loop. This page works with zero auth.
 * HOW it gets out of the way again: it polls the unauthenticated `GET /api/maintenance/status`
 * every 20s (the endpoint is rate-limited to 30/min per IP, so this is comfortably gentle) and
 * the moment the phase is no longer "active" it sends the visitor to /login. The countdown is
 * client-rendered off `scheduledEndAt` every second in between, so the page feels alive without
 * hammering the server.
 * WHO routes here: `services/api.ts`'s response interceptor (any 503 with code MAINTENANCE),
 * and `Login.tsx` when a sign-in attempt is refused for the same reason.
 */
import { useQuery } from "@tanstack/react-query";
import { CalendarClock, Clock, LogIn, Wrench } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "../components/ui/button";
import { maintenanceApi } from "../services/api";

/** "2h 14m 09s" — zero-padded only where it reads naturally. Negative clamps to zero so a
 *  countdown never displays "-3s" while waiting for the next poll to confirm the window ended. */
function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

function formatWindowTime(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function MaintenancePage() {
  const navigate = useNavigate();
  // Re-render every second for the countdown; the poll below is what actually decides state.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const statusQuery = useQuery({
    queryKey: ["maintenance-status"],
    queryFn: maintenanceApi.status,
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
    // A failed poll (server restarting mid-maintenance is likely!) must not blank the page —
    // keep showing the last known window and just try again.
    retry: false
  });

  const status = statusQuery.data;

  // The exit door: the moment the workspace is open again, send them to sign back in. Covers
  // both "admin turned it off" and "the window's end time passed". Also covers someone who
  // bookmarked /maintenance and visits on a normal day.
  useEffect(() => {
    if (status && status.phase !== "active") {
      const timer = setTimeout(() => navigate("/login", { replace: true }), 1500);
      return () => clearTimeout(timer);
    }
  }, [status, navigate]);

  const endsAt = status?.scheduledEndAt ? new Date(status.scheduledEndAt).getTime() : null;
  const remainingMs = endsAt ? endsAt - now : null;
  const windowStart = formatWindowTime(status?.scheduledStartAt ?? null);
  const windowEnd = formatWindowTime(status?.scheduledEndAt ?? null);
  const reopened = Boolean(status && status.phase !== "active");

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background p-4">
      {/* Same ambient treatment as the login page, so this reads as "our app, closed for the
          night" rather than a generic error screen. */}
      <div className="pointer-events-none absolute inset-0" aria-hidden>
        <div className="absolute -left-32 -top-32 h-96 w-96 rounded-full bg-primary/20 blur-3xl" />
        <div className="absolute -right-24 bottom-0 h-[28rem] w-[28rem] rounded-full bg-accent/25 blur-3xl" />
        <div className="absolute left-1/2 top-1/2 h-72 w-72 -translate-x-1/2 -translate-y-1/2 rounded-full bg-warning/10 blur-3xl" />
      </div>

      <main className="relative w-full max-w-lg">
        <div className="rounded-2xl border bg-card/95 p-8 shadow-xl backdrop-blur sm:p-10">
          <div className="flex flex-col items-center text-center">
            <div className="mb-6 grid h-16 w-16 place-items-center rounded-2xl bg-warning/15 text-warning">
              <Wrench className="h-8 w-8" aria-hidden />
            </div>

            <p className="text-sm font-semibold uppercase tracking-widest text-primary">TimeSphere</p>

            {reopened ? (
              <>
                <h1 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">We're back online</h1>
                <p className="mt-3 text-muted-foreground">
                  Maintenance is finished — taking you to the sign-in page…
                </p>
              </>
            ) : (
              <>
                <h1 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">Scheduled maintenance in progress</h1>
                <p className="mt-3 text-muted-foreground">
                  We're making improvements behind the scenes. The workspace is temporarily unavailable and
                  signing in is paused until the window ends.
                </p>
              </>
            )}

            {!reopened && remainingMs !== null && remainingMs > 0 && (
              <div className="mt-6 w-full rounded-xl border bg-muted/40 px-6 py-4">
                <p className="flex items-center justify-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  <Clock className="h-3.5 w-3.5" aria-hidden /> Estimated time remaining
                </p>
                <p className="mt-1 font-mono text-3xl font-bold tabular-nums text-foreground" aria-live="off">
                  {formatRemaining(remainingMs)}
                </p>
              </div>
            )}

            {!reopened && (windowStart || windowEnd) && (
              <p className="mt-4 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                <CalendarClock className="h-4 w-4 shrink-0" aria-hidden />
                {windowStart && <span>{windowStart}</span>}
                {windowStart && windowEnd && <span aria-hidden>→</span>}
                {windowEnd && <span>{windowEnd}</span>}
              </p>
            )}

            {/* The admin's own words, if they left any — plain text rendering, React escapes it. */}
            {!reopened && status?.message && (
              <div className="mt-5 w-full rounded-lg border-l-4 border-warning bg-warning/10 px-4 py-3 text-left text-sm text-foreground">
                {status.message}
              </div>
            )}

            <div className="mt-8 flex w-full flex-col items-center gap-3">
              {reopened ? (
                <Button size="lg" className="w-full sm:w-auto" onClick={() => navigate("/login", { replace: true })}>
                  <LogIn className="mr-2 h-4 w-4" aria-hidden /> Go to sign in
                </Button>
              ) : (
                <p className="text-xs text-muted-foreground">
                  This page checks automatically and will let you back in the moment we're done — no
                  need to refresh.
                </p>
              )}
            </div>
          </div>
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          Your data is safe. Unsaved changes from before the window may need to be re-entered.
        </p>
      </main>
    </div>
  );
}
