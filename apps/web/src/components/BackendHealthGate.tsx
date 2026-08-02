/**
 * WHAT: the visible half of backend health monitoring — a warning strip when the API starts
 * failing, escalating to a full blocking overlay when it's genuinely down.
 *
 * WHY block at all: every screen in this app reads or writes through the API. With the backend
 * gone, the UI can only mislead — stale numbers look current, forms accept input that will be
 * silently lost, and "Save" appears to work. Freezing the surface is more honest than letting
 * someone keep typing into a void.
 *
 * WHY not block immediately: see hooks/use-backend-health.ts — one dropped request is usually a
 * sleeping laptop or a rolling deploy, not an outage.
 *
 * Recovery is automatic: the moment a probe (or any real request) succeeds, both the banner and
 * the overlay disappear. No reload, and nothing the user typed is discarded, because the overlay
 * sits ON TOP of the app rather than unmounting it.
 */
import { AlertTriangle, Loader2, RefreshCw, Sparkles, WifiOff, X } from "lucide-react";
import { useState } from "react";
import { useBackendHealth } from "../hooks/use-backend-health";
import { Button } from "./ui/button";

export function BackendHealthGate() {
  const { level, lastOkAt, newServerVersion, checkNow } = useBackendHealth();
  const [updateDismissed, setUpdateDismissed] = useState(false);

  // The "server was upgraded underneath this tab" prompt. Non-blocking on purpose: unlike an
  // outage, a version skew is not dangerous — the old bundle keeps working against the new API
  // until a genuinely incompatible change ships, and interrupting someone mid-form to force a
  // reload would LOSE work to deliver an update that could wait a minute. Dismiss lasts until the
  // next version change (state resets on remount / new version value).
  if (level === "healthy" && newServerVersion && !updateDismissed) {
    return (
      <div
        role="status"
        className="fixed inset-x-0 bottom-0 z-[80] flex flex-wrap items-center justify-center gap-2 border-t border-primary/40 bg-primary/10 px-4 py-2.5 text-sm backdrop-blur-sm sm:bottom-4 sm:left-1/2 sm:right-auto sm:inset-x-auto sm:-translate-x-1/2 sm:rounded-full sm:border sm:px-4 sm:shadow-lg"
      >
        <Sparkles className="h-4 w-4 shrink-0 text-primary" />
        <span className="min-w-0">
          TimeSphere was updated to <strong>v{newServerVersion}</strong>.
        </span>
        {/* A plain reload is a REAL hard refresh here: bundle assets are content-hashed, so the
            re-fetched index.html references brand-new file names nothing could have cached. */}
        <Button size="sm" className="h-7 shrink-0" onClick={() => window.location.reload()}>
          <RefreshCw className="h-3.5 w-3.5" />Refresh
        </Button>
        <button
          type="button"
          aria-label="Dismiss update notice"
          onClick={() => setUpdateDismissed(true)}
          className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  if (level === "healthy") return null;

  if (level === "degraded") {
    return (
      <div
        role="status"
        className="flex flex-wrap items-center gap-2 border-b border-warning/40 bg-warning/10 px-4 py-2 text-sm text-warning-foreground"
      >
        <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
        <span className="min-w-0 flex-1">
          Having trouble reaching the server — retrying. Anything you save right now might not go through.
        </span>
        <Button size="sm" variant="ghost" className="h-7 shrink-0" onClick={checkNow}>
          <RefreshCw className="h-3.5 w-3.5" />Retry now
        </Button>
      </div>
    );
  }

  return (
    // `fixed inset-0` deliberately overlays rather than replaces the app: unmounting would destroy
    // in-progress form state, so when the backend comes back the user picks up exactly where they
    // were. aria-modal + role=alertdialog so assistive tech announces it and treats it as blocking.
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="backend-down-title"
      className="fixed inset-0 z-[100] grid place-items-center bg-background/80 p-4 backdrop-blur-sm"
    >
      <div className="w-full max-w-md rounded-lg border border-destructive/40 bg-card p-6 shadow-lg">
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-destructive/10 text-destructive">
            <WifiOff className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h2 id="backend-down-title" className="text-base font-bold tracking-tight">
              Can't reach the server
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              The app is paused so nothing you do is lost or silently discarded. It'll resume on its own the moment the
              connection comes back — you don't need to reload.
            </p>
            {lastOkAt && (
              <p className="mt-2 text-xs text-muted-foreground">Last responded at {lastOkAt.toLocaleTimeString()}.</p>
            )}
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={checkNow}>
                <RefreshCw className="h-3.5 w-3.5" />Try again
              </Button>
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Retrying automatically
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
