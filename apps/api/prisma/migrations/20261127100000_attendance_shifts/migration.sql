-- 7.0.0: shifts/rosters. Additive only: with no shift assigned everyone keeps the workspace day.
CREATE TABLE `AttendanceShift` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `startMinute` INTEGER NOT NULL,
    `endMinute` INTEGER NOT NULL,
    `breakMinutes` INTEGER NOT NULL DEFAULT 0,
    `workingDays` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `AttendanceShift_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AttendanceShiftAssignment` (
    `id` VARCHAR(191) NOT NULL,
    `shiftId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NULL,
    `managerId` VARCHAR(191) NULL,
    `effectiveFrom` DATE NOT NULL,
    `effectiveTo` DATE NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AttendanceShiftAssignment_userId_effectiveFrom_idx`(`userId`, `effectiveFrom`),
    INDEX `AttendanceShiftAssignment_managerId_effectiveFrom_idx`(`managerId`, `effectiveFrom`),
    INDEX `AttendanceShiftAssignment_shiftId_idx`(`shiftId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `AttendanceShiftAssignment` ADD CONSTRAINT `AttendanceShiftAssignment_shiftId_fkey` FOREIGN KEY (`shiftId`) REFERENCES `AttendanceShift`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `AttendanceShiftAssignment` ADD CONSTRAINT `AttendanceShiftAssignment_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `AttendanceShiftAssignment` ADD CONSTRAINT `AttendanceShiftAssignment_managerId_fkey` FOREIGN KEY (`managerId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
