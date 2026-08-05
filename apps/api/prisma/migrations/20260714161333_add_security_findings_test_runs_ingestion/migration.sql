-- AlterTable
ALTER TABLE `GlobalNotificationSettings` ADD COLUMN `emailTicketClosedDigest` BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE `SecurityFinding` (
    `id` VARCHAR(191) NOT NULL,
    `ticketId` VARCHAR(191) NULL,
    `type` ENUM('SAST', 'DAST', 'SSAT', 'SSCT') NOT NULL,
    `tool` VARCHAR(80) NOT NULL,
    `severity` ENUM('LOW', 'MEDIUM', 'HIGH', 'CRITICAL') NOT NULL,
    `status` ENUM('OPEN', 'ACKNOWLEDGED', 'FIXED', 'ACCEPTED_RISK') NOT NULL DEFAULT 'OPEN',
    `title` VARCHAR(255) NOT NULL,
    `description` TEXT NULL,
    `cwe` VARCHAR(40) NULL,
    `filePath` VARCHAR(500) NULL,
    `lineNumber` INTEGER NULL,
    `repository` VARCHAR(255) NULL,
    `branch` VARCHAR(255) NULL,
    `prUrl` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `SecurityFinding_ticketId_idx`(`ticketId`),
    INDEX `SecurityFinding_type_severity_status_idx`(`type`, `severity`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TestRun` (
    `id` VARCHAR(191) NOT NULL,
    `ticketId` VARCHAR(191) NULL,
    `provider` VARCHAR(80) NOT NULL,
    `branch` VARCHAR(255) NULL,
    `prUrl` VARCHAR(500) NULL,
    `status` ENUM('PASSED', 'FAILED', 'RUNNING') NOT NULL,
    `passCount` INTEGER NULL,
    `failCount` INTEGER NULL,
    `durationMs` INTEGER NULL,
    `logUrl` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `TestRun_ticketId_createdAt_idx`(`ticketId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `IngestionSettings` (
    `id` VARCHAR(191) NOT NULL,
    `encryptedToken` VARCHAR(191) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `SecurityFinding` ADD CONSTRAINT `SecurityFinding_ticketId_fkey` FOREIGN KEY (`ticketId`) REFERENCES `Ticket`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TestRun` ADD CONSTRAINT `TestRun_ticketId_fkey` FOREIGN KEY (`ticketId`) REFERENCES `Ticket`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
