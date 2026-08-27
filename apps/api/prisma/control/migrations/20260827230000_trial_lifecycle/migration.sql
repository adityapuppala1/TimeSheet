-- 3.6.0: a trial with a clock, and a grace state between ACTIVE and SUSPENDED.
--
-- WHY GRACE EXISTS AS A STATUS RATHER THAN A FLAG. `resolveActiveOrgBySlug` admits only ACTIVE, so
-- moving an expired trial straight to SUSPENDED refuses every request including sign-in — and the
-- person who can pay is refused on the day they decided to. GRACE resolves like ACTIVE and is shut
-- like SUSPENDED everywhere past authentication, so billing and export stay reachable to a super
-- admin and nothing else does.
--
-- EVERY COLUMN IS NULLABLE AND NOTHING IS BACKFILLED. A null `trialEndsAt` means "this workspace
-- has no trial", never "its trial expired" — which is exactly right for every org that exists
-- today, all of which were provisioned by hand. A backfill would put live customers on a clock.
--
-- PORTABILITY NOTE: written in canonical casing by hand — `prisma migrate diff` introspected off
-- Windows MariaDB emits lowercase table names (the 2.4.0 lesson, docs/DATABASE.md).

-- AlterEnum
ALTER TABLE `Organization` MODIFY `status` ENUM('PROVISIONING', 'ACTIVE', 'GRACE', 'SUSPENDED', 'ARCHIVED') NOT NULL DEFAULT 'PROVISIONING';

-- AlterTable
ALTER TABLE `Organization` ADD COLUMN `trialStartedAt` DATETIME(3) NULL;
ALTER TABLE `Organization` ADD COLUMN `trialEndsAt` DATETIME(3) NULL;
ALTER TABLE `Organization` ADD COLUMN `trialTier` ENUM('STARTER', 'TEAM', 'ENTERPRISE') NULL;
ALTER TABLE `Organization` ADD COLUMN `trialNoticesSent` JSON NULL;
ALTER TABLE `Organization` ADD COLUMN `graceStartedAt` DATETIME(3) NULL;

-- The trial clock is read by the daily lifecycle worker across every org on the deployment.
CREATE INDEX `Organization_trialEndsAt_idx` ON `Organization`(`trialEndsAt`);
