-- AlterTable
ALTER TABLE `GlobalAISettings` ADD COLUMN `ciFailureTriageEnabled` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `IngestionSettings` ADD COLUMN `autoReopenEnabled` BOOLEAN NOT NULL DEFAULT false;
