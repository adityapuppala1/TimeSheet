-- CreateTable
CREATE TABLE `GlobalMailSettings` (
    `id` VARCHAR(191) NOT NULL,
    `host` VARCHAR(255) NULL,
    `port` INTEGER NOT NULL DEFAULT 587,
    `secure` BOOLEAN NOT NULL DEFAULT false,
    `user` VARCHAR(255) NULL,
    `password` VARCHAR(500) NULL,
    `fromAddress` VARCHAR(255) NULL,
    `updatedAt` DATETIME(3) NOT NULL,
    `updatedById` VARCHAR(191) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
