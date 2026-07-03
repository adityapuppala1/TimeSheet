-- CreateTable
CREATE TABLE `EmailTemplate` (
    `id` VARCHAR(191) NOT NULL,
    `key` VARCHAR(80) NOT NULL,
    `subject` VARCHAR(255) NOT NULL,
    `bodyHtml` TEXT NOT NULL,
    `description` VARCHAR(500) NULL,
    `variables` JSON NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `updatedAt` DATETIME(3) NOT NULL,
    `updatedById` VARCHAR(191) NULL,

    UNIQUE INDEX `EmailTemplate_key_key`(`key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GlobalNotificationSettings` (
    `id` VARCHAR(191) NOT NULL,
    `emailTimesheetSubmitted` BOOLEAN NOT NULL DEFAULT true,
    `emailTimesheetApproved` BOOLEAN NOT NULL DEFAULT true,
    `emailTimesheetRejected` BOOLEAN NOT NULL DEFAULT true,
    `emailSlaBreach` BOOLEAN NOT NULL DEFAULT true,
    `emailDeadlineReminder` BOOLEAN NOT NULL DEFAULT true,
    `emailEscalation` BOOLEAN NOT NULL DEFAULT true,
    `emailWeeklyDigest` BOOLEAN NOT NULL DEFAULT false,
    `updatedAt` DATETIME(3) NOT NULL,
    `updatedById` VARCHAR(191) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `EmailLog_template_createdAt_idx` ON `EmailLog`(`template`, `createdAt`);
