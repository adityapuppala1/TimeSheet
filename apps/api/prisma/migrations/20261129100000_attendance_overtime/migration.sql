-- 7.0.0: overtime. Additive only and OFF by default: overtimeEnabled defaults false, so a workspace
-- that never turns it on computes nothing and its payroll export keeps exactly its old columns.
ALTER TABLE `GlobalAttendanceSettings`
    ADD COLUMN `overtimeEnabled` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `overtimeDailyThresholdHours` DECIMAL(4, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `overtimeWeeklyThresholdHours` DECIMAL(5, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `overtimeRequireApproval` BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE `OvertimeClaim` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `weekStart` DATE NOT NULL,
    `hours` DECIMAL(6, 2) NOT NULL,
    `workedHours` DECIMAL(6, 2) NOT NULL,
    `expectedHours` DECIMAL(6, 2) NOT NULL,
    `status` ENUM('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `approverId` VARCHAR(64) NULL,
    `decidedById` VARCHAR(64) NULL,
    `onBehalfOfId` VARCHAR(64) NULL,
    `decidedAt` DATETIME(3) NULL,
    `decisionNote` TEXT NULL,
    `overriddenBySuperAdmin` BOOLEAN NOT NULL DEFAULT false,
    `cancelledAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `OvertimeClaim_userId_weekStart_idx`(`userId`, `weekStart`),
    INDEX `OvertimeClaim_approverId_status_idx`(`approverId`, `status`),
    INDEX `OvertimeClaim_status_weekStart_idx`(`status`, `weekStart`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `OvertimeClaim` ADD CONSTRAINT `OvertimeClaim_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
