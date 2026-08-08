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
/** Without this a dead backend leaves requests hanging until the browser's own (very long)
 *  default gives up, so the UI just sits there spinning with no way to tell the user why.
 *  Generous enough for the slowest real endpoint here (face verification runs wasm inference
 *  server-side and PDF/report exports stream). */
const REQUEST_TIMEOUT_MS = 30_000;

export const api = axios.create({ baseURL: API_BASE_URL, withCredentials: true, timeout: REQUEST_TIMEOUT_MS });

let inMemoryAccessToken: string | null = null;
export function setAccessToken(token: string | null) {
  inMemoryAccessToken = token;
  // A fresh session arms the session-ended notification again (see below) — without this, a
  // user who was force-signed-out once and signed back in would never be told a second time.
  if (token) sessionEndedNotified = false;
}

/* ------------------------------ Session-ended signal ------------------------------ */

/** Why the person's session just died, as best the client can tell. "revoked" = the server
 *  said the SESSION ROW was revoked (admin force-logout, or a sign-out from another device);
 *  "expired" = the refresh simply failed (idle past the refresh window, cookie gone). */
export type SessionEndedReason = "revoked" | "expired";

type SessionEndedListener = (reason: SessionEndedReason) => void;
const sessionEndedListeners = new Set<SessionEndedListener>();
/** Fires at most once per established session — a burst of parallel 401s must produce ONE
 *  dialog, not one per in-flight query. Re-armed by setAccessToken above. */
let sessionEndedNotified = false;

/**
 * Subscribe to "this signed-in session just ended and could not be refreshed". Fired by the
 * response interceptor below ONLY when a real session existed (never during the normal
 * signed-out boot probe). Same tiny-subscriber pattern as onBackendReachabilityChange, for the
 * same import-cycle reason.
 */
export function onSessionEnded(listener: SessionEndedListener): () => void {
  sessionEndedListeners.add(listener);
  return () => sessionEndedListeners.delete(listener);
}

function notifySessionEnded(reason: SessionEndedReason) {
  for (const listener of sessionEndedListeners) {
    try {
      listener(reason);
    } catch {
      // A misbehaving listener must never break the HTTP error flow it's observing.
    }
  }
}

/**
 * Lets the health monitor (hooks/use-backend-health.ts) learn about backend unreachability from
 * REAL traffic, not just its own poll — so a user who clicks Save into a dead API gets the warning
 * immediately instead of waiting up to a full poll interval.
 *
 * Deliberately a tiny subscriber list rather than importing a store here: this module is imported
 * by essentially every page, and reaching into app state from the HTTP layer would create an
 * import cycle (store -> api -> store).
 */
type ReachabilityListener = (reachable: boolean) => void;
const reachabilityListeners = new Set<ReachabilityListener>();

export function onBackendReachabilityChange(listener: ReachabilityListener): () => void {
  reachabilityListeners.add(listener);
  return () => reachabilityListeners.delete(listener);
}

function notifyReachability(reachable: boolean) {
  for (const listener of reachabilityListeners) {
    try {
      listener(reachable);
    } catch {
      // A misbehaving listener must never break the HTTP response it's observing.
    }
  }
}

/** True when the failure means "couldn't reach/att the server at all" rather than "the server
 *  answered with an error". A 500 means the backend is UP and talking — that's an application
 *  bug for the calling code to surface, not an outage the health gate should block the whole app
 *  for. Only a missing response (DNS/ECONNREFUSED/timeout/offline) counts. */
export function isBackendUnreachableError(error: unknown): boolean {
  const err = error as { response?: unknown; code?: string; message?: string } | undefined;
  if (!err) return false;
  if (err.response) return false;
  return err.code === "ERR_NETWORK" || err.code === "ECONNABORTED" || err.code === "ETIMEDOUT" || err.message === "Network Error";
}

/** True when a failure is the server's deliberate maintenance lockout (503 + code MAINTENANCE)
 *  rather than an outage or an auth problem. Callers use this to stay quiet — the response
 *  interceptor below is already navigating to /maintenance, so error toasts would just flash
 *  something misleading on the way out. */
export function isMaintenanceLockoutError(error: unknown): boolean {
  const err = error as { response?: { status?: number; data?: { code?: string } } } | undefined;
  return err?.response?.status === 503 && err.response.data?.code === "MAINTENANCE";
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
  (response) => {
    // Any successful response proves the backend is reachable — lets the gate clear itself the
    // instant real traffic recovers, without waiting for the next poll tick.
    notifyReachability(true);
    return response;
  },
  async (error) => {
    if (isBackendUnreachableError(error)) notifyReachability(false);

    // 503 + code MAINTENANCE is the server saying "the workspace is closed on purpose" — a
    // different animal from every other 503 (which the health gate treats as an outage) and
    // from 401 (which means "your session is bad, try refreshing it"). The right reaction is a
    // full navigation to the maintenance page: no token refresh (it would be refused too), no
    // retry loop. The pathname guard stops the page's own status poll from re-triggering an
    // endless chain of redirects to itself.
    if (isMaintenanceLockoutError(error) && window.location.pathname !== "/maintenance") {
      window.location.assign("/maintenance");
      throw error;
    }

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
      // The refresh itself failed — the session is genuinely over. If one was actually
      // established (token in memory — distinguishes this from the signed-out boot probe),
      // tell the app so it can show the person a dialog instead of leaving a zombie UI that
      // only reveals the truth on the next hard refresh. The ORIGINAL 401's message carries
      // the why: requireAuth says "Session revoked" for a revoked session row (admin
      // force-logout / another device's sign-out) — anything else is ordinary expiry.
      const wasSignedIn = Boolean(inMemoryAccessToken);
      setAccessToken(null);
      if (wasSignedIn && !sessionEndedNotified) {
        sessionEndedNotified = true;
        const message = String((error.response?.data as { message?: string } | undefined)?.message ?? "");
        notifySessionEnded(message.toLowerCase().includes("revoked") ? "revoked" : "expired");
      }
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

/** First-run setup state. Computed server-side — a gate the browser decides for itself is a gate
 *  anyone can open with devtools. `blocked` is the only field the gate acts on; the rest is for
 *  telling the person what's left. */
export interface OnboardingStatus {
  blocked: boolean;
  completedAt: string | null;
  profile: { complete: boolean; missing: string[] };
  face: { required: boolean; enrolled: boolean };
}

/** The running server's identity — see apps/api/src/config/version.ts. */
export interface SystemVersion {
  version: string;
  gitSha: string | null;
  builtAt: string;
}

/** One GitHub release, relayed through the server's hourly cache. `notes` is markdown and is
 *  REMOTE content — always render it through safeHtml, never raw. */
export interface ReleaseInfo {
  version: string;
  name: string;
  notes: string;
  publishedAt: string | null;
  url: string;
}

export interface UpdateStatus {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  checkedAt: string | null;
  checkEnabled: boolean;
  releases: ReleaseInfo[];
  /** "github" = live release feed; "changelog" = this build's own bundled history (complete up
   *  to the running version, blind to anything newer); null = nothing available at all. */
  releasesSource: "github" | "changelog" | null;
}

export const systemApi = {
  version: async () => (await api.get<SystemVersion>("/system/version")).data,
  /** Cached server-side (one GitHub request an hour for the whole deployment) — poll freely. */
  updates: async () => (await api.get<UpdateStatus>("/system/updates")).data
};

/* ------------------------------ Maintenance mode ------------------------------ */

/** Mirrors api/src/services/maintenance.service.ts#phaseOf. Only "active" locks anyone out;
 *  "scheduled" is the countdown-banner state. */
export type MaintenancePhase = "off" | "scheduled" | "active" | "ended";

/** The PUBLIC status shape — window + message are null whenever the mode is disabled, so an
 *  anonymous caller can't read a stale schedule. */
export interface MaintenanceStatus {
  phase: MaintenancePhase;
  scheduledStartAt: string | null;
  scheduledEndAt: string | null;
  message: string | null;
}

export interface MaintenanceSettingsRow {
  enabled: boolean;
  scheduledStartAt: string | null;
  scheduledEndAt: string | null;
  message: string | null;
  updatedAt: string;
}

/** One live session, already decoded server-side (api/src/utils/user-agent.ts) — the browser never
 *  receives other people's raw UA strings, only the label the panel displays. */
export interface MaintenanceOnlineSession {
  id: string;
  ipAddress: string | null;
  /** LAN/loopback address — the UI says "local network" so a 192.168.x isn't read as an intruder. */
  ipIsPrivate: boolean;
  browser: string;
  os: string;
  formFactor: "desktop" | "mobile" | "tablet" | "unknown";
  /** "Chrome on Windows 10/11", or "Unknown device" when the UA couldn't be decoded. */
  device: string;
  signedInAt: string;
  lastSeenAt: string | null;
}

export interface MaintenanceOnlineUser {
  id: string;
  name: string;
  email: string;
  role: string;
  lastSeenAt: string | null;
  /** One entry per live session — a phone AND a laptop is two, and both are shown. */
  sessions: MaintenanceOnlineSession[];
}

export interface MaintenanceAdminView {
  settings: MaintenanceSettingsRow;
  phase: MaintenancePhase;
  /** `count` is PEOPLE (what the badge and the warn flow mean by "online"); `sessionCount` is
   *  devices, reported separately so the two are never confused for each other. */
  online: { count: number; sessionCount: number; users: MaintenanceOnlineUser[] };
}

/** Mirrors api/src/services/system-health.service.ts#SystemHealthSnapshot — everything measured
 *  on the API instance that answered (one replica's view behind a load balancer, and it says so). */
export interface SystemHealthSnapshot {
  sampledAt: string;
  server: {
    hostname: string;
    pid: number;
    platform: string;
    arch: string;
    nodeVersion: string;
    appVersion: string;
    osUptimeSec: number;
    processUptimeSec: number;
  };
  cpu: { cores: number; model: string; usagePercent: number | null; loadAvg: [number, number, number] | null };
  memory: { totalBytes: number; freeBytes: number; usedPercent: number; processRssBytes: number };
  disk: { path: string; totalBytes: number; freeBytes: number; usedPercent: number } | null;
  network: {
    interfaces: Array<{ name: string; address: string; family: string }>;
    tenantDbPingMs: number | null;
    controlDbPingMs: number | null;
    eventLoopLagMeanMs: number;
    eventLoopLagMaxMs: number;
  };
  components: Array<{ name: string; ok: boolean; detail: string }>;
}

export const maintenanceApi = {
  /** Unauthenticated on purpose — the lockout page's poll must work for people whose sessions
   *  were just revoked. Rate-limited server-side to 30/min per IP, so poll gently (≥15s). */
  status: async () => (await api.get<MaintenanceStatus>("/maintenance/status")).data,
  admin: async () => (await api.get<MaintenanceAdminView>("/maintenance/admin")).data,
  /** SUPER_ADMIN. Shares the router's 30/min limiter with status/admin polls — poll ≥10s. */
  health: async () => (await api.get<SystemHealthSnapshot>("/maintenance/health")).data,
  updateSettings: async (payload: {
    enabled: boolean;
    scheduledStartAt: string | null;
    scheduledEndAt: string | null;
    message: string | null;
  }) => (await api.patch<{ settings: MaintenanceSettingsRow; phase: MaintenancePhase }>("/maintenance/settings", payload)).data,
  forceLogout: async () => (await api.post<{ revokedSessions: number }>("/maintenance/force-logout")).data,
  notify: async () => (await api.post<{ notified: number }>("/maintenance/notify")).data
};

export const authApi = {
  /** The 15s liveness beat AppLayout polls — its 401 is how an admin's force-logout reaches
   *  this tab within seconds (see components/SessionEndedDialog.tsx). Deliberately tiny. */
  heartbeat: async () => (await api.get<{ ok: boolean }>("/auth/heartbeat")).data,
  onboardingStatus: async () => (await api.get<OnboardingStatus>("/auth/onboarding-status")).data,
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
  /** Active projects only by default — pickers and filters must not offer disabled projects.
   *  The admin management page passes includeArchived to see (and reactivate) everything. */
  list: async (opts?: { includeArchived?: boolean }) =>
    (await api.get("/projects", { params: opts?.includeArchived ? { includeArchived: 1 } : {} })).data,
  create: async (payload: unknown) => (await api.post("/projects", payload)).data,
  update: async (id: string, payload: unknown) => (await api.patch(`/projects/${id}`, payload)).data,
  remove: async (id: string) => api.delete(`/projects/${id}`),
  createModule: async (projectId: string, name: string) => (await api.post(`/projects/${projectId}/modules`, { name })).data,
  createSubmodule: async (moduleId: string, name: string) =>
    (await api.post(`/projects/modules/${moduleId}/submodules`, { name })).data,
  renameModule: async (moduleId: string, name: string) => (await api.patch(`/projects/modules/${moduleId}`, { name })).data,
  renameSubmodule: async (submoduleId: string, name: string) =>
    (await api.patch(`/projects/submodules/${submoduleId}`, { name })).data,
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
  reject: async (id: string, reason: string) => (await api.patch(`/timesheets/${id}/reject`, { reason })).data,
  /** DRAFT and REJECTED entries only — the API refuses SUBMITTED (awaiting a decision) and
   *  APPROVED (part of the billing record). Soft delete; the time slot frees up immediately. */
  remove: async (id: string) => api.delete(`/timesheets/${id}`)
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
  /** Across ALL costed tickets, not just the `rows` slice below. */
  totalCostUsd: number;
  avgCostPerTicket: number;
  /** Top 25 by cost — the totals above are not derived from this slice. */
  rows: Array<{ ticketKey: string; title: string; hours: number; costUsd: number }>;
  /** Optional: added alongside the approved-billable-only correction. Older API builds omit them,
   *  hence optional — the UI degrades to just the totals. */
  basis?: "APPROVED_BILLABLE";
  ticketCount?: number;
  /** Hours with no rate on record (pre-snapshot history, or nobody has a rate configured). Not
   *  priced — reported separately so "unknown" is never silently rendered as "free". */
  unratedHours?: number;
  excludedDraftHours?: number;
  excludedRejectedHours?: number;
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

/** One entry inside an attestation's frozen payload. Mirrors AttestationPayload in
 *  api/src/services/attestation.service.ts — deliberately carries the CONCLUSION of an identity
 *  check, never the biometric internals behind it. */
export interface AttestationPayload {
  attestation: {
    reference: string;
    generatedAt: string;
    generatedBy: string | null;
    project: { code: string; name: string; clientName: string | null };
    period: { start: string; end: string };
    currency: string;
  };
  summary: {
    totalHours: number;
    billableHours: number;
    unratedHours: number;
    totalAmount: number;
    entryCount: number;
    contributorCount: number;
    identityVerifiedEntries: number;
    approvedEntries: number;
  };
  workItems: Array<{
    ticketKey: string | null;
    ticketTitle: string;
    hours: number;
    amount: number;
    entries: Array<{
      workDate: string;
      hours: number;
      activityType: string;
      task: string;
      person: string;
      rate: number | null;
      rateSource: string | null;
      amount: number | null;
      identityVerified: boolean;
    }>;
  }>;
  contributors: Array<{ name: string; hours: number; entries: number; identityVerifiedEntries: number }>;
  approvals: Array<{ approver: string; entries: number; identityVerified: boolean }>;
  caveats: string[];
}

export interface AttestationRow {
  id: string;
  reference: string;
  projectId: string;
  periodStart: string;
  periodEnd: string;
  status: "ISSUED" | "VOID";
  currency: string;
  totalHours: number;
  billableHours: number;
  unratedHours: number;
  totalAmount: number;
  entryCount: number;
  generatedBy: { id: string; name: string } | null;
  createdAt: string;
  voidedAt: string | null;
  voidReason: string | null;
}

/** Verified Work Attestation — see api/src/services/attestation.service.ts. Every route 403s
 *  until GlobalTicketSettings.enableAttestations is turned on. */
export const attestationApi = {
  /** Builds without persisting, so a period can be inspected before committing an immutable,
   *  client-facing record. */
  preview: async (payload: { projectId: string; periodStart: string; periodEnd: string }) =>
    (await api.post<{ payload: AttestationPayload }>("/attestations/preview", payload)).data,
  issue: async (payload: { projectId: string; periodStart: string; periodEnd: string }) =>
    (await api.post<AttestationRow>("/attestations", payload)).data,
  list: async (projectId: string) => (await api.get<AttestationRow[]>("/attestations", { params: { projectId } })).data,
  /** Void, never delete — a client may already hold a copy, so withdrawal is itself a record. */
  void: async (id: string, reason: string) => (await api.post<AttestationRow>(`/attestations/${id}/void`, { reason })).data,
  // Authenticated blob downloads — the access token lives in memory only, so a bare <a href>
  // would hit these routes unauthenticated. Same pattern as reportApi.download.
  downloadJson: async (id: string) => (await api.get(`/attestations/${id}`, { responseType: "blob" })).data,
  downloadPdf: async (id: string) => (await api.get(`/attestations/${id}.pdf`, { responseType: "blob" })).data,
  /** Public share links. SUPER_ADMIN only, and additionally gated on
   *  GlobalTicketSettings.enableAttestationSharing which ships off. The plaintext token comes back
   *  exactly once — same write-once convention as API keys. */
  shares: {
    list: async (id: string) => (await api.get<AttestationShareLinkRow[]>(`/attestations/${id}/shares`)).data,
    create: async (id: string, payload: { scope?: "SUMMARY" | "FULL"; expiresInDays?: number }) =>
      (await api.post<{ id: string; token: string; scope: string; expiresAt: string; tokenPrefix: string }>(
        `/attestations/${id}/share`,
        payload
      )).data,
    revoke: async (id: string, linkId: string) => api.delete(`/attestations/${id}/share/${linkId}`)
  }
};

export interface AttestationShareLinkRow {
  id: string;
  /** First 12 chars only — the full token is never returned after creation. */
  tokenPrefix: string;
  scope: "SUMMARY" | "FULL";
  expiresAt: string;
  revokedAt: string | null;
  viewCount: number;
  lastViewedAt: string | null;
  createdAt: string;
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
  /** Filters shared by both exports and the grouped report — one shape, so a CSV and a PDF asked
   *  for the same thing can never disagree about what "the same thing" means. */
  download: async (type: "csv" | "pdf" | "xlsx", filters: TimesheetReportFilters & { groupBy?: GroupByKey } = {}) => {
    const res = await api.get(`/reports/export.${type}`, { params: cleanFilters(filters), responseType: "blob" });
    return {
      blob: res.data as Blob,
      // Surfaced so the UI can warn. A caller scripting a PDF export cannot reasonably parse the
      // document to discover it is partial, and "partial" is the thing it must not miss.
      truncated: res.headers["x-report-truncated"] === "true",
      rowsIncluded: Number(res.headers["x-report-rows-included"] ?? 0),
      totalMatching: Number(res.headers["x-report-total-matching"] ?? 0)
    };
  },
  /** One entry, full detail, same columns as the bulk CSV — what an approver attaches to the
   *  record of why they approved it. Blob rather than a link for the same reason as `download`:
   *  the route needs the bearer token an <a href> cannot carry. */
  downloadEntry: async (timesheetId: string) =>
    (await api.get(`/reports/timesheets/${timesheetId}/export.csv`, { responseType: "blob" })).data as Blob,
  timesheetReport: async (filters: TimesheetReportFilters = {}, groupBy: GroupByKey = "user") =>
    (await api.get<TimesheetReport>("/reports/timesheets", { params: { ...cleanFilters(filters), groupBy } })).data,
  /** Requires a date range — utilisation is hours against capacity, and capacity only means
   *  something over a period. The server refuses without one rather than picking a window. */
  analytics: async (filters: TimesheetReportFilters & { from: string; to: string }) =>
    (await api.get<TimesheetAnalytics>("/reports/analytics", { params: cleanFilters(filters) })).data
};

export interface UtilisationRow {
  userId: string;
  name: string;
  loggedHours: number;
  billableHours: number;
  /** Null when the person has no capacity on file and the workspace has no default. Dividing by an
   *  unknown is how a utilisation chart shows 0% for a contractor nobody configured. */
  capacityHours: number | null;
  utilisationPct: number | null;
  billableUtilisationPct: number | null;
}

export interface TimesheetAnalytics {
  range: { from: string; to: string; workingDays: number };
  utilisation: UtilisationRow[];
  approvalLatency: {
    measured: number;
    /** Reviewed entries submitted before the submit timestamp existed. Reported so a median over a
     *  handful is never read as covering everything. */
    unmeasurable: number;
    medianHours: number | null;
    p90Hours: number | null;
    slowestHours: number | null;
    breached: number;
    breachRatePct: number | null;
    byApprover: Array<{ approverId: string; name: string; reviewed: number; medianHours: number | null }>;
  };
  activityMix: Array<{ activity: string; hours: number; sharePct: number; cost: number | null; unratedEntries: number }>;
  totals: { hours: number; billableHours: number; entries: number; people: number };
  truncated: boolean;
}

/** Drops empty values so the query string carries only real constraints — and so a bookmarked
 *  report URL stays readable. */
function cleanFilters(filters: TimesheetReportFilters): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === "") continue;
    out[key] = String(value);
  }
  return out;
}

export type GroupByKey = "user" | "project" | "module" | "activity" | "status" | "ticket" | "day" | "week" | "month";

export interface TimesheetReportFilters {
  from?: string;
  to?: string;
  projectId?: string;
  userId?: string;
  status?: "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED";
  activityType?: string;
  billable?: boolean;
}

export interface TimesheetReportGroup {
  key: string;
  label: string;
  entries: number;
  hours: number;
  billableHours: number;
  /** Null when NO row in the group carries a rate snapshot. Not zero — zero would claim the work
   *  was free, when the truth is that the rate was never captured. */
  cost: number | null;
  unratedEntries: number;
  people: number;
  firstDate: string | null;
  lastDate: string | null;
}

export interface TimesheetReport {
  groupBy: GroupByKey;
  groupByOptions: GroupByKey[];
  truncated: boolean;
  rowsScanned: number;
  totals: {
    entries: number;
    hours: number;
    billableHours: number;
    cost: number | null;
    unratedEntries: number;
    people: number;
  };
  groups: TimesheetReportGroup[];
}

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
  /// Live presence — same 15-minute lastSeenAt definition as the Maintenance tab's online panel.
  online: boolean;
  lastSeenAt: string | null;
  /// Stamped once on the very first successful login; null for accounts predating the column
  /// (deliberately not backfilled — see prisma schema comment).
  firstLoginAt: string | null;
  lastLoginAt: string | null;
}

export interface CreatedUser extends UserRow {
  welcomeEmail?: {
    sent: boolean;
    status: "SENT" | "FAILED" | "SKIPPED";
    errorMessage: string | null;
    emailLogId: string | null;
  };
}

/** What the user-management table asks for. Every field optional — the table starts unfiltered. */
export interface UserPageQuery {
  search?: string;
  roleId?: string;
  designation?: string;
  status?: "ACTIVE" | "INACTIVE" | "PENDING_VERIFICATION";
  online?: "online" | "offline";
  sort?: "name" | "email" | "createdAt" | "lastSeenAt" | "role";
  dir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

export interface UserPage {
  items: UserRow[];
  total: number;
  page: number;
  pageSize: number;
  /** Rows left on this page after the in-memory online filter — see the endpoint's note on why
   *  presence cannot be a WHERE clause, and why both counts are reported. */
  filteredOnPage: number;
  onlineFilterApplied: boolean;
  designations: string[];
}

export type UserBulkAction = "DEACTIVATE" | "ACTIVATE" | "RESET_PASSWORD" | "RESEND_WELCOME" | "FORCE_LOGOUT" | "DELETE";

export interface UserBulkResult {
  applied: number;
  requested: number;
  skipped: Array<{ id: string; name: string; reason: string }>;
  /** RESET_PASSWORD with no explicit password: each person's freshly generated one-time
   *  password, returned exactly once — the server keeps only the hash. */
  generatedPasswords: Array<{ id: string; name: string; email: string; password: string }>;
}

/* ---------- Service status page ---------- */

export type ServiceStatusValue = "OPERATIONAL" | "DEGRADED" | "DOWN";

export interface StatusDay {
  date: string;
  /** Null when nothing was sampled that day. A gap is not an outage — colouring it green would
   *  be a claim the data does not support. */
  status: ServiceStatusValue | null;
  samples: number;
  downSamples: number;
  degradedSamples: number;
  uptimePct: number | null;
}

export interface StatusPageService {
  key: string;
  label: string;
  description: string;
  current: ServiceStatusValue | null;
  currentDetail: string | null;
  lastCheckedAt: string | null;
  avgLatencyMs: number | null;
  uptimePct: number | null;
  days: StatusDay[];
}

export interface StatusIncident {
  id: string;
  service: string;
  serviceLabel: string;
  status: ServiceStatusValue;
  startedAt: string;
  endedAt: string | null;
  detail: string | null;
  sampleCount: number;
  durationMinutes: number;
}

export interface StatusPage {
  from: string;
  to: string;
  days: number;
  /** Null before the first probe has ever run — the page must not claim "all systems
   *  operational" on the strength of no evidence. */
  overall: ServiceStatusValue | null;
  services: StatusPageService[];
  incidents: StatusIncident[];
}

/* ------------------------------- API performance ------------------------------- */

export interface ApiLatencyPoint {
  bucketStart: string;
  total: number;
  clientErrors: number;
  serverErrors: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  avgDbMs: number | null;
}

export interface ApiEndpointRow {
  apiName: string;
  method: string;
  apiPath: string;
  total: number;
  clientErrors: number;
  serverErrors: number;
  errorRate: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  avgDbMs: number | null;
  totalMs: number;
}

export interface ApiHostRow {
  hostname: string;
  podName: string | null;
  cluster: string | null;
  osType: string;
  total: number;
  serverErrors: number;
  avgMs: number;
  p95Ms: number;
  avgCpuPercent: number | null;
  avgMemPercent: number | null;
  avgDiskPercent: number | null;
  lastSeenAt: string;
}

export interface ApiPerformanceOverview {
  window: { hours: number; since: string; bucketSeconds: number };
  /** Collection state, so an empty chart can say "recording is off" instead of "no traffic". */
  collection: {
    enabled: boolean;
    sampleRate: number;
    flushMs: number;
    retentionDays: number;
    maxBuffer: number;
    bufferedNow: number;
    droppedSinceBoot: number;
    failedSinceBoot: number;
    writtenSinceBoot: number;
    host: { hostname: string; podName: string | null; podNamespace: string | null; cluster: string | null; osType: string };
  };
  totals: {
    total: number;
    clientErrors: number;
    serverErrors: number;
    errorRate: number;
    avgMs: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    maxMs: number;
    avgDbMs: number | null;
    distinctUsers: number;
    distinctHosts: number;
  };
  series: ApiLatencyPoint[];
  endpoints: ApiEndpointRow[];
  hosts: ApiHostRow[];
  statusMix: Array<{ statusClass: string; total: number }>;
}

export interface ApiRequestRow {
  id: string;
  apiName: string;
  method: string;
  apiPath: string;
  statusCode: number;
  userId: string | null;
  user: { id: string; name: string; email: string } | null;
  apiRequestAt: string;
  apiResponseAt: string;
  apiResponseTime: number;
  dbResponseTime: number | null;
  dbQueryCount: number | null;
  hostname: string;
  podName: string | null;
  cluster: string | null;
  osType: string;
  cpuPercent: number | null;
  memUsedPercent: number | null;
  diskUsedPercent: number | null;
  eventLoopLagMs: number | null;
}

export interface ApiRequestQuery {
  hours?: number;
  path?: string;
  method?: string;
  hostname?: string;
  minMs?: number;
  statusClass?: number;
  sort?: "slowest" | "recent";
  limit?: number;
}

export const apiPerformanceApi = {
  /** SUPER_ADMIN. Aggregated server-side — the response carries percentiles and buckets, never
   *  raw samples, however wide the window. */
  overview: async (hours = 24) =>
    (await api.get<ApiPerformanceOverview>("/maintenance/api-performance", { params: { hours } })).data,
  /** The drill-down after the aggregates point somewhere. Server-capped at 200 rows. */
  requests: async (query: ApiRequestQuery) =>
    (await api.get<{ since: string; rows: ApiRequestRow[] }>("/maintenance/api-performance/requests", { params: query })).data
};

export const statusPageApi = {
  get: async (days = 90) => (await api.get<StatusPage>("/maintenance/status-page", { params: { days } })).data,
  /** Probe everything now rather than waiting for the five-minute worker. */
  runNow: async () => (await api.post<{ ranAt: string }>("/maintenance/status-page/run")).data
};

export const userApi = {
  list: async () => (await api.get<UserRow[]>("/users")).data,
  /** The management table's list: server-side filtering, sorting and pagination. Separate from
   *  `list` because that one feeds assignee/manager pickers, which want everybody rather than a
   *  page — two different questions, deliberately two endpoints. */
  paged: async (query: UserPageQuery) => (await api.get<UserPage>("/users/paged", { params: query })).data,
  /** One action across many users. Pass `userIds` for an explicit selection, or `filter` for
   *  "everything matching what I'm looking at" — the server re-derives that set with the same
   *  query the table used, so the two can never select different people. */
  bulkAction: async (payload: {
    action: UserBulkAction;
    userIds?: string[];
    filter?: Omit<UserPageQuery, "page" | "pageSize" | "sort" | "dir" | "online">;
    password?: string;
  }) => (await api.post<UserBulkResult>("/users/bulk-action", payload)).data,
  roles: async () => (await api.get("/users/roles")).data,
  create: async (payload: unknown) => (await api.post<CreatedUser>("/users", payload)).data,
  update: async (id: string, payload: unknown) => (await api.patch(`/users/${id}`, payload)).data,
  remove: async (id: string) => api.delete(`/users/${id}`),
  /** Omit `password` and the server generates a random one-time password, returned ONCE as
   *  `generatedPassword` (stored only as a hash). Passing a password uses it verbatim. Either
   *  way the person is prompted to choose their own at next sign-in. */
  resetPassword: async (id: string, password?: string) =>
    (
      await api.post<{ message: string; generatedPassword: string | null }>(
        `/users/${id}/reset-password`,
        password ? { password } : {}
      )
    ).data,
  /** Revokes every session the user has — server-side, so it needs no cooperation from their
   *  browser. Only a SUPER_ADMIN may target another SUPER_ADMIN. */
  forceLogout: async (id: string) => (await api.post<{ revokedSessions: number }>(`/users/${id}/force-logout`)).data,
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
    ).data,
  /** Per-report logged-hours trend. 404s unless `userId` is one of the caller's own direct
   *  reports — the backend re-derives that from `User.managerId`, never from this argument. */
  hoursTrend: async (userId: string) =>
    (await api.get<TeamHoursTrend>(`/team/reports/${userId}/hours-trend`)).data
};

/** Buckets are pre-aggregated server-side and always present, including empty ones, so a chart
 *  over them keeps a continuous axis for a report who logged nothing. */
export interface TeamHoursTrend {
  user: { id: string; name: string };
  currentMonth: {
    monthStart: string;
    /** ISO weeks clipped to the month — the first and last bucket can be shorter than 7 days. */
    weeks: Array<{ weekStart: string; weekEnd: string; hours: number; entries: number }>;
  };
  monthly: Array<{ monthStart: string; hours: number; entries: number }>;
}

/** Mirrors the API's AiAutonomyLevel enum, weakest first. */
export type AutonomyLevel = "SUGGEST" | "AUTO_APPLY" | "AUTONOMOUS";

export interface AutonomyEntry {
  capability: string;
  title: string;
  description: string;
  /** What this workspace asked for. */
  requestedLevel: AutonomyLevel;
  /** What it actually gets. THE ONLY VALUE THE UI SHOULD ACT ON — the server applies the master
   *  latch, the feature toggle and the product's own ceiling before returning it. */
  effectiveLevel: AutonomyLevel;
  /** The highest level the product permits for this capability. Rungs above it are locked. */
  maxLevel: AutonomyLevel;
  /** Why the effective level is lower than the requested one, when it is. */
  clampedReason: string | null;
  /** Why the locked rungs are locked. Rendered next to them — a disabled option is only worth
   *  showing if it explains itself. */
  ceilingReason: string | null;
  actsOnUntrustedInput: boolean;
  featureEnabled: boolean;
  /** The GlobalAISettings switch behind this capability, so one row can carry both controls.
   *  Null for a capability that reaches no model. */
  featureToggle: string | null;
}

export interface AutonomyCatalogue {
  autonomyEnabled: boolean;
  capabilities: AutonomyEntry[];
}

export interface AIUsageSummary {
  monthStart: string;
  totalCostUsd: number;
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  byFeature: Array<{ feature: string; costUsd: number; calls: number; inputTokens: number; outputTokens: number }>;
  byModel: Array<{ model: string; costUsd: number; inputTokens: number; outputTokens: number; calls: number }>;
}

/** One feature's consumption over the window. Sorted by tokens, not cost — cost is an estimate
 *  from a price table that moves, tokens are what was actually consumed. */
export interface AIFeatureUsageRow {
  feature: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  avgTokensPerCall: number;
  sharePct: number;
  models: string[];
}

export interface AIFeatureUsage {
  from: string;
  to: string;
  days: number;
  /** Feature keys present in the window, in the same order as `features` — the stacked chart uses
   *  this to pick series and colours consistently. */
  featureNames: string[];
  features: AIFeatureUsageRow[];
  /** One entry per day in the window (zero-filled), each carrying a numeric key per feature plus
   *  `totalTokens` and `costUsd`. Pivoted server-side so the zero-filling can't be forgotten. */
  daily: Array<Record<string, string | number>>;
  totals: { calls: number; inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number };
}

/** Mirrors api/src/services/ai-quality.service.ts. Read `coverage` before trusting
 *  `thumbsUpRate` — feedback in this product is heavily self-selected. */
export interface AIQualityFeature {
  feature: string;
  interactions: number;
  /** Null for free-text features, which have no schema to parse against. */
  parseFailureRate: number | null;
  parseableInteractions: number;
  rated: number;
  thumbsUp: number;
  thumbsDown: number;
  coverage: number;
  /** Null below 10 ratings — a percentage from 3 opinions isn't one. */
  thumbsUpRate: number | null;
  avgLatencyMs: number | null;
}

export interface AIQualitySummary {
  captureEnabled: boolean;
  contentCaptureEnabled: boolean;
  windowDays: number;
  totalInteractions: number;
  overallParseFailureRate: number | null;
  features: AIQualityFeature[];
  /** The pre-existing per-TICKET thumbs flag, reported separately and never merged into the
   *  per-call numbers above — different unit, would produce a meaningless total. */
  legacyTicketFeedback: { up: number; down: number };
  /** What people did with AI-authored change rows. Its own bucket, never merged with the
   *  per-call numbers above — these count ROWS, not model calls. */
  proposalDecisions: Array<{
    kind: string;
    accepted: number;
    rejected: number;
    /** Applied and then put back — a worse outcome than a rejection, counted apart from one. */
    undone: number;
    /** Refused at apply time, almost always a stale before-state. That is the envelope working,
     *  not the model being wrong, so it never counts against the rate. */
    refused: number;
    acceptRate: number | null;
  }>;
}

/** Golden datasets — see api/src/services/ai-dataset.service.ts. */
export interface AIDatasetRow {
  id: string;
  name: string;
  description: string | null;
  feature: string;
  itemCount: number;
  createdBy: { id: string; name: string } | null;
  createdAt: string;
}
export interface AIDatasetItemRow {
  id: string;
  sourceInteractionId: string | null;
  inputParamsJson: unknown;
  actualOutput: string | null;
  expectedOutput: string;
  expectedKind: "EXACT_FIELDS" | "CONTAINS" | "JUDGE";
  notes: string | null;
  createdBy: { id: string; name: string } | null;
  createdAt: string;
}
export interface AIDatasetDetail extends Omit<AIDatasetRow, "itemCount"> {
  items: AIDatasetItemRow[];
  /** False when this capability has no replayer yet, so an eval can't be run against it. */
  replayable: boolean;
}

export interface AIEvalRunRow {
  id: string;
  dataset: { id: string; name: string; feature: string };
  promptVersionId: string | null;
  model: string;
  /** QUEUED | RUNNING | COMPLETED | PARTIAL | FAILED. PARTIAL means the budget stopped it early
   *  but the scores it did produce are real. */
  status: string;
  itemCount: number;
  scoredCount: number;
  passCount: number;
  avgScore: number | null;
  estimatedCostUsd: number | null;
  actualCostUsd: number | null;
  error: string | null;
  createdBy: { id: string; name: string } | null;
  createdAt: string;
  finishedAt: string | null;
}
export interface AIEvalResultRow {
  id: string;
  itemId: string;
  output: string | null;
  score: number;
  passed: boolean;
  detail: string | null;
  error: string | null;
  expectedOutput: string | null;
  notes: string | null;
}
export interface AIEvalRunDetail extends AIEvalRunRow {
  results: AIEvalResultRow[];
}

export const aiEvalApi = {
  list: async (datasetId?: string) =>
    (await api.get<AIEvalRunRow[]>("/ai/evals", { params: datasetId ? { datasetId } : {} })).data,
  get: async (id: string) => (await api.get<AIEvalRunDetail>(`/ai/evals/${id}`)).data,
  /** Queues a run — the worker executes it. `promptVersionId: null` measures the built-in prompt. */
  enqueue: async (payload: { datasetId: string; promptVersionId?: string | null }) =>
    (await api.post<AIEvalRunRow>("/ai/evals", payload)).data
};
/** A captured interaction that could be promoted into a dataset. `replayable` is false when the
 *  inputs weren't captured (content capture was off), so the UI can say so before someone types
 *  out a corrected answer. */
export interface AIPromotableInteraction {
  id: string;
  feature: string;
  parseOk: boolean | null;
  feedback: string | null;
  outputText: string | null;
  paramsJson: unknown;
  createdAt: string;
  replayable: boolean;
}

export const aiDatasetApi = {
  list: async () => (await api.get<AIDatasetRow[]>("/ai/datasets")).data,
  create: async (payload: { name: string; feature: string; description?: string }) =>
    (await api.post<AIDatasetRow>("/ai/datasets", payload)).data,
  get: async (id: string) => (await api.get<AIDatasetDetail>(`/ai/datasets/${id}`)).data,
  /** Defaults to problem interactions only (unparseable or thumbs-down) — the ones worth
   *  correcting. Pass `all` to browse everything. */
  candidates: async (id: string, all = false) =>
    (await api.get<AIPromotableInteraction[]>(`/ai/datasets/${id}/candidates`, { params: { all } })).data,
  addItem: async (
    id: string,
    payload: { interactionId: string; expectedOutput: string; expectedKind?: "EXACT_FIELDS" | "CONTAINS" | "JUDGE"; notes?: string }
  ) => (await api.post<AIDatasetItemRow>(`/ai/datasets/${id}/items`, payload)).data,
  removeItem: async (id: string, itemId: string) => api.delete(`/ai/datasets/${id}/items/${itemId}`)
};

export interface AIPromptSummary {
  feature: string;
  label: string;
  description: string;
  /** False means "running the built-in prompt" — the normal state, not a problem. */
  customized: boolean;
  activeVersion: number | null;
  versionCount: number;
}
export interface AIPromptPlaceholder {
  name: string;
  description: string;
  sample: string;
}
export interface AIPromptVersionRow {
  id: string;
  version: number;
  body: string;
  note: string | null;
  createdBy: { id: string; name: string } | null;
  createdAt: string;
}
export interface AIPromptDetail {
  feature: string;
  label: string;
  description: string;
  placeholders: AIPromptPlaceholder[];
  required: string[];
  defaultTemplate: string;
  activeVersionId: string | null;
  versions: AIPromptVersionRow[];
}
export interface AIPromptPreview {
  problems: Array<{ kind: string; message: string }>;
  preview: string;
}

export const aiPromptApi = {
  list: async () => (await api.get<AIPromptSummary[]>("/ai/prompts")).data,
  get: async (feature: string) => (await api.get<AIPromptDetail>(`/ai/prompts/${feature}`)).data,
  /** Validates and renders against sample values. No model call, no cost. */
  preview: async (feature: string, body: string) =>
    (await api.post<AIPromptPreview>(`/ai/prompts/${feature}/preview`, { body })).data,
  saveVersion: async (feature: string, payload: { body: string; note?: string; activate?: boolean }) =>
    (await api.post<AIPromptVersionRow>(`/ai/prompts/${feature}/versions`, payload)).data,
  /** `versionId: null` reverts to the built-in prompt. */
  activate: async (feature: string, versionId: string | null) => api.post(`/ai/prompts/${feature}/activate`, { versionId })
};

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

/** The three workspace flags ordinary (non-super-admin) pages are allowed to read — see
 *  settings.controller.ts's `/effective-flags` doc comment for why this projection is deliberately
 *  tiny. Everything else under `settingsApi` requires SUPER_ADMIN and will 403 for other roles. */
export interface EffectiveWorkspaceFlags {
  autoTriageAutoApply: boolean;
  enableCostAnalytics: boolean;
  enableLeaderboard: boolean;
}

/** Mirrors api/src/config/storage-paths.ts#DirectoryProbe — probed live on every GET, so
 *  `writable` reflects a real write attempt at that moment, not a cached boot-time answer. */
export interface DirectoryProbe {
  path: string;
  exists: boolean;
  writable: boolean;
  problem: string | null;
}

/** Mirrors api/src/config/storage-paths.ts#StorageLayout + config/logger.ts#LoggingStatus. */
export interface StorageAndLogStatus {
  storage: {
    root: DirectoryProbe;
    documents: DirectoryProbe;
    avatars: DirectoryProbe;
    face: DirectoryProbe;
    documentFallbacks: string[];
    configuredBy: Record<"root" | "documents" | "avatars" | "face", string | null>;
  };
  logging: {
    enabled: boolean;
    directory: string;
    rotateHours: number;
    retentionDays: number;
    compressOnRollover: boolean;
    degraded: boolean;
    degradedReason: string | null;
    currentFile: string | null;
    namingExample: string;
  };
}

export const settingsApi = {
  /** Safe for any authenticated role. Use this from non-settings pages instead of `getAI`/
   *  `getTicketing`, which are super-admin-only. */
  getEffectiveFlags: async () => (await api.get<EffectiveWorkspaceFlags>("/settings/effective-flags")).data,
  /** Read-only: the paths themselves are env-only by design — see the header comment on the
   *  `/settings/storage` route in api/src/controllers/settings.controller.ts. */
  getStorage: async () => (await api.get<StorageAndLogStatus>("/settings/storage")).data,
  /** Dry-runs a candidate directory (absolute? no ".."? exists? really writable?) without
   *  changing anything, so an operator can check a path before editing .env and restarting. */
  validateStorageDirectory: async (candidate: string) =>
    (await api.post<{ ok: boolean; path?: string; message?: string }>("/settings/storage/validate-directory", { path: candidate }))
      .data,
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
  /** How much authority each AI capability holds, as opposed to whether it runs at all.
   *  The server returns BOTH `requestedLevel` and `effectiveLevel`; the UI must render the
   *  second and never re-derive it, or the screen will eventually disagree with the server. */
  getAIAutonomy: async () => (await api.get<AutonomyCatalogue>("/settings/ai/autonomy")).data,
  /** 422s when `level` is above the capability's ceiling — that refusal is the point, so the
   *  caller should surface the server's message rather than a generic one. */
  updateAIAutonomy: async (payload: { capability: string; level: AutonomyLevel }) =>
    (await api.patch<AutonomyEntry>("/settings/ai/autonomy", payload)).data,
  getAIUsageSummary: async () => (await api.get<AIUsageSummary>("/settings/ai/usage-summary")).data,
  /** AI QUALITY (not cost) — see api/src/services/ai-quality.service.ts for why the headline
   *  number is parse-failure rate rather than thumbs-up rate. */
  getAIQualitySummary: async (windowDays = 30) =>
    (await api.get<AIQualitySummary>("/settings/ai/quality-summary", { params: { windowDays } })).data,
  getAIUsageTrend: async (weeks = 8) => (await api.get<AIUsageWeek[]>("/settings/ai/usage-trend", { params: { weeks } })).data,
  /** Per-feature token consumption — "what is spending the budget", as opposed to the summary's
   *  "what did we spend". */
  getAIFeatureUsage: async (days = 30) =>
    (await api.get<AIFeatureUsage>("/settings/ai/feature-usage", { params: { days } })).data,
  /** Lists the real model ids an OpenAI-compatible endpoint serves, for the BYOK model picker —
   *  `baseUrl`/`apiKey` are optional overrides so this can preview a not-yet-saved draft (a
   *  freshly typed key, a provider just switched) instead of only ever checking what's stored.
   *  Never rejects on a remote failure — `ok: false` with a message is the "nothing to show,
   *  fall back to manual entry" case, same shape as testMailConnection. */
  fetchAvailableAiModels: async (payload: { baseUrl?: string; apiKey?: string }) =>
    (await api.post<{ ok: boolean; models: string[]; message?: string }>("/settings/ai/available-models", payload)).data,
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

  // MCP server — TimeSphere exposed AS an MCP server for Claude Desktop / Claude Code / the
  // Anthropic MCP connector. `getMcp` returns the tool catalogue with each tool's *effective*
  // state already resolved server-side, so the UI never re-derives the enablement rule.
  getMcp: async () => (await api.get<McpSettingsResponse>("/settings/mcp")).data,
  updateMcp: async (payload: { enabled?: boolean; allowWrites?: boolean; toolOverrides?: Record<string, boolean> }) =>
    (await api.patch<Omit<McpSettingsResponse, "credentials">>("/settings/mcp", payload)).data,
  /** Returns the bearer token exactly once — the server only ever stores its hash. */
  createMcpCredential: async (payload: { name: string; userId: string; allowedTools?: string[]; expiresAt?: string }) =>
    (await api.post<McpCredentialCreated>("/settings/mcp/credentials", payload)).data,
  revokeMcpCredential: async (id: string) => api.delete(`/settings/mcp/credentials/${id}`),

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
  /** Per-provider receiver URLs (gitlab, bitbucket, gitea, forgejo, azure-devops) — all
   *  verified against the same webhook secret as the GitHub URL above. */
  providerWebhookUrls: Record<string, string>;
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

export interface McpToolRow {
  name: string;
  title: string;
  description: string;
  /** Permission the acting user must hold, or null for tools scoped to the caller themselves. */
  permission: string | null;
  mutating: boolean;
  destructive: boolean;
  /** Results can contain text written by people outside the workspace (email/chat intake). */
  untrustedContent: boolean;
  /** The workspace's explicit choice; null when it has never made one. */
  override: boolean | null;
  defaultEnabled: boolean;
  /** What the MCP endpoint itself would answer — already folds in the master switch and the
   *  read-only latch, so a tool can read "on" here only if it is genuinely callable. */
  effectiveEnabled: boolean;
}
export interface McpCredentialRow {
  id: string;
  name: string;
  tokenPrefix: string;
  lastUsedAt: string | null;
  createdAt: string;
  /** The person every tool call made with this credential runs as. */
  actingAs: { id: string; name: string; email: string; role: string };
  createdBy: string | null;
  /** Tool names this credential may call, or null for "whatever the workspace allows".
   *  Only ever narrows — it can never grant something the workspace or the holder lacks. */
  allowedTools: string[] | null;
  expiresAt: string | null;
}
export interface McpSettingsResponse {
  enabled: boolean;
  allowWrites: boolean;
  updatedAt: string;
  tools: McpToolRow[];
  credentials: McpCredentialRow[];
}
export interface McpCredentialCreated {
  id: string;
  name: string;
  /** Shown exactly once — the server stores only a SHA-256 hash of it. */
  token: string;
  actingAs: { id: string; name: string; email: string; role: string };
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

/** One point of a volume series. `bucket` is the ISO date of the bucket start (day / Monday /
 *  1st of month) — formatting is the client's job, the API never sends a display string. */
export interface EmailVolumeBucket {
  bucket: string;
  sent: number;
  failed: number;
  queued: number;
  total: number;
}

export interface EmailTemplateVolumeRow {
  key: string;
  /** The raw `EmailLog.template` values reconciled into this card — a notification CATEGORY for
   *  worker-driven sends, a templateKey for transactional ones. See email-analytics.service.ts. */
  sources: string[];
  /** True when a source category also feeds another card (`reminder.escalation` covers both the
   *  employee and manager templates), so this number is a shared total and must NOT be summed
   *  with the sibling row's. */
  shared: boolean;
  sharedWith: string[];
  total: number;
  sent: number;
  failed: number;
  queued: number;
  /** Subset of `total` produced by the editor's test / bulk-test sends. */
  test: number;
  today: number;
  yesterday: number;
}

/** A log row whose `template` matches no template card at all (a category with no editable
 *  template, or a legacy value). Surfaced rather than dropped so the per-template numbers and
 *  the workspace total reconcile. */
export interface EmailUnmappedVolumeRow {
  template: string;
  total: number;
  sent: number;
  failed: number;
  queued: number;
  today: number;
  yesterday: number;
}

export interface EmailAnalytics {
  generatedAt: string;
  totals: { total: number; sent: number; failed: number; queued: number; test: number; unmapped: number };
  today: Omit<EmailVolumeBucket, "bucket">;
  yesterday: Omit<EmailVolumeBucket, "bucket">;
  perTemplate: EmailTemplateVolumeRow[];
  unmapped: EmailUnmappedVolumeRow[];
  daily: EmailVolumeBucket[];
  weekly: EmailVolumeBucket[];
  monthly: EmailVolumeBucket[];
}

export interface EmailFailureRecipient {
  to: string;
  count: number;
  lastAt: string;
  lastMessage: string;
}

export interface EmailFailureReason {
  id: string;
  /** Normalised form — volatile queue ids / addresses / timestamps replaced with `<markers>` so
   *  identical failures group. `sample` keeps one verbatim SMTP message. */
  reason: string;
  sample: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  templates: Array<{ template: string; count: number }>;
  recipients: EmailFailureRecipient[];
  recipientsTruncated: boolean;
}

export interface EmailFailureBreakdown {
  windowDays: number;
  since: string;
  totalFailures: number;
  sampledFailures: number;
  reasons: EmailFailureReason[];
}

export const emailTemplateApi = {
  list: async () => (await api.get<EmailTemplateRow[]>("/email-templates")).data,
  analytics: async () => (await api.get<EmailAnalytics>("/email-templates/analytics")).data,
  failures: async (days: number) =>
    (await api.get<EmailFailureBreakdown>("/email-templates/analytics/failures", { params: { days } })).data,
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

  /** Planning layer (V6). Present on the DETAIL only — the ticket list stays one query, and
   *  hierarchy is a per-ticket question. All nullable: a workspace that never enabled planning
   *  simply has nulls here and every existing surface behaves exactly as it did. */
  parentId?: string | null;
  parent?: { id: string; key: string; title: string; status: string; priority: string } | null;
  children?: Array<{
    id: string;
    key: string;
    title: string;
    status: string;
    priority: string;
    startDate: string | null;
    endDate: string | null;
    progressPct: number | null;
    isMilestone: boolean;
    assignee: { id: string; name: string; avatarUrl?: string | null } | null;
  }>;
  startDate?: string | null;
  endDate?: string | null;
  isMilestone?: boolean;
  progressPct?: number | null;
  estimatedHours?: number | string | null;
  baselineStartDate?: string | null;
  baselineEndDate?: string | null;
  baselineSetAt?: string | null;
  workflowStatus?: { id: string; name: string; category: WorkStatusCategoryValue; color: string | null } | null;
}

export interface AssigneeSuggestion {
  userId: string;
  name: string;
  openTicketCount: number;
  resolvedHereCount: number;
  score: number;
}

export const ticketApi = {
  /** `title` is optional context for the AI narration only (assigneeSuggestionAiEnabled) — the
   *  ranking itself never depends on it. */
  suggestAssignee: async (projectId: string, moduleId?: string, title?: string) =>
    (await api.get<{ suggestions: AssigneeSuggestion[]; narrative: string | null }>("/tickets/suggest-assignee", { params: { projectId, moduleId, title } })).data,
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

/** The free-text fields the inline "Refine with AI" affordance is offered on. Mirrors `RefineField`
 *  in apps/api/src/services/ai.service.ts — the server owns the list, this is the client's copy of
 *  it so a typo is a compile error rather than a 422. */
export type AIRefineField =
  | "ticket_title"
  | "ticket_description"
  | "ticket_comment"
  | "timesheet_description"
  | "timesheet_notes";

export interface AIRefineResult {
  /** Plain text — what a plain input takes, and what the compare view shows. */
  refined: string;
  /** Sanitized rich-text HTML for rich-text fields; null for plain ones. Already through the
   *  server's `sanitizeRichText` allow-list, and re-sanitized again on render via `safeHtml`. */
  refinedHtml: string | null;
  format: "plain" | "html";
  /** The user's own text as the model saw it (plain), so the comparison is like for like. */
  original: string;
}

export interface AIRefineAvailability {
  available: boolean;
  reason: "ok" | "disabled" | "budget" | "unavailable";
  message: string;
}

/** On-demand AI capabilities (auto-triage, duplicate check, writing assistant, inline refine, comment summary, workspace Q&A) — see apps/api/src/services/ai.service.ts for the gating/budget logic each of these goes through server-side. */
export const aiApi = {
  suggestTriage: async (payload: { projectId: string; title: string; description?: string }) =>
    (await api.post<AITriageSuggestion>("/ai/tickets/suggest-triage", payload)).data,
  findDuplicates: async (payload: { projectId: string; title: string; description?: string; excludeTicketId?: string }) =>
    (await api.post<{ matches: AIDuplicateMatch[] }>("/ai/tickets/duplicates", payload)).data,
  improveText: async (payload: { text: string; context?: "ticket_description" | "comment" }) =>
    (await api.post<{ improved: string }>("/ai/text/improve", payload)).data,
  refineText: async (payload: { text: string; field: AIRefineField }) =>
    (await api.post<AIRefineResult>("/ai/text/refine", payload)).data,
  refineAvailability: async () => (await api.get<AIRefineAvailability>("/ai/text/refine/availability")).data,
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
  /** Lets a plain-http browser (camera unavailable — a browser rule) proceed without the face
   *  check, recorded as a skipped-insecure attempt. A deliberate, audited weakening for LAN
   *  pilots; off by default. */
  insecureContextBypass: boolean;
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
  /** When true, a browser that cannot open the camera (plain-http origin) may proceed via
   *  faceApi.skipVerification — recorded in the review log, never silent. */
  insecureContextBypass: boolean;
  enrolled: boolean;
  /** Enrollment exists but was made with an older model — embeddings aren't comparable across
   *  model versions, so the user must re-enroll or every check would fail. */
  needsReEnrollment: boolean;
  /** How many stored templates verification compares against — the size of this face model. */
  templateCount: number;
  /** Enrollment predates the guided multi-angle wizard (fewer than 3 templates). Verification
   *  still works, but marginal scores are likelier — offer retraining, never force it. */
  needsBetterEnrollment: boolean;
  enrolledAt: string | null;
  consentAt: string | null;
  consentText: string;
  imageRetentionDays: number;
  maxAttempts: number;
}

/**
 * Every value `FaceVerificationAttempt.outcome` can hold, in the same severity order as
 * FACE_OUTCOMES in apps/api/src/services/face.service.ts. An ordered array rather than a bare
 * union because the analytics charts assign colour BY POSITION — a palette keyed off rank would
 * give one outcome a different colour in each chart.
 *
 * SKIPPED_INSECURE was missing from the old hand-kept union even though the column has stored it
 * since the insecure-context bypass shipped, which made every "exhaustive" Record over
 * FaceOutcome quietly incomplete.
 */
export const FACE_OUTCOMES = [
  "PASSED",
  "NO_MATCH",
  "SPOOF_SUSPECTED",
  "CHALLENGE_FAILED",
  "LOW_QUALITY",
  "NO_FACE",
  "MULTIPLE_FACES",
  "NOT_ENROLLED",
  "SKIPPED_INSECURE",
  "ERROR"
] as const;

export type FaceOutcome = (typeof FACE_OUTCOMES)[number];

export interface FaceChallenge {
  challengeId: string;
  instruction: "TURN_LEFT" | "TURN_RIGHT" | "LOOK_UP";
  prompt: string;
  expiresInSeconds: number;
  /** Which rotation axis the server will measure. */
  axis: "yaw" | "pitch";
  /** Radians of rotation the server requires. Sent so the live meter is calibrated against the
   *  real requirement rather than a duplicated constant that could drift out of step with it. */
  minDelta: number;
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

/** Selectable analytics windows. 90 days is bucketed by week server-side — 90 daily bars are
 *  unreadable at any width this card gets. */
export type FaceAnalyticsWindow = 7 | 30 | 90;

/**
 * Outcome analytics for the face review screen. Every field is a COUNT computed in the database:
 * this endpoint deliberately never returns attempt rows, so the payload is the same size for a
 * workspace with a thousand checks and one with a million.
 */
export interface FaceAnalytics {
  since: string;
  days: number;
  bucket: "day" | "week";
  total: number;
  /** Descending by count. Charts re-order to FACE_OUTCOMES so colours stay put. */
  outcomes: Array<{ outcome: string; count: number }>;
  /** Zero-filled across every bucket and every outcome seen in the window. */
  trend: Array<{ bucketStart: string; total: number; counts: Record<string, number> }>;
  /** The three review states are mutually exclusive and must never be summed into one "handled"
   *  number: an auto-triaged attempt is one NOBODY looked at. */
  review: { flaggedTotal: number; pendingReview: number; humanReviewed: number; autoTriaged: number };
  /** Enrollment coverage — the true meaning of "trained" here: there is no adaptive retraining,
   *  only a user completing the guided multi-pose enrollment, which replaces their templates. */
  enrollment: {
    enforcementMode: string;
    covered: number;
    enrolled: number;
    notEnrolled: number;
    /** Enrolled against a superseded model — still unable to verify until they re-enroll. */
    staleModel: number;
    multiPose: number;
    singlePose: number;
  };
}

/** Why one covered user cannot verify reliably today. Mirrors EnrollmentGapKind in
 *  apps/api/src/services/face.service.ts. */
export type FaceEnrollmentGapKind = "NOT_ENROLLED" | "STALE_MODEL" | "SINGLE_POSE";

export interface FaceEnrollmentGap {
  userId: string;
  name: string;
  email: string;
  kind: FaceEnrollmentGapKind;
  /** Comparable templates on the current model — 0 when not enrolled or on a superseded model. */
  templateCount: number;
  enrolledAt: string | null;
  /** Last enrollment nudge of either category; a fresh remind inside 72h is deduped away. */
  lastRemindedAt: string | null;
}

export interface FaceEnrollmentGaps {
  multiPoseTemplateMin: number;
  gaps: FaceEnrollmentGap[];
  counts: { notEnrolled: number; staleModel: number; singlePose: number };
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
  undoneAt: string | null;
  undoneBy: { id: string; name: string } | null;
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
      await api.post<{
        enrolled: boolean;
        consentAt: string;
        templatesStored: number;
        framesSubmitted: number;
        /** Per-shot verdicts in submission order, so the wizard can report which head position
         *  failed and why instead of a single anonymous rejection string. */
        frameResults: Array<{ index: number; accepted: boolean; quality: number | null; reason: string | null }>;
      }>("/face/enroll", form, { headers: { "Content-Type": "multipart/form-data" } })
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
  /** The insecure-context pass-through: mints a consumable "skipped" verification, only while
   *  the super-admin bypass toggle is on. Recorded in the review log — never silent. */
  skipVerification: async (context: "TIMESHEET" | "TICKET" | "APPROVAL") =>
    (await api.post<{ verificationId: string }>("/face/skip", { context })).data,
  deleteMyEnrollment: async () => (await api.delete<{ deleted: boolean }>("/face/enrollment")).data,
  deleteEnrollmentFor: async (userId: string) => (await api.delete<{ deleted: boolean }>(`/face/enrollment/${userId}`)).data,
  /** Server-side paginated: the review log grows unbounded (one row per attempt, forever), so
   *  unlike the DataTable-backed surfaces it can't fetch everything and page in the browser. */
  /** Filtering, search and sort all happen SERVER-side — this log grows without bound (a row per
   *  check, forever, per covered employee), so the client can never hold the whole set to filter
   *  it the way DataTable does elsewhere. `search` matches the subject's name or email. */
  listAttempts: async (params?: {
    userId?: string;
    outcome?: string;
    context?: string;
    flaggedOnly?: boolean;
    search?: string;
    sortBy?: "createdAt" | "similarity" | "livenessScore" | "outcome" | "context";
    sortDir?: "asc" | "desc";
    page?: number;
    pageSize?: number;
  }) => (await api.get<FaceAttemptPage>("/face/attempts", { params })).data,
  reviewAttempt: async (id: string, note?: string) =>
    (await api.patch<{ id: string; reviewedAt: string }>(`/face/attempts/${id}/review`, { note })).data,
  /** Blob, not a bare URL, for the same reason as downloadEvidencePack below: the route is
   *  authenticated, and a `window.open`/`<img src>` navigation carries no bearer token — it
   *  greeted admins with {"message":"Authentication required"} instead of the capture. */
  attemptImage: async (id: string) =>
    (await api.get(`/face/image/attempt/${id}`, { responseType: "blob" })).data as Blob,
  stats: async () => (await api.get<FaceStats>("/face/stats")).data,
  /** Outcome analytics over a selectable window — counts only, aggregated in the database.
   *  Separate from `stats`, which answers the fixed-window CALIBRATION question. */
  analytics: async (days: FaceAnalyticsWindow = 30) =>
    (await api.get<FaceAnalytics>("/face/analytics", { params: { days } })).data,
  /** The per-user worklist behind the coverage chart — the rows an admin can actually chase,
   *  where `analytics().enrollment` only has counts. */
  enrollmentGaps: async () => (await api.get<FaceEnrollmentGaps>("/face/enrollment-gaps")).data,
  /** Sends the standard enrollment reminder (worded for each user's actual gap). The server
   *  intersects with its own gap list and drops anyone nudged in the last 72h, so `sent` is
   *  routinely lower than the number requested — that is the dedupe working, not a failure. */
  remindEnrollment: async (userIds: string[]) =>
    (await api.post<{ requested: number; matched: number; sent: number; skipped: number }>(
      "/face/enrollment-gaps/remind",
      { userIds }
    )).data,
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

/* ------------------------------------------------------------------ *
 * PLANNING LAYER (V6)
 *
 * `settings()` is fetched on every page load by the sidebar, so it is deliberately one request
 * returning three things: what the workspace turned on, what the plan tier allows, and the
 * `effective` AND of the two. The client never computes that AND itself — if it did, the nav
 * could offer a page the API then 403s, and the two would drift the first time a tier changed.
 * ------------------------------------------------------------------ */

export interface PlanningSettings {
  enablePlanning: boolean;
  enableResourceManagement: boolean;
  enableApprovals: boolean;
  enableProofing: boolean;
  enableRequestForms: boolean;
  enableCustomWorkflows: boolean;
  workingDays: number[];
  defaultWeeklyCapacityHours: number | string;
  updatedAt: string;
  updatedById: string | null;
}

export interface PlanningEntitlements {
  ganttEnabled: boolean;
  resourceMgmtEnabled: boolean;
  approvalsEnabled: boolean;
  proofingEnabled: boolean;
  customWorkflowsEnabled: boolean;
  aiPmCopilotEnabled: boolean;
  maxPortfolios: number;
  maxRequestForms: number;
  maxBlueprints: number;
  maxCustomFields: number;
  maxDashboards: number;
}

/** Workspace toggle AND plan entitlement, computed server-side. This is what the UI gates on. */
export interface PlanningEffective {
  planning: boolean;
  timeline: boolean;
  resourceManagement: boolean;
  approvals: boolean;
  proofing: boolean;
  requestForms: boolean;
  customWorkflows: boolean;
}

export interface PlanningConfig {
  settings: PlanningSettings;
  entitlements: PlanningEntitlements;
  effective: PlanningEffective;
}

export type WorkStatusCategoryValue = "TODO" | "ACTIVE" | "REVIEW" | "DONE" | "CANCELLED";

export interface WorkflowStatusRow {
  id: string;
  workflowId: string;
  name: string;
  category: WorkStatusCategoryValue;
  legacyStatus: string;
  color: string | null;
  order: number;
  isInitial: boolean;
  isFinal: boolean;
}

export interface WorkflowRow {
  id: string;
  name: string;
  description: string | null;
  appliesToTicketType: string | null;
  isDefault: boolean;
  isActive: boolean;
  isSystem: boolean;
  statuses: WorkflowStatusRow[];
  transitions: Array<{
    id: string;
    workflowId: string;
    fromStatusId: string;
    toStatusId: string;
    requiresApproval: boolean;
    requiredPermission: string | null;
  }>;
}

export interface WorkflowPayload {
  name: string;
  description?: string | null;
  appliesToTicketType?: string | null;
  isDefault?: boolean;
  isActive?: boolean;
  statuses: Array<{
    name: string;
    category: WorkStatusCategoryValue;
    legacyStatus: string;
    color?: string | null;
    isInitial?: boolean;
    isFinal?: boolean;
  }>;
  transitions: Array<{ from: string; to: string; requiresApproval?: boolean; requiredPermission?: string | null }>;
}

export interface CustomFieldRow {
  id: string;
  key: string;
  label: string;
  type: string;
  description: string | null;
  options: string[] | null;
  isRequired: boolean;
  appliesTo: "TICKET" | "PROJECT";
  ticketTypeFilter: string | null;
  showOnRequestForm: boolean;
  order: number;
  isActive: boolean;
}

export type CustomFieldPayload = Omit<CustomFieldRow, "id" | "options"> & { options?: string[] };

export const planningApi = {
  settings: async () => (await api.get<PlanningConfig>("/planning/settings")).data,
  updateSettings: async (patch: Partial<Omit<PlanningSettings, "updatedAt" | "updatedById">>) =>
    (await api.patch<PlanningSettings>("/planning/settings", patch)).data,

  listWorkflows: async () => (await api.get<WorkflowRow[]>("/planning/workflows")).data,
  /** The category/legacy-status vocabulary the editor's dropdowns render from — served rather
   *  than hard-coded in the client so it can't drift from what the API validates. */
  workflowMeta: async () =>
    (await api.get<{ categories: WorkStatusCategoryValue[]; legacyStatuses: string[] }>("/planning/workflows/meta")).data,
  createWorkflow: async (payload: WorkflowPayload) => (await api.post<WorkflowRow>("/planning/workflows", payload)).data,
  updateWorkflow: async (id: string, payload: WorkflowPayload) =>
    (await api.put<WorkflowRow>(`/planning/workflows/${id}`, payload)).data,
  deleteWorkflow: async (id: string) => {
    await api.delete(`/planning/workflows/${id}`);
  },

  listCustomFields: async (includeInactive = false) =>
    (await api.get<CustomFieldRow[]>("/planning/custom-fields", { params: includeInactive ? { all: "true" } : undefined })).data,
  createCustomField: async (payload: CustomFieldPayload) =>
    (await api.post<CustomFieldRow>("/planning/custom-fields", payload)).data,
  updateCustomField: async (id: string, payload: CustomFieldPayload) =>
    (await api.put<CustomFieldRow>(`/planning/custom-fields/${id}`, payload)).data,
  /** Returns `{ deleted: false }` when the field had values and was deactivated instead — the
   *  API refuses to cascade away stored values just because a definition was removed. */
  deleteCustomField: async (id: string) =>
    (await api.delete<{ deleted: boolean }>(`/planning/custom-fields/${id}`)).data
};

/* ------------------------------------------------------------------ *
 * PLAN (V6 phase 2) — timeline, hierarchy, dependencies, baselines, my work, saved views.
 *
 * Dates on the wire are always `YYYY-MM-DD`, never ISO instants. A planning date is a CALENDAR
 * DAY: "starts on the 3rd" must mean the same thing in Mumbai and Chicago, and the moment a
 * time-of-day is involved the same stored value renders as two different days either side of a
 * timezone boundary. The API enforces the same rule — see plan-schedule.service.ts.
 * ------------------------------------------------------------------ */

export interface PlanItemRow {
  id: string;
  key: string;
  title: string;
  parentId: string | null;
  depth: number;
  /** What a human entered. Null means nobody has scheduled this yet. */
  startDate: string | null;
  endDate: string | null;
  /** What the solver worked out, always present. Equals the entered dates when they exist. */
  resolvedStart: string;
  resolvedEnd: string;
  /** True when the dates are inferred from a dependency or a default rather than entered — the
   *  timeline renders these differently so a guess is never mistaken for a commitment. */
  isInferred: boolean;
  durationDays: number;
  isMilestone: boolean;
  progressPct: number | null;
  effectiveProgressPct: number;
  totalFloatDays: number;
  isCritical: boolean;
  slipDays: number | null;
  baselineStart: string | null;
  baselineEnd: string | null;
  violations: Array<{ dependencyId: string; message: string }>;
  status: string;
  statusCategory: WorkStatusCategoryValue;
  statusLabel: string | null;
  statusColor: string | null;
  priority: string;
  type: string;
  estimatedHours: number | null;
  assignee: { id: string; name: string; avatarUrl?: string | null } | null;
  project: { id: string; code: string; name: string } | null;
}

export interface PlanTimeline {
  workingDays: number[];
  start: string | null;
  end: string | null;
  criticalPath: string[];
  violations: Array<{ itemId: string; dependencyId: string; message: string }>;
  items: PlanItemRow[];
}

export type PlanDependencyType =
  | "BLOCKS"
  | "FINISH_TO_START"
  | "START_TO_START"
  | "FINISH_TO_FINISH"
  | "START_TO_FINISH";

export interface PlanDependencyRow {
  id: string;
  fromId: string;
  toId: string;
  type: PlanDependencyType;
  lagDays: number;
}

export interface CalendarItemRow {
  id: string;
  key: string;
  title: string;
  startDate: string | null;
  endDate: string | null;
  dueAt: string | null;
  /** The day the calendar should place this on — real dates when present, else the SLA date. */
  anchorDate: string;
  /** False when the item only has an SLA date, so the calendar can mark it as unscheduled
   *  rather than implying someone committed to that day. */
  isScheduled: boolean;
  isMilestone: boolean;
  status: string;
  statusCategory: WorkStatusCategoryValue;
  statusLabel: string | null;
  priority: string;
  type: string;
  assignee: { id: string; name: string; avatarUrl?: string | null } | null;
  project: { id: string; code: string; name: string } | null;
}

export interface MyWorkItem {
  id: string;
  key: string;
  title: string;
  startDate: string | null;
  endDate: string | null;
  dueAt: string | null;
  deadline: string | null;
  priority: string;
  status: string;
  statusCategory: WorkStatusCategoryValue;
  statusLabel: string | null;
  type: string;
  isMilestone: boolean;
  progressPct: number | null;
  estimatedHours: number | null;
  project: { id: string; code: string; name: string } | null;
  blockers: Array<{ id: string; key: string; title: string; status: string }>;
}

export interface MyWork {
  overdue: MyWorkItem[];
  today: MyWorkItem[];
  thisWeek: MyWorkItem[];
  later: MyWorkItem[];
  blocked: MyWorkItem[];
  counts: { total: number; blocked: number };
}

export interface SavedViewRow {
  id: string;
  ownerId: string;
  owner?: { id: string; name: string };
  name: string;
  scope: "PERSONAL" | "SHARED";
  viewType: "LIST" | "BOARD" | "TIMELINE" | "CALENDAR" | "WORKLOAD";
  filters: Record<string, unknown> | null;
  columns: string[] | null;
  sort: Record<string, unknown> | null;
  isDefault: boolean;
}

export const planApi = {
  timeline: async (params?: { projectIds?: string[]; from?: string; to?: string; includeClosed?: boolean }) =>
    (
      await api.get<PlanTimeline>("/plan/timeline", {
        params: {
          projectIds: params?.projectIds?.length ? params.projectIds.join(",") : undefined,
          from: params?.from,
          to: params?.to,
          includeClosed: params?.includeClosed ? "true" : undefined
        }
      })
    ).data,
  dependencies: async (projectIds?: string[]) =>
    (
      await api.get<PlanDependencyRow[]>("/plan/dependencies", {
        params: { projectIds: projectIds?.length ? projectIds.join(",") : undefined }
      })
    ).data,
  updateItem: async (
    id: string,
    patch: Partial<{
      startDate: string | null;
      endDate: string | null;
      parentId: string | null;
      isMilestone: boolean;
      progressPct: number | null;
      sortOrder: number;
      estimatedHours: number | null;
    }>
  ) => (await api.patch(`/plan/items/${id}`, patch)).data,
  setBaseline: async (id: string, clear = false) =>
    (await api.post<{ baselineStart: string | null; baselineEnd: string | null }>(`/plan/items/${id}/baseline`, { clear })).data,
  setProjectBaseline: async (projectId: string, clear = false) =>
    (await api.post<{ count: number }>(`/plan/projects/${projectId}/baseline`, { clear })).data,

  addDependency: async (payload: { fromId: string; toId: string; type: PlanDependencyType; lagDays?: number }) =>
    (await api.post<PlanDependencyRow>("/plan/dependencies", payload)).data,
  updateDependency: async (id: string, lagDays: number) =>
    (await api.patch<{ id: string; lagDays: number }>(`/plan/dependencies/${id}`, { lagDays })).data,
  removeDependency: async (id: string) => {
    await api.delete(`/plan/dependencies/${id}`);
  },

  calendar: async (params: { from: string; to: string; projectIds?: string[] }) =>
    (
      await api.get<CalendarItemRow[]>("/plan/calendar", {
        params: { ...params, projectIds: params.projectIds?.length ? params.projectIds.join(",") : undefined }
      })
    ).data,
  myWork: async () => (await api.get<MyWork>("/plan/my-work")).data,

  listViews: async () => (await api.get<SavedViewRow[]>("/plan/views")).data,
  createView: async (payload: Partial<SavedViewRow> & { name: string }) =>
    (await api.post<SavedViewRow>("/plan/views", payload)).data,
  updateView: async (id: string, payload: Partial<SavedViewRow> & { name: string }) =>
    (await api.put<SavedViewRow>(`/plan/views/${id}`, payload)).data,
  deleteView: async (id: string) => {
    await api.delete(`/plan/views/${id}`);
  }
};

export interface PortfolioRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  color: string | null;
  status: string;
  owner: { id: string; name: string; email: string; avatarUrl?: string | null } | null;
  _count?: { projects: number };
}

export interface PortfolioProjectRollup {
  id: string;
  code: string;
  name: string;
  status: string;
  portfolio: { id: string; code: string; name: string; color: string | null } | null;
  plannedStart: string | null;
  plannedEnd: string | null;
  scheduleStart: string | null;
  scheduleEnd: string | null;
  overrunsPlannedEnd: boolean;
  itemCount: number;
  openCount: number;
  doneCount: number;
  progressPct: number;
  criticalCount: number;
  slippedCount: number;
  worstSlipDays: number;
  violationCount: number;
  budget: number | null;
  currency: string;
  burn: number;
  burnPct: number | null;
  /** Null when there is not enough progress or spend for a forecast to mean anything — a blank
   *  is honest, a confident zero is not. */
  forecastAtCompletion: number | null;
  overBudgetRisk: boolean;
  budgetAlertPct: number | null;
  loggedHours: number;
}

export interface PortfolioRollupRow {
  id: string;
  code: string;
  name: string;
  color: string | null;
  status: string;
  owner: { id: string; name: string } | null;
  projectCount: number;
  itemCount: number;
  openCount: number;
  progressPct: number;
  budget: number | null;
  burn: number;
  slippedCount: number;
  atRiskProjects: number;
  scheduleEnd: string | null;
}

export const portfolioApi = {
  list: async () => (await api.get<PortfolioRow[]>("/portfolios")).data,
  create: async (payload: Partial<PortfolioRow> & { name: string; code: string }) =>
    (await api.post<PortfolioRow>("/portfolios", payload)).data,
  update: async (id: string, payload: Partial<PortfolioRow> & { name: string; code: string }) =>
    (await api.put<PortfolioRow>(`/portfolios/${id}`, payload)).data,
  remove: async (id: string) => {
    await api.delete(`/portfolios/${id}`);
  },
  setProjects: async (id: string, projectIds: string[]) =>
    (await api.post<{ count: number }>(`/portfolios/${id}/projects`, { projectIds })).data,
  rollup: async (portfolioId?: string) =>
    (
      await api.get<{ projects: PortfolioProjectRollup[]; portfolios: PortfolioRollupRow[] }>("/portfolios/rollup", {
        params: portfolioId ? { portfolioId } : undefined
      })
    ).data
};

/* ------------------------------------------------------------------ *
 * RESOURCES & BUDGET (V6 phase 3)
 *
 * The board puts PLANNED (a booking), ACTUAL (approved timesheets) and CAPACITY on one axis.
 * That third and second column together are what a pure PM tool cannot show — every competitor
 * can only compare a plan against another plan.
 * ------------------------------------------------------------------ */

export interface CapacityPersonRow {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  designation?: string | null;
  /** Null = use the workspace default. A row-level 40 and an unanswered 40 are different facts. */
  weeklyCapacityHours: number | null;
  /** Share of capacity expected to be bookable project work. Null = 100. */
  plannedUtilizationPct: number | null;
}

export interface WorkloadCellRow {
  bucketStart: string;
  /** Capacity MINUS time off — what is actually available to book. */
  capacityHours: number;
  bookedHours: number;
  timeOffHours: number;
  loggedHours: number;
  /** Null when there is no capacity to divide by (someone fully on leave). */
  allocationPct: number | null;
  isOverAllocated: boolean;
}

export interface WorkloadRowData {
  person: CapacityPersonRow;
  cells: WorkloadCellRow[];
  totals: {
    capacityHours: number;
    bookedHours: number;
    loggedHours: number;
    timeOffHours: number;
    allocationPct: number | null;
    overAllocatedBuckets: number;
  };
}

export interface WorkloadBucket {
  start: string;
  end: string;
  label: string;
  workingDays: number;
}

export interface WorkloadBoard {
  from: string;
  to: string;
  granularity: "day" | "week";
  workingDays: number[];
  buckets: WorkloadBucket[];
  rows: WorkloadRowData[];
  summary: {
    people: number;
    overAllocated: number;
    unbooked: number;
    totalCapacityHours: number;
    totalBookedHours: number;
    totalLoggedHours: number;
  };
}

export interface ResourceBookingRow {
  id: string;
  userId: string;
  user: { id: string; name: string; email: string; avatarUrl?: string | null };
  projectId: string | null;
  project: { id: string; code: string; name: string } | null;
  ticketId: string | null;
  ticket: { id: string; key: string; title: string } | null;
  startDate: string;
  endDate: string;
  /** Per WORKING day, not per calendar day. */
  hoursPerDay: number;
  note: string | null;
  isTimeOff: boolean;
}

export interface BookingConflict {
  userId: string;
  user: { id: string; name: string; avatarUrl?: string | null };
  overlapStart: string;
  overlapEnd: string;
  combinedHoursPerDay: number;
  bookings: Array<{ id: string; project: { id: string; code: string; name: string } | null; hoursPerDay: number; note: string | null }>;
}

export interface ProjectBudgetRow {
  projectId: string;
  budget: number | null;
  currency: string;
  budgetAlertPct: number | null;
  burn: number;
  burnPct: number | null;
  billableHours: number;
  nonBillableHours: number;
  /** Approved hours with no rate on record — reported, never priced as zero. */
  unratedHours: number;
  forecastAtCompletion: number | null;
  overBudgetRisk: boolean;
  alerting: boolean;
}

export interface EffortVarianceRow {
  ticketId: string;
  key: string;
  title: string;
  estimatedHours: number;
  actualHours: number;
  varianceHours: number;
  variancePct: number;
  assignee: { id: string; name: string } | null;
}

export interface ProjectBudgetPanel {
  project: { id: string; code: string; name: string; plannedStart: string | null; plannedEnd: string | null };
  progressPct: number;
  schedule: { start: string | null; end: string | null; overrunsPlannedEnd: boolean };
  budget: ProjectBudgetRow | null;
  variance: { rows: EffortVarianceRow[]; medianVariancePct: number | null; overrunRate: number | null };
}

/** Create and update take the same shape, so it is named once rather than inferred from the
 *  create method — a `Parameters<typeof resourceApi.createBooking>` reference inside the object
 *  that declares it is circular, and TypeScript widens the whole export to `any`. */
export interface ResourceBookingInput {
  userId: string;
  projectId?: string | null;
  ticketId?: string | null;
  startDate: string;
  endDate: string;
  /** Per WORKING day. */
  hoursPerDay: number;
  note?: string | null;
  isTimeOff?: boolean;
}

export const resourceApi = {
  workload: async (params?: { from?: string; to?: string; granularity?: "day" | "week"; projectId?: string }) =>
    (await api.get<WorkloadBoard>("/resources/workload", { params })).data,
  conflicts: async (params?: { from?: string; to?: string }) =>
    (await api.get<BookingConflict[]>("/resources/conflicts", { params })).data,

  listBookings: async (params?: { from?: string; to?: string; userId?: string; projectId?: string }) =>
    (await api.get<ResourceBookingRow[]>("/resources/bookings", { params })).data,
  createBooking: async (payload: ResourceBookingInput) =>
    (await api.post<ResourceBookingRow>("/resources/bookings", payload)).data,
  updateBooking: async (id: string, payload: ResourceBookingInput) =>
    (await api.put<ResourceBookingRow>(`/resources/bookings/${id}`, payload)).data,
  deleteBooking: async (id: string) => {
    await api.delete(`/resources/bookings/${id}`);
  },

  capacity: async () =>
    (await api.get<{ defaultWeeklyCapacityHours: number; people: CapacityPersonRow[] }>("/resources/capacity")).data,
  updateCapacity: async (userId: string, patch: { weeklyCapacityHours?: number | null; plannedUtilizationPct?: number | null }) =>
    (await api.patch<CapacityPersonRow>(`/resources/capacity/${userId}`, patch)).data,

  budget: async (projectId: string) => (await api.get<ProjectBudgetPanel>(`/resources/budget/${projectId}`)).data
};

/* ------------------------------------------------------------------ *
 * INTAKE, BLUEPRINTS, APPROVALS & PROOFING (V6 phase 4)
 *
 * `publicFormApi` and `guestApprovalApi` deliberately use a BARE axios instance rather than the
 * shared `api` client: those two surfaces are opened by people with no account, and the shared
 * client attaches credentials and runs the 401-refresh interceptor. Pointing an unauthenticated
 * page at it would bounce a submitter to the login screen the first time anything returned 401.
 * ------------------------------------------------------------------ */

export const REQUEST_FIELD_TYPES = ["TEXT", "TEXTAREA", "NUMBER", "DATE", "SELECT", "MULTISELECT", "CHECKBOX", "EMAIL"] as const;
export type RequestFieldType = (typeof REQUEST_FIELD_TYPES)[number];

export interface RequestFormVisibilityRule {
  field: string;
  operator: "equals" | "notEquals" | "contains" | "isAnswered";
  value?: string;
}

export interface RequestFormFieldRow {
  key: string;
  label: string;
  type: RequestFieldType;
  help?: string;
  required?: boolean;
  options?: string[];
  showWhen?: RequestFormVisibilityRule[];
  /** "title" | "description" | "custom:<key>" */
  mapsTo?: string;
}

export interface RequestFormSchemaRow {
  fields: RequestFormFieldRow[];
  intro?: string;
  confirmation?: string;
}

export interface RequestFormRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  projectId: string;
  project?: { id: string; code: string; name: string };
  moduleId: string | null;
  ticketType: string;
  defaultPriority: string;
  defaultAssigneeId: string | null;
  blueprintId: string | null;
  blueprint?: { id: string; name: string } | null;
  isActive: boolean;
  isPublic: boolean;
  /** Present only to someone who may configure forms — it IS the capability. */
  publicToken?: string | null;
  hasPublicLink: boolean;
  maxSubmissionsPerHour: number;
  schema: RequestFormSchemaRow;
  _count?: { submissions: number };
}

export interface RequestSubmissionRow {
  id: string;
  formId: string;
  form: { id: string; name: string; slug: string; schema: RequestFormSchemaRow };
  ticketId: string | null;
  ticket: { id: string; key: string; title: string; status: string } | null;
  submitterName: string | null;
  submitterEmail: string | null;
  answers: Record<string, unknown>;
  status: "PENDING" | "ACCEPTED" | "REJECTED";
  needsReview: boolean;
  createdAt: string;
}

export const requestFormApi = {
  list: async () => (await api.get<RequestFormRow[]>("/request-forms")).data,
  create: async (payload: Partial<RequestFormRow> & { name: string; slug: string; projectId: string; schema: RequestFormSchemaRow }) =>
    (await api.post<RequestFormRow>("/request-forms", payload)).data,
  update: async (id: string, payload: Partial<RequestFormRow> & { name: string; slug: string; projectId: string; schema: RequestFormSchemaRow }) =>
    (await api.put<RequestFormRow>(`/request-forms/${id}`, payload)).data,
  /** Revoking clears the token, so an old URL can never be resurrected by flipping a flag back. */
  publish: async (id: string, publish: boolean) =>
    (await api.post<RequestFormRow>(`/request-forms/${id}/publish`, { publish })).data,
  remove: async (id: string) => (await api.delete<{ deleted: boolean; submissions?: number }>(`/request-forms/${id}`)).data,

  submissions: async (params?: { status?: string; formId?: string }) =>
    (await api.get<RequestSubmissionRow[]>("/request-forms/submissions", { params })).data,
  accept: async (id: string) => (await api.post(`/request-forms/submissions/${id}/accept`)).data,
  reject: async (id: string, reason?: string) => (await api.post(`/request-forms/submissions/${id}/reject`, { reason })).data
};

export interface BlueprintItemRow {
  title: string;
  type?: string;
  description?: string;
  priority?: string;
  offsetStartDays?: number;
  durationDays?: number;
  isMilestone?: boolean;
  estimatedHours?: number;
  parentIndex?: number;
  dependsOn?: number[];
  moduleName?: string;
}

export interface BlueprintRow {
  id: string;
  name: string;
  description: string | null;
  kind: "PROJECT" | "WORK_ITEM";
  isActive: boolean;
  payload: { modules?: string[]; items: BlueprintItemRow[] };
  itemCount?: number;
  createdBy?: { id: string; name: string } | null;
}

export const blueprintApi = {
  list: async () => (await api.get<BlueprintRow[]>("/blueprints")).data,
  get: async (id: string) => (await api.get<BlueprintRow>(`/blueprints/${id}`)).data,
  create: async (payload: { name: string; description?: string | null; kind?: string; payload: BlueprintRow["payload"] }) =>
    (await api.post<BlueprintRow>("/blueprints", payload)).data,
  update: async (id: string, payload: { name: string; description?: string | null; kind?: string; payload: BlueprintRow["payload"] }) =>
    (await api.put<BlueprintRow>(`/blueprints/${id}`, payload)).data,
  remove: async (id: string) => {
    await api.delete(`/blueprints/${id}`);
  },
  /** Runs the same expander the real instantiation runs, and writes nothing. */
  preview: async (id: string, startDate: string) =>
    (
      await api.post<{ items: Array<BlueprintItemRow & { index: number; depth: number; startDate: string | null; endDate: string | null }>; start: string | null; end: string | null }>(
        `/blueprints/${id}/preview`,
        { startDate }
      )
    ).data,
  instantiate: async (id: string, payload: { projectId: string; startDate: string; titlePrefix?: string }) =>
    (await api.post<{ count: number; items: Array<{ id: string; key: string; title: string }> }>(`/blueprints/${id}/instantiate`, payload)).data,
  derive: async (projectId: string, name: string) =>
    (await api.post<BlueprintRow>("/blueprints/derive", { projectId, name })).data
};

export interface ApprovalStepRow {
  id: string;
  order: number;
  decision: "PENDING" | "APPROVED" | "REJECTED";
  comment: string | null;
  decidedAt: string | null;
  approver: { id: string; name: string; email: string; avatarUrl?: string | null } | null;
  guestEmail: string | null;
  hasGuestLink: boolean;
}

export interface ApprovalRequestRow {
  id: string;
  ticketId: string;
  title: string;
  description: string | null;
  dueAt: string | null;
  isSequential: boolean;
  status: "PENDING" | "APPROVED" | "REJECTED";
  completedAt: string | null;
  requestedBy: { id: string; name: string } | null;
  steps: ApprovalStepRow[];
}

export const approvalApi = {
  forTicket: async (ticketId: string) => (await api.get<ApprovalRequestRow[]>(`/approvals/ticket/${ticketId}`)).data,
  create: async (payload: {
    ticketId: string;
    title: string;
    description?: string | null;
    dueAt?: string | null;
    isSequential?: boolean;
    steps: Array<{ approverId?: string | null; guestEmail?: string | null; order?: number }>;
  }) => (await api.post<ApprovalRequestRow>("/approvals", payload)).data,
  decide: async (stepId: string, decision: "APPROVED" | "REJECTED", comment?: string) =>
    (await api.post(`/approvals/steps/${stepId}/decide`, { decision, comment })).data,
  /** Mints a fresh link; the previous one dies immediately. */
  resendGuestLink: async (stepId: string) => (await api.post<{ url: string }>(`/approvals/steps/${stepId}/resend`)).data,
  cancel: async (id: string) => {
    await api.delete(`/approvals/${id}`);
  }
};

export interface ProofAnnotationRow {
  id: string;
  attachmentId: string;
  author: { id: string; name: string; avatarUrl?: string | null } | null;
  guestEmail: string | null;
  /** Normalised 0-1, so a pin lands on the same spot at any render size. */
  x: number;
  y: number;
  w: number | null;
  h: number | null;
  pageIndex: number | null;
  body: string;
  resolvedAt: string | null;
  parentId: string | null;
  createdAt: string;
  replies?: ProofAnnotationRow[];
}

export const proofApi = {
  list: async (attachmentId: string) => (await api.get<ProofAnnotationRow[]>(`/proofs/attachment/${attachmentId}`)).data,
  add: async (attachmentId: string, payload: { x: number; y: number; w?: number | null; h?: number | null; pageIndex?: number | null; body: string; parentId?: string | null }) =>
    (await api.post<ProofAnnotationRow>(`/proofs/attachment/${attachmentId}`, payload)).data,
  resolve: async (id: string, resolved: boolean) => (await api.patch(`/proofs/${id}/resolve`, { resolved })).data,
  remove: async (id: string) => {
    await api.delete(`/proofs/${id}`);
  }
};

/* ---------- Unauthenticated surfaces ---------- */

/**
 * A bare axios instance for the two pages a person with no account can open.
 *
 * Deliberately NOT the shared `api` client: that one sends credentials and runs a 401-refresh
 * interceptor, which would bounce a submitter to the login screen the moment anything returned
 * 401 — on a page where there is nothing to log in to.
 */
const publicClient = axios.create({ baseURL: api.defaults.baseURL, withCredentials: false });

export interface PublicRequestForm {
  name: string;
  description: string | null;
  intro: string | null;
  confirmation: string | null;
  fields: RequestFormFieldRow[];
}

export const publicFormApi = {
  get: async (token: string) => (await publicClient.get<PublicRequestForm>(`/shared/request-forms/${token}`)).data,
  submit: async (token: string, payload: { submitterName?: string; submitterEmail?: string; answers: Record<string, unknown> }) =>
    (await publicClient.post<{ reference: string; confirmation: string }>(`/shared/request-forms/${token}`, payload)).data
};

export interface GuestApproval {
  title: string;
  description: string | null;
  dueAt: string | null;
  reviewerEmail: string | null;
  item: {
    reference: string;
    title: string;
    description: string | null;
    attachments: Array<{ id: string; fileName: string; mimeType: string; url: string }>;
  } | null;
}

export const guestApprovalApi = {
  get: async (token: string) => (await publicClient.get<GuestApproval>(`/shared/approvals/${token}`)).data,
  decide: async (token: string, decision: "APPROVED" | "REJECTED", comment?: string) =>
    (await publicClient.post<{ ok: boolean; decision: string }>(`/shared/approvals/${token}`, { decision, comment })).data
};

/* ------------------------------------------------------------------ *
 * AI PM COPILOT (V6 phase 5)
 *
 * Two things live here and they are deliberately different in kind. Risk is ARITHMETIC — it works
 * with AI switched off entirely, and `narrative` is simply null in that case. Proposals are the
 * only way an AI feature reaches the plan, and they never apply themselves.
 * ------------------------------------------------------------------ */

export type RiskBandValue = "GREEN" | "AMBER" | "RED";

export interface RiskSignalRow {
  key: "scheduleSlip" | "budgetOverrun" | "blockedWork" | "overAllocation" | "slaBreaches" | "reopenRate";
  /** 0-1. */
  severity: number;
  /** severity × weight — what this signal contributed to the total. */
  points: number;
  detail: Record<string, number | string | null>;
  /** One actionable sentence, or "" when the signal is clean. */
  note: string;
}

export interface ProjectRisk {
  projectId: string;
  projectName: string;
  projectCode: string;
  riskScore: number;
  band: RiskBandValue;
  signals: RiskSignalRow[];
  /** Worst-first — reads as what to fix, in order. */
  topConcerns: string[];
  facts: Record<string, number | string | null>;
  /** Null whenever AI is off, unavailable, or over budget. The score is never lost with it. */
  narrative: string | null;
  snapshotId?: string;
}

export interface RiskSnapshotRow {
  projectId: string;
  riskScore: number;
  band: RiskBandValue;
  computedAt: string;
  narrative: string | null;
}

export interface AiProposalChangeRow {
  id: string;
  targetType: "TICKET" | "PROJECT" | "BOOKING" | "LINK";
  targetId: string | null;
  op: "CREATE" | "UPDATE" | "LINK";
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  summary: string;
  /** Null = not yet decided. Nothing is accepted by default. */
  accepted: boolean | null;
  appliedAt: string | null;
  /** Set when application was attempted and refused — usually a stale before-state. */
  applyError: string | null;
  undoneAt: string | null;
  /** Why this row could not be put back — almost always "somebody changed it since". */
  undoError: string | null;
  order: number;
}

export interface AiProposalRow {
  id: string;
  kind: "PLAN_BREAKDOWN" | "SCHEDULE_ADJUSTMENT" | "ASSIGNMENT_REBALANCE" | "RISK_MITIGATION" | "BLUEPRINT_SUGGESTION";
  title: string;
  rationale: string | null;
  confidence: number | null;
  model: string | null;
  status: "PENDING_REVIEW" | "PARTIALLY_APPLIED" | "APPLIED" | "REJECTED" | "EXPIRED" | "UNDONE" | "PARTIALLY_UNDONE";
  createdAt: string;
  expiresAt: string | null;
  reviewedAt: string | null;
  requestedBy: { id: string; name: string } | null;
  reviewedBy: { id: string; name: string } | null;
  scopeProject: { id: string; code: string; name: string } | null;
  scopeTicket: { id: string; key: string; title: string } | null;
  changes: AiProposalChangeRow[];
}

export interface ApplyProposalResult {
  applied: number;
  skipped: number;
  failed: Array<{ id: string; summary: string; reason: string }>;
  status: "APPLIED" | "PARTIALLY_APPLIED" | "REJECTED";
}

export interface UndoProposalResult {
  undone: number;
  /** Rows that could not be put back, each with the reason — nearly always that somebody has
   *  edited the row since, in which case reverting it would erase THEIR change. */
  refused: Array<{ id: string; summary: string; reason: string }>;
  status: "UNDONE" | "PARTIALLY_UNDONE";
}

export const copilotApi = {
  /** `narrate` costs a model call; the score does not. */
  risk: async (projectId: string, narrate = false) =>
    (await api.get<ProjectRisk>(`/ai-proposals/risk/${projectId}`, { params: narrate ? { narrate: "true" } : undefined })).data,
  riskSnapshots: async () => (await api.get<RiskSnapshotRow[]>("/ai-proposals/risk")).data,
  refreshRisk: async (projectId: string) => (await api.post<ProjectRisk>(`/ai-proposals/risk/${projectId}/refresh`)).data,

  listProposals: async (params?: { status?: string; projectId?: string }) =>
    (await api.get<AiProposalRow[]>("/ai-proposals", { params })).data,
  planBreakdown: async (payload: { projectId: string; parentTicketId?: string | null; goal: string; context?: string }) =>
    (await api.post<AiProposalRow>("/ai-proposals/plan-breakdown", payload)).data,
  /** Save per-row decisions without applying, so a long review can be done in sittings. */
  saveDecisions: async (id: string, decisions: Record<string, boolean>) =>
    (await api.patch<{ updated: number }>(`/ai-proposals/${id}/decisions`, { decisions })).data,
  apply: async (id: string, decisions: Record<string, boolean>) =>
    (await api.post<ApplyProposalResult>(`/ai-proposals/${id}/apply`, { decisions })).data,
  reject: async (id: string) => (await api.post(`/ai-proposals/${id}/reject`)).data,
  /** Put back what an applied proposal changed. Refuses per row rather than wholesale: a field
   *  somebody has edited since is deliberately left alone, because reverting it would clobber
   *  them exactly the way applying a stale row would have. */
  undo: async (id: string) => (await api.post<UndoProposalResult>(`/ai-proposals/${id}/undo`)).data
};

/* ------------------------------------------------------------------ *
 * DASHBOARDS & SCHEDULED DELIVERY (V6 phase 6)
 *
 * A dashboard stores a LAYOUT, never data. Every widget resolves against the viewer's own project
 * scope on the server, so sharing one can never share a project somebody was not already allowed
 * to see — which is what makes sharing safe to do casually.
 * ------------------------------------------------------------------ */

export const WIDGET_TYPES = [
  "OPEN_ITEMS",
  "OVERDUE_ITEMS",
  "HOURS_LOGGED",
  "BUDGET_BURN",
  "VELOCITY",
  "STATUS_MIX",
  "RISK_BANDS",
  "WORKLOAD_SUMMARY",
  "UPCOMING_MILESTONES",
  "MY_QUEUE"
] as const;
export type WidgetTypeValue = (typeof WIDGET_TYPES)[number];

/** Shape decides which component draws it, so a new STAT widget needs no new UI. */
export type WidgetShapeValue = "STAT" | "SERIES" | "BREAKDOWN" | "TABLE";

export interface WidgetDescriptorRow {
  type: WidgetTypeValue;
  label: string;
  shape: WidgetShapeValue;
  description: string;
}

export interface DashboardWidgetSpec {
  id: string;
  type: WidgetTypeValue;
  title?: string;
  config?: { projectId?: string | null; days?: number };
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

export interface DashboardRow {
  id: string;
  ownerId: string;
  owner?: { id: string; name: string } | null;
  name: string;
  scope: "PERSONAL" | "SHARED";
  isDefault: boolean;
  widgets: DashboardWidgetSpec[];
}

export interface ResolvedWidget {
  id: string;
  title: string;
  type: WidgetTypeValue;
  shape: WidgetShapeValue;
  value?: number | string | null;
  unit?: string | null;
  hint?: string | null;
  points?: Array<{ label: string; value: number; secondary?: number }>;
  rows?: Array<Record<string, string | number | null>>;
  /** Set when the tile could not be computed. Shown instead of a zero — a zero is a claim. */
  unavailable?: string;
}

export interface ReportSubscriptionRow {
  id: string;
  name: string;
  dashboardId: string | null;
  dashboard?: { id: string; name: string } | null;
  cadence: "DAILY" | "WEEKLY" | "MONTHLY";
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  hourUtc: number;
  recipients: string[];
  isActive: boolean;
  lastSentAt: string | null;
  lastSendError: string | null;
}

export const dashboardApi = {
  catalogue: async () => (await api.get<WidgetDescriptorRow[]>("/dashboards/catalogue")).data,
  list: async () => (await api.get<DashboardRow[]>("/dashboards")).data,
  /** Layout plus resolved data in one request — a grid of eight tiles fetched separately would be
   *  eight round trips on every page load. */
  data: async (id: string) => (await api.get<{ dashboard: DashboardRow; widgets: ResolvedWidget[] }>(`/dashboards/${id}/data`)).data,
  create: async (payload: { name: string; scope?: string; isDefault?: boolean; widgets: DashboardWidgetSpec[] }) =>
    (await api.post<DashboardRow>("/dashboards", payload)).data,
  update: async (id: string, payload: { name: string; scope?: string; isDefault?: boolean; widgets: DashboardWidgetSpec[] }) =>
    (await api.put<DashboardRow>(`/dashboards/${id}`, payload)).data,
  remove: async (id: string) => {
    await api.delete(`/dashboards/${id}`);
  },

  subscriptions: async () => (await api.get<ReportSubscriptionRow[]>("/dashboards/subscriptions/all")).data,
  createSubscription: async (payload: {
    name: string;
    dashboardId: string;
    cadence?: "DAILY" | "WEEKLY" | "MONTHLY";
    dayOfWeek?: number | null;
    dayOfMonth?: number | null;
    hourUtc?: number;
    recipients: string[];
  }) => (await api.post<ReportSubscriptionRow>("/dashboards/subscriptions", payload)).data,
  removeSubscription: async (id: string) => {
    await api.delete(`/dashboards/subscriptions/${id}`);
  }
};
