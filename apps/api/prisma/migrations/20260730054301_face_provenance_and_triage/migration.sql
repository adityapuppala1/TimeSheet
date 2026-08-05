-- AlterTable
ALTER TABLE `faceverificationattempt` ADD COLUMN `autoResolvedReason` VARCHAR(200) NULL,
    ADD COLUMN `captureLagMs` INTEGER NULL,
    ADD COLUMN `challengeId` VARCHAR(64) NULL,
    ADD COLUMN `frameIntervalMs` INTEGER NULL,
    ADD COLUMN `provenanceNote` VARCHAR(200) NULL,
    ADD COLUMN `provenanceSuspect` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `globalaisettings` ADD COLUMN `facePolicyCopilotEnabled` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `globalfaceverificationsettings` ADD COLUMN `autoTriageHonestFailures` BOOLEAN NOT NULL DEFAULT false;
