-- AlterTable
ALTER TABLE `User` ADD COLUMN `scimExternalId` VARCHAR(255) NULL;

-- CreateTable
CREATE TABLE `ScimSettings` (
    `id` VARCHAR(191) NOT NULL,
    `encryptedToken` VARCHAR(191) NULL,
    `isEnabled` BOOLEAN NOT NULL DEFAULT false,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `User_scimExternalId_key` ON `User`(`scimExternalId`);
