-- AlterTable
ALTER TABLE `FaceVerificationAttempt` ADD COLUMN `challengeInstruction` VARCHAR(20) NULL,
    ADD COLUMN `challengePitchDelta` DOUBLE NULL,
    ADD COLUMN `challengeYawDelta` DOUBLE NULL,
    ADD COLUMN `deviceLabel` VARCHAR(255) NULL,
    ADD COLUMN `frameSimilarity` DOUBLE NULL,
    ADD COLUMN `unfamiliarNetwork` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `virtualCameraSuspected` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `GlobalAISettings` ADD COLUMN `faceReviewSummaryEnabled` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `GlobalFaceVerificationSettings` ADD COLUMN `challengeEnabled` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `entitlementLostAt` DATETIME(3) NULL,
    ADD COLUMN `requireForApproval` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `GlobalNotificationSettings` ADD COLUMN `emailFaceDataDeleted` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `emailFaceEnrollmentReminder` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `emailFaceEnrollmentRequired` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `emailFaceEntitlementLost` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `emailFaceReviewOverdue` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `emailFaceVerificationFlagged` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `emailIdentityWeeklyDigest` BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE `FaceChallenge` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `context` VARCHAR(20) NOT NULL,
    `instruction` VARCHAR(20) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,
    `usedAt` DATETIME(3) NULL,

    INDEX `FaceChallenge_userId_createdAt_idx`(`userId`, `createdAt`),
    INDEX `FaceChallenge_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `FaceChallenge` ADD CONSTRAINT `FaceChallenge_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
