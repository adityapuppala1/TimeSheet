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
-- installations would keep rendering thousands of stale rows forever, because nothing else ever
-- deletes them.
--
-- WHY REVOKE RATHER THAN DELETE: `revokedAt` is the mechanism the app already uses everywhere,
-- every read path filters on it, and it keeps the row for audit. A DELETE would also race the
-- foreign keys and lose the forensic trail an admin may be mid-investigation on.
--
-- WHY "10 MOST RECENT" AND NOT "ALL": the most recently used session is almost certainly the one
-- the person is signed in on right now. Ordering by `lastSeenAt` (falling back to `createdAt` for
-- rows that predate that column) keeps that one, so an upgrade does not sign the whole workspace
-- out mid-shift. Anyone genuinely using more than ten devices loses the least-recently-used ones,
-- which is the same trade every consumer product makes.
--
-- Written with a correlated subquery rather than a window function so it runs on MySQL 5.7 as
-- well as 8, and guarded by `revokedAt IS NULL` so re-running it is a no-op.
UPDATE `Session` AS `s`
JOIN (
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
    ) >= 10
) AS `stale` ON `stale`.`id` = `s`.`id`
SET `s`.`revokedAt` = NOW(3)
WHERE `s`.`revokedAt` IS NULL;
