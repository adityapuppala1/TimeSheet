/**
 * WHAT: the workspace admin's control for how far back a timesheet entry may be dated — Workspace
 * Settings → Ticketing → "Timesheet back-dating". The value is `GlobalTicketSettings.timesheetBackdateDays`:
 * a number of days (0 = today only), or null for no limit at all.
 *
 * WHY IT SITS ON THE TICKETING TAB: that is where the workspace-wide policies a super admin sets for
 * how people record work already live (SLA hours, CI gates, attestations), and it is where the admin
 * asked for it. It is the ONLY place this setting appears.
 *
 * WHY IT IS PRESENTATIONAL: the parent already owns the ticketing settings query and its save
 * mutation (one cache key, one toast, one audit row), so this takes the stored value and hands a new
 * one to `onSave` rather than making a second set of requests for the same row.
 *
 * WHAT THE CONTROL IS SAYING, plainly: "limited" is a switch and the number is only offered while it
 * is on, because "no limit" is a real choice some organisations want (they back-fill after month-end
 * close) and burying it as a very large number would make it a secret. The preview line shows the
 * actual earliest date for a person whose today is today, so an admin sees what 7 means in dates.
 */
import { useEffect, useState } from "react";
import { CalendarClock, Save } from "lucide-react";
import { earliestLoggableDate, TIMESHEET_BACKDATE_DAYS, TIMESHEET_BACKDATE_MAX_DAYS } from "@timesheet/shared";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Skeleton } from "../../components/ui/skeleton";
import { Switch } from "../../components/ui/switch";
import { isoToLocalDate, localDateKey } from "../../lib/local-day";
import { liveOrError, type TileVerdict } from "../../lib/settings-state";
import { cn } from "../../lib/utils";

/** The windows most organisations reach for, one click each. The number box takes anything else. */
const PRESETS: ReadonlyArray<{ days: number; label: string }> = [
  { days: 0, label: "Today only" },
  { days: 3, label: "3 days" },
  { days: 7, label: "7 days" },
  { days: 14, label: "14 days" },
  { days: 30, label: "30 days" }
];

/** The day count in the box as a whole number in range, or null when it is not one. */
export function parseBackdateDays(text: string): number | null {
  if (!/^\d{1,3}$/.test(text.trim())) return null;
  const n = Number(text);
  return n <= TIMESHEET_BACKDATE_MAX_DAYS ? n : null;
}

function dayLabel(iso: string): string {
  const date = isoToLocalDate(iso);
  return date ? date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }) : iso;
}

/** What the saved value means, for the board tile: whether a limit is in force and a short value. */
export function backdateSummary(value: number | null | undefined): { limited: boolean; value: string } {
  if (value === undefined) return { limited: true, value: "" };
  if (value === null) return { limited: false, value: "Any past date" };
  if (value === 0) return { limited: true, value: "Today only" };
  const noun = value === 1 ? "day" : "days";
  return { limited: true, value: `${value} ${noun} back` };
}

/** The slice of the ticketing-settings query this card needs — so the parent passes its query as it is. */
export interface BackdateSettingsQuery {
  data?: { timesheetBackdateDays: number | null };
  isLoading: boolean;
  isError: boolean;
  refetch: () => unknown;
}

/** The board tile for this section: a verdict from the query, so the parent adds no branching of its own. */
export function backdateTile(settings: Pick<BackdateSettingsQuery, "data" | "isError">): TileVerdict {
  const summary = backdateSummary(settings.data?.timesheetBackdateDays);
  return liveOrError(settings.isError, summary.limited, "Limit in force", "No limit", settings.data ? summary.value : undefined);
}

export function TimesheetBackdateCard({
  settings,
  readOnly,
  saving,
  onSave
}: Readonly<{
  settings: BackdateSettingsQuery;
  readOnly: boolean;
  saving: boolean;
  onSave: (days: number | null) => void;
}>) {
  /** The stored setting: days, 0 for today only, null for no limit. Undefined until it loads. */
  const value = settings.data?.timesheetBackdateDays;
  const loadFailed = settings.isError && !settings.data;
  const [limited, setLimited] = useState(true);
  const [daysText, setDaysText] = useState(String(TIMESHEET_BACKDATE_DAYS));

  // Follow the stored value: on first load, and again after a save refetches it.
  useEffect(() => {
    if (value === undefined) return;
    setLimited(value !== null);
    setDaysText(String(value ?? TIMESHEET_BACKDATE_DAYS));
  }, [value]);

  const parsed = parseBackdateDays(daysText);
  const next = limited ? parsed : null;
  const valid = !limited || parsed !== null;
  const changed = value !== undefined && next !== value;

  const todayKey = localDateKey(new Date());
  let preview = "Anyone can log for any past date. Approvers will see entries dated long after the work was done.";
  if (limited && parsed === 0) {
    preview = `Today only — for someone whose today is ${dayLabel(todayKey)}, that is the one day they can log.`;
  } else if (limited && parsed !== null) {
    preview = `For someone whose today is ${dayLabel(todayKey)}, the earliest day they can log is ${dayLabel(earliestLoggableDate(todayKey, parsed))}.`;
  }

  let body: React.ReactNode;
  if (loadFailed) {
    body = (
      <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3">
        <p className="text-sm text-destructive">These settings couldn&apos;t be loaded. No value has been changed.</p>
        <Button size="sm" variant="outline" onClick={() => settings.refetch()}>
          Retry
        </Button>
      </div>
    );
  } else if (settings.isLoading || value === undefined) {
    body = <Skeleton className="h-24 w-full" />;
  } else {
    body = (
      <>
        <div className="flex items-start gap-4 rounded-lg border border-border bg-muted/30 p-4">
          <div className="flex-1">
            <Label htmlFor="backdate-limited">Limit how far back an entry can be dated</Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              On by default. Switch it off to let people back-fill any past day — for example, if you reconcile timesheets after month-end.
            </p>
          </div>
          <Switch id="backdate-limited" checked={limited} disabled={readOnly} onCheckedChange={setLimited} />
        </div>

        {limited && (
          <div className="grid gap-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="backdate-days">Days back</Label>
                <Input
                  id="backdate-days"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={TIMESHEET_BACKDATE_MAX_DAYS}
                  className="w-28"
                  value={daysText}
                  disabled={readOnly}
                  aria-invalid={parsed === null}
                  onChange={(e) => setDaysText(e.target.value)}
                />
              </div>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Common windows">
                {PRESETS.map((p) => {
                  const on = parsed === p.days;
                  return (
                    <Button
                      key={p.days}
                      type="button"
                      size="sm"
                      variant={on ? "default" : "outline"}
                      aria-pressed={on}
                      disabled={readOnly}
                      className={cn("h-8", !on && "text-muted-foreground")}
                      onClick={() => setDaysText(String(p.days))}
                    >
                      {p.label}
                    </Button>
                  );
                })}
              </div>
            </div>
            {parsed === null && (
              <p role="alert" className="text-xs text-destructive">
                Enter a whole number of days from 0 to {TIMESHEET_BACKDATE_MAX_DAYS}. Use the switch above for no limit.
              </p>
            )}
          </div>
        )}

        <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground" aria-live="polite">
          {preview}
        </p>

        {!readOnly && (
          <Button size="sm" className="justify-self-start" disabled={!changed || !valid || saving} onClick={() => onSave(next)}>
            <Save className="h-4 w-4" />
            Save back-dating
          </Button>
        )}

        <p className="text-xs text-muted-foreground">
          Each person&apos;s own calendar day (their profile time zone) is the &quot;today&quot; this counts back from. It applies when an entry is
          created, when it is moved to another date, and when a draft is submitted — a draft that has aged past the window can no longer be
          submitted. Fixing the hours or project of an entry that is already saved, without changing its date, is still allowed, and entries
          already older than the window are left as they are. Future dates are never allowed.
        </p>
      </>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarClock className="h-4 w-4 text-primary" />
          Timesheet back-dating
        </CardTitle>
        <CardDescription>
          How many days before today a timesheet entry can still be dated. The calendar greys out older days and the server refuses them.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">{body}</CardContent>
    </Card>
  );
}
