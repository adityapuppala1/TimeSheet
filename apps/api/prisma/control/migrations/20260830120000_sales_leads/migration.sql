-- 4.0.0: the public contact form's leads, and the inbox their notification goes to.
--
-- WHY A LEAD LIVES IN THE CONTROL PLANE: it has no workspace. The person filling the form is
-- deciding whether to become a customer, so there is no tenant database to write to and no
-- `resolveTenant` that could find one. There is deliberately no foreign key to `Organization`
-- either — the row that matters most is the one from a company that does not exist here yet.
--
-- WHY EVERY ENUM-SHAPED COLUMN IS A VARCHAR: team-size bands, deployment interest, timeline and
-- pipeline status are all things a sales process renames, and renaming a MySQL ENUM is a table
-- rewrite. `TrialFeedback.stage` made the same call for the same reason. `interests` is JSON
-- because it is a multi-select whose options are a marketing decision, not a schema one.
--
-- `isFreeMailDomain` IS A FLAG, NOT A GATE. Signup refuses gmail.com because a trial is per
-- organisation and one address anybody can make in ten seconds is not one. A sales enquiry is the
-- opposite case: a founder evaluating the product from a personal address is a real lead, and this
-- deployment's own sales inbox is itself a Gmail address. The column records what the address is
-- so the console can show it; nothing on the server ever refuses a row because of it.
--
-- `PlatformMailSettings.salesInboxAddress` is configuration with a shipped default rather than a
-- literal at the send site: where enquiries land is a per-deployment fact, and a self-hosted
-- install's sales address is not ours.
--
-- PORTABILITY NOTE: written in canonical casing by hand — `prisma migrate diff` introspected off
-- Windows MariaDB emits lowercase table names (the 2.4.0 lesson, docs/DATABASE.md).

-- AlterTable
ALTER TABLE `PlatformMailSettings` ADD COLUMN `salesInboxAddress` VARCHAR(255) NULL;

-- CreateTable
CREATE TABLE `SalesLead` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `email` VARCHAR(255) NOT NULL,
    `company` VARCHAR(255) NOT NULL,
    `role` VARCHAR(120) NULL,
    `country` VARCHAR(120) NULL,
    `phone` VARCHAR(40) NULL,
    `teamSize` VARCHAR(24) NOT NULL,
    `deploymentInterest` VARCHAR(24) NOT NULL,
    `timeline` VARCHAR(24) NOT NULL,
    `interests` JSON NOT NULL,
    `message` TEXT NOT NULL,
    `isFreeMailDomain` BOOLEAN NOT NULL DEFAULT false,
    `sourcePage` VARCHAR(255) NULL,
    `referrer` VARCHAR(500) NULL,
    `utmSource` VARCHAR(120) NULL,
    `utmMedium` VARCHAR(120) NULL,
    `utmCampaign` VARCHAR(120) NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'NEW',
    `ownerLabel` VARCHAR(255) NULL,
    `notes` TEXT NULL,
    `contactedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `SalesLead_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `SalesLead_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
