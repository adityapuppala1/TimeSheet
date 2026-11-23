-- V17 A6: attendance analytics settings and the AI suggestion cache.
--
-- Lateness ships OFF (latenessEnabled = false): without an agreed start time, analytics compare
-- each person with their own median punch-in rather than calling anyone late.
ALTER TABLE `GlobalAttendanceSettings`
  ADD COLUMN `aiInsightsFrequency` ENUM('DAILY', 'WEEKLY') NOT NULL DEFAULT 'WEEKLY',
  ADD COLUMN `latenessEnabled` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `expectedStartMinute` INTEGER NOT NULL DEFAULT 600;

CREATE TABLE `AttendanceInsightCache` (
    `id` VARCHAR(191) NOT NULL,
    `cacheKey` VARCHAR(191) NOT NULL,
    `insights` JSON NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `AttendanceInsightCache_cacheKey_key`(`cacheKey`),
    INDEX `AttendanceInsightCache_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
