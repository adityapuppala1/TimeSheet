-- 7.0.0: comp-off. Additive only, everything OFF: the settings toggle defaults false, and the "CO"
-- leave type it credits is inserted DISABLED (same reasoning as the PL/CL/SL presets in
-- 20261124100000_leave_management: fresh and upgraded installs must agree). INSERT IGNORE on the
-- unique code leaves an admin's own "CO" alone.
ALTER TABLE `GlobalAttendanceSettings`
    ADD COLUMN `compOffEnabled` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `compOffHalfDayHours` DECIMAL(4, 2) NOT NULL DEFAULT 4,
    ADD COLUMN `compOffFullDayHours` DECIMAL(4, 2) NOT NULL DEFAULT 8,
    ADD COLUMN `compOffLeaveTypeCode` VARCHAR(20) NOT NULL DEFAULT 'CO',
    ADD COLUMN `compOffExpiryDays` INTEGER NULL;

CREATE TABLE `CompOffRequest` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `workDate` DATE NOT NULL,
    `dayKind` VARCHAR(16) NOT NULL,
    `hoursLogged` DECIMAL(5, 2) NOT NULL,
    `days` DECIMAL(4, 2) NOT NULL,
    `reason` TEXT NULL,
    `status` ENUM('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `approverId` VARCHAR(64) NULL,
    `decidedById` VARCHAR(64) NULL,
    `onBehalfOfId` VARCHAR(64) NULL,
    `decidedAt` DATETIME(3) NULL,
    `decisionNote` TEXT NULL,
    `overriddenBySuperAdmin` BOOLEAN NOT NULL DEFAULT false,
    `leaveTypeId` VARCHAR(64) NULL,
    `leaveYear` INTEGER NULL,
    `expiresOn` DATE NULL,
    `expiredAt` DATETIME(3) NULL,
    `cancelledAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `CompOffRequest_userId_workDate_idx`(`userId`, `workDate`),
    INDEX `CompOffRequest_approverId_status_idx`(`approverId`, `status`),
    INDEX `CompOffRequest_status_expiresOn_idx`(`status`, `expiresOn`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `CompOffRequest` ADD CONSTRAINT `CompOffRequest_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

INSERT IGNORE INTO `LeaveType` (`id`, `code`, `name`, `colour`, `annualQuota`, `accrual`, `carryForwardMax`, `allowHalfDay`, `isPaid`, `requiresApproval`, `requiresDocumentAfterDays`, `allowNegative`, `enabled`, `sortOrder`, `updatedAt`)
VALUES (UUID(), 'CO', 'Compensatory off', 'success', 0.00, 'YEARLY_UPFRONT', 0.00, true, true, true, NULL, false, false, 40, NOW(3));
