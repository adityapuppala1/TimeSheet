-- AlterTable
ALTER TABLE `FaceVerificationAttempt` ADD COLUMN `autoResolvedReason` VARCHAR(200) NULL,
    ADD COLUMN `captureLagMs` INTEGER NULL,
    ADD COLUMN `challengeId` VARCHAR(64) NULL,
    ADD COLUMN `frameIntervalMs` INTEGER NULL,
    ADD COLUMN `provenanceNote` VARCHAR(200) NULL,
    ADD COLUMN `provenanceSuspect` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `GlobalAISettings` ADD COLUMN `facePolicyCopilotEnabled` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `GlobalFaceVerificationSettings` ADD COLUMN `autoTriageHonestFailures` BOOLEAN NOT NULL DEFAULT false;
