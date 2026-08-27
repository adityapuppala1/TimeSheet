-- 3.6.0: record the result of an SSO connection test on the config it tested.
--
-- These three columns are what lets `OrgAuthMethod.requireSsoOnly` refuse to turn off password
-- login for a whole workspace on a configuration nobody has ever proven works. Before them, a
-- super admin could set `requireSsoOnly` against a config holding dummy values and lock every
-- user out including themselves, with no break-glass short of a manual UPDATE against this table.
--
-- All three are NULLABLE with no backfill, and that is the correct state: every existing row has
-- genuinely never been tested, and "never tested" is a real answer the settings card renders. A
-- backfill to PASS would be a lie that defeats the gate on its first day.
--
-- PORTABILITY NOTE: `prisma migrate diff` introspected off Windows MariaDB emits `orgssoconfig`;
-- written in canonical casing by hand (the 2.4.0 lesson, docs/DATABASE.md).

-- AlterTable
ALTER TABLE `OrgSsoConfig` ADD COLUMN `lastTestedAt` DATETIME(3) NULL;
ALTER TABLE `OrgSsoConfig` ADD COLUMN `lastTestStatus` VARCHAR(16) NULL;
ALTER TABLE `OrgSsoConfig` ADD COLUMN `lastTestMessage` TEXT NULL;
