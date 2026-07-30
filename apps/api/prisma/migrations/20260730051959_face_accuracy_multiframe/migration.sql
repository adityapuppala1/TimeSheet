-- AlterTable
ALTER TABLE `faceverificationattempt` ADD COLUMN `durationMs` INTEGER NULL,
    ADD COLUMN `effectiveThreshold` DOUBLE NULL,
    ADD COLUMN `qualityScore` DOUBLE NULL;

-- CreateTable
CREATE TABLE `FaceEnrollmentTemplate` (
    `id` VARCHAR(191) NOT NULL,
    `enrollmentId` VARCHAR(191) NOT NULL,
    `encryptedEmbedding` TEXT NOT NULL,
    `modelVersion` VARCHAR(60) NOT NULL,
    `quality` DOUBLE NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `FaceEnrollmentTemplate_enrollmentId_idx`(`enrollmentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `FaceEnrollmentTemplate` ADD CONSTRAINT `FaceEnrollmentTemplate_enrollmentId_fkey` FOREIGN KEY (`enrollmentId`) REFERENCES `FaceEnrollment`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
