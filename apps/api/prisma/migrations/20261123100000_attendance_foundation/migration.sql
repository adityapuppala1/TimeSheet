-- V17 A1: attendance, holiday calendars and missed-day reasons (tenant).
--
-- Every switch defaults OFF (GlobalAttendanceSettings is upserted on first read), so an upgraded
-- workspace behaves exactly as before until an admin opts in. `User` written in canonical casing by
-- hand: migrate diff introspected off Windows MariaDB emits `user` (the 2.4.0 lesson, docs/DATABASE.md).
-- AlterTable
ALTER TABLE `User` ADD COLUMN `employeeCode` VARCHAR(64) NULL,
    ADD COLUMN `holidayCalendarId` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `GlobalAttendanceSettings` (
    `id` VARCHAR(191) NOT NULL,
    `attendanceEnabled` BOOLEAN NOT NULL DEFAULT false,
    `punchInMode` ENUM('OFF', 'OPTIONAL', 'MANDATORY') NOT NULL DEFAULT 'OFF',
    `locationMode` ENUM('OFF', 'OPTIONAL', 'REQUIRED') NOT NULL DEFAULT 'OFF',
    `punchInFaceRequired` BOOLEAN NOT NULL DEFAULT false,
    `faceFailureRule` ENUM('BLOCK', 'ALLOW_FLAGGED') NOT NULL DEFAULT 'BLOCK',
    `punchInReminderHour` INTEGER NOT NULL DEFAULT 11,
    `punchInReminderEnabled` BOOLEAN NOT NULL DEFAULT false,
    `missedDayReasonEnabled` BOOLEAN NOT NULL DEFAULT false,
    `aiInsightsSelf` BOOLEAN NOT NULL DEFAULT false,
    `aiInsightsManager` BOOLEAN NOT NULL DEFAULT false,
    `aiInsightsOrg` BOOLEAN NOT NULL DEFAULT false,
    `minGroupSize` INTEGER NOT NULL DEFAULT 5,
    `locationConsentText` TEXT NULL,
    `locationRetentionDays` INTEGER NOT NULL DEFAULT 90,
    `updatedById` VARCHAR(191) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `HolidayCalendar` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `description` VARCHAR(500) NULL,
    `isDefault` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `HolidayCalendar_name_key`(`name`),
    INDEX `HolidayCalendar_isDefault_idx`(`isDefault`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Holiday` (
    `id` VARCHAR(191) NOT NULL,
    `calendarId` VARCHAR(191) NOT NULL,
    `date` DATE NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `isOptional` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Holiday_date_idx`(`date`),
    UNIQUE INDEX `Holiday_calendarId_date_key`(`calendarId`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AttendanceSource` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `kind` ENUM('WEB', 'API', 'WEBHOOK', 'MCP', 'CSV') NOT NULL,
    `secretHash` VARCHAR(255) NULL,
    `matchField` ENUM('EMAIL', 'EMPLOYEE_CODE', 'EXTERNAL_ID') NOT NULL DEFAULT 'EMAIL',
    `priority` INTEGER NOT NULL DEFAULT 0,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `lastEventAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `AttendanceSource_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AttendanceRecord` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `workDate` DATE NOT NULL,
    `punchInAt` DATETIME(3) NOT NULL,
    `punchOutAt` DATETIME(3) NULL,
    `lat` DECIMAL(9, 6) NULL,
    `lng` DECIMAL(9, 6) NULL,
    `accuracyM` INTEGER NULL,
    `ip` VARCHAR(64) NULL,
    `userAgent` TEXT NULL,
    `faceAttemptId` VARCHAR(64) NULL,
    `flagged` BOOLEAN NOT NULL DEFAULT false,
    `source` ENUM('WEB', 'API', 'WEBHOOK', 'MCP', 'CSV') NOT NULL,
    `sourceId` VARCHAR(191) NULL,
    `externalRef` VARCHAR(191) NULL,
    `rawPayload` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `AttendanceRecord_workDate_idx`(`workDate`),
    INDEX `AttendanceRecord_sourceId_idx`(`sourceId`),
    UNIQUE INDEX `AttendanceRecord_userId_workDate_key`(`userId`, `workDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MissedReasonOption` (
    `id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(40) NOT NULL,
    `label` VARCHAR(120) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `order` INTEGER NOT NULL DEFAULT 0,
    `requiresNote` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `MissedReasonOption_code_key`(`code`),
    INDEX `MissedReasonOption_enabled_order_idx`(`enabled`, `order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MissedDayReason` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `workDate` DATE NOT NULL,
    `reasonCode` VARCHAR(40) NOT NULL,
    `note` TEXT NULL,
    `timesheetId` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `MissedDayReason_workDate_idx`(`workDate`),
    UNIQUE INDEX `MissedDayReason_userId_workDate_key`(`userId`, `workDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `User_employeeCode_key` ON `User`(`employeeCode`);

-- CreateIndex
CREATE INDEX `User_holidayCalendarId_idx` ON `User`(`holidayCalendarId`);

-- AddForeignKey
ALTER TABLE `User` ADD CONSTRAINT `User_holidayCalendarId_fkey` FOREIGN KEY (`holidayCalendarId`) REFERENCES `HolidayCalendar`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Holiday` ADD CONSTRAINT `Holiday_calendarId_fkey` FOREIGN KEY (`calendarId`) REFERENCES `HolidayCalendar`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AttendanceRecord` ADD CONSTRAINT `AttendanceRecord_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AttendanceRecord` ADD CONSTRAINT `AttendanceRecord_sourceId_fkey` FOREIGN KEY (`sourceId`) REFERENCES `AttendanceSource`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `MissedDayReason` ADD CONSTRAINT `MissedDayReason_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;


-- ===================================================================================
-- The nine default missed-day reasons, inserted HERE rather than in a seed so a fresh install and
-- an upgraded one start with the same list (seeds are a bootstrap step update.sh does not re-run).
-- INSERT IGNORE on the unique `code` makes a re-run of an interrupted deploy a no-op, and never
-- overwrites a label an admin has since edited.
-- ===================================================================================
INSERT IGNORE INTO `MissedReasonOption` (`id`, `code`, `label`, `enabled`, `order`, `requiresNote`, `createdAt`, `updatedAt`) VALUES
  (UUID(), 'ON_LEAVE',         'On leave',                         TRUE, 10, FALSE, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
  (UUID(), 'SICK',             'Sick',                             TRUE, 20, FALSE, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
  (UUID(), 'HOLIDAY',          'Holiday',                          TRUE, 30, FALSE, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
  (UUID(), 'FORGOT',           'Forgot to log',                    TRUE, 40, FALSE, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
  (UUID(), 'TRAVEL',           'Travelling',                       TRUE, 50, FALSE, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
  (UUID(), 'TRAINING',         'Training',                         TRUE, 60, FALSE, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
  (UUID(), 'SYSTEM_ISSUE',     'System issue',                     TRUE, 70, FALSE, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
  (UUID(), 'LOGGED_ELSEWHERE', 'Logged in another system',         TRUE, 80, FALSE, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
  (UUID(), 'OTHER',            'Other',                            TRUE, 90, TRUE,  CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));
