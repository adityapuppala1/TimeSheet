-- A session records how it was established (security audit #11).
--
-- WHY: `User.mustChangePassword` — set when an admin creates an account or resets its password, so
-- the admin knows the password — becomes a gate: until the person chooses their own, the API allows
-- only the forced change-password screen. That is right for a PASSWORD sign-in and wrong for SSO or
-- LDAP, which never used the admin's password and have nothing to change here. The gate therefore
-- needs to know which kind of session it is looking at.
--
-- WHAT THIS ADDS: one nullable column, `Session.authMethod`. Password sign-in writes 'PASSWORD'.
--
-- WHAT EXISTING ROWS DO: NULL, which the gate reads as "not a password session" — so nobody signed
-- in at deploy time is interrupted mid-session; the gate applies from their next password sign-in.
-- SSO and LDAP sessions also write NULL. Nothing is read or backfilled.
--
-- Idempotent through the house information_schema + PREPARE guard (MySQL 8 has no ADD COLUMN IF
-- NOT EXISTS; MariaDB does; this app runs on both). Canonical casing written by hand.
-- @rerunnable

SET @stmt := (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `Session` ADD COLUMN `authMethod` VARCHAR(16) NULL',
    'DO 0'
  )
  FROM `information_schema`.`COLUMNS`
  WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'Session' AND `COLUMN_NAME` = 'authMethod'
);
PREPARE `guarded_stmt` FROM @stmt;
EXECUTE `guarded_stmt`;
DEALLOCATE PREPARE `guarded_stmt`;
