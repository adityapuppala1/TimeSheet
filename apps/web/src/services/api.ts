import axios, { type AxiosRequestConfig } from "axios";
import type { BulkUploadResult } from "../components/CsvBulkUploadDialog";
import type {
  AiProposalTargetType,
  ApiKeyScope,
  AuthUser,
  ChatIntegrationRow,
  ChatMatchType,
  ChatPlatform,
  ChatRoutingRuleRow,
  ChangeBand,
  ChangeKind,
  ChangeOutcome,
  ChangeState,
  EmailIntakeSettings,
  EmailMatchType,
  EmailRoutingRuleRow,
  GlobalAISettings,
  GlobalSettings,
  GlobalTicketSettings,
  ModuleAssigneeRuleRow,
  OutboundWebhookEvent,
  RoleName,
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
/** Exported so a page can build a plain download link. A fetch-then-blob download would have to
 *  re-attach auth and hold the whole file in memory; an anchor lets the browser stream it and honour
 *  the server's Content-Disposition. */
export const API_BASE_URL = import.meta.env.VITE_API_URL ?? "/api";

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

/** A value the API may hand back as either a JS number or a string (Prisma Decimal serialized
 *  over JSON), or omit — shared by the several "amount" fields below rather than repeating the
 *  union at each one. */
export type NumericOrString = number | string | null;

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

/** True when a failure is the server saying "this workspace's plan has lapsed" (402 + code
 *  PLAN_LAPSED) rather than anything wrong with the request. Same contract, and the same reason,
 *  as `isMaintenanceLockoutError` above: the interceptor is already navigating away, so a caller
 *  that toasts on this would flash a misleading error on the way out. */
export function isPlanLapsedError(error: unknown): boolean {
  const err = error as { response?: { status?: number; data?: { code?: string } } } | undefined;
  return err?.response?.status === 402 && err.response.data?.code === "PLAN_LAPSED";
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

    // 402 + PLAN_LAPSED is the billing equivalent, and needs the same treatment for the same
    // reasons: a full navigation, no token refresh (the session is fine — it is the plan that is
    // not), and no retry. Without this the workspace does not look "locked", it looks BROKEN:
    // every panel renders an error and nothing on screen says why. The pathname guard is what
    // stops /plan-lapsed's own requests from redirecting to itself forever.
    if (isPlanLapsedError(error) && window.location.pathname !== "/plan-lapsed") {
      window.location.assign("/plan-lapsed");
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
  ipAddress: string | null;
  createdAt: string;
  expiresAt: string;
  /** Last authenticated request on this session — what makes "which of these is stale?" a
   *  question the list can answer. Null on a session that has not been used since the column
   *  existed. */
  lastSeenAt: string | null;
  current: boolean;
  /**
   * Decoded server-side (`utils/user-agent.ts`) rather than shipped as a raw UA string for the
   * page to parse. The raw string was a wall of "Mozilla/5.0 (Windows NT 10.0; Win64; x64)
   * AppleWebKit/537.36…" — complete and unreadable — and it is a fingerprinting surface with no
   * remaining purpose once the label exists.
   */
  device: string;
  browser: string;
  os: string;
  formFactor: "desktop" | "mobile" | "tablet" | "unknown";
  /** True for loopback/RFC1918/CGNAT addresses. On a LAN deployment every address is a 192.168.x
   *  and a column of them tells the reader nothing; this is what makes "on your network" sayable. */
  privateNetwork: boolean;
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
  /** "github" = every listed version was also known to the live release feed; "changelog" = this
   *  build's own bundled history alone (complete up to the running version, blind to anything
   *  newer); "mixed" = the bundle supplied versions GitHub hasn't been tagged with yet, which is
   *  the normal state between cutting a release and pushing its tag; null = nothing at all. */
  releasesSource: "github" | "changelog" | "mixed" | null;
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
  /** Self-service switch among roles the account already holds — granting a NEW role is
   *  SUPER_ADMIN-only, from User Management (userApi.create/update's `roles` field below). */
  switchRole: async (role: RoleName) => (await api.post<AuthUser>("/auth/switch-role", { role })).data,
  logout: async () => api.post("/auth/logout"),
  logoutAll: async () => api.post("/auth/logout-all"),
  sessions: async () => (await api.get<SessionRow[]>("/auth/sessions")).data,
  revokeSession: async (id: string) => api.delete(`/auth/sessions/${id}`),
  forgotPassword: async (email: string) => (await api.post("/auth/forgot-password", { email })).data,

  /* --- Workspace discovery (3.6.0) ---------------------------------------------------------
     Two steps on purpose. `start` answers identically whether or not the address matched — the
     list is only reachable by returning a code sent to that address, so the endpoint cannot be
     used to ask "does bob@acme.com exist, and where does he work". */
  findWorkspacesStart: async (email: string) =>
    (await api.post<{ token: string; message: string }>("/auth/workspaces/start", { email })).data,
  findWorkspacesVerify: async (token: string, code: string) =>
    (await api.post<{ workspaces: Array<{ slug: string; name: string; url: string }> }>("/auth/workspaces/verify", { token, code })).data,

  /* --- Self-serve signup (3.6.0) ------------------------------------------------------------
     Two steps for the same verify-first reason discovery has, and one more besides: `complete`
     provisions a database, so nothing should reach it that has not proven an inbox first. */
  signupStart: async (email: string) =>
    (await api.post<{ token: string; message: string }>("/signup/start", { email })).data,
  signupComplete: async (payload: {
    token: string;
    code: string;
    workspaceName: string;
    slug: string;
    adminName: string;
    adminPassword: string;
  }) => (await api.post<{ slug: string; url: string; trialEndsAt: string; trialDays: number }>("/signup/complete", payload)).data,
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

/** The workspace's own logo + display name. The GET half is public — the login page renders it
 *  before anyone signs in (see controllers/branding.controller.ts for why that is the design). */
export interface WorkspaceBranding {
  displayName: string | null;
  hasLogo: boolean;
  /** Changes on every upload; used as a cache-busting query param on the image URL. */
  logoVersion: number | null;
}

/** Absolute URL for the logo image, or null when none is set. Not a `/uploads` path: branding is
 *  served by its own route precisely because `/uploads` needs a signed grant. */
export function brandingLogoUrl(branding?: WorkspaceBranding | null): string | null {
  if (!branding?.hasLogo) return null;
  return apiUrl(`/branding/logo?v=${branding.logoVersion ?? 0}`);
}

export const brandingApi = {
  get: async () => (await api.get<WorkspaceBranding>("/branding")).data,
  setName: async (displayName: string | null) => (await api.patch<WorkspaceBranding>("/branding", { displayName })).data,
  uploadLogo: async (file: File) => {
    const form = new FormData();
    form.append("logo", file);
    return (await api.post<WorkspaceBranding>("/branding/logo", form, { headers: { "Content-Type": "multipart/form-data" } })).data;
  },
  removeLogo: async () => (await api.delete<WorkspaceBranding>("/branding/logo")).data
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
  /** Inbox triage (V8 phase 2). `readAt` is about attention; `handledAt` is about work — see
   *  the schema comment on Notification. */
  handledAt?: string | null;
  snoozedUntil?: string | null;
}

/* ---- Inbox and the daily brief (V8 phase 2) ----------------------------------------------- */

export type InboxFilterValue = "unhandled" | "snoozed" | "handled" | "all";

export interface InboxCounts {
  unhandled: number;
  snoozed: number;
  handled: number;
  unread: number;
}

export interface BriefSection {
  key: string;
  label: string;
  count: number;
  link: string | null;
  detail: string | null;
  tone: "attention" | "ok";
}

export interface DailyBrief {
  generatedAt: string;
  allClear: boolean;
  sections: BriefSection[];
}

export const inboxApi = {
  list: async (filter: InboxFilterValue) =>
    (await api.get<{ items: Notification[]; counts: InboxCounts }>("/inbox", { params: { filter } })).data,
  brief: async () => (await api.get<DailyBrief>("/inbox/brief")).data,
  /** Every field is optional and independent: handling, reading and snoozing are three different
   *  statements about one row. Returns the fresh counts so the tab badges cannot drift. */
  update: async (id: string, patch: { handled?: boolean; read?: boolean; snoozeUntil?: string | null }) =>
    (await api.patch<InboxCounts>(`/inbox/${id}`, patch)).data,
  handleAll: async () => (await api.post<InboxCounts>("/inbox/handle-all")).data
};

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

/** One attachment on a timesheet entry. `url` arrives already signed — every `/uploads/...` path
 *  leaving the API in a JSON body is rewritten into an expiring, org-bound link (see app.ts), so
 *  a plain `<a href>` downloads it and a stale link fails closed with a message that says so. */
export interface TimesheetAttachmentRow {
  id: string;
  fileName: string;
  mimeType: string;
  url: string;
  sizeBytes: number;
  createdAt: string;
  uploadedBy?: { id: string; name: string } | null;
}

/** The full entry behind the approvals queue, the history table and the dashboard's day
 *  timeline — all three now open the same dialog, so they need the same shape. */
export interface TimesheetEntryDetail {
  id: string;
  userId: string;
  status: "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED";
  activityType: string;
  taskDescription: string;
  notes: string | null;
  workDate: string;
  startTime: string;
  endTime: string;
  totalHours: string | number;
  billable: boolean;
  rejectionReason: string | null;
  submittedAt: string | null;
  reviewedAt: string | null;
  updatedAt: string;
  projectId: string;
  moduleId: string;
  submoduleId: string | null;
  ticketId: string | null;
  project?: { id: string; name: string; code?: string } | null;
  module?: { id: string; name: string } | null;
  submodule?: { id: string; name: string } | null;
  ticket?: { id: string; key: string; title: string } | null;
  user?: { id: string; name: string; email: string; avatarUrl?: string | null; role?: string } | null;
  reviewedBy?: { id: string; name: string; email: string } | null;
  /** Who last corrected the entry, and when. Null on one nobody has edited — which is what the
   *  UI should say, rather than inventing an editor from the create path. */
  lastEditedBy?: { id: string; name: string; email: string } | null;
  lastEditedAt?: string | null;
  attachments: TimesheetAttachmentRow[];
  identityVerified: boolean;
  identityVerifiedAt: string | null;
  identityVerificationApplies: boolean;
}

/** Everything PATCH /timesheets/:id accepts. Every field optional — the server merges onto the
 *  stored row and validates the RESULT, so a dialog can send only what the user touched. */
export interface TimesheetEntryPatch {
  projectId?: string;
  moduleId?: string;
  submoduleId?: string | null;
  ticketId?: string | null;
  activityType?: string;
  taskDescription?: string;
  workDate?: string;
  startTime?: string;
  endTime?: string;
  notes?: string;
}

/** The date window the dashboard endpoints accept, as ISO `yyyy-mm-dd`. Omitted entirely, each one
 *  falls back to the window it used before the home page had a filter. */
export interface DateWindow {
  from?: string;
  to?: string;
}

export interface TimesheetListParams extends DateWindow {
  /**
   * `team` asks the server for the role-appropriate set rather than the caller's own guess:
   * everyone for an admin, self plus direct reports for a manager, and just themselves for anyone
   * who manages nobody. Omitted, the route returns exactly what it always did.
   */
  scope?: "team";
}

export const timesheetApi = {
  /** With a window, the server filters AND raises its row cap. Without one it returns the newest
   *  page, as before — which is why a range must never be filtered in the browser instead. */
  list: async (params?: TimesheetListParams) => (await api.get("/timesheets", { params })).data,
  /** One entry by id, with attachments, reviewer and identity badge. Used by the entry dialog
   *  rather than a lookup in the list cache: the list is capped at 100 rows, so an older entry
   *  reached by deep link simply is not in it. */
  get: async (id: string) => (await api.get<TimesheetEntryDetail>(`/timesheets/${id}`)).data,
  /** Move an existing DRAFT into the approval queue.
   *
   *  Without this, "Save draft" was a one-way door: `saveTimesheet` only ever CREATES rows, so a
   *  draft could be edited forever and never submitted. Runs the same identity gate, SLA deadline
   *  and notifications a fresh submit runs, because it is the same event. */
  submitDraft: async (id: string, faceVerificationId?: string) =>
    (await api.post<TimesheetEntryDetail>(`/timesheets/${id}/submit`, faceVerificationId ? { faceVerificationId } : {})).data,
  /** Correct an entry after the fact. The author may edit their own DRAFT/REJECTED entries;
   *  anyone with timesheets:approve may edit any entry in any status, and every change is
   *  audited field-by-field with the submitter notified. */
  update: async (id: string, payload: TimesheetEntryPatch) =>
    (await api.patch<TimesheetEntryDetail>(`/timesheets/${id}`, payload)).data,
  attachments: {
    upload: async (id: string, files: File[]) => {
      const form = new FormData();
      files.forEach((file) => form.append("attachments", file));
      return (
        await api.post<TimesheetEntryDetail>(`/timesheets/${id}/attachments`, form, {
          headers: { "Content-Type": "multipart/form-data" }
        })
      ).data;
    },
    remove: async (id: string, attachmentId: string) => api.delete(`/timesheets/${id}/attachments/${attachmentId}`)
  },
  submit: async (payload: unknown, draft = false) => (await api.post(`/timesheets/${draft ? "draft" : "submit"}`, payload)).data,
  submitForm: async (payload: FormData, draft = false) =>
    (
      await api.post(`/timesheets/${draft ? "draft-with-files" : "submit-with-files"}`, payload, {
        headers: { "Content-Type": "multipart/form-data" }
      })
    ).data,
  /** One decision across a ticked selection — per-row independence server-side, so "already
   *  decided while you were reading" refuses that row alone and the rest land. On a face-gated
   *  workspace ONE verification covers the batch: the check asserts the approver's presence at
   *  decision time, not once per row. */
  decideBulk: async (payload: { ids: string[]; decision: "approve" | "reject"; reason?: string; faceVerificationId?: string }) =>
    (await api.patch<{ done: number; failed: Array<{ id: string; reason: string }> }>("/timesheets/decide-bulk", payload)).data,
  approve: async (id: string, faceVerificationId?: string) =>
    (await api.patch(`/timesheets/${id}/approve`, faceVerificationId ? { faceVerificationId } : {})).data,
  reject: async (id: string, reason: string) => (await api.patch(`/timesheets/${id}/reject`, { reason })).data,
  /** DRAFT and REJECTED entries only — the API refuses SUBMITTED (awaiting a decision) and
   *  APPROVED (part of the billing record). Soft delete; the time slot frees up immediately. */
  remove: async (id: string) => api.delete(`/timesheets/${id}`)
};

export interface DailyStatus {
  date: string;
  /** The window this answers for. Echoed back so the card can label itself — it cannot infer the
   *  period from the numbers, and a card reading "today" over a month of data is simply wrong. */
  from?: string;
  to?: string;
  days?: number;
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
  admin: async (params?: DateWindow) => (await api.get("/reports/admin-summary", { params })).data,
  employee: async () => (await api.get("/reports/employee-summary")).data,
  dailyStatus: async (params?: DateWindow) => (await api.get<DailyStatus>("/reports/daily-status", { params })).data,
  tickets: async () => (await api.get<TicketSummary>("/reports/ticket-summary")).data,
  ticketInsights: async () => (await api.get<TicketInsights>("/reports/ticket-insights")).data,
  securityInsights: async () => (await api.get<SecurityInsights>("/reports/security-insights")).data,
  sbomInventory: async () => (await api.get<SbomInventory>("/reports/sbom-inventory")).data,
  costInsights: async () => (await api.get<CostInsights>("/reports/cost-insights")).data,
  leaderboard: async () => (await api.get<{ rows: LeaderboardRow[] }>("/reports/leaderboard")).data,
  /** An empty `projectId` is the ALL-PROJECTS request, not a missing argument — the server reads it
   *  as "the whole portfolio" and answers with a summary plus a section per project. */
  statusReport: async (projectId: string, periodDays = 7) =>
    (
      await api.post<{
        report: string;
        projectName: string;
        periodLabel: string;
        truncated: boolean;
        projectCount: number;
      }>("/reports/status-report", { projectId, periodDays })
    ).data,
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
  /// Every role this account may hold/switch into — always includes role.name. Length 1 unless a
  /// super admin has explicitly granted more (see UserRole in schema.prisma).
  heldRoles: RoleName[];
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
  /** Rows to skip. Bounded server-side — this is a drill-down, not a log export. */
  offset?: number;
}

export const apiPerformanceApi = {
  /** SUPER_ADMIN. Aggregated server-side — the response carries percentiles and buckets, never
   *  raw samples, however wide the window. */
  overview: async (hours = 24) =>
    (await api.get<ApiPerformanceOverview>("/maintenance/api-performance", { params: { hours } })).data,
  /** The drill-down after the aggregates point somewhere. Server-capped at 200 rows. */
  requests: async (query: ApiRequestQuery) =>
    (await api.get<{ since: string; total: number; limit: number; offset: number; rows: ApiRequestRow[] }>("/maintenance/api-performance/requests", { params: query })).data
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
  /** Which agent on the roster owns this capability, when one does. Display-only — the lever is
   *  still this screen — but it turns "some capability" into "🗂️ Triage's ticket triage", so the
   *  consequence of lowering a level here is visible before it is made. */
  claimedBy: { profileId: string; name: string; emoji: string } | null;
  /** The GlobalAISettings switch behind this capability, so one row can carry both controls.
   *  Null for a capability that reaches no model. */
  featureToggle: string | null;
}

export interface AutonomyCatalogue {
  autonomyEnabled: boolean;
  capabilities: AutonomyEntry[];
}

/** One provider×model combination's usage over the picked range — one row of the usage table. */
/** One entry in the ranked BYOK list (Workspace Settings → AI). `callChat` tries ENABLED rows in
 *  ascending `priority` order; only the top one ever honors a feature's requested model — every
 *  row after it uses its own `model`, since a fallback was chosen for a different vendor's
 *  catalogue and is unlikely to serve a model by the primary's name at all. */
/** "Is it working right now" — derived from the last 15 minutes of real traffic, not the 30-day
 *  history the "Suggest order" reasoning uses. `"unknown"` means no attempts in that window, not a
 *  problem: a freshly-added row, or one sitting low-priority long enough not to have been tried. */
export type ProviderHealthStatus = "healthy" | "degraded" | "down" | "unknown";

export interface AIProviderConfigRow {
  id: string;
  provider: "ANTHROPIC" | "OPENAI_COMPATIBLE";
  label: string | null;
  baseUrl: string | null;
  model: string;
  enabled: boolean;
  priority: number;
  apiKeySet: boolean;
  status: ProviderHealthStatus;
  /** Set the moment the circuit breaker demoted this row; cleared by any human edit or reorder. */
  autoDemotedAt: string | null;
  /** How many calls may run at once against this provider before the rest queue or fall over to
   *  the next one. Match it to the provider's real parallelism (for Ollama, OLLAMA_NUM_PARALLEL). */
  maxConcurrent: number;
  createdAt: string;
  updatedAt: string;
}

export interface AIProviderConfigInput {
  provider: "ANTHROPIC" | "OPENAI_COMPATIBLE";
  label?: string | null;
  baseUrl?: string | null;
  model: string;
  apiKey?: string;
  enabled?: boolean;
  maxConcurrent?: number;
}

/** One provider's real 30-day track record, behind the "Suggest order" recommendation. */
export interface SuggestedProviderOrderEntry {
  id: string;
  label: string;
  /** null = no calls in the window — neither good nor bad, just unproven. */
  successRatePct: number | null;
  avgLatencyMs: number | null;
  avgCostUsd: number | null;
  calls: number;
}

export interface AIUsageRow {
  provider: string;
  model: string;
  /** Every ATTEMPT against this provider×model, successful or not. */
  calls: number;
  successCount: number;
  failureCount: number;
  /** null = zero calls in this group — "never tried" and "fails every time" are different claims;
   *  render "n/a", never "0%". */
  successRatePct: number | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** null = no call in this group had a measured duration — render "not measured", never 0ms. */
  avgLatencyMs: number | null;
  /** How many of `calls` contributed to avgLatencyMs, so "842ms" can be qualified with "measured
   *  on 8 of 10 calls" rather than implying every call was timed. */
  latencyMeasuredCalls: number;
  costUsd: number;
  costSharePct: number;
}

export interface AIUsageBreakdown {
  /** Inclusive range actually reported — echoes back whatever from/to were requested. */
  from: string;
  to: string;
  totalCostUsd: number;
  /** Every ATTEMPT in the range, successful or not — see AIUsageRow.calls. */
  totalCalls: number;
  totalFailures: number;
  /** null = zero calls in the range at all. */
  overallSuccessRatePct: number | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** The agent-driven SHARE of the totals above — a subset, never an addition. Without this the panel
   *  can say a workspace spent $40 but not whether that was forty people using refine or one teammate
   *  running unattended all month. */
  agentDriven: { costUsd: number; calls: number; inputTokens: number; outputTokens: number };
  /** Options for the feature filter, with a call count — scoped to the date range only, so picking
   *  one feature never collapses this list down to just that entry. */
  features: Array<{ feature: string; calls: number }>;
  /** The provider×model cross-tab — one row per combination actually used in the range. */
  rows: AIUsageRow[];
  /** Per-workflow spend, attributed through the agent runs each flow queued. A subset of
   *  `agentDriven`, and read from a different table — the usage log records what was asked of a model,
   *  not who composed the question. */
  byFlow: Array<{ flowId: string; name: string; emoji: string; costUsd: number; runs: number }>;
}

/** One week's spend, split by provider — `weekStart` plus one numeric key per provider name seen
 *  in the range (dynamic keys, since the provider set isn't known ahead of time). */
export interface AIUsageTrendWeek {
  weekStart: string;
  [provider: string]: string | number;
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
  /** The rating `listPromotableInteractions` filters on ("down" = a problem worth correcting).
   *  The endpoint predates any web caller — the signal it reads could never be produced from the
   *  UI until the candidates browser grew its thumbs. Null clears a rating. */
  setInteractionFeedback: async (id: string, feedback: "up" | "down" | null) =>
    (await api.patch<{ id: string; feedback: "up" | "down" | null }>(`/ai/interactions/${id}/feedback`, { feedback })).data,
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


/** The 4-tier scale reused for a ticket's priority, a VAPT finding's severity, and a Requirements
 *  Studio feature's priority — one alias rather than the same four literals repeated per call
 *  site (sonarjs/use-type-alias). */
export type PriorityLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/// General-purpose if/then automation on manually-created tickets — see
/// prisma/schema.prisma's TicketRule doc comment (apps/api) for the full evaluation model.
export interface TicketRuleRow {
  id: string;
  name: string;
  isActive: boolean;
  order: number;
  conditionProjectId: string | null;
  conditionProject: { id: string; name: string; code: string } | null;
  conditionPriority: PriorityLevel | null;
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
  conditionPriority?: PriorityLevel | null;
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
  /** The ranked BYOK list, ascending priority — what `callChat` actually tries in order. */
  listAiProviders: async () => (await api.get<AIProviderConfigRow[]>("/settings/ai/providers")).data,
  createAiProvider: async (payload: AIProviderConfigInput) => (await api.post<AIProviderConfigRow>("/settings/ai/providers", payload)).data,
  /** `apiKey` write-only, same convention as updateAI: omit to leave the stored key untouched. */
  updateAiProvider: async (id: string, payload: Partial<AIProviderConfigInput>) =>
    (await api.patch<AIProviderConfigRow>(`/settings/ai/providers/${id}`, payload)).data,
  deleteAiProvider: async (id: string) => api.delete(`/settings/ai/providers/${id}`),
  /** Rewrites priority to match this exact order — the whole list, not a delta. */
  reorderAiProviders: async (orderedIds: string[]) =>
    (await api.post<AIProviderConfigRow[]>("/settings/ai/providers/reorder", { orderedIds })).data,
  /** A RECOMMENDATION over the last 30 days of real usage — never applied automatically. Call
   *  reorderAiProviders yourself with `suggestedOrderIds` once the admin accepts it. */
  getSuggestedAiProviderOrder: async () =>
    (await api.get<{ suggestedOrderIds: string[]; reasoning: SuggestedProviderOrderEntry[] }>("/settings/ai/providers/suggested-order")).data,
  /** A real, on-demand connectivity check — separate from the passive `status` field, which is
   *  derived from actual traffic. Costs nothing (a models-list metadata call, no completion). */
  testAiProvider: async (id: string) =>
    (await api.post<{ ok: boolean; latencyMs: number; message: string }>(`/settings/ai/providers/${id}/test`)).data,
  /** How much authority each AI capability holds, as opposed to whether it runs at all.
   *  The server returns BOTH `requestedLevel` and `effectiveLevel`; the UI must render the
   *  second and never re-derive it, or the screen will eventually disagree with the server. */
  getAIAutonomy: async () => (await api.get<AutonomyCatalogue>("/settings/ai/autonomy")).data,
  /** 422s when `level` is above the capability's ceiling — that refusal is the point, so the
   *  caller should surface the server's message rather than a generic one. */
  updateAIAutonomy: async (payload: { capability: string; level: AutonomyLevel }) =>
    (await api.patch<AutonomyEntry>("/settings/ai/autonomy", payload)).data,
  getAIUsageSummary: async (params: { from: string; to: string; feature?: string }) =>
    (await api.get<AIUsageBreakdown>("/settings/ai/usage-summary", { params })).data,
  /** AI QUALITY (not cost) — see api/src/services/ai-quality.service.ts for why the headline
   *  number is parse-failure rate rather than thumbs-up rate. */
  getAIQualitySummary: async (windowDays = 30) =>
    (await api.get<AIQualitySummary>("/settings/ai/quality-summary", { params: { windowDays } })).data,
  getAIUsageTrend: async (params: { from: string; to: string }) =>
    (await api.get<{ providerNames: string[]; weeks: AIUsageTrendWeek[] }>("/settings/ai/usage-trend", { params })).data,
  /** A BLOB through the authenticated axios instance, never an `<a href>` — same reasoning as
   *  changeApi.download: this app keeps its access token in memory, so a bare link would reach
   *  the export route with no Authorization header and 401. */
  downloadAiUsageExcel: async (params: { from: string; to: string; feature?: string }) => {
    const res = await api.get("/settings/ai/usage-export.xlsx", { params, responseType: "blob" });
    return { blob: res.data as Blob, rowsIncluded: Number(res.headers["x-export-rows-included"] ?? 0) };
  },
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
  /** Tests the SAVED configuration, not what is in the form — see the route's own comment for why
   *  a pass recorded against unsaved values would be exactly the false assurance to avoid. */
  /** Is clamd actually reachable? Same contract as the mail and SSO testers: a failure is an
   *  answer, not an exception. Worth checking BEFORE switching scanning on, because the setting
   *  fails closed — an unreachable scanner refuses every upload in the workspace. */
  testVirusScanner: async () =>
    (await api.post<{ ok: boolean; message: string; version?: string }>("/settings/security/virus-scan/test")).data,

  testSso: async (provider: "google" | "microsoft" | "saml" | "ldap", payload: { probeEmail?: string } = {}) =>
    (await api.post<SsoTestResult>(`/settings/sso/${provider}/test-connection`, payload)).data,

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
      severity: PriorityLevel;
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
  createApiKey: async (payload: { name: string; scope: ApiKeyScope; expiresAt?: string }) =>
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
  /** Null means it never expires — every key issued before expiry existed reads that way. */
  expiresAt: string | null;
  createdBy: { id: string; name: string } | null;
}
export interface ApiKeyCreated {
  id: string;
  name: string;
  scope: ApiKeyScope;
  expiresAt: string | null;
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
  /** Sending throttle — simultaneous SMTP connections, and messages per window across the pool.
   *  These are what keep a burst (a bulk approval, the daily reminder sweep) from opening one
   *  connection per message and earning the provider's rate limit. */
  maxConnections: number;
  maxMessagesPerWindow: number;
  rateWindowMs: number;
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

  /* --- Proof that this configuration works (3.6.0) --------------------------------------- */
  /** Last connection test: a DIAGNOSTIC. Green here does not mean sign-in works — see below. */
  lastTestedAt: string | null;
  lastTestStatus: "PASS" | "FAIL" | null;
  lastTestMessage: string | null;
  /**
   * When a real person last completed a sign-in through this provider, and the ONLY thing that
   * unlocks "Require SSO". A connection test cannot fill that role: Azure AD answers a probe with
   * `invalid_grant` before it looks at the client credentials, so a Microsoft config holding two
   * junk strings tests green.
   */
  lastSuccessfulLoginAt: string | null;
  /** Parsed facts about the SAML signing certificate. Null for every other provider. */
  certificate: {
    subject: string;
    issuer: string;
    validFrom: string;
    validTo: string;
    expired: boolean;
    expiringSoon: boolean;
    fingerprint: string;
  } | null;
}

export interface SsoTestResult {
  ok: boolean;
  message: string;
  detail?: Record<string, string | number | boolean>;
  testedAt: string;
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
  /** What this workspace SENDS when nothing has been customised — the real shipped email with its
   *  `{{placeholders}}`. The editor previously had no access to this and fell back to a three-line
   *  stub, so an un-customised template previewed as almost nothing and saving replaced the real
   *  email with the stub. */
  defaultSubject: string | null;
  defaultHtml: string | null;
  /** Variables the shipped template uses that THIS workspace's customised version does not — an
   *  override wins outright, so a template customised before a field existed keeps sending without
   *  it, silently, until somebody is told. */
  missingVariables: string[];
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
  /** Recipient domains across the whole group, top 10 — "8 addresses at gmail.com" at a glance. */
  domains: Array<{ domain: string; count: number }>;
}

export interface EmailFailureBreakdown {
  windowDays: number;
  since: string;
  totalFailures: number;
  sampledFailures: number;
  reasons: EmailFailureReason[];
}

/** The AI diagnosis of one failure group — POST /email-templates/analytics/failures/analyze. */
export interface EmailFailureAnalysis {
  diagnosis: string;
  likelyCause: string;
  transient: boolean;
  actions: string[];
}

export interface EmailDomainRow {
  domain: string;
  total: number;
  sent: number;
  failed: number;
  queued: number;
  /** sent / (sent + failed); null until something has settled. In-flight mail is excluded. */
  successRate: number | null;
  /** This domain's top 3 failure reasons (normalised) in the window. */
  topFailures: Array<{ reason: string; count: number }>;
  /** Oldest still-in-flight send — an old timestamp means stuck, not busy. */
  oldestQueuedAt: string | null;
}

export interface EmailDomainStats {
  from: string;
  to: string;
  totals: EmailDomainRow;
  domains: EmailDomainRow[];
  truncated: boolean;
  daily: EmailVolumeBucket[];
}

export type PracticeCategory = "PRODUCT" | "POC" | "BUGS" | "SECURITY" | "TRAINING";
export type RagStatus = "GREEN" | "AMBER" | "RED";

export interface PracticeInitiative {
  id: string;
  name: string;
  code: string | null;
  category: PracticeCategory;
  owner: string | null;
  status: RagStatus;
  ticketsCreated: number;
  ticketsClosed: number;
  openCount: number;
  overdueCount: number;
  hours: number;
  progress: string;
  risks: string;
}

export interface PracticeMetrics {
  ticketsCreated: number;
  ticketsClosed: number;
  hours: number;
  billableHours: number;
  contributors: number;
  overdue: number;
  slaBreaches: number;
  openEscalations: number;
  changesRaised: number;
  changesImplemented: number;
  releases: number;
  securityOpenCritical: number;
  securityOpenHigh: number;
  securityNewFindings: number;
  trainingHours: number;
}

export interface PracticeNarrative {
  executiveSummary: string;
  risks: string[];
  nextWeekPriorities: string[];
  decisionsRequired: string[];
  nextSteps: Array<{ id: string; text: string }>;
}

export interface PracticeDraft {
  data: {
    period: { from: string; to: string; label: string };
    previous: { from: string; to: string };
    metrics: PracticeMetrics;
    previousMetrics: PracticeMetrics;
    initiatives: PracticeInitiative[];
    releases: Array<{ version: string; product: string | null; closedAt: string | null; state: string }>;
    isEmpty: boolean;
  };
  narrative: PracticeNarrative | null;
  /** Why there is no narrative: switched off, unreachable, or answered in the wrong shape. Null
   *  when the prose was written — the three are different things to tell a reviewer. */
  aiFailed: string | null;
  preview: { subject: string; headline: string; sectionsHtml: string };
  /** Set on a stored draft — absent only on the immediate response to a fresh generate, which the
   *  page already knows the timing of. Used to tell a reviewer how old the thing they're looking at
   *  is, which is the first question anybody asks about a restored document. */
  id?: string;
  generatedAt?: string;
  generatedByName?: string | null;
}

export interface PracticeSettings {
  recipients: string[];
  configured: boolean;
  weekly: boolean;
  emailEnabled: boolean;
  aiNarrativeEnabled: boolean;
  maxRecipients: number;
}

/** SUPER_ADMIN only, every route — see the controller's header for why both halves are privileged. */
export const practiceUpdateApi = {
  settings: async () => (await api.get<PracticeSettings>("/practice-update/settings")).data,
  saveSettings: async (payload: { recipients: string[]; weekly?: boolean }) =>
    (await api.put<{ recipients: string[]; weekly: boolean }>("/practice-update/settings", payload)).data,
  /** Generates a NEW update, replacing whatever draft is stored. Costs a model run — the page
   *  calls this only from Generate/Regenerate, never on load. */
  draft: async (period?: { from: string; to: string }) =>
    (await api.post<PracticeDraft>("/practice-update/draft", period ?? {})).data,
  /** The stored draft, if any. This is what a page load calls, so a refresh restores what was
   *  already generated instead of spending tokens again. `{ draft: null }` is a normal answer. */
  storedDraft: async () => (await api.get<{ draft: PracticeDraft | null }>("/practice-update/draft")).data,
  /** Saves the edited prose. Only the narrative — the figures are never accepted from the client. */
  saveDraft: async (narrative: PracticeNarrative) =>
    (await api.patch<{ saved: boolean }>("/practice-update/draft", { narrative })).data,
  discardDraft: async () => (await api.delete<{ discarded: number }>("/practice-update/draft")).data,
  history: async () => (await api.get<{ records: PracticeHistoryRow[] }>("/practice-update/history")).data,
  historyItem: async (id: string) => (await api.get<PracticeHistoryDetail>(`/practice-update/history/${id}`)).data,
  send: async (payload: { from?: string; to?: string; narrative?: PracticeNarrative }) =>
    (await api.post<{ status: string; recipients: number; subject: string; emailLogId?: string }>("/practice-update/send", payload)).data
};

export const emailTemplateApi = {
  list: async () => (await api.get<EmailTemplateRow[]>("/email-templates")).data,
  analytics: async () => (await api.get<EmailAnalytics>("/email-templates/analytics")).data,
  failures: async (days: number) =>
    (await api.get<EmailFailureBreakdown>("/email-templates/analytics/failures", { params: { days } })).data,
  domains: async (from?: string, to?: string) =>
    (await api.get<EmailDomainStats>("/email-templates/analytics/domains", { params: { from: from || undefined, to: to || undefined } })).data,
  analyzeFailure: async (reasonId: string, days: number) =>
    (await api.post<EmailFailureAnalysis>("/email-templates/analytics/failures/analyze", { reasonId, days })).data,
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
  collaborators: TicketCollaboratorRow[];
  comments: TicketComment[];
  attachments: TicketAttachmentRow[];
  timesheets: TicketTimesheetRow[];
  links: TicketLinkRow[];
  checklistItems: TicketChecklistItemRow[];
  branches: TicketBranchRow[];
  /** The most recent face check spent on this ticket (creation or a status transition). */
  identityVerified: boolean;
  identityVerifiedAt: string | null;

  /** May the viewer edit this ticket / change its status? Reporter, assignee, a collaborator, a
   *  privileged role, or the manager of the reporter or assignee. */
  canWork: boolean;
  /** May the viewer change the assignee or the collaborator list? Narrower than `canWork` — a
   *  super admin, an admin, or the reporter's/assignee's own manager.
   *
   *  BOTH ARE COMPUTED SERVER-SIDE, deliberately: "is this viewer the mapped manager of one of the
   *  parties" is a `managerId` lookup the browser has no data for, so re-deriving either here would
   *  put a control on screen that the API refuses. */
  canReassign: boolean;

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
  estimatedHours?: NumericOrString;
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

/** Per-project open/closed ticket counts — counted server-side, because a long serving assignee has
 *  hundreds of closed tickets and the list route carries a heavy include.
 *
 *  `open`/`closed` are the PROJECT's totals (bounded by what the caller may see); `mineOpen`/
 *  `mineClosed` are the caller's own share of them. The dashboard shows the totals and keeps the
 *  personal figures for the tooltip — a rollup row that reads "—" because you happen to hold no
 *  tickets in a project you logged time against tells you nothing about the project. */
export interface TicketCountsByProject {
  projectId: string;
  open: number;
  closed: number;
  mineOpen: number;
  mineClosed: number;
}

/** Status/priority tallies for the Tickets page's metric tiles. Counted over the whole (scoped)
 *  workspace rather than the 200-row list the table renders, so a tile can never describe a page
 *  of results as if it were the total. */
/** The daily history behind each metric card's sparkline, reconstructed server-side by undoing
 *  recorded creations and status transitions — so the LAST point of every array is the same number
 *  the card's headline shows. See apps/api/src/services/ticket-metrics.service.ts for what is exact
 *  (status) and what is an approximation (priority, when something was re-prioritised in window). */
export interface TicketMetricSeries {
  /** ISO `YYYY-MM-DD`, oldest first; the last entry is today. */
  days: string[];
  total: number[];
  byStatus: Partial<Record<TicketStatus, number[]>>;
  byPriority: Partial<Record<TicketPriority, number[]>>;
  /** False when a ticket was re-prioritised inside the window, making that series approximate. */
  priorityExact: boolean;
  /** True when the server hit its event cap, so the history is incomplete and says so. */
  truncated: boolean;
}

export interface TicketMetrics {
  total: number;
  byStatus: Partial<Record<TicketStatus, number>>;
  byPriority: Partial<Record<TicketPriority, number>>;
  /** Who has raised tickets in the current scope, most first. Populates the "Raised by" filter with
   *  exactly the people who actually appear, rather than the whole user directory. */
  byReporter: Array<{ userId: string; name: string; count: number }>;
  /** Null when the caller can see no projects at all — there is no history of nothing. */
  series: TicketMetricSeries | null;
  byProject: Array<{
    projectId: string;
    code: string;
    name: string;
    total: number;
    open: number;
    closed: number;
    byStatus: Partial<Record<TicketStatus, number>>;
    byPriority: Partial<Record<TicketPriority, number>>;
  }>;
}

/** Somebody explicitly added to a ticket so they may work on it, alongside its reporter and
 *  assignee. Distinct from a watcher, which is a notification subscription and grants nothing. */
export interface TicketCollaboratorRow {
  id: string;
  userId: string;
  user: TicketUserSummary;
  addedBy: { id: string; name: string } | null;
  createdAt: string;
}

export const ticketApi = {
  /** Per-project open/closed counts for one person's tickets, counted server-side. Defaults to the
   *  caller; another assignee needs the same permission the list route requires. */
  countsByProject: async (assigneeId?: string) =>
    (await api.get<TicketCountsByProject[]>("/tickets/counts-by-project", { params: { assigneeId } })).data,
  /** Status/priority tallies for the metric tiles. Takes the SAME filters as `list` so the tiles and
   *  the table below them can never describe different sets of tickets. */
  metrics: async (params?: {
    projectId?: string;
    status?: string;
    priority?: string;
    type?: string;
    reporterId?: string;
    labelId?: string;
    assigneeId?: string;
  }) => (await api.get<TicketMetrics>("/tickets/metrics", { params })).data,
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
    /** "Raised by" — the ticket's reporter. */
    reporterId?: string;
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
  /** Extra people who may WORK ON the ticket. Adding one is the same decision as reassigning, so
   *  the API refuses it for anybody but a super admin, an admin, or the reporter's/assignee's
   *  manager — see ticket.service.ts#canReassignTicket. */
  collaborators: {
    add: async (id: string, userId: string) =>
      (await api.post<TicketCollaboratorRow>(`/tickets/${id}/collaborators`, { userId })).data,
    remove: async (id: string, userId: string) => api.delete(`/tickets/${id}/collaborators/${userId}`)
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

/** A row of the admin-editable activity catalog behind the timesheet form's "Activity" field.
 *  `seeded` marks a synthetic row the API returns when the table is empty (a workspace whose seed
 *  never ran) — those are read-only placeholders and carry a `seed:` id, never a uuid. */
export interface ActivityTypeRow {
  id: string;
  name: string;
  isActive: boolean;
  seeded?: boolean;
}

export const activityTypeApi = {
  /** `all` additionally returns disabled rows and needs projects:manage — the management screen
   *  wants them, the logging picker must never offer them. */
  list: async (all = false) =>
    (await api.get<ActivityTypeRow[]>("/activity-types", { params: all ? { all: "true" } : undefined })).data,
  create: async (name: string) => (await api.post<ActivityTypeRow>("/activity-types", { name })).data,
  update: async (id: string, payload: { name?: string; isActive?: boolean }) =>
    (await api.patch<ActivityTypeRow>(`/activity-types/${id}`, payload)).data,
  /** Refused with a 409 (and a count) when any entry was logged under it — disable those instead,
   *  so the history stays readable. */
  remove: async (id: string) => api.delete(`/activity-types/${id}`)
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
  | "timesheet_notes"
  | "practice_summary"
  | "practice_risk"
  | "practice_priority"
  | "practice_decision";

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

/** Mirrors `FaceContext` in apps/api/src/services/face.service.ts — not imported from there since
 *  the web app doesn't depend on API source, but named the same to keep the two in sync by eye. */
export type FaceContext = "TIMESHEET" | "TICKET" | "APPROVAL";

export interface FaceAttemptRow {
  id: string;
  userId: string;
  context: FaceContext;
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
  challenge: async (context: FaceContext) =>
    (await api.post<FaceChallenge>("/face/challenge", { context })).data,
  /** Resolves with the outcome either way — a failed check is a 422 carrying a structured
   *  body, not an exception the caller should have to unwrap. `frames` is [neutral] when the
   *  challenge feature is off, [neutral, gesture] when on. */
  verify: async (params: {
    frames: Blob[];
    context: FaceContext;
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
  skipVerification: async (context: FaceContext) =>
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
  /** One action across many attempts — explicit `ids`, or `filter` for "everything matching what
   *  I'm looking at" (the server re-derives that set with the same query the table used, so the
   *  two can never diverge). Only flagged rows are touched; the count returned is flags cleared. */
  reviewAttemptsBulk: async (payload: {
    ids?: string[];
    filter?: { userId?: string; outcome?: string; context?: string; search?: string };
    note?: string;
  }) => (await api.patch<{ reviewed: number }>("/face/attempts/review-bulk", payload)).data,
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
  enableGoals: boolean;
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
  goalsEnabled: boolean;
  maxPortfolios: number;
  maxRequestForms: number;
  maxBlueprints: number;
  maxCustomFields: number;
  maxDashboards: number;
  maxGoals: number;
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
  goals: boolean;
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

/* ---- Goals / OKRs (V8 phase 1) ------------------------------------------------------------ */

export type GoalProgressSourceValue =
  | "MANUAL"
  | "APPROVED_HOURS"
  | "BUDGET_SPEND"
  | "TICKETS_CLOSED"
  | "ON_TIME_RATE"
  | "SLA_BREACHES"
  | "RISK_SCORE";

export type GoalStatusValue = "ACTIVE" | "ACHIEVED" | "CLOSED";
export type GoalHealthValue = "ON_TRACK" | "AT_RISK" | "OFF_TRACK";
export type GoalLinkTargetValue = "PROJECT" | "PORTFOLIO" | "TICKET";

/** `unavailable` is a real state, never rendered as 0 — see goal-progress.service.ts. */
export interface GoalMeasurement {
  currentValue: number | null;
  progressPct: number | null;
  health: GoalHealthValue | null;
  unavailable: boolean;
  unavailableReason: string | null;
}

export interface GoalOverrideRow {
  progressPct: number;
  measuredValue: number | null;
  measuredPct: number | null;
  note: string;
  createdAt: string;
  createdBy: { id: string; name: string; email: string; avatarUrl?: string | null } | null;
}

export interface GoalRow {
  id: string;
  title: string;
  description: string | null;
  parentId: string | null;
  ownerId: string | null;
  owner: { id: string; name: string; email: string; avatarUrl?: string | null } | null;
  createdBy: { id: string; name: string; email: string; avatarUrl?: string | null } | null;
  startDate: string | null;
  endDate: string | null;
  status: GoalStatusValue;
  progressSource: GoalProgressSourceValue;
  targetValue: number | null;
  unit: string | null;
  manualProgressPct: number | null;
  direction: "AT_LEAST" | "AT_MOST";
  measurement: GoalMeasurement;
  override: GoalOverrideRow | null;
  /** An override wins the headline; the measurement stays visible beside it. */
  effectiveProgressPct: number | null;
  links: Array<{ id: string; targetType: GoalLinkTargetValue; targetId: string }>;
  _count: { children: number; overrides: number };
  createdAt: string;
  updatedAt: string;
}

export interface GoalDetail extends GoalRow {
  children: GoalRow[];
}

export interface GoalPayload {
  title: string;
  description?: string | null;
  parentId?: string | null;
  ownerId?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  progressSource?: GoalProgressSourceValue;
  targetValue?: number | null;
  unit?: string | null;
  manualProgressPct?: number | null;
  links?: Array<{ targetType: GoalLinkTargetValue; targetId: string }>;
  status?: GoalStatusValue;
}

export const goalApi = {
  list: async () => (await api.get<GoalRow[]>("/goals")).data,
  get: async (id: string) => (await api.get<GoalDetail>(`/goals/${id}`)).data,
  create: async (payload: GoalPayload) => (await api.post<GoalRow>("/goals", payload)).data,
  update: async (id: string, payload: Partial<GoalPayload>) => (await api.patch<GoalRow>(`/goals/${id}`, payload)).data,
  /** Appends an override; the API captures what the measurement said at that moment. There is
   *  deliberately no edit or delete — a correction is another override. */
  override: async (id: string, payload: { progressPct: number; note: string }) =>
    (await api.post<GoalOverrideRow>(`/goals/${id}/override`, payload)).data,
  remove: async (id: string) => {
    await api.delete(`/goals/${id}`);
  }
};

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
  /** The AI teammates over the same buckets, as their OWN list rather than extra rows: an agent has
   *  no capacity, so every column of a person's row would be meaningless for one. */
  agentRows: AgentWorkloadRowData[];
  summary: {
    people: number;
    overAllocated: number;
    unbooked: number;
    totalCapacityHours: number;
    totalBookedHours: number;
    totalLoggedHours: number;
  };
}

export interface AgentWorkloadRowData {
  agent: { id: string; name: string; avatarUrl: string | null };
  cells: Array<{
    bucketStart: string;
    /** Wall clock. Never summed with a person's hours — the two do not mean the same thing. */
    workedHours: number;
    costUsd: number;
    /** Null when nothing in this bucket had a measurable baseline. Zero would claim it displaced
     *  nothing, which is a different statement from "we cannot tell". */
    displacedMinutes: number | null;
    runs: number;
  }>;
  totals: { workedHours: number; costUsd: number; displacedMinutes: number | null; runs: number; measuredRuns: number };
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
  /** What the AI teammates spent on this project, in US DOLLARS — beside the burn, never inside it.
   *  Not billable, not in the project's currency, and an operating cost rather than an agreement with
   *  a client. See the server's comment for why adding the two would be arithmetic across units. */
  agentCostUsd: number;
  agentRuns: number;
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

/* ---------------------------------- Requirements Studio ---------------------------------- */

export interface RequirementsInterviewTurnRow {
  question: string;
  answer: string | null;
  skipped: boolean;
  sectionTag: string | null;
}

export interface RequirementsDocFeatureRow {
  title: string;
  description: string;
  priority: PriorityLevel;
  estimatedHours: number | null;
  moduleName: string | null;
  dependsOnIndex: number;
}

export interface RequirementsDocSuccessMetricRow {
  title: string;
  description?: string;
  targetValue?: number;
  unit?: string;
}

export interface RequirementsDocSectionsRow {
  problem: string;
  goals: string;
  targetUsers: string;
  scopeIn: string[];
  scopeOut: string[];
  features: RequirementsDocFeatureRow[];
  techStack: string[];
  dependencies: string[];
  uiUx: string;
  architecture: { description: string; diagramMermaid: string };
  modules: Array<{ name: string; description: string }>;
  nfr: { performance?: string; security?: string; compliance?: string; scalability?: string };
  timeline: Array<{ label: string; description: string; isMilestone: boolean }>;
  risks: string[];
  assumptions: string[];
  successMetrics: RequirementsDocSuccessMetricRow[];
  procedures: string[];
  /* Industry-standard sections added after the first release. ALL OPTIONAL and must stay that way
   * — a document generated before they existed has none of these keys, and still has to render. */
  executiveSummary?: string;
  personas?: Array<{ name: string; role: string; needs: string; painPoints: string }>;
  stakeholders?: Array<{ name: string; role: string; raci: "R" | "A" | "C" | "I" }>;
  constraints?: string[];
  functionalRequirements?: Array<{ id: string; requirement: string; priority: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"; acceptanceCriteria: string }>;
  costBenefit?: { costs: string; benefits: string; notes?: string };
  openQuestions?: string[];
}

export interface RequirementsDocRow {
  id: string;
  title: string;
  docType: "PRD" | "BRD" | "BOTH";
  status: "DRAFTING" | "READY" | "ARCHIVED";
  projectId: string | null;
  sections: RequirementsDocSectionsRow | null;
  interviewTranscript: RequirementsInterviewTurnRow[];
  /** All null together = created manually (the default). Set when an uploaded PRD/BRD was
   *  imported — see UserRole's sibling comment in schema.prisma for why the extracted text is
   *  kept but the raw file never is. */
  sourceDocumentName: string | null;
  sourceDocumentSize: number | null;
  sourceDocumentUploadedAt: string | null;
  sourceDocumentUploadedBy: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface RequirementsInterviewTurnResult {
  done: boolean;
  question?: string;
  quickReplies?: string[];
  sectionTag?: string;
  progress: { section: string; answered: number; total: number };
}

export interface RequirementsImportProposedTurnRow {
  question: string;
  answer: string;
  sectionTag: string;
  confidence: "HIGH" | "MEDIUM" | "LOW";
}

export interface RequirementsImportAnalysisRow {
  proposedTurns: RequirementsImportProposedTurnRow[];
  openQuestions: string[];
  documentSummary: string;
  truncated: boolean;
  /** The text the AI actually read — sent back on `importApply` so a confirmed upload can persist
   *  its provenance. Absent on a regenerate (that ran against already-stored text). */
  documentText?: string;
}

export const requirementsDocApi = {
  list: async () => (await api.get<RequirementsDocRow[]>("/requirements-docs")).data,
  get: async (id: string) => (await api.get<RequirementsDocRow>(`/requirements-docs/${id}`)).data,
  create: async (payload: { title: string; docType: "PRD" | "BRD" | "BOTH" }) =>
    (await api.post<RequirementsDocRow>("/requirements-docs", payload)).data,
  archive: async (id: string) => (await api.patch<RequirementsDocRow>(`/requirements-docs/${id}`, { status: "ARCHIVED" })).data,
  /** `{}` (both fields omitted) asks for the opening question. */
  interviewTurn: async (id: string, payload: { answer?: string; skip?: boolean }) =>
    (await api.post<RequirementsInterviewTurnResult>(`/requirements-docs/${id}/interview/turn`, payload)).data,
  generate: async (id: string) => (await api.post<RequirementsDocRow>(`/requirements-docs/${id}/generate`, {})).data,
  /** Optional "import an existing PRD/BRD" path — analyze writes nothing, only proposes. */
  importAnalyze: async (id: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return (
      await api.post<RequirementsImportAnalysisRow>(`/requirements-docs/${id}/import/analyze`, form, {
        headers: { "Content-Type": "multipart/form-data" }
      })
    ).data;
  },
  /** Which viewer suits the uploaded file, plus its content — a PDF says "pdf" and the bytes come
   *  from sourceFileUrl below; a .docx arrives already converted to HTML; text/markdown arrive as
   *  text. Its own request so a long document isn't shipped on every page load. */
  sourceView: async (id: string) =>
    (
      await api.get<{
        fileName: string | null;
        size: number | null;
        uploadedAt: string | null;
        uploadedBy: { id: string; name: string } | null;
        kind: "pdf" | "html" | "markdown" | "text";
        html?: string;
        text?: string;
        /** False for documents imported before the original file was kept — only text survives. */
        hasOriginalFile: boolean;
      }>(`/requirements-docs/${id}/source-view`)
    ).data,
  /** The original bytes, as a blob the PDF viewer can point at. Fetched through the API client
   *  rather than a bare URL because the access token lives in memory, not in a cookie. */
  sourceFileBlob: async (id: string) =>
    (await api.get(`/requirements-docs/${id}/source-file`, { responseType: "blob" })).data as Blob,
  /** Uploads the original bytes after the reviewed answers are applied. */
  storeSourceFile: async (id: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return (
      await api.post<RequirementsDocRow>(`/requirements-docs/${id}/source-file`, form, {
        headers: { "Content-Type": "multipart/form-data" }
      })
    ).data;
  },
  sourceText: async (id: string) =>
    (
      await api.get<{
        fileName: string | null;
        size: number | null;
        uploadedAt: string | null;
        uploadedBy: { id: string; name: string } | null;
        text: string;
      }>(`/requirements-docs/${id}/source-text`)
    ).data,
  /** Re-runs the analysis against the document's already-stored text — no upload. Preview only. */
  importRegenerate: async (id: string) =>
    (await api.post<RequirementsImportAnalysisRow>(`/requirements-docs/${id}/import/regenerate`, {})).data,
  /** Un-links the supporting document. The transcript (the answers) is left alone. */
  importClearSource: async (id: string) =>
    (await api.post<RequirementsDocRow>(`/requirements-docs/${id}/import/clear-source`, {})).data,
  /**
   * The human-in-the-loop gate — writes the reviewed/edited turns onto the document. A full
   * replace, not a merge. `sourceDocument` is sent only for a genuine (re-)upload.
   */
  importApply: async (
    id: string,
    payload: {
      turns: Array<{ question: string; answer: string; sectionTag: string }>;
      sourceDocument?: { fileName: string; fileSize: number; text: string };
    }
  ) => (await api.post<RequirementsDocRow>(`/requirements-docs/${id}/import/apply`, payload)).data,
  // Authenticated blob downloads — same reasoning as attestationApi.downloadPdf: the access token
  // lives in memory only, so a bare <a href> would hit these routes unauthenticated.
  /** POST, not GET: `diagramPng` carries the browser-rendered Mermaid diagram so the PDF can embed
   *  a real picture instead of the diagram's source text. Omitting it still produces a valid PDF. */
  downloadPdf: async (id: string, diagramPng?: string | null) =>
    (await api.post(`/requirements-docs/${id}/export.pdf`, { diagramPng: diagramPng ?? undefined }, { responseType: "blob" })).data as Blob,
  downloadMarkdown: async (id: string) => (await api.get(`/requirements-docs/${id}/export.md`, { responseType: "blob" })).data as Blob,
  /** The fill-in-the-blank starting point for someone with no PRD/BRD yet. */
  downloadTemplate: async () => (await api.get(`/requirements-docs/template.txt`, { responseType: "blob" })).data as Blob,
  materializeTickets: async (id: string, payload: { projectId: string; moduleIndexes?: number[] }) =>
    (await api.post<AiProposalRow>(`/requirements-docs/${id}/materialize-tickets`, payload)).data,
  materializeGoals: async (
    id: string,
    payload: { projectId?: string; items: Array<{ title: string; description?: string; targetValue?: number; unit?: string; startDate?: string; endDate?: string }> }
  ) => (await api.post<{ created: Array<{ id: string; title: string }> }>(`/requirements-docs/${id}/materialize-goals`, payload)).data
};

/* ---------------------------------- Agent runs ---------------------------------- */

export interface AgentRunStepRow {
  id: string;
  index: number;
  /** "tool" | "note" | "refusal" | "error" | "finish" | "proposal" */
  kind: string;
  toolName: string | null;
  argsJson: unknown;
  resultText: string | null;
  error: string | null;
  createdAt: string;
}

export interface AgentRunRow {
  id: string;
  capability: string;
  trigger: string;
  /** QUEUED | RUNNING | COMPLETED | PARTIAL | BLOCKED | ABORTED | FAILED */
  status: string;
  level: string;
  goal: string | null;
  /** Set the moment the run reads text authored outside the workspace — from then on it may not
   *  write, whatever its level says. */
  taintedAt: string | null;
  stepCount: number;
  maxSteps: number;
  costUsd: NumericOrString;
  maxCostUsd: NumericOrString;
  proposalId: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  onBehalfOf?: { id: string; name: string } | null;
  steps?: AgentRunStepRow[];
  /** The workflow that queued this run, when one did — so a run from a flow is never mistaken for one
   *  somebody started by hand. */
  flow?: { id: string; name: string; emoji: string } | null;
  /** The rest of the chain, on the detail route only: what it proposed, whether that was applied, and
   *  what changed. Absent on the list. */
  proposal?: {
    id: string;
    title: string;
    status: string;
    changes: Array<{ id: string; summary: string; appliedAt: string | null; targetType: string; targetId: string | null }>;
  } | null;
  /** What this run put on the same books as human work. Null is normal. */
  ledger?: { costUsd: string | number; durationSeconds: number; displacedMinutes: number | null; displacedBasis: string | null; billable: boolean } | null;
}

export const agentRunApi = {
  capabilities: async () =>
    (await api.get<Array<{ id: string; title: string; description: string; needsProject: boolean }>>("/agent-runs/capabilities")).data,
  list: async (limit = 25, params: { capability?: string; flowId?: string } = {}) =>
    (await api.get<AgentRunRow[]>("/agent-runs", { params: { limit, ...params } })).data,
  get: async (id: string) => (await api.get<AgentRunRow>(`/agent-runs/${id}`)).data,
  queue: async (payload: { capability: string; goal?: string; projectId?: string }) =>
    (await api.post<{ runId: string; created: boolean }>("/agent-runs", payload)).data,
  abort: async (id: string) => (await api.post<{ ok: true }>(`/agent-runs/${id}/abort`)).data
};

/* ---- The agent roster (V8 phase 3) --------------------------------------------------------- */

export interface AgentAutonomy {
  capability: string;
  requestedLevel: string;
  /** The only value to act on — every clamp already applied server-side. */
  effectiveLevel: string;
  maxLevel: string;
  clampedReason: string | null;
}

export interface AgentRosterEntry {
  id: string;
  name: string;
  emoji: string;
  description: string | null;
  enabled: boolean;
  templateKey: string | null;
  identity: { id: string; name: string; email: string };
  scopeProjectIds: string[];
  maxCostUsdPerDay: number | null;
  spentTodayUsd: number;
  capabilities: Array<{
    id: string;
    title: string;
    description: string;
    actsOnUntrustedInput: boolean;
    autonomy: AgentAutonomy;
    /** Whether it can act right now: AI on for the workspace AND its own feature switch on. */
    runnable: boolean;
    /** Set when another ENABLED profile owns this capability — only possible on a draft, since
     *  enabling with an overlap is refused. */
    claimedByOther: { profileId: string; name: string; emoji: string } | null;
  }>;
  /** What the workspace can actually deliver, as opposed to what the switch says. */
  readiness: { runnableCount: number; enabledButInert: boolean };
  runs: {
    total: number;
    recent: Array<{
      id: string;
      capability: string;
      status: string;
      trigger: string;
      level: string;
      stepCount: number;
      costUsd: number | null;
      /** The run read externally-authored text, so its authority dropped to SUGGEST for the rest
       *  of its life. Surfaced because it explains an otherwise baffling "why did it only propose?" */
      tainted: boolean;
      createdAt: string;
      finishedAt: string | null;
      error: string | null;
    }>;
  };
}

export interface AgentTemplateRow {
  key: string;
  name: string;
  emoji: string;
  description: string;
  /** For the gallery's filter row — the question somebody arrives with is "is there one for my job". */
  category: string;
  /** Plain-English phrases, never capability ids: an admin choosing a teammate should not need to know
   *  that `pr_review_summary` is a thing. */
  skills: string[];
  capabilities: string[];
  installed: boolean;
}

export interface AgentCapabilityRow {
  id: string;
  title: string;
  description: string;
  maxLevel: string;
  ceilingReason: string | null;
  actsOnUntrustedInput: boolean;
  /** Whether an agent RUN can execute it unattended. Most capabilities are invoked inline by the
   *  feature that owns them and have nothing for a run loop to do — a workflow step naming one would
   *  activate and then fail, so the builder does not offer them. Ownership is a separate question: a
   *  teammate may still be accountable for a capability it cannot be sent off to run. */
  agentRunnable: boolean;
}

export interface AgentLedgerSummary {
  entries: number;
  totalCostUsd: number;
  totalDurationHours: number;
  /** Only the displacements that ARE measurable. Read it with the two counts below or not at all. */
  displacedHours: number;
  measuredEntries: number;
  unmeasurableEntries: number;
  billableCostUsd: number;
  byCapability: Array<{ capability: string; entries: number; costUsd: number; displacedMinutes: number | null }>;
}

export interface AgentLedgerHistory {
  entries: Array<{
    agentRunId: string;
    capability: string;
    title: string;
    costUsd: number;
    durationSeconds: number;
    displacedMinutes: number | null;
    displacedBasis: string | null;
    occurredAt: string;
  }>;
  /** Zero-filled: a day with no agent work is a 0, not a gap. */
  daily: Array<{ day: string; costUsd: number; displacedMinutes: number; entries: number }>;
  /** How many days in the window have a MEASURED displacement — the trend is otherwise read as
   *  covering all of them. */
  measuredDays: number;
}

export const agentRosterApi = {
  list: async () => (await api.get<AgentRosterEntry[]>("/agents")).data,
  ledger: async () => (await api.get<AgentLedgerSummary>("/agents/ledger")).data,
  ledgerHistory: async (days = 30) => (await api.get<AgentLedgerHistory>("/agents/ledger/history", { params: { days } })).data,
  catalogue: async () =>
    (await api.get<{ templates: AgentTemplateRow[]; categories: string[]; capabilities: AgentCapabilityRow[] }>("/agents/catalogue")).data,
  install: async (templateKey: string) => (await api.post<AgentRosterEntry>("/agents/install", { templateKey })).data,
  create: async (payload: { name: string; emoji?: string; description?: string | null; capabilities: string[]; maxCostUsdPerDay?: number | null }) =>
    (await api.post<AgentRosterEntry>("/agents", payload)).data,
  update: async (id: string, patch: { enabled?: boolean; name?: string; emoji?: string; description?: string | null; capabilities?: string[]; maxCostUsdPerDay?: number | null }) =>
    (await api.patch<AgentRosterEntry>(`/agents/${id}`, patch)).data,
  retire: async (id: string) => {
    await api.delete(`/agents/${id}`);
  }
};

/** The map of AI in this workspace: every number a count, so each can be checked against the screen it
 *  came from. */
export interface AiOverview {
  aiEnabled: boolean;
  captureEnabled: boolean;
  capabilities: { total: number; aboveSuggest: number; unowned: number };
  agents: { total: number; enabled: number };
  flows: { total: number; live: number; proposalOnly: number; runsLastWeek: number; waiting: number };
  proposals: { pending: number; appliedLastWeek: number };
  spend: { monthToDateUsd: number; agentDrivenUsd: number; byFlowUsd: number };
  ledger: { entries: number; displacedHours: number; unmeasurableEntries: number };
  /** At most one suggestion. A list of five is a list nobody acts on. */
  nextStep: string | null;
}

export const aiOverviewApi = {
  get: async () => (await api.get<AiOverview>("/ai/overview")).data
};

/** One approver's verdict, and the request's own status once enough of them are in. Aliased rather
 *  than repeated: the same three words describe an approval step, an approval request, and both
 *  halves of a change's chain, and four copies of a union is four places to forget a value. */
export type ApprovalDecisionValue = "PENDING" | "APPROVED" | "REJECTED";

export interface ApprovalStepRow {
  id: string;
  order: number;
  decision: ApprovalDecisionValue;
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
  status: ApprovalDecisionValue;
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
  detail: Record<string, NumericOrString>;
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
  facts: Record<string, NumericOrString>;
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
  /** Imported, never re-typed. A hand-kept copy of this list is what caused the blank-panel bug —
   *  see the comment on `aiProposalTargetTypes` in @timesheet/shared. */
  targetType: AiProposalTargetType;
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
  kind: "PLAN_BREAKDOWN" | "SCHEDULE_ADJUSTMENT" | "ASSIGNMENT_REBALANCE" | "RISK_MITIGATION" | "BLUEPRINT_SUGGESTION" | "CHANGE_DRAFT" | "REQUIREMENTS_DOC";
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
  /** Deterministic — the solver's own corrections for dates that contradict a dependency. */
  scheduleAdjust: async (projectId: string) =>
    (await api.post<{ proposalId: string | null; reason: string | null; heldForReview: string | null; corrections: number }>(
      "/ai-proposals/schedule-adjust",
      { projectId }
    )).data,
  /** Deterministic — realigns a committed end date with measured slip. SUGGEST-capped server-side. */
  riskMitigation: async (projectId: string) =>
    (await api.post<{
      proposalId: string | null;
      reason: string | null;
      heldForReview: string | null;
      riskScore: number;
      band: string;
      snapshotId: string | null;
    }>("/ai-proposals/risk-mitigation", { projectId })).data,
  /** Expands a saved blueprint into a reviewable change set instead of an all-or-nothing stamp. */
  blueprintInstantiate: async (payload: { blueprintId: string; projectId: string; startDate: string }) =>
    (await api.post<{ proposalId: string; heldForReview: string | null; items: number; dependencies: number }>(
      "/ai-proposals/blueprint-instantiate",
      payload
    )).data,
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
  value?: NumericOrString;
  unit?: string | null;
  hint?: string | null;
  points?: Array<{ label: string; value: number; secondary?: number }>;
  rows?: Array<Record<string, NumericOrString>>;
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

/** One project on the home page's "My projects this month" card. */
export interface MyMonthProject {
  id: string;
  code: string;
  name: string;
  monthHours: number;
  approvedHours: number;
  entries: number;
  lastDate: string | null;
  /** Assigned to the viewer, as opposed to merely logged against. A project can be both, or only
   *  one — which is exactly why the card unions the two rather than deriving from entries alone. */
  assigned: boolean;
  /** The project's standing, plus the viewer's own share of it for the hover detail. */
  tickets: { open: number; closed: number; mineOpen: number; mineClosed: number };
  /** Null when change management is off for the workspace, so the card can drop the column rather
   *  than render zeroes that look like measurements. */
  changes: { raised: number; closed: number } | null;
}

export interface MyMonthRollup {
  month: { from: string; to: string };
  projects: MyMonthProject[];
  truncated: boolean;
  totals: {
    monthHours: number;
    approvedHours: number;
    submittedHours: number;
    draftHours: number;
    rejectedHours: number;
    tickets: { open: number; closed: number; total: number };
    changes: { raised: number; closed: number; total: number } | null;
  };
  /** Each is done ÷ total for its own kind of work, so the three bars are comparable rather than
   *  three unrelated numbers sharing a row. Null when the denominator is empty. */
  completion: { timesheetPct: number | null; ticketPct: number | null; changePct: number | null };
}

/** One question-and-answer on the Ask AI page. Meta figures are stored at answer time, so the
 *  history keeps saying what each answer actually cost even after the workspace's model changes. */
export interface AiAskExchangeRow {
  id: string;
  prompt: string;
  answer: string | null;
  error: string | null;
  toolCalls: Array<{ tool: string; detail: string }>;
  model: string | null;
  provider: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: string | number | null;
  durationMs: number;
  feedback: 1 | -1 | null;
  createdAt: string;
}

/** One capability the assistant either can or cannot use, as the server judged it for this caller. */
export interface AiChatCapability {
  name: string;
  description: string;
  group: string;
  /** True for the ones that write something — kept visibly apart from the reads in the panel. */
  acts: boolean;
  /** True when the write is immediately visible to other people rather than stopping at a draft. */
  publishes: boolean;
  allowed: boolean;
  /** Human-readable gate: "Everyone", "Super admin", "Reports access". */
  requires: string;
}

export interface AiChatCapabilities {
  role: string;
  allowedCount: number;
  totalCount: number;
  groups: Array<{ group: string; tools: AiChatCapability[] }>;
}

export const askAiApi = {
  ask: async (prompt: string) => (await api.post<AiAskExchangeRow>("/ai-chat/ask", { prompt })).data,
  /** What this person's assistant can actually do — the same filter the prompt is built through. */
  capabilities: async () => (await api.get<AiChatCapabilities>("/ai-chat/capabilities")).data,
  history: async (limit = 50) => (await api.get<AiAskExchangeRow[]>("/ai-chat/history", { params: { limit } })).data,
  /** 0 clears — pressing the same thumb twice un-rates. */
  feedback: async (id: string, feedback: 1 | -1 | 0) => api.post(`/ai-chat/${id}/feedback`, { feedback }),
  clear: async () => (await api.delete<{ deleted: number }>("/ai-chat/history")).data
};

export const dashboardApi = {
  catalogue: async () => (await api.get<WidgetDescriptorRow[]>("/dashboards/catalogue")).data,
  /**
   * The home page's month rollup, counted server-side.
   *
   * WHY NOT DERIVED FROM `timesheetApi.list`: that list is capped at 100 rows, newest first, so on a
   * busy account the older half of the month falls off the end and the projects only worked on early
   * in the month disappear from the card. It looked right in development and wrong in production.
   */
  myMonth: async (params?: DateWindow) => (await api.get<MyMonthRollup>("/dashboards/my-month", { params })).data,
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

/* ---- Workflow Studio (V8 phase 4) --------------------------------------------------------- */

export type FlowTriggerKind = "EVENT" | "SCHEDULE" | "FORM_SUBMISSION" | "MANUAL";
export type FlowStepKind = "ACTION" | "CAPABILITY" | "HUMAN_GATE" | "BRANCH";

export interface FlowStepAuthority {
  order: number;
  kind: FlowStepKind;
  capability: string | null;
  ownLevel: string;
  effectiveLevel: string;
  /** Names WHICH rule clamped it — a minimum is fixed by removing a step, a taint clamp by
   *  reordering, so the two must not collapse into "restricted". */
  clampedReason: string | null;
  taintedByEarlierStep: boolean;
}

export interface FlowAuthority {
  effectiveLevel: string;
  limitedBy: { order: number; capability: string; level: string } | null;
  taintedFrom: { order: number; capability: string } | null;
  proposalOnly: boolean;
  gatedBeforeWrites: boolean;
  steps: FlowStepAuthority[];
}

export interface FlowIssue {
  severity: "error" | "warning";
  message: string;
  order?: number;
}

export interface FlowRow {
  id: string;
  name: string;
  description: string | null;
  emoji: string;
  trigger: FlowTriggerKind;
  triggerConfig: Record<string, unknown>;
  enabled: boolean;
  agentProfile: { id: string; name: string; emoji: string; enabled: boolean } | null;
  steps: Array<{
    id: string;
    order: number;
    kind: FlowStepKind;
    capability: string | null;
    title: string | null;
    /** What the step is configured to do, in words, with ids already resolved to names. */
    summary: string | null;
    config: Record<string, unknown>;
  }>;
  authority: FlowAuthority;
  issues: FlowIssue[];
  /** Errors block activation; the badge and the activate route read the same value. */
  activatable: boolean;
  createdBy: { id: string; name: string; email: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface FlowSimulation {
  disclaimer: string;
  trigger: FlowTriggerKind;
  sampleCount: number;
  noSamplesReason: string | null;
  authority: FlowAuthority;
  samples: Array<{
    subject: string;
    subjectId: string | null;
    steps: Array<{
      order: number;
      kind: FlowStepKind;
      capability: string | null;
      title: string | null;
      outcome: "would-run" | "would-propose" | "skipped-by-branch" | "waits-for-approval" | "not-reached";
      level: string | null;
      detail: string;
    }>;
  }>;
}

export interface FlowPayload {
  name: string;
  description?: string | null;
  emoji?: string;
  trigger?: FlowTriggerKind;
  triggerConfig?: Record<string, unknown>;
  agentProfileId?: string | null;
  steps: Array<{ kind: FlowStepKind; capability?: string | null; config?: Record<string, unknown> }>;
}

/**
 * Everything the builder's pickers need, in one response.
 *
 * `options` on an action or branch field names WHICH list below it draws from, so the builder renders
 * a picker from data rather than from a switch statement that has to be edited every time the server
 * grows a new action.
 */
export interface FlowCatalogue {
  capabilities: AgentCapabilityRow[];
  events: string[];
  actions: Array<{ key: string; label: string; target: string; options: "people" | "labels" }>;
  branchFields: Array<{ key: string; label: string; values?: string[]; options?: "projects"; freeText?: boolean }>;
  people: Array<{ id: string; name: string; email: string }>;
  labels: Array<{ id: string; name: string; color: string | null }>;
  projects: Array<{ id: string; code: string; name: string }>;
}

/** One execution of one flow against one subject. */
export interface FlowRunRow {
  id: string;
  flowId: string;
  flow: { id: string; name: string; emoji: string } | null;
  trigger: string;
  subjectType: string | null;
  subjectId: string | null;
  subjectLabel: string | null;
  /** RUNNING | WAITING | COMPLETED | STOPPED | FAILED. STOPPED means a condition said no, which is a
   *  correct outcome and not a failure. */
  status: string;
  awaitingOrder: number | null;
  awaitingUser: { id: string; name: string } | null;
  summary: string | null;
  startedAt: string;
  finishedAt: string | null;
  steps: Array<{
    id: string;
    order: number;
    kind: FlowStepKind;
    /** ran | proposed | queued | waiting | skipped | not-reached | held | failed */
    outcome: string;
    detail: string;
    agentRunId: string | null;
    /** Set when a proposal-only flow routed this step into the review queue — the link that makes
     *  flow → proposal → applied change one navigable chain. */
    proposalId: string | null;
  }>;
}

export const flowApi = {
  list: async () => (await api.get<FlowRow[]>("/flows")).data,
  get: async (id: string) => (await api.get<FlowRow>(`/flows/${id}`)).data,
  catalogue: async () => (await api.get<FlowCatalogue>("/flows/catalogue")).data,
  /** A GET because it writes nothing — safe to re-run and refresh. */
  simulate: async (id: string, limit = 5) => (await api.get<FlowSimulation>(`/flows/${id}/simulate`, { params: { limit } })).data,
  create: async (payload: FlowPayload) => (await api.post<FlowRow>("/flows", payload)).data,
  update: async (id: string, payload: Partial<FlowPayload>) => (await api.patch<FlowRow>(`/flows/${id}`, payload)).data,
  setEnabled: async (id: string, enabled: boolean) => (await api.post<FlowRow>(`/flows/${id}/enabled`, { enabled })).data,
  /** What the flows have actually done. Readable by anybody who can see tickets — see the route. */
  runs: async (flowId?: string, limit = 20) =>
    (await api.get<FlowRunRow[]>("/flows/runs", { params: { flowId, limit } })).data,
  /** Clear a gate. Only the person the step named may — the server enforces it, not this call. */
  decide: async (runId: string, approved: boolean) => {
    await api.post(`/flows/runs/${runId}/decision`, { approved });
  },
  runNow: async (id: string) => (await api.post<{ runId: string; created: boolean }>(`/flows/${id}/run`)).data,
  retire: async (id: string) => {
    await api.delete(`/flows/${id}`);
  }
};

/* ------------------------------------------------------------------ *
 * CHANGE MANAGEMENT
 * ------------------------------------------------------------------ */

export type ChangeEnvironment = "DEVELOPMENT" | "QA" | "UAT" | "STAGING" | "PRODUCTION" | "DR";

export interface ChangeCategoryRow {
  id: string;
  name: string;
  color: string | null;
  requiresSecurityReview: boolean;
}

export interface ChangeTicketSummary {
  id: string;
  key: string;
  title: string;
  description: string | null;
  status: TicketStatus;
  priority: TicketPriority;
  dueAt: string | null;
  createdAt: string;
  project: { id: string; code: string; name: string };
  module: { id: string; name: string } | null;
  reporter: TicketUserSummary;
  assignee: TicketUserSummary | null;
  _count: { comments: number; attachments: number };
}

export interface ChangeRow {
  id: string;
  ticketId: string;
  /** The number people quote: `HICS-TS-20260812-0001`. Project code, the UTC date it was raised, and
   *  a sequence that restarts each day. Distinct from the underlying ticket key, which reads as a bug
   *  report in an approval email. */
  changeKey: string;
  justification: string;
  changeKind: ChangeKind;
  categoryId: string | null;
  category: ChangeCategoryRow | null;
  state: ChangeState;
  impact: ChangeBand;
  likelihood: ChangeBand;
  /** Derived from impact x likelihood by the server. Never sent up — the API ignores it. */
  riskLevel: ChangeBand;
  riskScoredAt: string | null;
  affectedServices: string[];
  affectedUserCount: number | null;
  requiresDowntime: boolean;
  downtimeMinutes: number | null;
  securityReviewRequired: boolean;
  dataMigration: boolean;
  complianceTags: string[];
  implementationPlan: string | null;
  backoutPlan: string | null;
  testPlan: string | null;
  communicationPlan: string | null;
  plannedStart: string | null;
  plannedEnd: string | null;
  actualStart: string | null;
  actualEnd: string | null;
  outcome: ChangeOutcome | null;
  pirNotes: string | null;
  closureNotes: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  ticket: ChangeTicketSummary;

  /* --- Classification (spec 10) --- */
  sourceId: string | null;
  source: { id: string; name: string } | null;
  applicationId: string | null;
  application: { id: string; name: string; code: string | null } | null;
  environment: ChangeEnvironment;
  businessUnit: string | null;
  department: string | null;
  serviceName: string | null;
  productName: string | null;
  businessOwnerId: string | null;
  technicalOwnerId: string | null;

  /* --- Business case (spec 11) --- */
  problemStatement: string | null;
  currentSituation: string | null;
  reasonForChange: string | null;
  expectedOutcome: string | null;
  businessBenefits: string | null;
  costOfNotImplementing: string | null;
  revenueImpact: string | null;
  customerImpactNotes: string | null;
  slaImpactNotes: string | null;
  regulatoryRequirement: boolean;
  complianceReference: string | null;
  projectReference: string | null;

  /* --- Impact (spec 12) --- */
  affectedApplications: string[];
  affectedCustomers: string[];
  affectedLocations: string[];
  affectedDepartments: string[];
  affectedInfrastructure: string[];
  affectedApis: string[];
  affectedDatabases: string[];
  affectedIntegrations: string[];
  productionAffected: boolean;
  customerAffected: boolean;
  serviceInterruption: boolean;
  dataModified: boolean;
  appRestartRequired: boolean;
  serverRestartRequired: boolean;
  dbRestartRequired: boolean;
  securityImpact: boolean;
  complianceImpact: boolean;
  slaImpact: boolean;
  externalIntegrationImpact: boolean;
  downtimeStart: string | null;
  downtimeEnd: string | null;
  customerNotificationRequired: boolean;

  /** The per-parameter bands the score was computed from, keyed by risk-parameter key. Stored with
   *  the score so retuning the matrix cannot rewrite what an approver actually agreed to. */
  riskInputs: Record<string, ChangeBand>;
  riskScore: number;

  /* --- Implementation (spec 14) --- */
  implementationSummary: string | null;
  implementationObjective: string | null;
  prerequisites: string | null;
  requiredAccess: string | null;
  requiredTools: string | null;
  requiredResources: string | null;
  primaryEngineerId: string | null;
  backupEngineerId: string | null;
  expectedDurationMinutes: number | null;
  implementationNotes: string | null;
  implementationIssues: string | null;

  /* --- Testing (spec 15) --- */
  testEnvironment: ChangeEnvironment | null;
  testingTeam: string | null;
  uatRequired: boolean;
  businessValidationRequired: boolean;
  testingStart: string | null;
  testingEnd: string | null;
  validationCriteria: string | null;

  /* --- Rollback (spec 16, 24) --- */
  rollbackRequired: boolean;
  rollbackCriteria: string | null;
  rollbackProcedure: string | null;
  rollbackOwnerId: string | null;
  estimatedRollbackMinutes: number | null;
  backupRequired: boolean;
  backupLocation: string | null;
  backupVerified: boolean;
  restoreProcedure: string | null;
  rollbackStatus: string;
  rollbackStartedAt: string | null;
  rollbackEndedAt: string | null;
  rollbackReason: string | null;
  rollbackResult: string | null;

  /* --- Release (spec 17) --- */
  releaseVersion: string | null;
  buildNumber: string | null;
  deploymentPackage: string | null;
  repository: string | null;
  branch: string | null;
  cicdPipeline: string | null;
  releaseTicket: string | null;
  deploymentTool: string | null;
  deploymentMethod: string | null;
  configurationChanges: boolean;
  databaseChanges: boolean;
  apiChanges: boolean;
  infrastructureChanges: boolean;

  /* --- Communication (spec 20) --- */
  internalCommRequired: boolean;
  stakeholderNotifyRequired: boolean;
  communicationChannel: string | null;
  notificationAudience: string | null;
  communicationOwnerId: string | null;
  notificationDate: string | null;

  /* --- Schedule (spec 18) --- */
  conflictOverridden: boolean;
  conflictOverrideReason: string | null;

  /* --- Validation (spec 25) --- */
  validationOwnerId: string | null;
  validationDate: string | null;
  validationResult: string | null;
  businessConfirmation: boolean;
  technicalConfirmation: boolean;
  validationIssues: string | null;

  /* --- PIR (spec 26) --- */
  implementationSuccessful: boolean | null;
  expectedResultAchieved: boolean | null;
  actualResult: string | null;
  issuesEncountered: string | null;
  incidentCreated: boolean;
  incidentReference: string | null;
  actualDowntimeMinutes: number | null;
  lessonsLearned: string | null;
  recommendations: string | null;
  followUpActions: string | null;
  followUpOwnerId: string | null;
  followUpTargetDate: string | null;

  /* --- Closure (spec 27) --- */
  closureStatus: string | null;
  documentationUpdated: boolean;
  monitoringCompleted: boolean;
  closedById: string | null;

  /* --- Children --- */
  collaborators: Array<{ id: string; userId: string; roleLabel: string | null; user: TicketUserSummary }>;
  linkedTickets: Array<{ id: string; ticketId: string; ticket: { id: string; key: string; title: string; status: string; type: string } }>;
}

export interface ChangeApprovalRow {
  id: string;
  round: number;
  approverId: string;
  approver: TicketUserSummary | null;
  /** Why this person was asked — recorded because reporting lines move. */
  reason: "MANAGER_OF_REQUESTER" | "SUPER_ADMIN";
  status: "PENDING" | "APPROVED" | "REJECTED" | "RETURNED" | "CANCELLED";
  comments: string | null;
  decidedAt: string | null;
  dueAt: string | null;
}

/* ------------------------------------------------------------------ *
 * The runbook
 * ------------------------------------------------------------------ */

export type ChangeStepStatus = "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED" | "FAILED" | "SKIPPED";
export type ChangeTestStatus = "NOT_STARTED" | "PASSED" | "FAILED" | "BLOCKED";
export type ChangeDependencyType = "PREDECESSOR" | "SUCCESSOR" | "RELATED" | "BLOCKS";
export type ChangeDependencyStatus = "OPEN" | "COMPLETED" | "WAIVED";

export interface ChangeStep {
  id: string;
  stepNumber: number;
  description: string;
  ownerId: string | null;
  plannedStart: string | null;
  plannedEnd: string | null;
  status: ChangeStepStatus;
  comments: string | null;
}
export type ChangeStepInput = Omit<ChangeStep, "id" | "stepNumber">;

export interface ChangeTest {
  id: string;
  reference: string;
  description: string;
  expectedResult: string | null;
  actualResult: string | null;
  status: ChangeTestStatus;
  testerId: string | null;
  comments: string | null;
}
export type ChangeTestInput = Omit<ChangeTest, "id" | "reference"> & { reference?: string };

export interface ChangeDependency {
  id: string;
  dependencyType: ChangeDependencyType;
  description: string;
  relatedChangeId: string | null;
  application: string | null;
  team: string | null;
  ownerId: string | null;
  status: ChangeDependencyStatus;
}
export type ChangeDependencyInput = Omit<ChangeDependency, "id">;

/** One stage's clock, judged server-side. The browser has the timestamps but not the configured
 *  budgets, and a second copy of the thresholds here is a second thing to get wrong. */
export interface ChangeSlaVerdict {
  state: "BREACHED" | "WARNING" | "ON_TRACK" | "NOT_STARTED" | "MET";
  /** Negative once breached, so a card can say "9h over" without consulting a second field. */
  hoursRemaining: number;
  dueAt: string | null;
  pctElapsed: number;
}

/** The URL segment for each editable change catalogue. */
export type ChangeCatalogueKind =
  | "categories"
  | "sources"
  | "applications"
  | "risk-parameters"
  | "sla"
  | "maintenance-windows"
  | "blackouts";

/** The union of every catalogue row. Loose on purpose — one editor renders all seven, and the
 *  columns it shows come from a per-kind field list rather than from the type. */
export interface ChangeCatalogueRow {
  id: string;
  isActive: boolean;
  [field: string]: unknown;
}

/** Everything about a change that is DERIVED from its linked tickets rather than typed — see
 *  `change-context.service.ts` and docs/AI_AND_AUTOMATION_FOR_CHANGE.md. */
export interface ChangeContextRepo {
  repository: string;
  branches: string[];
  pullRequests: Array<{ url: string; status: string; branch: string; ticketKey: string }>;
  /** Null means nobody has ingested a run — which is NOT the same as passing, and is the
   *  distinction an approver needs. */
  latestCi: { status: string; provider: string; branch: string | null; passCount: number | null; failCount: number | null; at: string } | null;
  openFindings: { critical: number; high: number; medium: number; low: number };
}

export interface ChangeContext {
  tickets: Array<{ id: string; key: string; title: string; status: string; assignee: string | null; approvedHours: number }>;
  repositories: ChangeContextRepo[];
  contributors: Array<{ id: string; name: string; approvedHours: number }>;
  totals: { tickets: number; repositories: number; pullRequests: number; approvedHours: number; openFindings: number };
  applicationHistory: Array<{ changeKey: string; title: string; state: string; outcome: string | null; closedAt: string | null }>;
  suggestions: { affectedApplications: string[]; affectedServices: string[]; implementerId: string | null };
}

export interface ChangeDetail extends ChangeRow {
  /** Every decision ever asked for, newest round first. A change rejected and reworked opens a new
   *  round rather than overwriting the first — the objection stays on the record. */
  approvals: ChangeApprovalRow[];
  canEdit: boolean;
  /** Whether THIS viewer has a pending step and the permission to decide it. Computed server-side:
   *  the browser cannot work that out without the chain, and guessing would render a Decide button
   *  the API then refuses. */
  canDecide: boolean;
  myPendingStepId: string | null;
  /** What the change still owes before it could be submitted, so the form can say so up front
   *  rather than letting somebody press Submit to find out. */
  blockingForSubmit: string[];
  implementationSteps: ChangeStep[];
  testCases: ChangeTest[];
  dependencies: ChangeDependency[];
  /** Every stage clock, keyed by stage — APPROVAL, IMPLEMENTATION, VALIDATION, CLOSURE. */
  sla: Record<string, ChangeSlaVerdict>;
  /** Open predecessors, named. Implementation is refused while any exist, so the page can say which
   *  rather than letting somebody press Implement to find out. */
  blockingDependencies: Array<{ id: string; description: string; dependencyType: ChangeDependencyType }>;
}

export interface ChangeMetrics {
  total: number;
  byState: Partial<Record<ChangeState, number>>;
  byRisk: Partial<Record<ChangeBand, number>>;
  byKind: Partial<Record<ChangeKind, number>>;
  byEnvironment: Partial<Record<ChangeEnvironment, number>>;
  /** Approval steps waiting on this viewer. The number that decides whether they open the page. */
  /** Decisions waiting on THIS viewer. A super admin sees every pending one, because they can act
   *  on any of them. */
  awaitingMyDecision: number;
  /** Submitted but not yet resting — the change manager's headline. */
  inFlight: number;
  /** NULL, never 0, when nothing has closed yet. "No change has closed" and "every change succeeded"
   *  are different facts, and a 0% failure rate over an empty set is the kind of number that gets
   *  quoted in a review. Every rate below follows the same rule. */
  changeFailureRate: number | null;
  emergencyRate: number | null;
  avgApprovalHours: number | null;
  /** Running clocks only — a stage that already finished late is history, not something to save. */
  sla: { ON_TRACK: number; WARNING: number; BREACHED: number };
  /** Twelve weekly buckets, oldest first, for the trend chart. */
  trend: Array<{ week: string; raised: number; closed: number; high: number }>;
  /** Busiest eight projects. Capped server-side: a register spanning sixty projects would otherwise
   *  render a chart nobody can read. */
  byProject: Array<{ id: string; code: string; name: string; total: number; inFlight: number; high: number }>;
}


export interface ChangeSettingsResponse {
  settings: {
    enableChangeManagement: boolean;
    approvalSlaHours: number;
    requireFaceOnApproval: boolean;
  };
  entitlements: { changeManagementEnabled: boolean; maxChangePolicies: number };
  /** The AND of the workspace toggle and the plan entitlement, computed server-side so the client
   *  can never offer a page the API then refuses — the rule the planning layer's `effective`
   *  object follows. */
  effective: boolean;
}

export const changeApi = {
  list: async (params?: { state?: string; changeKind?: string; riskLevel?: string; projectId?: string; mine?: boolean }) =>
    (await api.get<ChangeRow[]>("/changes", { params })).data,
  metrics: async () => (await api.get<ChangeMetrics>("/changes/metrics")).data,
  get: async (id: string) => (await api.get<ChangeDetail>(`/changes/${id}`)).data,
  create: async (payload: Record<string, unknown>) => (await api.post<ChangeRow>("/changes", payload)).data,
  update: async (id: string, payload: Record<string, unknown>) => (await api.patch<ChangeRow>(`/changes/${id}`, payload)).data,
  /** The one route that moves a change. Every rule — legality, the fields the target state demands,
   *  building the approval chain — is enforced server-side; this just asks. */
  transition: async (id: string, to: ChangeState, note?: string) =>
    (await api.post<ChangeRow>(`/changes/${id}/transition`, { to, note })).data,
  /** Decide YOUR pending step on this change's chain. The module has its own decision route rather
   *  than reusing the planning one, which is gated on a different feature — see the route's comment
   *  for why two features gating each other would be a support ticket waiting to happen. */
  decide: async (id: string, decision: "APPROVED" | "REJECTED", comments?: string) =>
    (await api.post<ChangeRow>(`/changes/${id}/decision`, { decision, comments })).data,
  /** Closed tickets in this change's project that are not already linked. */
  linkableTickets: async (id: string, q?: string) =>
    (await api.get<Array<{ id: string; key: string; title: string; status: string; type: string }>>(`/changes/${id}/linkable-tickets`, { params: { q } })).data,
  linkTickets: async (id: string, ticketIds: string[]) => (await api.post<ChangeDetail>(`/changes/${id}/tickets`, { ticketIds })).data,
  unlinkTicket: async (id: string, ticketId: string) => api.delete(`/changes/${id}/tickets/${ticketId}`),
  addCollaborators: async (id: string, userIds: string[], roleLabel?: string) =>
    (await api.post<ChangeDetail>(`/changes/${id}/collaborators`, { userIds, roleLabel })).data,
  removeCollaborator: async (id: string, userId: string) => api.delete(`/changes/${id}/collaborators/${userId}`),

  /**
   * The runbook: implementation steps, test cases and dependencies.
   *
   * All three are read off the change detail response rather than fetched separately — they arrive
   * with it — so these are writes only, and every one of them invalidates the same detail query.
   */
  addStep: async (id: string, body: ChangeStepInput) =>
    (await api.post<ChangeStep>(`/changes/${id}/steps`, body)).data,
  updateStep: async (id: string, stepId: string, body: Partial<ChangeStepInput>) =>
    (await api.patch<ChangeStep>(`/changes/${id}/steps/${stepId}`, body)).data,
  removeStep: async (id: string, stepId: string) => api.delete(`/changes/${id}/steps/${stepId}`),

  addTest: async (id: string, body: ChangeTestInput) =>
    (await api.post<ChangeTest>(`/changes/${id}/tests`, body)).data,
  updateTest: async (id: string, testId: string, body: Partial<ChangeTestInput>) =>
    (await api.patch<ChangeTest>(`/changes/${id}/tests/${testId}`, body)).data,
  removeTest: async (id: string, testId: string) => api.delete(`/changes/${id}/tests/${testId}`),

  addDependency: async (id: string, body: ChangeDependencyInput) =>
    (await api.post<ChangeDependency>(`/changes/${id}/dependencies`, body)).data,
  updateDependency: async (id: string, dependencyId: string, body: Partial<ChangeDependencyInput>) =>
    (await api.patch<ChangeDependency>(`/changes/${id}/dependencies/${dependencyId}`, body)).data,
  removeDependency: async (id: string, dependencyId: string) => api.delete(`/changes/${id}/dependencies/${dependencyId}`),
  /**
   * The register in one of three formats.
   *
   * A BLOB through the authenticated axios instance, never an `<a href>`: this app keeps its access
   * token in memory (see store/auth.ts), so a bare link reaches the export route with no
   * Authorization header and gets a 401. That is not a hypothetical — it shipped that way once.
   *
   * The truncation headers come back with it so the caller can warn at the moment of download rather
   * than leaving the reader to notice a short file.
   */
  download: async (format: "csv" | "xlsx" | "pdf") => {
    const res = await api.get(`/changes/export.${format}`, { responseType: "blob" });
    return {
      blob: res.data as Blob,
      rowsIncluded: Number(res.headers["x-export-rows-included"] ?? 0),
      truncated: String(res.headers["x-export-truncated"] ?? "false") === "true"
    };
  },
  /**
   * The seven catalogues behind a change's dropdowns, editable.
   *
   * One set of methods rather than seven, because the server exposes them under one shape — the
   * `kind` is the URL segment. `all` additionally returns disabled rows and is refused for anyone
   * but a super admin: the settings screen wants them, the raise form must never offer them.
   */
  configList: async (kind: ChangeCatalogueKind, all = false) =>
    (await api.get<ChangeCatalogueRow[]>(`/changes/config/${kind}`, { params: all ? { all: "true" } : undefined })).data,
  configCreate: async (kind: ChangeCatalogueKind, body: Record<string, unknown>) =>
    (await api.post<ChangeCatalogueRow>(`/changes/config/${kind}`, body)).data,
  configUpdate: async (kind: ChangeCatalogueKind, id: string, body: Record<string, unknown>) =>
    (await api.patch<ChangeCatalogueRow>(`/changes/config/${kind}/${id}`, body)).data,
  /** Refused with a 409 and a count when live records point at it — disable instead, so the
   *  history stays readable. Same rule activity types follow. */
  configRemove: async (kind: ChangeCatalogueKind, id: string) => api.delete(`/changes/config/${kind}/${id}`),
  /**
   * The derived context pack. Its own request, not part of `get`: it reads across tickets, branches,
   * CI runs, findings and timesheets, which is worth paying for when somebody opens the Context tab
   * and not on every load of a form they came to edit one field on.
   */
  context: async (id: string) => (await api.get<ChangeContext>(`/changes/${id}/context`)).data,
  /**
   * A plain-prose briefing on this change's already-recorded risk score.
   *
   * POST because it spends a model call — a GET should be safe to re-run and refresh. It writes
   * nothing either way, and it never returns a score: the number is read off the row.
   */
  riskNarrative: async (id: string) =>
    (await api.post<{ narrative: string | null }>(`/changes/${id}/risk-narrative`, {})).data,
  /**
   * Drafts the sections this change still owes, as a PROPOSAL nobody has accepted yet.
   *
   * Returns a proposal id, not text: each drafted section becomes a row somebody accepts or rejects
   * on the AI suggestions page. Nothing reaches the change until they do.
   */
  draftAssist: async (id: string) =>
    (await api.post<{ proposalId: string | null; drafted: string[]; skipped?: string[]; message?: string }>(`/changes/${id}/draft-assist`, {})).data,
  /**
   * Drafts ONE section inline and hands the text back — nothing is saved. The suggestion renders
   * beside the empty field, and pressing "Use this" writes it through the form's own save as the
   * person's edit. Same trust model as AiRefine. A null text means the drafter had too little to
   * ground a real draft and declined — for a gating field, a padded draft would be worse than none.
   */
  draftField: async (id: string, field: string) =>
    (await api.post<{ text: string | null; message?: string }>(`/changes/${id}/draft-field`, { field })).data,
  /** A reading of the conflicts already computed for this change's window. Null brief means there
   *  was nothing to brief — not that the model failed. */
  conflictBrief: async (id: string) =>
    (await api.post<{ brief: string | null; conflicts?: Array<{ kind: string; message: string }>; message?: string }>(
      `/changes/${id}/conflict-brief`,
      {}
    )).data,
  /** Drafts the post-implementation review as a proposal. Returns a proposal id, never the text
   *  written into the change — a review nobody stood behind is worse than no review. */
  pirAssist: async (id: string) =>
    (await api.post<{ proposalId: string | null; message?: string }>(`/changes/${id}/pir-assist`, {})).data,
  /** Scheduled work and the freeze periods it has to dodge, in one call — a calendar that fetches its
   *  bars and its no-go zones separately renders them a frame apart. */
  calendar: async (from: string, to: string) =>
    (await api.get<{
      changes: Array<{
        id: string;
        changeKey: string;
        state: ChangeState;
        riskLevel: ChangeBand;
        changeKind: ChangeKind;
        environment: ChangeEnvironment;
        plannedStart: string | null;
        plannedEnd: string | null;
        ticket: { title: string; project: { code: string; name: string } };
      }>;
      blackouts: Array<{ id: string; name: string; reason: string | null; environment: ChangeEnvironment | null; startsAt: string; endsAt: string }>;
    }>("/changes/calendar", { params: { from, to } })).data,
  conflicts: async (id: string) =>
    (await api.get<{ conflicts: Array<{ kind: string; message: string; reference?: string }> }>(`/changes/${id}/conflicts`)).data,
  /** Categories, sources, applications and the active risk parameters — one call, because the form
   *  needs all four before it can render a single dropdown. */
  masterData: async () =>
    (await api.get<{
      categories: ChangeCategoryRow[];
      sources: Array<{ id: string; name: string }>;
      applications: Array<{ id: string; name: string; code: string | null }>;
      riskParameters: Array<{ id: string; key: string; label: string; weight: number }>;
    }>("/changes/config/master-data")).data,
  settings: {
    get: async () => (await api.get<ChangeSettingsResponse>("/changes/config/settings")).data,
    update: async (payload: Record<string, unknown>) => (await api.patch("/changes/config/settings", payload)).data
  }
};

export interface PracticeHistoryRow {
  id: string;
  periodLabel: string;
  periodFrom: string;
  periodTo: string;
  sentAt: string | null;
  subject: string | null;
  recipientCount: number;
  sentByName: string | null;
  metrics: { ticketsClosed: number; hours: number; overdue: number; slaBreaches: number } | null;
  initiativeCount: number;
}

export interface PracticeHistoryDetail {
  id: string;
  periodLabel: string;
  sentAt: string | null;
  subject: string | null;
  /** What was ACTUALLY mailed, stored at send time — not re-rendered, so improving the email
   *  template can never rewrite what a past update says it contained. */
  html: string | null;
  recipients: string[];
  sentByName: string | null;
  generatedByName: string | null;
}
