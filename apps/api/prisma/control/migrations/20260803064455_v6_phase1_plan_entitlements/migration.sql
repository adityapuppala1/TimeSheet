-- AlterTable
ALTER TABLE `PlanTierLimit` ADD COLUMN `aiPmCopilotEnabled` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `approvalsEnabled` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `customWorkflowsEnabled` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `ganttEnabled` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `maxBlueprints` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `maxCustomFields` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `maxDashboards` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `maxPortfolios` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `maxRequestForms` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `proofingEnabled` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `resourceMgmtEnabled` BOOLEAN NOT NULL DEFAULT false;

-- ===================================================================================
-- Set the intended per-tier planning entitlements ONCE.
--
-- WHY THIS IS HERE AND NOT LEFT TO THE SEED: `apps/api/prisma/control/seed.ts` is a bootstrap
-- step (docs/DEPLOYMENT.md), not something update.sh re-runs. Without these statements an
-- existing deployment would come out of the V6 upgrade with every tier at the column defaults --
-- all-false, all-zero -- and an Enterprise customer would be told to upgrade to use features
-- they already pay for. The columns default restrictive (see the schema comment) precisely so
-- that this is the failure direction if the UPDATE below is ever skipped.
--
-- The values are the same ones in `PLAN_TIER_LIMITS` in packages/shared/src/index.ts, which is
-- the single source of truth the control seed and the marketing pricing table both read. Change
-- them there and here together.
--
-- WHY EACH UPDATE IS GUARDED ON "still at the default": this runs once via `migrate deploy`,
-- but a re-run of an interrupted deploy must not stomp a platform admin who has since
-- hand-tuned a tier from the Plan tiers console. Guarding on the pre-migration state makes the
-- statement a genuine one-time initialisation rather than a policy that reasserts itself.
-- ===================================================================================

UPDATE `PlanTierLimit`
SET `ganttEnabled`           = TRUE,
    `approvalsEnabled`       = TRUE,
    `proofingEnabled`        = TRUE,
    `maxPortfolios`          = 1,
    `maxRequestForms`        = 5,
    `maxBlueprints`          = 5,
    `maxCustomFields`        = 10,
    `maxDashboards`          = 3
WHERE `tier` = 'TEAM'
  AND `ganttEnabled` = FALSE
  AND `approvalsEnabled` = FALSE
  AND `maxPortfolios` = 0;

UPDATE `PlanTierLimit`
SET `ganttEnabled`           = TRUE,
    `resourceMgmtEnabled`    = TRUE,
    `approvalsEnabled`       = TRUE,
    `proofingEnabled`        = TRUE,
    `customWorkflowsEnabled` = TRUE,
    `aiPmCopilotEnabled`     = TRUE,
    `maxPortfolios`          = 1000000,
    `maxRequestForms`        = 1000000,
    `maxBlueprints`          = 1000000,
    `maxCustomFields`        = 1000000,
    `maxDashboards`          = 1000000
WHERE `tier` = 'ENTERPRISE'
  AND `ganttEnabled` = FALSE
  AND `approvalsEnabled` = FALSE
  AND `maxPortfolios` = 0;

-- STARTER is intentionally left at the column defaults (everything off, every count 0): the
-- planning layer is what differentiates the paid tiers, and Starter already has no AI budget at
-- all for the same reason.
