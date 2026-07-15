-- CreateTable
CREATE TABLE `GitConnection` (
    `id` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(20) NOT NULL DEFAULT 'GITHUB',
    `clientId` VARCHAR(255) NULL,
    `encryptedClientSecret` VARCHAR(1000) NULL,
    `encryptedAccessToken` VARCHAR(1000) NULL,
    `accountLogin` VARCHAR(255) NULL,
    `connectedById` VARCHAR(191) NULL,
    `connectedAt` DATETIME(3) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `GitConnection` ADD CONSTRAINT `GitConnection_connectedById_fkey` FOREIGN KEY (`connectedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
