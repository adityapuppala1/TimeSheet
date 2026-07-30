import axios, { type AxiosRequestConfig } from "axios";
import type { BulkUploadResult } from "../components/CsvBulkUploadDialog";
import type {
  ApiKeyScope,
  AuthUser,
  ChatIntegrationRow,
  ChatMatchType,
  ChatPlatform,
  ChatRoutingRuleRow,
  EmailIntakeSettings,
  EmailMatchType,
  EmailRoutingRuleRow,
  GlobalAISettings,
  GlobalSettings,
  GlobalTicketSettings,
  ModuleAssigneeRuleRow,
  OutboundWebhookEvent,
  SecurityFindingSeverity,
  SecurityFindingStatus,
  SecurityFindingType,
  TestRunStatus,
  TicketBranchPrStatus,
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

/** Full-page-navigation API URLs (e.g. an SSO start link, not a fetch call) — resolves the
 *  same way `api`'s axios instance does (relative `/api` in dev via the Vite proxy, or the
 *  absolute VITE_API_URL in a split-deployment production build). */
export function apiUrl(path: string): string {
  return `${API_BASE_URL}${path.startsWith("/") ? "" : "/"}${path}`;
}

/**
 * The refresh token never touches page JS at all — it's an httpOnly cookie the API sets on
 * `/auth/login` and `/auth/refresh` (scoped to `path=/api/auth`), so `withCredentials` is
 * required for the browser to actually send/receive it. Only the short-lived access token is
 * visible here, and it's held in memory only (see store/auth.ts) — never localStorage — to
 * shrink the window an XSS payload could steal it in.
 */
export const api = axios.create({ baseURL: API_BASE_URL, withCredentials: true });

let inMemoryAccessToken: string | null = null;
export function setAccessToken(token: string | null) {
  inMemoryAccessToken = token;
}

api.interceptors.request.use((config) => {
  if (inMemoryAccessToken) config.headers.Authorization = `Bearer ${inMemoryAccessToken}`;
  return config;
});

let refreshPromise: Promise<string> | null = null;

async function refreshAccessToken(): Promise<string> {
  const response = await axios.post<{ accessToken: string }>(`${api.defaults.baseURL}/auth/refresh`, undefined, {
    withCredentials: true
  });
  setAccessToken(response.data.accessToken);
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
      setAccessToken(null);
      throw refreshError;
    }
  }
);

export interface LoginResponse {
  accessToken: string;
  user: AuthUser;
}

export interface SessionRow {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  expiresAt: string;
  current: boolean;
}

export interface SsoMethods {
  passwordEnabled: boolean;
  providers: Array<"GOOGLE" | "MICROSOFT" | "SAML" | "LDAP">;
}

export const authApi = {
  login: async (email: string, password: string, rememberMe: boolean) =>
    (await api.post<LoginResponse>("/auth/login", { email, password, rememberMe })).data,
  /** LDAP is a direct bind, not a redirect (see auth.controller.ts's "/login/ldap"), so it
   *  returns the same JSON shape as /login rather than navigating away to an IdP. */
  loginLdap: async (email: string, password: string) => (await api.post<LoginResponse>("/auth/login/ldap", { email, password })).data,
  refresh: refreshAccessToken,
  ssoMethods: async () => (await api.get<SsoMethods>("/auth/sso-methods")).data,
  me: async () => (await api.get<AuthUser>("/auth/me")).data,
  logout: async () => api.post("/auth/logout"),
  logoutAll: async () => api.post("/auth/logout-all"),
  sessions: async () => (await api.get<SessionRow[]>("/auth/sessions")).data,
  revokeSession: async (id: string) => api.delete(`/auth/sessions/${id}`),
  forgotPassword: async (email: string) => (await api.post("/auth/forgot-password", { email })).data,
  resetPassword: async (token: string, password: string) => (await api.post("/auth/reset-password", { token, password })).data,
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
    api.delete(`/projects/${projectId}/assignments/${userId}`),
  bulkCreate: async (rows: Array<{ projectCode: string; projectName: string; moduleName?: string; submoduleName?: string }>) =>
    (await api.post<{ results: BulkUploadResult[] }>("/projects/bulk", { rows })).data
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
  approve: async (id: string, faceVerificationId?: string) =>
    (await api.patch(`/timesheets/${id}/approve`, faceVerificationId ? { faceVerificationId } : {})).data,
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
  openSlaBreachesYesterday: number;
  createdThisWeek: number;
  resolvedThisWeek: number;
  resolvedLastWeek: number;
  avgResolutionHours: number;
  avgResolutionHoursLastWeek: number;
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

export interface SecurityInsights {
  totalOpen: number;
  totalOpenYesterday: number;
  openBySeverity: Record<"CRITICAL" | "HIGH" | "MEDIUM" | "LOW", number>;
  byType: Array<{ type: "SAST" | "DAST" | "SSAT" | "SSCT" | "VAPT"; count: number }>;
  findingsOverTime: Array<{ weekStart: string; count: number }>;
  meanTimeToRemediateHours: number;
  topRepositories: Array<{ repository: string; count: number }>;
  riskScore: number;
  riskScoreYesterday: number;
}

export interface SbomInventory {
  totalComponents: number;
  vulnerableCount: number;
  vulnerableComponents: Array<{
    id: string;
    name: string;
    version: string;
    ecosystem: string | null;
    license: string | null;
    knownCve: string | null;
    repository: string | null;
    createdAt: string;
  }>;
  byEcosystem: Array<{ ecosystem: string; count: number }>;
  byRepository: Array<{ repository: string; count: number }>;
}

export const reportApi = {
  admin: async () => (await api.get("/reports/admin-summary")).data,
  employee: async () => (await api.get("/reports/employee-summary")).data,
  dailyStatus: async () => (await api.get<DailyStatus>("/reports/daily-status")).data,
  tickets: async () => (await api.get<TicketSummary>("/reports/ticket-summary")).data,
  ticketInsights: async () => (await api.get<TicketInsights>("/reports/ticket-insights")).data,
  securityInsights: async () => (await api.get<SecurityInsights>("/reports/security-insights")).data,
  sbomInventory: async () => (await api.get<SbomInventory>("/reports/sbom-inventory")).data,
  costInsights: async () => (await api.get<CostInsights>("/reports/cost-insights")).data,
  leaderboard: async () => (await api.get<{ rows: LeaderboardRow[] }>("/reports/leaderboard")).data,
  statusReport: async (projectId: string, periodDays = 7) =>
    (await api.post<{ report: string; projectName: string; periodLabel: string }>("/reports/status-report", { projectId, periodDays })).data,
  download: async (type: "csv" | "pdf") => (await api.get(`/reports/export.${type}`, { responseType: "blob" })).data
};

export interface UserRow {
  id: string;
  name: string;
  email: string;
  status: "ACTIVE" | "INACTIVE" | "PENDING_VERIFICATION";
  avatarUrl: string | null;
  bio: string | null;
  designation: string | null;
  /// GitHub login (no leading @) — lets security-ingestion's CODEOWNERS/last-committer
  /// auto-assignment resolve a finding back to this user. Set from the Users page.
  githubUsername: string | null;
  /// Admin-set per-user opt-in for face (identity) verification. Only consulted while the
  /// workspace-level switch is on AND its enforcement mode is SELECTED.
  faceVerificationRequired: boolean;
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
    (await api.post<{ sent: boolean; to: string; emailLogId: string | null }>(`/users/${id}/resend-welcome`)).data,
  bulkCreate: async (
    rows: Array<{
      name: string;
      email: string;
      role: string;
      password?: string;
      managerEmail?: string;
      designation?: string;
      githubUsername?: string;
    }>
  ) => (await api.post<{ results: BulkUploadResult[] }>("/users/bulk", { rows })).data
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

export interface OrgChartNode {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  designation: string | null;
  role: string;
  reports: OrgChartNode[];
}

export const teamApi = {
  reports: async () => (await api.get<TeamReport[]>("/team/reports")).data,
  escalations: async () => (await api.get("/team/escalations")).data,
  slaSummary: async () =>
    (
      await api.get<{
        submitted: number;
        submittedYesterday: number;
        breached: number;
        breachedYesterday: number;
        approvedThisWeek: number;
        approvedLastWeek: number;
        openEscalations: number;
        openEscalationsYesterday: number;
      }>("/team/sla-summary")
    ).data,
  /** Privileged roles see the whole company tree; everyone else sees only their own subtree. */
  orgChart: async () => (await api.get<OrgChartNode[]>("/team/org-chart")).data,
  /** Opt-in manager insight — sustained-overtime and implausible-daily-total flags among direct
   *  reports. Informational only, never blocks anything — see team.controller.ts's doc comment. */
  timesheetAnomalies: async () =>
    (
      await api.get<{
        burnout: Array<{ userId: string; name: string; weekStart: string; hours: number }>;
        implausible: Array<{ userId: string; name: string; date: string; hours: number }>;
      }>("/team/timesheet-anomalies")
    ).data
};

export interface AIUsageSummary {
  monthStart: string;
  totalCostUsd: number;
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  byFeature: Array<{ feature: string; costUsd: number; calls: number }>;
  byModel: Array<{ model: string; costUsd: number; inputTokens: number; outputTokens: number; calls: number }>;
}

export interface AIUsageWeek {
  weekStart: string;
  costUsd: number;
}

/// General-purpose if/then automation on manually-created tickets — see
/// prisma/schema.prisma's TicketRule doc comment (apps/api) for the full evaluation model.
export interface TicketRuleRow {
  id: string;
  name: string;
  isActive: boolean;
  order: number;
  conditionProjectId: string | null;
  conditionProject: { id: string; name: string; code: string } | null;
  conditionPriority: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | null;
  conditionSource: "MANUAL" | "EMAIL" | "API" | "CHAT" | null;
  conditionSenderDomain: string | null;
  actionAssigneeId: string | null;
  actionAssignee: { id: string; name: string } | null;
  actionLabelId: string | null;
  actionLabel: { id: string; name: string; color: string | null } | null;
  actionNotifyUserId: string | null;
  actionNotifyUser: { id: string; name: string } | null;
}

export interface TicketRuleInput {
  name: string;
  isActive?: boolean;
  order?: number;
  conditionProjectId?: string | null;
  conditionPriority?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | null;
  conditionSource?: "MANUAL" | "EMAIL" | "API" | "CHAT" | null;
  conditionSenderDomain?: string | null;
  actionAssigneeId?: string | null;
  actionLabelId?: string | null;
  actionNotifyUserId?: string | null;
}

/** Self-serve Stripe billing — see billing.controller.ts. */
export const billingApi = {
  status: async () =>
    (
      await api.get<{
        planTier: "STARTER" | "TEAM" | "ENTERPRISE";
        hasStripeCustomer: boolean;
        seatLimit: number;
        activeSeats: number;
        checkoutAvailable: { TEAM: boolean; ENTERPRISE: boolean };
      }>("/billing/status")
    ).data,
  checkoutSession: async (tier: "TEAM" | "ENTERPRISE") => (await api.post<{ url: string }>("/billing/checkout-session", { tier })).data
};

export const settingsApi = {
  getNotifications: async () => (await api.get<GlobalSettings>("/settings/notifications")).data,
  updateNotifications: async (payload: Partial<GlobalSettings>) =>
    (await api.patch<GlobalSettings>("/settings/notifications", payload)).data,
  getFaceVerification: async () => (await api.get<FaceVerificationSettings>("/settings/face-verification")).data,
  updateFaceVerification: async (payload: Partial<FaceVerificationSettings>) =>
    (await api.patch<FaceVerificationSettings>("/settings/face-verification", payload)).data,
  getTicketing: async () => (await api.get<GlobalTicketSettings>("/settings/ticketing")).data,
  updateTicketing: async (payload: Partial<GlobalTicketSettings>) =>
    (await api.patch<GlobalTicketSettings>("/settings/ticketing", payload)).data,
  listTicketRules: async () => (await api.get<TicketRuleRow[]>("/settings/ticket-rules")).data,
  createTicketRule: async (payload: TicketRuleInput) => (await api.post<TicketRuleRow>("/settings/ticket-rules", payload)).data,
  updateTicketRule: async (id: string, payload: Partial<TicketRuleInput>) =>
    (await api.patch<TicketRuleRow>(`/settings/ticket-rules/${id}`, payload)).data,
  deleteTicketRule: async (id: string) => api.delete(`/settings/ticket-rules/${id}`),
  getAI: async () => (await api.get<GlobalAISettings>("/settings/ai")).data,
  /** `apiKey` is write-only (not part of GlobalAISettings — the server never echoes it back);
   *  omit to leave the stored key untouched, pass "" to clear it back to the env-var fallback. */
  updateAI: async (payload: Partial<GlobalAISettings> & { apiKey?: string }) =>
    (await api.patch<GlobalAISettings>("/settings/ai", payload)).data,
  getAIUsageSummary: async () => (await api.get<AIUsageSummary>("/settings/ai/usage-summary")).data,
  getAIUsageTrend: async (weeks = 8) => (await api.get<AIUsageWeek[]>("/settings/ai/usage-trend", { params: { weeks } })).data,
  getSso: async () => (await api.get<SsoSettings>("/settings/sso")).data,
  /** `clientSecret`/`idpCertificate` are write-only, same masked-field convention as
   *  GlobalAISettings.apiKey — omit to leave the stored value untouched, pass "" to clear it.
   *  (`idpCertificate` isn't secret — it's the IdP's PUBLIC cert — but it's still large/opaque
   *  enough that round-tripping it back into the form on every load isn't worth doing.) */
  updateSso: async (
    provider: "google" | "microsoft" | "saml" | "ldap",
    payload: Partial<SsoProviderConfig> & { clientSecret?: string; idpCertificate?: string; ldapBindCredential?: string }
  ) => (await api.patch<SsoProviderConfig>(`/settings/sso/${provider}`, payload)).data,
  updateAuthMethod: async (payload: { passwordLoginEnabled?: boolean; requireSsoOnly?: boolean }) =>
    (await api.patch<{ passwordLoginEnabled: boolean; requireSsoOnly: boolean }>("/settings/auth-method", payload)).data,
  getSecurityIngestion: async () =>
    (
      await api.get<{
        tokenSet: boolean;
        orgSlug: string;
        findingsWebhookPath: string;
        testRunsWebhookPath: string;
        sarifFindingsWebhookPath: string;
        sbomWebhookPath: string;
        errorEventsWebhookPath: string;
        fallbackProjectId: string | null;
        autoReopenEnabled: boolean;
        codeownersAssignEnabled: boolean;
        autoCreateTicketOnCiFailureEnabled: boolean;
      }>("/settings/security-ingestion")
    ).data,
  /** Returns the new token in plaintext — the ONE time it's ever visible; see
   *  settings.controller.ts's POST /security-ingestion/rotate-token for why. */
  rotateSecurityIngestionToken: async () => (await api.post<{ token: string }>("/settings/security-ingestion/rotate-token")).data,
  disableSecurityIngestion: async () => api.delete("/settings/security-ingestion/token"),
  /** Where a CRITICAL/HIGH finding with no explicit ticketKey auto-creates a ticket — null
   *  disables auto-ticket-creation. See security-report.service.ts#maybeAutoCreateTicketForFinding. */
  updateSecurityIngestionFallbackProject: async (fallbackProjectId: string | null) =>
    (await api.patch<{ fallbackProjectId: string | null }>("/settings/security-ingestion/fallback-project", { fallbackProjectId })).data,
  /** Deterministic auto-reopen when a FAILED test run references a RESOLVED/CLOSED ticket — see
   *  security-report.service.ts#maybeReopenTicketOnRegression. */
  updateSecurityIngestionAutoReopen: async (autoReopenEnabled: boolean) =>
    (await api.patch<{ autoReopenEnabled: boolean }>("/settings/security-ingestion/auto-reopen", { autoReopenEnabled })).data,
  /** Fallback assignee resolution (CODEOWNERS, then last committer) for an auto-created security
   *  ticket when no ModuleAssigneeRule matches — see
   *  security-report.service.ts#maybeAssignFindingViaCodeowners. Needs a connected GitConnection
   *  and at least one User.githubUsername set to ever resolve anyone. */
  updateSecurityIngestionCodeownersAssign: async (codeownersAssignEnabled: boolean) =>
    (await api.patch<{ codeownersAssignEnabled: boolean }>("/settings/security-ingestion/codeowners-assign", { codeownersAssignEnabled })).data,
  /** A FAILED test run with NO ticket reference at all auto-creates one (with a flaky-test dedup
   *  guard) — see security-report.service.ts#maybeAutoCreateTicketForCiFailure. */
  updateSecurityIngestionAutoCreateTicketOnCiFailure: async (autoCreateTicketOnCiFailureEnabled: boolean) =>
    (
      await api.patch<{ autoCreateTicketOnCiFailureEnabled: boolean }>("/settings/security-ingestion/auto-create-ticket-on-ci-failure", {
        autoCreateTicketOnCiFailureEnabled
      })
    ).data,
  /** Inbound SCIM 2.0 provisioning — see scim.controller.ts. `baseUrl` is what the admin pastes
   *  into their IdP's SCIM connector config, alongside a rotated bearer token. */
  getScim: async () => (await api.get<{ tokenSet: boolean; isEnabled: boolean; baseUrl: string }>("/settings/scim")).data,
  updateScimEnabled: async (isEnabled: boolean) => (await api.patch<{ isEnabled: boolean }>("/settings/scim/enabled", { isEnabled })).data,
  /** Returns the new token in plaintext — the ONE time it's ever visible, same trade-off as
   *  rotateSecurityIngestionToken above. */
  rotateScimToken: async () => (await api.post<{ token: string }>("/settings/scim/rotate-token")).data,
  disableScim: async () => api.delete("/settings/scim/token"),
  /** VAPT findings never go through the CI ingestion webhook (see docs/SECURITY_DEVOPS_INTEGRATIONS.md
   *  §4) — this uploads a structured JSON report directly, parsed into the same SecurityFinding
   *  rows as the automated types. */
  uploadVaptReport: async (payload: {
    assessor: string;
    findings: Array<{
      title: string;
      severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
      description?: string;
      cwe?: string;
      filePath?: string;
      lineNumber?: number;
      ticketKey?: string;
    }>;
  }) => (await api.post<{ created: number; ticketAttached: number }>("/settings/security-ingestion/vapt-report", payload)).data,
  getMail: async () => (await api.get<GlobalMailSettingsRow>("/settings/mail")).data,
  getMailTransportStatus: async () => (await api.get<MailTransportStatus>("/settings/mail/transport-status")).data,
  /** `password` is write-only (masked convention, same as every other secret in this app) —
   *  omit to leave the stored password untouched, pass "" to clear it back to the .env fallback. */
  updateMail: async (payload: Partial<Omit<GlobalMailSettingsRow, "passwordSet">> & { password?: string }) =>
    (await api.patch<GlobalMailSettingsRow>("/settings/mail", payload)).data,
  testMailConnection: async (payload?: { host?: string; port?: number; secure?: boolean; user?: string; password?: string }) =>
    (await api.post<{ ok: boolean; message: string }>("/settings/mail/test-connection", payload ?? {})).data,

  // Public API keys & outbound webhooks — see docs/ROADMAP.md's "Public REST API + outbound
  // webhooks" theme. Both "create" endpoints return the plaintext secret exactly once.
  listApiKeys: async () => (await api.get<ApiKeyRow[]>("/settings/api-keys")).data,
  createApiKey: async (payload: { name: string; scope: ApiKeyScope }) =>
    (await api.post<ApiKeyCreated>("/settings/api-keys", payload)).data,
  revokeApiKey: async (id: string) => api.delete(`/settings/api-keys/${id}`),

  listWebhooks: async () => (await api.get<OutboundWebhookRow[]>("/settings/webhooks")).data,
  createWebhook: async (payload: { name: string; url: string; events: OutboundWebhookEvent[] }) =>
    (await api.post<OutboundWebhookCreated>("/settings/webhooks", payload)).data,
  updateWebhook: async (id: string, payload: { isActive?: boolean; events?: OutboundWebhookEvent[] }) =>
    (await api.patch<OutboundWebhookRow>(`/settings/webhooks/${id}`, payload)).data,
  deleteWebhook: async (id: string) => api.delete(`/settings/webhooks/${id}`),
  /** Deliveries still pending an automatic retry, or that exhausted their attempts — see
   *  workers/webhook-retry.worker.ts. A delivered attempt never needed a row, so it never
   *  appears here. */
  listWebhookDeliveries: async (webhookId: string) => (await api.get<WebhookDeliveryRow[]>(`/settings/webhooks/${webhookId}/deliveries`)).data,
  retryWebhookDelivery: async (webhookId: string, deliveryId: string) =>
    (await api.post<WebhookDeliveryRow>(`/settings/webhooks/${webhookId}/deliveries/${deliveryId}/retry`)).data,

  // Live git-provider (GitHub) connection — see docs/ROADMAP.md's "Live git-provider App
  // integration" item. /git/connect returns a URL to navigate the browser to (a normal fetch,
  // not a plain <a href>, since it needs the Authorization header to build the signed state).
  getGitConnection: async () => (await api.get<GitConnectionStatus>("/settings/git")).data,
  saveGitAppCredentials: async (payload: { clientId: string; clientSecret: string }) =>
    (await api.patch<{ clientIdSet: boolean }>("/settings/git/app-credentials", payload)).data,
  getGitConnectUrl: async () => (await api.get<{ url: string }>("/settings/git/connect")).data,
  disconnectGit: async () => api.delete("/settings/git"),
  rotateGitWebhookSecret: async () => (await api.post<{ secret: string }>("/settings/git/webhook-secret/rotate")).data,
  listGitRepos: async () => (await api.get<GitHubRepoSummary[]>("/settings/git/repos")).data,
  listGitBranches: async (repo: string) => (await api.get<string[]>("/settings/git/branches", { params: { repo } })).data,
  listGitPulls: async (repo: string) => (await api.get<GitHubPullRequestSummary[]>("/settings/git/pulls", { params: { repo } })).data
};

export interface GitConnectionStatus {
  connected: boolean;
  clientIdSet: boolean;
  accountLogin: string | null;
  connectedAt: string | null;
  webhookSecretSet: boolean;
  webhookUrl: string;
}
export interface GitHubRepoSummary {
  fullName: string;
  defaultBranch: string;
}
export interface GitHubPullRequestSummary {
  number: number;
  title: string;
  url: string;
  status: "OPEN" | "MERGED" | "CLOSED";
  branch: string;
}

export interface ApiKeyRow {
  id: string;
  name: string;
  keyPrefix: string;
  scope: ApiKeyScope;
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
  createdBy: { id: string; name: string } | null;
}
export interface ApiKeyCreated {
  id: string;
  name: string;
  scope: ApiKeyScope;
  /** Shown exactly once — the server never returns it again after this response. */
  key: string;
}

export interface OutboundWebhookRow {
  id: string;
  name: string;
  url: string;
  events: OutboundWebhookEvent[];
  isActive: boolean;
  lastDeliveryAt: string | null;
  lastDeliveryStatus: string | null;
  createdAt: string;
  createdBy: { id: string; name: string } | null;
}
export interface WebhookDeliveryRow {
  id: string;
  event: string;
  attempt: number;
  status: "pending" | "delivered" | "exhausted";
  lastError: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface OutboundWebhookCreated {
  id: string;
  name: string;
  url: string;
  events: OutboundWebhookEvent[];
  /** Shown exactly once — used to verify the X-TimeSphere-Signature HMAC header. */
  secret: string;
}

export interface GlobalMailSettingsRow {
  host: string | null;
  port: number;
  secure: boolean;
  user: string | null;
  passwordSet: boolean;
  fromAddress: string | null;
  updatedAt: string | null;
}

export interface SsoProviderConfig {
  provider: "GOOGLE" | "MICROSOFT" | "SAML" | "LDAP";
  isEnabled: boolean;
  // OIDC (Google/Microsoft)
  clientId: string | null;
  clientSecretSet: boolean;
  tenantHint: string | null;
  // SAML
  idpEntityId: string | null;
  idpSsoUrl: string | null;
  idpCertificateSet: boolean;
  spEntityId: string | null;
  // LDAP
  ldapUrl: string | null;
  ldapBindDn: string | null;
  ldapBindCredentialSet: boolean;
  ldapSearchBase: string | null;
  ldapUserFilter: string | null;
  ldapTlsRejectUnauthorized: boolean;
}

export interface SsoSettings {
  providers: SsoProviderConfig[];
  passwordLoginEnabled: boolean;
  requireSsoOnly: boolean;
}

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
  /** Which layer actually supplied the config — a saved GlobalMailSettings row, or apps/api/.env. */
  configSource: "database" | "env";
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

/** Only populated on the ticket LIST endpoint's `assignee` (not the detail endpoint) — see
 *  ticket.controller.ts's GET / handler comment. Used to group the Kanban board into
 *  swimlanes by reporting line (TicketKanban.tsx). */
export interface TicketAssigneeSummary extends TicketUserSummary {
  managerId?: string | null;
  manager?: { id: string; name: string } | null;
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
  assignee: TicketAssigneeSummary | null;
  labels: TicketLabelRow[];
  _count: { comments: number; attachments: number };
  /** Latest ingested CI run only (see docs/ROADMAP.md's "Auto testing on branch/PR push"
   *  theme) — empty when no CI has ever POSTed a test-run result for this ticket. */
  testRuns: { status: TestRunStatus }[];
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

export interface SecurityFindingRow {
  id: string;
  type: SecurityFindingType;
  tool: string;
  severity: SecurityFindingSeverity;
  status: SecurityFindingStatus;
  title: string;
  description: string | null;
  cwe: string | null;
  filePath: string | null;
  lineNumber: number | null;
  repository: string | null;
  branch: string | null;
  prUrl: string | null;
  /// Opt-in AI exploitability triage (Workspace Settings → AI → "Security finding exploitability
  /// triage") — null until triaged, or if the toggle is off, or the finding's severity is below
  /// CRITICAL/HIGH (see security-report.service.ts#maybeTriageFindingWithAI).
  aiVerdict: "TRUE_POSITIVE" | "FALSE_POSITIVE" | "NEEDS_REVIEW" | null;
  aiExploitability: string | null;
  aiFixSuggestion: string | null;
  aiTriagedAt: string | null;
  createdAt: string;
}

export interface TestRunRow {
  id: string;
  provider: string;
  branch: string | null;
  prUrl: string | null;
  status: TestRunStatus;
  passCount: number | null;
  failCount: number | null;
  durationMs: number | null;
  logUrl: string | null;
  createdAt: string;
}

/** Mirrors services/security-report.service.ts#TicketSecurityReport on the API side. */
export interface TicketSecurityReport {
  ticket: { id: string; key: string; title: string };
  findings: SecurityFindingRow[];
  findingsByType: Record<SecurityFindingType, SecurityFindingRow[]>;
  openCountBySeverity: Record<SecurityFindingSeverity, number>;
  latestTestRun: TestRunRow | null;
  riskVerdict: string;
  generatedAt: string;
}

export interface TicketLineageEvent {
  type: "branch_linked" | "pr_status" | "test_run" | "security_finding";
  at: string;
  summary: string;
  detail?: string;
  tone: "success" | "failure" | "neutral";
}
export interface TicketLineage {
  ticket: { id: string; key: string; title: string };
  events: TicketLineageEvent[];
}

export interface TicketBranchRow {
  id: string;
  repository: string;
  branch: string;
  prUrl: string | null;
  prStatus: TicketBranchPrStatus;
  addedBy: TicketUserSummary | null;
  createdAt: string;
}

export interface TicketDetail extends TicketRow {
  description: string | null;
  watchers: TicketWatcherRow[];
  comments: TicketComment[];
  attachments: TicketAttachmentRow[];
  timesheets: TicketTimesheetRow[];
  links: TicketLinkRow[];
  checklistItems: TicketChecklistItemRow[];
  branches: TicketBranchRow[];
  /** The most recent face check spent on this ticket (creation or a status transition). */
  identityVerified: boolean;
  identityVerifiedAt: string | null;
}

export interface AssigneeSuggestion {
  userId: string;
  name: string;
  openTicketCount: number;
  resolvedHereCount: number;
  score: number;
}

export const ticketApi = {
  suggestAssignee: async (projectId: string, moduleId?: string) =>
    (await api.get<{ suggestions: AssigneeSuggestion[] }>("/tickets/suggest-assignee", { params: { projectId, moduleId } })).data,
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
  updateStatus: async (id: string, status: TicketStatus, faceVerificationId?: string) =>
    (await api.patch<TicketDetail>(`/tickets/${id}/status`, { status, ...(faceVerificationId ? { faceVerificationId } : {}) })).data,
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
  },
  securityReport: {
    get: async (id: string) => (await api.get<TicketSecurityReport>(`/tickets/${id}/security-report`)).data,
    // Access token lives in memory only (see store/auth.ts) — a plain <a href> to the PDF
    // endpoint would hit it with no Authorization header, so this downloads via the same
    // authenticated axios instance + blob pattern reportApi.download uses, not a direct link.
    downloadPdf: async (id: string) => (await api.get(`/tickets/${id}/security-report.pdf`, { responseType: "blob" })).data
  },
  /** One chronological timeline of everything bound to this ticket — branches/PRs, CI runs,
   *  security findings — see ticket-lineage.service.ts. Pure aggregation of data the Dev/Security
   *  tabs already show separately; this is the merged view. */
  lineage: async (id: string) => (await api.get<TicketLineage>(`/tickets/${id}/lineage`)).data,
  /** Manual repo/branch/PR linking — see prisma/schema.prisma's TicketBranch model comment for
   *  why this isn't synced live from a git provider. */
  branches: {
    add: async (id: string, payload: { repository: string; branch: string; prUrl?: string; prStatus?: TicketBranchPrStatus }) =>
      (await api.post<TicketBranchRow>(`/tickets/${id}/branches`, payload)).data,
    update: async (id: string, branchId: string, payload: { prUrl?: string | null; prStatus?: TicketBranchPrStatus }) =>
      (await api.patch<TicketBranchRow>(`/tickets/${id}/branches/${branchId}`, payload)).data,
    remove: async (id: string, branchId: string) => api.delete(`/tickets/${id}/branches/${branchId}`),
    /** Suggests (and, with a repository + a connected GitHub, actually creates) a conventional
     *  branch name for this ticket — the ticket -> git direction, complementing the auto-linking
     *  the push webhook already does in the other direction. */
    auto: async (id: string, payload: { repository?: string; baseBranch?: string }) =>
      (await api.post<{ created: boolean; suggestedName?: string; branch?: TicketBranchRow }>(`/tickets/${id}/branches/auto`, payload)).data
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

/** Admin-only: per-platform chat-connector settings (Slack/Teams/Google Chat/Telegram) and
 *  their routing rules — same shape as emailIntakeApi above. */
export const chatIntegrationsApi = {
  getSettings: async () => (await api.get<{ allowedPlatforms: ChatPlatform[]; integrations: ChatIntegrationRow[] }>("/chat-integrations/settings")).data,
  updateSettings: async (
    platform: ChatPlatform,
    payload: Partial<{
      isEnabled: boolean;
      botToken: string;
      signingSecret: string;
      teamsAppId: string | null;
      teamsAppPassword: string;
      googleChatWebhookUrl: string | null;
      defaultProjectId: string | null;
    }>
  ) => (await api.patch<ChatIntegrationRow>(`/chat-integrations/settings/${platform}`, payload)).data,

  routingRules: {
    list: async () => (await api.get<ChatRoutingRuleRow[]>("/chat-integrations/routing-rules")).data,
    create: async (payload: { platform: ChatPlatform; matchType: ChatMatchType; matchValue: string; projectId: string; defaultModuleId?: string }) =>
      (await api.post<ChatRoutingRuleRow>("/chat-integrations/routing-rules", payload)).data,
    update: async (id: string, payload: Partial<{ matchType: ChatMatchType; matchValue: string; projectId: string; defaultModuleId: string | null; isActive: boolean }>) =>
      (await api.patch<ChatRoutingRuleRow>(`/chat-integrations/routing-rules/${id}`, payload)).data,
    remove: async (id: string) => api.delete(`/chat-integrations/routing-rules/${id}`)
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

// ---------------------------------------------------------------------------------------------
// Face (identity) verification
// ---------------------------------------------------------------------------------------------

export interface FaceVerificationSettings {
  id: string;
  enabled: boolean;
  /** Whether this org's plan tier includes the feature at all (Enterprise-only by default).
   *  GET-only — computed from the control plane, not a stored setting. */
  allowedByPlan?: boolean;
  requireForTimesheet: boolean;
  requireForTicket: boolean;
  requireForApproval: boolean;
  challengeEnabled: boolean;
  autoTriageHonestFailures: boolean;
  enforcementMode: "ALL" | "SELECTED";
  matchThreshold: number;
  antispoofThreshold: number;
  livenessThreshold: number;
  maxAttempts: number;
  verificationTtlSeconds: number;
  imageRetentionDays: number;
  consentText: string | null;
  entitlementLostAt: string | null;
  updatedAt: string;
  updatedById: string | null;
}

export interface FaceStatus {
  enabled: boolean;
  allowedByPlan: boolean;
  requiredForTimesheet: boolean;
  requiredForTicket: boolean;
  requiredForApproval: boolean;
  /** Challenge–response liveness on: verification captures TWO frames (neutral + a server-chosen
   *  head movement) — the dialog orchestrates that automatically. */
  challengeEnabled: boolean;
  enrolled: boolean;
  /** Enrollment exists but was made with an older model — embeddings aren't comparable across
   *  model versions, so the user must re-enroll or every check would fail. */
  needsReEnrollment: boolean;
  enrolledAt: string | null;
  consentAt: string | null;
  consentText: string;
  imageRetentionDays: number;
  maxAttempts: number;
}

export type FaceOutcome = "PASSED" | "NO_FACE" | "MULTIPLE_FACES" | "NO_MATCH" | "SPOOF_SUSPECTED" | "CHALLENGE_FAILED" | "LOW_QUALITY" | "NOT_ENROLLED" | "ERROR";

export interface FaceChallenge {
  challengeId: string;
  instruction: "TURN_LEFT" | "TURN_RIGHT" | "LOOK_UP";
  prompt: string;
  expiresInSeconds: number;
}

export interface FaceStatsBucket {
  from: number;
  to: number;
  passed: number;
  rejected: number;
}

export interface FaceStats {
  since: string;
  total: number;
  outcomes: Record<string, number>;
  flaggedPending: number;
  virtualCameraSuspected: number;
  unfamiliarNetwork: number;
  histogram: FaceStatsBucket[];
  /** Operational accuracy — the numbers that answer "did that change help?". */
  accuracy: {
    retakeRatePct: number | null;
    /** A proxy, not a certified FNMR — see the server comment for why. */
    fnmrProxyPct: number | null;
    avgQuality: number | null;
    timeToVerifyMsP50: number | null;
    timeToVerifyMsP95: number | null;
    samples: { judged: number; lowQuality: number; timed: number };
  };
}

export interface FaceThresholdRecommendation {
  currentThreshold: number;
  recommendedThreshold: number | null;
  currentRejectRatePct: number | null;
  projectedRejectRatePct: number | null;
  passedMedian: number | null;
  rejectedMedian: number | null;
  separation: number | null;
  sampleSize: number;
  summary: string;
  /** AI narration of the computed numbers — never the source of the recommendation. */
  narrative: string | null;
}

export interface FaceReviewAiSummary {
  summary: string;
  risk: "LOW" | "MEDIUM" | "HIGH";
  recommendation: string;
}

export interface FaceVerifyResult {
  outcome: FaceOutcome;
  verificationId?: string;
  expiresInSeconds?: number;
  attemptId?: string;
  flagged?: boolean;
  message?: string;
}

export interface FaceAttemptRow {
  id: string;
  userId: string;
  context: "TIMESHEET" | "TICKET" | "APPROVAL";
  outcome: FaceOutcome;
  similarity: number | null;
  antispoofReal: number | null;
  livenessScore: number | null;
  hasImage: boolean;
  purgedAt: string | null;
  flaggedForReview: boolean;
  reviewedAt: string | null;
  reviewNote: string | null;
  createdAt: string;
  consumedAt: string | null;
  deviceLabel: string | null;
  virtualCameraSuspected: boolean;
  unfamiliarNetwork: boolean;
  challengeInstruction: string | null;
  provenanceSuspect?: boolean;
  provenanceNote?: string | null;
  autoResolvedReason?: string | null;
  user: { id: string; name: string; email: string; avatarUrl: string | null };
  reviewedBy: { id: string; name: string } | null;
}

/** One page of the verification log plus the true total, so the footer can say "of N". */
export interface FaceAttemptPage {
  rows: FaceAttemptRow[];
  total: number;
  page: number;
  pageSize: number;
}

export const faceApi = {
  status: async () => (await api.get<FaceStatus>("/face/status")).data,
  /** Multi-frame enrollment: pass several frames from ONE consented session and each usable one
   *  becomes a stored template, so a single unlucky frame can't define the person forever. A
   *  single-frame array still works exactly as before. */
  enroll: async (captures: Blob[]) => {
    const form = new FormData();
    captures.forEach((c, i) => form.append("capture", c, `capture-${i}.jpg`));
    form.append("consent", "true");
    return (
      await api.post<{ enrolled: boolean; consentAt: string; templatesStored: number; framesSubmitted: number }>(
        "/face/enroll",
        form,
        { headers: { "Content-Type": "multipart/form-data" } }
      )
    ).data;
  },
  /** Issues the liveness challenge a verification must satisfy while challenge–response is on. */
  challenge: async (context: "TIMESHEET" | "TICKET" | "APPROVAL") =>
    (await api.post<FaceChallenge>("/face/challenge", { context })).data,
  /** Resolves with the outcome either way — a failed check is a 422 carrying a structured
   *  body, not an exception the caller should have to unwrap. `frames` is [neutral] when the
   *  challenge feature is off, [neutral, gesture] when on. */
  verify: async (params: {
    frames: Blob[];
    context: "TIMESHEET" | "TICKET" | "APPROVAL";
    challengeId?: string;
    deviceLabel?: string | null;
    /** Client-perceived ms from camera-ready to submit — the only place the human's actual wait
     *  can be measured, and what /face/stats reports p50/p95 over. */
    clientDurationMs?: number;
    /** Client clock at each frame capture — provenance evidence (Phase C). Self-reported, so the
     *  server treats a mismatch as a review signal, never a rejection. */
    neutralCapturedAt?: number;
    gestureCapturedAt?: number;
  }): Promise<FaceVerifyResult> => {
    const form = new FormData();
    params.frames.forEach((frame, index) => form.append("capture", frame, `capture-${index}.jpg`));
    form.append("context", params.context);
    if (params.challengeId) form.append("challengeId", params.challengeId);
    if (params.deviceLabel) form.append("deviceLabel", params.deviceLabel.slice(0, 255));
    if (params.clientDurationMs != null) form.append("clientDurationMs", String(Math.round(params.clientDurationMs)));
    if (params.neutralCapturedAt != null) form.append("neutralCapturedAt", String(Math.round(params.neutralCapturedAt)));
    if (params.gestureCapturedAt != null) form.append("gestureCapturedAt", String(Math.round(params.gestureCapturedAt)));
    try {
      return (await api.post<FaceVerifyResult>("/face/verify", form, { headers: { "Content-Type": "multipart/form-data" } })).data;
    } catch (error) {
      const data = (error as { response?: { data?: FaceVerifyResult } }).response?.data;
      if (data?.outcome) return data;
      throw error;
    }
  },
  deleteMyEnrollment: async () => (await api.delete<{ deleted: boolean }>("/face/enrollment")).data,
  deleteEnrollmentFor: async (userId: string) => (await api.delete<{ deleted: boolean }>(`/face/enrollment/${userId}`)).data,
  /** Server-side paginated: the review log grows unbounded (one row per attempt, forever), so
   *  unlike the DataTable-backed surfaces it can't fetch everything and page in the browser. */
  listAttempts: async (params?: { userId?: string; outcome?: string; flaggedOnly?: boolean; page?: number; pageSize?: number }) =>
    (await api.get<FaceAttemptPage>("/face/attempts", { params })).data,
  reviewAttempt: async (id: string, note?: string) =>
    (await api.patch<{ id: string; reviewedAt: string }>(`/face/attempts/${id}/review`, { note })).data,
  attemptImageUrl: (id: string) => `${api.defaults.baseURL}/face/image/attempt/${id}`,
  stats: async () => (await api.get<FaceStats>("/face/stats")).data,
  /** Threshold recommendation computed from this workspace's own distribution; `narrative` is the
   *  optional AI explanation of that same number (null when AI is off). */
  policyRecommendation: async () => (await api.get<FaceThresholdRecommendation>("/face/policy-recommendation")).data,
  autoTriage: async () => (await api.post<{ resolved: number }>("/face/auto-triage")).data,
  /** The dispute-ready evidence pack for one timesheet — every identity check bound to it, the
   *  consent record, and the policy in effect at export time. Blob response (like
   *  ticketApi.securityReport.downloadPdf) rather than a bare URL: the route is authenticated,
   *  and a plain `<a href>`/`window.open` can't attach the bearer token. */
  downloadEvidencePack: async (timesheetId: string) =>
    (await api.get(`/face/evidence/timesheet/${timesheetId}`, { responseType: "blob" })).data as Blob,
  aiSummary: async (attemptId: string) => (await api.post<FaceReviewAiSummary>(`/face/attempts/${attemptId}/ai-summary`)).data,
  /** Self-service data-subject export — everything held about the caller's face verification,
   *  minus the biometrics themselves. */
  exportMyData: async () => (await api.get<Record<string, unknown>>("/face/export")).data
};
