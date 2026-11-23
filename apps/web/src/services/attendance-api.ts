/**
 * Client for /api/attendance/admin (V17 A1) — workspace configuration of Attendance & Leave.
 * Its own file rather than another block in api.ts: the module grows a punch-in, ingest and
 * analytics client in later steps, and they belong together.
 */
import { api } from "./api";

export type PunchInMode = "OFF" | "OPTIONAL" | "MANDATORY";
export type AttendanceLocationMode = "OFF" | "OPTIONAL" | "REQUIRED";
export type AttendanceFaceFailureRule = "BLOCK" | "ALLOW_FLAGGED";

export interface AttendanceSettings {
  attendanceEnabled: boolean;
  punchInMode: PunchInMode;
  locationMode: AttendanceLocationMode;
  punchInFaceRequired: boolean;
  faceFailureRule: AttendanceFaceFailureRule;
  punchInReminderHour: number;
  punchInReminderEnabled: boolean;
  missedDayReasonEnabled: boolean;
  aiInsightsSelf: boolean;
  aiInsightsManager: boolean;
  aiInsightsOrg: boolean;
  minGroupSize: number;
  locationConsentText: string | null;
  locationRetentionDays: number;
}

export interface AttendanceEntitlements {
  attendanceEnabled: boolean;
  leaveManagementEnabled: boolean;
  attendanceIntegrationsEnabled: boolean;
  attendanceAiInsightsEnabled: boolean;
}

export interface AttendanceSettingsResponse {
  settings: AttendanceSettings;
  entitlements: AttendanceEntitlements;
  /** Workspace toggle AND plan entitlement, computed server-side. */
  effective: boolean;
}

export interface HolidayRow {
  id: string;
  calendarId: string;
  /** YYYY-MM-DD — a calendar day, never an instant. */
  date: string;
  name: string;
  isOptional: boolean;
}

export interface HolidayCalendarRow {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  holidays: HolidayRow[];
  _count: { users: number };
}

export interface MissedReasonOptionRow {
  id: string;
  code: string;
  label: string;
  enabled: boolean;
  order: number;
  requiresNote: boolean;
}

const BASE = "/attendance/admin";

export const attendanceAdminApi = {
  settings: {
    get: async () => (await api.get<AttendanceSettingsResponse>(`${BASE}/settings`)).data,
    update: async (payload: Partial<AttendanceSettings>) => (await api.put<AttendanceSettings>(`${BASE}/settings`, payload)).data
  },
  calendars: {
    list: async () => (await api.get<HolidayCalendarRow[]>(`${BASE}/calendars`)).data,
    create: async (payload: { name: string; description?: string | null; isDefault?: boolean }) =>
      (await api.post<HolidayCalendarRow>(`${BASE}/calendars`, payload)).data,
    update: async (id: string, payload: { name?: string; description?: string | null; isDefault?: boolean }) =>
      (await api.put<HolidayCalendarRow>(`${BASE}/calendars/${id}`, payload)).data,
    remove: async (id: string) => {
      await api.delete(`${BASE}/calendars/${id}`);
    }
  },
  holidays: {
    create: async (calendarId: string, payload: { date: string; name: string; isOptional?: boolean }) =>
      (await api.post<HolidayRow>(`${BASE}/calendars/${calendarId}/holidays`, payload)).data,
    update: async (calendarId: string, id: string, payload: { date?: string; name?: string; isOptional?: boolean }) =>
      (await api.put<HolidayRow>(`${BASE}/calendars/${calendarId}/holidays/${id}`, payload)).data,
    remove: async (calendarId: string, id: string) => {
      await api.delete(`${BASE}/calendars/${calendarId}/holidays/${id}`);
    }
  },
  reasons: {
    list: async () => (await api.get<MissedReasonOptionRow[]>(`${BASE}/missed-reasons`)).data,
    create: async (payload: { code: string; label: string; requiresNote?: boolean; order?: number }) =>
      (await api.post<MissedReasonOptionRow>(`${BASE}/missed-reasons`, payload)).data,
    update: async (id: string, payload: { label?: string; enabled?: boolean; order?: number; requiresNote?: boolean }) =>
      (await api.put<MissedReasonOptionRow>(`${BASE}/missed-reasons/${id}`, payload)).data,
    remove: async (id: string) => {
      await api.delete(`${BASE}/missed-reasons/${id}`);
    }
  }
};

/* ------------------------------------------------------------------ *
 * Employee routes (V17 A2) — /api/attendance/me/today and /punch-in. Any signed-in person.
 * ------------------------------------------------------------------ */

export type AttendanceDayStatus = "WEEKEND" | "HOLIDAY" | "LEAVE" | "PRESENT" | "ABSENT" | "PENDING";
export type PunchStep = "LOCATION" | "FACE";

export interface AttendancePunchRecord {
  id: string;
  workDate: string;
  punchInAt: string;
  source: "WEB" | "API" | "WEBHOOK" | "MCP" | "CSV";
  /** The integration's own name when it has one ("Front door biometric"), else the kind. */
  sourceLabel: string;
  flagged: boolean;
  faceVerified: boolean;
  hasLocation: boolean;
}

/** Only what the pop-up needs; admin configuration never reaches a non-admin. */
export interface MyToday {
  enabled: boolean;
  punchInMode?: PunchInMode;
  locationMode?: AttendanceLocationMode;
  faceRequired?: boolean;
  faceFailureRule?: AttendanceFaceFailureRule;
  consentText?: string;
  consentNeeded?: boolean;
  dateKey?: string;
  status?: AttendanceDayStatus;
  isWorkingDay?: boolean;
  holidayName?: string | null;
  record?: AttendancePunchRecord | null;
  steps?: PunchStep[];
}

export interface PunchInPayload {
  lat?: number | null;
  lng?: number | null;
  accuracyM?: number | null;
  consentAccepted?: boolean;
  verificationId?: string | null;
}

export const MY_TODAY_QUERY_KEY = ["attendance", "me", "today"] as const;

export const attendanceApi = {
  myToday: async () => (await api.get<MyToday>("/attendance/me/today")).data,
  punchIn: async (payload: PunchInPayload) =>
    (await api.post<{ created: boolean; record: AttendancePunchRecord }>("/attendance/punch-in", payload)).data
};
