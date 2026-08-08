-- AlterTable
ALTER TABLE `GlobalAISettings` ADD COLUMN `aiCaptureContentEnabled` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `aiCaptureEnabled` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `aiCaptureRetentionDays` INTEGER NOT NULL DEFAULT 30;

-- CreateTable
CREATE TABLE `AIInteraction` (
    `id` VARCHAR(191) NOT NULL,
    `feature` VARCHAR(60) NOT NULL,
    `model` VARCHAR(80) NOT NULL,
    `provider` VARCHAR(30) NOT NULL,
    `promptHash` VARCHAR(64) NOT NULL,
    `parseOk` BOOLEAN NULL,
    `latencyMs` INTEGER NULL,
    `promptVersionId` VARCHAR(64) NULL,
    `promptFallbackReason` VARCHAR(200) NULL,
    `promptText` TEXT NULL,
    `outputText` TEXT NULL,
    `paramsJson` JSON NULL,
    `promptTruncated` BOOLEAN NOT NULL DEFAULT false,
    `outputTruncated` BOOLEAN NOT NULL DEFAULT false,
    `feedback` VARCHAR(10) NULL,
    `feedbackById` VARCHAR(191) NULL,
    `feedbackAt` DATETIME(3) NULL,
    `feedbackNote` VARCHAR(500) NULL,
    `ticketId` VARCHAR(191) NULL,
    `userId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AIInteraction_feature_createdAt_idx`(`feature`, `createdAt`),
    INDEX `AIInteraction_createdAt_idx`(`createdAt`),
    INDEX `AIInteraction_feedback_idx`(`feedback`),
    INDEX `AIInteraction_ticketId_idx`(`ticketId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AIInteraction` ADD CONSTRAINT `AIInteraction_feedbackById_fkey` FOREIGN KEY (`feedbackById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AIInteraction` ADD CONSTRAINT `AIInteraction_ticketId_fkey` FOREIGN KEY (`ticketId`) REFERENCES `Ticket`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AIInteraction` ADD CONSTRAINT `AIInteraction_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
