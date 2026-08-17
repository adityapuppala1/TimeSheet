-- ONE BROWSER, ONE SESSION ROW — and a cleanup of the rows created before that was true.
--
-- `login()` INSERTed a Session on every sign-in and nothing ever collapsed or reaped them, so a
-- person signing in from one machine accumulated one "active device" per sign-in. Measured on the
-- development workspace before this migration: 7,486 live sessions for a single user, 6,952 of
-- them carrying the identical Chrome-on-Windows user-agent string. The Profile page's "active
-- sessions" list and the admin's who's-online panel both read that table, so the feature whose
-- entire job is "spot the session that shouldn't be there" was rendered useless by its own noise.
--
-- `deviceId` is an opaque id from a long-lived httpOnly cookie. It is NOT an authenticator: it
-- only groups rows, sessions are matched on (userId, deviceId) AND user agent, and forging one
-- buys nothing without the password. See the schema comment for the full argument.
--
-- Canonical casing throughout, per the CHANGELOG's Linux-MySQL upgrade note.
--
-- ── WHY THE DDL BELOW IS GUARDED ─────────────────────────────────────────────────────────────
--
-- An earlier version of this file failed PART-WAY THROUGH on MySQL 8: the two DDL statements
-- applied, and the data cleanup after them hit error 1093 (see the note further down). MySQL DDL
-- is not transactional and Prisma does not roll a migration back, so the affected databases were
-- left holding the column and the index while `_prisma_migrations` recorded the migration as
-- FAILED — which blocks every later migration with P3009.
--
-- Recovering from that has to be `migrate resolve --rolled-back` followed by `migrate deploy`,
-- which RE-RUNS this file over the partial state. A bare `ADD COLUMN` would then die on
-- "Duplicate column name" and the database would be stuck for a second reason.
--
-- MySQL has no `ADD COLUMN IF NOT EXISTS` (MariaDB does; relying on it would reintroduce exactly
-- the engine split that caused this). The portable form is to ask `information_schema` and
-- prepare either the real statement or a no-op — verified against both engines. `DO 0` is the
-- no-op: a valid statement that evaluates an expression and returns nothing.
SET @stmt := (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `Session` ADD COLUMN `deviceId` VARCHAR(64) NULL',
    'DO 0'
  )
  FROM `information_schema`.`COLUMNS`
  WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'Session' AND `COLUMN_NAME` = 'deviceId'
);
PREPARE `guarded_stmt` FROM @stmt;
EXECUTE `guarded_stmt`;
DEALLOCATE PREPARE `guarded_stmt`;

-- Backs the "does this user already have a live session on this device?" lookup that every
-- sign-in now performs. Guarded for the same reason as the column above.
SET @stmt := (
  SELECT IF(
    COUNT(*) = 0,
    'CREATE INDEX `Session_userId_deviceId_revokedAt_idx` ON `Session` (`userId`, `deviceId`, `revokedAt`)',
    'DO 0'
  )
  FROM `information_schema`.`STATISTICS`
  WHERE `TABLE_SCHEMA` = DATABASE()
    AND `TABLE_NAME` = 'Session'
    AND `INDEX_NAME` = 'Session_userId_deviceId_revokedAt_idx'
);
PREPARE `guarded_stmt` FROM @stmt;
EXECUTE `guarded_stmt`;
DEALLOCATE PREPARE `guarded_stmt`;

-- ── The cleanup ──────────────────────────────────────────────────────────────────────────────
--
-- Revokes every live session for a user beyond their 10 most recently active, matching the cap
-- `establishSession` enforces from now on. Without this the fix only stops the bleeding: existing
-- installations would keep rendering thousands of stale rows forever, because nothing else clears
-- them.
--
-- WHY A SCRATCH TABLE AND NOT THE OBVIOUS ONE-STATEMENT VERSION:
--
--   `UPDATE Session s JOIN (SELECT … FROM Session) d` reads from the table it updates, which MySQL
--   refuses with error 1093. Wrapping the read in a derived table is the classic workaround
--   because it forces materialisation, and it does work on MariaDB — but MySQL 8.0.14+ can MERGE
--   the derived table back into the outer query, putting 1093 straight back. That difference is
--   invisible unless you test both engines, and its failure mode is a migration that breaks
--   provisioning for every new organization on one of them. This file shipped that way once.
--
-- A separate table sidesteps the question: nothing is reading `Session` at the moment `Session` is
-- written. It is dropped either side of the work, so a re-run — including a resumed,
-- previously-failed migration — starts clean rather than joining stale ids.
--
-- `TEMPORARY` would also work (see `20260804013530_service_incident_single_open`, which uses two
-- of them). An ordinary table is used here only because it is the weaker assumption; if you are
-- reading this because a scratch table was left behind by a killed migration, dropping it by hand
-- is safe — it holds nothing but a list of ids.
--
-- WHY REVOKE RATHER THAN DELETE: `revokedAt` is the mechanism the app already uses everywhere,
-- every read path filters on it, and it keeps the row for audit. A DELETE would also lose the
-- forensic trail an admin may be mid-investigation on.
--
-- WHY "10 MOST RECENT" AND NOT "ALL": the most recently used session is almost certainly the one
-- the person is signed in on right now. Ordering by `lastSeenAt` (falling back to `createdAt` for
-- rows written before that column existed) keeps it, so an upgrade does not sign a whole workspace
-- out mid-shift. Anyone genuinely using more than ten devices loses the least-recently-used ones,
-- which is the same trade every consumer product makes.
DROP TABLE IF EXISTS `_session_cleanup`;

-- `CREATE TABLE … AS SELECT` rather than a declared column list, and this is the whole reason:
-- CTAS INHERITS the source column's character set and collation. Declaring
-- `id VARCHAR(191) … COLLATE utf8mb4_unicode_ci` and joining it to `Session`.`id` is an
-- "Illegal mix of collations" (error 1267) on any database whose `Session` table was created with
-- a different default — and the default is exactly what differs between engines: MySQL 8.0 ships
-- `utf8mb4_0900_ai_ci`, MySQL 5.7 and MariaDB ship `utf8mb4_general_ci`, and a database created
-- with an explicit `COLLATE` clause has whatever the operator chose. Reproduced against a
-- `general_ci` database: the CREATE succeeds, the INSERT succeeds, and the JOIN two statements
-- later dies — the same shape of late, engine-dependent failure this migration already caused
-- once. Inheriting sidesteps the question rather than guessing the answer.
--
-- The correlated COUNT reads "how many of this user's live sessions are fresher than this one?".
-- Ten or more means this row is past the cap. The `id` tiebreak keeps the ordering total, so two
-- sessions sharing a timestamp can never each count the other as fresher and both survive.
CREATE TABLE `_session_cleanup` AS
SELECT `keep`.`id` AS `id`
FROM `Session` AS `keep`
WHERE `keep`.`revokedAt` IS NULL
  AND (
    SELECT COUNT(*)
    FROM `Session` AS `newer`
    WHERE `newer`.`userId` = `keep`.`userId`
      AND `newer`.`revokedAt` IS NULL
      AND (
        COALESCE(`newer`.`lastSeenAt`, `newer`.`createdAt`) > COALESCE(`keep`.`lastSeenAt`, `keep`.`createdAt`)
        OR (
          COALESCE(`newer`.`lastSeenAt`, `newer`.`createdAt`) = COALESCE(`keep`.`lastSeenAt`, `keep`.`createdAt`)
          AND `newer`.`id` > `keep`.`id`
        )
      )
  ) >= 10;

-- CTAS produces a heap with no keys, and the UPDATE below joins on this column. Without an index
-- that join is a full scan of the scratch table per row — fine for the ten rows a small workspace
-- produces, an hour-long migration on the 7,486-row installation that motivated this file.
CREATE INDEX `_session_cleanup_id_idx` ON `_session_cleanup` (`id`);

-- Guarded by `revokedAt IS NULL` so re-running the migration is a no-op rather than restamping.
UPDATE `Session` AS `s`
JOIN `_session_cleanup` AS `stale` ON `stale`.`id` = `s`.`id`
SET `s`.`revokedAt` = NOW(3)
WHERE `s`.`revokedAt` IS NULL;

DROP TABLE `_session_cleanup`;
