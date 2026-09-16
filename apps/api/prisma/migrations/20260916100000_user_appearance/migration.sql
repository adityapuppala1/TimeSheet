-- V12: a saved appearance preference on the User row — theme mode and accent palette.
--
-- WHY ONE JSON COLUMN AND NOT TWO: mode and accent are one preference, edited from one card, and the
-- V12 plan has a third knob (density) queued behind them. A column per knob means a migration per
-- knob across every tenant database; a validated JSON object means the next one is a shared-type
-- change. The allowed shape is enforced on write by the API against packages/shared/src/appearance.ts,
-- never by the database, so an old row and a future row are both just "whatever was valid when saved".
--
-- WHAT EXISTING ROWS DO: they get NULL, and NULL is rendered by the web as "follow the OS, default
-- accent" — which is precisely what every existing person was already seeing before this column
-- existed. Nobody's screen changes on deploy. No row is read, no value is backfilled.
--
-- WHY `ADD COLUMN IF NOT EXISTS` IS NOT USED: MySQL 8 does not support it (MariaDB does), and this
-- application runs on both. The information_schema + PREPARE guard below is the house pattern for
-- an idempotent ADD COLUMN that works on either (docs/DATABASE.md), so `migrate deploy` re-running
-- this file — an interrupted first attempt, a rerunnable recovery — cannot fail on a column that is
-- already there.
--
-- Additive only: no existing column altered, no data touched, no behaviour changed for anyone who
-- never opens the Appearance card.
--
-- PORTABILITY NOTE: canonical casing written by hand — `prisma migrate diff` introspected off
-- Windows MariaDB emits lowercase table names (the 2.4.0 lesson, docs/DATABASE.md).

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'User' AND COLUMN_NAME = 'appearance'
);
SET @ddl := IF(@col_exists = 0, 'ALTER TABLE `User` ADD COLUMN `appearance` JSON NULL', 'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
