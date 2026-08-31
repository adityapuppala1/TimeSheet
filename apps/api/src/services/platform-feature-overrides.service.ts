/**
 * WHAT: the general per-org escape from the tier defaults — "give THIS workspace THIS one thing" —
 * read, written, and recorded.
 *
 * WHY IT EXISTS. `Organization` has carried `seatLimitOverride` and `aiMonthlyBudgetCeilingOverride`
 * since Phase B6, and between them they cover seats and AI budget. Nothing else had an escape at
 * all. So switching one beta on for one design partner meant moving their whole tier — which hands
 * them nine other features nobody agreed to, changes what every entitlement check believes they
 * have paid for, and has to be remembered and reversed by hand afterwards. The escape was missing,
 * so the blunt instrument got used instead.
 *
 * THE RULE — an override may never silently GRANT past the plan — and the allowlist of keys both
 * live in `utils/feature-overrides.ts`, which is pure and has no database. This file is the half
 * that touches the world: it resolves which tier to judge an override against, it enforces the
 * acknowledgement, and it writes the audit row. Three mechanisms stand between an operator and an
 * accidental grant, and all three are here or in that util:
 *   1. `classifyOverrides` names the EFFECT of every key against the tier the workspace actually
 *      has right now — trial included, because judging against `planTier` while the resolver reads
 *      `trialTier` would show an operator the wrong answer for the length of a trial.
 *   2. The write REFUSES a body containing any grant unless the caller acknowledges it, and the
 *      refusal names the granting keys. Nobody arrives at a grant by accident.
 *   3. Every write lands in `platformAudit` with the before, the after, and the granting keys — so
 *      "who gave Acme the AI copilot, and when" is one query rather than an archaeology project.
 */
import { Prisma } from "../generated/control-client/index.js";
import { controlPrisma } from "../config/control-prisma.js";
import { AppError } from "../middleware/error.js";
import {
  classifyOverrides,
  FEATURE_OVERRIDE_KEYS,
  grantingKeys,
  OVERRIDABLE_FEATURES,
  readFeatureOverrides,
  type ClassifiedOverride,
  type FeatureOverrideKey,
  type FeatureOverrides
} from "../utils/feature-overrides.js";
import { platformAudit } from "./platform-audit.service.js";
import { effectiveTier } from "./plan-limits.service.js";

export interface OrgOverrideView {
  organizationId: string;
  slug: string;
  /** The tier the workspace is entitled to RIGHT NOW, trial included — the same answer
   *  `plan-limits.service.ts` resolves, so the console's judgement and the enforcement agree. */
  effectiveTier: string;
  overrides: FeatureOverrides;
  classified: ClassifiedOverride[];
  grants: FeatureOverrideKey[];
  /**
   * Every key that MAY be overridden, with what this workspace's tier gives it.
   *
   * Sent to the console rather than hard-coded there: the allowlist in `utils/feature-overrides.ts`
   * is the authority, and a second copy in a React component is a list of switches that silently
   * does nothing the first time the two drift. It also means the editor can offer a key the
   * workspace has never overridden, which is the common case.
   */
  available: Array<{ key: FeatureOverrideKey; kind: "boolean" | "quota"; tierValue: boolean | number }>;
}

/** The allowlist, resolved against one tier's row. */
const availableFor = (tierLimit: Record<string, unknown>) =>
  FEATURE_OVERRIDE_KEYS.map((key) => ({ key, kind: OVERRIDABLE_FEATURES[key], tierValue: tierLimit[key] as boolean | number }));

async function loadOrgAndTier(orgId: string) {
  const org = await controlPrisma.organization.findUnique({ where: { id: orgId } });
  if (!org) throw new AppError(404, "Organization not found");
  const tier = effectiveTier(org);
  const tierLimit = await controlPrisma.planTierLimit.findUnique({ where: { tier } });
  if (!tierLimit) throw new AppError(409, `This deployment has no plan-tier row for ${tier}, so an override cannot be judged against it.`);
  return { org, tier, tierLimit };
}

export async function getOrgFeatureOverrides(orgId: string): Promise<OrgOverrideView> {
  const { org, tier, tierLimit } = await loadOrgAndTier(orgId);
  const overrides = readFeatureOverrides(org.featureOverrides);
  const limit = tierLimit as unknown as Record<string, unknown>;
  const classified = classifyOverrides(limit, overrides);
  return { organizationId: org.id, slug: org.slug, effectiveTier: tier, overrides, classified, grants: grantingKeys(classified), available: availableFor(limit) };
}

/**
 * Replace a workspace's overrides wholesale.
 *
 * REPLACE, NOT MERGE, and that is the safer of the two. A merge means there is no way to remove an
 * override except by knowing it is there — so a key set by somebody who has since left stays set
 * forever, invisibly, because nobody thought to unset what they could not see. `{}` clears
 * everything, which is a sentence an operator can say out loud.
 *
 * THE GRANT GATE. Any key that hands out something the tier forbids requires `acknowledgeGrants`.
 * Without it this refuses with a 422 that NAMES those keys.
 */
export async function setOrgFeatureOverrides(input: {
  orgId: string;
  overrides: FeatureOverrides;
  acknowledgeGrants: boolean;
  actorLabel: string;
  reason?: string;
  ipAddress?: string;
}): Promise<OrgOverrideView> {
  const { org, tier, tierLimit } = await loadOrgAndTier(input.orgId);

  // Sanitised BEFORE classification, so an unknown key can never reach the stored column and can
  // never be classified as a grant of something that does not exist.
  const clean = readFeatureOverrides(input.overrides);
  const classified = classifyOverrides(tierLimit as unknown as Record<string, unknown>, clean);
  const grants = grantingKeys(classified);

  if (grants.length > 0 && !input.acknowledgeGrants) {
    throw new AppError(
      422,
      // The granting keys are NAMED in the message rather than carried in a structured field:
      // `AppError` takes a code and nothing else, and the console already knows which keys grant
      // because `GET` hands it the same classification this refusal was computed from. The message
      // is the backstop for anything calling the API directly, and it has to be readable.
      `This would grant ${grants.join(", ")} beyond what the ${tier} plan includes. That is allowed, but it has to be deliberate — confirm the grant and it will be recorded against your name in the audit trail.`,
      { code: "OVERRIDE_GRANTS_BEYOND_PLAN" }
    );
  }

  const before = readFeatureOverrides(org.featureOverrides);
  await controlPrisma.organization.update({
    where: { id: org.id },
    data: {
      // SQL NULL rather than `{}` when empty, so "no override" is ONE state in the database rather
      // than two every reader would have to treat alike. `Prisma.DbNull` and not a bare `null`: on
      // a nullable Json column Prisma cannot tell a bare null from the JSON value `null`, which
      // would be a third state and the worst of the three.
      featureOverrides: Object.keys(clean).length ? (clean as Prisma.InputJsonValue) : Prisma.DbNull
    }
  });

  // AWAITED, not detached. The whole promise of this feature is that a grant cannot happen
  // unrecorded, and a fire-and-forget audit write is a recording that may or may not exist.
  await platformAudit(
    "PLATFORM_ADMIN",
    input.actorLabel,
    "organization.feature_overrides_set",
    "Organization",
    org.id,
    { slug: org.slug, tier, keys: Object.keys(clean), grants },
    { reason: input.reason, ipAddress: input.ipAddress, before, after: clean as Prisma.InputJsonValue }
  );

  return { organizationId: org.id, slug: org.slug, effectiveTier: tier, overrides: clean, classified, grants, available: availableFor(tierLimit as unknown as Record<string, unknown>) };
}
