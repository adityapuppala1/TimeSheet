-- V17: attendance / leave / holiday entitlements on the plan-tier matrix.
--
-- Written in canonical `PlanTierLimit` casing by hand (the 2.4.0 lesson, docs/DATABASE.md).

-- AlterTable
ALTER TABLE `PlanTierLimit` ADD COLUMN `attendanceEnabled` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `leaveManagementEnabled` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `attendanceIntegrationsEnabled` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `attendanceAiInsightsEnabled` BOOLEAN NOT NULL DEFAULT false;

-- ===================================================================================
-- Set the intended per-tier entitlements ONCE — same pattern and reasons as
-- 20260819160100_change_management_entitlements:
--
-- * The control seed is a bootstrap step that update.sh does not re-run, so an upgraded install
--   would otherwise come out with attendance dark on every tier. (A FRESH install matches zero rows
--   here and gets the values from the seed's `...limits` spread instead.)
-- * Columns default restrictive, so a skipped UPDATE under-entitles rather than over-entitles.
-- * Each UPDATE is guarded on "still at the default" so re-running an interrupted deploy cannot
--   stomp a tier a platform admin has since hand-tuned.
-- * Values mirror PLAN_TIER_LIMITS in packages/shared/src/index.ts. Change both together.
--
-- Team gets the everyday half (punch-in, holidays, missed-day reasons). Leave, external ingest and
-- AI analytics are what Enterprise buys.
-- ===================================================================================

UPDATE `PlanTierLimit`
SET `attendanceEnabled` = TRUE
WHERE `tier` = 'TEAM'
  AND `attendanceEnabled` = FALSE
  AND `leaveManagementEnabled` = FALSE
  AND `attendanceIntegrationsEnabled` = FALSE
  AND `attendanceAiInsightsEnabled` = FALSE;

UPDATE `PlanTierLimit`
SET `attendanceEnabled`             = TRUE,
    `leaveManagementEnabled`        = TRUE,
    `attendanceIntegrationsEnabled` = TRUE,
    `attendanceAiInsightsEnabled`   = TRUE
WHERE `tier` = 'ENTERPRISE'
  AND `attendanceEnabled` = FALSE
  AND `leaveManagementEnabled` = FALSE
  AND `attendanceIntegrationsEnabled` = FALSE
  AND `attendanceAiInsightsEnabled` = FALSE;
