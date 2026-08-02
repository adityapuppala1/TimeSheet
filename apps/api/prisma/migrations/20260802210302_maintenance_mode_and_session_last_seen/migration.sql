-- AlterTable
ALTER TABLE `session` ADD COLUMN `lastSeenAt` DATETIME(3) NULL;

-- CreateTable
CREATE TABLE `MaintenanceSettings` (
    `id` VARCHAR(191) NOT NULL DEFAULT 'global',
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `scheduledStartAt` DATETIME(3) NULL,
    `scheduledEndAt` DATETIME(3) NULL,
    `message` VARCHAR(500) NULL,
    `updatedById` VARCHAR(191) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `Session_lastSeenAt_idx` ON `Session`(`lastSeenAt`);
