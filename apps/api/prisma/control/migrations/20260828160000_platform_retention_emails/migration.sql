-- 3.12.0: the trial retention programme, and the platform-level email system underneath it.
--
-- EVERY ORGANIZATION COLUMN IS NULLABLE OR DEFAULTED AND NOTHING IS BACKFILLED. `ownerEmail` is
-- null on every existing org (the worker falls back to the tenant's super admins), no notice is
-- recorded as sent, no hold is set, nothing is marked deleted. An existing installation upgrades
-- with no change in behaviour until a platform admin looks at the new console pages.
--
-- THE POLICY ROW IS NOT SEEDED. `PlatformRetentionSettings` is created lazily on first read with
-- the documented defaults — a migration that inserts a row saying "delete after 90 days" is a
-- policy decision hidden in a schema change, and it belongs in the console where it is visible.
--
-- PORTABILITY NOTE: written in canonical casing by hand — `prisma migrate diff` introspected off
-- Windows MariaDB emits lowercase table names (the 2.4.0 lesson, docs/DATABASE.md).

-- AlterTable
ALTER TABLE `Organization` ADD COLUMN `ownerEmail` VARCHAR(255) NULL;
ALTER TABLE `Organization` ADD COLUMN `retentionNoticesSent` JSON NULL;
ALTER TABLE `Organization` ADD COLUMN `retentionHold` BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE `Organization` ADD COLUMN `retentionDeletedAt` DATETIME(3) NULL;

-- CreateTable
CREATE TABLE `PlatformMailSettings` (
    `id` VARCHAR(191) NOT NULL,
    `host` VARCHAR(255) NULL,
    `port` INTEGER NOT NULL DEFAULT 587,
    `secure` BOOLEAN NOT NULL DEFAULT false,
    `user` VARCHAR(255) NULL,
    `encryptedPassword` TEXT NULL,
    `fromAddress` VARCHAR(255) NULL,
    `replyTo` VARCHAR(255) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PlatformEmailTemplate` (
    `key` VARCHAR(80) NOT NULL,
    `subject` VARCHAR(255) NOT NULL,
    `bodyHtml` TEXT NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `updatedAt` DATETIME(3) NOT NULL,
    `updatedById` VARCHAR(191) NULL,

    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PlatformEmailLog` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NULL,
    `templateKey` VARCHAR(80) NOT NULL,
    `to` VARCHAR(255) NOT NULL,
    `subject` VARCHAR(255) NOT NULL,
    `status` ENUM('SENT', 'FAILED', 'SKIPPED') NOT NULL,
    `errorMessage` TEXT NULL,
    `dayMarker` VARCHAR(24) NULL,
    `isTest` BOOLEAN NOT NULL DEFAULT false,
    `payload` JSON NULL,
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `PlatformEmailLog_templateKey_createdAt_idx`(`templateKey`, `createdAt`),
    INDEX `PlatformEmailLog_organizationId_createdAt_idx`(`organizationId`, `createdAt`),
    INDEX `PlatformEmailLog_status_createdAt_idx`(`status`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PlatformRetentionSettings` (
    `id` VARCHAR(191) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `feedbackDay` INTEGER NOT NULL DEFAULT 10,
    `reminderDays` JSON NOT NULL,
    `retentionDays` INTEGER NOT NULL DEFAULT 90,
    `autoDeleteEnabled` BOOLEAN NOT NULL DEFAULT true,
    `snapshotDir` VARCHAR(500) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TrialFeedback` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `stage` VARCHAR(24) NOT NULL,
    `rating` INTEGER NOT NULL,
    `liked` TEXT NULL,
    `missing` TEXT NULL,
    `wouldReturn` VARCHAR(16) NULL,
    `comment` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `TrialFeedback_organizationId_createdAt_idx`(`organizationId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PlatformAuditLog` (
    `id` VARCHAR(191) NOT NULL,
    `actorType` VARCHAR(24) NOT NULL,
    `actorLabel` VARCHAR(255) NULL,
    `action` VARCHAR(80) NOT NULL,
    `entity` VARCHAR(40) NOT NULL,
    `entityId` VARCHAR(64) NULL,
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `PlatformAuditLog_createdAt_idx`(`createdAt`),
    INDEX `PlatformAuditLog_entity_entityId_idx`(`entity`, `entityId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `PlatformEmailLog` ADD CONSTRAINT `PlatformEmailLog_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TrialFeedback` ADD CONSTRAINT `TrialFeedback_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
