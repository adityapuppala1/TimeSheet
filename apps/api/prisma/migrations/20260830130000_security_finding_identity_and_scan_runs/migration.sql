-- 4.0.0: a security finding gets a stable identity, and a scan gets a record that it happened.
--
-- WHY THIS EXISTS. Findings ingestion was an unconditional INSERT, so a nightly scan reporting the
-- same 200 issues wrote 200 new rows every night. Nothing was wrong with any individual row and
-- everything downstream was wrong because of them: the risk score climbed while a workspace stood
-- still, the insights trend sloped upwards forever, the weekly digest counted one vulnerability
-- once per night, and auto-ticket-creation opened a fresh ticket for the same line of code every
-- morning. There was simply no column that could answer "have we seen this before?". `fingerprint`
-- is that column, and `firstSeenAt`/`lastSeenAt`/`occurrences` are what it makes possible.
--
-- `ScanRun` answers the other half. Findings alone can only say what we HEARD ABOUT; they can
-- never say whether a problem is gone, because a finding missing from tonight's payload is
-- indistinguishable from nobody having run the scanner. Recording each run — which tool, which
-- repo and branch, how many findings — makes absence mean something, which is what the
-- verification work is built on. This migration records that data and nothing acts on it yet.
--
-- `PENDING_VERIFICATION` is the fifth `SecurityFindingStatus`: claimed fixed, not yet confirmed by
-- a scan. It is APPENDED to the enum rather than placed in life-cycle order because MySQL stores
-- an ENUM as its member's ordinal, and only an appended member keeps this a metadata-only change
-- instead of a full copy of the one table every nightly build appends to.
--
-- WHAT EXISTING ROWS DO:
--   * `occurrences` becomes 1 for every existing row, from the column DEFAULT — "seen once", which
--     is exactly what an un-deduplicated row means.
--   * `firstSeenAt`/`lastSeenAt` are BACKFILLED from `createdAt` by the UPDATE at the foot of this
--     file. Without it every pre-existing finding would claim to have first been seen at the
--     moment of the upgrade, and "how long has this been open" — the number the age decay in the
--     risk score is built on — would reset to zero for the entire backlog. docs/DATABASE.md's
--     "Backfills" section is explicit that a column the application gates on is backfilled by the
--     migration, because `seed.ts` never re-runs on upgrade.
--   * `fingerprint` is left NULL, DELIBERATELY. The recipe (apps/api/src/utils/finding-fingerprint.ts)
--     normalises a file path, buckets a line number into a window and hashes a JSON payload; a SQL
--     re-implementation would be a second copy of the one definition everything downstream trusts,
--     and the two would drift. Null is a first-class value here rather than a defect: every reader
--     is null-tolerant, and an unfingerprinted finding simply keeps the old create-always
--     behaviour until a scan reports the same problem again with enough detail to identify it.
--   * `scanRunId` is left NULL for the same reason there is nothing to point it at — the runs that
--     produced those findings were never recorded.
--   * `status` keeps whatever value it holds. Nothing becomes PENDING_VERIFICATION here; the enum
--     gains a member and no row changes.
--
-- WHY THE COLUMN AND INDEX DDL IS GUARDED: this file follows its schema change with a data
-- backfill, and MySQL DDL is not transactional — a failure in the UPDATE leaves the columns in
-- place while `_prisma_migrations` records the migration FAILED, and recovery re-runs the file
-- over that partial state. See `20260817100000_session_device_identity` for the incident this
-- pattern comes from. The backfill is itself written to survive meeting its own output: its WHERE
-- clause is made false by the update it performs.
--
-- PORTABILITY NOTE: canonical casing written by hand — `prisma migrate diff` introspected off
-- Windows MariaDB emits lowercase table names (the 2.4.0 lesson, docs/DATABASE.md).

-- AlterTable
-- The fifth status. A full restatement of the column is how MySQL adds an enum member; there is no
-- additive form. Repeating this statement is harmless, which is why it needs no guard.
ALTER TABLE `SecurityFinding` MODIFY `status` ENUM('OPEN', 'ACKNOWLEDGED', 'FIXED', 'ACCEPTED_RISK', 'PENDING_VERIFICATION') NOT NULL DEFAULT 'OPEN';

-- CreateTable
-- `IF NOT EXISTS` so a re-run after a partial failure reaches the statements below rather than
-- dying here. This is the portable spelling MySQL and MariaDB agree on, unlike `ADD COLUMN IF NOT
-- EXISTS`, which is MariaDB-only and is why the columns further down use the information_schema
-- guard instead.
CREATE TABLE IF NOT EXISTS `ScanRun` (
    `id` VARCHAR(191) NOT NULL,
    `tool` VARCHAR(80) NOT NULL,
    `type` ENUM('SAST', 'DAST', 'SSAT', 'SSCT', 'VAPT') NOT NULL,
    `repository` VARCHAR(255) NULL,
    `branch` VARCHAR(255) NULL,
    `commitSha` VARCHAR(64) NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `findingCount` INTEGER NOT NULL DEFAULT 0,

    INDEX `ScanRun_tool_repository_branch_startedAt_idx`(`tool`, `repository`, `branch`, `startedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterTable
-- All five columns are added by one statement and guarded on one of them: they arrive together, so
-- if `fingerprint` is present the other four are too. Guarding each separately would be five times
-- the ceremony for the same guarantee.
SET @stmt := (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `SecurityFinding` ADD COLUMN `fingerprint` VARCHAR(128) NULL, ADD COLUMN `firstSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `lastSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ADD COLUMN `occurrences` INTEGER NOT NULL DEFAULT 1, ADD COLUMN `scanRunId` VARCHAR(191) NULL',
    'DO 0'
  )
  FROM `information_schema`.`COLUMNS`
  WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'SecurityFinding' AND `COLUMN_NAME` = 'fingerprint'
);
PREPARE `guarded_stmt` FROM @stmt;
EXECUTE `guarded_stmt`;
DEALLOCATE PREPARE `guarded_stmt`;

-- CreateIndex
-- The deduplication lookup, in the order the ingest asks it: "do I already hold this fingerprint
-- on this repository and branch?". Deliberately not UNIQUE — MySQL treats NULLs as distinct in a
-- unique index and both `repository` and `branch` are optional, so the constraint would silently
-- not apply to most findings while turning the cases where it did apply into a failed batch.
SET @stmt := (
  SELECT IF(
    COUNT(*) = 0,
    'CREATE INDEX `SecurityFinding_fingerprint_repository_branch_idx` ON `SecurityFinding` (`fingerprint`, `repository`, `branch`)',
    'DO 0'
  )
  FROM `information_schema`.`STATISTICS`
  WHERE `TABLE_SCHEMA` = DATABASE()
    AND `TABLE_NAME` = 'SecurityFinding'
    AND `INDEX_NAME` = 'SecurityFinding_fingerprint_repository_branch_idx'
);
PREPARE `guarded_stmt` FROM @stmt;
EXECUTE `guarded_stmt`;
DEALLOCATE PREPARE `guarded_stmt`;

-- CreateIndex
-- Created BEFORE the foreign key below on purpose: MySQL requires an index on a referencing column
-- and invents one named after the constraint if it cannot find a suitable one. Providing the
-- Prisma-named index first means the schema and the database agree on what it is called.
SET @stmt := (
  SELECT IF(
    COUNT(*) = 0,
    'CREATE INDEX `SecurityFinding_scanRunId_idx` ON `SecurityFinding` (`scanRunId`)',
    'DO 0'
  )
  FROM `information_schema`.`STATISTICS`
  WHERE `TABLE_SCHEMA` = DATABASE()
    AND `TABLE_NAME` = 'SecurityFinding'
    AND `INDEX_NAME` = 'SecurityFinding_scanRunId_idx'
);
PREPARE `guarded_stmt` FROM @stmt;
EXECUTE `guarded_stmt`;
DEALLOCATE PREPARE `guarded_stmt`;

-- AddForeignKey
-- SET NULL, not CASCADE, and the distinction matters more here than usual: `ScanRun` is a log and
-- logs get pruned. Deleting a year-old scan record must never delete the findings it reported —
-- those are the workspace's open vulnerabilities, and they outlive the run that first named them.
SET @stmt := (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `SecurityFinding` ADD CONSTRAINT `SecurityFinding_scanRunId_fkey` FOREIGN KEY (`scanRunId`) REFERENCES `ScanRun`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
    'DO 0'
  )
  FROM `information_schema`.`TABLE_CONSTRAINTS`
  WHERE `TABLE_SCHEMA` = DATABASE()
    AND `TABLE_NAME` = 'SecurityFinding'
    AND `CONSTRAINT_NAME` = 'SecurityFinding_scanRunId_fkey'
);
PREPARE `guarded_stmt` FROM @stmt;
EXECUTE `guarded_stmt`;
DEALLOCATE PREPARE `guarded_stmt`;

-- The backfill.
--
-- The two new timestamps default to the moment the ALTER ran, so without this every finding in an
-- existing workspace would claim to have been first seen at upgrade time. `createdAt` is the
-- honest answer for a row that has never been deduplicated: it was seen once, then, and that is
-- both the first and the last time.
--
-- The WHERE clause is what makes a re-run a no-op rather than a restamp: it selects exactly the
-- rows whose `firstSeenAt` is still the ALTER's clock rather than their own creation time, and
-- performing the update makes it false. A row created after this migration has
-- `createdAt = firstSeenAt` and is never touched.
UPDATE `SecurityFinding`
SET `firstSeenAt` = `createdAt`, `lastSeenAt` = `createdAt`
WHERE `createdAt` < `firstSeenAt`;
