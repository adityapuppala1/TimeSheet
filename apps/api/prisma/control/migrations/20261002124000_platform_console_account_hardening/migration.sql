-- The platform console's own accounts get the controls a tenant account already had, and a few it
-- did not.
--
-- (1) `PlatformAdminUser.mustChangePassword` — a real gate. While it is true the API answers every
--     console route except the operator's own `/auth/*` routes with 403 PASSWORD_ROTATION_REQUIRED.
--     Set for a password nobody chose for themselves: a bootstrap password the control seed
--     generated, an operator created or reactivated through the approval queue, an owner minted by
--     the break-glass CLI.
-- (2) `PlatformAdminUser.failedLoginCount` / `lockedUntil` — per-account lockout. The per-IP limiter
--     in app.ts cannot see one password being guessed from many addresses; a counter on the account
--     can. Progressive: locked from the fifth consecutive failure, doubling to a one-hour ceiling,
--     reset by a completed sign-in.
-- (3) `PlatformAdminSession.lastUsedAt` — what the console's idle timeout measures.
--
-- ===================================================================================
-- WHAT EXISTING ROWS DO.
--
-- Nothing changes for any existing operator: `mustChangePassword` defaults to FALSE, so an install
-- upgrading with its admin still on the old public seed password is NOT locked behind a rotation by
-- this migration — the console's existing "seeded bootstrap password" banner keeps asking, and only
-- passwords issued from now on carry the flag. Flagging existing rows would lock the operator
-- running the upgrade out of everything but the password dialog with no warning, which is a
-- decision for a release note rather than a migration.
--
-- Counters start at zero and nobody is locked. Existing sessions get `lastUsedAt` NULL, which the
-- idle check reads as "since the session was created" — so a session older than the idle timeout
-- that has not been used since this deploy ends at its next request, which is the intent.
--
-- CANONICAL CASING, written by hand: Windows MariaDB emits lowercase table names (the 2.4.0 lesson,
-- docs/DATABASE.md).
-- ===================================================================================
--
-- Every column goes through an information_schema check + PREPARE, so a run interrupted anywhere
-- replays safely. The control-plane checks in tests/unit/migration-portability.test.ts hold it to that.
-- @rerunnable

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'PlatformAdminUser' AND COLUMN_NAME = 'mustChangePassword');
SET @ddl := IF(@c = 0, 'ALTER TABLE `PlatformAdminUser` ADD COLUMN `mustChangePassword` BOOLEAN NOT NULL DEFAULT false', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'PlatformAdminUser' AND COLUMN_NAME = 'failedLoginCount');
SET @ddl := IF(@c = 0, 'ALTER TABLE `PlatformAdminUser` ADD COLUMN `failedLoginCount` INTEGER NOT NULL DEFAULT 0', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'PlatformAdminUser' AND COLUMN_NAME = 'lockedUntil');
SET @ddl := IF(@c = 0, 'ALTER TABLE `PlatformAdminUser` ADD COLUMN `lockedUntil` DATETIME(3) NULL', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'PlatformAdminSession' AND COLUMN_NAME = 'lastUsedAt');
SET @ddl := IF(@c = 0, 'ALTER TABLE `PlatformAdminSession` ADD COLUMN `lastUsedAt` DATETIME(3) NULL', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
