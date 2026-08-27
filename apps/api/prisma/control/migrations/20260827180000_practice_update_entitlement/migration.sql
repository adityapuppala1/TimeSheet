-- 3.5.0: the Weekly AI/ML Practice Update on the plan-tier matrix.
--
-- PORTABILITY NOTE: `prisma migrate diff` introspected off Windows MariaDB emits `plantierlimit`;
-- written in canonical casing by hand (the 2.4.0 lesson, docs/DATABASE.md).

-- AlterTable
ALTER TABLE `PlanTierLimit` ADD COLUMN `practiceUpdateEnabled` BOOLEAN NOT NULL DEFAULT false;

-- ===================================================================================
-- Set the intended per-tier entitlement ONCE — same pattern and same reasons as
-- 20260819160100_change_management_entitlements:
--
-- * The control seed is a bootstrap step, not something update.sh re-runs, so without this an
--   existing deployment comes out of the upgrade with the practice update dark on every tier.
-- * The column defaults restrictive, so under-entitlement is the failure direction if this UPDATE
--   is ever skipped — an admin sees "not in your plan" rather than a Starter workspace quietly
--   gaining a document that rolls up everyone's hours.
-- * Guarded on "still at the default" so a re-run of an interrupted deploy cannot stomp a platform
--   admin who has since hand-tuned a tier from the Plan tiers console.
-- * Values mirror PLAN_TIER_LIMITS in packages/shared/src/index.ts. Change them there and here
--   together.
--
-- Team and above. A practice update is a management artefact and Team is where a workspace has
-- managers in it; Starter is ten seats, where the roll-up would be the workspace.
-- ===================================================================================

UPDATE `PlanTierLimit`
SET `practiceUpdateEnabled` = TRUE
WHERE `tier` IN ('TEAM', 'ENTERPRISE')
  AND `practiceUpdateEnabled` = FALSE;
