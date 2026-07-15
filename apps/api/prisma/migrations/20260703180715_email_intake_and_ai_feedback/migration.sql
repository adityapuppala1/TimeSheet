-- AlterTable
ALTER TABLE `GlobalNotificationSettings` ADD COLUMN `emailTicketNeedsReview` BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE `Ticket` ADD COLUMN `aiFeedback` VARCHAR(10) NULL;

-- CreateTable
CREATE TABLE `EmailIntakeSettings` (
    `id` VARCHAR(191) NOT NULL,
    `imapHost` VARCHAR(255) NULL,
    `imapPort` INTEGER NOT NULL DEFAULT 993,
    `imapSecure` BOOLEAN NOT NULL DEFAULT true,
    `imapUser` VARCHAR(255) NULL,
    `imapPassword` VARCHAR(500) NULL,
    `pollIntervalMinutes` INTEGER NOT NULL DEFAULT 5,
    `fallbackProjectId` VARCHAR(191) NULL,
    `lastPolledAt` DATETIME(3) NULL,
    `lastPollError` TEXT NULL,
    `updatedAt` DATETIME(3) NOT NULL,
    `updatedById` VARCHAR(191) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `EmailRoutingRule` (
    `id` VARCHAR(191) NOT NULL,
    `matchType` ENUM('TO_ADDRESS', 'TO_PLUS_TAG', 'SUBJECT_PREFIX') NOT NULL,
    `matchValue` VARCHAR(255) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `defaultModuleId` VARCHAR(191) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `EmailRoutingRule_isActive_idx`(`isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ModuleAssigneeRule` (
    `id` VARCHAR(191) NOT NULL,
    `moduleId` VARCHAR(191) NOT NULL,
    `defaultAssigneeId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ModuleAssigneeRule_moduleId_key`(`moduleId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `EmailIntakeSettings` ADD CONSTRAINT `EmailIntakeSettings_fallbackProjectId_fkey` FOREIGN KEY (`fallbackProjectId`) REFERENCES `Project`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `EmailRoutingRule` ADD CONSTRAINT `EmailRoutingRule_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `EmailRoutingRule` ADD CONSTRAINT `EmailRoutingRule_defaultModuleId_fkey` FOREIGN KEY (`defaultModuleId`) REFERENCES `ProjectModule`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ModuleAssigneeRule` ADD CONSTRAINT `ModuleAssigneeRule_moduleId_fkey` FOREIGN KEY (`moduleId`) REFERENCES `ProjectModule`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ModuleAssigneeRule` ADD CONSTRAINT `ModuleAssigneeRule_defaultAssigneeId_fkey` FOREIGN KEY (`defaultAssigneeId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
