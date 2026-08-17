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
ALTER TABLE `Session`
  ADD COLUMN `deviceId` VARCHAR(64) NULL;

-- Backs the "does this user already have a live session on this device?" lookup that every
-- sign-in now performs.
CREATE INDEX `Session_userId_deviceId_revokedAt_idx` ON `Session` (`userId`, `deviceId`, `revokedAt`);

-- ── The cleanup ──────────────────────────────────────────────────────────────────────────────
--
-- Revokes every live session for a user beyond their 10 most recently active, matching the cap
-- `establishSession` enforces from now on. Without this the fix only stops the bleeding: existing
-- installations would keep rendering thousands of stale rows forever, because nothing else clears
-- them.
--
-- WHY A SCRATCH TABLE, AND WHY NOT THE TWO OBVIOUS ALTERNATIVES — both were tried and both fail:
--
--   * `UPDATE Session s JOIN (SELECT … FROM Session) d` reads from the table it updates, which
--     MySQL refuses with error 1093. Wrapping the read in a derived table is the classic
--     workaround because it forces materialisation, and it does work on MariaDB — but MySQL
--     8.0.14+ can MERGE a derived table back into the outer query, putting 1093 straight back.
--     That difference is invisible unless you test both engines, and its failure mode is a
--     migration that breaks provisioning for every new organization on one of them.
--   * A TEMPORARY table looks like the clean fix and silently is not: temporary tables are
--     CONNECTION-scoped, and Prisma's migration engine does not guarantee one connection for the
--     whole file. Verified here — the statement that creates it succeeds and the next statement
--     that joins it fails with "query number 5". Nothing in the file hints at why.
--
-- An ordinary table is visible from any connection and behaves identically on every engine. It is
-- dropped either side of the work, so a re-run (or a resumed, previously-failed migration) starts
-- clean rather than joining stale ids.
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

CREATE TABLE `_session_cleanup` (
  `id` VARCHAR(191) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- The correlated COUNT reads "how many of this user's live sessions are fresher than this one?".
-- Ten or more means this row is past the cap. The `id` tiebreak keeps the ordering total, so two
-- sessions sharing a timestamp can never each count the other as fresher and both survive.
INSERT INTO `_session_cleanup` (`id`)
SELECT `keep`.`id`
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

-- Guarded by `revokedAt IS NULL` so re-running the migration is a no-op rather than restamping.
UPDATE `Session` AS `s`
JOIN `_session_cleanup` AS `stale` ON `stale`.`id` = `s`.`id`
SET `s`.`revokedAt` = NOW(3)
WHERE `s`.`revokedAt` IS NULL;

DROP TABLE `_session_cleanup`;
