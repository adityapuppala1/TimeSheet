import axios, { type AxiosRequestConfig } from "axios";
import type { AuthUser, GlobalSettings } from "@timesheet/shared";

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

export const reportApi = {
  admin: async () => (await api.get("/reports/admin-summary")).data,
  employee: async () => (await api.get("/reports/employee-summary")).data,
  dailyStatus: async () => (await api.get<DailyStatus>("/reports/daily-status")).data,
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

export const settingsApi = {
  getNotifications: async () => (await api.get<GlobalSettings>("/settings/notifications")).data,
  updateNotifications: async (payload: Partial<GlobalSettings>) =>
    (await api.patch<GlobalSettings>("/settings/notifications", payload)).data
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
