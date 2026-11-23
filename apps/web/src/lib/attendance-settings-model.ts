/**
 * The Attendance & Leave settings tab's brains (V17 UI v2), as pure functions: the presets, the diff
 * between saved and staged values, the plain-language summary, and which staged changes touch the
 * whole workspace (and so need a confirm that names how many people). No React in here, so each rule
 * is unit-tested (tests/unit/attendance-settings-model.test.ts).
 */
import type { AttendanceSettings } from "../services/attendance-api";

export type PresetId = "OFFICE" | "HYBRID" | "REMOTE" | "CUSTOM";

/** The keys a preset may stage. It never touches the master switch, AI, privacy or priorities. */
export type PresetValues = Pick<
  AttendanceSettings,
  "punchInMode" | "locationMode" | "punchInFaceRequired" | "punchInReminderEnabled" | "punchInReminderHour" | "missedDayReasonEnabled" | "latenessEnabled"
>;

export const PRESETS: ReadonlyArray<{ id: PresetId; label: string; blurb: string; values: Partial<PresetValues> | null }> = [
  {
    id: "OFFICE",
    label: "Office",
    blurb: "Everyone punches in on arrival, location confirmed.",
    values: { punchInMode: "MANDATORY", locationMode: "OPTIONAL", punchInFaceRequired: false, punchInReminderEnabled: true, punchInReminderHour: 10, missedDayReasonEnabled: true }
  },
  {
    id: "HYBRID",
    label: "Hybrid",
    blurb: "A friendly prompt that can be dismissed; location optional.",
    values: { punchInMode: "OPTIONAL", locationMode: "OPTIONAL", punchInFaceRequired: false, punchInReminderEnabled: true, punchInReminderHour: 11, missedDayReasonEnabled: true }
  },
  {
    id: "REMOTE",
    label: "Remote / Field",
    blurb: "Optional punch-in, no location, no reminder nagging.",
    values: { punchInMode: "OPTIONAL", locationMode: "OFF", punchInFaceRequired: false, punchInReminderEnabled: false, missedDayReasonEnabled: false }
  },
  { id: "CUSTOM", label: "Custom", blurb: "Set each option yourself.", values: null }
];

export type SettingsDraft = Partial<AttendanceSettings>;

/** The values a preset would change from `current` (keys already equal are left out). */
export function stagePreset(current: AttendanceSettings, id: PresetId): SettingsDraft {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset?.values) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(preset.values)) {
    if ((current as unknown as Record<string, unknown>)[key] !== value) out[key] = value;
  }
  return out as SettingsDraft;
}

/** Which preset the effective values equal, or CUSTOM. */
export function matchPreset(values: AttendanceSettings): PresetId {
  for (const preset of PRESETS) {
    if (!preset.values) continue;
    if (Object.entries(preset.values).every(([k, v]) => (values as unknown as Record<string, unknown>)[k] === v)) return preset.id;
  }
  return "CUSTOM";
}

const PUNCH_LABEL = { OFF: "off", OPTIONAL: "optional", MANDATORY: "mandatory" } as const;
const LOCATION_LABEL = { OFF: "off", OPTIONAL: "optional", REQUIRED: "required" } as const;

export const FIELD_LABELS: Partial<Record<keyof AttendanceSettings, string>> = {
  attendanceEnabled: "Attendance",
  punchInMode: "Punch-in prompt",
  locationMode: "Location",
  punchInFaceRequired: "Face check",
  faceFailureRule: "When the face check fails",
  punchInReminderEnabled: "Reminder",
  punchInReminderHour: "Reminder time",
  missedDayReasonEnabled: "Missed-day reasons",
  aiInsightsSelf: "AI insights for each person",
  aiInsightsManager: "AI insights for managers",
  aiInsightsOrg: "AI insights for the organisation",
  minGroupSize: "Smallest group size",
  aiInsightsFrequency: "AI refresh",
  latenessEnabled: "Expected start time",
  expectedStartMinute: "Expected start",
  locationConsentText: "Location consent text",
  locationRetentionDays: "Evidence retention"
};

const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** A value as the person would say it ("mandatory", "11:00", "on"). */
export function valueText(key: keyof AttendanceSettings, value: unknown): string {
  if (typeof value === "boolean") return value ? "on" : "off";
  if (key === "punchInMode") return PUNCH_LABEL[value as keyof typeof PUNCH_LABEL] ?? String(value);
  if (key === "locationMode") return LOCATION_LABEL[value as keyof typeof LOCATION_LABEL] ?? String(value);
  if (key === "punchInReminderHour") return clock(Number(value) * 60);
  if (key === "expectedStartMinute") return clock(Number(value));
  if (key === "locationRetentionDays") return `${value} days`;
  if (key === "locationConsentText") return value ? "custom wording" : "built-in wording";
  if (key === "faceFailureRule") return value === "BLOCK" ? "block the punch" : "allow and flag";
  if (key === "aiInsightsFrequency") return String(value).toLowerCase();
  return String(value ?? "—");
}

export interface SettingChange {
  key: keyof AttendanceSettings;
  label: string;
  from: string;
  to: string;
}

/** Staged values that actually differ from what is saved, in a stable order, with readable text. */
export function diffSettings(saved: AttendanceSettings, draft: SettingsDraft): SettingChange[] {
  const out: SettingChange[] = [];
  for (const key of Object.keys(draft) as Array<keyof AttendanceSettings>) {
    if (draft[key] === undefined || draft[key] === saved[key]) continue;
    out.push({ key, label: FIELD_LABELS[key] ?? String(key), from: valueText(key, saved[key]), to: valueText(key, draft[key]) });
  }
  return out;
}

/** The draft without the keys that were edited back to the saved value. */
export function cleanDraft(saved: AttendanceSettings, draft: SettingsDraft): SettingsDraft {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(draft)) if (v !== (saved as unknown as Record<string, unknown>)[k]) out[k] = v;
  return out as SettingsDraft;
}

/** The payload for PUT /settings: just the changed keys. */
export function changesPayload(saved: AttendanceSettings, draft: SettingsDraft): SettingsDraft {
  return cleanDraft(saved, draft);
}

/** Changes that reach everyone in the workspace, in words, for the confirm dialog. */
export function impactReasons(saved: AttendanceSettings, draft: SettingsDraft): string[] {
  const next = { ...saved, ...draft };
  const out: string[] = [];
  if (!saved.attendanceEnabled && next.attendanceEnabled) out.push("Switching attendance on starts the module for everyone.");
  if (saved.attendanceEnabled && !next.attendanceEnabled) out.push("Switching attendance off hides it for everyone.");
  if (saved.punchInMode !== "MANDATORY" && next.punchInMode === "MANDATORY") out.push("Mandatory punch-in blocks the app until each person punches in.");
  if (saved.locationMode !== "REQUIRED" && next.locationMode === "REQUIRED") out.push("Required location means a punch-in without location access is refused.");
  if (!saved.punchInFaceRequired && next.punchInFaceRequired) out.push("A face check is added to every punch-in.");
  if (!saved.punchInReminderEnabled && next.punchInReminderEnabled) out.push("People who have not punched in start getting a reminder email.");
  return out;
}

function locationClause(mode: AttendanceSettings["locationMode"]): string {
  if (mode === "OFF") return "";
  return mode === "REQUIRED" ? " and must confirm their work location" : " and can confirm their work location";
}

/** The sentence(s) under the preset row: what the current values mean for a person on a normal morning. */
export function settingsSummary(s: AttendanceSettings): string {
  if (!s.attendanceEnabled) return "Attendance is off. Nobody sees a punch-in prompt and nothing is recorded.";
  const parts: string[] = [];
  if (s.punchInMode === "OFF") parts.push("The web punch-in is off; attendance only comes from connected sources.");
  else {
    const must = s.punchInMode === "MANDATORY";
    const loc = locationClause(s.locationMode);
    parts.push(`Employees ${must ? "must" : "are asked to"} punch in when they open TimeSphere${loc}.`);
    parts.push(s.punchInFaceRequired ? "A face check is part of punching in." : "Face check is off.");
  }
  parts.push(s.punchInReminderEnabled ? `Reminder at ${clock(s.punchInReminderHour * 60)}.` : "No reminder email.");
  if (s.latenessEnabled) parts.push(`Punch-ins after ${clock(s.expectedStartMinute)} count as late.`);
  if (s.missedDayReasonEnabled) parts.push("Past days with no time ask for a reason.");
  return parts.join(" ");
}

/** Section ids for the left nav; leave sections are listed only when the plan includes leave. */
export interface NavSection {
  id: string;
  label: string;
  group: "Attendance" | "Leave" | "Workspace";
}

export function settingsSections(leaveEntitled: boolean): NavSection[] {
  const base: NavSection[] = [
    { id: "overview", label: "Overview", group: "Attendance" },
    { id: "punch-in", label: "Punch-in", group: "Attendance" },
    { id: "reminders", label: "Reminders", group: "Attendance" },
    { id: "holidays", label: "Working days & holidays", group: "Attendance" },
    { id: "reasons", label: "Missed-day reasons", group: "Attendance" }
  ];
  const leave: NavSection[] = [
    { id: "leave-types", label: "Leave types", group: "Leave" },
    { id: "leave-settings", label: "Leave settings", group: "Leave" },
    { id: "leave-balances", label: "Balance adjustments", group: "Leave" }
  ];
  const rest: NavSection[] = [
    { id: "sources", label: "Sources & integrations", group: "Workspace" },
    { id: "analytics", label: "Analytics & AI", group: "Workspace" },
    { id: "privacy", label: "Privacy & retention", group: "Workspace" }
  ];
  return [...base, ...(leaveEntitled ? leave : []), ...rest];
}

export interface LeaveSettingsShape {
  leaveEnabled: boolean;
  leaveYearStartMonth: number;
  trustExternalApprovals: boolean;
  leaveApprovalFallback: "ADMINS" | "SUPER_ADMINS";
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export interface LeaveSettingChange {
  key: keyof LeaveSettingsShape;
  label: string;
  from: string;
  to: string;
}

/** Staged leave-setting changes, as readable lines (the leave settings live behind their own endpoint). */
export function diffLeaveSettings(saved: LeaveSettingsShape, draft: Partial<LeaveSettingsShape>): LeaveSettingChange[] {
  const labels: Record<keyof LeaveSettingsShape, string> = {
    leaveEnabled: "Leave",
    leaveYearStartMonth: "Leave year starts",
    trustExternalApprovals: "Trust external approvals",
    leaveApprovalFallback: "When there is no manager"
  };
  const text = (k: keyof LeaveSettingsShape, v: unknown) => {
    if (typeof v === "boolean") return v ? "on" : "off";
    if (k === "leaveYearStartMonth") return MONTHS[Number(v) - 1] ?? String(v);
    return v === "ADMINS" ? "any admin decides" : "super admins decide";
  };
  const out: LeaveSettingChange[] = [];
  for (const key of Object.keys(draft) as Array<keyof LeaveSettingsShape>) {
    if (draft[key] === undefined || draft[key] === saved[key]) continue;
    out.push({ key, label: labels[key], from: text(key, saved[key]), to: text(key, draft[key]) });
  }
  return out;
}
