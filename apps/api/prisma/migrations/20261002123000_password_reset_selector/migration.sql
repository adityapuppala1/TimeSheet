-- Reset links become `<selector>.<verifier>` (security audit #3, services/reset-token.service.ts).
--
-- WHAT WAS WRONG: `PasswordResetToken.tokenHash` was bcrypt with a per-row salt, so it could not be
-- looked up by equality. Redemption loaded up to 500 live tokens across every user and ran a
-- bcrypt compare on each — about 24 s of CPU for one wrong guess once 500 were live — and a genuine
-- link older than the newest 500 could never match at all.
--
-- WHAT THIS ADDS: one nullable column, `selector`, with a UNIQUE index. New links are looked up by
-- it (one indexed read) and their verifier is checked against a SHA-256 stored in `tokenHash`.
--
-- WHAT EXISTING ROWS DO: they keep `selector` NULL and keep working until they expire (30 minutes
-- for a reset, 72 hours for a welcome link), checked by the old scan restricted to NULL-selector
-- rows. No new row ever enters that pool, so it drains to empty on its own. No row is read or
-- rewritten here.
--
-- MySQL allows any number of NULLs in a UNIQUE index, so the legacy rows do not collide.
--
-- Idempotent through the house information_schema + PREPARE guard (MySQL 8 has no ADD COLUMN IF
-- NOT EXISTS; MariaDB does; this app runs on both). Canonical casing written by hand.
-- @rerunnable

SET @stmt := (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `PasswordResetToken` ADD COLUMN `selector` VARCHAR(32) NULL',
    'DO 0'
  )
  FROM `information_schema`.`COLUMNS`
  WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'PasswordResetToken' AND `COLUMN_NAME` = 'selector'
);
PREPARE `guarded_stmt` FROM @stmt;
EXECUTE `guarded_stmt`;
DEALLOCATE PREPARE `guarded_stmt`;

SET @stmt := (
  SELECT IF(
    COUNT(*) = 0,
    'CREATE UNIQUE INDEX `PasswordResetToken_selector_key` ON `PasswordResetToken` (`selector`)',
    'DO 0'
  )
  FROM `information_schema`.`STATISTICS`
  WHERE `TABLE_SCHEMA` = DATABASE()
    AND `TABLE_NAME` = 'PasswordResetToken'
    AND `INDEX_NAME` = 'PasswordResetToken_selector_key'
);
PREPARE `guarded_stmt` FROM @stmt;
EXECUTE `guarded_stmt`;
DEALLOCATE PREPARE `guarded_stmt`;
