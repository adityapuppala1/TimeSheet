import axios, { type AxiosRequestConfig } from "axios";
import type {
  AuthUser,
  EmailIntakeSettings,
  EmailMatchType,
  EmailRoutingRuleRow,
  GlobalAISettings,
  GlobalSettings,
  GlobalTicketSettings,
  ModuleAssigneeRuleRow,
  TicketPriority,
  TicketStatus,
  TicketType
} from "@timesheet/shared";

/**
 * Defaults to a relative `/api` path. In dev, Vite proxies `/api` and `/uploads`
 * to the API server — so the SPA stays same-origin no matter which IP it's
 * accessed at (localhost, LAN IP, phone, etc.). No CORS preflight required.
 *
 * In production, deploy the SPA and API behind the same reverse proxy.
 * To override (e.g. point a hosted SPA at a separately-deployed API), set
 * `VITE_API_URL=https://api.example.com/api` at build time.
 */
const API_BASE_URL = import.meta.env.VITE_API_URL ?? "/api";

/** Empty when API_BASE_URL is relative — file paths resolve against current origin. */
export const SERVER_ORIGIN = API_BASE_URL.startsWith("http")
  ? API_BASE_URL.replace(/\/api\/?$/, "")
  : "";

export function fileUrl(path?: string | null): string | undefined {
  if (!path) return undefined;
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  return `${SERVER_ORIGIN}${path.startsWith("/") ? "" : "/"}${path}`;
}

export const api = axios.create({ baseURL: API_BASE_URL });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("accessToken");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

let refreshPromise: Promise<string> | null = null;

async function refreshAccessToken(): Promise<string> {
  const refreshToken = localStorage.getItem("refreshToken");
  if (!refreshToken) throw new Error("no refresh token");
  const response = await axios.post<{ accessToken: string }>(`${api.defaults.baseURL}/auth/refresh`, { refreshToken });
  localStorage.setItem("accessToken", response.data.accessToken);
  return response.data.accessToken;
}

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config as (AxiosRequestConfig & { _retry?: boolean }) | undefined;
    const url = original?.url ?? "";
    if (
      error.response?.status !== 401 ||
      !original ||
      original._retry ||
      url.includes("/auth/login") ||
      url.includes("/auth/refresh")
    ) {
      throw error;
    }
    original._retry = true;
    try {
      refreshPromise ??= refreshAccessToken().finally(() => {
        refreshPromise = null;
      });
      const token = await refreshPromise;
      original.headers = { ...original.headers, Authorization: `Bearer ${token}` };
      return api.request(original);
    } catch (refreshError) {
      localStorage.removeItem("accessToken");
      localStorage.removeItem("refreshToken");
      throw refreshError;
    }
  }
);

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

export const authApi = {
  login: async (email: string, password: string, rememberMe: boolean) =>
    (await api.post<LoginResponse>("/auth/login", { email, password, rememberMe })).data,
  me: async () => (await api.get<AuthUser>("/auth/me")).data,
  logout: async () => api.post("/auth/logout"),
  forgotPassword: async (email: string) => (await api.post("/auth/forgot-password", { email })).data,
  changePassword: async (currentPassword: string, nextPassword: string) =>
    api.post("/auth/change-password", { currentPassword, nextPassword }),
  updateProfile: async (
    payload: { name?: string; bio?: string | null; phoneNumber?: string | null; timezone?: string | null }
  ) => (await api.patch<AuthUser>("/auth/profile", payload)).data,
  uploadAvatar: async (file: File) => {
    const form = new FormData();
    form.append("avatar", file);
    return (
      await api.post<AuthUser>("/auth/avatar", form, { headers: { "Content-Type": "multipart/form-data" } })
    ).data;
  },
  removeAvatar: async () => (await api.delete<AuthUser>("/auth/avatar")).data
};

export const notificationApi = {
  list: async () => (await api.get<{ items: Notification[]; unread: number }>("/notifications")).data,
  read: async (id: string) => api.post(`/notifications/${id}/read`),
  readAll: async () => api.post("/notifications/read-all")
};

export interface Notification {
  id: string;
  title: string;
  body: string;
  category?: string | null;
  link?: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface AuditEntry {
  id: string;
  action: string;
  entity: string;
  entityId: string | null;
  createdAt: string;
  actor?: { id: string; name: string; email: string } | null;
  metadata?: unknown;
}

export const auditApi = {
  list: async (params?: { action?: string; entity?: string; actorId?: string; take?: number }) =>
    (await api.get<AuditEntry[]>("/audit", { params })).data
};

export interface ProjectAssignmentMember {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  status: string;
  role: { name: string };
}

export interface ProjectAssignment {
  userId: string;
  projectId: string;
  createdAt: string;
  user: ProjectAssignmentMember;
}

export const projectApi = {
  list: async () => (await api.get("/projects")).data,
  create: async (payload: unknown) => (await api.post("/projects", payload)).data,
  update: async (id: string, payload: unknown) => (await api.patch(`/projects/${id}`, payload)).data,
  remove: async (id: string) => api.delete(`/projects/${id}`),
  createModule: async (projectId: string, name: string) => (await api.post(`/projects/${projectId}/modules`, { name })).data,
  createSubmodule: async (moduleId: string, name: string) =>
    (await api.post(`/projects/modules/${moduleId}/submodules`, { name })).data,
  assignments: async (projectId: string) =>
    (await api.get<ProjectAssignment[]>(`/projects/${projectId}/assignments`)).data,
  assign: async (projectId: string, userId: string) =>
    (await api.post(`/projects/${projectId}/assignments`, { userId })).data,
  unassign: async (projectId: string, userId: string) =>
    api.delete(`/projects/${projectId}/assignments/${userId}`)
};

export const timesheetApi = {
  list: async () => (await api.get("/timesheets")).data,
  submit: async (payload: unknown, draft = false) => (await api.post(`/timesheets/${draft ? "draft" : "submit"}`, payload)).data,
  submitForm: async (payload: FormData, draft = false) =>
    (
      await api.post(`/timesheets/${draft ? "draft-with-files" : "submit-with-files"}`, payload, {
        headers: { "Content-Type": "multipart/form-data" }
      })
    ).data,
  approve: async (id: string) => (await api.patch(`/timesheets/${id}/approve`)).data,
  reject: async (id: string, reason: string) => (await api.patch(`/timesheets/${id}/reject`, { reason })).data
};

export interface DailyStatus {
  date: string;
  entries: number;
  hours: number;
  reminderReceived: boolean;
  escalated: boolean;
}

export interface TicketSummary {
  total: number;
  byStatus: Array<{ status: TicketStatus; _count: number }>;
  byPriority: Array<{ priority: TicketPriority; _count: number }>;
  byAssignee: Array<{ assigneeId: string; assignee: string; _count: number }>;
  openSlaBreaches: number;
  createdThisWeek: number;
  resolvedThisWeek: number;
  avgResolutionHours: number;
}

export interface TicketInsights {
  velocity: Array<{ weekStart: string; created: number; resolved: number }>;
  slaCompliance: Array<{ weekStart: string; compliant: number; breached: number; pct: number | null }>;
  cycleTimeHistogram: Array<{ bucket: string; count: number }>;
  hotspotByModule: Array<{ moduleId: string; moduleName: string; projectName: string; count: number }>;
  reopenRate: { reopenedCount: number; everResolvedCount: number; pct: number | null };
  firstResponseHours: { avgHours: number | null; sampleSize: number };
  workloadHeatmap: {
    weeks: string[];
    rows: Array<{
      assigneeId: string;
      assigneeName: string;
      cells: Array<{ weekStart: string; openCount: number; hoursLogged: number }>;
      totalOpen: number;
    }>;
  };
  estimateVsActual: Array<{ ticketKey: string; title: string; estimatedHours: number; actualHours: number; varianceHours: number }>;
}

export interface CostInsights {
  totalCostUsd: number;
  avgCostPerTicket: number;
  rows: Array<{ ticketKey: string; title: string; hours: number; costUsd: number }>;
}

export interface LeaderboardRow {
  assigneeId: string;
  assigneeName: string;
  resolvedCount: number;
  avgCycleHours: number;
}

export const reportApi = {
  admin: async () => (await api.get("/reports/admin-summary")).data,
  employee: async () => (await api.get("/reports/employee-summary")).data,
  dailyStatus: async () => (await api.get<DailyStatus>("/reports/daily-status")).data,
  tickets: async () => (await api.get<TicketSummary>("/reports/ticket-summary")).data,
  ticketInsights: async () => (await api.get<TicketInsights>("/reports/ticket-insights")).data,
  costInsights: async () => (await api.get<CostInsights>("/reports/cost-insights")).data,
  leaderboard: async () => (await api.get<{ rows: LeaderboardRow[] }>("/reports/leaderboard")).data,
  download: async (type: "csv" | "pdf") => (await api.get(`/reports/export.${type}`, { responseType: "blob" })).data
};

export interface UserRow {
  id: string;
  name: string;
  email: string;
  status: "ACTIVE" | "INACTIVE" | "PENDING_VERIFICATION";
  avatarUrl: string | null;
  bio: string | null;
  managerId: string | null;
  manager?: { id: string; name: string; email: string } | null;
  role: { name: string };
}

export interface CreatedUser extends UserRow {
  welcomeEmail?: {
    sent: boolean;
    status: "SENT" | "FAILED" | "SKIPPED";
    errorMessage: string | null;
    emailLogId: string | null;
  };
}

export const userApi = {
  list: async () => (await api.get<UserRow[]>("/users")).data,
  roles: async () => (await api.get("/users/roles")).data,
  create: async (payload: unknown) => (await api.post<CreatedUser>("/users", payload)).data,
  update: async (id: string, payload: unknown) => (await api.patch(`/users/${id}`, payload)).data,
  remove: async (id: string) => api.delete(`/users/${id}`),
  resetPassword: async (id: string, password: string) =>
    (await api.post(`/users/${id}/reset-password`, { password })).data,
  resendWelcome: async (id: string) =>
    (await api.post<{ sent: boolean; to: string; emailLogId: string | null }>(`/users/${id}/resend-welcome`)).data
};

export interface TeamReport {
  id: string;
  name: string;
  email: string;
  status: string;
  avatarUrl: string | null;
  bio: string | null;
  role: string;
  stats: { total: number; pending: number; approved: number; rejected: number; slaBreached: number; approvedHours: number };
}

export const teamApi = {
  reports: async () => (await api.get<TeamReport[]>("/team/reports")).data,
  escalations: async () => (await api.get("/team/escalations")).data,
  slaSummary: async () =>
    (await api.get<{ submitted: number; breached: number; approvedThisWeek: number; openEscalations: number }>("/team/sla-summary")).data
};

export interface AIUsageSummary {
  monthStart: string;
  totalCostUsd: number;
  totalCalls: number;
  byFeature: Array<{ feature: string; costUsd: number; calls: number }>;
}

export const settingsApi = {
  getNotifications: async () => (await api.get<GlobalSettings>("/settings/notifications")).data,
  updateNotifications: async (payload: Partial<GlobalSettings>) =>
    (await api.patch<GlobalSettings>("/settings/notifications", payload)).data,
  getTicketing: async () => (await api.get<GlobalTicketSettings>("/settings/ticketing")).data,
  updateTicketing: async (payload: Partial<GlobalTicketSettings>) =>
    (await api.patch<GlobalTicketSettings>("/settings/ticketing", payload)).data,
  getAI: async () => (await api.get<GlobalAISettings>("/settings/ai")).data,
  updateAI: async (payload: Partial<GlobalAISettings>) => (await api.patch<GlobalAISettings>("/settings/ai", payload)).data,
  getAIUsageSummary: async () => (await api.get<AIUsageSummary>("/settings/ai/usage-summary")).data
};

export interface EmailTemplateRow {
  key: string;
  description: string;
  variables: string[];
  hasOverride: boolean;
  enabled: boolean;
  subject: string | null;
  bodyHtml: string | null;
  updatedAt: string | null;
}

export interface EmailLogRow {
  id: string;
  to: string;
  subject: string;
  template: string;
  status: "QUEUED" | "SENT" | "FAILED";
  errorMessage: string | null;
  metadata: { messageId?: string; response?: string; bcc?: string[] } | null;
  createdAt: string;
}

export interface MailTransportStatus {
  configured: boolean;
  host: string | null;
  port: number | null;
  secure: boolean | null;
  user: string | null;
  from: string;
  fromAddress: string | null;
  fromDomain: string | null;
  userDomain: string | null;
  fromIssues: string[];
  verified: boolean | null;
  verifyError: string | null;
}

export interface BulkTestResult {
  recipient: string;
  sent: number;
  failed: number;
  total: number;
  results: Array<{ key: string; ok: boolean; status: string; errorMessage?: string; emailLogId?: string }>;
}

export const emailTemplateApi = {
  list: async () => (await api.get<EmailTemplateRow[]>("/email-templates")).data,
  transportStatus: async () => (await api.get<MailTransportStatus>("/email-templates/transport-status")).data,
  log: async (key: string) => (await api.get<EmailLogRow[]>(`/email-templates/${encodeURIComponent(key)}/log`)).data,
  save: async (key: string, payload: { subject: string; bodyHtml: string; enabled?: boolean }) =>
    (await api.put(`/email-templates/${encodeURIComponent(key)}`, payload)).data,
  revert: async (key: string) => api.delete(`/email-templates/${encodeURIComponent(key)}`),
  test: async (key: string, to?: string) =>
    (await api.post(`/email-templates/${encodeURIComponent(key)}/test`, { to })).data,
  testAll: async (to?: string) => (await api.post<BulkTestResult>("/email-templates/test-all", { to })).data
};

/* ============================== TICKETS ============================== */

export interface TicketUserSummary {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
}

export interface LabelRow {
  id: string;
  name: string;
  color: string | null;
}

export interface TicketLabelRow {
  id: string;
  labelId: string;
  label: LabelRow;
}

export interface TicketTypeRow {
  id: string;
  name: string;
  color: string | null;
  isActive: boolean;
}

export type TicketSourceValue = "MANUAL" | "EMAIL" | "API";
export type AiFeedbackValue = "up" | "down" | null;

export interface TicketRow {
  id: string;
  key: string;
  type: TicketType;
  title: string;
  priority: TicketPriority;
  status: TicketStatus;
  source: TicketSourceValue;
  needsReview: boolean;
  aiConfidence: number | null;
  aiFeedback: AiFeedbackValue;
  externalReporterEmail: string | null;
  externalReporterName: string | null;
  dueAt: string | null;
  slaBreachAt: string | null;
  createdAt: string;
  project: { id: string; code: string; name: string };
  module: { id: string; name: string } | null;
  reporter: TicketUserSummary;
  assignee: TicketUserSummary | null;
  labels: TicketLabelRow[];
  _count: { comments: number; attachments: number };
}

export interface TicketComment {
  id: string;
  body: string;
  createdAt: string;
  author: TicketUserSummary;
}

export interface TicketAttachmentRow {
  id: string;
  fileName: string;
  mimeType: string;
  url: string;
  sizeBytes: number;
  createdAt: string;
  uploadedBy: { id: string; name: string } | null;
}

export interface TicketWatcherRow {
  id: string;
  userId: string;
  user: TicketUserSummary;
}

export interface TicketTimesheetRow {
  id: string;
  workDate: string;
  totalHours: string | number;
  user: { id: string; name: string };
}

export type TicketLinkType = "BLOCKS" | "DUPLICATE" | "RELATES";

export interface TicketLinkRow {
  id: string;
  type: TicketLinkType;
  label: string;
  ticket: { id: string; key: string; title: string; status: TicketStatus; priority: TicketPriority };
}

export interface TicketChecklistItemRow {
  id: string;
  label: string;
  done: boolean;
  position: number;
}

export interface TicketDetail extends TicketRow {
  description: string | null;
  watchers: TicketWatcherRow[];
  comments: TicketComment[];
  attachments: TicketAttachmentRow[];
  timesheets: TicketTimesheetRow[];
  links: TicketLinkRow[];
  checklistItems: TicketChecklistItemRow[];
}

export const ticketApi = {
  list: async (params?: {
    status?: string;
    priority?: string;
    type?: string;
    projectId?: string;
    assigneeId?: string;
    source?: TicketSourceValue;
    labelId?: string;
    aiOnly?: boolean;
  }) => (await api.get<TicketRow[]>("/tickets", { params })).data,
  get: async (id: string) => (await api.get<TicketDetail>(`/tickets/${id}`)).data,
  create: async (payload: unknown) => (await api.post<TicketDetail>("/tickets", payload)).data,
  update: async (id: string, payload: unknown) => (await api.patch<TicketDetail>(`/tickets/${id}`, payload)).data,
  updateStatus: async (id: string, status: TicketStatus) =>
    (await api.patch<TicketDetail>(`/tickets/${id}/status`, { status })).data,
  assign: async (id: string, assigneeId: string | null) =>
    (await api.patch<TicketDetail>(`/tickets/${id}/assign`, { assigneeId })).data,
  setAiFeedback: async (id: string, feedback: AiFeedbackValue) =>
    (await api.patch<{ id: string; aiFeedback: AiFeedbackValue }>(`/tickets/${id}/ai-feedback`, { feedback })).data,
  remove: async (id: string) => api.delete(`/tickets/${id}`),
  activity: async (id: string) => (await api.get<AuditEntry[]>(`/tickets/${id}/activity`)).data,
  comments: {
    list: async (id: string) => (await api.get<TicketComment[]>(`/tickets/${id}/comments`)).data,
    add: async (id: string, body: string) => (await api.post<TicketComment>(`/tickets/${id}/comments`, { body })).data
  },
  attachments: {
    upload: async (id: string, files: File[]) => {
      const form = new FormData();
      files.forEach((file) => form.append("attachments", file));
      return (
        await api.post<TicketAttachmentRow[]>(`/tickets/${id}/attachments`, form, {
          headers: { "Content-Type": "multipart/form-data" }
        })
      ).data;
    },
    remove: async (id: string, attachmentId: string) => api.delete(`/tickets/${id}/attachments/${attachmentId}`)
  },
  watchers: {
    add: async (id: string, userId?: string) => (await api.post(`/tickets/${id}/watchers`, userId ? { userId } : {})).data,
    remove: async (id: string, userId: string) => api.delete(`/tickets/${id}/watchers/${userId}`)
  },
  labels: {
    add: async (id: string, labelId: string) => (await api.post<TicketLabelRow>(`/tickets/${id}/labels`, { labelId })).data,
    remove: async (id: string, labelId: string) => api.delete(`/tickets/${id}/labels/${labelId}`)
  },
  links: {
    add: async (id: string, targetKey: string, type: TicketLinkType) =>
      (await api.post<TicketLinkRow>(`/tickets/${id}/links`, { targetKey, type })).data,
    remove: async (id: string, linkId: string) => api.delete(`/tickets/${id}/links/${linkId}`)
  },
  checklist: {
    add: async (id: string, label: string) => (await api.post<TicketChecklistItemRow>(`/tickets/${id}/checklist`, { label })).data,
    update: async (id: string, itemId: string, payload: { label?: string; done?: boolean }) =>
      (await api.patch<TicketChecklistItemRow>(`/tickets/${id}/checklist/${itemId}`, payload)).data,
    remove: async (id: string, itemId: string) => api.delete(`/tickets/${id}/checklist/${itemId}`),
    reorder: async (id: string, itemIds: string[]) =>
      (await api.patch<TicketChecklistItemRow[]>(`/tickets/${id}/checklist-reorder`, { itemIds })).data
  }
};

export const ticketTypeApi = {
  list: async (all = false) => (await api.get<TicketTypeRow[]>("/ticket-types", { params: all ? { all: "true" } : undefined })).data,
  create: async (payload: { name: string; color?: string }) => (await api.post<TicketTypeRow>("/ticket-types", payload)).data,
  update: async (id: string, payload: { name?: string; color?: string | null; isActive?: boolean }) =>
    (await api.patch<TicketTypeRow>(`/ticket-types/${id}`, payload)).data
};

/** Admin-only: mailbox connection, routing rules, and module-assignee rules for email-to-ticket intake. */
export const emailIntakeApi = {
  getSettings: async () => (await api.get<EmailIntakeSettings>("/email-intake/settings")).data,
  updateSettings: async (payload: {
    imapHost?: string | null;
    imapPort?: number;
    imapSecure?: boolean;
    imapUser?: string | null;
    imapPassword?: string;
    pollIntervalMinutes?: number;
    fallbackProjectId?: string | null;
  }) => (await api.patch<EmailIntakeSettings>("/email-intake/settings", payload)).data,
  testConnection: async (payload?: { host?: string; port?: number; secure?: boolean; user?: string; password?: string }) =>
    (await api.post<{ ok: boolean; error?: string }>("/email-intake/settings/test-connection", payload ?? {})).data,

  routingRules: {
    list: async () => (await api.get<EmailRoutingRuleRow[]>("/email-intake/routing-rules")).data,
    create: async (payload: { matchType: EmailMatchType; matchValue: string; projectId: string; defaultModuleId?: string }) =>
      (await api.post<EmailRoutingRuleRow>("/email-intake/routing-rules", payload)).data,
    update: async (id: string, payload: Partial<{ matchType: EmailMatchType; matchValue: string; projectId: string; defaultModuleId: string | null; isActive: boolean }>) =>
      (await api.patch<EmailRoutingRuleRow>(`/email-intake/routing-rules/${id}`, payload)).data,
    remove: async (id: string) => api.delete(`/email-intake/routing-rules/${id}`)
  },

  assigneeRules: {
    list: async () => (await api.get<ModuleAssigneeRuleRow[]>("/email-intake/assignee-rules")).data,
    save: async (payload: { moduleId: string; defaultAssigneeId: string }) =>
      (await api.post<ModuleAssigneeRuleRow>("/email-intake/assignee-rules", payload)).data,
    remove: async (id: string) => api.delete(`/email-intake/assignee-rules/${id}`)
  }
};

export interface AITriageSuggestion {
  type: string;
  priority: TicketPriority;
  moduleId: string | null;
  confidence: number;
  reasoning: string;
}

export interface AIDuplicateMatch {
  ticketId: string;
  key: string;
  likelihood: number;
  reasoning: string;
}

/** On-demand AI capabilities (auto-triage, duplicate check, writing assistant, comment summary, workspace Q&A) — see apps/api/src/services/ai.service.ts for the gating/budget logic each of these goes through server-side. */
export const aiApi = {
  suggestTriage: async (payload: { projectId: string; title: string; description?: string }) =>
    (await api.post<AITriageSuggestion>("/ai/tickets/suggest-triage", payload)).data,
  findDuplicates: async (payload: { projectId: string; title: string; description?: string; excludeTicketId?: string }) =>
    (await api.post<{ matches: AIDuplicateMatch[] }>("/ai/tickets/duplicates", payload)).data,
  improveText: async (payload: { text: string; context?: "ticket_description" | "comment" }) =>
    (await api.post<{ improved: string }>("/ai/text/improve", payload)).data,
  summarizeTicket: async (id: string) => (await api.post<{ summary: string }>(`/ai/tickets/${id}/summarize`)).data,
  ask: async (question: string) => (await api.post<{ answer: string }>("/ai/ask", { question })).data
};

export const labelApi = {
  list: async () => (await api.get<LabelRow[]>("/labels")).data,
  create: async (payload: { name: string; color?: string }) => (await api.post<LabelRow>("/labels", payload)).data,
  update: async (id: string, payload: { name?: string; color?: string | null }) =>
    (await api.patch<LabelRow>(`/labels/${id}`, payload)).data,
  remove: async (id: string) => api.delete(`/labels/${id}`)
};
