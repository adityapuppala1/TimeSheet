import axios, { type AxiosRequestConfig } from "axios";
/* TYPE-ONLY, and erased at build: the platform console reads the very same tenant health
   services a workspace's own Maintenance tab does, so a second copy of these shapes could
   only drift out of step with the first. No runtime coupling to the tenant axios client. */
import type { ApiPerformanceOverview, StatusPage, SystemHealthSnapshot } from "./api";

/**
 * A completely separate axios instance from services/api.ts's tenant `api` — different base
 * path, different in-memory access token, different refresh endpoint/cookie. A platform-admin
 * session and a tenant user session must never share any client-side state, mirroring how
 * they're kept apart on the server (separate JWT secret, separate cookie path — see
 * apps/api/src/controllers/platform-admin.controller.ts).
 */
const API_BASE_URL = import.meta.env.VITE_API_URL ?? "/api";
const PLATFORM_ADMIN_BASE_URL = `${API_BASE_URL.replace(/\/$/, "")}/platform-admin`;

export const platformAdminApi = axios.create({ baseURL: PLATFORM_ADMIN_BASE_URL, withCredentials: true });

let inMemoryToken: string | null = null;
export function setPlatformAdminAccessToken(token: string | null) {
  inMemoryToken = token;
}

platformAdminApi.interceptors.request.use((config) => {
  if (inMemoryToken) config.headers.Authorization = `Bearer ${inMemoryToken}`;
  return config;
});

let refreshPromise: Promise<string> | null = null;

async function refreshPlatformAdminAccessToken(): Promise<string> {
  const response = await axios.post<{ accessToken: string }>(`${PLATFORM_ADMIN_BASE_URL}/auth/refresh`, undefined, {
    withCredentials: true
  });
  setPlatformAdminAccessToken(response.data.accessToken);
  return response.data.accessToken;
}

platformAdminApi.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config as (AxiosRequestConfig & { _retry?: boolean }) | undefined;
    const url = original?.url ?? "";
    if (error.response?.status !== 401 || !original || original._retry || url.includes("/auth/login") || url.includes("/auth/refresh")) {
      throw error;
    }
    original._retry = true;
    try {
      refreshPromise ??= refreshPlatformAdminAccessToken().finally(() => {
        refreshPromise = null;
      });
      const token = await refreshPromise;
      original.headers = { ...original.headers, Authorization: `Bearer ${token}` };
      return platformAdminApi.request(original);
    } catch (refreshError) {
      setPlatformAdminAccessToken(null);
      throw refreshError;
    }
  }
);

export type PlanTier = "STARTER" | "TEAM" | "ENTERPRISE";
export type OrgStatus = "PROVISIONING" | "ACTIVE" | "GRACE" | "SUSPENDED" | "ARCHIVED";
export type SsoProvider = "GOOGLE" | "MICROSOFT" | "SAML" | "LDAP";
export type ChatPlatform = "SLACK" | "MICROSOFT_TEAMS" | "GOOGLE_CHAT" | "TELEGRAM";

export interface PlatformAdminUser {
  id: string;
  name: string;
  email: string;
  /** True while the account still verifies against the password the control seed ships with. Drives the console banner. */
  usingSeededPassword?: boolean;
}

export interface OrgListRow {
  id: string;
  name: string;
  slug: string;
  status: OrgStatus;
  planTier: PlanTier;
  seatLimitOverride: number | null;
  aiMonthlyBudgetCeilingOverride: string | null;
  suspendedAt: string | null;
  suspendedReason: string | null;
  createdAt: string;
  database: { host: string; databaseName: string; migratedAt: string | null; schemaVersion: string | null } | null;
}

export interface OrgDetail extends OrgListRow {
  ssoConfigs: Array<{ provider: SsoProvider; isEnabled: boolean }>;
  authMethod: { passwordLoginEnabled: boolean; requireSsoOnly: boolean } | null;
}

/**
 * The boolean entitlements a tier carries, in the order the console renders them.
 *
 * Exported as a value so the form is generated from it rather than hand-listed — the previous
 * version typed five fields while the platform enforced twenty-one, and the fifteen it omitted
 * were editable only by a database migration.
 */
export const PLAN_CAPABILITIES = [
  { key: "faceVerificationEnabled", label: "Face (identity) verification", hint: "Enrolling and verifying fail closed without it; enforcement on submissions fails open, so a lapsed plan never locks a workforce out of logging time." },
  { key: "ganttEnabled", label: "Planning & timeline", hint: "Gantt, dependencies, baselines, critical path. Also gates request forms." },
  { key: "resourceMgmtEnabled", label: "Resource management", hint: "Capacity, bookings and the workload board — reads every person's rate and capacity." },
  { key: "approvalsEnabled", label: "Approval chains", hint: "Sequential or parallel approvals on work items, including guest approvers." },
  { key: "proofingEnabled", label: "Proofing", hint: "Pinned annotations on attached images and PDFs." },
  { key: "customWorkflowsEnabled", label: "Custom workflows", hint: "Admin-defined statuses and transitions per ticket type." },
  { key: "aiPmCopilotEnabled", label: "AI PM copilot", hint: "The proposal-based planning copilot. Spends AI budget." },
  { key: "goalsEnabled", label: "Goals / OKRs", hint: "Measured goals with progress. Paired with the Max goals quota." },
  { key: "changeManagementEnabled", label: "Change management", hint: "Raise, assess, approve, schedule and review changes. Paired with Max change policies." },
  { key: "practiceUpdateEnabled", label: "Weekly AI/ML practice update", hint: "The consolidated leadership digest. Gated for what it aggregates — every project, everyone's hours, every open finding — not for what it costs." }
] as const;

/** The countable ceilings. `0` means the tier cannot use that resource at all; 1,000,000 is the
 *  shared `UNLIMITED_PLAN_ITEMS` sentinel and renders as "Unlimited". */
export const PLAN_QUOTAS = [
  { key: "maxPortfolios", label: "Max portfolios" },
  { key: "maxRequestForms", label: "Max request forms" },
  { key: "maxBlueprints", label: "Max blueprints" },
  { key: "maxCustomFields", label: "Max custom fields" },
  { key: "maxDashboards", label: "Max dashboards" },
  { key: "maxGoals", label: "Max goals" },
  { key: "maxChangePolicies", label: "Max change policies" }
] as const;

export type PlanCapabilityKey = (typeof PLAN_CAPABILITIES)[number]["key"];
export type PlanQuotaKey = (typeof PLAN_QUOTAS)[number]["key"];

export type PlanTierLimitRow = {
  tier: PlanTier;
  seatLimit: number;
  aiMonthlyBudgetCeilingUsd: string;
  allowedSsoProviders: Array<SsoProvider>;
  allowedChatPlatforms: Array<ChatPlatform>;
  /** Managed backups. A CEILING on the cadence, not a setting — see the schema's doc comment. */
  backupFrequency: "NONE" | "WEEKLY" | "DAILY" | "HOURLY";
  maxBackupDestinations: number;
  backupPitrEnabled: boolean;
} & Record<PlanCapabilityKey, boolean> &
  Record<PlanQuotaKey, number>;

export interface OrgAnalyticsSummary {
  orgId: string;
  slug: string;
  name: string;
  status: string;
  planTier: string;
  seatCount: number;
  ticketCountsByStatus: Record<string, number>;
  aiSpendThisMonthUsd: number;
  /** Outbound mail this month, counts only — every workspace brings its own SMTP, so one org's
   *  credentials expiring is invisible from anywhere else. */
  emailsSentThisMonth: number;
  emailsFailedThisMonth: number;
  /** Adoption of the plan-gated weekly practice update, whose entire output is an email. */
  practiceUpdatesSentThisMonth: number;
  lastActivityAt: string | null;
  reachable: boolean;
}

export interface PlatformAnalytics {
  orgs: OrgAnalyticsSummary[];
  totals: { orgCount: number; seatCount: number; aiSpendThisMonthUsd: number };
}

export const platformAdminAuthApi = {
  login: async (email: string, password: string) =>
    (await platformAdminApi.post<{ accessToken: string; admin: PlatformAdminUser }>("/auth/login", { email, password })).data,
  refresh: refreshPlatformAdminAccessToken,
  me: async () => (await platformAdminApi.get<PlatformAdminUser>("/auth/me")).data,
  logout: async () => platformAdminApi.post("/auth/logout"),
  /** Re-verifies the current password server-side; every OTHER console session is revoked on success. */
  changePassword: async (currentPassword: string, newPassword: string) =>
    (await platformAdminApi.post<{ otherSessionsRevoked: number; usingSeededPassword: false }>("/auth/change-password", { currentPassword, newPassword })).data
};

export interface ProvisionOrgResult {
  organizationId: string;
  databaseName: string;
  schemaVersion: string;
  /** The sign-in address the welcome email carries — null only if the org row vanished mid-flight. */
  url: string | null;
  /** False when provisioning succeeded but the welcome mail did not send — hand the link over by hand. */
  welcomeSent: boolean;
}

export interface ResetAdminPasswordResult {
  orgSlug: string;
  email: string;
  name: string;
  /** Shown once; the server keeps only a hash. */
  temporaryPassword: string;
  url: string;
  message: string;
}

export const platformAdminOrgApi = {
  list: async () => (await platformAdminApi.get<OrgListRow[]>("/organizations")).data,
  get: async (id: string) => (await platformAdminApi.get<OrgDetail>(`/organizations/${id}`)).data,
  create: async (payload: { name: string; slug: string; planTier: PlanTier }) =>
    (await platformAdminApi.post<OrgListRow>("/organizations", payload)).data,
  /** The rescue for a workspace whose only super admin is locked out — issues a one-time password
   *  for an EXISTING super admin of that workspace. Never creates an account. */
  resetAdminPassword: async (id: string, email: string) =>
    (await platformAdminApi.post<ResetAdminPasswordResult>(`/organizations/${id}/reset-admin-password`, { email })).data,
  /** Physically provisions a PROVISIONING org's database — see provisioning.service.ts. */
  provision: async (id: string, payload: { adminEmail: string; adminName: string; adminPassword: string }) =>
    (await platformAdminApi.post<ProvisionOrgResult>(`/organizations/${id}/provision`, payload)).data,
  update: async (
    id: string,
    payload: Partial<{
      name: string;
      planTier: PlanTier;
      status: OrgStatus;
      suspendedReason: string | null;
      seatLimitOverride: number | null;
      aiMonthlyBudgetCeilingOverride: number | null;
    }>
  ) => (await platformAdminApi.patch<OrgListRow>(`/organizations/${id}`, payload)).data,

  /* --- Custom domains (3.6.1) ---------------------------------------------------------------
     The table and the routing shipped with 3.6.0; this is the half that makes them reachable.
     An unverified row is inert — `resolveCustomDomainSlug` only reads verified ones — so listing
     and creating are safe operations and only `verify` changes what traffic does. */
  listDomains: async (id: string) =>
    (await platformAdminApi.get<{ domains: OrgDomainRow[]; rootDomain: string | null }>(`/organizations/${id}/domains`)).data,
  addDomain: async (id: string, domain: string) =>
    (await platformAdminApi.post<OrgDomainRow>(`/organizations/${id}/domains`, { domain })).data,
  verifyDomain: async (id: string, domainId: string) =>
    (await platformAdminApi.post<OrgDomainRow>(`/organizations/${id}/domains/${domainId}/verify`)).data,
  removeDomain: async (id: string, domainId: string) => {
    await platformAdminApi.delete(`/organizations/${id}/domains/${domainId}`);
  },

  /** How this deployment turns a hostname into a workspace, and what setting ROOT_DOMAIN would
   *  change. A read-only dry run for a switch that cannot be flipped back quietly. */
  routing: async () => (await platformAdminApi.get<RoutingReadout>("/routing")).data
};

export const platformAdminPlanTierApi = {
  list: async () => (await platformAdminApi.get<PlanTierLimitRow[]>("/plan-tier-limits")).data,
  update: async (
    tier: PlanTier,
    payload: Partial<
      {
        seatLimit: number;
        aiMonthlyBudgetCeilingUsd: number;
        allowedSsoProviders: Array<SsoProvider>;
        allowedChatPlatforms: Array<ChatPlatform>;
      } & Record<PlanCapabilityKey, boolean> &
        Record<PlanQuotaKey, number>
    >
  ) => (await platformAdminApi.patch<PlanTierLimitRow>(`/plan-tier-limits/${tier}`, payload)).data
};

export const platformAdminAnalyticsApi = {
  get: async () => (await platformAdminApi.get<PlatformAnalytics>("/analytics")).data
};

/** Platform-wide Stripe configuration — see platform-admin.controller.ts's Billing section. */
export const platformAdminBillingApi = {
  get: async () =>
    (
      await platformAdminApi.get<{
        secretKeySet: boolean;
        webhookSigningSecretSet: boolean;
        priceIdTeam: string | null;
        priceIdEnterprise: string | null;
      }>("/billing-settings")
    ).data,
  update: async (payload: Partial<{ secretKey: string; webhookSigningSecret: string; priceIdTeam: string | null; priceIdEnterprise: string | null }>) =>
    (
      await platformAdminApi.patch<{
        secretKeySet: boolean;
        webhookSigningSecretSet: boolean;
        priceIdTeam: string | null;
        priceIdEnterprise: string | null;
      }>("/billing-settings", payload)
    ).data
};

export interface OrgDomainRow {
  id: string;
  domain: string;
  verified: boolean;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  lastCheckError: string | null;
  /** The DNS record the customer publishes, spelled out so it can be shown verbatim. */
  recordName: string;
  recordValue: string;
}

export interface RoutingReadout {
  mode: "single-org" | "multi-org";
  rootDomain: string | null;
  defaultOrgSlug: string;
  appBaseUrl: string;
  apexServes: string;
  organizations: Array<{
    slug: string;
    name: string;
    status: string;
    customDomain: string | null;
    url: string;
    urlIfRootDomainSet: string | null;
  }>;
}


/* ================================================================================================
 * 3.12.0 — the console's second half: overview, platform mail, platform email templates, the
 * trial retention programme, customer feedback, the control-plane audit trail and platform-admin
 * accounts. Backed by controllers/platform-admin-console.controller.ts.
 * ============================================================================================== */

export interface PlatformOverview {
  orgs: { total: number; byStatus: Record<string, number>; byTier: Record<string, number>; trialsActive: number; signups30: number; deletedUnderPolicy: number };
  retention: { enabled: boolean; autoDeleteEnabled: boolean; inProgramme: number; dueSoon: number; held: number };
  email: { sent30: number; failed30: number; skipped30: number; configured: boolean; source: "database" | "env" };
  feedback: { count: number; avgRating: number | null };
  signupsByWeek: Array<{ week: string; signups: number }>;
  recentActivity: PlatformAuditRow[];
}

export interface PlatformAuditRow {
  id: string;
  actorType: string;
  actorLabel: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface PlatformMailSettings {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  passwordSet: boolean;
  fromAddress: string;
  replyTo: string;
  updatedAt: string | null;
  effective: { configured: boolean; source: "database" | "env"; host: string | null; port: number; secure: boolean; user: string | null; from: string; replyTo: string | null };
}

export interface PlatformEmailTemplateRow {
  key: string;
  group: string;
  description: string;
  variables: string[];
  hasOverride: boolean;
  enabled: boolean;
  subject: string | null;
  bodyHtml: string | null;
  defaultSubject: string;
  defaultHtml: string;
  missingVariables: string[];
  sent30: number;
  failed30: number;
  updatedAt: string | null;
  updatedById: string | null;
}

export interface PlatformEmailLogRow {
  id: string;
  to: string;
  subject: string;
  templateKey: string;
  status: "SENT" | "FAILED" | "SKIPPED";
  errorMessage: string | null;
  dayMarker: string | null;
  isTest: boolean;
  createdAt: string;
  organizationId: string | null;
  organization: { name: string; slug: string } | null;
}

export interface PlatformRateRow {
  sent: number;
  failed: number;
  skipped: number;
  test: number;
  /** sent / (sent + failed). Skipped is excluded — see the service. Null until something settles. */
  successRate: number | null;
  lastSentAt: string | null;
}

export interface PlatformEmailAnalytics {
  /** Echo of the window that was MEASURED, not the one that was asked for. */
  from: string;
  to: string;
  windowDays: number;
  totals: PlatformRateRow;
  perDay: Array<{ day: string; sent: number; failed: number; skipped: number }>;
  perTemplate: Array<PlatformRateRow & { key: string; group: string }>;
  perDomain: Array<PlatformRateRow & { domain: string; topFailures: Array<{ reason: string; count: number }> }>;
  perTenant: Array<PlatformRateRow & { organizationId: string | null; name: string; slug: string | null; status: OrgStatus | null; markers: string[] }>;
  failureReasons: Array<{ reason: string; count: number; lastAt: string }>;
  domainsTruncated: boolean;
}

export interface RetentionSettings {
  enabled: boolean;
  feedbackDay: number;
  reminderDays: number[];
  retentionDays: number;
  autoDeleteEnabled: boolean;
  snapshotDir: string | null;
  updatedAt: string | null;
}

export type DeletionBlocker = "not-in-programme" | "converted" | "status" | "not-yet" | "hold" | "auto-delete-off" | "final-notice-pending" | "final-notice-today";

export interface RetentionPlan {
  inProgramme: boolean;
  converted: boolean;
  stage: "none" | "trial" | "lapsed" | "converted" | "deleted";
  daysIntoTrial: number | null;
  daysSinceTrialEnd: number | null;
  deleteAt: string | null;
  daysUntilDeletion: number | null;
  sent: Record<string, string>;
  due: string[];
  superseded: string[];
  finalMarker: string;
  nextMarker: { marker: string; at: string } | null;
  deletionDue: boolean;
  deletionBlockedBy: DeletionBlocker | null;
}

export interface RetentionQueueRow {
  id: string;
  name: string;
  slug: string;
  status: OrgStatus;
  planTier: PlanTier;
  trialTier: PlanTier | null;
  ownerEmail: string | null;
  trialStartedAt: string | null;
  trialEndsAt: string | null;
  retentionHold: boolean;
  retentionDeletedAt: string | null;
  feedbackCount: number;
  lastEmail: { organizationId: string; templateKey: string; status: string; createdAt: string; dayMarker: string | null } | null;
  plan: RetentionPlan;
}

export interface RetentionTickResult {
  enabled: boolean;
  dryRun: boolean;
  now: string;
  sent: Array<{ org: string; marker: string; to: string | null }>;
  failed: Array<{ org: string; marker: string; error: string }>;
  superseded: Array<{ org: string; marker: string }>;
  deleted: Array<{ org: string; databaseName: string | null }>;
  held: Array<{ org: string; blockedBy: DeletionBlocker | null }>;
  wouldSend: Array<{ org: string; marker: string }>;
  wouldDelete: Array<{ org: string }>;
}

export interface TrialFeedbackRow {
  id: string;
  organizationId: string;
  stage: string;
  rating: number;
  liked: string | null;
  missing: string | null;
  wouldReturn: string | null;
  comment: string | null;
  createdAt: string;
  organization: { name: string; slug: string; status: OrgStatus; planTier: PlanTier };
}

export interface TrialFeedbackAnalytics {
  count: number;
  avgRating: number | null;
  /** How many answers carried WORDS, not only a score — the response rate on the part that matters. */
  withWords: number;
  distribution: Array<{ rating: number; count: number }>;
  wouldReturn: Array<{ answer: string; count: number }>;
  stages: Array<{ stage: string; count: number; avgRating: number | null; wouldReturn: number }>;
  byStatus: Array<{ status: OrgStatus; count: number; avgRating: number | null }>;
  byTier: Array<{ tier: PlanTier; count: number; avgRating: number | null }>;
  monthly: Array<{ month: string; count: number; avgRating: number | null }>;
  rows: TrialFeedbackRow[];
}

export interface PlatformAuditPage {
  rows: PlatformAuditRow[];
  total: number;
  page: number;
  limit: number;
  pages: number;
  entities: Array<{ entity: string; count: number }>;
}

export interface PlatformSessionRow {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  expiresAt: string;
  refreshRotatedAt: string | null;
  current: boolean;
}

export interface PlatformSessionPage {
  rows: PlatformSessionRow[];
  total: number;
  page: number;
  limit: number;
  pages: number;
}

export interface SnapshotFile {
  /** The file name, which is also the API's id. Never a path. */
  id: string;
  slug: string | null;
  organizationId: string | null;
  organizationName: string | null;
  /** True when that workspace exists and currently has NO database — i.e. this can be restored. */
  restorable: boolean;
  bytes: number;
  createdAt: string;
  modifiedAt: string;
}

export interface SnapshotListing {
  configured: boolean;
  directory: string | null;
  problem: string | null;
  totalBytes: number;
  files: SnapshotFile[];
  tools: { mysqldump: boolean; mysql: boolean; mysqldumpPath: string; mysqlPath: string };
}

export interface PlatformAdminAccountRow {
  id: string;
  email: string;
  name: string;
  status: "ACTIVE" | "INACTIVE";
  createdAt: string;
  lastLoginAt: string | null;
  liveSessions: number;
}

export const platformAdminConsoleApi = {
  overview: async () => (await platformAdminApi.get<PlatformOverview>("/overview")).data,

  mailSettings: async () => (await platformAdminApi.get<PlatformMailSettings>("/mail-settings")).data,
  updateMailSettings: async (payload: { host: string; port: number; secure: boolean; user?: string; password?: string; clearPassword?: boolean; fromAddress?: string; replyTo?: string }) =>
    (await platformAdminApi.put<{ ok: true; updatedAt: string; effective: PlatformMailSettings["effective"] }>("/mail-settings", payload)).data,
  testMail: async (to: string) => (await platformAdminApi.post<{ sent: true; to: string; emailLogId: string | null }>("/mail-settings/test", { to })).data,

  emailTemplates: async () => (await platformAdminApi.get<PlatformEmailTemplateRow[]>("/email-templates")).data,
  saveEmailTemplate: async (key: string, payload: { subject: string; bodyHtml: string; enabled?: boolean }) =>
    (await platformAdminApi.put(`/email-templates/${encodeURIComponent(key)}`, payload)).data,
  revertEmailTemplate: async (key: string) => platformAdminApi.delete(`/email-templates/${encodeURIComponent(key)}`),
  previewEmailTemplate: async (key: string, draft?: { subject?: string; bodyHtml?: string; vars?: Record<string, string> }) =>
    (await platformAdminApi.post<{ subject: string; html: string; sample: Record<string, string> }>(`/email-templates/${encodeURIComponent(key)}/preview`, draft ?? {})).data,
  testEmailTemplate: async (key: string, to: string) =>
    (await platformAdminApi.post<{ sent: true; to: string; subject: string; emailLogId: string | null }>(`/email-templates/${encodeURIComponent(key)}/test`, { to })).data,
  emailTemplateLog: async (key: string) => (await platformAdminApi.get<PlatformEmailLogRow[]>(`/email-templates/${encodeURIComponent(key)}/log`)).data,

  emailLog: async (params?: { status?: string; orgId?: string; limit?: number }) => (await platformAdminApi.get<PlatformEmailLogRow[]>("/email-log", { params })).data,
  emailLogEntry: async (id: string) => (await platformAdminApi.get<PlatformEmailLogRow & { html: string | null; metadata: Record<string, unknown> | null }>(`/email-log/${id}`)).data,
  resendEmail: async (id: string) => (await platformAdminApi.post<{ sent: true; emailLogId: string | null }>(`/email-log/${id}/resend`)).data,
  emailAnalytics: async (range?: { from?: string; to?: string }) =>
    (await platformAdminApi.get<PlatformEmailAnalytics>("/email-analytics", { params: range })).data,

  retention: async () => (await platformAdminApi.get<{ settings: RetentionSettings; markers: string[]; queue: RetentionQueueRow[] }>("/retention")).data,
  updateRetentionSettings: async (patch: Partial<Omit<RetentionSettings, "updatedAt">>) => (await platformAdminApi.put<RetentionSettings>("/retention/settings", patch)).data,
  runRetention: async (body: { dryRun?: boolean; simulateNow?: string }) => (await platformAdminApi.post<RetentionTickResult>("/retention/run", body)).data,
  setRetentionHold: async (orgId: string, hold: boolean) => (await platformAdminApi.post<{ id: string; slug: string; retentionHold: boolean }>(`/retention/${orgId}/hold`, { hold })).data,
  sendRetentionMarker: async (orgId: string, marker: string) =>
    (await platformAdminApi.post<{ ok: boolean; status: string; marker: string; to: string | null; subject?: string }>(`/retention/${orgId}/send/${encodeURIComponent(marker)}`)).data,
  deleteUnderPolicy: async (orgId: string, confirmSlug: string) =>
    (await platformAdminApi.post<{ deleted: boolean; databaseName: string | null; snapshot?: { taken: boolean; path?: string; reason?: string }; confirmationSent?: boolean }>(`/retention/${orgId}/delete`, { confirmSlug })).data,

  feedback: async () => (await platformAdminApi.get<TrialFeedbackAnalytics>("/feedback")).data,

  audit: async (params?: { entity?: string; actorType?: string; limit?: number; page?: number }) =>
    (await platformAdminApi.get<PlatformAuditPage>("/audit", { params })).data,

  admins: async () => (await platformAdminApi.get<PlatformAdminAccountRow[]>("/admins")).data,
  createAdmin: async (payload: { email: string; name: string }) => (await platformAdminApi.post<{ id: string; email: string; name: string; temporaryPassword: string }>("/admins", payload)).data,
  setAdminStatus: async (id: string, status: "ACTIVE" | "INACTIVE") => (await platformAdminApi.patch<{ id: string; status: string }>(`/admins/${id}`, { status })).data,
  sessions: async (params?: { page?: number; limit?: number }) => (await platformAdminApi.get<PlatformSessionPage>("/auth/sessions", { params })).data,
  endSession: async (id: string) => platformAdminApi.delete(`/auth/sessions/${id}`),
  /** Ends every session except the caller's own — the "a machine I no longer have" button. */
  revokeOtherSessions: async () => (await platformAdminApi.post<{ revoked: number }>("/auth/sessions/revoke-others")).data,

  backups: async () => (await platformAdminApi.get<SnapshotListing>("/backups")).data,
  /**
   * A BLOB, not an `<a href>`, for the reason written on `timesheetReportApi.download`: the route is
   * authenticated with the in-memory bearer token, and a plain link carries no Authorization
   * header — the console's refresh cookie is path-scoped to `/auth`, so it would not rescue it
   * either. A link here downloads a 401 page named `<slug>.sql`, which is the worst possible
   * failure: it looks like it worked.
   */
  downloadBackup: async (id: string) =>
    (await platformAdminApi.get(`/backups/${encodeURIComponent(id)}/download`, { responseType: "blob" })).data as Blob,
  restoreBackup: async (id: string, organizationId: string, confirmSlug: string) =>
    (await platformAdminApi.post<{ restored: true; organizationId: string; slug: string; databaseName: string; status: string }>(`/backups/${encodeURIComponent(id)}/restore`, { organizationId, confirmSlug })).data,
  deleteBackup: async (id: string) => (await platformAdminApi.delete<{ deleted: true; id: string }>(`/backups/${encodeURIComponent(id)}`)).data
};

/** The public doors a retention email opens. Cross-tenant; no auth; the token is the credential. */
export const platformPublicApi = {
  feedbackInfo: async (token: string) => (await axios.get<{ workspace: string; stage: string; alreadySubmitted: boolean }>(`${API_BASE_URL.replace(/\/$/, "")}/public/trial-feedback/${encodeURIComponent(token)}`)).data,
  submitFeedback: async (token: string, body: { rating: number; liked?: string; missing?: string; wouldReturn?: "yes" | "maybe" | "no"; comment?: string }) =>
    (await axios.post<{ ok: true }>(`${API_BASE_URL.replace(/\/$/, "")}/public/trial-feedback/${encodeURIComponent(token)}`, body)).data,
  reactivateInfo: async (token: string) =>
    (await axios.get<{ workspace: string; slug: string; url: string; status: OrgStatus; alreadyActive: boolean; eligible: boolean; deleteDate: string | null }>(`${API_BASE_URL.replace(/\/$/, "")}/public/reactivate/${encodeURIComponent(token)}`)).data,
  reactivate: async (token: string) => (await axios.post<{ restored: boolean; alreadyActive: boolean; url: string }>(`${API_BASE_URL.replace(/\/$/, "")}/public/reactivate/${encodeURIComponent(token)}`)).data
};

/* ================================================================================================
 * Managed backups (3.14.0) — the tier entitlement, destinations, per-workspace schedules, the runs
 * they produce, and the retention rules that prune them.
 * ============================================================================================== */

export type BackupFrequency = "NONE" | "WEEKLY" | "DAILY" | "HOURLY";
export type BackupDestinationKind = "LOCAL" | "S3" | "AZURE_BLOB" | "GOOGLE_DRIVE" | "ONEDRIVE" | "SFTP";
export type BackupRetentionMode = "COUNT" | "AGE" | "GFS";
export type BackupRunKind = "SCHEDULED" | "MANUAL" | "PRE_DELETE" | "TEST_RESTORE";
export type BackupRunStatus = "RUNNING" | "SUCCEEDED" | "FAILED" | "SKIPPED";

export interface DestinationFieldSpec {
  key: string;
  label: string;
  hint?: string;
  /** Write-only: sent on save, never returned. The console shows whether it is SET, never its value. */
  secret?: boolean;
  optional?: boolean;
  placeholder?: string;
}

export interface BackupDestinationRow {
  id: string;
  name: string;
  kind: BackupDestinationKind;
  /** null = platform-owned; any workspace's policy may point at it. */
  organizationId: string | null;
  organizationName: string | null;
  config: Record<string, string>;
  prefix: string | null;
  isDefault: boolean;
  /** Which secret fields have a value stored — never the values. */
  secretsSet: Record<string, boolean>;
  lastTestedAt: string | null;
  lastTestStatus: string | null;
  lastTestMessage: string | null;
  runCount: number;
}

export interface BackupPolicyRow {
  id: string;
  enabled: boolean;
  frequency: BackupFrequency;
  hourUtc: number;
  dayOfWeek: number;
  destinationId: string | null;
  destinationName: string | null;
  retentionMode: BackupRetentionMode;
  keepCount: number;
  keepDays: number;
  gfsDaily: number;
  gfsWeekly: number;
  gfsMonthly: number;
  gfsYearly: number;
  alertEmails: string | null;
  hasAlertWebhook: boolean;
  alertOnSuccess: boolean;
  alertOnFailure: boolean;
  lastRunAt: string | null;
  lastStatus: BackupRunStatus | null;
  nextRunAt: string | null;
  /** Recomputed server-side, so a stale stored value is never shown. */
  projectedNextRunAt: string | null;
  /** The tier no longer permits what this policy asks for — the scheduler will clamp it. */
  overTier: boolean;
}

export interface BackupWorkspaceRow {
  organizationId: string;
  name: string;
  slug: string;
  status: OrgStatus;
  planTier: PlanTier;
  trialTier: PlanTier | null;
  hasDatabase: boolean;
  entitlement: { tier: PlanTier; frequency: BackupFrequency; maxDestinations: number; pitrEnabled: boolean };
  allowedFrequencies: BackupFrequency[];
  policy: BackupPolicyRow | null;
}

export interface BackupRunRow {
  id: string;
  organizationId: string;
  organizationName: string;
  slug: string;
  destinationName: string | null;
  destinationKind: BackupDestinationKind | null;
  kind: BackupRunKind;
  status: BackupRunStatus;
  startedAt: string;
  finishedAt: string | null;
  bytes: number | null;
  objectKey: string | null;
  checksumSha256: string | null;
  errorMessage: string | null;
  retentionTag: string | null;
}

export interface BackupOverview {
  tiers: Array<{ tier: PlanTier; backupFrequency: BackupFrequency; backupFrequencyLabel: string; maxBackupDestinations: number; backupPitrEnabled: boolean }>;
  frequencyLabels: Record<BackupFrequency, string>;
  destinationKinds: Array<{ kind: BackupDestinationKind; label: string; blurb: string; fields: DestinationFieldSpec[] }>;
  destinations: BackupDestinationRow[];
  workspaces: BackupWorkspaceRow[];
  recentRuns: BackupRunRow[];
}

export interface BackupTickResult {
  due: number;
  ran: Array<{ slug: string; status: string; message: string }>;
  clamped: Array<{ slug: string; asked: BackupFrequency; allowed: BackupFrequency }>;
  dryRun: boolean;
  now: string;
}

export const platformBackupApi = {
  overview: async () => (await platformAdminApi.get<BackupOverview>("/backups/overview")).data,

  createDestination: async (payload: {
    name: string;
    kind: BackupDestinationKind;
    organizationId?: string | null;
    config: Record<string, string>;
    secrets?: Record<string, string>;
    prefix?: string | null;
    isDefault?: boolean;
  }) => (await platformAdminApi.post<{ id: string }>("/backups/destinations", payload)).data,
  /** Only the secret fields actually retyped are sent; the server merges the rest. */
  updateDestination: async (id: string, payload: Partial<{ name: string; config: Record<string, string>; secrets: Record<string, string>; prefix: string | null; isDefault: boolean }>) =>
    (await platformAdminApi.patch<{ id: string }>(`/backups/destinations/${id}`, payload)).data,
  testDestination: async (id: string) => (await platformAdminApi.post<{ ok: boolean; message: string }>(`/backups/destinations/${id}/test`)).data,
  deleteDestination: async (id: string) => platformAdminApi.delete(`/backups/destinations/${id}`),

  savePolicy: async (orgId: string, payload: Record<string, unknown>) =>
    (await platformAdminApi.put<{ id: string; nextRunAt: string | null }>(`/backups/policy/${orgId}`, payload)).data,
  retentionPreview: async (orgId: string) =>
    (await platformAdminApi.get<{ total: number; keep: Array<{ id: string; tag: string | null }>; drop: Array<{ id: string; startedAt: string; objectKey: string | null }> }>(`/backups/policy/${orgId}/retention-preview`)).data,

  runNow: async (orgId: string, destinationId?: string) =>
    (await platformAdminApi.post<{ runId: string; status: string; message: string; bytes?: number }>(`/backups/run/${orgId}`, destinationId ? { destinationId } : {})).data,
  sweep: async (orgId: string) => (await platformAdminApi.post<{ kept: number; deleted: number; failed: number }>(`/backups/sweep/${orgId}`)).data,
  testRestore: async (runId: string) => (await platformAdminApi.post<{ ok: boolean; message: string; tables?: number }>(`/backups/runs/${runId}/test-restore`)).data,
  tick: async (dryRun: boolean) => (await platformAdminApi.post<BackupTickResult>("/backups/tick", { dryRun })).data
};

/* ================================ Fleet maintenance ================================= */

/** One workspace's own `MaintenanceSettings` row, read through the control plane. */
export interface WorkspaceMaintenanceState {
  organizationId: string;
  name: string;
  slug: string;
  status: string;
  settings: {
    enabled: boolean;
    phase: "off" | "scheduled" | "active" | "expired" | string;
    scheduledStartAt: string | null;
    scheduledEndAt: string | null;
    message: string | null;
    /** True while THIS window belongs to the platform, which makes it read-only inside the
     *  workspace. The server refuses a tenant-sourced write; the disabled controls over there are
     *  the courtesy, not the control. */
    managedByPlatform?: boolean;
    managedByLabel?: string | null;
    managedReference?: string | null;
  } | null;
  /** Set when the workspace's database could not be read — stated rather than guessed at. */
  error: string | null;
}

export interface BroadcastOutcome {
  organizationId: string;
  slug: string;
  ok: boolean;
  notified: number;
  emailed: boolean;
  error: string | null;
}

export interface MaintenanceBroadcastRow {
  id: string;
  enabled: boolean;
  scheduledStartAt: string | null;
  scheduledEndAt: string | null;
  message: string | null;
  actorLabel: string;
  targetCount: number;
  appliedCount: number;
  failedCount: number;
  notifiedCount: number;
  emailedCount: number;
  outcomes: BroadcastOutcome[] | null;
  createdAt: string;
}

/* ================================ Tenant monitoring ================================= */

export interface TenantDatabaseMetrics {
  databaseName: string;
  host: string;
  serverVersion: string | null;
  schema: {
    tableCount: number;
    estimatedRows: number;
    dataBytes: number;
    indexBytes: number;
    totalBytes: number;
    indexShare: number | null;
    largestTables: TenantTableRow[];
    /** Allocated and unused — what a rebuild would hand back. */
    freeBytes: number;
    tablesWithoutPrimaryKey: string[];
    indexHeavyTables: string[];
    engines: Array<{ engine: string; tables: number }>;
    indexCount: number;
    widestIndexes: Array<{ table: string; name: string; columns: string[]; unique: boolean; cardinality: number }>;
  };
  /** Everything here describes the SERVER, which other workspaces may share. */
  server: {
    scope: "server";
    uptimeSec: number | null;
    threadsConnected: number | null;
    threadsRunning: number | null;
    maxConnections: number | null;
    connectionUsePercent: number | null;
    slowQueries: number | null;
    questions: number | null;
    bufferPoolHitRate: number | null;
    abortedConnects: number | null;
    rowsExaminedPerReturned: number | null;
    tmpDiskTablePercent: number | null;
    openTables: number | null;
    tableOpenCache: number | null;
    bufferPoolBytes: number | null;
  };
  /** Statements running right now against this schema, reduced to their SHAPE — literals were
   *  stripped server-side before this left the API, because a tenant's SQL carries a tenant's
   *  data. */
  activeQueries: Array<{ id: number; user: string; host: string | null; command: string; seconds: number; state: string | null; digest: string | null }>;
  queryMs: number;
}

export interface TenantTableRow {
  name: string;
  estimatedRows: number;
  dataBytes: number;
  indexBytes: number;
  totalBytes: number;
  freeBytes: number;
  fragmentation: number | null;
  engine: string | null;
  collation: string | null;
  avgRowBytes: number;
  indexCount: number;
  /** Percent of a signed INT consumed. At 100% every insert fails. */
  autoIncrementUsePercent: number | null;
  hasPrimaryKey: boolean;
}

export interface HealthAlert {
  severity: "critical" | "warning" | "info";
  title: string;
  detail: string;
  area: "database" | "services" | "api" | "server" | "maintenance";
}

/** A panel that may have failed on its own without taking the page with it. */
export interface HealthSection<T> {
  data: T | null;
  error: string | null;
}

export interface FleetHealthRow {
  organizationId: string;
  name: string;
  slug: string;
  status: string;
  planTier: string;
  databaseName: string | null;
  reachable: boolean;
  error: string | null;
  totalBytes: number | null;
  tableCount: number | null;
  estimatedRows: number | null;
  queryMs: number | null;
  maintenancePhase: string | null;
  alerts: HealthAlert[];
}

export const platformOpsApi = {
  fleetMaintenance: async () =>
    (await platformAdminApi.get<{ workspaces: WorkspaceMaintenanceState[]; broadcasts: MaintenanceBroadcastRow[] }>("/maintenance/fleet")).data,

  /** `organizationIds: []` means every reachable workspace — the console always states which. */
  broadcast: async (payload: {
    organizationIds: string[];
    enabled: boolean;
    scheduledStartAt?: string | null;
    scheduledEndAt?: string | null;
    message?: string | null;
    notifyUsers?: boolean;
    emailSuperAdmins?: boolean;
  }) => (await platformAdminApi.post<{ broadcastId: string; outcomes: BroadcastOutcome[] }>("/maintenance/broadcast", payload)).data,

  fleetHealth: async () =>
    (await platformAdminApi.get<{ rows: FleetHealthRow[]; totals: { databases: number; reachable: number; totalBytes: number; alerts: number } }>("/monitoring/fleet")).data,

  tenantHealth: async (orgId: string, days = 30) =>
    (
      await platformAdminApi.get<{
        organization: { id: string; name: string; slug: string; status: string; planTier: string; databaseName: string | null };
        maintenance: HealthSection<{ enabled: boolean; phase: string; scheduledStartAt: string | null; scheduledEndAt: string | null; message: string | null }>;
        system: HealthSection<SystemHealthSnapshot>;
        status: HealthSection<StatusPage>;
        api: HealthSection<ApiPerformanceOverview>;
        database: HealthSection<TenantDatabaseMetrics>;
        alerts: HealthAlert[];
      }>(`/monitoring/${orgId}`, { params: { days } })
    ).data,

  tenantDatabase: async (orgId: string) => (await platformAdminApi.get<TenantDatabaseMetrics>(`/monitoring/${orgId}/database`)).data
};


/* ============================ Trends, operations, advisor =========================== */

export interface DbTrendPoint {
  at: string;
  totalBytes: number;
  dataBytes: number;
  indexBytes: number;
  freeBytes: number;
  estimatedRows: number;
  tableCount: number;
  queryMs: number;
  connectionUsePercent: number | null;
  bufferPoolHitRate: number | null;
}

export interface DbGrowth {
  bytesPerDay: number | null;
  percentChange: number | null;
  rowsPerDay: number | null;
  /** Days until the database reaches `projectionTargetBytes` at the current rate. Null when it is
   *  flat or shrinking — a projection off a negative slope is arithmetic, not information. */
  daysToTarget: number | null;
  projectionTargetBytes: number;
  firstSampleAt: string | null;
  lastSampleAt: string | null;
  samples: number;
}

export interface MaintenanceOperationResult {
  operation: "ANALYZE" | "OPTIMIZE";
  tables: string[];
  ms: number;
  messages: Array<{ table: string; type: string; text: string }>;
  /** Bytes handed back by an OPTIMIZE. Null for ANALYZE, which reclaims nothing. */
  freedBytes: number | null;
}

/** The closed set of actions an advisory finding may name. `executable` marks the two the console
 *  can actually run — both through the same guarded endpoint an operator reaches by hand. */
export type AdvisorActionId = "ANALYZE_TABLES" | "OPTIMIZE_TABLES" | "ARM_MAINTENANCE_WINDOW" | "REVIEW_BACKUP_POLICY" | "REVIEW_INDEXES" | "CONTACT_WORKSPACE" | "MONITOR";

export type AdvisorActionCatalogue = Record<AdvisorActionId, { label: string; executable: boolean; description: string }>;

export interface AdvisorFinding {
  severity: "critical" | "warning" | "info";
  title: string;
  rationale: string;
  action: AdvisorActionId;
  tables: string[];
  confidence: "high" | "medium" | "low";
}

export interface AdviceRow {
  id: string;
  organizationId: string;
  createdAt: string;
  actorLabel: string;
  model: string;
  summary: string;
  findings: AdvisorFinding[] | null;
  inputTokens: number;
  outputTokens: number;
  status: "PENDING" | "APPLIED" | "DISMISSED";
  decidedAt: string | null;
  decidedBy: string | null;
  decisionNote: string | null;
}

export interface PlatformAiSettings {
  enabled: boolean;
  provider: "ANTHROPIC" | "OPENAI_COMPATIBLE" | string;
  baseUrl: string | null;
  model: string;
  /** Whether a key is stored — never the key itself. */
  apiKeySet: boolean;
  dailyCallLimit: number;
  updatedAt: string | null;
  updatedBy: string | null;
  usedToday: number;
}

export const platformOpsExtrasApi = {
  trend: async (orgId: string, days = 30) =>
    (await platformAdminApi.get<{ points: DbTrendPoint[]; growth: DbGrowth }>(`/monitoring/${orgId}/trend`, { params: { days } })).data,
  /** Take a reading of the whole fleet now rather than waiting for the hourly worker. */
  sampleNow: async () => (await platformAdminApi.post<{ sampled: number; failed: Array<{ slug: string; error: string }>; prunedRows: number }>("/monitoring/sample")).data,
  /** The caller names an operation and a table list; it never sends SQL. */
  runOperation: async (orgId: string, operation: "ANALYZE" | "OPTIMIZE", tables: string[]) =>
    (await platformAdminApi.post<MaintenanceOperationResult>(`/monitoring/${orgId}/operation`, { operation, tables })).data,

  aiSettings: async () => (await platformAdminApi.get<{ settings: PlatformAiSettings; actions: AdvisorActionCatalogue }>("/ai/settings")).data,
  saveAiSettings: async (payload: { enabled: boolean; provider: string; baseUrl: string | null; model: string; apiKey?: string; dailyCallLimit: number }) =>
    (await platformAdminApi.put<PlatformAiSettings>("/ai/settings", payload)).data,
  advise: async (orgId: string, days = 30) =>
    (await platformAdminApi.post<{ id: string; summary: string; findings: AdvisorFinding[]; model: string }>(`/ai/advise/${orgId}`, { days })).data,
  advice: async (orgId: string) => (await platformAdminApi.get<{ advice: AdviceRow[] }>(`/ai/advice/${orgId}`)).data,
  decideAdvice: async (adviceId: string, status: "APPLIED" | "DISMISSED", note: string | null) =>
    (await platformAdminApi.post<AdviceRow>(`/ai/advice/${adviceId}/decision`, { status, note })).data
};
