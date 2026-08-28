/**
 * WHAT: the full-page lockout screen users land on while the workspace is in an active
 * maintenance window — branded, animated, and honest about when they can come back.
 * WHY a PUBLIC page (outside /app): the people sent here have just had their sessions revoked
 * and their logins refused — routing them into AppLayout (which assumes a working session)
 * would bounce them straight back to /login in a loop. This page works with zero auth.
 * HOW it gets out of the way again: it polls the unauthenticated `GET /api/maintenance/status`
 * every 20s and the moment the phase is no longer "active" it sends the visitor to /login. The
 * countdown ticks client-side every second in between, and the progress bar is derived from
 * the window bounds — so the page feels alive without hammering the server.
 * DESIGN NOTES: counter-rotating gears + drifting ambient orbs say "work in progress" without a
 * single image asset; every entrance is staggered via framer-motion (already in the bundle for
 * the dashboard); the e2e-asserted strings ("Scheduled maintenance in progress", "Estimated
 * time remaining", "We're back online") are load-bearing — tests/e2e/maintenance.spec.ts.
 * WHO routes here: `services/api.ts`'s response interceptor (any 503 with code MAINTENANCE),
 * and `Login.tsx` when a sign-in attempt is refused for the same reason.
 */
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { CalendarClock, Clock, Cog, LogIn, RadioTower, ShieldCheck, Wrench } from "lucide-react";
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

/** Two counter-rotating gears with a wrench — the "crew at work" mark, in pure CSS/SVG. */
function WorkingGears() {
  return (
    <div className="relative h-24 w-24" aria-hidden>
      <motion.div
        className="absolute left-0 top-0 text-warning"
        animate={{ rotate: 360 }}
        transition={{ duration: 14, repeat: Infinity, ease: "linear" }}
      >
        <Cog className="h-14 w-14" strokeWidth={1.5} />
      </motion.div>
      <motion.div
        className="absolute bottom-0 right-0 text-primary"
        animate={{ rotate: -360 }}
        transition={{ duration: 10, repeat: Infinity, ease: "linear" }}
      >
        <Cog className="h-10 w-10" strokeWidth={1.5} />
      </motion.div>
      <motion.div
        className="absolute -bottom-1 left-1 text-foreground/70"
        animate={{ rotate: [0, -14, 8, 0] }}
        transition={{ duration: 2.6, repeat: Infinity, ease: "easeInOut" }}
      >
        <Wrench className="h-8 w-8" strokeWidth={1.75} />
      </motion.div>
    </div>
  );
}

/** Slow-drifting ambient orb. Motion runs transform-only, so this costs nothing measurable. */
function Orb({ className, duration, dx, dy }: { className: string; duration: number; dx: number; dy: number }) {
  return (
    <motion.div
      className={`absolute rounded-full blur-3xl ${className}`}
      animate={{ x: [0, dx, 0], y: [0, dy, 0] }}
      transition={{ duration, repeat: Infinity, ease: "easeInOut" }}
      aria-hidden
    />
  );
}

const enter = (delay: number) => ({
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.45, delay, ease: "easeOut" as const }
});

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

  const startsAt = status?.scheduledStartAt ? new Date(status.scheduledStartAt).getTime() : null;
  const endsAt = status?.scheduledEndAt ? new Date(status.scheduledEndAt).getTime() : null;
  const remainingMs = endsAt ? endsAt - now : null;
  // How far through the window we are — the "someone is actually working on this" signal.
  const progressPct =
    startsAt && endsAt && endsAt > startsAt ? Math.min(99, Math.max(1, Math.round(((now - startsAt) / (endsAt - startsAt)) * 100))) : null;
  const windowStart = formatWindowTime(status?.scheduledStartAt ?? null);
  const windowEnd = formatWindowTime(status?.scheduledEndAt ?? null);
  const reopened = Boolean(status && status.phase !== "active");

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background p-4">
      {/* Ambient layer — same visual family as the login page, but alive: the orbs drift. */}
      <div className="pointer-events-none absolute inset-0" aria-hidden>
        <Orb className="-left-32 -top-32 h-96 w-96 bg-primary/20" duration={18} dx={40} dy={28} />
        <Orb className="-right-24 bottom-0 h-[28rem] w-[28rem] bg-accent/25" duration={22} dx={-36} dy={-24} />
        <Orb className="left-1/2 top-1/2 h-72 w-72 -translate-x-1/2 -translate-y-1/2 bg-warning/10" duration={26} dx={24} dy={-32} />
        {/* Faint blueprint grid — "under construction" texture with zero assets. */}
        <div
          className="absolute inset-0 opacity-[0.35] dark:opacity-[0.18]"
          style={{
            backgroundImage:
              "linear-gradient(hsl(var(--border) / 0.55) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--border) / 0.55) 1px, transparent 1px)",
            backgroundSize: "44px 44px",
            maskImage: "radial-gradient(ellipse 70% 60% at 50% 45%, black 30%, transparent 75%)",
            WebkitMaskImage: "radial-gradient(ellipse 70% 60% at 50% 45%, black 30%, transparent 75%)"
          }}
        />
      </div>

      <main className="relative w-full max-w-xl">
        <motion.div {...enter(0)} className="rounded-2xl border bg-card/95 p-8 shadow-2xl backdrop-blur sm:p-10">
          <div className="flex flex-col items-center text-center">
            <motion.div {...enter(0.05)}>
              <WorkingGears />
            </motion.div>

            <motion.p {...enter(0.12)} className="mt-4 text-sm font-semibold uppercase tracking-widest text-primary">
              TimeSphere
            </motion.p>

            {reopened ? (
              <>
                <motion.h1 {...enter(0.18)} className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">
                  We're back online
                </motion.h1>
                <motion.p {...enter(0.24)} className="mt-3 text-muted-foreground">
                  Maintenance is finished — taking you to the sign-in page…
                </motion.p>
              </>
            ) : (
              <>
                <motion.h1 {...enter(0.18)} className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">
                  Scheduled maintenance in progress
                </motion.h1>
                <motion.p {...enter(0.24)} className="mt-3 max-w-md text-muted-foreground">
                  We're making improvements behind the scenes. The workspace is temporarily unavailable and
                  signing in is paused until the window ends.
                </motion.p>
              </>
            )}

            {!reopened && remainingMs !== null && remainingMs > 0 && (
              <motion.div {...enter(0.3)} className="mt-6 w-full rounded-xl border bg-muted/40 px-6 py-4">
                <p className="flex items-center justify-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  <Clock className="h-3.5 w-3.5" aria-hidden /> Estimated time remaining
                </p>
                <p className="mt-1 font-mono text-4xl font-bold tabular-nums text-foreground" aria-live="off">
                  {formatRemaining(remainingMs)}
                </p>
                {progressPct !== null && (
                  <div className="mt-3">
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <motion.div
                        className="h-full rounded-full bg-gradient-to-r from-primary to-warning"
                        initial={{ width: 0 }}
                        animate={{ width: `${progressPct}%` }}
                        transition={{ duration: 0.8, ease: "easeOut" }}
                      />
                    </div>
                    <p className="mt-1.5 text-[11px] tabular-nums text-muted-foreground">~{progressPct}% of the window elapsed</p>
                  </div>
                )}
              </motion.div>
            )}

            {!reopened && (windowStart || windowEnd) && (
              <motion.p
                {...enter(0.36)}
                className="mt-4 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-sm text-muted-foreground"
              >
                <CalendarClock className="h-4 w-4 shrink-0" aria-hidden />
                {windowStart && <span>{windowStart}</span>}
                {windowStart && windowEnd && <span aria-hidden>→</span>}
                {windowEnd && <span>{windowEnd}</span>}
              </motion.p>
            )}

            {/* WHO armed it, when it was platform operations rather than this workspace. A person
                locked out of their own workspace asks their own administrator first; if the window
                is a deployment-wide one, that administrator cannot lift it either, and saying so
                here saves a support round-trip that ends in "we can't". A role, never a person. */}
            {!reopened && status?.managedByPlatform && (
              <motion.p {...enter(0.4)} className="mt-4 text-sm text-muted-foreground">
                Scheduled by {status.managedByLabel ?? "platform operations"} as part of planned maintenance across the service — your own
                administrators cannot bring this forward.
              </motion.p>
            )}

            {/* The admin's own words, if they left any — plain text rendering, React escapes it. */}
            {!reopened && status?.message && (
              <motion.div
                {...enter(0.42)}
                className="mt-5 w-full rounded-lg border-l-4 border-warning bg-warning/10 px-4 py-3 text-left text-sm text-foreground"
              >
                {status.message}
              </motion.div>
            )}

            <motion.div {...enter(0.48)} className="mt-8 flex w-full flex-col items-center gap-3">
              {reopened ? (
                <Button size="lg" className="w-full sm:w-auto" onClick={() => navigate("/login", { replace: true })}>
                  <LogIn className="mr-2 h-4 w-4" aria-hidden /> Go to sign in
                </Button>
              ) : (
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="relative flex h-2 w-2" aria-hidden>
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
                  </span>
                  <RadioTower className="h-3.5 w-3.5" aria-hidden />
                  Live — this page checks automatically and lets you back in the moment we're done. No need to refresh.
                </p>
              )}
            </motion.div>
          </div>
        </motion.div>

        <motion.p
          {...enter(0.55)}
          className="mt-6 flex items-center justify-center gap-1.5 text-center text-xs text-muted-foreground"
        >
          <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden />
          Your data is safe. Unsaved changes from before the window may need to be re-entered.
        </motion.p>
      </main>
    </div>
  );
}
