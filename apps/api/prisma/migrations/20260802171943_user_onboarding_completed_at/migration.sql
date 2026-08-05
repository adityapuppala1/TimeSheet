-- AlterTable
ALTER TABLE `user` ADD COLUMN `onboardingCompletedAt` DATETIME(3) NULL;

-- Backfill: every user who ALREADY EXISTS is treated as onboarded.
--
-- This is the line that makes the first-run gate safe to ship. Without it, adding the gate would
-- immediately lock out every current user whose profile happens to be missing a phone number or
-- who predates face verification - punishing people for a change they had no part in, which is
-- exactly the objection the old dismissible checklist was written to avoid.
--
-- Only the new column is written. No existing column, row, or table is modified or removed.
UPDATE `user` SET `onboardingCompletedAt` = `createdAt` WHERE `onboardingCompletedAt` IS NULL;

