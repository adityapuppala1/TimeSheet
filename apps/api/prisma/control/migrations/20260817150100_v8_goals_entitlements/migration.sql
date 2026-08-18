-- V8 phase 1: goals entitlements on the plan-tier matrix.
--
-- PORTABILITY NOTE: `prisma migrate diff` introspected off Windows MariaDB emitted
-- `plantierlimit`; corrected to canonical casing (the 2.4.0 lesson, docs/DATABASE.md).

-- AlterTable
ALTER TABLE `PlanTierLimit` ADD COLUMN `goalsEnabled` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `maxGoals` INTEGER NOT NULL DEFAULT 0;

-- ===================================================================================
-- Set the intended per-tier goals entitlements ONCE — the same pattern, for the same reasons,
-- as 20260803064455_v6_phase1_plan_entitlements:
--
-- * The control seed is a bootstrap step, not something update.sh re-runs, so without these an
--   existing deployment comes out of the upgrade with goals dark on every tier — an Enterprise
--   customer told to upgrade to use a feature they already pay for.
-- * The columns default restrictive so that under-entitlement is the failure direction if this
--   UPDATE is ever skipped.
-- * Each UPDATE is guarded on "still at the default" so a re-run of an interrupted deploy
--   cannot stomp a platform admin who has since hand-tuned a tier from the Plan tiers console.
-- * Values mirror PLAN_TIER_LIMITS in packages/shared/src/index.ts — the single source of truth
--   the control seed and the pricing table both read. Change them there and here together.
-- ===================================================================================

UPDATE `PlanTierLimit`
SET `goalsEnabled` = TRUE,
    `maxGoals`     = 25
WHERE `tier` = 'TEAM'
  AND `goalsEnabled` = FALSE
  AND `maxGoals` = 0;

UPDATE `PlanTierLimit`
SET `goalsEnabled` = TRUE,
    `maxGoals`     = 1000000
WHERE `tier` = 'ENTERPRISE'
  AND `goalsEnabled` = FALSE
  AND `maxGoals` = 0;
