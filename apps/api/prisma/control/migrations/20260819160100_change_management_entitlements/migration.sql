-- V8 phase 11: change-management entitlements on the plan-tier matrix.
--
-- PORTABILITY NOTE: `prisma migrate diff` introspected off Windows MariaDB emits `plantierlimit`;
-- written in canonical casing by hand (the 2.4.0 lesson, docs/DATABASE.md).

-- AlterTable
ALTER TABLE `PlanTierLimit` ADD COLUMN `changeManagementEnabled` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `maxChangePolicies` INTEGER NOT NULL DEFAULT 0;

-- ===================================================================================
-- Set the intended per-tier entitlements ONCE — same pattern and same reasons as
-- 20260817150100_v8_goals_entitlements:
--
-- * The control seed is a bootstrap step, not something update.sh re-runs, so without these an
--   existing deployment comes out of the upgrade with change management dark on every tier.
-- * The columns default restrictive, so under-entitlement is the failure direction if this
--   UPDATE is ever skipped — an admin sees "not in your plan" rather than a Starter workspace
--   quietly gaining a governance module.
-- * Each UPDATE is guarded on "still at the default" so a re-run of an interrupted deploy cannot
--   stomp a platform admin who has since hand-tuned a tier from the Plan tiers console.
-- * Values mirror PLAN_TIER_LIMITS in packages/shared/src/index.ts. Change them there and here
--   together.
--
-- Team gets the capability with a policy ceiling rather than being locked out: a ten-person team
-- shipping to production needs a backout plan as much as a bank does. What Enterprise buys is the
-- ceiling coming off, not the module appearing.
-- ===================================================================================

UPDATE `PlanTierLimit`
SET `changeManagementEnabled` = TRUE,
    `maxChangePolicies`       = 5
WHERE `tier` = 'TEAM'
  AND `changeManagementEnabled` = FALSE
  AND `maxChangePolicies` = 0;

UPDATE `PlanTierLimit`
SET `changeManagementEnabled` = TRUE,
    `maxChangePolicies`       = 1000000
WHERE `tier` = 'ENTERPRISE'
  AND `changeManagementEnabled` = FALSE
  AND `maxChangePolicies` = 0;
