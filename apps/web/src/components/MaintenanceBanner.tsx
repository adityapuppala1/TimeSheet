/**
 * WHAT: the two warning surfaces during the SCHEDULED maintenance phase — a persistent amber
 * strip under the topbar, plus a one-time modal POP-UP over whatever the person is doing.
 * WHY both: the banner is easy to tune out (people don't scan chrome while mid-task — the
 * explicit product feedback behind the pop-up), while a modal interrupts exactly once and then
 * stays out of the way. The banner persists after the pop-up is acknowledged, as the ambient
 * reminder. Once the window actually starts, both are moot: the api interceptor (plus the 15s
 * session heartbeat) sends non-admins to /maintenance within seconds.
 * WHY it polls the PUBLIC status endpoint (60s): the phase can flip from "off" to "scheduled"
 * at any moment by admin action, and the endpoint is served from a 10s in-memory cache
 * server-side, so this costs almost nothing. 60s is well inside the 30/min per-IP limit.
 * DISMISSAL SCOPES, deliberately different: the pop-up is once per window per BROWSER
 * (localStorage — being interrupted again in every new tab would teach people to click it away
 * blind), while the banner is per-tab-session (sessionStorage — cheap to re-show, and a
 * reminder about losing unsaved work should err toward reappearing). Both keys carry the
 * window's start time, so rescheduling the window re-warns everyone about the NEW time.
 * WHO renders this: `layouts/AppLayout.tsx`, between the Topbar and the routed content.
 */
import { useQuery } from "@tanstack/react-query";
import { AlarmClock, CalendarClock, X } from "lucide-react";
import { useEffect, useState } from "react";
import { maintenanceApi } from "../services/api";
import { useAuthStore } from "../store/auth";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "./ui/alert-dialog";

function dismissKey(startIso: string | null): string {
  return `maintenance-banner-dismissed:${startIso ?? "unknown"}`;
}

function popupSeenKey(startIso: string): string {
  return `maintenance-popup-seen:${startIso}`;
}

export function MaintenanceBanner() {
  const role = useAuthStore((s) => s.user?.role);
  const [, forceRender] = useState(0);
  const [popupOpen, setPopupOpen] = useState(false);

  const statusQuery = useQuery({
    queryKey: ["maintenance-status"],
    queryFn: maintenanceApi.status,
    refetchInterval: 60_000,
    retry: false
  });

  const status = statusQuery.data;
  const scheduledStart = status?.phase === "scheduled" ? status.scheduledStartAt : null;

  // Open the pop-up the first time this browser learns about a given window — including when
  // the phase flips to "scheduled" mid-session via the poll, which is precisely the moment the
  // person most needs interrupting.
  useEffect(() => {
    if (scheduledStart && !localStorage.getItem(popupSeenKey(scheduledStart))) {
      setPopupOpen(true);
    }
  }, [scheduledStart]);

  if (!status || status.phase !== "scheduled" || !status.scheduledStartAt) return null;

  const start = new Date(status.scheduledStartAt);
  const end = status.scheduledEndAt ? new Date(status.scheduledEndAt) : null;
  const timeFormat: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" };
  const window = `${start.toLocaleString(undefined, timeFormat)}${end ? ` – ${end.toLocaleString(undefined, timeFormat)}` : ""}`;

  const popup = (
    <AlertDialog open={popupOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <div className="mb-2 grid h-12 w-12 place-items-center rounded-full bg-warning/15 text-warning">
            <CalendarClock className="h-6 w-6" aria-hidden />
          </div>
          <AlertDialogTitle>Scheduled maintenance ahead</AlertDialogTitle>
          <AlertDialogDescription className="space-y-2">
            <span className="block">
              This workspace goes into maintenance <span className="font-semibold text-foreground">{window}</span>.
            </span>
            <span className="block">
              {role === "SUPER_ADMIN"
                ? "All non-admin users will be signed out for the window and can't sign back in until it ends. As a super admin, you stay signed in."
                : "Please save your work before it starts — you'll be signed out automatically when the window begins, and signing in is paused until it ends."}
            </span>
            {status.message && (
              <span className="block rounded-md border-l-4 border-warning bg-warning/10 px-3 py-2 text-foreground">
                {status.message}
              </span>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction
            onClick={() => {
              localStorage.setItem(popupSeenKey(status.scheduledStartAt!), "1");
              setPopupOpen(false);
            }}
          >
            Got it — I'll save my work
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  if (sessionStorage.getItem(dismissKey(status.scheduledStartAt))) return popup;

  return (
    <>
      {popup}
    <div
      role="status"
      className="flex items-start justify-between gap-3 border-b border-warning/30 bg-warning/10 px-4 py-2.5 text-sm text-foreground lg:px-6"
    >
      <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <AlarmClock className="h-4 w-4 shrink-0 text-warning" aria-hidden />
        <span className="font-medium">Scheduled maintenance:</span>
        <span>{window}.</span>
        <span className="text-muted-foreground">
          {role === "SUPER_ADMIN"
            ? "Users will be locked out for the window — super admins stay signed in."
            : "Save your work — you'll be signed out when it begins."}
        </span>
        {status.message && <span className="text-muted-foreground">{status.message}</span>}
      </p>
      <button
        type="button"
        aria-label="Dismiss maintenance warning"
        className="grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-warning/20 hover:text-foreground"
        onClick={() => {
          sessionStorage.setItem(dismissKey(status.scheduledStartAt), "1");
          forceRender((n) => n + 1);
        }}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
    </>
  );
}
