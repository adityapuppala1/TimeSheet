-- 3.8.0: opt-in malware scanning on upload.
--
-- FALSE by default, and that default is the whole reason this is a toggle rather than always-on: a
-- deployment with no clamd reachable would otherwise be unable to accept a single attachment from
-- the moment it upgraded. Turning it on is a deliberate act by a workspace's own super admin, who
-- is also the person who knows whether a scanner exists to turn it on for.
--
-- What ON means is stricter than it sounds, and deliberately so: an upload that cannot be scanned
-- is REFUSED, not stored-and-flagged. An "enabled" scanner that passes files through when the
-- daemon is down is worse than no scanner, because the admin has been told files are scanned.
--
-- PORTABILITY NOTE: `prisma migrate diff` introspected off Windows MariaDB emits
-- `globalticketsettings`; written in canonical casing by hand (the 2.4.0 lesson, docs/DATABASE.md).

-- AlterTable
ALTER TABLE `GlobalTicketSettings` ADD COLUMN `virusScanEnabled` BOOLEAN NOT NULL DEFAULT false;
