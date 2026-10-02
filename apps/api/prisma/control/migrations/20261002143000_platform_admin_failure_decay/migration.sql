-- The console's per-account lockout forgives a stranger who stops guessing (review R1-2).
--
-- `PlatformAdminUser.lastFailedLoginAt` — when the last counted sign-in failure happened. On an
-- account WITHOUT a second factor, a quiet spell of 15 minutes after the last failure and after the
-- last lock ends forgives the count, the same model as the tenant lockout. Without it the count
-- never decayed: the bootstrap owner's address is public on every install, so about one wrong guess
-- an hour kept that owner off the console indefinitely. (An account WITH a second factor no longer
-- counts password failures at all; only its second-factor stage locks — see
-- platform-admin-auth.service.ts.)
--
-- WHAT EXISTING ROWS DO: the column starts NULL, which reads as "no failure recorded". A count left
-- over from before this migration is therefore forgiven at its next failure once any lock it holds
-- is a quiet spell old — which is the point. Nobody is unlocked early: a lock in force still runs.
--
-- Guarded through information_schema + PREPARE, so a run interrupted anywhere replays safely.
-- CANONICAL CASING, written by hand (docs/DATABASE.md).
-- @rerunnable

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'PlatformAdminUser' AND COLUMN_NAME = 'lastFailedLoginAt');
SET @ddl := IF(@c = 0, 'ALTER TABLE `PlatformAdminUser` ADD COLUMN `lastFailedLoginAt` DATETIME(3) NULL', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
