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
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, Lock, MessageSquareWarning, Pencil, Plus } from "lucide-react";
import { CardError } from "../../components/attendance/attendance-ui";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../components/ui/alert-dialog";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Skeleton } from "../../components/ui/skeleton";
import { Switch } from "../../components/ui/switch";
import { Textarea } from "../../components/ui/textarea";
import { toast } from "../../components/ui/toaster";
import {
  changesPayload,
  cleanDraft,
  diffLeaveSettings,
  diffSettings,
  impactReasons,
  matchPreset,
  PRESETS,
  settingsSections,
  settingsSummary,
  stagePreset,
  type NavSection,
  type PresetId,
  type SettingsDraft
} from "../../lib/attendance-settings-model";
import { planSettingsSave, runSettingsSave } from "../../lib/attendance-settings-save";
import { runInBackground } from "../../lib/run-in-background";
import { cn } from "../../lib/utils";
import {
  attendanceAdminApi,
  MY_TODAY_QUERY_KEY,
  type AttendanceSettings,
  type HolidayCalendarRow,
  type HolidayRow,
  type MissedReasonOptionRow
} from "../../services/attendance-api";
import { LEAVE_STATUS_KEY, leaveAdminApi, type LeaveSettings } from "../../services/leave-api";
import { StagedNumber, StagedSegment, StagedSelect, StagedToggle } from "./attendance-fields";
import { AttendanceConfirmDelete } from "./AttendanceConfirmDelete";
import { AttendanceSourcesSection } from "./AttendanceSourcesSection";
import { BalanceAdjustments, LEAVE_SETTINGS_KEY, LEAVE_TYPES_KEY, LeaveSettingsFields, LeaveTypesSection } from "./LeaveSettingsSections";

const serverMessage = (err: any, fallback: string) => err?.response?.data?.message ?? fallback;

const SETTINGS_KEY = ["attendance-admin", "settings"] as const;
const CALENDARS_KEY = ["attendance-admin", "calendars"] as const;
const REASONS_KEY = ["attendance-admin", "reasons"] as const;

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;

export function AttendanceSettingsCard({ readOnly }: { readOnly: boolean }) {
  const queryClient = useQueryClient();
  const config = useQuery({ queryKey: SETTINGS_KEY, queryFn: attendanceAdminApi.settings.get });
  const entitled = Boolean(config.data?.entitlements.attendanceEnabled);
  const leaveEntitled = Boolean(config.data?.entitlements.leaveManagementEnabled);
  const calendars = useQuery({ queryKey: CALENDARS_KEY, queryFn: attendanceAdminApi.calendars.list, enabled: entitled });
  const reasons = useQuery({ queryKey: REASONS_KEY, queryFn: attendanceAdminApi.reasons.list, enabled: entitled });
  const leaveCfg = useQuery({ queryKey: LEAVE_SETTINGS_KEY, queryFn: leaveAdminApi.settings, enabled: leaveEntitled });
  const leaveTypes = useQuery({ queryKey: LEAVE_TYPES_KEY, queryFn: leaveAdminApi.types, enabled: leaveEntitled });

  const [section, setSection] = useState("overview");
  const [draft, setDraft] = useState<SettingsDraft>({});
  const [leaveDraft, setLeaveDraft] = useState<Partial<LeaveSettings>>({});
  const [confirm, setConfirm] = useState<{ reasons: string[]; people: number | null } | null>(null);

  const saved = config.data?.settings;
  const savedLeave = leaveCfg.data?.settings;
  const changes = useMemo(() => (saved ? diffSettings(saved, draft) : []), [saved, draft]);
  const leaveChanges = useMemo(() => (savedLeave ? diffLeaveSettings(savedLeave, leaveDraft) : []), [savedLeave, leaveDraft]);
  const dirty = changes.length + leaveChanges.length;
  const sections = useMemo(() => settingsSections(leaveEntitled), [leaveEntitled]);

  const afterSave = () => {
    setDraft({});
    setLeaveDraft({});
    setConfirm(null);
    toast.success("Settings saved");
    runInBackground(queryClient.invalidateQueries({ queryKey: SETTINGS_KEY }));
    runInBackground(queryClient.invalidateQueries({ queryKey: LEAVE_SETTINGS_KEY }));
    // The sidebar and the leave screens key off these, so they must notice the switch at once.
    runInBackground(queryClient.invalidateQueries({ queryKey: LEAVE_STATUS_KEY }));
    runInBackground(queryClient.invalidateQueries({ queryKey: MY_TODAY_QUERY_KEY }));
  };

  const saveAll = useMutation({
    mutationFn: async () => {
      // Only attendance must be loaded: on the Team plan (or when the leave GET failed) there is no leave half.
      if (!saved) throw new Error("not loaded");
      const plan = planSettingsSave({ attendancePayload: changesPayload(saved, draft), leaveLoaded: Boolean(savedLeave), leaveChangeCount: leaveChanges.length, leaveDraft });
      const outcome = await runSettingsSave(plan, { saveAttendance: attendanceAdminApi.settings.update, saveLeave: leaveAdminApi.updateSettings });
      if (outcome.status === "failed") throw outcome.error;
      return outcome;
    },
    onSuccess: (outcome) => {
      if (outcome.status === "saved") {
        afterSave();
        return;
      }
      // Half-saved: the attendance part is live, so it leaves the staged set; only leave stays staged.
      setDraft({});
      setConfirm(null);
      runInBackground(queryClient.invalidateQueries({ queryKey: SETTINGS_KEY }));
      runInBackground(queryClient.invalidateQueries({ queryKey: MY_TODAY_QUERY_KEY }));
      toast.error("Attendance settings saved; leave settings were not", {
        description: serverMessage(outcome.error, "Your leave changes are still staged. Try saving again.")
      });
    },
    onError: (err: unknown) => {
      toast.error("Could not save", { description: serverMessage(err, "Nothing was lost; your changes are still staged.") });
      setConfirm(null);
    }
  });

  // An immediate save for the one control that is not staged (source priorities in the Sources section).
  const saveNow = useMutation({
    mutationFn: (payload: Partial<AttendanceSettings>) => attendanceAdminApi.settings.update(payload),
    onSuccess: () => {
      toast.success("Saved");
      runInBackground(queryClient.invalidateQueries({ queryKey: SETTINGS_KEY }));
    },
    onError: (err: unknown) => toast.error("Could not save", { description: serverMessage(err, "Try again.") })
  });

  if (config.isLoading) return <Skeleton className="h-64 w-full" />;
  if (config.isError || !config.data || !saved) {
    return <CardError message="Attendance settings could not be loaded." onRetry={() => runInBackground(config.refetch())} />;
  }
  const { entitlements } = config.data;

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

  const values: AttendanceSettings = { ...saved, ...draft };
  const leaveValues: LeaveSettings | null = savedLeave ? { ...savedLeave, ...leaveDraft } : null;
  const disabled = readOnly || saveAll.isPending;
  const stage = (patch: SettingsDraft) => setDraft((d) => cleanDraft(saved, { ...d, ...patch }));
  const stageLeave = (patch: Partial<LeaveSettings>) =>
    setLeaveDraft((d) => {
      const next = { ...d, ...patch } as Partial<LeaveSettings>;
      for (const k of Object.keys(next) as Array<keyof LeaveSettings>) if (savedLeave && next[k] === savedLeave[k]) delete next[k];
      return next;
    });
  const changed = (key: keyof AttendanceSettings) => key in draft;
  const on = config.data.effective;
  const enabledTypes = (leaveTypes.data ?? []).filter((t) => t.enabled).length;

  const requestSave = async () => {
    const reasonsList = impactReasons(saved, draft);
    if (reasonsList.length === 0) {
      saveAll.mutate();
      return;
    }
    let people: number | null = null;
    try {
      people = (await attendanceAdminApi.settings.impact()).people;
    } catch {
      /* the count is context, not a gate: confirm without it */
    }
    setConfirm({ reasons: reasonsList, people });
  };

  const summary = settingsSummary(values);
  const preset = matchPreset(values);

  return (
    <div className="grid min-w-0 gap-4">
      <div className="grid min-w-0 gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
        <SectionNav sections={sections} value={section} onChange={setSection} dirtySections={dirtySections(changes, leaveChanges)} />
        <div className="grid min-w-0 content-start gap-4 pb-24">
          <p className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground" aria-live="polite">
            <span className="font-semibold text-foreground">Right now: </span>
            {summary}
          </p>

          {section === "overview" && (
            <div className="grid gap-4">
              <StagedToggle
                id="att-enabled"
                emphasis
                label="Enable attendance"
                hint="Turns on the module for this workspace. Each part has its own switch and stays off until you choose otherwise."
                checked={values.attendanceEnabled}
                disabled={disabled}
                changed={changed("attendanceEnabled")}
                onChange={(v) => stage({ attendanceEnabled: v })}
              >
                <PresetPicker active={preset} disabled={disabled} onPick={(id) => stage(stagePreset(values, id))} />
              </StagedToggle>
            </div>
          )}

          {section === "punch-in" && (
            <div className="grid gap-4">
              <PresetPicker active={preset} disabled={disabled} onPick={(id) => stage(stagePreset(values, id))} />
              <StagedToggle
                id="att-punch"
                label="Ask people to punch in"
                hint="A prompt when they open TimeSphere. Optional can be dismissed for the day; mandatory blocks the app (except profile and sign-out) until done."
                checked={values.punchInMode !== "OFF"}
                disabled={disabled}
                changed={changed("punchInMode")}
                onChange={(v) => stage({ punchInMode: v ? "OPTIONAL" : "OFF" })}
              >
                <StagedSegment
                  label="How firmly"
                  value={values.punchInMode === "MANDATORY" ? "MANDATORY" : "OPTIONAL"}
                  disabled={disabled}
                  onChange={(v) => stage({ punchInMode: v })}
                  options={[
                    { value: "OPTIONAL", label: "Optional" },
                    { value: "MANDATORY", label: "Mandatory" }
                  ]}
                />
              </StagedToggle>
              <StagedToggle
                id="att-location"
                label="Confirm work location"
                hint="Asked from the browser with consent; the network address is the fallback when it is refused."
                checked={values.locationMode !== "OFF"}
                disabled={disabled}
                changed={changed("locationMode")}
                onChange={(v) => stage({ locationMode: v ? "OPTIONAL" : "OFF" })}
              >
                <StagedSegment
                  label="How firmly"
                  value={values.locationMode === "REQUIRED" ? "REQUIRED" : "OPTIONAL"}
                  disabled={disabled}
                  onChange={(v) => stage({ locationMode: v })}
                  options={[
                    { value: "OPTIONAL", label: "Optional" },
                    { value: "REQUIRED", label: "Required" }
                  ]}
                />
              </StagedToggle>
              <StagedToggle
                id="att-face"
                label="Face check to punch in"
                hint="Reuses face verification (liveness and match). Needs face verification enabled and in your plan."
                checked={values.punchInFaceRequired}
                disabled={disabled}
                changed={changed("punchInFaceRequired")}
                onChange={(v) => stage({ punchInFaceRequired: v })}
              >
                <StagedSegment
                  label="When the face check fails"
                  hint="Allow and flag records the punch and queues it for review, so a bad camera never costs someone a day."
                  value={values.faceFailureRule}
                  disabled={disabled}
                  onChange={(v) => stage({ faceFailureRule: v })}
                  options={[
                    { value: "BLOCK", label: "Block the punch" },
                    { value: "ALLOW_FLAGGED", label: "Allow and flag" }
                  ]}
                />
              </StagedToggle>
            </div>
          )}

          {section === "reminders" && (
            <StagedToggle
              id="att-reminder"
              label="Remind people who have not punched in"
              hint="Working days only — never on a weekend, a holiday or approved leave, and never if a punch arrived from any source."
              checked={values.punchInReminderEnabled}
              disabled={disabled}
              changed={changed("punchInReminderEnabled")}
              onChange={(v) => stage({ punchInReminderEnabled: v })}
            >
              <StagedSelect
                id="att-reminder-hour"
                label="Reminder time (each person's own timezone)"
                hint="The end-of-day timesheet reminder is separate and unchanged."
                value={String(values.punchInReminderHour)}
                options={HOURS.map((h) => [String(h), hourLabel(h)] as [string, string])}
                disabled={disabled}
                onChange={(v) => stage({ punchInReminderHour: Number(v) })}
              />
            </StagedToggle>
          )}

          {section === "holidays" && <HolidayCalendarsEditor readOnly={readOnly} query={calendars} />}

          {section === "reasons" && (
            <div className="grid gap-4">
              <StagedToggle
                id="att-reasons"
                label="Ask for a reason on empty past days"
                hint="When someone logs time for a past working day that has no entries at all, they pick a reason. No approval — it is an explanation."
                checked={values.missedDayReasonEnabled}
                disabled={disabled}
                changed={changed("missedDayReasonEnabled")}
                onChange={(v) => stage({ missedDayReasonEnabled: v })}
              />
              <MissedReasonsEditor readOnly={readOnly} query={reasons} />
            </div>
          )}

          {section === "leave-types" && <LeaveTypesSection readOnly={readOnly} />}
          {section === "leave-settings" && (
            <LeaveSettingsPanel query={leaveCfg} saved={savedLeave} values={leaveValues} readOnly={readOnly} enabledTypes={enabledTypes} onChange={stageLeave} />
          )}
          {section === "leave-balances" && <BalanceAdjustments readOnly={readOnly} />}

          {section === "sources" && (
            <AttendanceSourcesSection readOnly={readOnly} locked={!entitlements.attendanceIntegrationsEnabled} settings={saved} onSaveSettings={(p) => saveNow.mutate(p)} />
          )}

          {section === "analytics" && (
            <div className="grid gap-4">
              {!entitlements.attendanceAiInsightsEnabled && <PlanNote text="AI insights are part of the Enterprise plan." />}
              <StagedToggle
                id="att-ai-self"
                label="Insights for each person about themselves"
                hint="Their own patterns only."
                checked={values.aiInsightsSelf}
                disabled={disabled || !entitlements.attendanceAiInsightsEnabled}
                changed={changed("aiInsightsSelf")}
                onChange={(v) => stage({ aiInsightsSelf: v })}
              />
              <StagedToggle
                id="att-ai-manager"
                label="Insights for managers about their team"
                hint="Aggregates only — never raw location, face data or anyone's free-text notes."
                checked={values.aiInsightsManager}
                disabled={disabled || !entitlements.attendanceAiInsightsEnabled}
                changed={changed("aiInsightsManager")}
                onChange={(v) => stage({ aiInsightsManager: v })}
              />
              <StagedToggle
                id="att-ai-org"
                label="Organisation-wide insights for super admins"
                hint="Aggregates across the workspace."
                checked={values.aiInsightsOrg}
                disabled={disabled || !entitlements.attendanceAiInsightsEnabled}
                changed={changed("aiInsightsOrg")}
                onChange={(v) => stage({ aiInsightsOrg: v })}
              />
              <StagedNumber id="att-min-group" label="Smallest group an aggregate may describe" hint="Below this, an average is really one person. Minimum 3." value={values.minGroupSize} min={3} max={100} disabled={disabled} onChange={(v) => stage({ minGroupSize: v })} />
              <StagedSegment
                label="Refresh AI suggestions"
                hint="AI suggestions are reused for this long; rule-based suggestions are always current."
                value={values.aiInsightsFrequency}
                disabled={disabled || !entitlements.attendanceAiInsightsEnabled}
                onChange={(v) => stage({ aiInsightsFrequency: v })}
                options={[
                  { value: "DAILY", label: "Daily" },
                  { value: "WEEKLY", label: "Weekly" }
                ]}
              />
              <StagedToggle
                id="att-lateness"
                label="Measure punch-ins against an expected start time"
                hint="Off by default. Without it, analytics compare each person with their own usual time, never with a rule. It is informational: nobody is asked to explain."
                checked={values.latenessEnabled}
                disabled={disabled}
                changed={changed("latenessEnabled")}
                onChange={(v) => stage({ latenessEnabled: v })}
              >
                <StagedSelect id="att-expected-start" label="Expected start" hint="In each person's own timezone." value={String(values.expectedStartMinute)} options={EXPECTED_START_OPTIONS} disabled={disabled} onChange={(v) => stage({ expectedStartMinute: Number(v) })} />
              </StagedToggle>
            </div>
          )}

          {section === "privacy" && (
            <div className="grid gap-4">
              <div className="grid min-w-0 gap-1.5">
                <Label htmlFor="att-consent">Location consent text</Label>
                <Textarea
                  id="att-consent"
                  rows={4}
                  maxLength={2000}
                  disabled={disabled}
                  value={values.locationConsentText ?? ""}
                  placeholder="Shown the first time someone is asked for their location. Leave empty for the built-in wording."
                  onChange={(e) => stage({ locationConsentText: e.target.value.trim() === "" ? null : e.target.value })}
                />
                <p className="text-xs text-muted-foreground">Say what is kept, for how long and who can see it. People read this before their first punch with location.</p>
              </div>
              <StagedNumber id="att-retention" label="Keep raw location, IP and device for (days)" hint="After this the evidence is cleared; the punch time and source are kept." value={values.locationRetentionDays} min={1} max={3650} disabled={disabled} onChange={(v) => stage({ locationRetentionDays: v })} />
            </div>
          )}

          {!on && section !== "overview" && <p className="text-xs text-muted-foreground">Attendance is off, so nothing here affects anyone yet.</p>}
        </div>
      </div>

      {dirty > 0 && !readOnly && (
        <DirtyBar changes={[...changes, ...leaveChanges]} saving={saveAll.isPending} onDiscard={() => { setDraft({}); setLeaveDraft({}); }} onSave={() => runInBackground(requestSave())} />
      )}

      <ImpactDialog confirm={confirm} onCancel={() => setConfirm(null)} onConfirm={() => saveAll.mutate()} />
    </div>
  );
}

function LeaveSettingsPanel({ query, saved, values, readOnly, enabledTypes, onChange }: Readonly<{ query: { isLoading: boolean; isError: boolean; refetch: () => Promise<unknown>; data?: { leaveYearLockedMessage?: string | null } }; saved: LeaveSettings | undefined; values: LeaveSettings | null; readOnly: boolean; enabledTypes: number; onChange: (patch: Partial<LeaveSettings>) => void }>) {
  if (query.isLoading) return <Skeleton className="h-40 w-full" />;
  if (query.isError || !values || !saved) return <CardError message="Leave settings could not be loaded." onRetry={() => runInBackground(query.refetch())} />;
  return <LeaveSettingsFields saved={saved} values={values} readOnly={readOnly} enabledTypes={enabledTypes} yearLockedMessage={query.data?.leaveYearLockedMessage ?? null} onChange={onChange} />;
}

function DirtyBar({ changes, saving, onDiscard, onSave }: Readonly<{ changes: Array<{ label: string; from: string; to: string }>; saving: boolean; onDiscard: () => void; onSave: () => void }>) {
  const n = changes.length;
  const preview = changes.slice(0, 2).map((c) => c.label + ": " + c.from + " → " + c.to).join(" · ") + (n > 2 ? " · +" + (n - 2) + " more" : "");
  return (
    <div className="sticky bottom-[68px] z-30 flex flex-wrap items-center gap-3 rounded-lg border border-primary/40 bg-card p-3 pr-16 shadow-lg lg:bottom-4" role="region" aria-label="Unsaved changes">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold tabular-nums">{n} unsaved {n === 1 ? "change" : "changes"}</p>
        <p className="truncate text-xs text-muted-foreground">{preview}</p>
      </div>
      <Button variant="ghost" className="min-h-[44px]" disabled={saving} onClick={onDiscard}>Discard</Button>
      <Button className="min-h-[44px]" disabled={saving} onClick={onSave}>{saving ? "Saving…" : "Save"}</Button>
    </div>
  );
}

function ImpactDialog({ confirm, onCancel, onConfirm }: Readonly<{ confirm: { reasons: string[]; people: number | null } | null; onCancel: () => void; onConfirm: () => void }>) {
  const people = confirm?.people;
  let title = "This affects everyone";
  if (people != null) title = "This affects " + people + (people === 1 ? " person" : " people");
  return (
    <AlertDialog open={Boolean(confirm)} onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="grid gap-2">
              <ul className="list-disc pl-5">{confirm?.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
              <p>Save these changes?</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Go back</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Save changes</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Which nav sections hold unsaved values, so the nav can say where the work is. */
function dirtySections(changes: Array<{ key: string }>, leaveChanges: unknown[]): Set<string> {
  const map: Record<string, string> = {
    attendanceEnabled: "overview",
    punchInMode: "punch-in",
    locationMode: "punch-in",
    punchInFaceRequired: "punch-in",
    faceFailureRule: "punch-in",
    punchInReminderEnabled: "reminders",
    punchInReminderHour: "reminders",
    missedDayReasonEnabled: "reasons",
    aiInsightsSelf: "analytics",
    aiInsightsManager: "analytics",
    aiInsightsOrg: "analytics",
    minGroupSize: "analytics",
    aiInsightsFrequency: "analytics",
    latenessEnabled: "analytics",
    expectedStartMinute: "analytics",
    locationConsentText: "privacy",
    locationRetentionDays: "privacy"
  };
  const out = new Set(changes.map((c) => map[c.key]).filter(Boolean));
  if (leaveChanges.length > 0) out.add("leave-settings");
  return out;
}

function SectionNav({ sections, value, onChange, dirtySections: dirtySet }: Readonly<{ sections: NavSection[]; value: string; onChange: (id: string) => void; dirtySections: Set<string> }>) {
  const groups = ["Attendance", "Leave", "Workspace"] as const;
  return (
    <>
      <div className="lg:hidden">
        <Label htmlFor="att-section-select" className="sr-only">
          Settings section
        </Label>
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger id="att-section-select" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {sections.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.label}
                {dirtySet.has(s.id) ? " •" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <nav aria-label="Settings sections" className="hidden content-start gap-4 lg:grid">
        {groups.map((g) => {
          const items = sections.filter((s) => s.group === g);
          if (items.length === 0) return null;
          return (
            <div key={g} className="grid gap-0.5">
              <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{g}</p>
              {items.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  aria-current={value === s.id ? "page" : undefined}
                  onClick={() => onChange(s.id)}
                  className={cn(
                    "focus-ring flex min-h-[40px] items-center justify-between gap-2 rounded-md px-3 text-left text-sm transition-colors",
                    value === s.id ? "bg-primary/10 font-semibold text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  )}
                >
                  <span className="truncate">{s.label}</span>
                  {dirtySet.has(s.id) && <span className="h-2 w-2 shrink-0 rounded-full bg-primary" role="img" aria-label="Unsaved changes" />}
                </button>
              ))}
            </div>
          );
        })}
      </nav>
    </>
  );
}

function PresetPicker({ active, disabled, onPick }: Readonly<{ active: PresetId; disabled: boolean; onPick: (id: PresetId) => void }>) {
  return (
    <div className="grid gap-2">
      <Label>Start from a preset</Label>
      <p className="text-xs text-muted-foreground">A preset fills the values below. Nothing is saved until you press Save, and you can still change each one.</p>
      <div role="radiogroup" aria-label="Preset" className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={active === p.id}
            disabled={disabled}
            onClick={() => onPick(p.id)}
            className={cn(
              "focus-ring grid min-h-[44px] min-w-0 gap-0.5 rounded-lg border p-3 text-left transition-colors disabled:opacity-60",
              active === p.id ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border bg-card hover:bg-muted/50"
            )}
          >
            <span className="text-sm font-semibold">{p.label}</span>
            <span className="text-xs text-muted-foreground">{p.blurb}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Small fields
 * ------------------------------------------------------------------ */

/** 05:00 to 14:00 in half hours — the server accepts 300-840. */
const EXPECTED_START_OPTIONS: Array<[string, string]> = Array.from({ length: 19 }, (_, i) => {
  const minute = 300 + i * 30;
  return [String(minute), `${String(Math.floor(minute / 60)).padStart(2, "0")}:${minute % 60 === 0 ? "00" : "30"}`];
});

function PlanNote({ text }: { text: string }) {
  return (
    <p className="flex items-center gap-2 text-xs text-muted-foreground">
      <Lock className="h-3 w-3 shrink-0" />
      {text}
    </p>
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
