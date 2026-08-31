/**
 * Plan-tier enforcement (Phase B7) — reads the control-plane PlanTierLimit for the current
 * org's tier, or its own per-org override (Organization.seatLimitOverride /
 * aiMonthlyBudgetCeilingOverride, set by a platform admin — see platform-admin.controller.ts),
 * and returns the EFFECTIVE limit. Deliberately re-read on every call rather than cached: if a
 * platform admin lowers a tier's limit (or an org's override) mid-month, that must take effect
 * on the very next check, not after some cache/reconciliation job catches up.
 */
import { controlPrisma } from "../config/control-prisma.js";
import { readFeatureOverrides, resolveEntitlement } from "../utils/feature-overrides.js";

/**
 * The tier a workspace is entitled to RIGHT NOW, which is not always what it has paid for.
 *
 * A trialling workspace is entitled to `trialTier` until `trialEndsAt`, and to `planTier` after.
 * Resolved HERE, in the one function every entitlement read already goes through, so all fifteen
 * capability and quota checks inherit trials without a single caller changing — the same reasoning
 * that put the never-cache rule here rather than in each caller.
 *
 * The comparison is against the clock on every call, deliberately. A trial that expires at 09:00
 * must stop granting Team features at 09:00, not whenever a nightly job next runs; the worker moves
 * the org to GRACE and sends the mail, but it is not what makes the entitlement lapse.
 */
export function effectiveTier(org: { planTier: "STARTER" | "TEAM" | "ENTERPRISE"; trialTier: "STARTER" | "TEAM" | "ENTERPRISE" | null; trialEndsAt: Date | null }): "STARTER" | "TEAM" | "ENTERPRISE" {
  if (org.trialTier && org.trialEndsAt && org.trialEndsAt.getTime() > Date.now()) return org.trialTier;
  return org.planTier;
}

/**
 * THE RESOLUTION POINT (5.0.0).
 *
 * `Organization.featureOverrides` is the general per-org escape from the tier defaults, and this is
 * the one place it is applied — the same reasoning that put `effectiveTier` here rather than in
 * each caller. Every capability and quota check in the product already goes through this function,
 * so all seventeen of them inherit overrides without a single caller changing.
 *
 * TWO THINGS IT IS DELIBERATELY NOT. It is not cached, for the reason at the top of this file: an
 * override set at 09:00 must take effect on the next check. And it does NOT cover `seatLimit` or
 * the AI budget ceiling — those have their own columns and their own readers below, and two places
 * to set one number is a bug waiting for the day they disagree.
 *
 * An override key this build does not recognise is DROPPED by `readFeatureOverrides` rather than
 * honoured or thrown — see that function for why a malformed column must cost the workspace its
 * override and nothing else.
 */
async function getOrgAndTierLimit(orgId: string) {
  const org = await controlPrisma.organization.findUniqueOrThrow({ where: { id: orgId } });
  const tierLimit = await controlPrisma.planTierLimit.findUniqueOrThrow({ where: { tier: effectiveTier(org) } });
  return { org, tierLimit, overrides: readFeatureOverrides(org.featureOverrides) };
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
  const { tierLimit, overrides } = await getOrgAndTierLimit(orgId);
  return Boolean(resolveEntitlement(tierLimit, overrides, "faceVerificationEnabled"));
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
  | "goalsEnabled"
  | "changeManagementEnabled"
  | "practiceUpdateEnabled";

export type PlanningQuota =
  | "maxPortfolios"
  | "maxRequestForms"
  | "maxBlueprints"
  | "maxCustomFields"
  | "maxDashboards"
  | "maxGoals"
  | "maxChangePolicies";

/** One boolean capability. Callers should 403 with an upgrade message when this is false. */
export async function isPlanningCapabilityAllowed(orgId: string, capability: PlanningCapability): Promise<boolean> {
  const { tierLimit, overrides } = await getOrgAndTierLimit(orgId);
  return Boolean(resolveEntitlement(tierLimit, overrides, capability));
}

/** Every capability at once — for the settings screen, which needs to render the whole matrix
 *  and would otherwise make six round trips to the control plane on one page load. */
export async function getPlanningEntitlements(orgId: string): Promise<Record<PlanningCapability, boolean> & Record<PlanningQuota, number>> {
  const { tierLimit, overrides } = await getOrgAndTierLimit(orgId);
  // Through the same resolver as the single-capability reads above, not a second copy of the
  // lookup: this is the matrix the settings screen renders, and a matrix that disagrees with the
  // check that runs a second later is the worst possible way to ship an override.
  const value = <T extends boolean | number>(key: PlanningCapability | PlanningQuota) => resolveEntitlement<T>(tierLimit, overrides, key);
  return {
    ganttEnabled: Boolean(value("ganttEnabled")),
    resourceMgmtEnabled: Boolean(value("resourceMgmtEnabled")),
    approvalsEnabled: Boolean(value("approvalsEnabled")),
    proofingEnabled: Boolean(value("proofingEnabled")),
    customWorkflowsEnabled: Boolean(value("customWorkflowsEnabled")),
    aiPmCopilotEnabled: Boolean(value("aiPmCopilotEnabled")),
    goalsEnabled: Boolean(value("goalsEnabled")),
    changeManagementEnabled: Boolean(value("changeManagementEnabled")),
    practiceUpdateEnabled: Boolean(value("practiceUpdateEnabled")),
    maxPortfolios: value<number>("maxPortfolios"),
    maxRequestForms: value<number>("maxRequestForms"),
    maxBlueprints: value<number>("maxBlueprints"),
    maxCustomFields: value<number>("maxCustomFields"),
    maxDashboards: value<number>("maxDashboards"),
    maxGoals: value<number>("maxGoals"),
    maxChangePolicies: value<number>("maxChangePolicies")
  };
}

/** Ceiling on how many of a countable planning resource this org may have. */
export async function getPlanningQuota(orgId: string, quota: PlanningQuota): Promise<number> {
  const { tierLimit, overrides } = await getOrgAndTierLimit(orgId);
  return resolveEntitlement<number>(tierLimit, overrides, quota);
}
