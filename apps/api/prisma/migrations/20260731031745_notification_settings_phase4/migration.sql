-- AlterTable
ALTER TABLE `GlobalNotificationSettings` ADD COLUMN `emailBugPatternDigest` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `emailTicketStaleNudge` BOOLEAN NOT NULL DEFAULT true;
