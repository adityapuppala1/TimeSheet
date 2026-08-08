-- AlterTable
ALTER TABLE `GlobalAISettings` ADD COLUMN `aiEvalJudgeEnabled` BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE `AIEvalRun` (
    `id` VARCHAR(191) NOT NULL,
    `datasetId` VARCHAR(191) NOT NULL,
    `promptVersionId` VARCHAR(64) NULL,
    `model` VARCHAR(80) NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'QUEUED',
    `itemCount` INTEGER NOT NULL DEFAULT 0,
    `scoredCount` INTEGER NOT NULL DEFAULT 0,
    `passCount` INTEGER NOT NULL DEFAULT 0,
    `avgScore` DOUBLE NULL,
    `estimatedCostUsd` DOUBLE NULL,
    `actualCostUsd` DOUBLE NULL,
    `error` VARCHAR(500) NULL,
    `startedAt` DATETIME(3) NULL,
    `finishedAt` DATETIME(3) NULL,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AIEvalRun_datasetId_idx`(`datasetId`),
    INDEX `AIEvalRun_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AIEvalResult` (
    `id` VARCHAR(191) NOT NULL,
    `runId` VARCHAR(191) NOT NULL,
    `itemId` VARCHAR(64) NOT NULL,
    `output` TEXT NULL,
    `score` DOUBLE NOT NULL,
    `passed` BOOLEAN NOT NULL,
    `detail` TEXT NULL,
    `error` VARCHAR(300) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AIEvalResult_runId_idx`(`runId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AIEvalRun` ADD CONSTRAINT `AIEvalRun_datasetId_fkey` FOREIGN KEY (`datasetId`) REFERENCES `AIDataset`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AIEvalRun` ADD CONSTRAINT `AIEvalRun_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AIEvalResult` ADD CONSTRAINT `AIEvalResult_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `AIEvalRun`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
