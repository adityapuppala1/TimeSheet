/**
 * 7.0.0 — Profile: subscribe to my leave and holidays from Google / Outlook / Apple Calendar.
 *
 * The URL holds a private token (the server keeps only its hash), so it is shown ONCE, right after
 * it is created or rotated; afterwards only its first characters are shown. Rotate replaces it (the
 * old URL stops working), Turn off deletes it. Managers, team leads and admins also get a team feed:
 * approved leave of the people they can already see, leave type only. Renders nothing while
 * Attendance & Leave is off.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarSync, Copy } from "lucide-react";
import { useState } from "react";
import { runInBackground } from "../lib/run-in-background";
import { api } from "../services/api";
import { useLeaveEnabled } from "./attendance/use-leave";
import { useMyToday } from "./PunchIn";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { toast } from "./ui/toaster";

interface FeedStatus {
  enabled: boolean;
  hint: string | null;
  createdAt: string | null;
  lastUsedAt: string | null;
  teamFeedAvailable: boolean;
}

const KEY = ["calendar", "feed-token"] as const;
const serverMessage = (err: unknown, fallback: string) => (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback;

/** Pure: the two subscribe URLs for a token on this origin (exported for the unit test). */
export function feedUrls(origin: string, token: string): { mine: string; team: string } {
  const base = `${origin.replace(/\/$/, "")}/api/calendar/feed/${token}`;
  return { mine: `${base}.ics`, team: `${base}-team.ics` };
}

/** Pure: the line shown when no fresh URL is on screen. */
export function feedStatusText(s: Pick<FeedStatus, "enabled" | "hint" | "lastUsedAt">): string {
  if (!s.enabled) return "No calendar link yet.";
  const read = s.lastUsedAt ? ", last read " + new Date(s.lastUsedAt).toLocaleString() : "";
  return `A link is active (starts ${s.hint}…)${read}.`;
}

function CopyRow({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div className="grid gap-1">
      <span className="text-xs font-medium">{label}</span>
      <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
        <code className="min-w-0 flex-1 truncate text-xs">{value}</code>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="min-h-[44px] sm:min-h-8"
          aria-label={`Copy ${label}`}
          onClick={() =>
            runInBackground(
              navigator.clipboard.writeText(value).then(
                () => toast.success("Copied"),
                () => toast.error("Could not copy. Select the text and copy it instead.")
              )
            )
          }
        >
          <Copy className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

export function CalendarFeedCard() {
  const qc = useQueryClient();
  const leaveOn = useLeaveEnabled();
  const today = useMyToday();
  const on = leaveOn || Boolean(today.data?.enabled);
  const status = useQuery({ queryKey: KEY, queryFn: async () => (await api.get<FeedStatus>("/calendar/feed-token")).data, enabled: on });
  const [fresh, setFresh] = useState<string | null>(null);
  const rotate = useMutation({
    mutationFn: async () => (await api.post<{ token: string; hint: string }>("/calendar/feed-token/rotate")).data,
    onSuccess: (r) => {
      setFresh(r.token);
      runInBackground(qc.invalidateQueries({ queryKey: KEY }));
    },
    onError: (err) => toast.error("Could not create the calendar link", { description: serverMessage(err, "Try again.") })
  });
  const revoke = useMutation({
    mutationFn: async () => api.delete("/calendar/feed-token"),
    onSuccess: () => {
      setFresh(null);
      toast.success("Calendar link turned off", { description: "Calendars subscribed to it stop updating." });
      runInBackground(qc.invalidateQueries({ queryKey: KEY }));
    },
    onError: (err) => toast.error("Could not turn the link off", { description: serverMessage(err, "Try again.") })
  });
  if (!on || !status.data) return null;
  const s = status.data;
  const urls = fresh ? feedUrls(window.location.origin, fresh) : null;
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-lg bg-primary/10 text-primary">
            <CalendarSync className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <CardTitle>Calendar sync</CardTitle>
            <CardDescription>Your approved leave and holidays in Google, Outlook or Apple Calendar. The link is private: anyone who has it can read the calendar.</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3">
        {urls ? (
          <div className="grid gap-2" aria-live="polite">
            <p className="text-xs text-muted-foreground">Copy it now: for your security it is shown only once. Add it in your calendar app as a subscription ("From URL").</p>
            <CopyRow label="My leave and holidays" value={urls.mine} />
            {s.teamFeedAvailable && <CopyRow label="My team's leave (leave type only)" value={urls.team} />}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {feedStatusText(s)}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="button" className="min-h-[44px]" disabled={rotate.isPending} onClick={() => rotate.mutate()}>
            {s.enabled ? "Rotate link" : "Create link"}
          </Button>
          {s.enabled && (
            <Button type="button" variant="outline" className="min-h-[44px]" disabled={revoke.isPending} onClick={() => revoke.mutate()}>
              Turn off
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
