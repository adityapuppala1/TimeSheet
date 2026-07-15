-- AlterTable
ALTER TABLE `gitconnection` ADD COLUMN `encryptedWebhookSecret` VARCHAR(1000) NULL;

-- AlterTable
ALTER TABLE `globalaisettings` ADD COLUMN `aiPrReviewSummaryEnabled` BOOLEAN NOT NULL DEFAULT false;
