-- V8 phase 1: Goals/OKRs. See docs/AGENTIC_WORK_MANAGEMENT.md §5 phase 1 and §7 decision 4.
--
-- PORTABILITY NOTE (the 2.4.0 lesson, docs/DATABASE.md "three portability traps"): every table
-- name below is in canonical model casing. The `prisma migrate diff` this file started from was
-- introspected off a Windows MariaDB with lower_case_table_names=1 and emitted
-- `globalplanningsettings` — which works here and dies on case-sensitive Linux MySQL. Corrected
-- by hand; the migration-history tests assert canonical casing so the next one is caught in CI.
--
-- Additive only: one defaulted column on an existing table, three new tables, and an idempotent
-- permission backfill. Nothing here reads or rewrites an existing row, so an upgrade cannot lose
-- data.
--
-- WHY THE ALTER IS GUARDED: this file ends with DML (the permission backfill), so it can die
-- half-applied — and recovery is `migrate resolve --rolled-back` followed by `migrate deploy`,
-- which RE-RUNS the whole file over the partial state. A bare ADD COLUMN would then fail on
-- "Duplicate column name" and the database would be stuck for a second reason. MySQL has no
-- `ADD COLUMN IF NOT EXISTS` (MariaDB does, and relying on it is the engine split 2.4.0 was
-- about), so the portable form is to ask information_schema and PREPARE either the real
-- statement or a no-op. The CREATE TABLEs below need no guard: a re-run fails at the first
-- CREATE, long before anything else, which is the convention the migration-portability test
-- encodes.
SET @stmt := (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `GlobalPlanningSettings` ADD COLUMN `enableGoals` BOOLEAN NOT NULL DEFAULT false',
    'DO 0'
  )
  FROM `information_schema`.`COLUMNS`
  WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'GlobalPlanningSettings' AND `COLUMN_NAME` = 'enableGoals'
);
PREPARE `guarded_stmt` FROM @stmt;
EXECUTE `guarded_stmt`;
DEALLOCATE PREPARE `guarded_stmt`;

-- CreateTable
CREATE TABLE `Goal` (
    `id` VARCHAR(191) NOT NULL,
    `title` VARCHAR(200) NOT NULL,
    `description` TEXT NULL,
    `parentId` VARCHAR(191) NULL,
    `ownerId` VARCHAR(191) NULL,
    `startDate` DATE NULL,
    `endDate` DATE NULL,
    `status` ENUM('ACTIVE', 'ACHIEVED', 'CLOSED') NOT NULL DEFAULT 'ACTIVE',
    `progressSource` ENUM('MANUAL', 'APPROVED_HOURS', 'BUDGET_SPEND', 'TICKETS_CLOSED', 'ON_TIME_RATE', 'SLA_BREACHES', 'RISK_SCORE') NOT NULL DEFAULT 'MANUAL',
    `targetValue` DECIMAL(14, 2) NULL,
    `unit` VARCHAR(20) NULL,
    `manualProgressPct` INTEGER NULL,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    INDEX `Goal_status_deletedAt_idx`(`status`, `deletedAt`),
    INDEX `Goal_parentId_idx`(`parentId`),
    INDEX `Goal_ownerId_idx`(`ownerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GoalLink` (
    `id` VARCHAR(191) NOT NULL,
    `goalId` VARCHAR(191) NOT NULL,
    `targetType` ENUM('PROJECT', 'PORTFOLIO', 'TICKET') NOT NULL,
    `targetId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `GoalLink_targetType_targetId_idx`(`targetType`, `targetId`),
    UNIQUE INDEX `GoalLink_goalId_targetType_targetId_key`(`goalId`, `targetType`, `targetId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GoalProgressOverride` (
    `id` VARCHAR(191) NOT NULL,
    `goalId` VARCHAR(191) NOT NULL,
    `progressPct` INTEGER NOT NULL,
    `measuredValue` DECIMAL(14, 2) NULL,
    `measuredPct` INTEGER NULL,
    `note` VARCHAR(500) NOT NULL,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `GoalProgressOverride_goalId_createdAt_idx`(`goalId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Goal` ADD CONSTRAINT `Goal_parentId_fkey` FOREIGN KEY (`parentId`) REFERENCES `Goal`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Goal` ADD CONSTRAINT `Goal_ownerId_fkey` FOREIGN KEY (`ownerId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Goal` ADD CONSTRAINT `Goal_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `GoalLink` ADD CONSTRAINT `GoalLink_goalId_fkey` FOREIGN KEY (`goalId`) REFERENCES `Goal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `GoalProgressOverride` ADD CONSTRAINT `GoalProgressOverride_goalId_fkey` FOREIGN KEY (`goalId`) REFERENCES `Goal`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `GoalProgressOverride` ADD CONSTRAINT `GoalProgressOverride_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- ===================================================================================
-- Permission backfill — the V6 phase-1 lesson, applied again.
--
-- `prisma/seed.ts` is a one-time bootstrap that never runs on upgrade (and would wipe
-- hand-customised grants if it did), so a permission key added to @timesheet/shared reaches
-- fresh installs and silently 403s for every existing customer unless the migration that
-- introduces it also backfills it. Every INSERT is `SELECT ... WHERE NOT EXISTS` — idempotent,
-- and a re-run of an interrupted deploy changes nothing.
--
-- Who gets goals:manage: SUPER_ADMIN, ADMIN, MANAGER, TEAM_LEAD. Broader than
-- portfolios:manage (admins only) because goals are the alignment surface managers own —
-- a manager who cannot write the goals their team is measured against has nothing to manage.
-- EMPLOYEE reads goals (no permission needed) but does not edit them.
-- ===================================================================================

INSERT INTO `Permission` (`id`, `key`, `description`)
SELECT UUID() AS id, 'goals:manage' AS `key`, 'Create and edit goals, close them, and record progress overrides' AS description
WHERE NOT EXISTS (SELECT 1 FROM `Permission` WHERE `key` = 'goals:manage');

INSERT INTO `RolePermission` (`roleId`, `permissionId`)
SELECT r.`id`, p.`id`
FROM `Role` r
CROSS JOIN `Permission` p
WHERE r.`name` IN ('SUPER_ADMIN', 'ADMIN', 'MANAGER', 'TEAM_LEAD')
  AND p.`key` = 'goals:manage'
  AND NOT EXISTS (
    SELECT 1 FROM `RolePermission` rp WHERE rp.`roleId` = r.`id` AND rp.`permissionId` = p.`id`
  );

