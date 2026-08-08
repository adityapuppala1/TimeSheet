-- AlterTable
ALTER TABLE `GlobalTicketSettings` ADD COLUMN `defaultCurrency` VARCHAR(3) NOT NULL DEFAULT 'USD',
    ADD COLUMN `enableAttestationSharing` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `enableAttestations` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `Project` ADD COLUMN `billingCurrency` VARCHAR(3) NULL,
    ADD COLUMN `clientName` VARCHAR(160) NULL,
    ADD COLUMN `defaultHourlyRate` DECIMAL(10, 2) NULL;

-- AlterTable
ALTER TABLE `Timesheet` ADD COLUMN `billable` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `billedAmount` DECIMAL(12, 2) NULL,
    ADD COLUMN `billedCurrency` VARCHAR(3) NULL,
    ADD COLUMN `billedRate` DECIMAL(10, 2) NULL,
    ADD COLUMN `billedRateSource` VARCHAR(20) NULL,
    ADD COLUMN `rateSnapshotAt` DATETIME(3) NULL;

-- CreateTable
CREATE TABLE `WorkAttestation` (
    `id` VARCHAR(191) NOT NULL,
    `reference` VARCHAR(40) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `periodStart` DATE NOT NULL,
    `periodEnd` DATE NOT NULL,
    `status` VARCHAR(10) NOT NULL DEFAULT 'ISSUED',
    `currency` VARCHAR(3) NOT NULL,
    `totalHours` DECIMAL(10, 2) NOT NULL,
    `billableHours` DECIMAL(10, 2) NOT NULL,
    `unratedHours` DECIMAL(10, 2) NOT NULL,
    `totalAmount` DECIMAL(14, 2) NOT NULL,
    `entryCount` INTEGER NOT NULL,
    `payload` JSON NOT NULL,
    `payloadHash` VARCHAR(64) NOT NULL,
    `generatedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `voidedAt` DATETIME(3) NULL,
    `voidReason` VARCHAR(500) NULL,

    UNIQUE INDEX `WorkAttestation_reference_key`(`reference`),
    INDEX `WorkAttestation_projectId_periodStart_periodEnd_idx`(`projectId`, `periodStart`, `periodEnd`),
    INDEX `WorkAttestation_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AttestationShareLink` (
    `id` VARCHAR(191) NOT NULL,
    `attestationId` VARCHAR(191) NOT NULL,
    `tokenHash` VARCHAR(64) NOT NULL,
    `tokenPrefix` VARCHAR(12) NOT NULL,
    `scope` VARCHAR(10) NOT NULL DEFAULT 'SUMMARY',
    `expiresAt` DATETIME(3) NOT NULL,
    `revokedAt` DATETIME(3) NULL,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `viewCount` INTEGER NOT NULL DEFAULT 0,
    `lastViewedAt` DATETIME(3) NULL,

    UNIQUE INDEX `AttestationShareLink_tokenHash_key`(`tokenHash`),
    INDEX `AttestationShareLink_tokenHash_idx`(`tokenHash`),
    INDEX `AttestationShareLink_attestationId_idx`(`attestationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `Timesheet_projectId_status_workDate_idx` ON `Timesheet`(`projectId`, `status`, `workDate`);

-- AddForeignKey
ALTER TABLE `WorkAttestation` ADD CONSTRAINT `WorkAttestation_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WorkAttestation` ADD CONSTRAINT `WorkAttestation_generatedById_fkey` FOREIGN KEY (`generatedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AttestationShareLink` ADD CONSTRAINT `AttestationShareLink_attestationId_fkey` FOREIGN KEY (`attestationId`) REFERENCES `WorkAttestation`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AttestationShareLink` ADD CONSTRAINT `AttestationShareLink_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
