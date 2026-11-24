/**
 * Client for /api/attendance/admin (V17 A1) — workspace configuration of Attendance & Leave.
 * Its own file rather than another block in api.ts: the module grows a punch-in, ingest and
 * analytics client in later steps, and they belong together.
 */
import { api } from "./api";
import type { MissedReasonOption } from "../lib/missed-day-reason";

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
  /** V17 A6: how long AI suggestions are reused. */
  aiInsightsFrequency: "DAILY" | "WEEKLY";
  /** Off by default: no on-time % unless an admin sets an expected start. */
  latenessEnabled: boolean;
  /** Minutes after local midnight, 300-840. */
  expectedStartMinute: number;
  locationConsentText: string | null;
  locationRetentionDays: number;
  /** A3 conflict priorities for punches without a source row. Higher wins; webhooks rank 1000+. */
  apiPriority: number;
  webPriority: number;
  mcpPriority: number;
  csvPriority: number;
  /** 7.0.0 regularisation: corrections to a past day's punch, decided by the manager. OFF by default. */
  regularizationEnabled: boolean;
  regularizationMaxDaysBack: number;
  regularizationMonthlyCap: number;
  /** 7.0.0 work sites: what a web punch-in outside every site does. */
  requireSite: "OFF" | "BLOCK" | "ALLOW_FLAGGED";
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
  /** 7.0.0: optional holidays one person may take per calendar year; null = no limit. */
  maxOptionalPerYear?: number | null;
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
    update: async (payload: Partial<AttendanceSettings>) => (await api.put<AttendanceSettings>(`${BASE}/settings`, payload)).data,
    /** How many people a workspace-wide change reaches. */
    impact: async () => (await api.get<{ people: number }>(`${BASE}/impact`)).data
  },
  calendars: {
    list: async () => (await api.get<HolidayCalendarRow[]>(`${BASE}/calendars`)).data,
    create: async (payload: { name: string; description?: string | null; isDefault?: boolean; maxOptionalPerYear?: number | null }) =>
      (await api.post<HolidayCalendarRow>(`${BASE}/calendars`, payload)).data,
    update: async (id: string, payload: { name?: string; description?: string | null; isDefault?: boolean; maxOptionalPerYear?: number | null }) =>
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
  punchOutAt: string | null;
  source: "WEB" | "API" | "WEBHOOK" | "MCP" | "CSV";
  /** The integration's own name when it has one ("Front door biometric"), else the kind. */
  sourceLabel: string;
  flagged: boolean;
  faceVerified: boolean;
  hasLocation: boolean;
  /** 7.0.0: "At <site>" / "Outside work sites"; null without sites or a location. */
  siteLabel?: string | null;
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
  /** Present only when the admin switched lateness on. */
  latenessEnabled?: boolean;
  expectedStartMinute?: number;
  /** 7.0.0: the person's shift for this work date; null = the workspace day. */
  shift?: { id: string; name: string; startMinute: number; endMinute: number; breakMinutes: number; workingDays: number[]; crossesMidnight: boolean; expectedMinutes: number } | null;
  record?: AttendancePunchRecord | null;
  steps?: PunchStep[];
  /** 7.0.0: corrections can be asked for, and how far back. Absent while they are off. */
  regularization?: { enabled: true; maxDaysBack: number };
}

export type RegularizationStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";

export interface RegularizationRow {
  id: string;
  user?: { id: string; name: string; email: string; avatarUrl: string | null };
  workDate: string;
  punchInAt: string;
  punchOutAt: string | null;
  originalPunchInAt: string | null;
  originalPunchOutAt: string | null;
  /** Only the requester and the people who may decide ever receive it. */
  reason: string | null;
  status: RegularizationStatus;
  decisionNote: string | null;
  decidedAt: string | null;
  createdAt: string;
  onBehalfOf?: string | null;
}

export const regularizationApi = {
  mine: async () => (await api.get<{ items: RegularizationRow[] }>("/attendance/regularizations/me")).data.items,
  request: async (body: { workDate: string; punchInAt: string; punchOutAt: string | null; reason: string }) =>
    (await api.post<RegularizationRow>("/attendance/regularizations", body)).data,
  cancel: async (id: string) => (await api.post<RegularizationRow>(`/attendance/regularizations/${id}/cancel`)).data,
  inbox: async () => (await api.get<{ total: number; items: RegularizationRow[] }>("/attendance/regularizations/inbox")).data,
  decide: async (id: string, decision: "APPROVE" | "REJECT", note?: string) =>
    (await api.post<RegularizationRow>(`/attendance/regularizations/${id}/decision`, note ? { decision, note } : { decision })).data
};

export interface PunchInPayload {
  lat?: number | null;
  lng?: number | null;
  accuracyM?: number | null;
  consentAccepted?: boolean;
  verificationId?: string | null;
}

export const MY_TODAY_QUERY_KEY = ["attendance", "me", "today"] as const;

/** 7.0.0: one person's day on the dashboard grid / Reports summary (GET /attendance/day-grid). */
export interface DayGridDay {
  status: "WEEKEND" | "HOLIDAY" | "LEAVE" | "PRESENT" | "ABSENT" | "PENDING";
  holidayName?: string;
  leaveTypeCode?: string;
  leaveTypeName?: string;
  halfDay?: "FIRST_HALF" | "SECOND_HALF";
}

export interface DayGridSummary {
  workingDays: number;
  holidays: number;
  leaveDays: Record<string, number>;
  presentDays: number;
  absentDays: number;
  loggedHours: number;
}

export type DayGridResponse =
  | { enabled: false }
  | {
      enabled: true;
      attendanceEnabled: boolean;
      leaveEnabled: boolean;
      from: string;
      to: string;
      leaveTypes: Array<{ code: string; name: string }>;
      people: Array<{ userId: string; name: string; days: Record<string, DayGridDay>; summary: DayGridSummary }>;
    };

export const attendanceApi = {
  /** 7.0.0: never 403s for "module off" — answers { enabled: false }. */
  dayGrid: async (from: string, to: string) => (await api.get<DayGridResponse>("/attendance/day-grid", { params: { from, to } })).data,
  myToday: async () => (await api.get<MyToday>("/attendance/me/today")).data,
  /** V17 A4: does logging the first entry on `date` need a "why was this day missed?" reason? */
  missedDayCheck: async (date: string) =>
    (await api.get<{ date: string; required: boolean; options: MissedReasonOption[] }>("/attendance/missed-reasons/check", { params: { date } })).data,
  punchIn: async (payload: PunchInPayload) =>
    (await api.post<{ created: boolean; record: AttendancePunchRecord }>("/attendance/punch-in", payload)).data,
  /** V17 UI v2: stamps today's web punch with the server clock; no body. */
  punchOut: async () => (await api.post<{ updated: boolean; record: AttendancePunchRecord }>("/attendance/punch-out")).data,
  myHolidays: async (from: string, to: string) => (await api.get<MyHolidays>("/attendance/me/holidays", { params: { from, to } })).data,
  /** 7.0.0: take an optional holiday (409 OPTIONAL_HOLIDAY_LIMIT at the calendar's yearly cap). */
  optInHoliday: async (holidayId: string) => (await api.put<{ holidayId: string; optedIn: boolean }>(`/attendance/me/optional-holidays/${holidayId}`)).data,
  optOutHoliday: async (holidayId: string) => (await api.delete<{ holidayId: string; optedIn: boolean }>(`/attendance/me/optional-holidays/${holidayId}`)).data
};

export interface MyHolidays {
  calendar: { id: string; name: string } | null;
  from: string;
  to: string;
  holidays: Array<{ id: string; date: string; name: string; isOptional: boolean; optedIn?: boolean }>;
  /** 7.0.0: the calendar's yearly cap on optional holidays (null = no limit) and how many this person took per year. */
  maxOptionalPerYear?: number | null;
  optionalTakenByYear?: Record<string, number>;
}

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

/* ------------------------------------------------------------------ *
 * Team Activity + my history (V17 A5) — /api/attendance/team, /me/history
 * ------------------------------------------------------------------ */

export type TeamDayStatus = "WEEKEND" | "HOLIDAY" | "LEAVE" | "PRESENT" | "ABSENT" | "PENDING";
export type PunchSourceKind = "WEB" | "API" | "WEBHOOK" | "MCP" | "CSV";

export interface TeamDayRow {
  user: { id: string; name: string; email: string; avatarUrl: string | null; title: string };
  status: TeamDayStatus;
  holidayName: string | null;
  /** Approved leave on the day: the type code and the portion taken. No reason, ever. */
  leave?: { type: string; half: "FULL" | "FIRST_HALF" | "SECOND_HALF" } | null;
  /** Never a coordinate: `location` is a coarse label decided server-side. */
  punch: {
    punchInAt: string;
    source: PunchSourceKind;
    sourceLabel: string;
    location: "Location shared" | "Network only" | "Not captured";
    face: "PASSED" | "FLAGGED" | "NONE";
  } | null;
  timesheet: { state: "SUBMITTED" | "DRAFT" | "NONE"; hours: number };
  missedReason: { code: string; note: string | null } | null;
  reminderSent: boolean;
}

export interface TeamDayResponse {
  date: string;
  summary: Record<TeamDayStatus, number>;
  /** Late over everyone in scope (server-side); null when lateness is off. */
  late?: number | null;
  total: number;
  page: number;
  pageSize: number;
  rows: TeamDayRow[];
}

export type TimelineKind =
  | "LOGIN"
  | "PUNCH_IN"
  | "TIMESHEET_CREATED"
  | "TIMESHEET_SUBMITTED"
  | "TIMESHEET_UPDATED"
  | "MISSED_REASON"
  | "REMINDER_EMAIL"
  | "LEAVE";

export interface TimelineEvent {
  kind: TimelineKind;
  at: string;
  label: string;
  detail: string | null;
}

export interface MyHistoryDay {
  date: string;
  status: TeamDayStatus;
  holidayName: string | null;
  punchInAt: string | null;
  punchOutAt: string | null;
  sourceLabel: string | null;
  face: "PASSED" | "FLAGGED" | "NONE" | null;
  /** 7.0.0: the matched work site, never a coordinate. */
  siteLabel?: string | null;
  isWorkingDay: boolean;
  /** Approved leave on the day: the type code and the portion taken. */
  leave: { type: string; half: "FULL" | "FIRST_HALF" | "SECOND_HALF" } | null;
  /** Timesheet hours logged that day, null when none. */
  hours: number | null;
  reasonCode: string | null;
}

export interface TeamDayParams {
  date?: string;
  search?: string;
  status?: TeamDayStatus;
  source?: PunchSourceKind;
  page?: number;
  pageSize?: number;
}

export const attendanceTeamApi = {
  teamDay: async (params: TeamDayParams) => (await api.get<TeamDayResponse>("/attendance/team/today", { params })).data,
  timeline: async (userId: string, from: string, to: string) =>
    (
      await api.get<{ user: { id: string; name: string; timezone: string | null }; events: TimelineEvent[] }>(
        `/attendance/team/${encodeURIComponent(userId)}/timeline`,
        { params: { from, to } }
      )
    ).data,
  myHistory: async (from: string, to: string) =>
    (await api.get<{ from: string; to: string; days: MyHistoryDay[] }>("/attendance/me/history", { params: { from, to } })).data
};

/* ----------------------------- Analytics (V17 A6) ----------------------------- */

export type AnalyticsAudience = "me" | "team" | "org";

export interface AnalyticsRangeOut {
  from: string;
  to: string;
  days: number;
  workingDays: number;
}

export interface SelfSummary {
  statusCounts: Record<TeamDayStatus, number>;
  presenceRate: number | null;
  onTimeRate: number | null;
  medianPunchMinute: number | null;
  driftMinutesPerWeek: number | null;
  punchTrend: Array<{ date: string; minute: number }>;
  hours: { logged: number; expected: number };
  missedReasons: Record<string, number>;
  sources: Partial<Record<PunchSourceKind, number>>;
  absencesByWeekday: number[];
  presentNoTimesheetDays: number;
  closedPresentDays: number;
}

export interface GroupSummary {
  people: number;
  suppressed: boolean;
  aggregates: {
    presenceRate: number | null;
    absenceRate: number | null;
    punchHistogram: Array<{ bucket: string; count: number }>;
    presentNoTimesheet: { days: number; rate: number | null };
    missedReasons: Record<string, number>;
    absencesByWeekday: number[];
  } | null;
}

export interface UpcomingHoliday {
  date: string;
  name: string;
}

export interface Lateness {
  enabled: boolean;
  expectedStartMinute: number;
}

export interface MyAnalytics {
  audience: "me";
  range: AnalyticsRangeOut;
  lateness: Lateness;
  summary: SelfSummary;
  upcomingHolidays: UpcomingHoliday[];
  leave?: LeaveAnalyticsOut | null;
}

export interface LeaveAnalyticsOut {
  audience: AnalyticsAudience;
  utilisation: Array<{ code: string; name: string; days: number; people: number }> | null;
  upcoming: { requests: number; people: number; entries: Array<{ name?: string; typeCode: string; startDate: string; endDate: string; status: string }> | null };
  coverage: Array<{ weekStart: string; peopleOff: number; teamSize: number; share: number; atRisk: boolean }> | null;
  expiring: Array<{ typeCode: string; days: number; yearEnd: string }> | null;
}

export interface AnalyticsPersonRow {
  userId: string;
  name: string;
  presenceRate: number | null;
  medianPunchMinute: number | null;
  driftMinutesPerWeek: number | null;
  drifting: boolean;
  absentDays: number;
}

export interface TeamAnalytics {
  audience: "team";
  range: AnalyticsRangeOut;
  minGroupSize: number;
  lateness: Lateness;
  group: GroupSummary;
  people: AnalyticsPersonRow[];
  upcomingHolidays: UpcomingHoliday[];
}

export interface SourceHealth {
  id: string;
  name: string;
  kind: PunchSourceKind;
  enabled: boolean;
  counts: Record<string, number>;
  lastEventAt: string | null;
  silentWorkingDays: number | null;
}

export interface OrgAnalytics {
  audience: "org";
  range: AnalyticsRangeOut;
  minGroupSize: number;
  lateness: Lateness;
  overall: GroupSummary;
  /** Daily presence across everyone; null while the group is below the k-anonymity floor. */
  trend: Array<{ date: string; presenceRate: number | null; absenceRate: number | null; present: number; absent: number }> | null;
  hours: { logged: number; expected: number } | null;
  byManager: Array<GroupSummary & { managerId: string | null; managerName: string }>;
  bySource: Array<{ source: PunchSourceKind; people: number; suppressed: boolean; punches: number | null }>;
  /** 7.0.0: punch-ins per work-site label ("Location label" in the breakdown). */
  bySite?: Array<{ label: string; people: number; suppressed: boolean; punches: number | null }>;
  face: { suppressed: boolean; checks: number | null; passRate: number | null; flagRate: number | null };
  loginHistogram: { suppressed: boolean; hours: number[] | null };
  integrations: SourceHealth[];
  holidays: { dates: number; personDays: number };
  upcomingHolidays: UpcomingHoliday[];
  leave?: LeaveAnalyticsOut | null;
}

export interface AttendanceInsight {
  id: string;
  title: string;
  detail: string;
  severity: "info" | "warn";
  source: "rule" | "ai";
}

export interface InsightsResponse {
  audience: AnalyticsAudience;
  aiStatus: "off" | "fresh" | "cached" | "unavailable";
  insights: AttendanceInsight[];
  /** How many cards this person already dismissed for this audience and range (7.0.0). */
  dismissedCount?: number;
}

const rangeParams = (from: string, to: string) => ({ params: { from, to } });

export const attendanceAnalyticsApi = {
  me: async (from: string, to: string) => (await api.get<MyAnalytics>("/attendance/analytics/me", rangeParams(from, to))).data,
  team: async (from: string, to: string) => (await api.get<TeamAnalytics>("/attendance/analytics/team", rangeParams(from, to))).data,
  org: async (from: string, to: string) => (await api.get<OrgAnalytics>("/attendance/analytics/org", rangeParams(from, to))).data,
  insights: async (audience: AnalyticsAudience, from: string, to: string) =>
    (await api.get<InsightsResponse>(`/attendance/analytics/${audience}/insights`, rangeParams(from, to))).data,
  dismissInsight: async (audience: AnalyticsAudience, insightId: string, from: string, to: string) => {
    await api.post(`/attendance/analytics/${audience}/insights/${encodeURIComponent(insightId)}/dismiss`, null, rangeParams(from, to));
  }
};
