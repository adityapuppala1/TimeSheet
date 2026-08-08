-- AlterTable
ALTER TABLE `User` ADD COLUMN `faceVerificationRequired` BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE `GlobalFaceVerificationSettings` (
    `id` VARCHAR(191) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `requireForTimesheet` BOOLEAN NOT NULL DEFAULT true,
    `requireForTicket` BOOLEAN NOT NULL DEFAULT false,
    `enforcementMode` VARCHAR(20) NOT NULL DEFAULT 'SELECTED',
    `matchThreshold` DOUBLE NOT NULL DEFAULT 0.75,
    `antispoofThreshold` DOUBLE NOT NULL DEFAULT 0.5,
    `livenessThreshold` DOUBLE NOT NULL DEFAULT 0.6,
    `maxAttempts` INTEGER NOT NULL DEFAULT 3,
    `verificationTtlSeconds` INTEGER NOT NULL DEFAULT 300,
    `imageRetentionDays` INTEGER NOT NULL DEFAULT 30,
    `consentText` TEXT NULL,
    `updatedAt` DATETIME(3) NOT NULL,
    `updatedById` VARCHAR(191) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `FaceEnrollment` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `encryptedEmbedding` TEXT NOT NULL,
    `modelVersion` VARCHAR(60) NOT NULL,
    `referenceImagePath` VARCHAR(500) NULL,
    `consentAt` DATETIME(3) NOT NULL,
    `consentText` TEXT NOT NULL,
    `consentIp` VARCHAR(64) NULL,
    `enrolledById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `FaceEnrollment_userId_key`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `FaceVerificationAttempt` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `context` VARCHAR(20) NOT NULL,
    `outcome` VARCHAR(30) NOT NULL,
    `similarity` DOUBLE NULL,
    `antispoofReal` DOUBLE NULL,
    `livenessScore` DOUBLE NULL,
    `imagePath` VARCHAR(500) NULL,
    `purgedAt` DATETIME(3) NULL,
    `consumedAt` DATETIME(3) NULL,
    `timesheetId` VARCHAR(64) NULL,
    `ticketId` VARCHAR(64) NULL,
    `flaggedForReview` BOOLEAN NOT NULL DEFAULT false,
    `reviewedById` VARCHAR(191) NULL,
    `reviewedAt` DATETIME(3) NULL,
    `reviewNote` TEXT NULL,
    `ipAddress` VARCHAR(64) NULL,
    `userAgent` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `FaceVerificationAttempt_userId_createdAt_idx`(`userId`, `createdAt`),
    INDEX `FaceVerificationAttempt_flaggedForReview_createdAt_idx`(`flaggedForReview`, `createdAt`),
    INDEX `FaceVerificationAttempt_outcome_createdAt_idx`(`outcome`, `createdAt`),
    INDEX `FaceVerificationAttempt_purgedAt_idx`(`purgedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `FaceEnrollment` ADD CONSTRAINT `FaceEnrollment_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `FaceVerificationAttempt` ADD CONSTRAINT `FaceVerificationAttempt_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `FaceVerificationAttempt` ADD CONSTRAINT `FaceVerificationAttempt_reviewedById_fkey` FOREIGN KEY (`reviewedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
