-- AlterTable
ALTER TABLE `globalaisettings` ADD COLUMN `chatIngestionEnabled` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `ticket` ADD COLUMN `externalChatChannelId` VARCHAR(255) NULL,
    ADD COLUMN `externalChatPlatform` ENUM('SLACK', 'MICROSOFT_TEAMS', 'GOOGLE_CHAT', 'TELEGRAM') NULL,
    ADD COLUMN `externalChatUserId` VARCHAR(255) NULL,
    ADD COLUMN `externalChatUserName` VARCHAR(160) NULL,
    MODIFY `source` ENUM('MANUAL', 'EMAIL', 'API', 'CHAT') NOT NULL DEFAULT 'MANUAL';

-- CreateTable
CREATE TABLE `ChatIntegration` (
    `id` VARCHAR(191) NOT NULL,
    `platform` ENUM('SLACK', 'MICROSOFT_TEAMS', 'GOOGLE_CHAT', 'TELEGRAM') NOT NULL,
    `isEnabled` BOOLEAN NOT NULL DEFAULT false,
    `encryptedBotToken` TEXT NULL,
    `encryptedSigningSecret` TEXT NULL,
    `teamsAppId` VARCHAR(255) NULL,
    `encryptedTeamsAppPassword` TEXT NULL,
    `googleChatWebhookUrl` VARCHAR(500) NULL,
    `defaultProjectId` VARCHAR(191) NULL,
    `webhookOrgToken` VARCHAR(64) NULL,
    `telegramUpdateOffset` INTEGER NULL,
    `lastEventAt` DATETIME(3) NULL,
    `lastError` TEXT NULL,
    `updatedAt` DATETIME(3) NOT NULL,
    `updatedById` VARCHAR(191) NULL,

    UNIQUE INDEX `ChatIntegration_platform_key`(`platform`),
    UNIQUE INDEX `ChatIntegration_webhookOrgToken_key`(`webhookOrgToken`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ChatRoutingRule` (
    `id` VARCHAR(191) NOT NULL,
    `platform` ENUM('SLACK', 'MICROSOFT_TEAMS', 'GOOGLE_CHAT', 'TELEGRAM') NOT NULL,
    `matchType` ENUM('CHANNEL_ID', 'COMMAND_PREFIX') NOT NULL,
    `matchValue` VARCHAR(255) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `defaultModuleId` VARCHAR(191) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ChatRoutingRule_platform_isActive_idx`(`platform`, `isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ChatIntegration` ADD CONSTRAINT `ChatIntegration_defaultProjectId_fkey` FOREIGN KEY (`defaultProjectId`) REFERENCES `Project`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ChatRoutingRule` ADD CONSTRAINT `ChatRoutingRule_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ChatRoutingRule` ADD CONSTRAINT `ChatRoutingRule_defaultModuleId_fkey` FOREIGN KEY (`defaultModuleId`) REFERENCES `ProjectModule`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
