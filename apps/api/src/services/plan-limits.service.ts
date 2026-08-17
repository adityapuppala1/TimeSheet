/**
 * Plan-tier enforcement (Phase B7) — reads the control-plane PlanTierLimit for the current
 * org's tier, or its own per-org override (Organization.seatLimitOverride /
 * aiMonthlyBudgetCeilingOverride, set by a platform admin — see platform-admin.controller.ts),
 * and returns the EFFECTIVE limit. Deliberately re-read on every call rather than cached: if a
 * platform admin lowers a tier's limit (or an org's override) mid-month, that must take effect
 * on the very next check, not after some cache/reconciliation job catches up.
 */
import { controlPrisma } from "../config/control-prisma.js";

async function getOrgAndTierLimit(orgId: string) {
  const org = await controlPrisma.organization.findUniqueOrThrow({ where: { id: orgId } });
  const tierLimit = await controlPrisma.planTierLimit.findUniqueOrThrow({ where: { tier: org.planTier } });
  return { org, tierLimit };
}

export async function getEffectiveSeatLimit(orgId: string): Promise<number> {
  const { org, tierLimit } = await getOrgAndTierLimit(orgId);
  return org.seatLimitOverride ?? tierLimit.seatLimit;
}

/** Always a real number — PlanTierLimit.aiMonthlyBudgetCeilingUsd is NOT NULL, so unlike the
 *  org's own optional GlobalAISettings.monthlyBudgetUsd (where null/unset means "no cap"), a
 *  ceiling of exactly 0 here is a deliberate, enforced "no AI budget on this tier" — see
 *  ai.service.ts#preflight, which is why assertWithinBudget no longer treats 0 as unlimited. */
export async function getEffectiveAiBudgetCeiling(orgId: string): Promise<number> {
  const { org, tierLimit } = await getOrgAndTierLimit(orgId);
  return Number(org.aiMonthlyBudgetCeilingOverride ?? tierLimit.aiMonthlyBudgetCeilingUsd);
}

export async function getAllowedSsoProviders(orgId: string): Promise<string[]> {
  const { tierLimit } = await getOrgAndTierLimit(orgId);
  return tierLimit.allowedSsoProviders as string[];
}

export async function getAllowedChatPlatforms(orgId: string): Promise<string[]> {
  const { tierLimit } = await getOrgAndTierLimit(orgId);
  return tierLimit.allowedChatPlatforms as string[];
}

/**
 * Whether this org's tier includes face (identity) verification — Enterprise-only by seed
 * default. Two DIFFERENT failure directions hang off this one boolean, deliberately:
 * - configuration/enrollment/verification fail CLOSED (403 — you can't start using a feature
 *   your plan doesn't include), while
 * - enforcement on submissions fails OPEN (isFaceVerificationRequired returns false), because a
 *   lapsed payment must stop DEMANDING face checks, not lock a whole workforce out of logging
 *   their own time.
 * Getting those backwards turns a billing event into a company-wide outage.
 */
export async function isFaceVerificationAllowed(orgId: string): Promise<boolean> {
  const { tierLimit } = await getOrgAndTierLimit(orgId);
  return Boolean(tierLimit.faceVerificationEnabled);
}

/* ------------------------------------------------------------------ *
 * PLANNING LAYER (V6) entitlements.
 *
 * Same never-cached, re-read-per-call rule as everything above. All of these fail CLOSED: a
 * missing or restrictive value means the capability is refused, which is why the control-plane
 * columns default to false/0 (see the schema comment) — a tier row that somehow missed its
 * initialisation under-entitles rather than over-entitles.
 *
 * NOTE the deliberate asymmetry with face verification: there is no fail-open counterpart here.
 * A lapsed plan must not lock people out of logging time (hence face enforcement fails open),
 * but planning data is never load-bearing for someone doing their day job — a downgraded org
 * loses the Gantt VIEW while every ticket, date and booking stays in the database, readable and
 * intact. Losing a view is a recoverable annoyance; being unable to submit a timesheet is not.
 * ------------------------------------------------------------------ */

export type PlanningCapability =
  | "ganttEnabled"
  | "resourceMgmtEnabled"
  | "approvalsEnabled"
  | "proofingEnabled"
  | "customWorkflowsEnabled"
  | "aiPmCopilotEnabled"
  | "goalsEnabled";

export type PlanningQuota =
  | "maxPortfolios"
  | "maxRequestForms"
  | "maxBlueprints"
  | "maxCustomFields"
  | "maxDashboards"
  | "maxGoals";

/** One boolean capability. Callers should 403 with an upgrade message when this is false. */
export async function isPlanningCapabilityAllowed(orgId: string, capability: PlanningCapability): Promise<boolean> {
  const { tierLimit } = await getOrgAndTierLimit(orgId);
  return Boolean(tierLimit[capability]);
}

/** Every capability at once — for the settings screen, which needs to render the whole matrix
 *  and would otherwise make six round trips to the control plane on one page load. */
export async function getPlanningEntitlements(orgId: string): Promise<Record<PlanningCapability, boolean> & Record<PlanningQuota, number>> {
  const { tierLimit } = await getOrgAndTierLimit(orgId);
  return {
    ganttEnabled: Boolean(tierLimit.ganttEnabled),
    resourceMgmtEnabled: Boolean(tierLimit.resourceMgmtEnabled),
    approvalsEnabled: Boolean(tierLimit.approvalsEnabled),
    proofingEnabled: Boolean(tierLimit.proofingEnabled),
    customWorkflowsEnabled: Boolean(tierLimit.customWorkflowsEnabled),
    aiPmCopilotEnabled: Boolean(tierLimit.aiPmCopilotEnabled),
    goalsEnabled: Boolean(tierLimit.goalsEnabled),
    maxPortfolios: tierLimit.maxPortfolios,
    maxRequestForms: tierLimit.maxRequestForms,
    maxBlueprints: tierLimit.maxBlueprints,
    maxCustomFields: tierLimit.maxCustomFields,
    maxDashboards: tierLimit.maxDashboards,
    maxGoals: tierLimit.maxGoals
  };
}

/** Ceiling on how many of a countable planning resource this org may have. */
export async function getPlanningQuota(orgId: string, quota: PlanningQuota): Promise<number> {
  const { tierLimit } = await getOrgAndTierLimit(orgId);
  return tierLimit[quota];
}
