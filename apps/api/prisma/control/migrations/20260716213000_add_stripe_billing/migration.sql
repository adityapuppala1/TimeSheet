-- AlterTable
ALTER TABLE `Organization` ADD COLUMN `stripeCustomerId` VARCHAR(255) NULL,
    ADD COLUMN `stripeSubscriptionId` VARCHAR(255) NULL;

-- CreateTable
CREATE TABLE `PlatformBillingSettings` (
    `id` VARCHAR(191) NOT NULL,
    `encryptedSecretKey` VARCHAR(191) NULL,
    `encryptedWebhookSigningSecret` VARCHAR(191) NULL,
    `priceIdTeam` VARCHAR(255) NULL,
    `priceIdEnterprise` VARCHAR(255) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `Organization_stripeCustomerId_key` ON `Organization`(`stripeCustomerId`);

-- CreateIndex
CREATE UNIQUE INDEX `Organization_stripeSubscriptionId_key` ON `Organization`(`stripeSubscriptionId`);
