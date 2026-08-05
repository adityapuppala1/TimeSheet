-- CreateTable
CREATE TABLE `Organization` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(200) NOT NULL,
    `slug` VARCHAR(63) NOT NULL,
    `status` ENUM('PROVISIONING', 'ACTIVE', 'SUSPENDED', 'ARCHIVED') NOT NULL DEFAULT 'PROVISIONING',
    `planTier` ENUM('STARTER', 'TEAM', 'ENTERPRISE') NOT NULL DEFAULT 'STARTER',
    `seatLimitOverride` INTEGER NULL,
    `aiMonthlyBudgetCeilingOverride` DECIMAL(10, 2) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `suspendedAt` DATETIME(3) NULL,
    `suspendedReason` TEXT NULL,

    UNIQUE INDEX `Organization_slug_key`(`slug`),
    INDEX `Organization_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OrgDatabase` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `encryptedDsn` TEXT NOT NULL,
    `host` VARCHAR(255) NOT NULL,
    `databaseName` VARCHAR(128) NOT NULL,
    `migratedAt` DATETIME(3) NULL,
    `schemaVersion` VARCHAR(160) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `OrgDatabase_organizationId_key`(`organizationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OrgSsoConfig` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `providerType` ENUM('GOOGLE', 'MICROSOFT', 'SAML') NOT NULL,
    `isEnabled` BOOLEAN NOT NULL DEFAULT false,
    `clientId` VARCHAR(255) NULL,
    `encryptedClientSecret` TEXT NULL,
    `tenantHint` VARCHAR(255) NULL,
    `idpEntityId` VARCHAR(500) NULL,
    `idpSsoUrl` VARCHAR(500) NULL,
    `idpCertificate` TEXT NULL,
    `spEntityId` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `OrgSsoConfig_organizationId_providerType_key`(`organizationId`, `providerType`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OrgAuthMethod` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `passwordLoginEnabled` BOOLEAN NOT NULL DEFAULT true,
    `requireSsoOnly` BOOLEAN NOT NULL DEFAULT false,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `OrgAuthMethod_organizationId_key`(`organizationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PlatformAdminUser` (
    `id` VARCHAR(191) NOT NULL,
    `email` VARCHAR(255) NOT NULL,
    `passwordHash` VARCHAR(191) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastLoginAt` DATETIME(3) NULL,

    UNIQUE INDEX `PlatformAdminUser_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PlatformAdminSession` (
    `id` VARCHAR(191) NOT NULL,
    `adminUserId` VARCHAR(191) NOT NULL,
    `refreshHash` VARCHAR(191) NOT NULL,
    `previousRefreshHash` VARCHAR(191) NULL,
    `refreshRotatedAt` DATETIME(3) NULL,
    `userAgent` VARCHAR(191) NULL,
    `ipAddress` VARCHAR(191) NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `revokedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `PlatformAdminSession_adminUserId_expiresAt_idx`(`adminUserId`, `expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PlanTierLimit` (
    `tier` ENUM('STARTER', 'TEAM', 'ENTERPRISE') NOT NULL,
    `seatLimit` INTEGER NOT NULL,
    `aiMonthlyBudgetCeilingUsd` DECIMAL(10, 2) NOT NULL,
    `allowedSsoProviders` JSON NOT NULL,

    PRIMARY KEY (`tier`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `OrgDatabase` ADD CONSTRAINT `OrgDatabase_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrgSsoConfig` ADD CONSTRAINT `OrgSsoConfig_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrgAuthMethod` ADD CONSTRAINT `OrgAuthMethod_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PlatformAdminSession` ADD CONSTRAINT `PlatformAdminSession_adminUserId_fkey` FOREIGN KEY (`adminUserId`) REFERENCES `PlatformAdminUser`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
