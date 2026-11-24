-- 7.0.0: regularisation (punch correction) requests. Additive only and OFF by default: the toggle
-- defaults false, so a workspace that never turns it on sees no change (Phase A said "no
-- corrections"; this is opt-in). The source enum gains REGULARIZATION on every column that uses it.
ALTER TABLE `GlobalAttendanceSettings`
    ADD COLUMN `regularizationEnabled` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `regularizationMaxDaysBack` INTEGER NOT NULL DEFAULT 7,
    ADD COLUMN `regularizationMonthlyCap` INTEGER NOT NULL DEFAULT 3;

ALTER TABLE `AttendanceSource` MODIFY `kind` ENUM('WEB', 'API', 'WEBHOOK', 'MCP', 'CSV', 'REGULARIZATION') NOT NULL;
ALTER TABLE `AttendanceEvent` MODIFY `source` ENUM('WEB', 'API', 'WEBHOOK', 'MCP', 'CSV', 'REGULARIZATION') NOT NULL;
ALTER TABLE `AttendanceRecord` MODIFY `source` ENUM('WEB', 'API', 'WEBHOOK', 'MCP', 'CSV', 'REGULARIZATION') NOT NULL;
ALTER TABLE `LeaveRequest` MODIFY `source` ENUM('WEB', 'API', 'WEBHOOK', 'MCP', 'CSV', 'REGULARIZATION') NOT NULL DEFAULT 'WEB';

CREATE TABLE `AttendanceRegularizationRequest` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `workDate` DATE NOT NULL,
    `punchInAt` DATETIME(3) NOT NULL,
    `punchOutAt` DATETIME(3) NULL,
    `originalPunchInAt` DATETIME(3) NULL,
    `originalPunchOutAt` DATETIME(3) NULL,
    `reason` TEXT NOT NULL,
    `status` ENUM('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `approverId` VARCHAR(64) NULL,
    `decidedById` VARCHAR(64) NULL,
    `onBehalfOfId` VARCHAR(64) NULL,
    `decidedAt` DATETIME(3) NULL,
    `decisionNote` TEXT NULL,
    `overriddenBySuperAdmin` BOOLEAN NOT NULL DEFAULT false,
    `eventId` VARCHAR(64) NULL,
    `cancelledAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `AttendanceRegularizationRequest_userId_workDate_idx`(`userId`, `workDate`),
    INDEX `AttendanceRegularizationRequest_approverId_status_idx`(`approverId`, `status`),
    INDEX `AttendanceRegularizationRequest_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `AttendanceRegularizationRequest` ADD CONSTRAINT `AttendanceRegularizationRequest_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
