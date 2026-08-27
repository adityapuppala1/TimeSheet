import axios, { type AxiosRequestConfig } from "axios";

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
export type OrgStatus = "PROVISIONING" | "ACTIVE" | "SUSPENDED" | "ARCHIVED";
export type SsoProvider = "GOOGLE" | "MICROSOFT" | "SAML" | "LDAP";
export type ChatPlatform = "SLACK" | "MICROSOFT_TEAMS" | "GOOGLE_CHAT" | "TELEGRAM";

export interface PlatformAdminUser {
  id: string;
  name: string;
  email: string;
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
  logout: async () => platformAdminApi.post("/auth/logout")
};

export interface ProvisionOrgResult {
  organizationId: string;
  databaseName: string;
  schemaVersion: string;
}

export const platformAdminOrgApi = {
  list: async () => (await platformAdminApi.get<OrgListRow[]>("/organizations")).data,
  get: async (id: string) => (await platformAdminApi.get<OrgDetail>(`/organizations/${id}`)).data,
  create: async (payload: { name: string; slug: string; planTier: PlanTier }) =>
    (await platformAdminApi.post<OrgListRow>("/organizations", payload)).data,
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
  ) => (await platformAdminApi.patch<OrgListRow>(`/organizations/${id}`, payload)).data
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
