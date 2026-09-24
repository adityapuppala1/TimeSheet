-- V12 C11: a saved AI answer preference on the User row, so the choice follows the person rather
-- than the browser.
--
-- WHAT WAS WRONG WITH WHERE IT LIVED: the answer style (default | concise | detailed | checklist)
-- was already an explicit, opt-in choice with a reset — but it was kept in `localStorage`, keyed by
-- user id. So the same person picked "concise" on their laptop and got the default on their phone,
-- and clearing site data reset it without saying so. Nothing about the CHOICE changes here; only
-- where it is kept.
--
-- WHY NOT INSIDE `appearance`: that column is documented as `{ mode, accent, density }` and is
-- edited from the Appearance card. An AI answer style is not an appearance, and a JSON column that
-- accepts anything vaguely preference-shaped stops meaning anything. A second nullable column keeps
-- both honest, and follows the same rule the first one set: the shape is enforced on write by the
-- API against packages/shared/src/ai-preferences.ts, never by the database.
--
-- WHAT EXISTING ROWS DO: they get NULL, which reads as "never chose", which is exactly what every
-- person already had. Nobody's answers change on deploy. No row is read, no value is backfilled,
-- and the browser copy keeps working for anyone who never opens Ask AI again.
--
-- WHY `ADD COLUMN IF NOT EXISTS` IS NOT USED: MySQL 8 does not support it (MariaDB does), and this
-- application runs on both. The information_schema + PREPARE guard is the house pattern for an
-- idempotent ADD COLUMN on either engine (docs/DATABASE.md), so `migrate deploy` re-running this
-- file cannot fail on a column that is already there.
--
-- Additive only: no existing column altered, no data touched.
--
-- PORTABILITY NOTE: canonical casing written by hand — `prisma migrate diff` introspected off
-- Windows MariaDB emits lowercase table names (the 2.4.0 lesson, docs/DATABASE.md).

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'User' AND COLUMN_NAME = 'aiPreferences'
);
SET @ddl := IF(@col_exists = 0, 'ALTER TABLE `User` ADD COLUMN `aiPreferences` JSON NULL', 'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
