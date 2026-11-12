-- 6.3.3: how far back a timesheet entry may be dated becomes a workspace setting.
--
-- WHY THIS EXISTS. The one-week back-date limit shipped as a constant, and a constant is the wrong
-- place for a policy that differs by organisation: a firm that bills monthly wants a longer window,
-- one that approves daily wants today only, and one that does not want a limit at all should be able
-- to say so. The workspace admin sets it on Workspace Settings -> Ticketing, next to the other
-- workspace-wide policies, and it lives on the same singleton row (GlobalTicketSettings, id 'global').
--
-- NULLABLE, WITH NULL MEANING "NO LIMIT". A very large number would also work, but then "I want
-- back-filling" is a magic value somebody has to know about. NULL is the answer in plain terms, and
-- the server reads it as "never too old".
--
-- WHAT EXISTING ROWS DO: they acquire 7, the window every workspace has been enforcing since the
-- limit shipped, so nothing changes for anyone until an admin chooses otherwise. A workspace whose
-- settings row does not exist yet gets the same default when the row is first created
-- (the column default, not application code).
--
-- THE DDL IS GUARDED (information_schema + PREPARE) so a re-run after a partial failure is a no-op
-- rather than a duplicate-column error - the house rule since
-- `20260817100000_session_device_identity`. `ADD COLUMN IF NOT EXISTS` is MariaDB-only, which is why
-- it is not used. Canonical table casing is written by hand (docs/DATABASE.md, the 2.4.0 lesson).

-- AlterTable
SET @stmt := (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `GlobalTicketSettings` ADD COLUMN `timesheetBackdateDays` INTEGER NULL DEFAULT 7',
    'DO 0'
  )
  FROM `information_schema`.`COLUMNS`
  WHERE `TABLE_SCHEMA` = DATABASE()
    AND `TABLE_NAME` = 'GlobalTicketSettings'
    AND `COLUMN_NAME` = 'timesheetBackdateDays'
);
PREPARE `guarded_stmt` FROM @stmt;
EXECUTE `guarded_stmt`;
DEALLOCATE PREPARE `guarded_stmt`;
