-- AlterTable
ALTER TABLE `GlobalAISettings` ADD COLUMN `findingTriageEnabled` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `SecurityFinding` ADD COLUMN `aiExploitability` TEXT NULL,
    ADD COLUMN `aiFixSuggestion` TEXT NULL,
    ADD COLUMN `aiTriagedAt` DATETIME(3) NULL,
    ADD COLUMN `aiVerdict` ENUM('TRUE_POSITIVE', 'FALSE_POSITIVE', 'NEEDS_REVIEW') NULL;

-- CreateTable
CREATE TABLE `SbomComponent` (
    `id` VARCHAR(191) NOT NULL,
    `repository` VARCHAR(255) NULL,
    `name` VARCHAR(255) NOT NULL,
    `version` VARCHAR(80) NOT NULL,
    `ecosystem` VARCHAR(80) NULL,
    `license` VARCHAR(120) NULL,
    `knownCve` VARCHAR(40) NULL,
    `format` VARCHAR(20) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `SbomComponent_repository_idx`(`repository`),
    INDEX `SbomComponent_name_idx`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
