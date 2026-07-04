-- AlterTable
ALTER TABLE `globalaisettings` ADD COLUMN `commentSummaryEnabled` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `workspaceSearchEnabled` BOOLEAN NOT NULL DEFAULT false;
