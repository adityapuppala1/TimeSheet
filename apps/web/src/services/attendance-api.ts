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
  /** A3 conflict priorities for punches without a source row. Higher wins; webhooks rank 1000+. */
  apiPriority: number;
  webPriority: number;
  mcpPriority: number;
  csvPriority: number;
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

/* ------------------------------------------------------------------ *
 * Sources & integrations (V17 A3) — /api/attendance/admin/integrations
 * ------------------------------------------------------------------ */

export type AttendanceSourceKind = "WEBHOOK" | "API" | "CSV";
export type AttendanceMatchField = "EMAIL" | "EMPLOYEE_CODE" | "EXTERNAL_ID";
export type AttendanceEventStatus = "ACCEPTED" | "DUPLICATE" | "SUPERSEDED" | "UNMATCHED" | "REJECTED";

export interface AttendanceSourceRow {
  id: string;
  name: string;
  kind: AttendanceSourceKind;
  matchField: AttendanceMatchField;
  priority: number;
  enabled: boolean;
  lastEventAt: string | null;
  createdAt: string;
  hasSecret: boolean;
  /** Relative; prefix with the API origin. Null for non-webhook sources. */
  webhookPath: string | null;
}

export interface AttendanceEventRow {
  id: string;
  source: string;
  status: AttendanceEventStatus;
  reason: string | null;
  externalRef: string | null;
  identifier: string | null;
  workDate: string | null;
  punchInAt: string | null;
  punchOutAt: string | null;
  isTest: boolean;
  createdAt: string;
  rawPayload: unknown;
  sourceRef: { id: string; name: string } | null;
  person: { id: string; name: string; email: string } | null;
}

export interface CsvPreviewRow {
  line: number;
  identifier: string;
  date: string;
  punchIn: string;
  punchOut: string | null;
  errors: string[];
  person: { id: string; name: string } | null;
}

export interface CsvPreview {
  headerErrors: string[];
  total: number;
  valid: number;
  rows: CsvPreviewRow[];
}

export type CsvCommitSummary = { total: number; skipped: number } & Record<AttendanceEventStatus, number>;

const INT = "/attendance/admin/integrations";

export const attendanceIntegrationsApi = {
  listSources: async () => (await api.get<AttendanceSourceRow[]>(`${INT}/sources`)).data,
  createSource: async (payload: { name: string; kind: AttendanceSourceKind; matchField: AttendanceMatchField; priority?: number; enabled?: boolean }) =>
    (await api.post<AttendanceSourceRow & { secret: string | null }>(`${INT}/sources`, payload)).data,
  updateSource: async (id: string, payload: Partial<Pick<AttendanceSourceRow, "name" | "matchField" | "priority" | "enabled">>) =>
    (await api.patch<AttendanceSourceRow>(`${INT}/sources/${id}`, payload)).data,
  deleteSource: async (id: string) => api.delete(`${INT}/sources/${id}`),
  rotateSecret: async (id: string) => (await api.post<{ secret: string }>(`${INT}/sources/${id}/rotate-secret`)).data,
  sendTestEvent: async (id: string) => (await api.post<{ results: Array<{ status: string; eventId: string | null }> }>(`${INT}/sources/${id}/test`)).data,
  listEvents: async (params: { status?: AttendanceEventStatus; sourceId?: string; cursor?: string }) =>
    (await api.get<{ events: AttendanceEventRow[]; nextCursor: string | null }>(`${INT}/events`, { params })).data,
  replayEvent: async (id: string) => (await api.post<{ status: AttendanceEventStatus; reason: string | null }>(`${INT}/events/${id}/replay`)).data,
  previewCsv: async (payload: { csv: string; matchField: AttendanceMatchField; sourceId?: string | null }) =>
    (await api.post<CsvPreview>(`${INT}/import/preview`, payload)).data,
  commitCsv: async (payload: { csv: string; matchField: AttendanceMatchField; sourceId?: string | null }) =>
    (await api.post<CsvCommitSummary>(`${INT}/import/commit`, payload)).data
};
