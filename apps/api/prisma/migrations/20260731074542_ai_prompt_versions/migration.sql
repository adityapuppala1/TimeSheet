-- CreateTable
CREATE TABLE `AIPromptTemplate` (
    `id` VARCHAR(191) NOT NULL,
    `feature` VARCHAR(60) NOT NULL,
    `activeVersionId` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `AIPromptTemplate_feature_key`(`feature`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AIPromptVersion` (
    `id` VARCHAR(191) NOT NULL,
    `templateId` VARCHAR(191) NOT NULL,
    `version` INTEGER NOT NULL,
    `body` TEXT NOT NULL,
    `note` VARCHAR(300) NULL,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AIPromptVersion_templateId_idx`(`templateId`),
    UNIQUE INDEX `AIPromptVersion_templateId_version_key`(`templateId`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AIPromptVersion` ADD CONSTRAINT `AIPromptVersion_templateId_fkey` FOREIGN KEY (`templateId`) REFERENCES `AIPromptTemplate`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AIPromptVersion` ADD CONSTRAINT `AIPromptVersion_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
