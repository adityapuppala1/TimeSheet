/**
 * WHAT: the "Maintenance" tab in Workspace Settings — schedule/enable the maintenance window,
 * watch who is online right now, warn them (in-app + email), and force-log-out the stragglers.
 * WHY split into its own file: same one-domain-per-file rule as every other card in this folder.
 * WHY the online list auto-refreshes: the whole point of the panel is "is anyone still in there?"
 * right before flipping the switch — a stale answer is worse than none. 30s matches the
 * server's picture, which itself moves in 5-minute lastSeenAt increments (see
 * api/src/middleware/auth.ts's throttle comment).
 * WHO calls the backing API: `controllers/maintenance.controller.ts`. SUPER_ADMINs are exempt
 * from the lockout by design — the card says so rather than leaving admins to discover it.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, CalendarClock, Loader2, LogOut, RefreshCw, Save, Users, Wrench } from "lucide-react";
import { useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from "../../components/ui/alert-dialog";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Skeleton } from "../../components/ui/skeleton";
import { Switch } from "../../components/ui/switch";
import { Textarea } from "../../components/ui/textarea";
import { toast } from "../../components/ui/toaster";
import { maintenanceApi, type MaintenancePhase } from "../../services/api";
import { ServerHealthCard } from "./ServerHealthCard";
import { ServiceStatusPage } from "../../components/ServiceStatusPage";

/** ISO from the API → the local "YYYY-MM-DDTHH:mm" a datetime-local input needs. Manual
 *  formatting because toISOString() would shift the wall-clock time to UTC — the admin picks
 *  times in THEIR clock. */
function toLocalInputValue(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** datetime-local value → ISO for the API. new Date() parses the value as local time, so the
 *  instant is preserved exactly. */
function fromLocalInputValue(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function formatLastSeen(iso: string | null): string {
  if (!iso) return "—";
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes === 0) return "just now";
  if (minutes === 1) return "1 min ago";
  return `${minutes} mins ago`;
}

const PHASE_BADGE: Record<MaintenancePhase, { label: string; variant: "muted" | "info" | "destructive" | "warning" }> = {
  off: { label: "Off", variant: "muted" },
  scheduled: { label: "Scheduled", variant: "info" },
  active: { label: "ACTIVE — users locked out", variant: "destructive" },
  ended: { label: "Window ended", variant: "warning" }
};

interface Draft {
  enabled: boolean;
  scheduledStartAt: string; // datetime-local format, "" = unset
  scheduledEndAt: string;
  message: string;
}

export function MaintenanceSettingsCard({ readOnly }: { readOnly: boolean }) {
  const queryClient = useQueryClient();
  const adminView = useQuery({
    queryKey: ["maintenance", "admin"],
    queryFn: maintenanceApi.admin,
    refetchInterval: 30_000
  });

  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => {
    if (adminView.data && !draft) {
      setDraft({
        enabled: adminView.data.settings.enabled,
        scheduledStartAt: toLocalInputValue(adminView.data.settings.scheduledStartAt),
        scheduledEndAt: toLocalInputValue(adminView.data.settings.scheduledEndAt),
        message: adminView.data.settings.message ?? ""
      });
    }
    // `!draft` guard: the 30s auto-refetch must not clobber half-typed edits.
  }, [adminView.data, draft]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["maintenance", "admin"] });

  const save = useMutation({
    mutationFn: () =>
      maintenanceApi.updateSettings({
        enabled: draft!.enabled,
        scheduledStartAt: fromLocalInputValue(draft!.scheduledStartAt),
        scheduledEndAt: fromLocalInputValue(draft!.scheduledEndAt),
        message: draft!.message.trim() || null
      }),
    onSuccess: (data) => {
      toast.success(
        data.settings.enabled
          ? data.phase === "active"
            ? "Maintenance mode is ACTIVE — users are now locked out"
            : "Maintenance window scheduled"
          : "Maintenance mode disabled"
      );
      setDraft(null); // re-seed from the fresh server copy
      invalidate();
    },
    onError: (error: any) => {
      toast.error("Couldn't save", { description: error?.response?.data?.message ?? "Try again." });
    }
  });

  const notify = useMutation({
    mutationFn: maintenanceApi.notify,
    onSuccess: ({ notified }) => {
      toast.success(
        notified === 0
          ? "Nobody to notify — no non-admin users are online"
          : `Warned ${notified} online user${notified === 1 ? "" : "s"} (in-app + email)`
      );
    },
    onError: (error: any) => {
      toast.error("Couldn't send the warning", { description: error?.response?.data?.message ?? "Try again." });
    }
  });

  const forceLogout = useMutation({
    mutationFn: maintenanceApi.forceLogout,
    onSuccess: ({ revokedSessions }) => {
      toast.success(
        revokedSessions === 0
          ? "No active sessions to revoke"
          : `Signed out ${revokedSessions} session${revokedSessions === 1 ? "" : "s"}`
      );
      invalidate();
    },
    onError: (error: any) => {
      toast.error("Couldn't force logout", { description: error?.response?.data?.message ?? "Try again." });
    }
  });

  if (adminView.isLoading || !draft) {
    return (
      <div className="grid gap-4">
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const phase = adminView.data?.phase ?? "off";
  const online = adminView.data?.online ?? { count: 0, users: [] };
  const badge = PHASE_BADGE[phase];
  const nonAdminOnline = online.users.filter((user) => user.role !== "SUPER_ADMIN").length;

  return (
    <div className="grid min-w-0 gap-4">
      {/* ------------------------------- Schedule card ------------------------------- */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2">
              <Wrench className="h-5 w-5 text-warning" /> Maintenance mode
            </CardTitle>
            <Badge variant={badge.variant}>{badge.label}</Badge>
          </div>
          <CardDescription>
            While the window is active, everyone except super admins is locked out: active sessions get a
            maintenance screen, and new sign-ins are refused until it ends. Super admins stay signed in —
            someone has to do the maintenance.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
            <div>
              <p className="font-medium">Enable maintenance window</p>
              <p className="text-sm text-muted-foreground">
                Requires a start and end time below. Enforcement begins at the start time — enabling ahead
                of time is safe and lets you warn people first.
              </p>
            </div>
            <Switch
              checked={draft.enabled}
              onCheckedChange={(checked) => setDraft({ ...draft, enabled: checked })}
              disabled={readOnly}
              aria-label="Enable maintenance window"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="maintenance-start">Window starts</Label>
              <Input
                id="maintenance-start"
                type="datetime-local"
                value={draft.scheduledStartAt}
                onChange={(event) => setDraft({ ...draft, scheduledStartAt: event.target.value })}
                disabled={readOnly}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="maintenance-end">Window ends</Label>
              <Input
                id="maintenance-end"
                type="datetime-local"
                value={draft.scheduledEndAt}
                onChange={(event) => setDraft({ ...draft, scheduledEndAt: event.target.value })}
                disabled={readOnly}
              />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="maintenance-message">Message to users (optional)</Label>
            <Textarea
              id="maintenance-message"
              placeholder="e.g. We're upgrading the database. Timesheets submitted before 6 PM are safe."
              value={draft.message}
              maxLength={500}
              rows={3}
              onChange={(event) => setDraft({ ...draft, message: event.target.value })}
              disabled={readOnly}
            />
            <p className="text-xs text-muted-foreground">
              Shown on the maintenance page and quoted in the warning email. {500 - draft.message.length}{" "}
              characters left.
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <CalendarClock className="h-3.5 w-3.5" /> Times are in your local timezone.
            </p>
            {/* Client-side seatbelt on top of the server's 422: enabling without a full window
                can't even be SUBMITTED. Belt and braces after a stray automated click once
                managed to arm a window mid-test-suite. */}
            <Button
              onClick={() => save.mutate()}
              disabled={readOnly || save.isPending || (draft.enabled && (!draft.scheduledStartAt || !draft.scheduledEndAt))}
              title={draft.enabled && (!draft.scheduledStartAt || !draft.scheduledEndAt) ? "Pick both a start and an end time first" : undefined}
            >
              {save.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              Save maintenance settings
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ------------------------------ Online users card ----------------------------- */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5 text-primary" /> Who's online now
            </CardTitle>
            <div className="flex items-center gap-2">
              <Badge variant={online.count > 0 ? "success" : "muted"}>
                {online.count} online
              </Badge>
              <Button
                variant="outline"
                size="sm"
                onClick={() => adminView.refetch()}
                disabled={adminView.isFetching}
                aria-label="Refresh online users"
              >
                <RefreshCw className={`h-4 w-4 ${adminView.isFetching ? "animate-spin" : ""}`} />
              </Button>
            </div>
          </div>
          <CardDescription>
            People with an authenticated request in the last 15 minutes. Warn them before the window, then
            force-log-out anyone still here. Auto-refreshes every 30 seconds.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {online.users.length === 0 ? (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              Nobody is online right now — a good moment for maintenance.
            </p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {online.users.map((user) => (
                <li key={user.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{user.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{user.email}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {user.role === "SUPER_ADMIN" && <Badge variant="info">exempt</Badge>}
                    <Badge variant="outline">{user.role.replace(/_/g, " ").toLowerCase()}</Badge>
                    <span className="text-xs tabular-nums text-muted-foreground">{formatLastSeen(user.lastSeenAt)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap justify-end gap-3">
            {/* Warn first… */}
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" disabled={readOnly || notify.isPending}>
                  {notify.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Bell className="mr-2 h-4 w-4" />}
                  Notify online users
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Warn everyone who's online?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Sends an in-app notification and an email to the {nonAdminOnline} non-admin user
                    {nonAdminOnline === 1 ? "" : "s"} currently online, quoting the scheduled window and your
                    message. Requires the window to be enabled and scheduled first.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => notify.mutate()}>Send warning</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>

            {/* …force-logout second. Destructive confirm: this signs out real people mid-work. */}
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" disabled={readOnly || forceLogout.isPending}>
                  {forceLogout.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <LogOut className="mr-2 h-4 w-4" />}
                  Force log out all users
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Sign out every non-admin user?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Revokes every active session except super admins' — people mid-edit lose unsaved work.
                    With maintenance active they'll land on the maintenance page; otherwise they can simply
                    sign back in. Consider sending the warning first.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    onClick={() => forceLogout.mutate()}
                  >
                    Force log out
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </CardContent>
      </Card>

      {/* Live vitals of the box the admin is about to take down / bring back. */}
      <ServerHealthCard />

      {/* And the other half of the question: the box can be perfectly healthy while a feature is
          not. This one is per-feature and has a memory — "was it down on Tuesday" is the question
          the vitals panel above structurally cannot answer. */}
      <ServiceStatusPage />
    </div>
  );
}
