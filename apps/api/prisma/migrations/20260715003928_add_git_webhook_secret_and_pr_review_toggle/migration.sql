-- AlterTable
ALTER TABLE `GitConnection` ADD COLUMN `encryptedWebhookSecret` VARCHAR(1000) NULL;

-- AlterTable
ALTER TABLE `GlobalAISettings` ADD COLUMN `aiPrReviewSummaryEnabled` BOOLEAN NOT NULL DEFAULT false;
