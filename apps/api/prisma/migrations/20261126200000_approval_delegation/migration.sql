-- 7.0.0: approval delegation. Additive only: an empty table changes nobody's inbox.
CREATE TABLE `ApprovalDelegation` (
    `id` VARCHAR(191) NOT NULL,
    `delegatorId` VARCHAR(64) NOT NULL,
    `delegateId` VARCHAR(64) NOT NULL,
    `startDate` DATE NOT NULL,
    `endDate` DATE NOT NULL,
    `createdById` VARCHAR(64) NOT NULL,
    `revokedAt` DATETIME(3) NULL,
    `revokedById` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ApprovalDelegation_delegateId_startDate_endDate_idx`(`delegateId`, `startDate`, `endDate`),
    INDEX `ApprovalDelegation_delegatorId_startDate_endDate_idx`(`delegatorId`, `startDate`, `endDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
