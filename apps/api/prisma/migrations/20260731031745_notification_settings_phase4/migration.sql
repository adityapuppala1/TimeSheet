-- AlterTable
ALTER TABLE `globalnotificationsettings` ADD COLUMN `emailBugPatternDigest` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `emailTicketStaleNudge` BOOLEAN NOT NULL DEFAULT true;
