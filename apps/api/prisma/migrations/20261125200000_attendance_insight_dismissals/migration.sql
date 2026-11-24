-- 7.0.0: persisted insight dismissals (per user, per insight, per period). Additive only.
CREATE TABLE `AttendanceInsightDismissal` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `insightId` VARCHAR(64) NOT NULL,
    `period` VARCHAR(64) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `AttendanceInsightDismissal_userId_insightId_period_key`(`userId`, `insightId`, `period`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `AttendanceInsightDismissal` ADD CONSTRAINT `AttendanceInsightDismissal_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
