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
