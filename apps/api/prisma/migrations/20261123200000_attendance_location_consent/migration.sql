-- V17 A2: per-person record of accepting the punch-in location consent. Nullable, no backfill:
-- nobody has consented to anything yet. `User` in canonical casing (docs/DATABASE.md).
ALTER TABLE `User` ADD COLUMN `attendanceLocationConsentAt` DATETIME(3) NULL;
