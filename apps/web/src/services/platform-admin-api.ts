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

export interface PlanTierLimitRow {
  tier: PlanTier;
  seatLimit: number;
  aiMonthlyBudgetCeilingUsd: string;
  allowedSsoProviders: Array<SsoProvider>;
  allowedChatPlatforms: Array<ChatPlatform>;
  /** Whether this tier includes face (identity) verification — Enterprise-only by seed default. */
  faceVerificationEnabled: boolean;
}

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
    payload: Partial<{
      seatLimit: number;
      aiMonthlyBudgetCeilingUsd: number;
      allowedSsoProviders: Array<SsoProvider>;
      allowedChatPlatforms: Array<ChatPlatform>;
      faceVerificationEnabled: boolean;
    }>
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
