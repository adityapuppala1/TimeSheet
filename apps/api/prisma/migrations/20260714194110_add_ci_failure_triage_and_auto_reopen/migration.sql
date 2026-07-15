-- AlterTable
ALTER TABLE `globalaisettings` ADD COLUMN `ciFailureTriageEnabled` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `ingestionsettings` ADD COLUMN `autoReopenEnabled` BOOLEAN NOT NULL DEFAULT false;
