/**
 * WHAT: the amber "maintenance is coming" strip under the topbar during the SCHEDULED phase —
 * the warning shot before the lockout. Once the window actually starts, this banner is moot:
 * the api interceptor sends non-admins to /maintenance on their next request.
 * WHY it polls the PUBLIC status endpoint (60s): the phase can flip from "off" to "scheduled"
 * at any moment by admin action, and the endpoint is served from a 10s in-memory cache
 * server-side, so this costs almost nothing. 60s is well inside the 30/min per-IP limit.
 * WHY dismissal is per-window, not forever: sessionStorage keyed by the window's start time —
 * dismissing Tuesday's warning must not swallow next month's. A new tab (new session) shows it
 * again, which is the right bias for a warning about losing unsaved work.
 * WHO renders this: `layouts/AppLayout.tsx`, between the Topbar and the routed content.
 */
import { useQuery } from "@tanstack/react-query";
import { AlarmClock, X } from "lucide-react";
import { useState } from "react";
import { maintenanceApi } from "../services/api";
import { useAuthStore } from "../store/auth";

function dismissKey(startIso: string | null): string {
  return `maintenance-banner-dismissed:${startIso ?? "unknown"}`;
}

export function MaintenanceBanner() {
  const role = useAuthStore((s) => s.user?.role);
  const [, forceRender] = useState(0);

  const statusQuery = useQuery({
    queryKey: ["maintenance-status"],
    queryFn: maintenanceApi.status,
    refetchInterval: 60_000,
    retry: false
  });

  const status = statusQuery.data;
  if (!status || status.phase !== "scheduled" || !status.scheduledStartAt) return null;
  if (sessionStorage.getItem(dismissKey(status.scheduledStartAt))) return null;

  const start = new Date(status.scheduledStartAt);
  const end = status.scheduledEndAt ? new Date(status.scheduledEndAt) : null;
  const timeFormat: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" };
  const window = `${start.toLocaleString(undefined, timeFormat)}${end ? ` – ${end.toLocaleString(undefined, timeFormat)}` : ""}`;

  return (
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
  );
}
