-- "Remember me" becomes a real choice (security audit #14).
--
-- WHAT WAS WRONG: the refresh cookie always carried an Expires date — 14 days unticked, 30 ticked —
-- so leaving "Remember me" unticked still kept the person signed in across browser restarts, and the
-- box was ticked by default.
--
-- WHAT THIS ADDS: one nullable column, `Session.rememberMe`, written by password sign-in. When it is
-- false the API sets the refresh cookie WITHOUT Expires (a browser-session cookie), and keeps it that
-- way on every refresh — which is why the choice has to live on the session row rather than only in
-- the sign-in request.
--
-- WHAT EXISTING ROWS DO: they get NULL, which the API reads as "keep the expiring cookie" — exactly
-- what every live session has today. SSO and LDAP sessions also write NULL; nobody is signed out by
-- this deploy, and nothing is read or backfilled.
--
-- Idempotent through the house information_schema + PREPARE guard (MySQL 8 has no ADD COLUMN IF
-- NOT EXISTS; MariaDB does; this app runs on both). Canonical casing written by hand.
-- @rerunnable

SET @stmt := (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `Session` ADD COLUMN `rememberMe` BOOLEAN NULL',
    'DO 0'
  )
  FROM `information_schema`.`COLUMNS`
  WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'Session' AND `COLUMN_NAME` = 'rememberMe'
);
PREPARE `guarded_stmt` FROM @stmt;
EXECUTE `guarded_stmt`;
DEALLOCATE PREPARE `guarded_stmt`;
