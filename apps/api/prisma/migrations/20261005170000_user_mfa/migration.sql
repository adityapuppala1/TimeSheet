-- Additive: two-factor sign-in for workspace users.
ALTER TABLE `User` ADD COLUMN `mfaEnabled` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `mfaSecret` TEXT NULL,
    ADD COLUMN `mfaPendingSecret` TEXT NULL,
    ADD COLUMN `mfaEnabledAt` DATETIME(3) NULL,
    ADD COLUMN `mfaLastStep` INTEGER NULL;

CREATE TABLE `UserRecoveryCode` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `codeHash` VARCHAR(255) NOT NULL,
    `usedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `UserRecoveryCode_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `UserRecoveryCode` ADD CONSTRAINT `UserRecoveryCode_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
