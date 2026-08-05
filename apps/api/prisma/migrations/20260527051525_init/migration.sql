-- AlterTable
ALTER TABLE `Notification` ADD COLUMN `category` VARCHAR(80) NULL,
    ADD COLUMN `link` VARCHAR(500) NULL,
    MODIFY `body` TEXT NOT NULL;

-- AlterTable
ALTER TABLE `Project` ADD COLUMN `slaApprovalHours` INTEGER NOT NULL DEFAULT 48,
    ADD COLUMN `submissionDeadlineDayOfMonth` INTEGER NULL;

-- AlterTable
ALTER TABLE `Timesheet` ADD COLUMN `approvalDeadline` DATETIME(3) NULL,
    ADD COLUMN `escalatedAt` DATETIME(3) NULL,
    ADD COLUMN `slaBreachAt` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `User` ADD COLUMN `avatarUrl` VARCHAR(500) NULL,
    ADD COLUMN `bio` TEXT NULL,
    ADD COLUMN `managerId` VARCHAR(191) NULL,
    ADD COLUMN `phoneNumber` VARCHAR(40) NULL,
    ADD COLUMN `timezone` VARCHAR(80) NULL;

-- CreateTable
CREATE TABLE `Escalation` (
    `id` VARCHAR(191) NOT NULL,
    `timesheetId` VARCHAR(191) NOT NULL,
    `escalatedFromId` VARCHAR(191) NOT NULL,
    `escalatedToId` VARCHAR(191) NOT NULL,
    `reason` VARCHAR(500) NOT NULL,
    `resolvedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Escalation_escalatedToId_resolvedAt_idx`(`escalatedToId`, `resolvedAt`),
    INDEX `Escalation_timesheetId_idx`(`timesheetId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `NotificationPreference` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `emailTimesheetApproved` BOOLEAN NOT NULL DEFAULT true,
    `emailTimesheetRejected` BOOLEAN NOT NULL DEFAULT true,
    `emailTimesheetSubmitted` BOOLEAN NOT NULL DEFAULT true,
    `emailSlaBreach` BOOLEAN NOT NULL DEFAULT true,
    `emailDeadlineReminder` BOOLEAN NOT NULL DEFAULT true,
    `emailEscalation` BOOLEAN NOT NULL DEFAULT true,
    `emailWeeklyDigest` BOOLEAN NOT NULL DEFAULT false,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `NotificationPreference_userId_key`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `EmailLog` (
    `id` VARCHAR(191) NOT NULL,
    `to` VARCHAR(255) NOT NULL,
    `subject` VARCHAR(255) NOT NULL,
    `template` VARCHAR(80) NOT NULL,
    `status` ENUM('QUEUED', 'SENT', 'FAILED') NOT NULL DEFAULT 'QUEUED',
    `errorMessage` TEXT NULL,
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `EmailLog_to_createdAt_idx`(`to`, `createdAt`),
    INDEX `EmailLog_status_createdAt_idx`(`status`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `Notification_userId_createdAt_idx` ON `Notification`(`userId`, `createdAt`);

-- CreateIndex
CREATE INDEX `Timesheet_status_approvalDeadline_idx` ON `Timesheet`(`status`, `approvalDeadline`);

-- CreateIndex
CREATE INDEX `User_managerId_idx` ON `User`(`managerId`);

-- AddForeignKey
ALTER TABLE `User` ADD CONSTRAINT `User_managerId_fkey` FOREIGN KEY (`managerId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Escalation` ADD CONSTRAINT `Escalation_timesheetId_fkey` FOREIGN KEY (`timesheetId`) REFERENCES `Timesheet`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Escalation` ADD CONSTRAINT `Escalation_escalatedFromId_fkey` FOREIGN KEY (`escalatedFromId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Escalation` ADD CONSTRAINT `Escalation_escalatedToId_fkey` FOREIGN KEY (`escalatedToId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `NotificationPreference` ADD CONSTRAINT `NotificationPreference_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
