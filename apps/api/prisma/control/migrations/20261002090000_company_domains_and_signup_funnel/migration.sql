-- Signup Phase 1 (docs/SIGNUP_AND_DOMAINS_PLAN.md §5): one workspace per company domain, a funnel the
-- console can draw, and a way for a daily job to run once however many API replicas there are.
--
-- (1) `OrgEmailDomain` — a company's claim on its email domain. `domain` is UNIQUE, and that index is
--     the rule: two people from one new company finishing signup at the same moment cannot both
--     create a workspace; the second INSERT fails and that person is sent to the join path. NOT a
--     custom hostname — that is `OrgDomain`, which this does not touch.
-- (2) `SignupAttempt` — one row per stage a signup reached (code sent, refused, verified, created,
--     asked to join, unavailable, failed). Domain and a keyed hash only; never an address.
-- (3) `PlatformJobClaim` — "this job ran for this period". Every replica runs the same cron; the one
--     whose INSERT wins does the work. First users: the daily signup summary and the once-an-hour
--     "provisioning is failing" warning.
-- (4) `Organization.createdVia` — "SELF_SERVE" or "CONSOLE", so the console stops counting customers
--     who signed themselves up together with ones an operator created.
--
-- ===================================================================================
-- WHAT EXISTING ROWS DO.
--
-- `createdVia` is backfilled: a workspace that started a trial came from signup (only signup starts
-- one), everything else from the console. The UPDATE touches only rows still NULL, so a re-run
-- changes nothing.
--
-- `OrgEmailDomain` starts EMPTY on purpose. Existing workspaces get their claims from the console's
-- "Backfill from signup emails" action, which shows a dry run first and lists every domain two
-- workspaces share as a CONFLICT for an operator to settle — a migration has no operator to ask, and
-- picking one of two companies' workspaces silently is the mistake that action exists to prevent.
--
-- CANONICAL CASING, written by hand: Windows MariaDB emits lowercase table names (the 2.4.0 lesson,
-- docs/DATABASE.md).
-- ===================================================================================
--
-- Every statement is guarded — tables with IF NOT EXISTS, the column and the foreign key through an
-- information_schema check + PREPARE, the backfill by its own WHERE — so a run interrupted anywhere
-- replays safely. The control-plane checks in tests/unit/migration-portability.test.ts hold it to that.
-- @rerunnable

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Organization' AND COLUMN_NAME = 'createdVia');
SET @ddl := IF(@c = 0, 'ALTER TABLE `Organization` ADD COLUMN `createdVia` VARCHAR(16) NULL', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

UPDATE `Organization`
   SET `createdVia` = IF(`trialStartedAt` IS NOT NULL, 'SELF_SERVE', 'CONSOLE')
 WHERE `createdVia` IS NULL;

CREATE TABLE IF NOT EXISTS `OrgEmailDomain` (
    `id` VARCHAR(191) NOT NULL,
    `domain` VARCHAR(253) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'UNVERIFIED',
    `source` VARCHAR(16) NOT NULL,
    `verifiedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `OrgEmailDomain_domain_key`(`domain`),
    INDEX `OrgEmailDomain_organizationId_idx`(`organizationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @f := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'OrgEmailDomain' AND CONSTRAINT_NAME = 'OrgEmailDomain_organizationId_fkey');
SET @ddl := IF(@f = 0, 'ALTER TABLE `OrgEmailDomain` ADD CONSTRAINT `OrgEmailDomain_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS `SignupAttempt` (
    `id` VARCHAR(191) NOT NULL,
    `stage` VARCHAR(16) NOT NULL,
    `domain` VARCHAR(253) NULL,
    `emailHash` CHAR(64) NULL,
    `organizationId` VARCHAR(191) NULL,
    `detail` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `SignupAttempt_createdAt_idx`(`createdAt`),
    INDEX `SignupAttempt_stage_createdAt_idx`(`stage`, `createdAt`),
    INDEX `SignupAttempt_organizationId_stage_createdAt_idx`(`organizationId`, `stage`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `PlatformJobClaim` (
    `job` VARCHAR(64) NOT NULL,
    `periodKey` VARCHAR(32) NOT NULL,
    `claimedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`job`, `periodKey`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
