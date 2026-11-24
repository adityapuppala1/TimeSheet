/**
 * Client for /api/leave (V17 Phase B) — balances, requests, the approver inbox, the team calendar and
 * the super-admin configuration. Days are computed by the server (the preview endpoint mirrors the
 * apply rules), so no screen ever sends or trusts a `days` figure from the client.
 */
import { api } from "./api";

export type LeaveHalf = "FULL" | "FIRST_HALF" | "SECOND_HALF";
export type LeaveStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
export type LeaveAccrual = "YEARLY_UPFRONT" | "MONTHLY_PRORATA";

export interface LeaveTypeRow {
  id: string;
  code: string;
  name: string;
  colour: string | null;
  annualQuota: number;
  accrual: LeaveAccrual;
  carryForwardMax: number;
  allowHalfDay: boolean;
  isPaid: boolean;
  requiresApproval: boolean;
  requiresDocumentAfterDays: number | null;
  allowNegative: boolean;
  enabled: boolean;
  sortOrder: number;
  /** 7.0.0 policy scope: empty = everyone on that axis. */
  scopeEmploymentTypes?: string[];
  scopeSiteIds?: string[];
}

export interface LeaveBalance {
  leaveType: LeaveTypeRow;
  balance: number;
  accrued: number;
  carriedForward: number;
  used: number;
  adjusted: number;
  expired: number;
  pending: number;
  available: number;
  projectedYearEnd: number;
  expiringAtYearEnd: number;
}

export interface LeaveBalances {
  leaveYear: number;
  from: string;
  to: string;
  yearStartMonth: number;
  balances: LeaveBalance[];
}

export interface LeaveRequestRow {
  id: string;
  user?: { id: string; name: string; email: string; avatarUrl: string | null };
  leaveType: { id: string; code: string; name: string; colour: string | null; isPaid: boolean };
  startDate: string;
  endDate: string;
  startHalf: LeaveHalf;
  endHalf: LeaveHalf;
  days: number;
  leaveYear: number;
  /** Present on the requester's own rows and in the approver inbox payload; no screen shows it to a manager. */
  reason?: string | null;
  status: LeaveStatus;
  attachment: { name: string | null; mimeType: string | null; size: number | null; url: string } | null;
  approverId: string | null;
  decidedAt: string | null;
  decisionNote?: string | null;
  overriddenBySuperAdmin: boolean;
  cancelledAt: string | null;
  source: string;
  createdAt: string;
  /** Inbox only: what the requester has left of this type if the request is approved. */
  balanceAfter?: number | null;
}

/** A team-calendar entry: no reason, note or document by design. */
export type TeamLeaveItem = Omit<LeaveRequestRow, "reason" | "decisionNote" | "attachment"> & { user: NonNullable<LeaveRequestRow["user"]> };

export interface LeavePreview {
  ok: boolean;
  problems: Array<{ code: string; message: string }>;
  days: number;
  excluded: Array<{ date: string; reason: "WEEKEND" | "HOLIDAY"; label: string }>;
  balanceBefore: number | null;
  balanceAfter: number | null;
  allowNegative: boolean;
  overlap: { requestId: string; startDate: string; endDate: string } | null;
  documentRequired: boolean;
  requiresApproval: boolean;
  approver: { id: string; name: string; avatarUrl: string | null } | null;
}

export interface PreviewParams {
  typeId: string;
  start: string;
  end: string;
  startHalf?: LeaveHalf;
  endHalf?: LeaveHalf;
}

export interface ApplyPayload {
  leaveTypeId: string;
  startDate: string;
  endDate: string;
  startHalf?: LeaveHalf;
  endHalf?: LeaveHalf;
  reason?: string;
  document?: File | null;
}

export interface BulkResult {
  id: string;
  ok: boolean;
  status?: LeaveStatus;
  error?: string;
  httpStatus?: number;
}

export interface ExpectedHours {
  from: string;
  to: string;
  workingDays: number;
  holidays: number;
  leaveDays: number;
  expectedDays: number;
  dailyHours: number;
  expectedHours: number;
}

export interface LeaveSettings {
  leaveEnabled: boolean;
  leaveYearStartMonth: number;
  trustExternalApprovals: boolean;
  leaveApprovalFallback: "ADMINS" | "SUPER_ADMINS";
}

export type LeaveTypeInput = Omit<LeaveTypeRow, "id" | "sortOrder"> & { sortOrder?: number };

export const LEAVE_STATUS_KEY = ["leave", "status"] as const;

/* ---- 7.0.0 comp-off ---- */
export interface CompOffRow {
  id: string;
  user?: { id: string; name: string; email: string; avatarUrl: string | null };
  workDate: string;
  dayKind: "WEEKEND" | "HOLIDAY";
  hoursLogged: number;
  days: number;
  reason: string | null;
  status: LeaveStatus;
  decidedAt: string | null;
  decisionNote: string | null;
  onBehalfOfId?: string | null;
  onBehalfOf?: string | null;
  expiresOn: string | null;
  expiredAt: string | null;
  createdAt: string;
}

export interface CompOffEligibility {
  workDate: string;
  eligible: boolean;
  dayKind: "WEEKEND" | "HOLIDAY" | null;
  holidayName: string | null;
  hoursLogged: number;
  days: 0 | 0.5 | 1;
  problem: string | null;
  thresholds: { halfDayHours: number; fullDayHours: number };
}

export interface DelegationRow {
  id: string;
  delegator: { id: string; name: string };
  delegate: { id: string; name: string };
  startDate: string;
  endDate: string;
  revoked: boolean;
  active: boolean;
  createdAt: string;
}

export const delegationApi = {
  list: async (scope: "mine" | "all" = "mine") => (await api.get<{ items: DelegationRow[] }>("/leave/delegations", { params: { scope } })).data.items,
  candidates: async (q?: string) => (await api.get<{ items: Array<{ id: string; name: string }> }>("/leave/delegations/candidates", { params: q ? { q } : {} })).data.items,
  create: async (payload: { delegateId: string; delegatorId?: string; startDate: string; endDate: string }) => (await api.post<DelegationRow>("/leave/delegations", payload)).data,
  revoke: async (id: string) => (await api.post<DelegationRow>(`/leave/delegations/${id}/revoke`)).data
};

export interface CompOffSettings {
  compOffEnabled: boolean;
  compOffHalfDayHours: number;
  compOffFullDayHours: number;
  compOffLeaveTypeCode: string;
  compOffExpiryDays: number | null;
}

export const compOffApi = {
  eligibility: async (date: string) => (await api.get<CompOffEligibility>("/leave/me/comp-off/eligibility", { params: { date } })).data,
  mine: async () => (await api.get<{ items: CompOffRow[] }>("/leave/me/comp-off")).data.items,
  request: async (workDate: string, reason?: string) => (await api.post<CompOffRow>("/leave/me/comp-off", reason ? { workDate, reason } : { workDate })).data,
  cancel: async (id: string) => (await api.post<CompOffRow>(`/leave/me/comp-off/${id}/cancel`)).data,
  inbox: async () => (await api.get<{ total: number; items: CompOffRow[] }>("/leave/comp-off/inbox")).data,
  decide: async (id: string, decision: "APPROVE" | "REJECT", note?: string) =>
    (await api.post<CompOffRow>(`/leave/comp-off/inbox/${id}/decision`, note ? { decision, note } : { decision })).data,
  settings: async () => (await api.get<{ settings: CompOffSettings; entitled: boolean }>("/leave/admin/comp-off")).data,
  updateSettings: async (payload: Partial<CompOffSettings>) => (await api.put<CompOffSettings>("/leave/admin/comp-off", payload)).data
};

/** Mirrors the API's cap on one bulk decision (leave.service.ts#BULK_DECISION_MAX). */
export const BULK_DECISION_MAX = 50;

export function chunkIds(ids: readonly string[], size: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/** The Apply body: the optional reason trimmed, and left out entirely when empty. */
export function applyPayload(fields: Omit<ApplyPayload, "reason">, reason: string): ApplyPayload {
  const trimmed = reason.trim();
  return trimmed ? { ...fields, reason: trimmed } : { ...fields };
}

export const leaveApi = {
  status: async () => (await api.get<{ enabled: boolean; leaveYearStartMonth: number; compOffEnabled?: boolean }>("/leave/status")).data,
  types: async () => (await api.get<{ items: LeaveTypeRow[] }>("/leave/types")).data.items,
  balances: async (year?: number) => (await api.get<LeaveBalances>("/leave/me/balances", { params: year ? { year } : {} })).data,
  requests: async (status?: LeaveStatus) => (await api.get<{ items: LeaveRequestRow[] }>("/leave/me/requests", { params: status ? { status } : {} })).data.items,
  preview: async (params: PreviewParams) => (await api.get<LeavePreview>("/leave/me/preview", { params })).data,
  apply: async (payload: ApplyPayload) => {
    const { document, ...fields } = payload;
    if (document) {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== "") form.append(k, String(v));
      form.append("document", document);
      return (await api.post<{ request: LeaveRequestRow; autoApproved: boolean }>("/leave/me/requests", form)).data;
    }
    return (await api.post<{ request: LeaveRequestRow; autoApproved: boolean }>("/leave/me/requests", fields)).data;
  },
  cancel: async (id: string) => (await api.post<LeaveRequestRow>(`/leave/me/requests/${id}/cancel`)).data,
  /** An administrator cancelling someone else's leave: the comment is required (422 LEAVE_CANCEL_COMMENT_REQUIRED) and the person is told. */
  cancelAsAdmin: async (id: string, comment: string) => (await api.post<LeaveRequestRow>(`/leave/me/requests/${id}/cancel`, { comment })).data,
  /** Every approved request an administrator can see (scope=all). */
  approvedAll: async () =>
    (await api.get<{ total: number; items: LeaveRequestRow[] }>("/leave/inbox", { params: { scope: "all", status: "APPROVED", pageSize: 200 } })).data,
  expectedHours: async (from: string, to: string) => (await api.get<ExpectedHours>("/leave/me/expected-hours", { params: { from, to } })).data,
  inbox: async (status: LeaveStatus | "ALL" = "PENDING") =>
    (await api.get<{ total: number; items: LeaveRequestRow[]; compOffPending?: number }>("/leave/inbox", { params: { status, pageSize: 100 } })).data,
  decide: async (id: string, decision: "APPROVE" | "REJECT", note?: string) =>
    (await api.post<LeaveRequestRow>(`/leave/inbox/${id}/decision`, { decision, note })).data,
  // validateStatus lets the 207 body through whatever the per-item outcome was.
  // The server decides at most BULK_DECISION_MAX per call; a bigger selection goes in chunks, in order.
  bulkDecide: async (ids: string[], decision: "APPROVE" | "REJECT", note?: string) => {
    const results: BulkResult[] = [];
    for (const chunk of chunkIds(ids, BULK_DECISION_MAX)) {
      results.push(...(await api.post<{ results: BulkResult[] }>("/leave/inbox/bulk-decision", { ids: chunk, decision, note })).data.results);
    }
    return results;
  },
  team: async (from: string, to: string) => (await api.get<{ from: string; to: string; items: TeamLeaveItem[] }>("/leave/team", { params: { from, to } })).data.items
};

const ADMIN = "/leave/admin";

export const leaveAdminApi = {
  settings: async () =>
    (
      await api.get<{ settings: LeaveSettings; entitled: boolean; effective: boolean; leaveYearLocked?: boolean; leaveYearLockedMessage?: string | null }>(
        `${ADMIN}/settings`
      )
    ).data,
  updateSettings: async (payload: Partial<LeaveSettings>) => (await api.put<LeaveSettings>(`${ADMIN}/settings`, payload)).data,
  types: async () => (await api.get<{ items: LeaveTypeRow[] }>(`${ADMIN}/types`)).data.items,
  createType: async (payload: LeaveTypeInput & { code: string }) => (await api.post<LeaveTypeRow>(`${ADMIN}/types`, payload)).data,
  updateType: async (id: string, payload: Partial<LeaveTypeInput>) => (await api.put<LeaveTypeRow>(`${ADMIN}/types/${id}`, payload)).data,
  /** Super admin only: one person's balances (GET /leave/admin/balances/:userId). */
  balancesFor: async (userId: string) => (await api.get<LeaveBalances>(`${ADMIN}/balances/${userId}`)).data,
  adjust: async (payload: { userId: string; leaveTypeId: string; delta: number; reason: string; leaveYear?: number }) =>
    (await api.post(`${ADMIN}/adjustments`, payload)).data
};
