-- 4.0.0: a security finding learns which part of the product it is in.
--
-- WHY THIS EXISTS. A scanner can only ever tell us a repository and a file path. This app's work
-- breakdown — Project -> ProjectModule -> ProjectSubmodule — is what a repository path actually
-- maps onto, and nothing in the schema connected the two. So every auto-created security ticket
-- landed in `IngestionSettings.fallbackProjectId` and was assigned through whichever module on that
-- project happened to own a `ModuleAssigneeRule` first. That is not routing; it is a coin toss with
-- one side. A finding in `services/billing-*.ts` should reach the people who own billing, in the
-- project that owns billing, and until now there was no row anywhere that could say so.
--
-- `RepositoryMap` is the first half: a repository pattern -> a project. `ModulePathRule` is the
-- second: a path pattern -> a module and optionally a submodule, scoped to one project. Both reuse
-- `TicketRule`'s rule semantics exactly — conditions AND'd, evaluated in `order` ascending, FIRST
-- MATCH WINS, never merge-all-matches — so an admin reasons about rule order identically in all
-- three places. `createdAt` breaks a tie on equal `order` so the winner is deterministic rather
-- than whatever the storage engine returned first.
--
-- MATCHING NEVER HAPPENS IN SQL, and the schema is built on that assumption. Patterns are compiled
-- and compared in application code (apps/api/src/utils/path-pattern.ts), CASE-SENSITIVELY, because
-- `src/Billing.ts` and `src/billing.ts` are different files on every Linux host a scanner runs on.
-- MySQL's default collation is case-INSENSITIVE, so a `LIKE` in a WHERE clause would quietly
-- disagree with the matcher about that — the same argument
-- `20260831090000_verified_remediation_gate` makes for comparing tool names outside its index.
-- Hence: no functional index, no collation clause, and the indexes below are for the ORDER these
-- rules are read in, not for finding one by its pattern.
--
-- `SecurityFinding.moduleId` / `.submoduleId` are the resolved answer, stored on the FINDING and
-- not only on the ticket it may become. Most findings never become a ticket (only CRITICAL/HIGH
-- with no `ticketKey` do), so "which module carries our open risk" has to answer for all of them or
-- it answers for a biased sample. `ON DELETE SET NULL`, like every other pointer on that row:
-- retiring a module must not delete the vulnerabilities that were found in it.
--
-- WHAT EXISTING ROWS DO:
--   * `SecurityFinding.moduleId` and `.submoduleId` are left NULL for every existing finding, and
--     NULL is the CORRECT value rather than a gap to be backfilled. There is nothing to backfill
--     FROM: the mapping is a set of rules an admin has not written yet, and this migration creates
--     both rule tables EMPTY. A finding acquires a module the first time a scan re-reports it after
--     a rule covers it, or never, and every reader is null-tolerant.
--   * `RepositoryMap` and `ModulePathRule` start empty on every installation. That is what makes
--     this upgrade a no-op for existing workspaces: with no repository map, resolution falls back
--     to `IngestionSettings.fallbackProjectId` exactly as it always did, and with no path rule the
--     module stays null. Nothing starts happening to anybody until somebody writes a rule.
--   * No ticket is re-routed and no finding is re-assigned. This migration adds columns and two
--     empty tables; the routing acts on findings ingested from here on.
--
-- THERE IS NO BACKFILL IN THIS FILE, on purpose (see above), and the DDL is guarded anyway. The
-- guards cost nothing and make a re-run after a partial failure a no-op instead of a
-- duplicate-column error; `20260817100000_session_device_identity` is the incident that made that
-- the house rule. The two CREATE TABLEs carry their foreign keys INLINE rather than as separate
-- ALTER statements so that `IF NOT EXISTS` covers the whole table in one re-runnable statement —
-- the constraint names are written out by hand so they match what Prisma expects to find. The file
-- deliberately does NOT carry the auto-heal marker (the one scripts/lib/migration-recovery.ts looks
-- for in a SQL comment, spelled out in docs/DATABASE.md and NOT repeated here, because writing it
-- down at all is what sets it). That marker authorises `npm run setup` to clear a failed record and
-- re-apply UNATTENDED against real data, which is a promise worth making only for the migration
-- that needs auto-healing, not for every safe one.
--
-- PORTABILITY NOTE: canonical casing written by hand — `prisma migrate diff` introspected off
-- Windows MariaDB emits lowercase table names (the 2.4.0 lesson, docs/DATABASE.md).

-- CreateTable
-- Repository pattern -> project. `IF NOT EXISTS` is the portable spelling MySQL and MariaDB agree
-- on, unlike `ADD COLUMN IF NOT EXISTS`, which is MariaDB-only and is why the columns further down
-- use the information_schema guard instead.
CREATE TABLE IF NOT EXISTS `RepositoryMap` (
    `id` VARCHAR(191) NOT NULL,
    `pattern` VARCHAR(255) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `order` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `RepositoryMap_isActive_order_idx`(`isActive`, `order`),
    CONSTRAINT `RepositoryMap_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
-- Path pattern -> module (+ optional submodule), scoped to one project. CASCADE from the project
-- and the module, SET NULL from the submodule: deleting the module a rule routes to leaves a rule
-- that can never fire, while deleting a submodule only makes the rule coarser.
CREATE TABLE IF NOT EXISTS `ModulePathRule` (
    `id` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `pattern` VARCHAR(500) NOT NULL,
    `moduleId` VARCHAR(191) NOT NULL,
    `submoduleId` VARCHAR(191) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `order` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ModulePathRule_projectId_isActive_order_idx`(`projectId`, `isActive`, `order`),
    CONSTRAINT `ModulePathRule_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `ModulePathRule_moduleId_fkey` FOREIGN KEY (`moduleId`) REFERENCES `ProjectModule`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `ModulePathRule_submoduleId_fkey` FOREIGN KEY (`submoduleId`) REFERENCES `ProjectSubmodule`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterTable
-- Both columns are added by one statement and guarded on one of them: they arrive together, so if
-- `moduleId` is present `submoduleId` is too. Same reasoning as the five-column adds in the two
-- previous security migrations.
SET @stmt := (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `SecurityFinding` ADD COLUMN `moduleId` VARCHAR(191) NULL, ADD COLUMN `submoduleId` VARCHAR(191) NULL',
    'DO 0'
  )
  FROM `information_schema`.`COLUMNS`
  WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'SecurityFinding' AND `COLUMN_NAME` = 'moduleId'
);
PREPARE `guarded_stmt` FROM @stmt;
EXECUTE `guarded_stmt`;
DEALLOCATE PREPARE `guarded_stmt`;

-- CreateIndex
-- The insights breakdown's own query, in the order it asks it: "how many still-open findings per
-- module?". `moduleId` is leftmost, so this index is ALSO the one MySQL requires on the referencing
-- column of the foreign key below — one index doing both jobs, and created before the constraint so
-- the server does not invent one named after it instead.
SET @stmt := (
  SELECT IF(
    COUNT(*) = 0,
    'CREATE INDEX `SecurityFinding_moduleId_status_idx` ON `SecurityFinding` (`moduleId`, `status`)',
    'DO 0'
  )
  FROM `information_schema`.`STATISTICS`
  WHERE `TABLE_SCHEMA` = DATABASE()
    AND `TABLE_NAME` = 'SecurityFinding'
    AND `INDEX_NAME` = 'SecurityFinding_moduleId_status_idx'
);
PREPARE `guarded_stmt` FROM @stmt;
EXECUTE `guarded_stmt`;
DEALLOCATE PREPARE `guarded_stmt`;

-- CreateIndex
SET @stmt := (
  SELECT IF(
    COUNT(*) = 0,
    'CREATE INDEX `SecurityFinding_submoduleId_idx` ON `SecurityFinding` (`submoduleId`)',
    'DO 0'
  )
  FROM `information_schema`.`STATISTICS`
  WHERE `TABLE_SCHEMA` = DATABASE()
    AND `TABLE_NAME` = 'SecurityFinding'
    AND `INDEX_NAME` = 'SecurityFinding_submoduleId_idx'
);
PREPARE `guarded_stmt` FROM @stmt;
EXECUTE `guarded_stmt`;
DEALLOCATE PREPARE `guarded_stmt`;

-- AddForeignKey
-- SET NULL, matching `SecurityFinding_scanRunId_fkey` and `SecurityFinding_verifiedByScanRunId_fkey`
-- before it: a module is an organisational unit that gets retired and merged, and doing so must
-- never delete the open vulnerabilities that were found inside it. The finding survives; it simply
-- stops being attributed to a module that no longer exists.
SET @stmt := (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `SecurityFinding` ADD CONSTRAINT `SecurityFinding_moduleId_fkey` FOREIGN KEY (`moduleId`) REFERENCES `ProjectModule`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
    'DO 0'
  )
  FROM `information_schema`.`TABLE_CONSTRAINTS`
  WHERE `TABLE_SCHEMA` = DATABASE()
    AND `TABLE_NAME` = 'SecurityFinding'
    AND `CONSTRAINT_NAME` = 'SecurityFinding_moduleId_fkey'
);
PREPARE `guarded_stmt` FROM @stmt;
EXECUTE `guarded_stmt`;
DEALLOCATE PREPARE `guarded_stmt`;

-- AddForeignKey
SET @stmt := (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `SecurityFinding` ADD CONSTRAINT `SecurityFinding_submoduleId_fkey` FOREIGN KEY (`submoduleId`) REFERENCES `ProjectSubmodule`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
    'DO 0'
  )
  FROM `information_schema`.`TABLE_CONSTRAINTS`
  WHERE `TABLE_SCHEMA` = DATABASE()
    AND `TABLE_NAME` = 'SecurityFinding'
    AND `CONSTRAINT_NAME` = 'SecurityFinding_submoduleId_fkey'
);
PREPARE `guarded_stmt` FROM @stmt;
EXECUTE `guarded_stmt`;
DEALLOCATE PREPARE `guarded_stmt`;
