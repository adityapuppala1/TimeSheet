-- CreateTable
CREATE TABLE `AIDataset` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `description` VARCHAR(500) NULL,
    `feature` VARCHAR(60) NOT NULL,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `AIDataset_feature_idx`(`feature`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AIDatasetItem` (
    `id` VARCHAR(191) NOT NULL,
    `datasetId` VARCHAR(191) NOT NULL,
    `sourceInteractionId` VARCHAR(64) NULL,
    `inputParamsJson` JSON NOT NULL,
    `actualOutput` TEXT NULL,
    `expectedOutput` TEXT NOT NULL,
    `expectedKind` VARCHAR(20) NOT NULL DEFAULT 'EXACT_FIELDS',
    `notes` VARCHAR(500) NULL,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AIDatasetItem_datasetId_idx`(`datasetId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AIDataset` ADD CONSTRAINT `AIDataset_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AIDatasetItem` ADD CONSTRAINT `AIDatasetItem_datasetId_fkey` FOREIGN KEY (`datasetId`) REFERENCES `AIDataset`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AIDatasetItem` ADD CONSTRAINT `AIDatasetItem_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
