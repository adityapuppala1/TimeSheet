-- AlterTable
ALTER TABLE `globalaisettings` ADD COLUMN `planBreakdownEnabled` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `projectRiskAgentEnabled` BOOLEAN NOT NULL DEFAULT false;
