-- 4.0.0: a claimed fix has to be proven by a scan, and a fix that did not hold tells the people who worked on it.
--
-- WHY THIS EXISTS. `20260830130000_security_finding_identity_and_scan_runs` gave a finding a stable
-- identity and gave a scan a record that it happened, and deliberately acted on neither. This is
-- the acting-on-it. Until now the only thing that could close a security finding was a person
-- deciding it was closed: somebody resolved the ticket, the finding stopped counting, and nothing
-- in the system ever asked the scanner whether the vulnerability was actually gone. That is the
-- single most valuable question this data can answer and it was never asked.
--
-- `verificationState` is the answer's home. It is NOT another `SecurityFindingStatus` member, and
-- the distinction is the whole design: `status` records a DECISION somebody made, this records what
-- a scanner OBSERVED. Folding them together would make "Priya says this is fixed" and "semgrep ran
-- and the finding is gone" the same value, which is exactly the conflation this feature exists to
-- undo.
--
-- `verifiedFixedAt` is the column report.controller.ts's `meanTimeToRemediateHours` has been
-- approximating with `updatedAt - createdAt` since it was written — an approximation that got worse
-- once the previous migration made `updatedAt` move on every re-sighting. It is set only by the
-- verdict pass, never by any human action, which is what makes it a measurement rather than a
-- restatement of how willing somebody was to close a ticket.
--
-- `verifiedByScanRunId` and `verifiedByCommitSha` are the EVIDENCE. The commit is copied rather
-- than read back through the run because `ScanRun` is a log and logs get pruned; `ON DELETE SET
-- NULL` guarantees the pointer can vanish, so the fact it pointed at has to be stored beside it.
--
-- `IngestionSettings.verifyResolutionEnabled` and the existing `autoReopenEnabled` form a LADDER,
-- not one switch split in two: verification on with auto-reopen off means "tell me the fix did not
-- hold, but do not move my tickets", which is a legitimate configuration and the one a workspace
-- adopting this should start from. `verificationWindowDays` is how long a claimed fix waits for a
-- scan before it is called UNVERIFIED and the assignee is nudged — never reopened. Absence of proof
-- is not proof of failure.
--
-- WHAT EXISTING ROWS DO:
--   * `verificationState`, `awaitingVerificationSince`, `verifiedFixedAt`, `verifiedByScanRunId`
--     and `verifiedByCommitSha` are all left NULL, and null is the CORRECT value rather than a gap
--     to be backfilled: these findings have never been through the resolution gate, so there is no
--     verdict to record and no evidence to point at. Every reader treats a null state as "never
--     entered verification", which is what happened. `meanTimeToRemediateHours` keeps using its old
--     `updatedAt - createdAt` approximation for exactly these rows, so historical figures still
--     report something instead of collapsing to zero the day this ships.
--   * `IngestionSettings.verifyResolutionEnabled` becomes FALSE for the existing singleton row,
--     from the column DEFAULT. Nothing starts happening to any workspace on upgrade; an admin turns
--     this on. `verificationWindowDays` becomes 14 the same way.
--   * `GlobalNotificationSettings.emailTicketReopenedDigest` becomes TRUE from its DEFAULT, unlike
--     the digest toggles around it. That is deliberate and safe: the email it gates can only ever
--     fire when a scan CONTRADICTS a decision the workspace already acted on, and it cannot fire at
--     all until `verifyResolutionEnabled` is switched on. Shipping it off would mean an admin
--     enabling verification and silently getting no word when a fix failed — the one message this
--     whole feature exists to send.
--   * No finding's `status` changes. This migration adds columns; the verdict pass changes rows.
--
-- THERE IS NO BACKFILL IN THIS FILE, on purpose, and the DDL is guarded anyway. The guards cost
-- nothing and make a re-run after a partial failure a no-op instead of a duplicate-column error;
-- the previous migration's header explains the incident (`20260817100000_session_device_identity`)
-- that made that the house rule. The file is NOT marked `@rerunnable` — that marker authorises
-- `npm run setup` to clear a failed record and re-apply UNATTENDED against real data, which is a
-- promise worth making only for the migration that needs auto-healing, not for every safe one.
--
-- PORTABILITY NOTE: canonical casing written by hand — `prisma migrate diff` introspected off
-- Windows MariaDB emits lowercase table names (the 2.4.0 lesson, docs/DATABASE.md).

-- AlterTable
-- The five verification columns arrive together and are guarded on one of them: if
-- `verificationState` is present the other four are too, so guarding each separately would be five
-- times the ceremony for the same guarantee. Same reasoning as the previous migration's five-column
-- add. `verificationState` is a NULLABLE enum with no default — "no verdict" is a real, expected
-- value here, distinct from every member of the enum.
SET @stmt := (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `SecurityFinding` ADD COLUMN `verificationState` ENUM(''AWAITING_PROOF'', ''VERIFIED_FIXED'', ''REFUTED_BY_SCAN'', ''UNVERIFIED'') NULL, ADD COLUMN `awaitingVerificationSince` DATETIME(3) NULL, ADD COLUMN `verifiedFixedAt` DATETIME(3) NULL, ADD COLUMN `verifiedByScanRunId` VARCHAR(191) NULL, ADD COLUMN `verifiedByCommitSha` VARCHAR(64) NULL',
    'DO 0'
  )
  FROM `information_schema`.`COLUMNS`
  WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'SecurityFinding' AND `COLUMN_NAME` = 'verificationState'
);
PREPARE `guarded_stmt` FROM @stmt;
EXECUTE `guarded_stmt`;
DEALLOCATE PREPARE `guarded_stmt`;

-- CreateIndex
-- The verdict pass's own lookup, in the order it asks it: "which findings on this repository and
-- branch are waiting on proof?". The TOOL is deliberately not part of this key — it is compared in
-- application code, case-normalised the same way the fingerprint recipe normalises it, because
-- MySQL's default collation would make `Semgrep` and `semgrep` match here while producing two
-- different fingerprints upstream. A filter that disagrees with the identity it is filtering is
-- worse than one more row read.
SET @stmt := (
  SELECT IF(
    COUNT(*) = 0,
    'CREATE INDEX `SecurityFinding_verificationState_repository_branch_idx` ON `SecurityFinding` (`verificationState`, `repository`, `branch`)',
    'DO 0'
  )
  FROM `information_schema`.`STATISTICS`
  WHERE `TABLE_SCHEMA` = DATABASE()
    AND `TABLE_NAME` = 'SecurityFinding'
    AND `INDEX_NAME` = 'SecurityFinding_verificationState_repository_branch_idx'
);
PREPARE `guarded_stmt` FROM @stmt;
EXECUTE `guarded_stmt`;
DEALLOCATE PREPARE `guarded_stmt`;

-- CreateIndex
-- Created BEFORE the foreign key below for the same reason the previous migration gives: MySQL
-- requires an index on a referencing column and invents one named after the constraint if it cannot
-- find a suitable one, so providing the Prisma-named index first keeps the schema and the database
-- agreeing on what it is called.
SET @stmt := (
  SELECT IF(
    COUNT(*) = 0,
    'CREATE INDEX `SecurityFinding_verifiedByScanRunId_idx` ON `SecurityFinding` (`verifiedByScanRunId`)',
    'DO 0'
  )
  FROM `information_schema`.`STATISTICS`
  WHERE `TABLE_SCHEMA` = DATABASE()
    AND `TABLE_NAME` = 'SecurityFinding'
    AND `INDEX_NAME` = 'SecurityFinding_verifiedByScanRunId_idx'
);
PREPARE `guarded_stmt` FROM @stmt;
EXECUTE `guarded_stmt`;
DEALLOCATE PREPARE `guarded_stmt`;

-- AddForeignKey
-- SET NULL, matching `SecurityFinding_scanRunId_fkey`, and for a sharper version of the same
-- reason: pruning a year-old scan record must not delete the finding it proved fixed, and it must
-- not delete the fact that the finding WAS proved fixed either. That is why `verifiedFixedAt` and
-- `verifiedByCommitSha` are plain columns beside this pointer rather than things to be read back
-- through it — the pointer is allowed to become null, the evidence is not.
SET @stmt := (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `SecurityFinding` ADD CONSTRAINT `SecurityFinding_verifiedByScanRunId_fkey` FOREIGN KEY (`verifiedByScanRunId`) REFERENCES `ScanRun`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
    'DO 0'
  )
  FROM `information_schema`.`TABLE_CONSTRAINTS`
  WHERE `TABLE_SCHEMA` = DATABASE()
    AND `TABLE_NAME` = 'SecurityFinding'
    AND `CONSTRAINT_NAME` = 'SecurityFinding_verifiedByScanRunId_fkey'
);
PREPARE `guarded_stmt` FROM @stmt;
EXECUTE `guarded_stmt`;
DEALLOCATE PREPARE `guarded_stmt`;

-- AlterTable
-- The two rungs of the ladder. Both added by one statement and guarded on the first, same reasoning
-- as the finding columns above.
SET @stmt := (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `IngestionSettings` ADD COLUMN `verifyResolutionEnabled` BOOLEAN NOT NULL DEFAULT false, ADD COLUMN `verificationWindowDays` INTEGER NOT NULL DEFAULT 14',
    'DO 0'
  )
  FROM `information_schema`.`COLUMNS`
  WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'IngestionSettings' AND `COLUMN_NAME` = 'verifyResolutionEnabled'
);
PREPARE `guarded_stmt` FROM @stmt;
EXECUTE `guarded_stmt`;
DEALLOCATE PREPARE `guarded_stmt`;

-- AlterTable
-- The reopen digest's category toggle. See the header for why this one ships TRUE while every
-- digest beside it ships FALSE.
SET @stmt := (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `GlobalNotificationSettings` ADD COLUMN `emailTicketReopenedDigest` BOOLEAN NOT NULL DEFAULT true',
    'DO 0'
  )
  FROM `information_schema`.`COLUMNS`
  WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'GlobalNotificationSettings' AND `COLUMN_NAME` = 'emailTicketReopenedDigest'
);
PREPARE `guarded_stmt` FROM @stmt;
EXECUTE `guarded_stmt`;
DEALLOCATE PREPARE `guarded_stmt`;
