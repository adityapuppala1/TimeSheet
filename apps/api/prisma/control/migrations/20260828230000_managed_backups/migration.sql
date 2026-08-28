-- 3.14.0: managed backups — a per-tier entitlement, per-organization schedules and retention, and
-- destinations that are not this server's disk.
--
-- EVERY NEW TIER COLUMN DEFAULTS TO THE RESTRICTIVE VALUE, the same rule every entitlement block in
-- this schema follows: a tier row that exists but has not been re-seeded is under-entitled rather
-- than over-entitled. `backupFrequency` therefore starts at NONE for all three tiers, and the
-- guarded UPDATE below sets the real Team/Enterprise values from @timesheet/shared's
-- PLAN_TIER_LIMITS — so an existing deployment gains the module without a re-seed, and a Starter
-- workspace never silently gains it.
--
-- NOTHING IS BACKFILLED FOR ORGANIZATIONS. No policy row is created, so no workspace starts backing
-- itself up because somebody ran a migration. A policy exists only once an operator makes one.
--
-- PORTABILITY NOTE: written in canonical casing by hand — `prisma migrate diff` introspected off
-- Windows MariaDB emits lowercase table names (the 2.4.0 lesson, docs/DATABASE.md).

-- AlterTable
ALTER TABLE `PlanTierLimit` ADD COLUMN `backupFrequency` ENUM('NONE', 'WEEKLY', 'DAILY', 'HOURLY') NOT NULL DEFAULT 'NONE';
ALTER TABLE `PlanTierLimit` ADD COLUMN `maxBackupDestinations` INTEGER NOT NULL DEFAULT 0;
ALTER TABLE `PlanTierLimit` ADD COLUMN `backupPitrEnabled` BOOLEAN NOT NULL DEFAULT false;

-- Guarded: only rows that are still at the restrictive default are raised, so an operator who has
-- already tuned a tier by hand is never overwritten by a schema change.
UPDATE `PlanTierLimit` SET `backupFrequency` = 'WEEKLY', `maxBackupDestinations` = 1 WHERE `tier` = 'TEAM' AND `backupFrequency` = 'NONE';
UPDATE `PlanTierLimit` SET `backupFrequency` = 'DAILY', `maxBackupDestinations` = 5, `backupPitrEnabled` = true WHERE `tier` = 'ENTERPRISE' AND `backupFrequency` = 'NONE';

-- CreateTable
CREATE TABLE `BackupDestination` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NULL,
    `name` VARCHAR(120) NOT NULL,
    `kind` ENUM('LOCAL', 'S3', 'AZURE_BLOB', 'GOOGLE_DRIVE', 'ONEDRIVE', 'SFTP') NOT NULL,
    `config` JSON NOT NULL,
    `encryptedSecret` TEXT NULL,
    `prefix` VARCHAR(255) NULL,
    `isDefault` BOOLEAN NOT NULL DEFAULT false,
    `lastTestedAt` DATETIME(3) NULL,
    `lastTestStatus` VARCHAR(16) NULL,
    `lastTestMessage` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `BackupDestination_organizationId_idx`(`organizationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OrgBackupPolicy` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `frequency` ENUM('NONE', 'WEEKLY', 'DAILY', 'HOURLY') NOT NULL DEFAULT 'NONE',
    `hourUtc` INTEGER NOT NULL DEFAULT 2,
    `dayOfWeek` INTEGER NOT NULL DEFAULT 0,
    `destinationId` VARCHAR(191) NULL,
    `retentionMode` ENUM('COUNT', 'AGE', 'GFS') NOT NULL DEFAULT 'COUNT',
    `keepCount` INTEGER NOT NULL DEFAULT 7,
    `keepDays` INTEGER NOT NULL DEFAULT 30,
    `gfsDaily` INTEGER NOT NULL DEFAULT 7,
    `gfsWeekly` INTEGER NOT NULL DEFAULT 4,
    `gfsMonthly` INTEGER NOT NULL DEFAULT 12,
    `gfsYearly` INTEGER NOT NULL DEFAULT 3,
    `alertEmails` VARCHAR(1000) NULL,
    `encryptedAlertWebhook` TEXT NULL,
    `alertOnSuccess` BOOLEAN NOT NULL DEFAULT false,
    `alertOnFailure` BOOLEAN NOT NULL DEFAULT true,
    `lastRunAt` DATETIME(3) NULL,
    `lastStatus` ENUM('RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED') NULL,
    `nextRunAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `OrgBackupPolicy_organizationId_key`(`organizationId`),
    INDEX `OrgBackupPolicy_enabled_nextRunAt_idx`(`enabled`, `nextRunAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `BackupRun` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `destinationId` VARCHAR(191) NULL,
    `kind` ENUM('SCHEDULED', 'MANUAL', 'PRE_DELETE', 'TEST_RESTORE') NOT NULL,
    `status` ENUM('RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED') NOT NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finishedAt` DATETIME(3) NULL,
    `bytes` BIGINT NULL,
    `objectKey` VARCHAR(1024) NULL,
    `checksumSha256` CHAR(64) NULL,
    `errorMessage` TEXT NULL,
    `retentionTag` VARCHAR(16) NULL,
    `metadata` JSON NULL,

    INDEX `BackupRun_organizationId_startedAt_idx`(`organizationId`, `startedAt`),
    INDEX `BackupRun_status_startedAt_idx`(`status`, `startedAt`),
    INDEX `BackupRun_destinationId_idx`(`destinationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `BackupDestination` ADD CONSTRAINT `BackupDestination_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrgBackupPolicy` ADD CONSTRAINT `OrgBackupPolicy_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrgBackupPolicy` ADD CONSTRAINT `OrgBackupPolicy_destinationId_fkey` FOREIGN KEY (`destinationId`) REFERENCES `BackupDestination`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `BackupRun` ADD CONSTRAINT `BackupRun_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `BackupRun` ADD CONSTRAINT `BackupRun_destinationId_fkey` FOREIGN KEY (`destinationId`) REFERENCES `BackupDestination`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
