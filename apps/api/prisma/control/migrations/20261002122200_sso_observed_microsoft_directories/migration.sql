-- Which Microsoft directories people sign in to each workspace from (audit C1, staged rollout).
--
-- WHY. A Microsoft configuration whose tenant ID is blank — or `common`, `organizations`, `consumers`
-- — accepts a token from ANY Entra directory (and, depending on the app registration, any personal
-- Microsoft account), and people are matched to accounts by email address. Requiring a tenant ID
-- outright would switch off Microsoft sign-in on deploy for every such workspace, and lock an SSO-only
-- one out completely. So the rollout observes first: every successful Microsoft sign-in records its
-- `tid` and email DOMAIN here, counted. The settings card then offers "Restrict to my directory"
-- prefilled from what was observed, listing every OTHER directory and its domains so the admin sees who
-- would be shut out before confirming; the platform console flags workspaces still open to any.
--
-- WHAT IS STORED: a directory id and an email domain — organisations, not people. No address.
-- One row per (workspace, directory, domain); `count`, `firstSeenAt` and `lastSeenAt` are maintained by
-- an upsert on each sign-in.
--
-- WHAT EXISTING DEPLOYMENTS SEE: an empty table. Nothing is enforced by it; the history starts at the
-- deploy that ships this. Sign-in behaviour is unchanged.
--
-- Every statement is guarded, so a run interrupted anywhere replays safely. CANONICAL CASING, written
-- by hand (docs/DATABASE.md).
-- @rerunnable

CREATE TABLE IF NOT EXISTS `OrgSsoObservedTenant` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(64) NOT NULL,
    `emailDomain` VARCHAR(253) NOT NULL,
    `count` INTEGER NOT NULL DEFAULT 1,
    `firstSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `OrgSsoObservedTenant_organizationId_tenantId_emailDomain_key`(`organizationId`, `tenantId`, `emailDomain`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @f := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'OrgSsoObservedTenant' AND CONSTRAINT_NAME = 'OrgSsoObservedTenant_organizationId_fkey');
SET @ddl := IF(@f = 0, 'ALTER TABLE `OrgSsoObservedTenant` ADD CONSTRAINT `OrgSsoObservedTenant_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
