/**
 * WHAT: the Workspace Settings tab for Attendance & Leave (V17 A1) — the master switch, punch-in,
 * reminders, holiday calendars, missed-day reasons, AI insights and privacy, as a board over
 * folding sections (the ChangeManagementSettingsCard shape).
 *
 * WHY EVERYTHING STARTS OFF: the module touches people's mornings (a punch-in prompt) and their
 * location, so an upgrade must never switch any of it on. The admin opts in here.
 *
 * WHY THE WHOLE TAB LOCKS WITHOUT THE PLAN (unlike change management's lock badge): every write
 * here is refused server-side without the entitlement, including the holiday and reason editors.
 * A form whose every save 403s is worse than one sentence explaining the plan.
 *
 * Leave types and approvals are placeholders until phase B. Sources & integrations (A3) live in
 * AttendanceSourcesSection.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BellRing,
  CalendarDays,
  Fingerprint,
  LayoutDashboard,
  Lock,
  MessageSquareWarning,
  Pencil,
  Plane,
  Plug,
  Plus,
  ShieldCheck,
  Sparkles,
  UserCheck
} from "lucide-react";
import { SectionBoard, SectionGroup, SettingsSection, ToggleRow, useOpenSections, type BoardEntry, type SectionState } from "../../components/settings/settings-sections";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { Card, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Skeleton } from "../../components/ui/skeleton";
import { Switch } from "../../components/ui/switch";
import { Textarea } from "../../components/ui/textarea";
import { toast } from "../../components/ui/toaster";
import { runInBackground } from "../../lib/run-in-background";
import {
  attendanceAdminApi,
  type AttendanceSettings,
  type HolidayCalendarRow,
  type HolidayRow,
  type MissedReasonOptionRow
} from "../../services/attendance-api";
import { AttendanceConfirmDelete } from "./AttendanceConfirmDelete";
import { AttendanceSourcesSection } from "./AttendanceSourcesSection";

const serverMessage = (err: any, fallback: string) => err?.response?.data?.message ?? fallback;

const PREFIX = "attendance";
const OPEN_KEY = "ts.settings.attendance.open";
const SETTINGS_KEY = ["attendance-admin", "settings"] as const;
const CALENDARS_KEY = ["attendance-admin", "calendars"] as const;
const REASONS_KEY = ["attendance-admin", "reasons"] as const;

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;

export function AttendanceSettingsCard({ readOnly }: { readOnly: boolean }) {
  const queryClient = useQueryClient();
  const config = useQuery({ queryKey: SETTINGS_KEY, queryFn: attendanceAdminApi.settings.get });
  const entitled = Boolean(config.data?.entitlements.attendanceEnabled);
  const calendars = useQuery({ queryKey: CALENDARS_KEY, queryFn: attendanceAdminApi.calendars.list, enabled: entitled });
  const reasons = useQuery({ queryKey: REASONS_KEY, queryFn: attendanceAdminApi.reasons.list, enabled: entitled });
  const sections = useOpenSections(OPEN_KEY, ["overview"]);

  const update = useMutation({
    mutationFn: (payload: Partial<AttendanceSettings>) => attendanceAdminApi.settings.update(payload),
    onSuccess: () => {
      toast.success("Saved");
      runInBackground(queryClient.invalidateQueries({ queryKey: SETTINGS_KEY }));
    },
    onError: (err: any) => toast.error("Could not save", { description: serverMessage(err, "Try again.") })
  });

  if (config.isLoading) return <Skeleton className="h-64 w-full" />;
  if (config.isError || !config.data) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/30 p-3">
        <p role="alert" className="text-sm text-destructive">Attendance settings could not be loaded.</p>
        <Button size="sm" variant="outline" onClick={() => config.refetch()}>Retry</Button>
      </div>
    );
  }

  const { settings, entitlements } = config.data;

  if (!entitlements.attendanceEnabled) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <CalendarDays className="h-4 w-4 text-primary" />
            Attendance & Leave
            <Badge variant="secondary" className="gap-1">
              <Lock className="h-3 w-3" />
              Not in your plan
            </Badge>
          </CardTitle>
          <CardDescription>
            Punch-in, holiday calendars and reasons for missed days are part of the Team and Enterprise plans; leave,
            integrations and AI insights are Enterprise. Ask your platform administrator to change the plan — nothing
            here can be switched on until then.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const disabled = readOnly || update.isPending;
  const save = (payload: Partial<AttendanceSettings>) => update.mutate(payload);
  const on = config.data.effective;
  const board = buildBoard({ settings, on, calendars: calendars.data, calendarsFailed: calendars.isError, reasons: reasons.data, reasonsFailed: reasons.isError, integrationsLocked: !entitlements.attendanceIntegrationsEnabled });
  const shell = (id: string) => {
    const e = board.find((b) => b.id === id)!;
    return { id, prefix: PREFIX, name: e.name, blurb: e.blurb, state: e.state, stateLabel: e.stateLabel, Icon: e.Icon, open: sections.isOpen(id), onToggle: () => sections.toggle(id) };
  };

  return (
    <div className="grid min-w-0 gap-4">
      <SectionBoard
        title="Attendance & Leave"
        summary={on ? "On — pick a section to tune it." : "Off — nothing here affects anyone until the master switch is on."}
        entries={board}
        onPick={(id) => sections.reveal(id, PREFIX)}
        columns={4}
      />

      <SettingsSection {...shell("overview")}>
        <SectionGroup>
          <ToggleRow
            emphasis
            label="Enable attendance"
            hint="Turns on the module for this workspace. Each part below has its own switch and stays off until you choose otherwise."
            checked={settings.attendanceEnabled}
            disabled={disabled}
            onChange={(v) => save({ attendanceEnabled: v })}
          />
        </SectionGroup>
      </SettingsSection>

      <SettingsSection {...shell("punch-in")}>
        <SectionGroup>
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            <ChoiceField
              id="att-punch-mode"
              label="Punch-in prompt"
              hint="Optional can be dismissed for the day; mandatory blocks the app (except profile and sign-out) until done."
              value={settings.punchInMode}
              options={[["OFF", "Off"], ["OPTIONAL", "Optional"], ["MANDATORY", "Mandatory"]]}
              disabled={disabled}
              onChange={(v) => save({ punchInMode: v as AttendanceSettings["punchInMode"] })}
            />
            <ChoiceField
              id="att-location"
              label="Location"
              hint="Asked from the browser with consent; IP is the fallback when it is refused."
              value={settings.locationMode}
              options={[["OFF", "Off"], ["OPTIONAL", "Optional"], ["REQUIRED", "Required"]]}
              disabled={disabled}
              onChange={(v) => save({ locationMode: v as AttendanceSettings["locationMode"] })}
            />
          </div>
          <ToggleRow
            label="Require a face check to punch in"
            hint="Reuses face verification (liveness and match). Needs face verification enabled and in your plan."
            checked={settings.punchInFaceRequired}
            disabled={disabled}
            onChange={(v) => save({ punchInFaceRequired: v })}
          />
          <ChoiceField
            id="att-face-rule"
            label="When the face check fails"
            hint="Allow and flag records the punch and queues the attempt for review, so a bad camera never costs someone a day."
            value={settings.faceFailureRule}
            options={[["BLOCK", "Block the punch"], ["ALLOW_FLAGGED", "Allow and flag for review"]]}
            disabled={disabled || !settings.punchInFaceRequired}
            onChange={(v) => save({ faceFailureRule: v as AttendanceSettings["faceFailureRule"] })}
          />
        </SectionGroup>
      </SettingsSection>

      <SettingsSection {...shell("reminders")}>
        <SectionGroup>
          <ToggleRow
            label="Remind people who have not punched in"
            hint="Working days only — never on a weekend, a holiday or approved leave, and never if a punch arrived from any source."
            checked={settings.punchInReminderEnabled}
            disabled={disabled}
            onChange={(v) => save({ punchInReminderEnabled: v })}
          />
          <ChoiceField
            id="att-reminder-hour"
            label="Reminder time (each person's own timezone)"
            hint="The end-of-day timesheet reminder is separate and unchanged."
            value={String(settings.punchInReminderHour)}
            options={HOURS.map((h) => [String(h), hourLabel(h)] as [string, string])}
            disabled={disabled || !settings.punchInReminderEnabled}
            onChange={(v) => save({ punchInReminderHour: Number(v) })}
          />
        </SectionGroup>
      </SettingsSection>

      <SettingsSection {...shell("holidays")}>
        <HolidayCalendarsEditor readOnly={readOnly} query={calendars} />
      </SettingsSection>

      <SettingsSection {...shell("reasons")}>
        <SectionGroup>
          <ToggleRow
            label="Ask for a reason on empty past days"
            hint="When someone logs time for a past working day that has no entries at all, they pick a reason. No approval — it is an explanation."
            checked={settings.missedDayReasonEnabled}
            disabled={disabled}
            onChange={(v) => save({ missedDayReasonEnabled: v })}
          />
          <MissedReasonsEditor readOnly={readOnly} query={reasons} />
        </SectionGroup>
      </SettingsSection>

      <SettingsSection {...shell("leave")}>
        <ComingSoon text="Leave types — quotas, accrual, carry-forward, half days — arrive in phase B." locked={!entitlements.leaveManagementEnabled} />
      </SettingsSection>

      <SettingsSection {...shell("approvals")}>
        <ComingSoon text="Leave approvals route to each person's manager, with a super-admin fallback. Coming in phase B." locked={!entitlements.leaveManagementEnabled} />
      </SettingsSection>

      <SettingsSection {...shell("sources")}>
        <AttendanceSourcesSection readOnly={readOnly} locked={!entitlements.attendanceIntegrationsEnabled} settings={settings} onSaveSettings={save} />
      </SettingsSection>

      <SettingsSection {...shell("analytics")}>
        <SectionGroup>
          {!entitlements.attendanceAiInsightsEnabled && <PlanNote text="AI insights are part of the Enterprise plan." />}
          <ToggleRow
            label="Insights for each person about themselves"
            hint="Their own patterns only."
            checked={settings.aiInsightsSelf}
            disabled={disabled || !entitlements.attendanceAiInsightsEnabled}
            onChange={(v) => save({ aiInsightsSelf: v })}
          />
          <ToggleRow
            label="Insights for managers about their team"
            hint="Aggregates only — never raw location, face data or anyone's free-text notes."
            checked={settings.aiInsightsManager}
            disabled={disabled || !entitlements.attendanceAiInsightsEnabled}
            onChange={(v) => save({ aiInsightsManager: v })}
          />
          <ToggleRow
            label="Organisation-wide insights for super admins"
            hint="Aggregates across the workspace."
            checked={settings.aiInsightsOrg}
            disabled={disabled || !entitlements.attendanceAiInsightsEnabled}
            onChange={(v) => save({ aiInsightsOrg: v })}
          />
          <NumberField
            id="att-min-group"
            label="Smallest group an aggregate may describe"
            hint="Below this, an average is really one person. Minimum 3."
            value={settings.minGroupSize}
            min={3}
            max={100}
            disabled={disabled}
            onCommit={(v) => save({ minGroupSize: v })}
          />
          <ChoiceField
            id="att-ai-frequency"
            label="Refresh AI suggestions"
            hint="AI suggestions are reused for this long; rule-based suggestions are always current."
            value={settings.aiInsightsFrequency}
            options={[["DAILY", "Daily"], ["WEEKLY", "Weekly"]]}
            disabled={disabled || !entitlements.attendanceAiInsightsEnabled}
            onChange={(v) => save({ aiInsightsFrequency: v as AttendanceSettings["aiInsightsFrequency"] })}
          />
          <ToggleRow
            label="Measure punch-ins against an expected start time"
            hint="Off by default. Without it, analytics compare each person with their own usual time, never with a rule."
            checked={settings.latenessEnabled}
            disabled={disabled}
            onChange={(v) => save({ latenessEnabled: v })}
          />
          {settings.latenessEnabled && (
            <ChoiceField
              id="att-expected-start"
              label="Expected start"
              hint="In each person's own timezone."
              value={String(settings.expectedStartMinute)}
              options={EXPECTED_START_OPTIONS}
              disabled={disabled}
              onChange={(v) => save({ expectedStartMinute: Number(v) })}
            />
          )}
        </SectionGroup>
      </SettingsSection>

      <SettingsSection {...shell("privacy")}>
        <SectionGroup>
          <div className="grid min-w-0 gap-1.5">
            <Label htmlFor="att-consent">Location consent text</Label>
            <Textarea
              id="att-consent"
              rows={3}
              maxLength={2000}
              disabled={disabled}
              defaultValue={settings.locationConsentText ?? ""}
              placeholder="Shown the first time someone is asked for their location. Leave empty for the built-in wording."
              onBlur={(e) => {
                const next = e.target.value.trim();
                if (next !== (settings.locationConsentText ?? "")) save({ locationConsentText: next === "" ? null : next });
              }}
            />
          </div>
          <NumberField
            id="att-retention"
            label="Keep raw location, IP and device for (days)"
            hint="After this the evidence is cleared; the punch time and source are kept."
            value={settings.locationRetentionDays}
            min={1}
            max={3650}
            disabled={disabled}
            onCommit={(v) => save({ locationRetentionDays: v })}
          />
        </SectionGroup>
      </SettingsSection>
    </div>
  );
}

/** A part's tile: off when its own switch is off; live only when the module is effective too. */
function partState(enabled: boolean, on: boolean): SectionState {
  if (!enabled) return "off";
  return on ? "live" : "ready";
}

function listState(failed: boolean, enabled: boolean, on: boolean): SectionState {
  return failed ? "attention" : partState(enabled, on);
}

function buildBoard(input: {
  settings: AttendanceSettings;
  on: boolean;
  calendars?: HolidayCalendarRow[];
  calendarsFailed: boolean;
  reasons?: MissedReasonOptionRow[];
  reasonsFailed: boolean;
  integrationsLocked: boolean;
}): BoardEntry[] {
  const { settings, on, calendars, reasons } = input;
  const holidayCount = (calendars ?? []).reduce((n, c) => n + c.holidays.length, 0);
  const enabledReasons = (reasons ?? []).filter((r) => r.enabled).length;
  const aiOn = settings.aiInsightsSelf || settings.aiInsightsManager || settings.aiInsightsOrg;
  const punchOff = settings.punchInMode === "OFF";
  const soon = { state: "off" as const, stateLabel: "Soon" };
  return [
    { id: "overview", name: "Overview", blurb: "The master switch for the whole module.", Icon: LayoutDashboard, state: on ? "live" : "off", stateLabel: on ? "On" : "Off" },
    { id: "punch-in", name: "Punch-in", blurb: "Whether and how people mark the start of their day.", Icon: Fingerprint, value: punchOff ? undefined : settings.punchInMode.toLowerCase(), state: partState(!punchOff, on), stateLabel: punchOff ? "Off" : undefined },
    { id: "reminders", name: "Reminders", blurb: "A nudge for anyone who has not punched in by the set hour.", Icon: BellRing, value: settings.punchInReminderEnabled ? hourLabel(settings.punchInReminderHour) : undefined, state: partState(settings.punchInReminderEnabled, on) },
    { id: "holidays", name: "Working days & holidays", blurb: "Holiday calendars and who follows which.", Icon: CalendarDays, value: calendars ? `${calendars.length} cal · ${holidayCount} days` : undefined, state: listState(input.calendarsFailed, holidayCount > 0, false) },
    { id: "reasons", name: "Missed-day reasons", blurb: "What people may choose when a past working day has no time.", Icon: MessageSquareWarning, value: reasons ? `${enabledReasons} enabled` : undefined, state: listState(input.reasonsFailed, settings.missedDayReasonEnabled, on) },
    { id: "leave", name: "Leave types", blurb: "Coming in phase B.", Icon: Plane, ...soon },
    { id: "approvals", name: "Approvals", blurb: "Coming in phase B.", Icon: UserCheck, ...soon },
    { id: "sources", name: "Sources & integrations", blurb: "Biometric devices, HRMS, API, MCP and CSV.", Icon: Plug, state: input.integrationsLocked ? "off" : "ready", stateLabel: input.integrationsLocked ? "Locked" : undefined },
    { id: "analytics", name: "Analytics & AI", blurb: "AI suggestions over attendance aggregates.", Icon: Sparkles, state: partState(aiOn, on) },
    { id: "privacy", name: "Privacy & retention", blurb: "Location consent wording and how long raw evidence is kept.", Icon: ShieldCheck, value: `${settings.locationRetentionDays} days`, state: "ready" }
  ];
}

/* ------------------------------------------------------------------ *
 * Small fields
 * ------------------------------------------------------------------ */

/** 05:00 to 14:00 in half hours — the server accepts 300-840. */
const EXPECTED_START_OPTIONS: Array<[string, string]> = Array.from({ length: 19 }, (_, i) => {
  const minute = 300 + i * 30;
  return [String(minute), `${String(Math.floor(minute / 60)).padStart(2, "0")}:${minute % 60 === 0 ? "00" : "30"}`];
});

function ChoiceField({
  id,
  label,
  hint,
  value,
  options,
  disabled,
  onChange
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  options: Array<[string, string]>;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <div className="grid min-w-0 gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={id} className="w-full min-w-0">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map(([v, text]) => (
            <SelectItem key={v} value={v}>{text}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

function NumberField({
  id,
  label,
  hint,
  value,
  min,
  max,
  disabled,
  onCommit
}: {
  id: string;
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onCommit: (v: number) => void;
}) {
  return (
    <div className="grid min-w-0 gap-1.5 sm:max-w-xs">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        disabled={disabled}
        defaultValue={value}
        onBlur={(e) => {
          const next = Number(e.target.value);
          if (Number.isInteger(next) && next >= min && next <= max && next !== value) onCommit(next);
        }}
      />
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

function PlanNote({ text }: { text: string }) {
  return (
    <p className="flex items-center gap-2 text-xs text-muted-foreground">
      <Lock className="h-3 w-3 shrink-0" />
      {text}
    </p>
  );
}

function ComingSoon({ text, locked }: { text: string; locked: boolean }) {
  return (
    <div className="grid gap-2 rounded-lg border border-dashed border-border p-4">
      <p className="text-sm text-muted-foreground">{text}</p>
      {locked && <PlanNote text="Part of the Enterprise plan." />}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Holiday calendars
 * ------------------------------------------------------------------ */

type ListQuery<T> = { data?: T[]; isLoading: boolean; isError: boolean; refetch: () => unknown };

function HolidayCalendarsEditor({ readOnly, query }: { readOnly: boolean; query: ListQuery<HolidayCalendarRow> }) {
  const queryClient = useQueryClient();
  const [newName, setNewName] = useState("");
  const refresh = () => runInBackground(queryClient.invalidateQueries({ queryKey: CALENDARS_KEY }));
  const onError = (err: any) => toast.error("Could not save", { description: serverMessage(err, "Try again.") });

  const create = useMutation({
    mutationFn: (name: string) => attendanceAdminApi.calendars.create({ name }),
    onSuccess: () => {
      setNewName("");
      refresh();
    },
    onError
  });
  const makeDefault = useMutation({ mutationFn: (id: string) => attendanceAdminApi.calendars.update(id, { isDefault: true }), onSuccess: refresh, onError });
  const remove = useMutation({ mutationFn: (id: string) => attendanceAdminApi.calendars.remove(id), onSuccess: refresh, onError });

  if (query.isLoading) return <Skeleton className="h-32 w-full" />;
  if (query.isError) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/30 p-3">
        <p role="alert" className="text-sm text-destructive">Holiday calendars could not be loaded.</p>
        <Button size="sm" variant="outline" onClick={() => query.refetch()}>Retry</Button>
      </div>
    );
  }
  const list = query.data ?? [];

  return (
    <div className="grid min-w-0 gap-4">
      <p className="text-xs text-muted-foreground">
        Weekends come from the working days under Planning. Everyone follows the default calendar unless assigned another.
      </p>
      {list.length === 0 && (
        <EmptyState compact icon={CalendarDays} title="No holiday calendars yet" description="The first calendar you add becomes the default for everyone." />
      )}
      {list.map((calendar) => (
        <div key={calendar.id} className="grid min-w-0 gap-3 rounded-lg border border-border p-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="min-w-0 truncate font-medium">{calendar.name}</span>
            {calendar.isDefault && <Badge variant="success">Default</Badge>}
            <span className="text-xs text-muted-foreground">{calendar.holidays.length} days · {calendar._count.users} assigned</span>
            <div className="ml-auto flex flex-wrap gap-2">
              {!calendar.isDefault && (
                <Button size="sm" variant="outline" disabled={readOnly || makeDefault.isPending} onClick={() => makeDefault.mutate(calendar.id)}>
                  Make default
                </Button>
              )}
              {!calendar.isDefault && (
                <AttendanceConfirmDelete
                  label={`Delete ${calendar.name}`}
                  title={`Delete "${calendar.name}"?`}
                  description={`This removes the calendar and its ${calendar.holidays.length} holidays. People assigned to it fall back to the default.`}
                  className="text-destructive hover:text-destructive"
                  iconClassName="h-4 w-4"
                  disabled={readOnly || remove.isPending}
                  onConfirm={() => remove.mutate(calendar.id)}
                />
              )}
            </div>
          </div>
          <HolidayList calendarId={calendar.id} holidays={calendar.holidays} readOnly={readOnly} onChanged={refresh} />
        </div>
      ))}
      {!readOnly && (
        <form
          className="flex min-w-0 flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (newName.trim()) create.mutate(newName.trim());
          }}
        >
          <div className="grid min-w-0 flex-1 gap-1.5">
            <Label htmlFor="att-new-calendar">New calendar</Label>
            <Input id="att-new-calendar" value={newName} maxLength={120} placeholder="e.g. India 2027" onChange={(e) => setNewName(e.target.value)} />
          </div>
          <Button type="submit" disabled={!newName.trim() || create.isPending}>
            <Plus className="mr-1 h-4 w-4" />
            Add calendar
          </Button>
        </form>
      )}
    </div>
  );
}

function HolidayList({ calendarId, holidays, readOnly, onChanged }: { calendarId: string; holidays: HolidayRow[]; readOnly: boolean; onChanged: () => void }) {
  const [draft, setDraft] = useState({ date: "", name: "", isOptional: false });
  const [editing, setEditing] = useState<{ id: string; date: string; name: string; isOptional: boolean } | null>(null);
  const onError = (err: any) => toast.error("Could not save", { description: serverMessage(err, "Try again.") });

  const create = useMutation({
    mutationFn: () => attendanceAdminApi.holidays.create(calendarId, draft),
    onSuccess: () => {
      setDraft({ date: "", name: "", isOptional: false });
      onChanged();
    },
    onError
  });
  const save = useMutation({
    mutationFn: (h: { id: string; date: string; name: string; isOptional: boolean }) =>
      attendanceAdminApi.holidays.update(calendarId, h.id, { date: h.date, name: h.name, isOptional: h.isOptional }),
    onSuccess: () => {
      setEditing(null);
      onChanged();
    },
    onError
  });
  const remove = useMutation({ mutationFn: (id: string) => attendanceAdminApi.holidays.remove(calendarId, id), onSuccess: onChanged, onError });

  return (
    <div className="grid min-w-0 gap-2">
      {holidays.length > 0 && (
        <ul className="grid min-w-0 gap-1">
          {holidays.map((h) =>
            editing?.id === h.id ? (
              <li key={h.id} className="flex min-w-0 flex-wrap items-center gap-2 rounded-md bg-muted/40 p-2">
                <Input type="date" aria-label="Date" className="w-auto" value={editing.date} onChange={(e) => setEditing({ ...editing, date: e.target.value })} />
                <Input aria-label="Name" className="min-w-0 flex-1" maxLength={120} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                <label className="flex items-center gap-2 text-xs">
                  <Switch checked={editing.isOptional} onCheckedChange={(v) => setEditing({ ...editing, isOptional: v })} />
                  Optional
                </label>
                <Button size="sm" disabled={!editing.date || !editing.name.trim() || save.isPending} onClick={() => save.mutate(editing)}>Save</Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              </li>
            ) : (
              <li key={h.id} className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-muted/40">
                <span className="shrink-0 font-mono text-xs text-muted-foreground">{h.date}</span>
                <span className="min-w-0 flex-1 truncate">{h.name}</span>
                {h.isOptional && <Badge variant="secondary">Optional</Badge>}
                {!readOnly && (
                  <>
                    <Button size="sm" variant="ghost" aria-label={`Edit ${h.name}`} onClick={() => setEditing({ id: h.id, date: h.date, name: h.name, isOptional: h.isOptional })}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <AttendanceConfirmDelete
                      label={`Delete ${h.name}`}
                      title={`Delete "${h.name}"?`}
                      description={`${h.date} stops counting as a holiday for everyone on this calendar.`}
                      disabled={remove.isPending}
                      onConfirm={() => remove.mutate(h.id)}
                    />
                  </>
                )}
              </li>
            )
          )}
        </ul>
      )}
      {!readOnly && (
        <form
          className="flex min-w-0 flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.date && draft.name.trim()) create.mutate();
          }}
        >
          <Input type="date" aria-label="Holiday date" className="w-auto" value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} />
          <Input aria-label="Holiday name" className="min-w-0 flex-1" maxLength={120} placeholder="Holiday name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <label className="flex items-center gap-2 text-xs">
            <Switch checked={draft.isOptional} onCheckedChange={(v) => setDraft({ ...draft, isOptional: v })} />
            Optional
          </label>
          <Button type="submit" size="sm" variant="outline" disabled={!draft.date || !draft.name.trim() || create.isPending}>
            <Plus className="mr-1 h-4 w-4" />
            Add holiday
          </Button>
        </form>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Missed-day reason options
 * ------------------------------------------------------------------ */

function MissedReasonsEditor({ readOnly, query }: { readOnly: boolean; query: ListQuery<MissedReasonOptionRow> }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState({ code: "", label: "" });
  const refresh = () => runInBackground(queryClient.invalidateQueries({ queryKey: REASONS_KEY }));
  const onError = (err: any) => toast.error("Could not save", { description: serverMessage(err, "Try again.") });

  const update = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Partial<MissedReasonOptionRow> }) => attendanceAdminApi.reasons.update(id, payload),
    onSuccess: refresh,
    onError
  });
  const create = useMutation({
    mutationFn: () => attendanceAdminApi.reasons.create({ code: draft.code, label: draft.label, order: ((query.data ?? []).length + 1) * 10 }),
    onSuccess: () => {
      setDraft({ code: "", label: "" });
      refresh();
    },
    onError
  });
  const remove = useMutation({ mutationFn: (id: string) => attendanceAdminApi.reasons.remove(id), onSuccess: refresh, onError });

  if (query.isLoading) return <Skeleton className="h-32 w-full" />;
  if (query.isError) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/30 p-3">
        <p role="alert" className="text-sm text-destructive">Reasons could not be loaded.</p>
        <Button size="sm" variant="outline" onClick={() => query.refetch()}>Retry</Button>
      </div>
    );
  }

  return (
    <div className="grid min-w-0 gap-2">
      {(query.data ?? []).length === 0 && (
        <EmptyState compact icon={MessageSquareWarning} title="No reasons yet" description="Add the choices people can give for a past day with no time. Nothing is asked until at least one is enabled." />
      )}
      <ul className="grid min-w-0 gap-2">
        {(query.data ?? []).map((r) => (
          <li key={r.id} className="grid min-w-0 gap-2 rounded-md border border-border p-2 sm:flex sm:flex-wrap sm:items-center">
            <span className="shrink-0 font-mono text-xs text-muted-foreground">{r.code}</span>
            <Input
              aria-label={`Label for ${r.code}`}
              className="min-w-0 sm:flex-1"
              maxLength={120}
              disabled={readOnly}
              defaultValue={r.label}
              onBlur={(e) => {
                const next = e.target.value.trim();
                if (next && next !== r.label) update.mutate({ id: r.id, payload: { label: next } });
              }}
            />
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-xs">
                <Switch checked={r.requiresNote} disabled={readOnly} onCheckedChange={(v) => update.mutate({ id: r.id, payload: { requiresNote: v } })} />
                Note required
              </label>
              <label className="flex items-center gap-2 text-xs">
                <Switch checked={r.enabled} disabled={readOnly} onCheckedChange={(v) => update.mutate({ id: r.id, payload: { enabled: v } })} />
                Enabled
              </label>
              {!readOnly && (
                <AttendanceConfirmDelete
                  label={`Delete ${r.code}`}
                  title={`Delete the "${r.label}" reason?`}
                  description="People can no longer pick it. Days already submitted with it keep it."
                  disabled={remove.isPending}
                  onConfirm={() => remove.mutate(r.id)}
                />
              )}
            </div>
          </li>
        ))}
      </ul>
      {!readOnly && (
        <form
          className="flex min-w-0 flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.code && draft.label.trim()) create.mutate();
          }}
        >
          <Input
            aria-label="New reason code"
            className="w-full sm:w-44"
            maxLength={40}
            placeholder="CODE"
            value={draft.code}
            onChange={(e) => setDraft({ ...draft, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_") })}
          />
          <Input aria-label="New reason label" className="min-w-0 flex-1" maxLength={120} placeholder="Label people see" value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
          <Button type="submit" size="sm" variant="outline" disabled={!draft.code || !draft.label.trim() || create.isPending}>
            <Plus className="mr-1 h-4 w-4" />
            Add reason
          </Button>
        </form>
      )}
    </div>
  );
}
