/*
  Warnings:

  - You are about to alter the column `type` on the `ticket` table. The data in that column could be lost. The data in that column will be cast from `Enum(EnumId(2))` to `VarChar(60)`.

*/
-- AlterTable
ALTER TABLE `ticket` ADD COLUMN `aiConfidence` DOUBLE NULL,
    ADD COLUMN `estimatedHours` DECIMAL(5, 2) NULL,
    ADD COLUMN `externalReporterEmail` VARCHAR(255) NULL,
    ADD COLUMN `externalReporterName` VARCHAR(160) NULL,
    ADD COLUMN `needsReview` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `source` ENUM('MANUAL', 'EMAIL', 'API') NOT NULL DEFAULT 'MANUAL',
    MODIFY `type` VARCHAR(60) NOT NULL DEFAULT 'BUG';

-- AlterTable
ALTER TABLE `user` ADD COLUMN `hourlyRate` DECIMAL(10, 2) NULL;

-- CreateTable
CREATE TABLE `TicketType` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(60) NOT NULL,
    `color` VARCHAR(20) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `TicketType_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Label` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(60) NOT NULL,
    `color` VARCHAR(20) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Label_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TicketLabel` (
    `id` VARCHAR(191) NOT NULL,
    `ticketId` VARCHAR(191) NOT NULL,
    `labelId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `TicketLabel_ticketId_labelId_key`(`ticketId`, `labelId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GlobalTicketSettings` (
    `id` VARCHAR(191) NOT NULL,
    `slaLowHours` INTEGER NOT NULL DEFAULT 168,
    `slaMediumHours` INTEGER NOT NULL DEFAULT 72,
    `slaHighHours` INTEGER NOT NULL DEFAULT 24,
    `slaCriticalHours` INTEGER NOT NULL DEFAULT 4,
    `enableCostAnalytics` BOOLEAN NOT NULL DEFAULT false,
    `enableLeaderboard` BOOLEAN NOT NULL DEFAULT false,
    `updatedAt` DATETIME(3) NOT NULL,
    `updatedById` VARCHAR(191) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GlobalAISettings` (
    `id` VARCHAR(191) NOT NULL,
    `aiEnabled` BOOLEAN NOT NULL DEFAULT false,
    `autoTriageEnabled` BOOLEAN NOT NULL DEFAULT false,
    `autoTriageAutoApply` BOOLEAN NOT NULL DEFAULT false,
    `duplicateDetectionEnabled` BOOLEAN NOT NULL DEFAULT false,
    `writingAssistantEnabled` BOOLEAN NOT NULL DEFAULT false,
    `emailIngestionEnabled` BOOLEAN NOT NULL DEFAULT false,
    `weeklyDigestEnabled` BOOLEAN NOT NULL DEFAULT false,
    `model` VARCHAR(80) NOT NULL DEFAULT 'claude-haiku-4-5',
    `confidenceThreshold` DOUBLE NOT NULL DEFAULT 0.6,
    `monthlyBudgetUsd` DECIMAL(10, 2) NULL,
    `updatedAt` DATETIME(3) NOT NULL,
    `updatedById` VARCHAR(191) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AIUsageLog` (
    `id` VARCHAR(191) NOT NULL,
    `feature` VARCHAR(60) NOT NULL,
    `model` VARCHAR(80) NOT NULL,
    `inputTokens` INTEGER NOT NULL,
    `outputTokens` INTEGER NOT NULL,
    `costUsdEstimate` DECIMAL(10, 4) NOT NULL,
    `ticketId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AIUsageLog_feature_createdAt_idx`(`feature`, `createdAt`),
    INDEX `AIUsageLog_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `TicketLabel` ADD CONSTRAINT `TicketLabel_ticketId_fkey` FOREIGN KEY (`ticketId`) REFERENCES `Ticket`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TicketLabel` ADD CONSTRAINT `TicketLabel_labelId_fkey` FOREIGN KEY (`labelId`) REFERENCES `Label`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AIUsageLog` ADD CONSTRAINT `AIUsageLog_ticketId_fkey` FOREIGN KEY (`ticketId`) REFERENCES `Ticket`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
